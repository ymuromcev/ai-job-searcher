// Pure helper: company name → filesystem-safe slug used as a folder name
// inside `profiles/<id>/cover_letters/<slug>/` and `cover_letters_md/<slug>/`.
//
// Rules (per RFC 019):
//   - `&` → `and`
//   - any non-alphanumeric run → single `_`
//   - collapse multiple `_` → single `_`
//   - trim leading / trailing `_`
//   - PRESERVE case (`Affirm` stays `Affirm`, not `affirm`) — folder names
//     stay readable in Finder, matching how a human would name them.
//   - empty / pure-symbol input → `_unknown` (sentinel — easy to spot in
//     migration reports).
//
// Profiles are US-only for now, so non-ASCII names (Cyrillic, etc.) collapse
// to `_unknown` after the non-alphanumeric pass. Acceptable for current scope;
// migration dry-run surfaces these so we can hand-fix if a real case lands.

function slugifyCompany(name) {
  if (name === null || name === undefined) return "_unknown";
  let s = String(name);

  // Replace `&` with the word `and` first so it survives the
  // non-alphanumeric pass (otherwise it'd just become `_`).
  s = s.replace(/&/g, " and ");

  // Anything that's not [A-Za-z0-9] becomes `_`.
  s = s.replace(/[^A-Za-z0-9]+/g, "_");

  // Collapse multiple underscores.
  s = s.replace(/_+/g, "_");

  // Trim leading / trailing underscores.
  s = s.replace(/^_+|_+$/g, "");

  if (s.length === 0) return "_unknown";
  return s;
}

module.exports = { slugifyCompany };
