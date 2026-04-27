// Pure filter: applies profile filter_rules to a list of jobs.
// Returns partitioned { passed, rejected } with reasons.
//
// Rules schema (see profiles/_example/filter_rules.example.json):
//   company_cap:        { max_active, overrides: { [company]: max } }
//   company_blocklist:  [names]                   case-insensitive exact match
//   title_blocklist:    [{ pattern, reason }]     case-insensitive substring match
//   location_blocklist: [substrings]              case-insensitive substring match,
//                                                 skipped entirely when job location
//                                                 contains a US marker (united states,
//                                                 usa, ", us", "(us)", "u.s.")
//
// Semantics match the prototype's validate_inbox.js so that migrated filter_rules
// behave identically in the new engine. See audit_prototype_alignment.md §6.

const US_MARKERS = ["united states", "usa", ", us", "(us)", "u.s."];

function hasUsMarker(locLower) {
  return US_MARKERS.some((m) => locLower.includes(m));
}

// Returns a reason object for the first matching blocklist (company / title /
// location) or null if nothing matches. Content-only: does NOT consult
// company_cap. Used by:
//   - checkJob: full SCAN-time gate (blocklists + cap)
//   - validate retro-sweep: re-screen existing "To Apply" rows after
//     filter_rules updates, without re-counting caps.
//
// Note: TSV rows (applications.tsv) do not store `location`, so retro-sweep
// only exercises company + title checks in practice. Location blocklist is
// only applied at SCAN time when the full job object is available.
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
  for (const pat of rules.title_blocklist || []) {
    const needle = String(pat.pattern || "").toLowerCase();
    if (needle && roleLower.includes(needle)) {
      return { kind: "title_blocklist", pattern: pat.pattern, why: pat.reason };
    }
  }

  const loc = String(job.location || "").toLowerCase();
  if (loc && !hasUsMarker(loc)) {
    for (const blocked of rules.location_blocklist || []) {
      if (loc.includes(String(blocked).toLowerCase())) {
        return { kind: "location_blocklist", match: blocked };
      }
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

module.exports = { filterJobs, checkJob, matchBlocklists, US_MARKERS };
