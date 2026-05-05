# RFC 014 — Status split: `Inbox` vs `To Apply` (TSV-only)

**Status**: Approved 2026-05-04 (revised: TSV-only, status name `Inbox`)
**Author**: Claude (with user direction)
**Tier**: M (TSV migration + engine code paths; no Notion schema change)
**Closes**: G-1
**Supersedes**: G-1 doc-only variant (B), and the original RFC 014 draft (Notion-visible variant A; status name `New`)
**Touches**: TSV-level status enum (`Inbox` added local-only — Notion DBs unchanged); engine code paths in `applications_tsv` / `prepare` / `validate` / `scan` / `sync` / `check`; SKILL job-pipeline.

> **Revision 2026-05-04**: User clarified during implementation that the new
> state is **TSV-only** — Notion DBs keep their existing 8-status set
> (`To Apply / Applied / Interview / Offer / Rejected / Closed / No Response /
> Archived`). User also picked the name `Inbox` (over `New`) because the hub
> callout already labels the staging queue "Inbox" and the term is in active
> use. `Inbox` rows by definition have `notion_page_id == ""` and never reach
> Notion. This eliminates the Notion UI step, the page-patch leg of backfill,
> and any risk of pushing a Notion-unsupported status.

---

## 1. Problem

Today the status `To Apply` in `applications.tsv` carries two distinct
semantic states:

1. **Fresh-after-scan** — discovery just appended a row; URL liveness, fitScore,
   resume archetype, CL — none of those exist yet. Operator should NOT click
   apply on this card.
2. **Prepared** — `prepare` ran, results.json approved, Notion page created,
   resume + CL generated. Card IS ready for the operator to actually submit.

The code distinguishes the two via guard logic (`notion_page_id !== ""` in
`prepare.js`, `appendNew()` defaults to `"To Apply"` in `applications_tsv`,
SKILL Step 9.0 idempotency check, hub callout in `sync.js`). Every consumer
has to remember the implicit split. The CLI summaries say `"To Apply"` for
both states. Easy mistake → operator clicks "submit" on a half-prepared row.

This is G-1 in `docs/GAPS_REVIEW.md` (Medium severity, M cost after the
TSV-only revision).

---

## 2. Proposed model

Add one new TSV-level status: **`Inbox`**.

TSV-level 9-status set (Notion DBs keep their 8-status set; `Inbox` is
local-only):

| Status | Semantics | Set by |
|--------|-----------|--------|
| **Inbox** | Fresh after scan. No URL-check, no fit, no CL, no Notion page. Awaiting `prepare`. **TSV-only.** | `applications_tsv.appendNew` (default — replaces previous `To Apply`) |
| **To Apply** | Prepared and ready to submit. Notion page exists, resume + CL generated, fit scored. Operator clicks "Apply" externally. | `prepare --phase commit` for `decision: "to_apply"` rows |
| **Applied** | Operator submitted application. | `check --apply` upon "application_received" email, OR manual transition in Notion (then synced via pull) |
| **Interview** | Recruiter scheduled call. | `check --apply` on `INTERVIEW_INVITE`, or manual |
| **Offer** | Offer extended. | Manual |
| **Rejected** | Rejection received. | `check --apply` on `REJECTION`, or manual |
| **Closed** | Position closed without resolution. | Manual |
| **No Response** | Stale, no recruiter contact >N days. | Manual or future automation |
| **Archived** | Operator archived (filter mismatch, location bad, etc.). | `validate --apply` retro-sweep + `prepare --phase commit` for `decision: "archive"` |

Transitions allowed:
- `Inbox → To Apply` — via `prepare --phase commit decision=to_apply`. Same step also creates the Notion page (status="To Apply" in Notion).
- `Inbox → Archived` — via `prepare --phase commit decision=archive` OR `validate --apply` retro-sweep.
- `To Apply → Applied` — operator manual transition in Notion (post-submit), pulled to TSV via `sync`.
- `Applied → Interview / Rejected / No Response` — via `check --apply` or manual.
- (rest unchanged)

Disallowed:
- `Inbox → Applied` — never (would skip prep). If operator wants to skip prep, they manually move `Inbox → Archived → Applied` (forces awareness).

