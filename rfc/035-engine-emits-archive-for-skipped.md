---
id: RFC-035
title: Engine emits archive decisions for skipped[] rows itself
status: proposed
author: Claude (via Jared)
tier: M
created: 2026-05-18
refs:
  - RFC-014
  - RFC-022
  - RFC-024
  - RFC-034
  - BL-80
  - BL-91
---

# RFC 035 — Engine emits archive decisions for `skipped[]` rows itself

## 1. Problem

Today `prepare --phase pre` (`engine/commands/prepare.js`) computes a
flat `skipped[]` array on `prepare_context.json` with reasons like
`title_blocklist`, `title_requirelist`, `company_blocklist`,
`company_cap`, `geo_*`, `url_dead` and the already-evaluated variants
(`already_evaluated_weak`, `already_evaluated_duplicate`). These rows
are surfaced to the SKILL as informational — and the **SKILL Step 10**
then emits `decision: "archive"` for them in `results.json`. The engine
commit phase reads those archive entries and writes `Archived` to TSV.

After RFC-034 the SKILL output contract loses `decision` entirely.
Every entry the SKILL emits becomes "evaluated → push to Notion as
To Apply". That fixes the Weak-phantom bug but leaves an open hole:
**filter-skipped rows have no path to `Archived` anymore.**

### Concrete failure mode (post-RFC-034)

1. Pre-phase: row `gh:123` has `title_blocklist` hit on "Director" →
   lands in `prepare_context.skipped[]`, never reaches the batch.
2. SKILL: sees `skipped[]` in context but doesn't write anything for
   those keys (RFC-034 schema only has `evaluated[]`).
3. Commit: nothing in `results.evaluated[]` for `gh:123` → TSV row
   stays `Inbox`, no `fit_score`, no `skip_reason`.
4. Next scan/prepare: same row picks up `Inbox`, hits the same blocklist,
   skipped again — forever. No audit trail, no Notion presence, no
   operator-visible signal that the filter is doing something.

This isn't just untidy: a loosened filter rule (e.g. operator removes
"Director" from blocklist) silently allows the row back in, with no
record that it was previously rejected. The blocklist's effect is
invisible until you `grep` `prepare_context.json` of the right run.

### Root cause

Filter rejection is a **policy decision the engine already made**.
Asking the SKILL to translate it into an archive write was
boilerplate — and after RFC-034 even that boilerplate is gone, so
nobody writes the archive. The engine should own the full lifecycle
of a row it rejected: surface it, persist the rejection, never make
the operator chase it.

## 2. Decision

1. **Engine writes `status="Archived"` to TSV for filter-skipped rows**
   during `--phase pre`, in the same pass that computes `skipped[]`.
   Not commit-phase. (See §3 for why.)
2. **`skip_reason` column** (TSV v4) gains a defined set of
   engine-emitted values: the same reasons already appearing in
   `skipped[].reason`. The SKILL still emits the legacy values
   (`weak_fit`, `duplicate`) per RFC-034's one-release back-compat;
   they coexist in the same column.
3. **Notion is not touched.** Filter-skipped rows never had a Notion
   page (they were `Inbox`, RFC-014 — TSV-only). The archive
   happens entirely in TSV. No Notion push, no Notion update.
4. **No `archive` entries in `results.json`.** SKILL Step 10
   archive-mapping prose is deleted (already removed in RFC-034; this
   RFC closes the loop by giving those rows a destination).
5. **Operator-visible signal**: pre-phase prints a one-line summary
   to stderr of how many rows it just archived, broken down by
   reason. The existing `skip reasons — …` stdout line already shows
   the breakdown; we add a separate line clarifying that those rows
   were written to TSV as `Archived`.

## 3. Where the write happens — pre, not commit

Two options were considered:

- **A. Write during `--phase pre`.** As soon as `applyPrepareFilter`
  + `filterAlreadyEvaluated` + URL-check classify a row as skipped,
  flip its TSV status to `Archived` with `skip_reason` set.
- **B. Write during `--phase commit`.** Re-read `prepare_context.skipped[]`
  during commit and archive then.

**Choice: A (pre-phase).**

Reasoning:
- Commit-phase requires `--results-file`; an operator who never runs
  the SKILL (e.g. cancels mid-flight, or never starts the LLM phase)
  would leave skipped rows in `Inbox` indefinitely. Pre-phase write
  guarantees the archive lands.
- The data is already in memory at the end of `runPre` (we have
  `allSkipped` right there before we serialize `prepare_context.json`).
  No re-read needed.
- Pre-phase is already side-effectful: it writes `prepare_context.json`.
  Adding a TSV save next to it is a small extension, not a new
  semantic layer.
- Dry-run (`--dry-run` on `prepare --phase pre`) suppresses the TSV
  write just like it suppresses the context write — symmetric.

The pre-phase TSV save **only mutates skipped rows** (status →
`Archived`, `skip_reason` → reason, `updatedAt` → now). Passing rows
in `batchOut` are untouched until commit phase (existing RFC-022
atomic-create contract).

## 4. Engine flow (changes only)

