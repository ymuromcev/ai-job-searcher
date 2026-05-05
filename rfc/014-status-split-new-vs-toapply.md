# RFC 014 — Status split: `New` vs `To Apply`

**Status**: Draft (awaiting approve) — 2026-05-04
**Author**: Claude (with user direction)
**Tier**: L (architecture + data migration across both Notion DBs)
**Closes**: G-1 (variant A — explicit status split)
**Supersedes**: G-1 doc-only variant (B)
**Touches**: 8-status set → 9-status set; both profiles' Jobs DB schemas; engine code paths in `applications_tsv` / `prepare` / `validate` / `scan` / `check`; SKILL job-pipeline.

---

## 1. Problem

Today the status `To Apply` carries two distinct semantic states:

1. **Fresh-after-scan** — discovery just appended a row; URL liveness, fitScore,
   resume archetype, CL — none of those exist yet. Operator should NOT click
   apply on this card.
2. **Prepared** — `prepare` ran, results.json approved, Notion page created,
   resume + CL generated. Card IS ready for the operator to actually submit.

The code distinguishes the two via guard logic (`notion_page_id !== ""` in
`prepare.js`, `appendNew()` defaults to `"To Apply"` in `applications_tsv`,
SKILL Step 9.0 idempotency check). Semantically, the operator looking at a
Notion view sees ONE column "To Apply" and has to mentally split it by
whether the page has a resume attached. Easy mistake → submit a
half-prepared card without proof paragraphs / wrong archetype.

This is G-1 in `docs/GAPS_REVIEW.md` (Medium severity, L cost). User
selected **variant A** (explicit split) over variant B (doc-only) on
2026-05-04.

---

## 2. Proposed model

Add one new status: **`New`**.

Final 9-status set:

| Status | Semantics | Set by |
|--------|-----------|--------|
| **New** | Fresh after scan. No URL-check, no fit, no CL. Awaiting `prepare`. | `applications_tsv.appendNew` (replaces current "To Apply" default) |
| **To Apply** | Prepared and ready to submit. Notion page exists, resume + CL generated, fit scored. Operator clicks "Apply" externally. | `prepare --phase commit` for `decision: "to_apply"` rows |
| **Applied** | Operator submitted application. | `check --apply` upon "application_received" email, OR manual transition in Notion |
| **Interview** | Recruiter scheduled call. | `check --apply` on `INTERVIEW_INVITE`, or manual |
| **Offer** | Offer extended. | Manual |
| **Rejected** | Rejection received. | `check --apply` on `REJECTION`, or manual |
| **Closed** | Position closed without resolution. | Manual |
| **No Response** | Stale, no recruiter contact >N days. | Manual or future automation |
| **Archived** | Operator archived (filter mismatch, location bad, etc.). | `validate --apply` retro-sweep + `prepare --phase commit` for `decision: "archive"` |

Transitions allowed:
- `New → To Apply` — via `prepare --phase commit decision=to_apply`.
- `New → Archived` — via `prepare --phase commit decision=archive` OR `validate --apply` retro-sweep.
- `To Apply → Applied` — operator manual transition in Notion (post-submit) OR `check` with explicit "I applied" signal (future).
- `Applied → Interview / Rejected / No Response` — via `check --apply` or manual.
- (rest unchanged)

Rejected:
- `New → Applied` — never (would skip prep). If operator wants to skip prep, they manually move `New → Archived → Applied` (forces awareness).

---

## 3. Why this over variant B

**Variant B (doc-only)**: keep "To Apply" with implicit `notion_page_id` split. Pros: zero migration, zero code change. Cons: cognitive load for operator stays; no UI cue in Notion; SKILL has to keep guarding.

**Variant A (this RFC)**: explicit Notion-visible state. Pros: Notion view groups "New" rows separately from "To Apply" — operator immediately sees "this card needs prep" vs "this card is ready". CLI summaries can use status names directly. Cons: schema migration in BOTH profiles' Jobs DBs, code touches across 5+ files, SKILL update.

User picked A 2026-05-04. Cost is justified — operator pain is real (mentioned by user during head-to-head).

---

## 4. Migration plan

### 4.1 Notion schema (manual, both profiles)

Status options can't be edited via Notion API (writes silently ignored — see Stage 16 incident). User must add **`New`** option to the `Status` property in both Jobs DBs through Notion UI (single click each):

- Jared: DB `b25f0de9-af3e-427c-ad98-7667207500c5`
- Lilia: DB `0ce9aa01-fcce-4e35-a080-6187b3e07dbf`

Pick a color (suggestion: gray) — distinct from `To Apply` (suggestion: yellow).

### 4.2 Backfill (one-shot script)

`scripts/rfc014_backfill_new_status.js --profile <id> [--apply]`:

