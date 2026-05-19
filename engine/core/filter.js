// Pure filter: applies profile filter_rules to a list of jobs.
// Returns partitioned { passed, rejected } with reasons.
//
// RFC 040 / BL-92: this module is now a thin shim layer over
// `evaluate_job.js`. The public API (`filterJobs` / `checkJob` /
// `matchBlocklists`) is preserved bit-identical for one release —
// existing callers in scan / validate retro-sweep do not need to
// change. Phase 2 will inline the `evaluateJob` calls here and delete
// the shim translation.
//
// Why a shim layer: the legacy API speaks in terms of `job.role`,
// `job.location`/`job.locations`, and returns `{ kind, ... } | null`.
// `evaluateJob` speaks in `job.title`, `job.locations[]`, and returns
// `{ decision, skipReason, matched }`. The adapter `jobFromAdapterScan`
// + the small `legacyReasonFor` translator are the only place this
// translation lives — drift is eliminated everywhere else.

const { enforceGeo, hasUsMarker, US_MARKERS } = require("./geo_enforcer.js");
const { findTitleBlocklistHit } = require("./filter_helpers.js");
const { evaluateJob } = require("./evaluate_job.js");

// Re-exported for back-compat — see filter.test.js (BL-81 fixture
// imports US_MARKERS from filter.js).
// `findTitleBlocklistHit` is also re-exported (BL-100: email_filters
// and prepare.js both import it from here).

/**
 * Shape adapter: legacy scan-style job → EvaluateJobInput.job.
 * Scan jobs carry `role` (not `title`), `location` (single string) or
 * `locations[]`, and `company`.
 */
function jobFromAdapterScan(scanJob) {
  const j = scanJob || {};
  return {
    company: String(j.company || ""),
    title: String(j.role || j.title || ""),
    locations:
      Array.isArray(j.locations) && j.locations.length > 0
        ? j.locations.map(String)
        : j.location
          ? [String(j.location)]
          : [],
    url: j.jobUrl || j.url || "",
    source: j.source || "",
  };
}

// Translate an evaluateJob result into the legacy `matchBlocklists`
// return shape (`{ kind, ... } | null`). `matchBlocklists` historically
// does NOT consult `company_cap` (that's `checkJob`'s job). The shim
// here mirrors that split — see the explicit company_cap exclusion.
function legacyReasonForMatchBlocklists(result) {
  if (!result || result.decision === "keep") return null;
  const reason = result.skipReason;
  const matched = result.matched || {};
  if (reason === "company_blocklist") {
    return { kind: "company_blocklist", company: matched.company };
  }
  if (reason === "title_requirelist") {
    return {
      kind: "title_requirelist",
      why: matched.why,
    };
  }
  if (reason === "title_blocklist") {
    return {
      kind: "title_blocklist",
      pattern: matched.pattern,
      why: matched.reason,
    };
  }
  if (reason === "location_blocklist") {
    return {
      kind: "location_blocklist",
      match: matched.match,
    };
  }
  if (reason && reason.startsWith("geo_")) {
    return { kind: reason, mode: matched.mode };
  }
  return null;
}

/**
 * Returns a reason object for the first matching blocklist (company /
 * title / location / geo) or null if nothing matches. Content-only:
 * does NOT consult company_cap. Used by:
 *   - checkJob: full SCAN-time gate (blocklists + cap)
 *   - validate retro-sweep: re-screen existing "To Apply" rows after
 *     filter_rules updates, without re-counting caps.
 *
 * Phase 1 shim: delegates to `evaluateJob` with a synthetic context
 * that includes ALL rules except company_cap (matchBlocklists never
 * consulted it). We achieve this by stripping `company_cap` from rules
 * before delegating — keeps the cap call-site as `checkJob`.
 */
function matchBlocklists(job, rules) {
  const evalJob = jobFromAdapterScan(job);
  const rulesForBlocklists = { ...(rules || {}) };
  delete rulesForBlocklists.company_cap;
  const profile = {
    filter_rules: rulesForBlocklists,
    geo: rules && rules.geo ? rules.geo : null,
  };
  const result = evaluateJob({
    job: evalJob,
    profile,
    appState: { companyCounts: {} },
    context: "scan",
  });
  return legacyReasonForMatchBlocklists(result);
}

function checkJob(job, rules, counts) {
  const evalJob = jobFromAdapterScan(job);
  const profile = {
    filter_rules: rules || {},
    geo: rules && rules.geo ? rules.geo : null,
  };
  const result = evaluateJob({
    job: evalJob,
    profile,
    appState: { companyCounts: counts || {} },
    context: "scan",
  });
  if (result.decision === "keep") return null;
  const reason = result.skipReason;
  const matched = result.matched || {};
  if (reason === "company_cap") {
    return { kind: "company_cap", cap: matched.cap, current: matched.current };
  }
  return legacyReasonForMatchBlocklists(result);
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
  jobFromAdapterScan,
  US_MARKERS,
  hasUsMarker,
  // Re-exported so existing internal callers (geo_enforcer test, etc.)
  // can keep importing from here.
  enforceGeo,
};
