// Pure dedup for Application Q&A entries.
// Key shape: `${company}||${role}||${question[:120]}` lowercased + trimmed.
// Question is truncated to 120 chars so long prose questions don't make the
// key fragile to whitespace/punctuation drift on copy-paste.
// Mirrors the key shape used by scripts/stage16/migrate_application_qa.js.

const QUESTION_HEAD_LIMIT = 120;

function normField(value) {
  return String(value || "").trim().toLowerCase();
}

function dedupKey({ company, role, question } = {}) {
  const co = normField(company);
  const ro = normField(role);
  const qu = normField(question).slice(0, QUESTION_HEAD_LIMIT);
  return `${co}||${ro}||${qu}`;
}

function isExactMatch(a, b) {
  return dedupKey(a) === dedupKey(b);
}

module.exports = { dedupKey, isExactMatch, QUESTION_HEAD_LIMIT };
