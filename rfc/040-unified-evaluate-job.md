---
id: RFC-040
title: Unified evaluateJob — consolidate filter.js + applyPrepareFilter (+ email_filters)
status: approved
approved: 2026-05-19
author: Claude (via Jared)
tier: L
created: 2026-05-19
refs:
  - BL-92
  - RFC-030
  - RFC-033
  - BL-91
---

# RFC 040 — Unified `evaluateJob` (consolidate filter.js + applyPrepareFilter + email_filters)

## Approval (2026-05-19)

Approved per user, all open-question recommendations accepted:

- **§7.1 `title_blocklist` canonical** — word-boundary across all three
  contexts (substring is prototype behaviour and produces operator-
  confusing false positives like `"rn"` → `"PRN Coordinator"`).
- **§7.2 substring for keyword/skill matching** — note for future RFC;
  no action here.
- **§7.3 URL-liveness ownership** — stays separate from `evaluateJob`
  (I/O-bearing; evaluator stays pure).
- **§7.4 BL-24 multi-loc rule** — confirmed codified in
  `evaluateJob`'s `location_blocklist` branch via `hasUsMarker()`.
- **§7.5 `email_filters.isLocationBlocked` on body** — remove with a
  one-release deprecation shim (`console.error`, no exception).
- **§7.6 Phase 2 timing** — one production release after Phase 1; flip
  to inline in a follow-up BL.

Implementation tracked under BL-92.

## 1. Problem

The same set of profile filter rules (`company_blocklist`,
`title_blocklist`, `title_requirelist`, `company_cap`,
`location_blocklist`, `geo`) is implemented **three** independent ways
across the engine, and the implementations have drifted:

| # | Call-site | File | Function | Style |
| - | --------- | ---- | -------- | ----- |
| 1 | `scan` (and `validate` retro-sweep) | `engine/core/filter.js` | `matchBlocklists` / `checkJob` / `filterJobs` | Pure, full rule-set, word-boundary on title, BL-24-aware multi-loc geo |
| 2 | `prepare --phase pre` | `engine/commands/prepare.js` | `applyPrepareFilter` | Stateful (counts, cached `_geoResult`), pulls in `enforceGeo`, word-boundary title (post-BL-79) |
| 3 | `check` (email pipeline) | `engine/core/email_filters.js` | `isLevelBlocked` / `isLocationBlocked` | **Substring** on title and free-text body — pre-engine prototype port, never aligned with BL-79/BL-24 |

Symptoms:

- Every new rule has to be coded in two places (sometimes three) and
  tested separately. Forgetting one half is the recurring trap: BL-79
  was filed exactly because `applyPrepareFilter` had not picked up
  `filter.js`'s word-boundary semantics for `title_blocklist`.
- BL-24 (US-marker-in-any-locations[] wins) is implemented in
  `filter.js` and `geo_enforcer.js` but `email_filters.js`'s
  `isLocationBlocked` still does naive substring over free text.
- `title_requirelist` is duplicated character-for-character in
  `filter.js` and `prepare.js` (compound `/` split, word-boundary
  regex) — anyone reading the code has to diff both to confirm they
  agree.
- `skip_reason` strings ("title_blocklist", "company_cap", "geo_*") are
  hand-written at each call-site. BL-91 introduced
  `ENGINE_SKIP_REASONS` as an enum, but each filter copy still emits
  the strings by hand — easy to typo, no compile-time link.

### 1.1 Semantic drift table (rule × call-site × today × canonical)

Each row is one rule × one call-site. **Today** is the live behaviour;
**Canonical** is what this RFC pins down. Cells in **bold** are the
behaviours that change under this RFC.

