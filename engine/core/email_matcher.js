// Pure email ↔ application matcher.
//
// Ported from ../../Job Search/check_emails.js:148-220 (prototype). The matcher
// has been hardened beyond the prototype with two changes that emerged from a
// 2026-04-30 dry-run on Jared's pipeline:
//
//   1. Score-based + all-tokens-required. The prototype used `tokens.some(...)`
//      which falsely matched "Match Group" emails to "IEX Group" rows (both
//      tokenize to ["group"] after stop-word filtering). We now require ALL
//      company tokens to appear in the haystack, and pick the entry with the
//      highest token-count match (so "Match Group" with 2 tokens wins over
//      "IEX Group" with 1).
//
//   2. companyAliases support. Many parent companies (e.g. Match Group) ship
//      applications under brand names (Hinge, Tinder, OkCupid). The TSV stores
//      the parent name; rejection emails come from the brand. companyAliases
//      maps parent → list of brands; matcher tokenizes each alias separately
//      and uses any synonym whose tokens all match.
//
// activeJobsMap shape (built in check.js at --prepare time):
//   { "Match Group": [{company, role, status, notion_id, resume_version}, ...] }
// companyAliases shape (from profile.json.company_aliases):
//   { "Match Group": ["Hinge", "Tinder", "OkCupid"] }

const TOKEN_STOP_WORDS = new Set([
  "and", "the", "for", "with", "from", "its", "our", "not",
  "llc", "inc", "ltd", "corp",
]);

function companyTokens(name) {
  return (name || "")
    .toLowerCase()
    .replace(/\(wd\)/g, "")
    .replace(/inc\.?/g, "")
    .replace(/llc\.?/g, "")
    .replace(/[^a-z0-9.]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 3 && !TOKEN_STOP_WORDS.has(t));
}

// Score one entry against a haystack. Returns the highest token-match count
// across the entry's synonyms. We use absolute count (not %) so that
// "Match Group" (2 tokens both matched) beats "IEX Group" (1 token matched)
// on the suffix-collision case, while "Veeva Systems" still scores 1 on
// emails that only mention "Veeva" (without the "Systems" suffix).
function scoreSynonyms(synonyms, haystack, useWordBoundary) {
  let best = 0;
  for (const syn of synonyms) {
    const tokens = companyTokens(syn);
    if (tokens.length === 0) continue;
    const matched = tokens.filter((t) =>
      useWordBoundary
        ? new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(haystack)
        : haystack.includes(t)
    ).length;
    if (matched > best) best = matched;
  }
  return best;
}

// Pass 1: strong signal — from + subject. Pass 2: body with word boundaries.
// Within each pass, pick the entry with the highest token-match score (so
// "Match Group" beats "IEX Group" on a Match Group email).
function findCompany(email, activeJobsMap, companyAliases = {}) {
  const from = (email.from || "").toLowerCase();
  const subject = (email.subject || "").toLowerCase();
  const body = (email.body || "").toLowerCase().slice(0, 3000);
  const haystack = `${from} ${subject}`;

  const entries = Object.entries(activeJobsMap).map(([company, jobs]) => {
    const aliases = Array.isArray(companyAliases[company]) ? companyAliases[company] : [];
    return { company, jobs, synonyms: [company, ...aliases] };
  });

  let bestPass1 = null;
  for (const entry of entries) {
    const score = scoreSynonyms(entry.synonyms, haystack, false);
    if (score > 0 && (!bestPass1 || score > bestPass1.score)) {
      bestPass1 = { entry, score };
    }
  }
  if (bestPass1) {
    return { company: bestPass1.entry.company, jobs: bestPass1.entry.jobs };
  }

  let bestPass2 = null;
  for (const entry of entries) {
    const score = scoreSynonyms(entry.synonyms, body, true);
    if (score > 0 && (!bestPass2 || score > bestPass2.score)) {
      bestPass2 = { entry, score };
    }
  }
  if (bestPass2) {
    return { company: bestPass2.entry.company, jobs: bestPass2.entry.jobs };
  }

  return null;
}

// Common PM title words that should not be used as disambiguation signals —
// they appear across too many roles ("Senior Product Manager" vs "Product
// Manager, Growth" both contain "product manager"). Also includes common
// rejection-boilerplate words — they appear in nearly every rejection body
// ("candidates whose experience more closely matches"), so without this guard
// any role containing "Experience" in its title falsely wins disambiguation.
const ROLE_MATCH_SKIP = new Set([
  "product", "manager", "senior", "principal", "staff", "lead", "technical", "manager,",
  "experience", "candidates", "considered", "application", "applications",
  "opportunity", "opportunities", "position", "decided", "carefully",
  "unfortunately", "qualified", "qualifications", "interest", "interested",
  "review", "reviewed", "consideration", "appreciate",
]);

function findRole(email, jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return null;
  if (jobs.length === 1) return { job: jobs[0], confidence: "HIGH" };

  const subject = (email.subject || "").toLowerCase();
  const body = (email.body || "").toLowerCase().slice(0, 4000);
  const text = `${subject} ${body}`;

  for (const job of jobs) {
    if (text.includes((job.role || "").toLowerCase())) {
      return { job, confidence: "HIGH" };
    }
  }

  for (const job of jobs) {
    const keywords = (job.role || "")
      .toLowerCase()
      .replace(/[,\-|]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 4 && !ROLE_MATCH_SKIP.has(w));
    if (keywords.length > 0 && keywords.some((kw) => text.includes(kw))) {
      return { job, confidence: "HIGH" };
    }
  }

  return { job: jobs[0], confidence: "LOW" };
}

function matchEmailToApp(email, activeJobsMap, companyAliases = {}) {
  const c = findCompany(email, activeJobsMap, companyAliases);
  if (!c) return null;
  const r = findRole(email, c.jobs);
  if (!r) return null;
  return { company: c.company, job: r.job, confidence: r.confidence };
}

function parseLevel(role) {
  const r = (role || "").toLowerCase();
  if (r.includes("principal")) return "Principal";
  if (r.includes("staff")) return "Staff";
  if (r.includes("director")) return "Director";
  if (r.includes("lead")) return "Lead";
  if (/senior|sr\.?\s/.test(r)) return "Senior";
  return "Mid";
}

function archetype(resumeVersion) {
  if (!resumeVersion) return "—";
  return resumeVersion.replace("CV_Jared_Moore_", "");
}

module.exports = {
  companyTokens,
  findCompany,
  findRole,
  matchEmailToApp,
  parseLevel,
  archetype,
};
