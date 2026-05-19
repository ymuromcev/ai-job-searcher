// Email-source and content filters for the check command.
// Ported from ../../Job Search/check_emails.js:54-74, 224-267 (prototype).
//
// RFC 040 / BL-92: `isLevelBlocked` and `isLocationBlocked` are
// shim-layer wrappers over `evaluateJob` (Phase 1). Behaviour is
// preserved bit-identical to BL-100; `isLocationBlocked` is deprecated
// (one-release warning shim) per RFC 040 §7.5.

const { findTitleBlocklistHit } = require("./filter_helpers.js");
const { evaluateJob } = require("./evaluate_job.js");

// Word-boundary regex mirroring filter.js#makeBoundaryRegex semantics.
// Inlined (not imported) because filter.js does not export it and BL-100
// requires using the same mechanism without modifying filter.js.
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function makeBoundaryRegex(needle) {
  const lower = String(needle).toLowerCase();
  const startB = /\w/.test(lower[0]) ? "\\b" : "";
  const endB = /\w/.test(lower[lower.length - 1]) ? "\\b" : "";
  return new RegExp(`${startB}${escapeRegex(lower)}${endB}`, "i");
}

// ATS domains — senders on these platforms are job-application-system
// notifications (acks, rejections, interview invites, etc.). Used in three
// places:
//   1. `isATS(from)` bypass for the recruiter-outreach branch.
//   2. `atsFromInclusions()` — explicit IMAP search batch in `check.js`
//      (covers emails where the company name lives in the body, not in
//      from/subject — see RFC 029).
//   3. `atsFromExclusions()` — applied to the recruiter-outreach batch so
//      these senders flow through the normal classify branch instead.
//
// Adding a new ATS: append the bare domain here. All three behaviors update
// automatically. Use the canonical sending domain (e.g. `greenhouse-mail.io`
// not the company-facing `greenhouse.io`).
const ATS_DOMAINS = [
  // Generic / tech-focused
  "greenhouse-mail.io",
  "us.greenhouse-mail.io",
  "hire.lever.co",
  "myworkdayjobs.com",
  "myworkday.com",
  "ashbyhq.com",
  "ashby.com",
  "smartrecruiters.com",
  "icims.com",
  "bamboohr.com",
  "jobvite.com",
  "workable.com",
  "taleo.net",
  "jobot.com",
  "breezy.hr",
  "paycomonline.com",
  // Modern recruiting platforms
  "gem.com",
  "paradox.ai",
  "eightfold.ai",
  // Healthcare / dental
  "dentemploy.com",
  // Generic small-business ATS (Sacramento Natural Dentistry, etc.)
  "applicantemails.com",
  "send.applicantemails.com",
];

// Returns `from:(d1 OR d2 OR ...)` for IMAP X-GM-RAW search. Used by
// `check.js:buildBatches` to fetch ATS-mediated emails that would otherwise
// be invisible to the per-company token search.
function atsFromInclusions() {
  return `from:(${ATS_DOMAINS.join(" OR ")})`;
}

// Returns `-from:d1 -from:d2 ...` to exclude ATS senders from the
// recruiter-outreach batch. They flow through the normal classify branch
// via the dedicated ATS inclusion batch instead.
function atsFromExclusions() {
  return ATS_DOMAINS.map((d) => `-from:${d}`).join(" ");
}

