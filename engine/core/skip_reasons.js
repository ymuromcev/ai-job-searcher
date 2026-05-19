// Canonical enumeration of engine-emitted `skip_reason` values written to
// `applications.tsv` when `prepare --phase pre` archives a filter-rejected
// row (RFC 035 / BL-91).
//
// Two distinct families share the `skip_reason` column in TSV v4:
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
    // URL liveness (checkUrls)
    "url_dead",
  ])
);

// Synthetic reasons surfaced in `prepare_context.skipped[]` for SKILL
// context. They DO NOT trigger archive writes — the rows already have
// `fit_score=Weak` / `skip_reason=weak_fit` / `skip_reason=duplicate`
// from a prior SKILL run, so their TSV state is already correct.
const ALREADY_EVALUATED_REASONS = Object.freeze(
  new Set(["already_evaluated_weak", "already_evaluated_duplicate"])
);

function isEngineSkipReason(reason) {
  return typeof reason === "string" && ENGINE_SKIP_REASONS.has(reason);
}

module.exports = {
  ENGINE_SKIP_REASONS,
  ALREADY_EVALUATED_REASONS,
  isEngineSkipReason,
};
