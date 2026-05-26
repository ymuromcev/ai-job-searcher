// engine/core/role_slug.js
//
// Pure helper for normalizing a job-role title into a filename-safe slug.
// Used by `engine/modules/tailor/dispatcher.js` when computing per-row
// tailored resume paths so that multiple roles at the same company on the
// same day don't collide (BL-F).
//
// Shape: lowercase, non-alphanumeric → "-", strip leading/trailing dashes,
// slice to `maxLen` (default 40). Empty / null / non-string input falls back
// to the literal string "role" so callers always get a usable segment.
//
// Symmetry with the cover-letter `clKey` convention
// (`<Company>_<role-slug>_<YYYYMMDD>`) is intentional — the resume PDF for
// a given row mirrors its CL filename pattern.

function slugifyRole(title, maxLen = 40) {
  if (typeof maxLen !== "number" || !Number.isFinite(maxLen) || maxLen <= 0) {
    maxLen = 40;
  }
  const raw = String(title == null ? "" : title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, ""); // re-trim if slice landed mid-separator
  return raw || "role";
}

module.exports = { slugifyRole };
