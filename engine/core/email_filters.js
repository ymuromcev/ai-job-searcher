// Email-source and content filters for the check command.
// Ported from ../../Job Search/check_emails.js:54-74, 224-267 (prototype).

// ATS domains — senders on these platforms are job-application-system
// notifications (acks, rejections, etc.), not recruiter outreach, so they
// bypass the recruiter-outreach branch.
const ATS_DOMAINS = [
  "greenhouse-mail.io",
  "us.greenhouse-mail.io",
  "hire.lever.co",
  "myworkdayjobs.com",
  "ashbyhq.com",
  "smartrecruiters.com",
  "icims.com",
  "bamboohr.com",
  "jobvite.com",
  "workable.com",
  "taleo.net",
  "jobot.com",
  "ashby.com",
];

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
  // ZipRecruiter / Glassdoor / Monster digests
  { fromIncludes: "@ziprecruiter.com", subjectMatches: /\b(new jobs?|matching jobs?|jobs? for you|job alert)\b/i },
  { fromIncludes: "@glassdoor.com", subjectMatches: /\b(new jobs?|matching jobs?|jobs? for you|job alert)\b/i },
  { fromIncludes: "@monster.com", subjectMatches: /\b(new jobs?|matching jobs?|jobs? for you|job alert)\b/i },
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

// Level blocklist uses substring match on the title (prototype behavior).
// rules arrives in the flat engine shape after profile_loader normalization:
//   { title_blocklist: [{pattern, reason}, ...] }
function isLevelBlocked(title, rules) {
  if (!rules || !Array.isArray(rules.title_blocklist)) return false;
  const t = (title || "").toLowerCase();
  return rules.title_blocklist.some((p) =>
    t.includes(String((p && (p.pattern || p)) || "").toLowerCase())
  );
}

// Location blocklist uses substring match on free-text context (subject/body).
// rules arrives in the flat engine shape: { location_blocklist: [strings] }.
function isLocationBlocked(text, rules) {
  if (!rules || !Array.isArray(rules.location_blocklist)) return false;
  const t = (text || "").toLowerCase();
  return rules.location_blocklist.some((p) =>
    t.includes(String(p || "").toLowerCase())
  );
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
  isJobAlert,
  isNonPipelineSender,
  matchesRecruiterSubject,
  isLevelBlocked,
  isLocationBlocked,
  isTSVDup,
};