Why `Inbox` over `New`:
- The hub callout in Notion already says "Inbox: N | Updated: …" — naming the TSV status the same eliminates a vocabulary mismatch.
- Operators talk about "what's in my Inbox" colloquially; matching that idiom saves cognitive load.

---

## 3. Why this over the doc-only variant

**Variant B (doc-only)**: keep `To Apply` with implicit `notion_page_id` split. Pros: zero migration. Cons: every consumer (`prepare`, `sync` callout, SKILL Step 9.0, retro-sweep) has to remember the implicit guard; CLI says `"To Apply"` for both states.

**This RFC (TSV-only `Inbox`)**: explicit pre-Notion state in TSV. Pros: single-field predicates everywhere (`status === "Inbox"`); CLI summaries and logs use the precise name; no Notion change needed. Cons: small TSV migration + 5 file touches.

Cost is justified — the implicit split has burned operators several times during 2026-04 stages (Stage 16 push, Stage 7 head-to-head).

---

## 4. Migration plan

### 4.1 Notion schema

**No change.** `Inbox` is TSV-only. Notion DBs keep their existing 8 status
options. There is no UI step.

### 4.2 Backfill (one-shot script)

`scripts/rfc014_backfill_inbox_status.js --profile <id> [--apply]`:

1. Load `applications.tsv`. Find rows where `status === "To Apply"` AND `notion_page_id === ""` (fresh-after-scan, never prepared). Plan: rewrite status to `"Inbox"`.
2. Load `applications.tsv`. Find rows where `status === "To Apply"` AND `notion_page_id !== ""` (already prepared). Keep as-is.
3. Default `--dry-run`. With `--apply`: writes TSV.
4. Backup TSV → `applications.tsv.pre-rfc014` before any write.
5. **Notion is not touched.** This is the key simplification vs the original draft.

Live counts (estimate, May 2026):
- Jared: ~240 `To Apply` rows; most already prepared (have `notion_page_id`). Expected migrate-to-Inbox count: tens.
- Lilia: ~99 prototype-imported rows; most are pre-Notion seed data without `notion_page_id`. Most migrate to `Inbox`.

### 4.3 Code changes

**`engine/core/applications_tsv.js`**:
- `appendNew(..., {defaultStatus = "Inbox", ...})` — default flips from `"To Apply"` → `"Inbox"`. Callers passing explicit `defaultStatus` (e.g. scan with `"Archived"` for filter rejects) unchanged.

**`engine/commands/scan.js`**:
- Passed-jobs append: `defaultStatus: "Inbox"` (was `"To Apply"`). Rejected jobs append still uses `"Archived"`. Log strings: `"X Inbox + Y Archived rows"`.

**`engine/commands/prepare.js`**:
- Pre-phase: `inboxApps` filter switches from `status === "To Apply" && !notion_page_id` to `status === "Inbox" || (status === "To Apply" && !notion_page_id)`. Dual filter for back-compat with un-migrated rows.
- Commit phase for `decision: "to_apply"` rows: writes `status = "To Apply"` (this becomes a real transition: Inbox → To Apply). Already does this; semantics now strictly correct.
- `CAP_ACTIVE_STATUSES`: keep as `["To Apply", "Applied", "Interview", "Offer"]`. `Inbox` does NOT count toward cap.

