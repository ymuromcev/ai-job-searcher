// Canonical enumeration of engine-emitted `skip_reason` values written to
// `applications.tsv` when `prepare --phase pre` archives a filter-rejected
// row (RFC 035 / BL-91).
//
// Two distinct families share the `skip_reason` column in TSV v4+:
//
//   1. Engine-emitted (this file): the engine's deterministic filter chain
//      decided the row is not worth surfacing to the SKILL. Pre-phase writes
//      `status="Archived"` + `skip_reason=<value from this set>` directly.
//      Never reaches Notion (RFC 014: Inbox is TSV-only; archive is local).
//
//   2. SKILL-legacy (`SKILL_LEGACY_SKIP_REASONS` in `commands/prepare.js`):
//      `"weak_fit"` and `"duplicate"`, retained for one release after
//      RFC 034 for back-compat with stale SKILL checkouts that still emit
//      `skipReason` on results.json entries.
//
// The two sets do not overlap. Tests assert any reason appearing in
// `prepare_context.skipped[].reason` is either an engine reason here OR one
// of the synthetic `already_evaluated_*` reasons (which are surfaced to the
// SKILL for context but never trigger a TSV write — the rows already carry
// their judgement from a prior run).
//
// Adding a new engine filter reason: append it here, otherwise the enum
// guard test fails loudly. Keep values stable (operator-facing in TSV).
//
// RFC 039 / BL-89: `hard_blocker:*` is a wildcard family. `findHardBlockers`
// emits codes like `hard_blocker:required_skill_excluded:Python`, where the
// suffix is a structured sub-reason. We accept any non-empty suffix via the
// `isEngineSkipReason` predicate so the enum guard test in `prepare.test.js`
// allows the whole family without enumerating every possible skill name.

const ENGINE_SKIP_REASONS = Object.freeze(
  new Set([
    // Filter (applyPrepareFilter)
    "company_blocklist",
    "title_blocklist",
    "title_requirelist",
    "company_cap",
    // Geo (enforceGeo via applyPrepareFilter)
    "geo_no_location",
    "geo_blocklist",
    "geo_metro_miss",
    "geo_country_miss",
    "geo_remote_only_miss",
    "geo_unknown_mode",
    // Geo title (RFC 039 / BL-89: extractTitleGeo via applyPrepareFilter)
    "geo_title_excluded",
    // URL liveness (checkUrls)
    "url_dead",
  ])
);

// RFC 039 / BL-89: hard-blocker reason family. Wildcard prefix; the suffix
// carries the structured sub-reason emitted by `findHardBlockers` (e.g.
// `hard_blocker:required_skill_excluded:Python`). `isEngineSkipReason`
// accepts any `hard_blocker:<non-empty>` value; the prepare.js archive
// path uses the FULL string verbatim as the TSV `skip_reason`.
const HARD_BLOCKER_PREFIX = "hard_blocker:";

// Synthetic reasons surfaced in `prepare_context.skipped[]` for SKILL
// context. They DO NOT trigger archive writes — the rows already have
// `fit_score=Weak` / `skip_reason=weak_fit` / `skip_reason=duplicate`
// from a prior SKILL run, so their TSV state is already correct.
const ALREADY_EVALUATED_REASONS = Object.freeze(
  new Set(["already_evaluated_weak", "already_evaluated_duplicate"])
);

/**
 * Is `reason` an engine-emitted skip-reason (literal enum value or a
 * `hard_blocker:<non-empty>` wildcard)? Used by the archive path and by
 * the enum-guard test in `prepare.test.js`.
 *
 * @param {string} reason
 * @returns {boolean}
 */
function isEngineSkipReason(reason) {
  if (typeof reason !== "string" || !reason) return false;
  if (ENGINE_SKIP_REASONS.has(reason)) return true;
  if (reason.startsWith(HARD_BLOCKER_PREFIX) && reason.length > HARD_BLOCKER_PREFIX.length) {
    return true;
  }
  return false;
}

module.exports = {
  ENGINE_SKIP_REASONS,
  ALREADY_EVALUATED_REASONS,
  HARD_BLOCKER_PREFIX,
  isEngineSkipReason,
};