`engine/commands/prepare.js` `runPre` + `runPreTopup`:

1. As today: load apps, run `filterAlreadyEvaluated` →
   `applyPrepareFilter` → URL-check, accumulate `allSkipped`.
2. **NEW**: build a `skippedByKey` map from `allSkipped`. For each
   skipped key, find the matching TSV row, set:
   - `status = "Archived"`
   - `skip_reason = <reason>` (normalized — see §5)
   - `updatedAt = now`
3. **NEW**: `deps.saveApplications(applicationsPath, allApps)` unless
   `flags.dryRun`. Log: `archived <N> filter-skipped row(s) to TSV
   (<reason1>: N1, <reason2>: N2, …)`.
4. Then continue as today: write `prepare_context.json`.

`runPreTopup` already merges new skips with `prevSkipped`. We only
archive the **new** skips from this run (not the carryover) to keep
the write idempotent — rows from a prior topup run were already
archived by that prior run.

`runCommit` is unchanged (no commit-phase archive path). The legacy
`if (r.decision === "archive")` branch is gone after RFC-034, so
there's nothing to delete here that wasn't already deleted.

## 5. TSV implications — canonical `skip_reason` values

After this RFC, `skip_reason` is the union of:

| Source        | Value                          | Set by             |
|---------------|--------------------------------|--------------------|
| Engine filter | `company_blocklist`            | pre-phase (this)   |
| Engine filter | `title_blocklist`              | pre-phase (this)   |
| Engine filter | `title_requirelist`            | pre-phase (this)   |
| Engine filter | `company_cap`                  | pre-phase (this)   |
| Engine filter | `geo_no_location`              | pre-phase (this)   |
| Engine filter | `geo_blocklist`                | pre-phase (this)   |
| Engine filter | `geo_*` (other geo reasons)    | pre-phase (this)   |
| URL check     | `url_dead`                     | pre-phase (this)   |
| SKILL legacy  | `weak_fit`                     | commit (back-compat) |
| SKILL legacy  | `duplicate`                    | commit (back-compat) |

`already_evaluated_weak` and `already_evaluated_duplicate` are **not**
written — those rows already have `fit_score=Weak` or
`skip_reason=duplicate` from a prior run. They're skipped from the
batch but their TSV state is already correct. We log them in
`skipped[]` for the SKILL's information only.

`applications_tsv.js` `VALID_SKIP_REASONS` (currently the gate in
`applyFitFields` at `prepare.js:1242`) is renamed to
`SKILL_LEGACY_SKIP_REASONS` and only used for the SKILL back-compat
path. Engine-side writes bypass that gate (engine is trusted to emit
valid values from a fixed enum).

A new constant `ENGINE_SKIP_REASONS` in `engine/commands/prepare.js`
(or `engine/core/skip_reasons.js` if we want one home) lists the
above engine values. Tests assert the live `skipped[]` reasons are a
subset of this enum, so a future filter that emits a new reason
without updating the enum fails loudly.

## 6. Edge cases

### 6.1 Row was already `Archived` for a different reason

If `app.status === "Archived"` already, the new write should
**preserve the original `skip_reason`** unless it's empty. Rationale:
the first archive event is the meaningful one (e.g. scan-time
`location_blocklist`); a later prepare-time hit on the same row would
overwrite it with a less informative reason (`company_cap`). Behavior:

- `status==="Archived" && skip_reason!==""` → skip (no write).
- `status==="Archived" && skip_reason===""` → backfill the reason
  from this run (closes the gap for pre-RFC rows).

### 6.2 Filter loosened later — should archived rows re-enter?

No, not automatically. `filterAlreadyEvaluated` (line 115) already
filters by `fit_score`/`skip_reason==="weak_fit"|"duplicate"`. We
extend it to also drop `status === "Archived"` rows. Operator who
wants to re-screen archived rows uses `validate --apply` retro_sweep
(which sets `Archived` again if still blocklisted) or a future
`prepare --re-evaluate` (out of scope, RFC-034 §10).

This is a behavior shift: today an `Archived` row with empty
`fit_score` would technically pass `filterAlreadyEvaluated` (no
`weak`/`duplicate` flag) but then get re-archived by
`applyPrepareFilter` (blocklist still applies). The new behavior
short-circuits at `filterAlreadyEvaluated` and saves a re-check.
Document this in the inline comment so a future reader knows
`Archived` is a hard stop.

### 6.3 Row had a Notion page (legacy `To Apply` + no `notion_page_id`)

`isFreshInboxApp` accepts `status==="To Apply" && !notion_page_id` as
"fresh" (RFC-014 back-compat). Such a row reaching the filter and
getting skipped should still archive — same write path. It never had a
Notion page (the guard is exactly `!notion_page_id`), so no Notion
cleanup needed.

### 6.4 `--dry-run` on `--phase pre`

TSV save is suppressed. Stderr line becomes
`(dry-run) would archive <N> filter-skipped row(s) …` for parity with
the existing `(dry-run) would write prepare_context.json` line.

### 6.5 `validate --apply` retro_sweep

