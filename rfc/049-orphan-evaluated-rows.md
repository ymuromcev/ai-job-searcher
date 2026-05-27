---
id: RFC-049
title: Orphan evaluated rows reach Notion via `alreadyEvaluated[]` carry-over
status: proposed
author: Claude (via Jared)
tier: M
created: 2026-05-27
refs:
  - RFC-014
  - RFC-022
  - RFC-034
  - BL-80
  - BL-135
---

# RFC 049 — Orphan evaluated rows reach Notion via `alreadyEvaluated[]` carry-over

## 1. Problem

RFC 034 (BL-80, closed 2026-05-18) changed the contract so every evaluated
row — including `Weak` — lands in Notion at `prepare --phase commit`. The
SKILL stopped emitting `decision`, the engine stopped dispatching on it,
and going forward every fresh Inbox row that the SKILL judges becomes a
`To Apply` row with a Notion page.

That fixed the **forward path**. The **retro pool** was never handled.

Concretely: `engine/commands/prepare.js#filterAlreadyEvaluated`
short-circuits rows where `fit_score === "Weak"` (or
`skip_reason === "weak_fit"`) by pushing them into the skipped list with
reason `already_evaluated_weak`. The justification in the comment block is
explicit: "Claude already decided this isn't a fit and the row was pushed
to Notion already (RFC 034)." That assumption is wrong for rows judged
**before** BL-80 landed — those rows have `fit_score=Weak` but
`notion_page_id=""` and `status="Inbox"`. They are stuck forever:

- pre-phase drops them under `already_evaluated_weak` → never re-evaluated,
  never built into the batch, never written into `alreadyEvaluated[]`
- commit-phase only sees `results.evaluated[]` from the SKILL, which never
  saw the orphan → never pushed to Notion
- next scan adds nothing to recover them — they are already in TSV

On 2026-05-27 in `profiles/jared/applications.tsv` this is **86 rows**:
85 from 2026-05-11..2026-05-17 (pre-BL-80 era) and 1 outlier from
2026-05-19 (one-off; out of scope here — see §10).

## 2. Decision

Pre-phase splits Inbox rows into **two** carry-buckets:

1. `batch[]` — fresh rows for the SKILL to judge (unchanged behaviour).
2. `alreadyEvaluated[]` — rows that already carry a `fit_score` verdict
   but have no `notion_page_id`. The SKILL never sees them; the engine
   carries the verdict + rationale straight through to commit.

Commit-phase merges both buckets before processing — for each
`alreadyEvaluated[]` row, the engine synthesizes a results-style entry
(using the persisted `fit_score` + `fit_rationale` + any persisted
`cl_path` / `resume_ver`) and feeds it through the same Notion-push
pipeline as a fresh evaluated row. TSV transitions `Inbox → To Apply`,
and the row gets a Notion page.

The SKILL contract does **not** change. The carry-over is engine-only.

## 3. Contract change — `prepare_context.json`

`prepare_context.json` already has shape:

```json
{
  "version": 1,
  "profileId": "...",
  "generatedAt": "...",
  "mode": "fresh" | "topup",
  "memory": {...},
  "roleTargets": {...},
  "salaryConfig": {...},
  "batchSize": 30,
  "batch": [...],            // for the SKILL
  "skipped": [...],
  "deferredQueue": [...],
  "unknownTierCompanies": [...],
  "stats": {...},
  "inbox_health": {...}
}
```

This RFC adds **one new top-level field**:

```json
"alreadyEvaluated": [
  {
    "key": "lever:abc123",
    "companyName": "Acme",
    "title": "Senior PM",
    "url": "https://...",
    "source": "lever",
    "jobId": "abc123",
    "fitScore": "Weak",
    "fitRationale": "string from TSV fit_rationale",
    "clKey": "",          // may be empty for orphan Weak rows
    "clPath": "",         // may be empty for orphan Weak rows
    "resumeVer": ""       // may be empty
  },
  ...
]
```

The SKILL **does not read this field**. It exists purely so commit-phase
can re-materialize the row without re-touching the TSV between phases.

`stats.alreadyEvaluatedCarryOver` (number) is added alongside
`stats.alreadyEvaluated` for visibility — the existing
`stats.alreadyEvaluated` keeps counting rows actually skipped (archived
and duplicate), so we don't break any consumer that already reads it.

Schema version bump: not needed. The new field is additive and absent in
older context files (commit-phase tolerates missing/empty `alreadyEvaluated`).

