---
id: RFC-013
title: Profile-level geo enforcement across all ATS adapters
status: draft
tier: L
created: 2026-05-04
tags: [discovery, geo, filter]
---

# RFC 013 — Profile-level geo enforcement across all ATS adapters

**Status**: Draft v2 — awaiting approval to start implementation
**Tier**: L (architectural — single geo contract for all 11 adapters + SKILL Step 3 refactor + migration of configs for both profiles; per `DEVELOPMENT.md` requires RFC + approve before code)
**Author**: Claude (sonnet), 2026-05-04
**Triggered by**:
- Incident 2026-05-02 — 485 Fresenius global jobs (Germany, Brazil, India, …) landed in Healthcare-Hannah's inbox under a Roseville-only setup.
- L-4 in `docs/GAPS_REVIEW.md` (absorbs G-7).
**Depends on**: RFC 001 (multi-profile architecture). Does not block RFC 012 (relational data model).
**Replaces**: stub v1 of this same file.

> Note: GAPS_REVIEW in the current edition calls this document "RFC-005". This is a stale reference — the real number is `013` (005 is taken by `005-gmail-cron-autonomous-check.md`). The tracker will be fixed in the commit closing L-4.

---

## 1. Problem

A profile declares its location (`identity.location`, `preferences.locations_ok`, `preferences.work_format`), but **the engine doesn't use any of this** for global discovery filtering. The decision is made in three out-of-sync places:

1. **`engine/core/filter.js`** — supports `location_blocklist` (substring deny-list with US-marker safeguard). Applied to all 11 adapters at scan-time. This is a **deny-list**, not a whitelist — you can't globally cut off a region.
2. **`engine/modules/discovery/indeed.js`** — the only adapter that reads `discovery.indeed.filters.location_whitelist` / `location_blocklist`. Only for Healthcare-Hannah, only for the Indeed feed.
3. **SKILL Step 3** — Claude makes the `geo: "us-compatible"` decision based on `jdText` via WebFetch. Doesn't use `profile.geo`, doesn't distinguish Healthcare-Hannah's "Sacramento metro only" vs PM-Pete's "US-wide OK". The decision is unstable (depends on LLM output) and re-fetches JD unnecessarily.

Consequences:

