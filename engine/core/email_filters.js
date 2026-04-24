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
  isATS,
  matchesRecruiterSubject,
  isLevelBlocked,
  isLocationBlocked,
  isTSVDup,
};
