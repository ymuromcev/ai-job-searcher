// Subject/header parsers for non-pipeline email sources.
// Ported from ../../Job Search/check_emails.js:234-260 (prototype).

// LinkedIn job-alert subjects come in 3 known formats (Russian + English).
// Returns {role, company} or null if the subject doesn't match any known shape.
function parseLinkedInSubject(subject) {
  if (!subject) return null;

  // "Role в компании Company[: ...]"
  let m = subject.match(/^(.+?)\s+в компании\s+(.+?)(?:\s*:|$)/);
  if (m) return { role: m[1].trim(), company: m[2].trim() };

  // "Компания X ищет специалистов: Role[ с зарплатой...]"
  m = subject.match(/^Компания\s+(.+?)\s+ищет специалистов:\s*(.+?)(?:\s+с зарплатой|$)/);
  if (m) return { role: m[2].trim(), company: m[1].trim() };

  // English fallback: "Role at Company[:]"
  m = subject.match(/^(.+?)\s+at\s+(.+?)(?:\s*:|$)/i);
  if (m) return { role: m[1].trim(), company: m[2].trim() };

  return null;
}

// Recruiter outreach subjects: "Requirement for <role>", "Immediate need -
// <region> - <role>", "new opportunity for <role>", etc. Returns role string
// or null when the subject is too generic to extract a role.
function parseRecruiterRole(subject) {
  if (!subject) return null;

  let m = subject.match(/^Requirement for\s+(.+?)(?:\s*::|,\s*Remote|,\s*Onsite|$)/i);
  if (m) return m[1].trim();

  m = subject.match(/^Immediate need\s*[-–]\s*\S+\s*[-–]\s*(.+)/i);
  if (m) return m[1].trim();

  m = subject.match(/new (?:opportunity|role|position) (?:as|for)[:\s]+(?:a\s+)?(.+)/i);
  if (m) return m[1].trim();

  return null;
}

// Pulls a human-readable sender name from an RFC 5322 From header.
// "Jane Doe <jane@acme.com>" → "Jane Doe"; "jane@acme.com" → "acme".
function extractSenderName(from) {
  if (!from) return "";
  const m = from.match(/^([^<@\s][^<@]*?)\s*(?:<|@)/);
  if (m) return m[1].trim();
  const domain = (from.split("@")[1] || "").split(".")[0];
  return domain || from;
}

module.exports = {
  parseLinkedInSubject,
  parseRecruiterRole,
  extractSenderName,
};
