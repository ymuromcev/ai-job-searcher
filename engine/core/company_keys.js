// Shared company-identity keys for dedup across the pipeline.
//
// Two normalized keys turn a company into a comparison token:
//   - normalizeName(raw)   — Cyrillic-safe name key (diacritics, punctuation,
//                            legal-suffix peeling). Originally lived in
//                            scripts/relokant/sweep_dedup.js; moved here so the
//                            relokant sweep dedup and the Notion upsert share
//                            ONE implementation (RFC 062).
//   - normalizeDomain(raw) — website key (scheme / www / path stripped).
//
// Pure functions over strings. No I/O, no network.

// Legal-entity suffixes stripped before comparison so "Virto Commerce, Inc."
// matches "Virto Commerce". Applied as a trailing-token set.
const LEGAL_SUFFIXES = new Set([
  "inc",
  "llc",
  "ltd",
  "limited",
  "gmbh",
  "corp",
  "co",
  "company",
  "plc",
  "ag",
  "sa",
  "bv",
  "oy",
  "ab",
]);

// Normalize a company name to a comparison key:
//   - strip diacritics (José -> jose)
//   - lowercase
//   - drop punctuation (keep Unicode letters/digits + spaces)
//   - collapse whitespace
//   - drop trailing legal-entity suffix tokens
function normalizeName(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.normalize("NFKD").replace(/[̀-ͯ]/g, ""); // strip Latin diacritics
  s = s.toLowerCase();
  // Drop punctuation but KEEP Unicode letters/digits — many CIS company
  // names are Cyrillic; stripping to ASCII would normalize "Яндекс" to ""
  // and the dedup would then mislabel a genuinely new company as a dup.
  s = s.replace(/[^\p{L}\p{N}\s]/gu, " "); // punctuation -> space
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "";
  let tokens = s.split(" ");
  // Peel trailing legal suffixes (e.g. "... inc", "... co ltd").
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(" ");
}

// Normalize a website / URL to a domain comparison key:
//   - lowercase
//   - strip scheme (http://, https://)
//   - strip a single leading "www."
//   - drop everything from the first path / query / port separator
//   - drop a trailing dot
// "https://www.Lokalise.com/careers" and "lokalise.com" both -> "lokalise.com".
function normalizeDomain(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme
  s = s.replace(/^www\./, ""); // strip leading www.
  s = s.split(/[/?#:]/)[0]; // drop path / query / fragment / port
  s = s.replace(/\.+$/, ""); // drop trailing dot(s)
  return s.trim();
}

module.exports = { normalizeName, normalizeDomain, LEGAL_SUFFIXES };
