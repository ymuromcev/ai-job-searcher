// Filter primitives shared between `filter.js`, `evaluate_job.js`, and
// `email_filters.js`. Lives in its own file so `evaluate_job.js` can
// import these helpers without taking a runtime dependency on
// `filter.js` (which, post-RFC 040, depends on `evaluate_job.js`).
//
// All helpers are pure, side-effect-free, and operate on plain strings.

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary match that handles patterns whose first or last char is
// a non-word character (comma, dot, space). When the pattern edge is
// already a non-word char, the boundary is intrinsic and `\b` is
// omitted (otherwise `\b` would never fire between two non-word chars).
function makeBoundaryRegex(needle) {
  const lower = String(needle).toLowerCase();
  const startB = /\w/.test(lower[0]) ? "\\b" : "";
  const endB = /\w/.test(lower[lower.length - 1]) ? "\\b" : "";
  return new RegExp(`${startB}${escapeRegex(lower)}${endB}`, "i");
}

// BL-79: shared title_blocklist semantics. Word-boundary regex +
// slash-split so:
//   - "rn" does NOT match "PRN Coordinator"
//   - "rn" DOES match "RN Manager"
//   - a slash-compound title passes if ANY part is clean
// `patterns` is a flat array of pattern strings (callers normalize
// their own shapes first — keeps the helper neutral about
// `{pattern,reason}` vs raw strings).
// Returns the first matching pattern string, or null if the title is
// clean.
function findTitleBlocklistHit(title, patterns) {
  if (!patterns || patterns.length === 0) return null;
  const titleLower = String(title || "").toLowerCase();
  if (!titleLower) return null;
  const parts = titleLower
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  const titleParts = parts.length > 0 ? parts : [titleLower];

  let firstHit = null;
  for (const part of titleParts) {
    let partHit = null;
    for (const pat of patterns) {
      const needle = String(pat || "");
      if (!needle) continue;
      if (makeBoundaryRegex(needle).test(part)) {
        partHit = needle;
        break;
      }
    }
    if (partHit) {
      if (firstHit == null) firstHit = partHit;
    } else {
      return null; // any clean part → title passes
    }
  }
  return firstHit;
}

module.exports = {
  escapeRegex,
  makeBoundaryRegex,
  findTitleBlocklistHit,
};
