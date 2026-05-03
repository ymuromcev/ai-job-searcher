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
//
// Tie-break (added 2026-05-02 after Lilia incident): if two entries score
// equally, REQUIRE that the winner has at least one DISCRIMINATING token
// (a token unique to that entry's synonym set, not present in the other
// tied entry's synonym set) that appears in the haystack. Without this,
// "Sacramento Natural Dentistry" and "Sacramento Spa Dentistry" both score
// 2 on tokens ["sacramento","dentistry"] for ANY haystack mentioning a
// Sacramento dental clinic, and the matcher would return whichever was
// iterated first — a 50/50 false match. With the tie-break, neither wins
// unless the discriminating token ("natural" / "spa") actually appears.
function findCompany(email, activeJobsMap, companyAliases = {}) {
  const from = (email.from || "").toLowerCase();
  const subject = (email.subject || "").toLowerCase();
  const body = (email.body || "").toLowerCase().slice(0, 3000);
  const haystack = `${from} ${subject}`;

  const entries = Object.entries(activeJobsMap).map(([company, jobs]) => {
    const aliases = Array.isArray(companyAliases[company]) ? companyAliases[company] : [];
    return { company, jobs, synonyms: [company, ...aliases] };
  });

  const winner = pickBestWithTieBreak(entries, haystack, false);
  if (winner && hasShortDiscriminatorMatch(winner.entry.synonyms, haystack, false)) {
    return { company: winner.entry.company, jobs: winner.entry.jobs };
  }

  const winner2 = pickBestWithTieBreak(entries, body, true);
  if (winner2 && hasShortDiscriminatorMatch(winner2.entry.synonyms, body, true)) {
    return { company: winner2.entry.company, jobs: winner2.entry.jobs };
  }

  return null;
}

// Short-discriminator guard (Lilia incident 2026-05-02 follow-up). If a
// company name has SHORT distinguishing tokens that companyTokens drops
// (length 2-3 after lowercase, e.g. "spa", "ENT", "MSO"), and those tokens
// are the ONLY thing differentiating it from email content that mentions
// the same long generic tokens (sacramento, dentistry), require at least
// one short token to appear in the haystack. Otherwise the match is too
// weak — it would attribute "Sacramento Natural Dentistry" emails to
// "Sacramento Spa Dentistry" purely on shared generic tokens.
//
// For each synonym: if the synonym has no short discriminators, it
// passes trivially (nothing extra to verify). If it has some, at least
// one must appear in the haystack. ANY synonym passing → match accepted.
function hasShortDiscriminatorMatch(synonyms, haystack, useWordBoundary) {
  for (const syn of synonyms) {
    const longTokens = new Set(companyTokens(syn));
    const allTokens = tieBreakTokens(syn);
    const shorts = allTokens.filter((t) => !longTokens.has(t) && t.length >= 2);
    if (shorts.length === 0) return true;
    const matched = shorts.some((t) =>
      useWordBoundary
        ? new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(haystack)
        : haystack.includes(t)
    );
    if (matched) return true;
  }
  return false;
}

// More lenient tokenization for tie-break only. Includes short distinctive
// words ("spa", "ENT", "MSO") that companyTokens drops by its length>3 rule.
// Still strips stop-words and corporate suffixes (LLC/Inc) which never
// discriminate. Used ONLY by pickBestWithTieBreak to decide between
// equally-scored entries.
const TIE_BREAK_STOP_WORDS = new Set([
  "and", "the", "for", "with", "from", "its", "our", "not", "of",
  "llc", "inc", "ltd", "corp", "co", "&",
]);

function tieBreakTokens(name) {
  return (name || "")
    .toLowerCase()
    .replace(/\(wd\)/g, "")
    .replace(/inc\.?/g, "")
    .replace(/llc\.?/g, "")
    .replace(/[^a-z0-9.]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !TIE_BREAK_STOP_WORDS.has(t));
}

// Pick the entry with highest score. If a tie, require the winner to have
// at least one discriminating token (unique to its synonym set vs the other
// tied entries) present in the haystack. If no entry passes the tie-break,
// return null — better to skip than mis-attribute.
function pickBestWithTieBreak(entries, haystack, useWordBoundary) {
  const scored = entries
    .map((entry) => ({ entry, score: scoreSynonyms(entry.synonyms, haystack, useWordBoundary) }))
    .filter((s) => s.score > 0);
  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  const tied = scored.filter((s) => s.score === top.score);
  if (tied.length === 1) return top;

  // Tie-break: find each tied entry's discriminating tokens (tokens in its
  // synonym set that aren't in ANY other tied entry's synonym set), check
  // if any appear in the haystack. Uses tieBreakTokens (more lenient) to
  // catch short distinctive words like "spa" / "ENT" that companyTokens
  // drops.
  const allTiedTokens = tied.map((s) =>
    new Set(s.entry.synonyms.flatMap((syn) => tieBreakTokens(syn)))
  );
  const candidatesWithUniqueMatch = tied.filter((s, i) => {
    const myTokens = allTiedTokens[i];
    const otherTokens = new Set();
    for (let j = 0; j < allTiedTokens.length; j++) {
      if (j === i) continue;
      for (const t of allTiedTokens[j]) otherTokens.add(t);
    }
    const discriminating = [...myTokens].filter((t) => !otherTokens.has(t));
    if (discriminating.length === 0) return false;
    return discriminating.some((t) =>
      useWordBoundary
        ? new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(haystack)
        : haystack.includes(t)
    );
  });

  if (candidatesWithUniqueMatch.length === 1) return candidatesWithUniqueMatch[0];
  // Either zero (no entry has a unique signal — ambiguous, skip) or
  // multiple (still ambiguous between them — skip too, safer than guessing).
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
