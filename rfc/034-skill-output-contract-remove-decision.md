---
id: RFC-034
title: SKILL output contract — remove `decision`, engine pushes all evaluated
status: proposed
author: Claude (via Jared)
tier: M
created: 2026-05-18
refs:
  - RFC-014
  - RFC-022
  - BL-80
  - BL-91
---

# RFC 034 — SKILL output contract: remove `decision`, engine pushes all evaluated

## 1. Problem

The `job-pipeline` SKILL (`skills/job-pipeline/SKILL.md`) currently
emits a `results.json` whose per-job entry carries a `decision` field
(`to_apply` / `skip` / `archive`) plus an optional `skipReason`. The
engine's `prepare --phase commit` (`engine/commands/prepare.js:1573-1614`)
dispatches on `decision`:

- `to_apply` → status `To Apply`, Notion page created.
- `archive` → status `Archived`, no Notion push.
- `skip` → else-branch — row stays where it was (often `Inbox`), no
  Notion push, no status change.

There is **prose** in SKILL.md telling the model "push all evaluated
rows to Notion" (the weak-fallback loop, RFC-022 commit-phase rule).
There is also an **example output** (SKILL.md:431-437) showing a
`Weak` row with `decision: "skip"`. The two contradict each other.

### Concrete failure mode

When the model follows the example rather than the prose:
1. Row gets `fitScore: "Weak"` + `decision: "skip"`.
2. Engine dispatch hits the else-branch — no Notion push, no status
   change.
3. Row stays `Inbox` forever. Operator triages nothing in Notion
   because there's nothing there.
4. `filterAlreadyEvaluated` in the **next** prepare run drops this
   row because `fit_score=Weak` (line 113) — so the row also never
   re-evaluates.

The row is now in a phantom state: TSV says "evaluated, Weak", Notion
says "never seen", operator never gets to decide.

### Root cause

`decision` is a **policy** field — "should this row go to Notion?"
That's a question for the filter/engine code, not the LLM. The LLM's
job is **advisory**: judge fit, surface flags, write rationale. The
engine decides whether to push.

When policy lives in prose, prose drifts. When policy lives in code,
the linter / tests / pre-commit catch drift.

## 2. Decision

1. **SKILL output schema loses `decision` and `skipReason`.** Per-job
   entry becomes:
   ```json
   {
     "appKey": "lever:abc123",
     "fitScore": "Strong" | "Medium" | "Weak",
     "fitRationale": "string, 1-3 sentences, user-facing",
     "flags": ["string", ...],    // optional, advisory
     "clParagraphs": ["..."]      // present when fitScore is not Weak; see §5
   }
   ```
2. **Engine pushes every evaluated row to Notion**, with status
   `To Apply`. Weak rows go too — the operator triages them in Notion
   instead of them disappearing in TSV.
3. **If a row should not reach Notion**, the filter in
   `applyPrepareFilter` archives it BEFORE the SKILL ever sees it
   (this is what `title_blocklist`, `location_blocklist`, `geo`,
   `company_blocklist`, `company_cap` already do — the right layer).
   If something slips through into Notion that shouldn't, **fix the
   filter**, not the prose.
4. **No `decision` / `skipReason` in TSV either.** Engine writes
   `fit_score` / `fit_rationale` / `fit_evaluated_at` per existing
   schema (BL-9). The `skip_reason` column is repurposed for
   **engine-side** reasons only (`weak_fallback_skipped` if we keep
   that mode — see §6; `duplicate` keeps its current meaning).

## 3. New SKILL flow

For each batch entry the model:
1. Reads the entry (no fetch — engine has prepared everything).
2. Judges fit → `fitScore` + `fitRationale` + optional `flags`.
3. If `fitScore !== "Weak"`, generates `clParagraphs` (cover letter).
4. Emits the row in `results.evaluated[]`.

The model never decides "should this go to Notion". Every evaluated
row goes.

## 4. New engine commit dispatch

`engine/commands/prepare.js` `runCommit`:
- Read `results.json`. Take `evaluated[]` (rename from current
  `decisions[]` / `results[]` — TBD during impl).
- For each row:
  1. Set TSV status to `To Apply`. Stamp `fit_score`, `fit_rationale`,
     `fit_evaluated_at`.
  2. If `clParagraphs` present → write MD + PDF (BL-14 layout).
  3. Create Notion page (RFC 022 atomic create).
  4. On Notion failure → revert TSV status to `Inbox` per existing
     RFC 022 contract.

The current `archive` and `skip` dispatch branches are deleted.
Existing `filterAlreadyEvaluated` (Weak-drop logic) is reviewed in §6.