## 4. Engine-side aggregator vs SKILL-side merge

Two ways to feed the carry-over into commit:

- **A. Engine aggregator (chosen).** Pre-phase emits
  `alreadyEvaluated[]`. Commit-phase reads it from `prepare_context.json`
  and concatenates with `results.evaluated[]` (synthesizing a result
  shape) before running the existing dispatch loop. SKILL untouched.
- **B. SKILL merges.** SKILL reads `alreadyEvaluated[]` and inlines the
  rows into the `results.evaluated[]` it writes. SKILL needs new prose +
  example + structural test. Higher risk: SKILL changes can drift, and
  this is dispatcher policy living in prose again — exactly the
  anti-pattern RFC 034 §2 corrected.

Choose A. Engine owns the policy; SKILL stays advisory.

Implementation note: the synthesized result entry for a carry-over row
uses the same shape as a SKILL-emitted entry (`{ key, fitScore,
fitRationale, clKey?, clPath?, resumeVer? }`). No `clParagraphs` — we are
re-using artifacts that already exist on disk (or accepting that a Weak
row has no CL per RFC 034 §5 option A).

## 5. Cover-letter handling for carry-over rows

Following RFC 034 §5 option A (Don't generate CL for Weak), and
generalizing to "use whatever the row already has":

- Row's persisted `fit_score === "Weak"` → push without CL. Notion's
  Cover Letter field is empty. Operator generates on-demand if they
  triage to apply.
- Row's persisted `fit_score` in `{"Medium", "Strong"}` and `cl_path`
  empty → an in-engine CL generation path doesn't exist today
  (`clParagraphs` come from the SKILL). For these rows the engine pushes
  with an empty Cover Letter field and emits a one-line stderr warn
  (`warn: carry-over row <key> has fitScore=<X> but cl_path empty — Notion will show empty CL; re-run prepare to regenerate via SKILL`).
  Operator can re-evaluate manually if they care. Expected count on
  jared = 0 (orphan pool is all Weak).
- Row's persisted `fit_score === "Strong"` with empty `tailoredResume`
  data → engine has no way to re-synthesize the tailored DOCX
  (`tailoredResume` was never persisted). Falls back to the legacy
  archetype path via `app.resume_ver` if set, else leaves `resume_ver`
  empty. Same one-line warn as above.

For jared the only relevant edge case is the empty-CL Weak path.

## 6. Engine changes — concrete

### 6.1 `engine/commands/prepare.js` — `filterAlreadyEvaluated`

Today the function returns `{ passed, skipped }` where `skipped[]`
carries `already_evaluated_weak` / `already_evaluated_duplicate` /
`already_evaluated_archived` reasons. Change to also return
`alreadyEvaluated[]` — the rows that **previously** went to skipped under
`already_evaluated_weak` AND have an empty `notion_page_id` are routed
here. Rows with a non-empty `notion_page_id` (post-BL-80 era — already
in Notion) continue going to `skipped[]` under
`already_evaluated_weak`.

```
function filterAlreadyEvaluated(apps) {
  const passed = [];
  const skipped = [];
  const alreadyEvaluated = [];
  for (const app of apps) {
    if (app.status === "Archived") {
      skipped.push({ key: app.key, reason: "already_evaluated_archived", url: app.url });
      continue;
    }
    if (app.fit_score === "Weak" || app.skip_reason === "weak_fit") {
      if (!app.notion_page_id || app.notion_page_id === "") {
        // Orphan — never reached Notion. Route to carry-over bucket.
        alreadyEvaluated.push(app);
      } else {
        // Already in Notion (RFC 034 forward path). Skip as before.
        skipped.push({ key: app.key, reason: "already_evaluated_weak", url: app.url });
      }
      continue;
    }
    if (app.skip_reason === "duplicate") {
      skipped.push({ key: app.key, reason: "already_evaluated_duplicate", url: app.url });
      continue;
    }
    passed.push(app);
  }
  return { passed, skipped, alreadyEvaluated };
}
```

Note: rows with non-Weak `fit_score` (`Strong`/`Medium`) that nevertheless
have empty `notion_page_id` were already passing through
`filterAlreadyEvaluated` to `applyPrepareFilter` (no branch caught them).
Today they get re-batched and re-evaluated by the SKILL on every run.
This RFC does NOT change that path — for completeness, those rows are
also orphan candidates, but they re-evaluate cleanly on next prepare so
they aren't stuck. Expanding carry-over to cover them would short-circuit
the SKILL on legitimately needed re-evaluations (e.g. operator wants a
fresh Strong-fit verdict). Out of scope.

### 6.2 `engine/commands/prepare.js` — `runPre`

Where today we have:

```
const { passed: notYetEvaluated, skipped: alreadyEvaluatedSkips } =
  filterAlreadyEvaluated(inboxApps);
```

Becomes:

```
const {
  passed: notYetEvaluated,
  skipped: alreadyEvaluatedSkips,
  alreadyEvaluated: orphanEvaluatedApps,
} = filterAlreadyEvaluated(inboxApps);
```

Build a serializable shape for the orphan rows (no `_geoResult`, no
internal fields):

```
const alreadyEvaluatedOut = orphanEvaluatedApps.map((app) => ({
  key: app.key,
  companyName: app.companyName,
  title: app.title,
  url: app.url,
  source: app.source,
  jobId: app.jobId,
  fitScore: app.fit_score,
  fitRationale: app.fit_rationale || "",
  clKey: app.cl_key || "",
  clPath: app.cl_path || "",
  resumeVer: app.resume_ver || "",
}));
```

Add to context object:

```
const context = {
  ...,
  batch: batchOut,
  alreadyEvaluated: alreadyEvaluatedOut,
  ...
  stats: {
    ...,
    alreadyEvaluatedCarryOver: alreadyEvaluatedOut.length,
  },
};
```

Mirror the same change in `runPreTopup` (it also calls
`filterAlreadyEvaluated`). Topup APPENDS to `alreadyEvaluated[]` the same
way it appends to `batch[]`. The topup path won't add many new orphan
rows in practice (the deferred queue is a subset of Inbox the fresh run
already saw), but the contract is symmetric.

stdout summary line in pre-phase gets a sibling: `already-evaluated:
carry-over N (orphan Weak from prior runs)`.

### 6.3 `engine/commands/prepare.js` — `runCommit`

After reading `results.json`, also load `prepare_context.json` (it
already does via `loadPrepareContextByKey`, but only for ctx extras).
Extend that load to also return `alreadyEvaluated[]`. Synthesize a
results-style entry for each and prepend (order: carry-over first, then
SKILL evaluated). The synthesized entry has no `clParagraphs`, so the
existing CL pass naturally skips it (it filters on
`Array.isArray(r.clParagraphs) && r.clParagraphs.length > 0`). The
Notion-push pass treats it identically to a SKILL-emitted entry — only
field origin differs.

Synthesized entry shape:

```
{
  key: "...",
  fitScore: app.fit_score,         // "Weak" by construction
  fitRationale: app.fit_rationale,
  clKey: app.cl_key || undefined,
  clPath: app.cl_path || undefined,
  resumeVer: app.resume_ver || undefined,
  // NB: no clParagraphs, no tailoredResume, no decision
}
```

City/state/workFormat for these rows: not available (SKILL extracted them
in pre-phase historically; for carry-over rows we have no JD). The
Notion page is created with what we have — those fields stay empty.
Acceptable trade-off: the page exists, operator can manually edit if
they care to triage. This matches the §5 trade-off: get the row into
Notion, don't block on completeness.

The legacy `decision` warn-once line is unaffected: synthesized entries
never carry `decision`.

`updates` counters get one new field:

```
updates = {
  ...,
  carryOver: 0,        // # orphan rows pushed via alreadyEvaluated[]
};
```

Final stdout summary appends `${updates.carryOver} carry-over` when
non-zero, alongside the existing `${updates.toApply} to-apply`.

## 7. Identity & PII

No new collection. The carry-over rows are already in
`profiles/<id>/applications.tsv` (gitignored). The only new on-disk
write is `prepare_context.json.alreadyEvaluated[]` — same file that
already exists, lives in the same directory, is also gitignored. No new
fields stored on the row itself. PII surface area unchanged.

## 8. Risk

**Highest risk: the first prepare run after this lands will push ~85
new Notion pages in a single commit on jared.** Today's Notion DB has
~N pages; this jumps to ~N+85 in one transaction. The operator needs to
know to expect this — otherwise it looks like a runaway loop.

Mitigations:
- The stdout pre-phase line `already-evaluated: carry-over 85 (orphan
  Weak from prior runs)` makes the count explicit before commit runs.
- Commit-phase final summary calls it out: `notion: 85 created (75
  carry-over from prior Weak verdicts, 10 fresh)`.
- This RFC body itself documents the one-time spike. The operator
  reading the BL closure will know.
- Atomic per-row push (RFC 022) is unchanged — a partial failure
  reverts only the failing row.

**Secondary risk: results-shape compatibility.** Synthesized entries do
not carry `clParagraphs`, `tailoredResume`, etc. The existing dispatch
code already gates on these (e.g. `clResults` filter on
`Array.isArray(r.clParagraphs) && length > 0`; tailor classification
on presence of `tailoredResume`). Verified by code-walk that no
unguarded access exists on these fields. Tests in §9 cover the path.

**Tertiary risk: `runPreTopup` symmetry.** Topup reads `prev.batch` and
`prev.deferredQueue` but does NOT read `prev.alreadyEvaluated`. Topup
appends only to `batch[]` today. After this RFC, topup also re-runs
`filterAlreadyEvaluated` on `liveQueueApps` and APPENDS to
`prev.alreadyEvaluated`. Failure mode if forgotten: topup overwrites
`alreadyEvaluated[]` with `[]` and erases the fresh-run carry-over. The
implementation explicitly carries `prev.alreadyEvaluated` forward.

## 9. Plan of testing

### 9.1 Unit tests (Node built-in `node --test`)

In `engine/commands/prepare.test.js` alongside existing
`filterAlreadyEvaluated` tests:

- `filterAlreadyEvaluated: routes Weak+empty notion_page_id to alreadyEvaluated[], leaves Weak+notion_page_id in skipped`
- `filterAlreadyEvaluated: archived rows still go to skipped (unchanged)`
- `filterAlreadyEvaluated: duplicate skip_reason still goes to skipped (unchanged)`
- `prepare --phase pre: alreadyEvaluated[] surfaces in prepare_context.json`
- `prepare --phase pre topup: appends to prev.alreadyEvaluated[]`
- `prepare --phase commit: synthesizes results from alreadyEvaluated[] and pushes to Notion`
- `prepare --phase commit: carry-over row with empty cl_path pushes without CL (Weak)`
- `prepare --phase commit: carry-over Notion failure reverts row to Inbox`

### 9.2 Smoke test on `jared`

```
node engine/cli.js prepare --profile jared --phase pre --batch 20
```

Confirm `profiles/jared/prepare_context.json.alreadyEvaluated` has ~85
entries. Do NOT run `--phase commit` from this RFC's implementation
session — that is the user's decision in a real session.

### 9.3 Full suite

`node --test` (npm test) must remain fully green. Baseline at start of
BL-114 was 1639/1639; recent BL-130/131/133 added more.

## 10. Out of scope

- The 1 outlier from 2026-05-19 (post-BL-80). It either has the same
  pattern as the pre-BL-80 batch (in which case it gets cleaned up by
  the carry-over path anyway) or there's a residual regression that
  needs investigation. Either way, separate BL.
- `Strong`/`Medium` orphan rows. None observed in jared. The existing
  re-evaluation behaviour (those rows aren't blocked by
  `filterAlreadyEvaluated`) is acceptable: they re-enter the SKILL on
  next prepare and produce fresh verdicts.
- Backfilling `clParagraphs` / regenerating CL for legacy Weak rows.
  RFC 034 §5 option A defers CL generation to on-demand for Weak.
- Re-evaluation of carry-over rows. They go to Notion with whatever
  verdict is on disk. If operator wants a fresh look, they re-prepare
  manually after the carry-over clears.

## 11. Migration

Single PR. No data migration:
- Pre-existing `prepare_context.json` files without `alreadyEvaluated[]`
  → commit-phase reads `parsed.alreadyEvaluated ?? []` (absent field
  defaults to empty array).
- Pre-existing TSV rows unchanged.
- The first prepare run on jared after the change will sweep the 85
  orphan rows. After that, the carry-over bucket stays at 0 unless a
  future regression re-introduces the orphan condition (defense-in-depth
  via the unit tests).

## 12. Approval checklist

- [ ] User approves contract change (§3): new `alreadyEvaluated[]` field
      on `prepare_context.json`, additive, no schema-version bump.
- [ ] User aware of one-time Notion spike on jared (~85 pages) on first
      prepare run after merge.
- [ ] User picks A vs B for CL handling on carry-over rows. RFC §5
      recommends A (no regeneration; Weak rows arrive without CL).
- [ ] Engine-side aggregator vs SKILL-side merge — RFC §4 picks
      engine-side. Confirm before code.