**`engine/commands/validate.js`**:
- `RETRO_SWEEP_STATUSES` → `Set(["Inbox", "To Apply"])` so retro-sweep covers both unprepared and prepared-but-not-submitted rows.
- `ACTIVE_STATUSES` for URL liveness — keep as `["To Apply", "Applied", "Interview", "Offer"]`. `Inbox` is NOT URL-checked here (prepare's pre phase will do it as part of normal flow).

**`engine/commands/sync.js`**:
- Hub callout count: `status === "Inbox" || (status === "To Apply" && !notion_page_id)` (dual for back-compat).
- Pull is naturally safe — `Inbox` rows don't have a `notion_page_id`, so `reconcilePull` won't match a Notion page to them. No guard needed.

**`engine/commands/check.js`**:
- `ACTIVE_STATUSES` for Gmail batches — keep as `["To Apply", "Applied", "Interview", "Offer"]`. `Inbox` excluded (no Notion page → no email thread can match).
- LinkedIn-job-alert and recruiter-outreach paths that auto-create TSV rows: switch hardcoded `status: "To Apply"` to `status: "Inbox"`. These rows enter the same lifecycle as scan-discovered rows.

**`engine/core/classifier.js` / matcher / states**:
- No change.

**`skills/job-pipeline/SKILL.md`**:
- Step 1 / 2 / 9.0: rewrite "fresh = To Apply + no notion_page_id" wording → "fresh = Inbox" (with a back-compat note for un-migrated rows).
- Status legend: add `Inbox` row (TSV-only, never appears in Notion).
- `check` LinkedIn-alert / recruiter-outreach branches: update status references to `Inbox`.

**`engine/modules/build_hub_layout.js`**:
- Status legend table (PM flavor + healthcare flavor): add `Inbox` row, note "TSV-only — fresh-after-scan, awaits prepare".
- Workflow text: where it says "fresh rows in To Apply", update to "fresh rows in Inbox".
- Callout label and predicate stay the same (the callout was already named "Inbox").

**Tests**:
- `applications_tsv.test.js` — flip expected default from `"To Apply"` to `"Inbox"`. Add transition test (scan writes Inbox; prepare commit transitions to To Apply).
- `scan.test.js` — flip `"To Apply"` → `"Inbox"` in fresh-row assertions and stdout-string assertions.
- `validate.test.js` — retro-sweep now covers `"Inbox"` rows. Add cap-counting test (Inbox ≠ active).
- `prepare.test.js` — pre-phase fresh filter accepts both `Inbox` (canonical) and back-compat `To Apply + no notion_page_id`.
- `sync.test.js` — callout predicate test.
- `check.test.js` — LinkedIn / recruiter row creation now writes `Inbox`.
- New test: `rfc014_backfill_inbox_status.test.js` — pure planner.

### 4.4 Documentation

- `docs/SPEC.md` — CC-1.a section update (status enum + TSV vs Notion split).
- `docs/GAPS_REVIEW.md` — close G-1 with link here, mark "Closed via RFC 014 (TSV-only revision) 2026-05-04".
- `BACKLOG.md` — no entry (this IS the close).
- `README.md` — no change.

---

## 5. Rollout

Sequence (no Notion-side ordering constraint anymore):

1. Land code change as one PR. Tests green (target: 909+ passing — RFC adds ~10 new tests, modifies ~20 existing).
2. Run backfill `--dry-run` on Jared → verify counts → `--apply`.
3. Same for Lilia.
4. Smoke `scan + prepare` on each profile (~5 min) — confirm new rows land as `Inbox`, `prepare --phase commit` flips them to `To Apply`.

Rollback:
- Revert PR.
- Backfill restore: `cp applications.tsv.pre-rfc014 applications.tsv` per profile.
- No Notion cleanup needed (Notion was never touched).

Risk: low. The dual filter in prepare/sync provides graceful degradation if backfill is forgotten or partial.

---

## 6. Estimate

- Code change + tests: 3–4 hours (5 engine files + SKILL + hub layout + 6 test files modified + 1 backfill script + tests for backfill).
- Live backfill + smoke: 15 min per profile × 2 = 30 min.
- Total: ~0.5 day for one focus session.

(Original L-tier estimate of 0.5–1 day stands at the lower end — TSV-only
revision saved the Notion UI step and the Notion patcher.)

---

## 7. Open questions

1. ~~Should `validate.RETRO_SWEEP_STATUSES` include the new state?~~ Yes (RFC §4.3). Confirmed during review.
2. Auto-archive of stale `Inbox` rows older than X days — out of scope for this RFC. Can be a future GAP.
3. SKILL: when operator manually creates a row in Notion (no scan), should default status be `Inbox` or `To Apply`? — Out of scope; recommend operator keep it `To Apply` since manual-create implies they already triaged.

---

## 8. Approve checklist

Operator (you) approved:
- [x] Status name `Inbox` (alternatives considered: `New`, `Discovered`, `Triaged`).
- [x] TSV-only — Notion DBs not touched.
- [x] `validate` retro-sweep extends to `Inbox` rows.
- [x] `Inbox` does NOT count toward `company_cap`.
- [x] Backfill creates `applications.tsv.pre-rfc014` backup automatically.
- [x] No Notion-side migration needed.

Implementation in progress 2026-05-04.