## 5. `clParagraphs` for Weak rows — open question

Today the SKILL generates `clParagraphs` for `Strong` / `Medium`,
skips for `Weak`. After this RFC, Weak rows go to Notion. Two options:

- **A. Don't generate CL for Weak.** Notion `Cover Letter` field is
  empty. If operator triages "actually I want to apply" → manual CL
  generation (later: button / slash-command). Saves ~1k tokens/Weak.
- **B. Always generate CL.** Operator gets a complete card to triage.
  Costs more tokens.

**Recommendation: A.** Operator decides intent first; CL generation is
on-demand. Saves tokens on rows that won't be applied anyway.

## 6. `weak-fallback` mode — keep or remove?

`prepare.js` currently has a `--mode weak-fallback` that re-evaluates
Weak rows from prior runs (BL-9 Step 5). After this RFC, Weak rows
are already in Notion — there's no "buried Weak" to surface.

**Recommendation: remove weak-fallback.** It exists to compensate for
the bug this RFC fixes. Removing it simplifies the autonomous loop
in SKILL (Steps 5-7) and shrinks `prepare.js`. BL-91 (engine emits
archive for skipped[]) becomes simpler too.

The autonomous prepare loop becomes:
1. `--mode fresh` — first 30 evaluated rows
2. `--mode topup` — refill from `deferredQueue` if budget remains
3. (no weak-fallback) — Weak rows are already pushed
4. push results.json once at end

## 7. `filterAlreadyEvaluated` review

`prepare.js:109-125` drops rows where `fit_score === "Weak"`. After
this RFC, do we still want that?

**Yes** — keep. Weak rows are in Notion. Re-evaluating them in
prepare is wasted token budget. If the operator wants to re-evaluate,
that's a separate CLI flag (out of scope here — `prepare --re-evaluate`
follow-up if ever needed).

`skip_reason: duplicate` drop logic unchanged.

## 8. Migration

Single PR. No data migration needed:
- Existing TSV rows already have `fit_score` — those rows behave
  identically under new dispatch (any row with `fit_score=Weak`
  gets filtered out of next prepare by `filterAlreadyEvaluated`, as
  today).
- Existing Notion pages unchanged.
- A row that's currently in the phantom state (TSV `fit_score=Weak`,
  no `notion_page_id`) — we offer a one-shot cleanup script:
  `scripts/backfill_weak_to_notion.js` that creates Notion pages for
  those rows. Out of scope for this RFC; track as follow-up BL.

Breaking change: anyone running a SKILL prepare on a stale checkout
will produce `results.json` with `decision` fields the new engine
ignores. Engine should tolerate (log warning, ignore the field) rather
than reject — keep one release of forward-compat.

## 9. Tests

Required for the impl PR:
- **Engine commit unit test**: `results.evaluated[]` with one Strong,
  one Medium, one Weak — all three reach Notion (mocked) with status
  `To Apply`. No row stays `Inbox`.
- **Engine commit unit test**: Notion failure on Weak row → status
  reverts to `Inbox` (existing RFC 022 behavior).
- **Backwards-compat test**: `results.json` with legacy `decision`
  field — engine logs warning, ignores, proceeds.
- **SKILL.md structural test**: assert SKILL.md does NOT mention the
  word `decision` as an output field (catches accidental regression).
- **SKILL.md structural test**: assert no example shows `decision:` in
  the schema.
- **Filter regression**: existing filter tests pass unchanged.

## 10. Out of scope

- Hard-blockers pre-SKILL archive (BL-89, separate RFC).
- Backfilling phantom-Weak rows from TSV → Notion (follow-up BL).
- Unified `evaluateJob` shape (BL-92, separate RFC).
- Re-evaluating Weak rows on demand (`prepare --re-evaluate`).

## 11. Open questions for approve

1. `clParagraphs` for Weak rows — A (don't generate) or B (always)?
   Recommendation: A.
2. Remove `weak-fallback` mode entirely? Recommendation: yes.
3. `skip_reason` column in TSV — keep for engine-side reasons
   (`duplicate`, etc.) or rename / drop? Recommendation: keep for
   `duplicate`; do not add new SKILL-emitted values.
4. Phantom-Weak backfill — separate BL after this lands, or fold in?
   Recommendation: separate BL.

## 12. Approval checklist

- [ ] User approves output schema (§2).
- [ ] User picks A or B for `clParagraphs` on Weak (§5).
- [ ] User decides on `weak-fallback` removal (§6).
- [ ] Implementation BL spawned with this RFC linked (BL-80 itself
      becomes the impl ticket; flip `status: planned → in_progress`).