- **Healthcare-Hannah**: 485 Fresenius global jobs (Germany / Brazil / India) come in as `geo: "us-compatible"` in SKILL Step 3, because `jdText` mentions "US" somewhere in boilerplate. Not relocating → blocker for live prepare.
- **PM-Pete**: 12 Workday tenants (PayPal, Capital One, Fidelity) show global postings → land in the inbox with UK / Singapore / India locations. Less critical (he's open to remote), but lots of noise.
- **Any next profile**: when adding a new profile, you'll have to repeat the hack about `discovery.indeed.filters.location_whitelist` or live with deny-list only.

## 2. Goals

- **Single source of truth**: the profile declares geo once → all 11 adapters + validate retro-sweep + SKILL Step 3 respect it.
- **Positive policy** (whitelist), not only deny-list. "Sacramento metro + Remote only" cannot be expressed via `location_blocklist`.
- **Multi-profile correctly**: shared company target → each profile filters itself, no global state.
- **Back-compat**: absence of the `profile.geo` block = `unrestricted` mode = PM-Pete's current behavior does not change.
- **Determinism**: SKILL Step 3 does no WebFetch — reads `prepare_context.batch[i].geo_decision` already resolved by the engine.
- **Closes G-33** as a side effect (retro-sweep starts respecting positive geo policy after TSV location migration).

## 3. Non-goals

- **Distance API / driving time**: only match against a list of cities/states. `max_radius_miles` in this RFC is a schema field for future geocoding integration, not used in v1 (see §10).
- **Server-side filter in adapters**: the universal post-fetch filter in `filter.js` works for all 11. Workday `appliedFacets` UUIDs / Indeed `?l=&radius=` URL params — separate backlog item for traffic optimization, not part of L-4.
- **Refactor `preferences.locations_ok` / `discovery.indeed.filters.*`**: both remain in the schema until migration (deprecated, read as fallback). Removal — separate cleanup commit after stabilization.
- **Geocoding cities into coordinates**: out of scope.
- **Cover letter / resume customization by location**: separate concern.

## 4. Proposed solution

### 4.1 Schema — `profile.json.geo` block

```jsonc
"geo": {
  "mode": "metro" | "us-wide" | "remote-only" | "unrestricted",

  // Required when mode === "metro". Substring match (case-insensitive).
  // Each city is a minimal token that must occur in job.location.
  "cities": ["Sacramento", "Roseville", "Folsom", "Rocklin", "Citrus Heights",
             "Elk Grove", "Auburn", "Rancho Cordova", "Davis", "West Sacramento",
             "Carmichael", "Fair Oaks"],

  // REQUIRED when mode === "metro" (resolved 2026-05-04 — open question §8.1
  // closed: states are required to exclude ambiguous-name cities like
  // Auburn (CA / AL / NY / WA) or Springfield. Profile_loader throws
  // ValidationError on metro mode without states.
  "states": ["CA"],

  // Required when mode === "us-wide". ISO codes.
  "countries": ["US"],

  // Optional. Default = false (Healthcare-Hannah: false, PM-Pete: true).
  // true = a job with a location containing "Remote" / "Anywhere" / "Work from home"
  // passes regardless of cities/states/countries.
  "remote_ok": false,

  // Optional. Substring deny-list, on top of the positive policy. Duplicates
  // `filter_rules.location_blocklist` deliberately (so that the geo block is
  // self-sufficient), the engine reads both and unions them.
  "blocklist": ["Napa", "Stockton", "Lodi", "Vacaville", "Modesto"],

  // Reserved for future geocoding. NOT used in v1. Documented in the schema
  // so that adding it is not a breaking change.
  "max_radius_miles": null
}
```

**Modes**:

| mode | Semantics | For whom |
|---|---|---|
| `metro` | job.location must contain any of `cities` (case-insensitive substring). If `states` is non-empty — also any of `states`. `remote_ok` optionally lets remote roles through. | Healthcare-Hannah |
| `us-wide` | job.location must contain a US/USA marker (any of `US_MARKERS` from `filter.js`) OR be in one of `countries` via an ISO/state hint. `remote_ok` optionally lets "Remote" through. | (optionally for PM-Pete — alt to `unrestricted`) |
| `remote-only` | job.location must contain "Remote" / "Anywhere" / "Work from home". Cities/states are ignored. | Future remote-only profiles |
| `unrestricted` | Geo is not enforced. Only `blocklist` (if set) and `filter_rules.location_blocklist` are applied. | PM-Pete (back-compat) — current behavior |

**Default**: `profile.geo` block is absent ⇒ `unrestricted` mode (zero regression).

### 4.2 Architectural layers

```
profile.json.geo  ─────────► profile_loader.normalizeGeo()
                                       │
                                       ▼
                               profile.geo (canonical)
                                       │
       ┌───────────────────────────────┼─────────────────────────────────┐
       ▼                               ▼                                 ▼
scan.js (filterJobs:            prepare.js (pre-phase):           validate.js (retro-sweep):
  rules.geo = profile.geo)         entry.geo_decision               matchBlocklists +
       │                                │                          enforceGeo per row
       ▼                                ▼                                 │
engine/core/filter.js          engine/core/geo_enforcer.js                ▼
  matchBlocklists()              enforceGeo(job, profile.geo)      retro-sweep respects
       │                                │                          positive geo policy
       ▼                                ▼                          (closes G-33)
  enforceGeo(job, rules.geo)    prepare_context.batch[i].
       │                          geo_decision: "allowed" |
       ▼                          "rejected" + reason
  reject reason: "geo_metro_miss" /
  "geo_country_miss" / "geo_blocklist"
```

**One enforcer**, three call-sites. Adapters are not touched — they continue to return `NormalizedJob` with a `locations[]` array. Filter.js maps `locations[0]` to `location` (as today) — but in v2 of this RFC it will read **all** `locations[]` and let a job through if at least one element passes the geo policy (important for multi-location postings like `["Sacramento, CA", "Remote", "Hybrid"]`).

### 4.3 New module `engine/core/geo_enforcer.js`

Pure function (testable, no I/O):

```js
/**
 * @param {string[]} jobLocations  Array of job locations (NormalizedJob.locations[]).
 * @param {object}   profileGeo    Canonical block from profile.geo (after normalizeGeo).
 * @returns {{ ok: boolean, reason: string | null, matchedBy: string | null }}
 *   ok=true  → job passes. matchedBy = "city:Sacramento" / "remote" / "country:US" / "unrestricted".
 *   ok=false → reason ∈ { "geo_metro_miss", "geo_country_miss", "geo_remote_only_miss",
 *                          "geo_blocklist", "geo_no_location" }.
 *
 * Semantics of "geo_no_location": job without locations[] (empty array or all empty
 * strings). In `unrestricted` mode — let through (ok=true). In other modes — reject.
 */
function enforceGeo(jobLocations, profileGeo) { … }
```

### 4.4 Wiring changes

#### `engine/core/profile_loader.js`
- New `normalizeGeo(profileRaw)`: validates `profile.geo` (mode required, cities required for `metro`, countries required for `us-wide`), throws on invalid shape, returns the canonical block. Absence of `profile.geo` ⇒ `{ mode: "unrestricted" }`.
- `loadProfile()` calls `normalizeGeo` and puts the result into `profile.geo` (mutate canonical, as `normalizeFilterRules` / `loadMemory` / `loadSalary` already do).

#### `engine/core/filter.js`
- In `matchBlocklists(job, rules)`, after the existing deny-list checks, add `enforceGeo(job.locations || [job.location], rules.geo)` if `rules.geo.mode !== "unrestricted"`. Reject reason `{kind: "geo_<reason>"}`.
- The signature `filterJobs(jobs, rules, counts)` stays the same — the caller (scan.js) injects `rules.geo = profile.geo` before the call.
- The `filterInputs` map in `scan.js` is updated: instead of `location: locations[0]` we pass `locations: j.locations`. Filter learns to read both fields (`job.locations || [job.location]`) — back-compat for tests and older code paths.

#### `engine/commands/prepare.js` (pre-phase)
- After filter (but before URL check), for each entry `enforceGeo(entry.locations || [entry.location], profile.geo)` is called.
- The result is saved into `entry.geo_decision = enforceGeo(…).ok ? "allowed" : "rejected"` + `entry.geo_reason = enforceGeo(…).reason`.
- If `geo_decision === "rejected"` — the entry goes to `prepare_context.stats.skipReasons[geo_<reason>]++` and does NOT go into `batch[]` (skip via the existing mechanism).
- If `unrestricted` — `geo_decision = "allowed"`, `geo_reason = null` (fields are still set — for audit and SKILL).

#### `engine/commands/validate.js` (retro-sweep)
- `RETRO_SWEEP_STATUSES` — unchanged.
- In the re-screen loop, after `matchBlocklists`, an additional call to `enforceGeo([app.location], profile.geo)` (TSV stores a single location string). Reject → forms `reason = {kind: "geo_<reason>"}`.
- `formatReason` is extended with cases `geo_metro_miss` / `geo_country_miss` / `geo_remote_only_miss` / `geo_no_location`.
- `--apply` behavior is unchanged — archives the row, as it does today.

#### `skills/job-pipeline/SKILL.md` Step 3
The current text ("Geo decision: Claude WebFetches the JD, marks as `us-compatible` / `non-us` / `unknown`, …") is replaced with:

> **Step 3 — Geo decision (now profile-driven)**
>
> Engine pre-phase already populated `prepare_context.batch[i].geo_decision`:
> - `"allowed"` → job passes profile geo policy. **No WebFetch needed.** Continue to Step 4.
> - `"rejected"` → engine already pruned this entry from the batch. (You won't see it.)
>
> Legacy fallback (for old `prepare_context.json` without the `geo_decision` field): WebFetch the JD location and apply a simple US policy. The `geo_decision` field is always populated starting from the engine version post-L-4 — the fallback is left in case of re-consuming old contexts.

#### Discovery adapters (11 of them)
**Not touched.** The universal post-fetch filter in `filter.js` works for all. `discovery.indeed.filters.location_whitelist` remains in Healthcare-Hannah's `profile.json` as **deprecated** (read by the indeed adapter for server-side narrowing — saves API requests on the Indeed side; the final filtering still goes through `filter.js` + `enforceGeo`).

Removing `indeed.filters.*` is a separate cleanup in a follow-up commit (when we confirm that the server-side filter in indeed.js is not needed — it could have produced false negatives).

### 4.5 Migration plan

**Step 1**: add the `profile.geo` block to both profiles.

Lilia (`profiles/lilia/profile.json`):
```jsonc
"geo": {
  "mode": "metro",
  "cities": [
    "Sacramento", "Roseville", "Folsom", "Rocklin", "Citrus Heights",
    "Elk Grove", "Auburn", "Rancho Cordova", "Davis", "West Sacramento",
    "Carmichael", "Fair Oaks"
  ],
  "states": ["CA"],
  "remote_ok": false,
  "blocklist": ["Napa", "Stockton", "Lodi", "Vacaville", "Modesto"]
}
```

PM-Pete (`profiles/jared/profile.json`):
```jsonc
"geo": {
  "mode": "unrestricted",
  "remote_ok": true
}
// or don't add the block at all — engine default = unrestricted, parity 1-to-1.
```

→ For the commit we'll prefer to **explicitly** spell out `unrestricted` for PM-Pete — for self-documentation. Behavior is identical to omitting the block (zero behavior change, verified via tests).

**Step 2**: backfill TSV location.
- TSV schema v3 (G-5) already carries `location`. Backfill for existing rows from the master pool jobs.tsv (by `job_url` key) — partially already done in G-5 (PM-Pete 2186/2897, Healthcare-Hannah 94/425).
- Additional sweep after the geo rollout: rows with empty location are left untouched (enforceGeo on empty location in `metro` mode → `geo_no_location` reject). The user decides whether to archive them via `validate --apply`.

**Step 3**: live retro-sweep dry-run for both profiles. Expected:
- Healthcare-Hannah: ~30-50 rows out of the remaining ~1100 in the pipeline will fall under `geo_*` reject (old out-of-metro rows).
- PM-Pete: 0 rows (unrestricted mode).

**Step 4**: after approving the dry-run output — `validate --apply` for Healthcare-Hannah.

**Step 5**: `discovery.indeed.filters.location_whitelist` — leave in place, don't remove. Cleanup as a separate PR.

### 4.6 Test plan

**Unit**:
- `engine/core/geo_enforcer.test.js` (new) — ~25 tests:
  - 4 modes × ok/reject path × variations (multi-locations, remote_ok, states narrowing, blocklist, US-marker matching, empty locations).
  - Edge cases: location strings like `"Sacramento, CA / Remote"`, `"Hybrid - Sacramento"`, `"United States"` without cities, `"Auburn, AL"` (Alabama Auburn — cut off via `states: ["CA"]`).
- `engine/core/profile_loader.test.js` — extension: `normalizeGeo` defaults / validation errors / canonical shape.
- `engine/core/filter.test.js` — extension: `rules.geo` integration, multi-locations support.
- `engine/commands/prepare.test.js` — extension: `entry.geo_decision` populated, rejected entries don't make it into batch, stats.skipReasons have geo counters.
- `engine/commands/scan.test.js` — extension: `filterInputs` passes `locations[]`, geo-rejected jobs go to `Archived`/`filter_rejections.log` correctly.
- `engine/commands/validate.test.js` — extension: retro-sweep takes geo into account, `formatReason` for geo cases.

**Parity (PM-Pete zero regression)**:
- Smoke: scan → prepare pre-phase → validate. Counts must match the previous run (we'll lock them in `docs/regression_baseline.md`).
- Dry-run validate retro-sweep on the current TSV → 0 archived rows.

**Live smoke (after approve)**:
- Healthcare-Hannah: scan dry-run → number of `geo_*` rejects is logged.
- Healthcare-Hannah: validate retro-sweep dry-run → list of candidates.
- User approve → validate --apply.

### 4.7 Acceptance criteria (DOD)

1. `profile.json.geo` schema is validated in `profile_loader`, errors give a clean message.
2. `geo_enforcer.js` exports `enforceGeo(locations, profileGeo)`. ≥25 tests passing.
3. `filter.js`, `prepare.js`, `validate.js` take the geo enforcer into account.
4. SKILL Step 3 is rewritten to read `prepare_context.batch[i].geo_decision`.
5. Healthcare-Hannah + PM-Pete `profile.json` have a `geo` block (Healthcare-Hannah: metro, PM-Pete: unrestricted).
6. All existing tests passing (843+25 = 868+).
7. PM-Pete smoke parity: scan output identical (counts equal), validate retro-sweep dry-run = 0 archived.
8. Healthcare-Hannah validate retro-sweep dry-run output shown to the user → approve → apply.
9. GAPS_REVIEW tracker: L-4 → Done with commit hash. G-7 closed with the note "absorbed by L-4".
10. The opening of RFC 005 (gmail-cron) is not affected — `005-gmail-cron-autonomous-check.md` is not touched.

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Healthcare-Hannah loses valid roles with `location: "Hybrid"` without an explicit city | enforceGeo matches ALL `locations[]`; if at least one passes — the job is let through. A JD like `["Sacramento, CA", "Hybrid"]` → passes by cities. |
| Multi-location postings like `["San Francisco / Sacramento / Los Angeles"]` are parsed as a single string | normalize.js already splits them. If the adapter returns a single string — filter.js fallback `[job.location]` still gives one shot — substring match will find "Sacramento". |
| PM-Pete parity shifts subtly because of `unrestricted` mode | Regression tests + manual diff of scan output before/after. `unrestricted` mode = enforcer returns `ok: true` without checks (only blocklist, which is empty for PM-Pete). |
| Auburn ambiguity (CA vs AL vs NY) | `states: ["CA"]` narrowing is required in metro mode. If states is empty — match by cities only (then false positives from Auburn AL are possible, but low-frequency and caught by the blocklist on state/country). |
| TSV rows with empty `location` after backfill in metro mode | enforceGeo returns a `geo_no_location` reject. Validate retro-sweep is show-only, --apply moves them to Archived. The user sees the list and decides per row. |
| Indeed adapter duplicates filtering (server-side `radius=25` + post-filter geo_enforcer) | Deliberately: server-side saves API traffic, post-filter is a safety net. Cleanup as a separate PR after stabilization. |

## 6. Rollback

- Merge without the `geo` block in `profile.json` of both profiles: engine default = `unrestricted` → no-op.
- If a post-merge regression is found — revert a single commit, behavior returns to pre-L-4 (filter.js — deny-list only).
- Backfilled TSV `location` fields are additive, nothing is lost.

## 7. Implementation steps (sequential)

After user approve:

1. `engine/core/geo_enforcer.js` + tests.
2. `engine/core/profile_loader.js`: `normalizeGeo` + integration.
3. `engine/core/filter.js`: `matchBlocklists` plugs in the enforcer; multi-locations support.
4. `engine/commands/scan.js`: `filterInputs` passes `locations[]`; smoke on PM-Pete (parity).
5. `engine/commands/prepare.js`: pre-phase populates `entry.geo_decision`.
6. `engine/commands/validate.js`: retro-sweep takes the enforcer into account; `formatReason` updates.
7. `skills/job-pipeline/SKILL.md` Step 3 rewritten.
8. `profiles/lilia/profile.json` + `profiles/jared/profile.json`: add the `geo` block.
9. All tests passing. Live dry-run for Healthcare-Hannah — output shown to the user.
10. GAPS_REVIEW v3: L-4 → Done, G-7 → closed "absorbed by L-4", reference to RFC 013 (not 005).
11. Commit C `feat(geo): profile-level geo enforcement across all adapters (L-4, RFC-013)`. Push after approve.

## 8. Resolved decisions (2026-05-04 approve cycle)

1. ✅ **`states` narrowing for metro mode**: **REQUIRED**. `profile_loader.normalizeGeo` throws ValidationError on `mode === "metro"` without a non-empty `states` array. Protection against ambiguous city names.
2. ✅ **`remote_ok` matching**: by `job.locations[]` (a structural field). Parsing the JD for "hybrid" / "remote-friendly" — out of scope of L-4.
3. ✅ **`max_radius_miles` in schema**: **kept** as a reserved-null field for future geocoding (not a breaking change).
4. ✅ **`indeed.filters.location_whitelist`**: **kept** as deprecated. The Indeed adapter continues to read it for server-side narrowing, post-filter in `filter.js` is a safety net. Cleanup as a separate PR after stabilization.
5. ✅ **TSV rows with empty `location`**: **we don't try to re-geocode**. In metro mode → `geo_no_location` reject. The user moves them to Archived via `validate --apply` (as in Stage 15).
6. ✅ **PM-Pete geo block**: **explicit** `{"mode": "unrestricted", "remote_ok": true}` for self-documentation (not an empty block). Behavior is identical to omitting the block.
7. ✅ **Multi-location matching (job.locations[])**: a job passes if **at least one** location satisfies the policy (important for multi-city postings like `["Sacramento, CA", "Hybrid"]`).

## 9. References

- Incident 2026-05-02 — root cause report (485 Fresenius).
- [Gap review 2026-05 — L-4](../docs/audits/2026-05-gap-review.md) — high-level description of the gap.
- [RFC 010 — Healthcare-Hannah Workday activation](./010-lilia-workday-activation.md) — per-target `locationAllow` will be deprecated in favor of `profile.geo`.
- [RFC 012 — Relational data model](./012-relational-data-model.md) — orthogonal, does not block L-4.
- [DEVELOPMENT.md](../DEVELOPMENT.md) — Tier L requires RFC + approve before code.

## 10. Future work (out of scope of L-4)

- **Geocoding cities**: integrate Nominatim / Google Geocode to compute real distances. `max_radius_miles` starts working.
- **Server-side adapter optimization**: Workday `appliedFacets.locationCountry`, Greenhouse `?office=`, Lever `?location=`, Ashby `?locationName=`, SmartRecruiters `?location=`. Will reduce inbound traffic by 30-70%.
- **Parsing JD for inferred geo**: "hybrid 2 days/week in NYC" → state machine extracts the city. Hard and unstable — not done without strong ROI.
- **Per-target overrides**: companies.tsv `geo_override` column (for example, Healthcare-Hannah allows a single remote-friendly company outside the metro). When needed.