| Rule | `scan` (`filter.js`) | `prepare` (`applyPrepareFilter`) | `email` (`email_filters.js`) | **Canonical (RFC 040)** |
| ---- | -------------------- | -------------------------------- | ---------------------------- | ----------------------- |
| `company_blocklist` | case-insensitive **exact** match on `job.company` | case-insensitive **exact** match on `app.companyName` | (no direct rule — `isATS`/`NON_PIPELINE_SENDERS` handles a different concern) | case-insensitive **exact** match on normalized company name |
| `title_blocklist` | word-boundary (`makeBoundaryRegex`), `/`-split compound titles, "any clean part passes" (BL-79) | word-boundary (`findTitleBlocklistHit`), same `/`-split semantics (BL-79) | **substring** `title.includes(pattern)` — `isLevelBlocked` | word-boundary + `/`-split, "any clean part passes". **`email_filters.isLevelBlocked` switches to canonical** (typos like "rn" no longer match "PRN") |
| `title_requirelist` | word-boundary regex, `/`-split, at least one part must hit at least one pattern (RFC 030/033) | duplicated copy of the same logic | (not applied to email titles today) | word-boundary regex, `/`-split, "at least one part hits at least one pattern" — same as scan |
| `company_cap` | per-company counter via `currentCounts`, optional `overrides[company]`, hard-default `Infinity` if `max_active` null | same logic, but counts are mutated in-place on `passedApp` | **not applied** in email context (correct — caps are scan/prepare concept) | per-company counter; **skipped in `context: "email"`** |
| `location_blocklist` | substring on `locations[]`, suppressed entirely if **any** element has a US marker (BL-24) | currently delegated to `enforceGeo`; `location_blocklist` not re-applied here (geo's `blocklist` is structurally separate) | **substring on free text** (`isLocationBlocked` over subject/body, no US-marker guard) | substring on `locations[]`, BL-24 US-marker-any-element-wins. **`email_filters` switches: applies on email's parsed `locations[]` if present, otherwise no-op (do not run on free body text — that produced false-positives historically)** |
| `geo` | calls `enforceGeo(locations, profile.geo)` after `location_blocklist` | calls `enforceGeo(app.locations, profile.geo)`; caches `_geoResult` on the passing entry | **not applied** today | calls `enforceGeo` for `context ∈ { "scan", "prepare" }`; **skipped in `context: "email"`** (emails arrive with parsed company/title but locations are unreliable — false-positive risk too high) |
| URL liveness | not in `matchBlocklists` — scan does not URL-check | **not in `applyPrepareFilter`** — separate `checkUrls` step downstream | (n/a) | **stays separate from `evaluateJob`** — URL liveness has I/O, evaluator stays pure. See §7 open question |
| `skip_reason` emitted | hand-written strings in `matchBlocklists` return value | hand-written strings in `applyPrepareFilter` `skipped[]` | n/a (returns `bool`) | **always a value from `ENGINE_SKIP_REASONS`** (BL-91), checked at module boundary |

Drift decisions to settle (recommendations folded into the canonical
column above, but called out in §7 Open questions for explicit
approve):

1. **`title_blocklist`: word-boundary canonical.** Substring (current
   email path) catches typos but produces real false positives like
   "rn" hitting "PRN Coordinator" or "do" hitting "orthodontic".
   Operator intent is "do not surface jobs whose title contains this
   role word", which is a word-level concept. Recommend word-boundary
   for all three contexts.
2. **`location_blocklist` in email context: only on parsed
   `locations[]`, not on free body text.** The current
   `isLocationBlocked(body, rules)` produced incidents where a body
   mentioning "our New York office is hiring in Wisconsin" tripped
   either side. Locations in emails should come from a parser, not
   substring sniffing.
3. **`geo` skipped in email context.** Same reason — email-derived
   locations are too unreliable for hard-blocking. Emails are already
   classified by the `classifier` for status updates; geo decisions
   were made at scan/prepare and persisted on the TSV row.

## 2. Decision

Introduce a single pure module `engine/core/evaluate_job.js` exporting
`evaluateJob`. Every existing call-site delegates to it through a thin
shape-adapter. Drift is eliminated in one step; the three legacy
entrypoints become shims that test continues to call so we get free
regression coverage during Phase 1.

`evaluateJob` is pure: no I/O, no `process`, no mutation of inputs.
Counters (`company_cap`) are accumulated via an explicit `appState`
parameter passed in by the caller — same pattern as today's
`activeCounts` / `currentCounts`.

`evaluateJob` only emits `skip_reason` values from
`ENGINE_SKIP_REASONS` (BL-91). The enum guard in `skip_reasons.test.js`
extends to assert no other string can leave the module.

## 3. New unified API

```js
// engine/core/evaluate_job.js

/**
 * @typedef {Object} EvaluateJobInput
 * @property {Object} job
 *   Normalized record. Required: company (string), title (string).
 *   Optional: locations (string[] preferred; single `location` string
 *   accepted as legacy fallback), url (string), source (string),
 *   jd_text (string).
 * @property {Object} profile
 *   Loaded profile (post `profile_loader.loadProfile`). Reads:
 *   profile.filter_rules (flat shape) and profile.geo.
 * @property {Object} [appState]
 *   { companyCounts: { [companyName]: number } } — caller-owned mutable
 *   counter map. evaluateJob does NOT mutate it; caller increments on
 *   `decision === "keep"` (same contract as filterJobs today).
 *   Required for `context: "prepare"` and `context: "scan"`; ignored
 *   in `context: "email"`.
 * @property {"scan"|"prepare"|"email"} context
 */

/**
 * @typedef {Object} EvaluateJobResult
 * @property {"keep"|"skip"} decision
 * @property {string|null} skipReason
 *   One of ENGINE_SKIP_REASONS (BL-91) when decision === "skip".
 *   null when decision === "keep".
 * @property {Object} matched
 *   Diagnostic detail for logs / TSV. Shape varies by skipReason:
 *     - company_blocklist: { rule, company }
 *     - title_blocklist:   { rule, pattern, reason }
 *     - title_requirelist: { rule }
 *     - company_cap:       { rule, cap, current }
 *     - geo_*:             { rule, mode, matchedBy: null }
 *   On `decision === "keep"`: { geoMatchedBy: string|null } so the
 *   caller can re-attach `_geoResult` to the entry (BL-102 cache).
 */

function evaluateJob({ job, profile, appState, context }) { … }

module.exports = { evaluateJob };
```

### 3.1 Context matrix

Which rules run under each context:

| Rule | `scan` | `prepare` | `email` |
| ---- | ------ | --------- | ------- |
| `company_blocklist` | ✅ | ✅ | ✅ |
| `title_blocklist` | ✅ | ✅ | ✅ (on parsed title only; never on body) |
| `title_requirelist` | ✅ | ✅ | ❌ (skipped — emails are about already-known apps, not surfacing) |
| `company_cap` | ✅ | ✅ | ❌ |
| `location_blocklist` | ✅ | ✅ (delegated to `enforceGeo.blocklist` when `profile.geo.blocklist` configured; otherwise standalone) | ❌ (skipped on body; never run on free text) |
| `geo` | ✅ | ✅ | ❌ |

Rationale for the matrix:

- `email` is the recall pass over already-classified mail. The job
  row already passed `scan` and `prepare` filters; re-filtering on
  unreliable email-side fields produces false negatives (existing pain
  point that motivated `email_filters` divergence in the first place).
  We keep `company_blocklist` and `title_blocklist` because they're
  cheap and safe — if the title in the email parses to a blocked
  pattern, classification noise is the most likely cause and we'd
  rather drop than misroute.
- `scan` and `prepare` apply the **full** rule-set so a row pulled
  from the master pool gets the same answer whether it goes through
  the scan path or the prepare retro-sweep.

### 3.2 Shape adapters

Each call-site already has its own job-like shape. To avoid leaking
shape concerns into `evaluate_job.js`, callers go through tiny
adapters that live alongside the call-sites:

- `engine/core/filter.js`: `jobFromAdapterScan(scanJob) → EvaluateJobInput.job`
  (`{ company, title, locations, url, source }`).
- `engine/commands/prepare.js`: `jobFromTsv(app) → EvaluateJobInput.job`
  (`{ company: app.companyName, title: app.title, locations: app.locations, url: app.url, source: app.source }`).
- `engine/core/email_filters.js`: `jobFromEmail(parsed) → EvaluateJobInput.job`
  (`{ company: parsed.company, title: parsed.title, locations: parsed.locations || [] }`).

Adapters are pure one-liners; tests live with the adapter, not the
module.

### 3.3 Decision pipeline (inside `evaluateJob`)

Order is deterministic and matches today's `matchBlocklists` order
exactly, so existing tests keep passing once we wire up the shim:

1. `company_blocklist` (always)
2. `title_requirelist` (skipped in `email`)
3. `title_blocklist`
4. `company_cap` (skipped in `email`; needs `appState.companyCounts`)
5. `location_blocklist` (skipped in `email`)
6. `geo` (`enforceGeo`, skipped in `email`)

First match short-circuits with `decision: "skip"`. If no rule fires,
`decision: "keep"`, `skipReason: null`, `matched.geoMatchedBy =
geoResult.matchedBy || null`.

## 4. Migration

Internal-only. No profile-config changes, no TSV schema changes, no
Notion schema changes.

### Phase 1 — this RFC's PR (single PR, reviewable diff)

1. Land `engine/core/evaluate_job.js` (pure, exports `evaluateJob`).
2. Land `engine/core/evaluate_job.test.js` (see §5).
3. Rewrite `engine/core/filter.js`:
   - `matchBlocklists(job, rules)` becomes a thin shim that calls
     `evaluateJob({ job, profile: { filter_rules: rules, geo: rules.geo },
     context: "scan" })` and translates the result back into the legacy
     `{ kind, ... } | null` shape the existing scan code expects.
   - `checkJob` / `filterJobs` keep their signatures; `checkJob`
     delegates to `evaluateJob` with `appState.companyCounts`.
4. Rewrite `engine/commands/prepare.js`'s `applyPrepareFilter`:
   - Body becomes a loop over `apps`, each iteration calls
     `evaluateJob({ ..., context: "prepare", appState })` and
     translates `decision: "skip"` into the existing `skipped[]` push,
     `decision: "keep"` into the existing `passed[]` push (carrying
     `_geoResult` cache, BL-102).
5. Rewrite `engine/core/email_filters.js`:
   - `isLevelBlocked(title, rules)` becomes
     `evaluateJob({ job: { company: "", title }, profile: { filter_rules: rules }, context: "email" }).matched?.rule === "title_blocklist"`.
   - `isLocationBlocked` is **removed** from the engine path. The two
     callers in `check` (free-body substring) get an explicit
     deprecation: the function stays exported with a one-release
     warning + `console.error` shim, and its callers are converted to
     pull `locations[]` from the parsed email instead. Tracked as
     follow-up BL after this RFC (not in this PR).
6. Every existing test in `filter.test.js`, `prepare.test.js`,
   `email_filters.test.js` continues to pass unchanged.

### Phase 2 — follow-up BL after one release in production

1. Delete the `matchBlocklists` shim; inline `evaluateJob` calls into
   `checkJob`/`filterJobs`.
2. Delete `applyPrepareFilter`'s local code path; replace with the
   direct loop introduced in Phase 1.
3. Delete `isLevelBlocked` / `isLocationBlocked` exports from
   `email_filters.js`. Migrate the remaining callers to call
   `evaluateJob` directly.
4. Module names settle: `filter.js` becomes a re-export of `evaluate_job.js`
   plus the legacy `filterJobs` / `checkJob` wrappers (kept — they're
   convenient for scan's batch shape).

Phase 2 is gated on a clean week of production logs from Phase 1 (no
new skip-reason values, no regressions in `prepare_context.skipped[]`
diff vs the previous release). Filed as a separate BL with this RFC
in `refs:`.

### Rollback

Phase 1 PR is one commit. If a regression shows up in production
`prepare_context.skipped[]` shape or in `check`'s email outcomes, we
revert the commit; behaviour returns exactly to today because the
shim layer preserves the legacy public API.

## 5. Tests

Phase 1 PR ships:

### 5.1 `engine/core/evaluate_job.test.js` — new

30–50 cases. Coverage matrix is one row per `(rule × context × decision)`:

- **`company_blocklist` ×** scan/prepare/email × keep/skip — 6 cases.
- **`title_blocklist` ×** 3 contexts × keep/skip × compound-`/`-split
  edge × word-boundary-vs-substring fixture (e.g. "PRN Coordinator"
  with pattern "rn" → `keep`; "Office Manager" with pattern "manager"
  → `skip`) — ~10 cases.
- **`title_requirelist` ×** scan/prepare (skipped in email) ×
  keep/skip × `/`-split fixture — 6 cases.
- **`company_cap` ×** scan/prepare (skipped in email) ×
  under-cap/at-cap/overrides — 6 cases. Tests verify `appState` is not
  mutated.
- **`location_blocklist` ×** scan/prepare (skipped in email) ×
  US-marker-wins fixture (BL-24: `["Berlin, DE", ", US"]` →
  `keep`; `["Berlin, DE"]` → `skip`) — 6 cases.
- **`geo` ×** scan/prepare × {unrestricted, metro, us-wide, remote-only,
  unknown_mode} × match/miss — ~10 cases. Tests assert the returned
  `skipReason` lands in `ENGINE_SKIP_REASONS`.
- **Enum guard:** for each context, fuzz 200 random `(company, title,
  locations, profile)` tuples and assert every emitted `skipReason ∈
  ENGINE_SKIP_REASONS` ∪ `{null}`. Catches any future addition that
  forgets to extend the enum.

### 5.2 Legacy tests — unchanged, must keep passing

- `engine/core/filter.test.js` — full suite. Shim layer guarantees
  bit-identical output for the test's expected shape (`matchBlocklists`
  returns `{ kind, ... } | null`).
- `engine/commands/prepare.test.js` — full suite. Same guarantee on
  `applyPrepareFilter`'s `{ passed, skipped }` shape.
- `engine/core/email_filters.test.js` — full suite. `isLevelBlocked`
  starts emitting word-boundary results; any test that previously
  relied on substring-false-positive behaviour (e.g. asserting "rn"
  matches "PRN Coordinator") is rewritten to assert the corrected
  semantic. **List of expected test changes is enumerated in the PR
  description, one line per assertion**; no silent rewrites.

### 5.3 Property-based fuzz — new

`engine/core/evaluate_job.fuzz.test.js`. For each rule, generate 100
random `(job, profile)` tuples (lowercase + mixed-case titles,
locations with random US-state suffixes, company names with leading
whitespace, etc.) and assert:

> Same `(job, profile, appState)` produces identical `decision` +
> `skipReason` from all three call-sites' adapters.

This is the load-bearing test of the RFC: **same input → same answer
across scan / prepare / email**. If it fails, the abstraction has
leaked.

## 6. Risks

1. **Behaviour change in `email_filters.isLevelBlocked`** — flips
   from substring to word-boundary. Real risk: typos that the old
   substring path caught ("Marketig" containing "marketin") will no
   longer trigger. Mitigation: list of broken patterns is enumerated
   in the PR description; we re-run the last 30 days of email
   fixtures from `check`'s `.gmail-state/` and compare classify
   outcomes side-by-side before merge.
2. **`isLocationBlocked` removal from email body** — produces fewer
   email skips. Risk: some marketing-style postings sneak through.
   Mitigation: `isLocationBlocked` stays exported for one release with
   a one-line `console.error("DEPRECATED — see RFC 040")` shim;
   removal is Phase 2.
3. **Shim layer hides a real bug** — if `evaluateJob` produces a
   subtly different answer in some edge case, the shim might paper
   over it. Mitigation: the §5.3 fuzz test runs in CI; any single
   diverging input is a hard failure.
4. **`appState.companyCounts` mutation contract is footgunny** —
   caller increments on `keep`, `evaluateJob` reads but doesn't
   write. Risk: future caller forgets to increment. Mitigation: the
   `filterJobs` wrapper in `filter.js` keeps the existing
   "increment-on-pass" loop and is the documented entrypoint for
   batch scans; ad-hoc callers go through it, not the raw
   `evaluateJob`.
5. **Tier L scope creep** — RFC explicitly scopes out URL-liveness,
   weak-fit / SKILL-side decisions, TSV schema. Risk: reviewer asks
   to fold in. Defer to follow-up BLs; this RFC is filter-only.

## 7. Open questions for approve

1. **Word-boundary vs substring canonical for `title_blocklist`.**
   Recommendation: word-boundary (current `scan` and `prepare`).
   Substring was prototype behaviour and produces operator-confusing
   false positives. **Approve?**
2. **Substring still desirable for skill/keyword matching?** Not
   part of this RFC (no `skill_blocklist` rule exists), but the
   audit flagged this as a future consideration. If we ever add one,
   substring is the right default there (catches "kuberntes" → "kube")
   — but it lives in a different rule, not `title_blocklist`. **Note
   for future RFC, no action here.**
3. **Should `evaluateJob` own URL-liveness?** Recommendation: no.
   URL-liveness has I/O (HTTP HEAD/GET), retry semantics, and a
   `fetchFn` dependency. `evaluateJob` stays pure (no I/O) so it can
   be called millions of times in tests / replays / migrations
   without a network. URL check stays in `prepare.js` (and writes
   `url_dead` to TSV with `skip_reason` from the same enum, which is
   how it works today). **Approve the separation?**
4. **BL-24 multi-loc rule** (US in any `locations[]` wins) —
   confirmed codified in `evaluateJob`'s `location_blocklist` branch
   via `hasUsMarker(locations)`. **Confirm.**
5. **`isLocationBlocked` on free email body — remove?**
   Recommendation: yes, with a one-release deprecation shim
   (`console.error`, not exception). Real-world false positives
   already documented. **Approve removal in Phase 2?**
6. **Phase 2 timing.** Recommendation: one production release after
   Phase 1. Approve cadence or pick a different gate (e.g. "after
   first BL filed against Phase 1 shows the abstraction holds").

## 8. Approval checklist

- [ ] User approves the canonical drift table (§1.1).
- [ ] User approves the context matrix (§3.1) — which rules run in
      `email` vs `scan` / `prepare`.
- [ ] User picks word-boundary canonical for `title_blocklist` (§7.1).
- [ ] User confirms URL-liveness stays separate (§7.3).
- [ ] User approves Phase 2 split (shim now → inline after one
      release) (§4).
- [ ] User confirms `email_filters.isLocationBlocked` deprecation
      (§7.5).
- [ ] BL-92 flipped from `in_progress` → linked to this RFC; Phase 1
      impl BL spawned with `refs: RFC-040`.