1. Load `applications.tsv`. Find rows where `status === "To Apply"` AND `notion_page_id === ""` (fresh-after-scan, never prepared). Plan: rewrite status to `"New"`.
2. Load `applications.tsv`. Find rows where `status === "To Apply"` AND `notion_page_id !== ""` (already prepared). Keep as-is.
3. Pull current Notion pages for both groups, set Status = `"New"` for group 1 (skipped for group 2 since they're already correct).
4. Default `--dry-run`. With `--apply`: writes TSV + patches Notion.
5. Backup TSV → `applications.tsv.pre-rfc014`.

Live counts (estimate, May 2026):
- Jared: ~240 To Apply rows; ~80% already have notion_page_id (group 2). ~50 rows need status flip.
- Lilia: ~45 fresh rows from healthcare scan; most no notion_page_id (group 1). All migrate to `New`.

### 4.3 Code changes

**`engine/core/applications_tsv.js`**:
- `appendNew(..., {defaultStatus = "New", ...})` — default flips from `"To Apply"` → `"New"`. Callers passing explicit `defaultStatus` (e.g. scan with `"Archived"` for filter rejects) unchanged.

**`engine/commands/prepare.js`**:
- Pre-phase: `freshRows` filter switches from `status === "To Apply" && !notion_page_id` → `status === "New"`. Cleaner predicate (single field).
- Commit phase for `decision: "to_apply"` rows: write `status = "To Apply"` (was already that — no change since the row was already "To Apply" before commit). Now it's a real transition (`New → To Apply`). Update commit-phase to set status explicitly.

**`engine/commands/scan.js`**:
- The `appendNewApplications(... {defaultStatus: "To Apply"})` call (line 299) — flip default to omit / explicit `"New"`. Rejected jobs append still uses `"Archived"`.

**`engine/commands/validate.js`**:
- `RETRO_SWEEP_STATUSES` → `Set(["New", "To Apply"])` so retro-sweep covers both unprepared and prepared-but-not-submitted rows. (Currently only "To Apply" — risk of leaving newly-imported `New` rows with bad geo.)
- `ACTIVE_STATUSES` for cap counting — keep as `["Applied", "To Apply", "Interview", "Offer"]`. `New` does NOT count toward cap (not yet committed to apply). This is a behavior change worth calling out in commit message.

**`engine/commands/check.js`**:
- `ACTIVE_STATUSES` — add `"New"`? **No** — check.js looks for email responses to applications already submitted. New rows haven't been applied yet, no email expected. Keep as `["To Apply", "Applied", "Interview", "Offer"]`.

**`engine/core/classifier.js` / matcher / states**:
- No change. `INTERVIEW_INVITE → "Interview"` mapping stays.

**`engine/commands/sync.js`** (pull only):
- `reconcilePull` — accepts `New` as valid status (today: untyped — accepts any). Document.

**`skills/job-pipeline/SKILL.md`**:
- Step 1 / 2 / 9.0 — explicit `New` references. Step 9.0 idempotency: `if status === "To Apply" && notion_page_id` → already prepared, skip 9a–9c. After RFC 014, condition is just `status === "To Apply"` (any "To Apply" row is already prepared by definition).

**Tests**:
- `applications_tsv.test.js` — flip expected default. Add transition test (`New → To Apply` via prepare commit).
- `scan.test.js` — flip `"To Apply"` → `"New"` in fresh-row assertions.
- `validate.test.js` — retro-sweep now covers `"New"` rows. Add cap-counting test (New ≠ active).
- `prepare.test.js` — pre-phase fresh filter, commit-phase status transition.
- New test: `rfc014_backfill_new_status.test.js` — pure planner.

### 4.4 Hub layout

`build_hub_layout.js` (PM flavor + healthcare flavor):
- Workflow text: rename "Inbox / To Apply" callout label to "New" where it refers to the count of fresh rows.
- Callout count predicate: `New + (To Apply with no notion_page_id)` → just `New` (cleaner).
- Status legend table: add `New` row.

### 4.5 Documentation

- `docs/SPEC.md` — CC-1.a section update (status enum).
- `docs/GAPS_REVIEW.md` — close G-1 with link here.
- `BACKLOG.md` — no entry (this IS the close).
- README — no change (high-level).

---

## 5. Rollout

Sequence (must be in this order to avoid data inconsistency):

1. Add `New` Status option in Jared DB → Lilia DB (manual UI, 2 minutes).
2. Land code change as one PR. Tests green.
3. Run backfill `--dry-run` on Jared → verify counts → `--apply`.
4. Same for Lilia.
5. Smoke `scan + prepare` on each profile (~15 min) — confirm new rows land as `New`, prepare flips them.
6. Update SKILL.

Rollback:
- Revert PR.
- Backfill restore: `cp applications.tsv.pre-rfc014 applications.tsv` per profile.
- Notion: pages with status `New` need manual flip back to `To Apply`. Or run a reverse one-shot patcher (small script, easy).

Risk: low. Worst case is operator confusion for a day until intuition catches up — fixable by Notion view legend.

---

## 6. Estimate

- Notion UI step (manual): 5 min.
- Code change + tests: 4–6 hours (5 files + SKILL + 4 test files + 1 backfill script + tests for backfill).
- Live backfill + smoke: 30 min per profile × 2 = 1 hour.
- Total: 0.5–1 day for one focus session.

---

## 7. Open questions

1. Should `validate.RETRO_SWEEP_STATUSES` include `"New"`? — Yes (RFC §4.3). Confirm during review.
2. Auto-archive of stale `New` rows older than X days — out of scope for this RFC. Can be a future GAP.
3. SKILL: when operator manually creates a row in Notion (no scan), should default status be `New` or `To Apply`? — Out of scope; user can pick whatever. Recommend `New` for consistency.

---

## 8. Approve checklist

Operator (you) approves:
- [ ] Status name `New` (alternatives: `Discovered`, `Triaged`, `Inbox`). I prefer `New` — short and orthogonal to other 8.
- [ ] `validate` retro-sweep extends to `New` rows.
- [ ] `New` does NOT count toward `company_cap`.
- [ ] Backfill creates `applications.tsv.pre-rfc014` backup automatically.
- [ ] Notion-side migration (UI add of `New` option) — you do this manually, RFC documents the click sequence.

Once approved → I write the code + backfill in next session.
