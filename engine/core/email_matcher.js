// Pure email ↔ application matcher.
//
// Ported from ../../Job Search/check_emails.js:148-220 (prototype).
//
// activeJobsMap is the shape produced by check.js at --prepare time:
//   { "Affirm": [{company, role, status, notion_id, resume_version}, ...], ... }
// We try to find the company first (from > subject > body with word boundaries),
// then narrow to a specific role if the company has multiple open applications.

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

// Pass 1: strong signal — token appears in sender address or subject line.
// Pass 2: fall back to body with word boundaries (avoids false positives from
// generic phrases like "next steps" or "potential match").
function findCompany(email, activeJobsMap) {
  const from = (email.from || "").toLowerCase();
  const subject = (email.subject || "").toLowerCase();
  const body = (email.body || "").toLowerCase().slice(0, 3000);

  for (const [company, jobs] of Object.entries(activeJobsMap)) {
    const tokens = companyTokens(company);
    if (tokens.some((t) => from.includes(t) || subject.includes(t))) {
      return { company, jobs };
    }
  }

  for (const [company, jobs] of Object.entries(activeJobsMap)) {
    const tokens = companyTokens(company);
    if (tokens.some((t) => new RegExp(`\\b${t}\\b`).test(body))) {
      return { company, jobs };
    }
  }

  return null;
}

// Common PM title words that should not be used as disambiguation signals —
// they appear across too many roles ("Senior Product Manager" vs "Product
// Manager, Growth" both contain "product manager").
const ROLE_MATCH_SKIP = new Set([
  "product", "manager", "senior", "principal", "staff", "lead", "technical", "manager,",
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

function matchEmailToApp(email, activeJobsMap) {
  const c = findCompany(email, activeJobsMap);
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
