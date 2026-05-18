// Pure filter: applies profile filter_rules to a list of jobs.
// Returns partitioned { passed, rejected } with reasons.
//
// Rules schema (see profiles/_example/filter_rules.example.json):
//   company_cap:        { max_active, overrides: { [company]: max } }
//   company_blocklist:  [names]                   case-insensitive exact match
//   title_blocklist:    [{ pattern, reason }]     case-insensitive WORD-BOUNDARY match
//   location_blocklist: [substrings]              case-insensitive substring match,
//                                                 skipped entirely when job location
//                                                 contains a US marker (united states,
//                                                 usa, ", us", "(us)", "u.s.")
//   geo:                profile.geo block (RFC 013, L-4) — when present and
//                                                 mode !== "unrestricted",
//                                                 enforces positive geo policy
//                                                 via geo_enforcer.enforceGeo.
//                                                 Caller (scan.js / validate.js)
//                                                 is expected to set
//                                                 rules.geo = profile.geo before
//                                                 calling.
//
// Multi-location support (RFC 013, L-4): job objects may carry either
// `location` (single string) or `locations[]` (array). Filter prefers
// `locations[]` when present and falls back to `[location]` otherwise. For
// blocklist purposes the first location is checked (as before — historic
// contract). For geo enforcer, the full array is passed.
//
// Title-blocklist semantics (2026-04-28 update — diverges from prototype):
//   - Word-boundary regex (\b…\b) instead of plain substring. Avoids false
//     positives like "PRN" matching "rn" or "orthodontic" matching "do".
//   - Compound title split on "/" (slash-titles like "Receptionist/Office
//     Manager"). If ANY split part is clean (no blocklist hit), the whole
//     title passes — caters to hybrid roles where one half is desirable.
//     NOTE: split is "/" only — not "," (e.g. "Supervisor, Medical" stays
//     a single part: "Medical" is a department modifier, not a co-role).

// US-marker primitives live in geo_enforcer.js (BL-81 — single source of
// truth). Importing keeps filter.js and geo_enforcer.js classification
// aligned. US_MARKERS is re-exported for back-compat (filter.test.js).
const { enforceGeo, hasUsMarker, US_MARKERS } = require("./geo_enforcer.js");

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary match that also handles patterns whose first or last char is
// a non-word character (comma, dot, space). Plain `\b...\b` fails for those
// because `\b` requires a word/non-word transition — it never fires between
// two non-word chars (e.g. between `,` and ` `). When the pattern edge is
// already a non-word char, the boundary is intrinsic and `\b` is omitted.
function makeBoundaryRegex(needle) {
  const lower = String(needle).toLowerCase();
  const startB = /\w/.test(lower[0]) ? "\\b" : "";
  const endB = /\w/.test(lower[lower.length - 1]) ? "\\b" : "";
  return new RegExp(`${startB}${escapeRegex(lower)}${endB}`, "i");
}

// BL-79: shared title_blocklist semantics for scan (matchBlocklists) and
// prepare (applyPrepareFilter). Word-boundary regex + slash-split so:
//   - "rn" does NOT match "PRN Coordinator"
//   - "rn" DOES match "RN Manager"
//   - a slash-compound title passes if ANY part is clean
// `patterns` is a flat array of pattern strings (callers normalize their own
// shapes first — keeps the helper neutral about {pattern,reason} vs raw).
// Returns the first matching pattern string, or null if the title is clean.
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