// Senders that produce JOB_ALERT noise (broadcasts of new openings, "N more
// matching jobs", saved-search digests). These are NOT pipeline updates —
// they should be skipped before classify() to avoid false REJECTION /
// INTERVIEW_INVITE matches on the JD body text.
//
// Added 2026-05-02 after Lilia incident: 11 false positives, several were
// `donotreply@match.indeed.com` "N more new jobs" digests whose embedded job
// descriptions tripped /interview/, /availability/, /questionnaire/,
// /assessment/. See incidents.md.
//
// Pattern matched against `from` (case-insensitive substring) AND/OR subject
// (case-insensitive regex). Either condition is sufficient.
const JOB_ALERT_SENDERS = [
  // Indeed digest emails
  { fromIncludes: "donotreply@match.indeed.com" },
  { fromIncludes: "noreply@match.indeed.com" },
  { fromIncludes: "alert@indeed.com" },
  { fromIncludes: "indeedapply@indeed.com" },
  // LinkedIn job alerts (already short-circuited in check.js but listed here
  // for completeness so isJobAlert() is the single source of truth).
  { fromIncludes: "jobalerts-noreply@linkedin.com" },
  // Jobot Alerts — proactive marketing digests on alerts.jobot.com subdomain
  // ("New opportunity as a Product Manager", "12 New Jobs for your Job
  // Search"). Distinct from genuine recruiter outreach on @jobot.com (no
  // `alerts.`), which still flows through the normal recruiter branch.
  // Added 2026-05-12 after Jared 30-day probe surfaced 3 such digests.
  { fromIncludes: "@alerts.jobot.com" },
  // ZipRecruiter / Glassdoor / Monster digests
  {
    fromIncludes: "@ziprecruiter.com",
    subjectMatches: /\b(new jobs?|matching jobs?|jobs? for you|job alert)\b/i,
  },
  {
    fromIncludes: "@glassdoor.com",
    subjectMatches: /\b(new jobs?|matching jobs?|jobs? for you|job alert)\b/i,
  },
  {
    fromIncludes: "@monster.com",
    subjectMatches: /\b(new jobs?|matching jobs?|jobs? for you|job alert)\b/i,
  },
  // Generic subject patterns for any sender — "+ N more new jobs", saved
  // search digests, "X jobs matching your search"
  { subjectMatches: /\+\s*\d+\s+more\s+new\s+jobs?/i },
  { subjectMatches: /\b\d+\s+(new\s+)?jobs?\s+(matching|for\s+you|in\s+your)/i },
  { subjectMatches: /^\s*(new\s+jobs?\s+for|jobs?\s+matching)/i },
];

// Senders that are unrelated to job-search entirely (banks, utilities,
// insurance) — must never reach the pipeline classifier. Even if the body
// contains words like "received your application" (e.g. credit card
// application receipt), they are NOT job-application updates.
//
// Added 2026-05-02 after Lilia incident: Wells Fargo "We received your claim
// inquiry" reply was misread because the body language overlaps with
// ACKNOWLEDGMENT patterns and findCompany found a weak token-collision.
const NON_PIPELINE_SENDERS = [
  // Banks / financial — anything from these domains is NOT a job email
  { fromIncludes: "@wellsfargo.com" },
  { fromIncludes: "@notify.wellsfargo.com" },
  { fromIncludes: "@email.wellsfargo.com" },
  { fromIncludes: "@chase.com" },
  { fromIncludes: "@bankofamerica.com" },
  { fromIncludes: "@email.bankofamerica.com" },
  { fromIncludes: "@citi.com" },
  { fromIncludes: "@capitalone.com" },
  { fromIncludes: "@discover.com" },
  { fromIncludes: "@americanexpress.com" },
  { fromIncludes: "@usbank.com" },
  { fromIncludes: "@paypal.com" },
  { fromIncludes: "@venmo.com" },
  // Utilities / telecom
  { fromIncludes: "@att.com" },
  { fromIncludes: "@verizon.com" },
  { fromIncludes: "@comcast.com" },
  { fromIncludes: "@xfinity.com" },
  { fromIncludes: "@spectrum.com" },
  // Insurance
  { fromIncludes: "@geico.com" },
  { fromIncludes: "@progressive.com" },
  { fromIncludes: "@statefarm.com" },
  { fromIncludes: "@allstate.com" },
  // Notion notifications — added 2026-05-12 after a critical feedback loop:
  // bot writes an INTERVIEW_INVITE comment to a Notion page → Notion emails
  // the user about the comment → email body quotes our own "Subject: ...
  // First Round Interview..." line → classifier matches /first round
  // interview/i → bot tries to apply Interview status AGAIN on a different
  // pipeline row (matcher cross-binds via body). Self-amplifying. Must be
  // filtered upstream.
  { fromIncludes: "@mail.notion.so" },
  { fromIncludes: "notify@mail.notion.so" },
];