Currently the only path that writes `Archived` for blocklist hits on
in-flight rows (`validate.js:519`). After this RFC, retro_sweep still
applies — but it operates on `RETRO_SWEEP_STATUSES` (which excludes
`Inbox`), so the new pre-phase archive doesn't overlap.
**No change needed to `validate.js`.** It catches rows the operator
applied to under one rule-set then loosened/tightened the rules; the
new pre-phase archive catches `Inbox` rows the filter rejects today.

## 7. Backwards compatibility

Stale `Inbox` rows from before this RFC that the filter would reject:
on the first prepare run after the change, they all flip to
`Archived` in one batch. Stderr summary will show a one-time spike
(`archived 47 filter-skipped row(s) — title_blocklist: 32,
company_cap: 11, …`). This is desirable: the operator finally sees
what the filter has been silently doing. No data migration script
needed — the next `prepare --phase pre` is the migration.

The `companyTiers` write path and `--mode topup` behavior are
unchanged. `validate --apply` retro_sweep behavior is unchanged.
`check` / `sync` are unaffected (they don't touch `Inbox` rows).

## 8. Tests

`engine/commands/prepare.test.js` additions:

- **pre-phase archives `company_blocklist` rows**: seed TSV with one
  blocklisted `Inbox` row, run `runPre`, assert the row is saved with
  `status="Archived"` + `skip_reason="company_blocklist"` +
  `updatedAt=now`.
- **pre-phase archives `title_blocklist` rows** (same pattern).
- **pre-phase archives `company_cap` rows**.
- **pre-phase archives `geo_*` rows** with a restrictive geo profile.
- **pre-phase archives `url_dead` rows** (faked URL-check failure).
- **pre-phase preserves prior `skip_reason` on Archived rows** —
  6.1 case: row already `Archived` with `skip_reason="location_blocklist"`
  doesn't get overwritten when a new prepare run would emit
  `company_cap`.
- **pre-phase backfills empty `skip_reason` on Archived rows** —
  6.1 case: row `Archived` with empty `skip_reason` gets the new
  reason written.
- **`filterAlreadyEvaluated` drops `status === "Archived"`** rows
  (regression: confirm 6.2).
- **`--dry-run` suppresses the TSV save** but still emits the
  `would archive N row(s)` stderr line.
- **`runPreTopup` archives only new skips**, not carryover.
- **Enum guard**: `skipped[].reason` for every entry in `allSkipped`
  is a member of `ENGINE_SKIP_REASONS ∪ {already_evaluated_weak,
  already_evaluated_duplicate}` (the latter two are not archive-able
  — they're surfaced for the SKILL but don't trigger a TSV write).

## 9. Migration

Single PR. Forward-only — no data migration script. On first run
after merge, the prepare pre-phase archives any backlog of skipped
`Inbox` rows in one pass, with full stderr breakdown. RFC-034 must
land first (or in the same PR) so the SKILL output schema removal is
in place when this engine change starts emitting archives directly.

## 10. Out of scope

- Un-archiving an archived row programmatically. Operator does it
  manually in TSV or via a future `prepare --re-evaluate` follow-up.
- Backfilling Notion with the archive event. Filter-skipped rows
  were never in Notion; there's nothing to backfill.
- Retroactive cleanup of `Inbox` rows from before this RFC that the
  filter would now skip — the first prepare run handles those.
- Adding `Archived` as a status in Notion's pipeline DB. Notion still
  never sees these rows (RFC-014 invariant).
- Unifying `skip_reason` and `fit_score=Weak` semantics. Separate
  axes; this RFC doesn't touch fit.

## 11. Open questions for approve

1. **Pre-phase or commit-phase write?**
   Recommendation: **pre-phase** (§3). Guarantees the archive lands
   even if the operator never runs the SKILL.
2. **Preserve prior `skip_reason` on already-Archived rows?**
   Recommendation: **yes** (§6.1). First archive wins; only backfill
   empty reasons.
3. **Filter `status==="Archived"` out of `filterAlreadyEvaluated`?**
   Recommendation: **yes** (§6.2). Behavior shift but operator-visible
   only as "we don't waste a URL-check on rows we already rejected."
4. **Where does `ENGINE_SKIP_REASONS` live?**
   Recommendation: new file `engine/core/skip_reasons.js`. Imported by
   `prepare.js` and the test suite. Keeps the enum testable and reusable
   if `check`/`validate` ever need it.
5. **One stderr summary line, or per-reason lines?**
   Recommendation: **one line with breakdown** matching the existing
   `skip reasons — title_blocklist: 2, …` format. Operator already
   reads that line.

## 12. Approval checklist

- [ ] User approves pre-phase write location (§3).
- [ ] User approves canonical `skip_reason` enum (§5).
- [ ] User confirms `filterAlreadyEvaluated` should hard-stop on
      `Archived` (§6.2).
- [ ] User decides `skip_reasons.js` home (§11.4).
- [ ] Implementation BL spawned with this RFC linked (BL-91 becomes
      the impl ticket; flip `status: planned → in_progress` after
      RFC-034 lands).