// Returns a reason object for the first matching blocklist (company / title /
// location) or null if nothing matches. Content-only: does NOT consult
// company_cap. Used by:
//   - checkJob: full SCAN-time gate (blocklists + cap)
//   - validate retro-sweep: re-screen existing "To Apply" rows after
//     filter_rules updates, without re-counting caps.
//
// Note: since schema v3 (G-5, 2026-05-03), TSV rows DO carry `location`, so
// retro-sweep exercises location_blocklist + geo enforcement on the row's
// stored location. Backfilled rows from the master pool have it; older rows
// without a backfill stay with location="" and never hit a substring match.
// (G-33 closed 2026-05-04 — covered together with G-5 + L-4.)
function matchBlocklists(job, rules) {
  const company = String(job.company || "");
  const companyLower = company.toLowerCase();
  if (Array.isArray(rules.company_blocklist)) {
    for (const blocked of rules.company_blocklist) {
      if (String(blocked).toLowerCase() === companyLower) {
        return { kind: "company_blocklist", company };
      }
    }
  }

  const role = String(job.role || "");
  const roleLower = role.toLowerCase();
  if (roleLower) {
    // Compound titles use "/" as a co-role separator. Split and check each
    // part independently — if any single part is clean, the title passes.
    // Example: "Dental Receptionist/Office Manager" passes for someone whose
    // blocklist contains "manager" because "Dental Receptionist" is clean.
    // We do NOT split on "," — "Supervisor, Medical" is one role with a
    // department modifier, not two roles.
    const titleParts = roleLower
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean);
    const parts = titleParts.length > 0 ? titleParts : [roleLower];

    // title_requirelist: positive gate — if configured, at least one title
    // part must match at least one required pattern. Rejects non-PM roles
    // (e.g. SWE, DevOps, Accounting) that slip through the company-level
    // filters because ATS adapters return all open roles, not just PM ones.
    if (Array.isArray(rules.title_requirelist) && rules.title_requirelist.length > 0) {
      const anyPartMatches = parts.some((part) =>
        rules.title_requirelist.some((pat) => {
          const needle = String(pat.pattern || "");
          if (!needle) return false;
          return makeBoundaryRegex(needle).test(part);
        })
      );
      if (!anyPartMatches) {
        return { kind: "title_requirelist", why: "title does not match any required pattern" };
      }
    }

    // BL-79: delegate to findTitleBlocklistHit so prepare.js and scan.js
    // share semantics. We still need the {pattern, reason} object for the
    // returned reason, so we resolve back to the original entry after hit.
    const blocklist = Array.isArray(rules.title_blocklist) ? rules.title_blocklist : [];
    const patternStrs = blocklist
      .map((p) => String((p && p.pattern) || ""))
      .filter((s) => s.length > 0);
    const hit = findTitleBlocklistHit(roleLower, patternStrs);
    if (hit) {
      const orig = blocklist.find(
        (p) => String((p && p.pattern) || "").toLowerCase() === hit.toLowerCase()
      );
      return {
        kind: "title_blocklist",
        pattern: orig ? orig.pattern : hit,
        why: orig ? orig.reason : undefined,
      };
    }
  }

  // BL-24 (2026-05-18): iterate the full locations[] array, not just the
  // first-element string. Previous behaviour collapsed `locations[]` to
  // `locations[0]` in scan.js and missed multi-loc jobs whose first element
  // happened to be US-clean while later elements carried country tags. New
  // contract: a US marker in ANY element keeps the job (US-hirable wins),
  // otherwise a blocklist match in ANY element blocks. Single-string
  // `job.location` is wrapped to preserve the historic single-value contract.
  const locsArr =
    Array.isArray(job.locations) && job.locations.length > 0
      ? job.locations.map(String)
      : job.location
        ? [String(job.location)]
        : [];
  const locsLower = locsArr.map((l) => l.toLowerCase());
  if (locsLower.length > 0 && !hasUsMarker(locsLower)) {
    for (const blocked of rules.location_blocklist || []) {
      const needle = String(blocked).toLowerCase();
      if (!needle) continue;
      if (locsLower.some((l) => l.includes(needle))) {
        return { kind: "location_blocklist", match: blocked };
      }
    }
  }

  // L-4 / RFC 013: profile-level geo enforcement. Active only when caller
  // injected `rules.geo` AND mode !== "unrestricted". Multi-location aware:
  // we pass the full locations[] array if available, else fall back to the
  // single string. enforceGeo returns ok=true for unrestricted mode, so the
  // explicit guard below is just an optimization (skip the call entirely).
  if (rules.geo && rules.geo.mode && rules.geo.mode !== "unrestricted") {
    const locsForGeo =
      Array.isArray(job.locations) && job.locations.length > 0
        ? job.locations
        : job.location
          ? [job.location]
          : [];
    const geoResult = enforceGeo(locsForGeo, rules.geo);
    if (!geoResult.ok) {
      return { kind: geoResult.reason, mode: rules.geo.mode };
    }
  }

  return null;
}

function checkJob(job, rules, counts) {
  const blockReason = matchBlocklists(job, rules);
  if (blockReason) return blockReason;

  const cap = rules.company_cap || {};
  const overrides = cap.overrides || {};
  const limit = Object.prototype.hasOwnProperty.call(overrides, job.company)
    ? overrides[job.company]
    : cap.max_active != null
      ? cap.max_active
      : Infinity;
  const current = counts[job.company] || 0;
  if (current >= limit) {
    return { kind: "company_cap", cap: limit, current };
  }

  return null;
}

function filterJobs(jobs, rules, currentCounts = {}) {
  if (!Array.isArray(jobs)) throw new Error("jobs must be an array");
  if (!rules || typeof rules !== "object") throw new Error("rules must be an object");

  const counts = { ...currentCounts };
  const passed = [];
  const rejected = [];

  for (const job of jobs) {
    const reason = checkJob(job, rules, counts);
    if (reason) {
      rejected.push({ job, reason });
    } else {
      passed.push(job);
      counts[job.company] = (counts[job.company] || 0) + 1;
    }
  }

  return { passed, rejected, finalCounts: counts };
}

module.exports = {
  filterJobs,
  checkJob,
  matchBlocklists,
  findTitleBlocklistHit,
  US_MARKERS,
  hasUsMarker,
};