const RECRUITER_SUBJECT_PATTERNS = [
  /^requirement for\s/i,
  /^immediate need/i,
  /\bjob opportunity\b/i,
  /\bexciting opportunity\b/i,
  /\bnew (?:role|opportunity|position)\b/i,
  /\bopen (?:position|role)\b/i,
  /\bgreat fit\b/i,
  /\bperfect fit\b/i,
  /came across your/i,
  /your (?:background|profile)\b/i,
  /i(?:'m| am) reaching out/i,
  /contract (?:role|position|opportunity)/i,
];

function isATS(from) {
  const lower = (from || "").toLowerCase();
  return ATS_DOMAINS.some((d) => lower.includes(d));
}

// True if email is a job-alert digest that should be skipped before classify().
// Any rule in JOB_ALERT_SENDERS that matches (from-substring AND/OR
// subject-regex) returns true. Subject-only rules apply across all senders.
function isJobAlert(from, subject) {
  const fromLower = (from || "").toLowerCase();
  const subj = subject || "";
  for (const rule of JOB_ALERT_SENDERS) {
    const fromOk = rule.fromIncludes ? fromLower.includes(rule.fromIncludes) : true;
    const subjOk = rule.subjectMatches ? rule.subjectMatches.test(subj) : true;
    if (rule.fromIncludes && rule.subjectMatches) {
      if (fromOk && subjOk) return true;
    } else if (rule.fromIncludes) {
      if (fromOk) return true;
    } else if (rule.subjectMatches) {
      if (subjOk) return true;
    }
  }
  return false;
}

// True if email is from a non-pipeline sender (bank, utility, insurance) —
// must be skipped before classify() to avoid false matches on transactional
// language like "we received your claim inquiry".
function isNonPipelineSender(from) {
  const lower = (from || "").toLowerCase();
  return NON_PIPELINE_SENDERS.some((rule) => lower.includes(rule.fromIncludes));
}

function matchesRecruiterSubject(subject) {
  if (!subject) return false;
  return RECRUITER_SUBJECT_PATTERNS.some((p) => p.test(subject));
}

// RFC 040 / BL-92: shape adapter from a parsed-email record to
// `EvaluateJobInput.job`. Emails carry parsed `company` / `title` /
// optional `locations[]`.
function jobFromEmail(parsed) {
  const p = parsed || {};
  return {
    company: String(p.company || ""),
    title: String(p.title || ""),
    locations: Array.isArray(p.locations) ? p.locations.map(String) : [],
  };
}

// Level blocklist — word-boundary match on the title. BL-100 / RFC 040:
// shares semantics with `findTitleBlocklistHit` (canonical
// word-boundary). Same blocklist behaves identically for jobs
// (scan/prepare) and for emails (check). Prevents false hits like
// "rn" matching "PRN Coordinator".
// rules arrives in the flat engine shape after profile_loader normalization:
//   { title_blocklist: [{pattern, reason}, ...] }
//
// Phase 1 shim: delegates to `evaluateJob({ context: "email" })`. The
// returned `matched.rule === "title_blocklist"` predicate is the
// boolean shape callers depend on.
function isLevelBlocked(title, rules) {
  if (!rules || !Array.isArray(rules.title_blocklist)) return false;
  const result = evaluateJob({
    job: jobFromEmail({ company: "", title }),
    profile: { filter_rules: rules || {} },
    context: "email",
  });
  return result.decision === "skip" && result.skipReason === "title_blocklist";
}

// RFC 040 §7.5 / BL-92: `isLocationBlocked` is deprecated. The free-
// text substring/word-boundary path produced real-world false
// positives (e.g. email body "our New York office is hiring in
// Wisconsin" tripping both NY and WI blocklists). The function stays
// exported for one release with a one-time console.error so existing
// callers keep working; Phase 2 removes it. Behaviour is preserved
// (word-boundary on free text, per BL-100) so existing tests pass
// unchanged.
let _isLocationBlockedWarned = false;
function isLocationBlocked(text, rules) {
  if (!_isLocationBlockedWarned) {
    _isLocationBlockedWarned = true;
    // eslint-disable-next-line no-console
    console.error(
      "DEPRECATED: email_filters.isLocationBlocked — see RFC 040 §7.5, removed in next release"
    );
  }
  if (!rules || !Array.isArray(rules.location_blocklist)) return false;
  const t = String(text || "");
  if (!t) return false;
  return rules.location_blocklist.some((p) => {
    const needle = String(p || "");
    if (!needle) return false;
    return makeBoundaryRegex(needle).test(t);
  });
}

// Deduplication against existing applications.tsv rows.
// Matches by lowercased (company, role) composite key — same as prototype.
function isTSVDup(company, role, rows) {
  const key = `${(company || "").toLowerCase()}|${(role || "").toLowerCase()}`;
  return rows.some(
    (r) =>
      `${(r.companyName || r.company || "").toLowerCase()}|${(r.title || r.role || "").toLowerCase()}` ===
      key
  );
}

module.exports = {
  ATS_DOMAINS,
  RECRUITER_SUBJECT_PATTERNS,
  JOB_ALERT_SENDERS,
  NON_PIPELINE_SENDERS,
  isATS,
  atsFromInclusions,
  atsFromExclusions,
  isJobAlert,
  isNonPipelineSender,
  matchesRecruiterSubject,
  isLevelBlocked,
  isLocationBlocked,
  isTSVDup,
  jobFromEmail,
};
