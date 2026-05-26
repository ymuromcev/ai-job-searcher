---
id: RFC-047
title: retro-tailor — re-tailor pre-RFC-044 Strong rows still in To Apply
status: draft
author: Claude (via Jared)
tier: M
created: 2026-05-26
refs:
  - RFC-022
  - RFC-044
  - BL-123
  - BL-133
---

# RFC 047 — `retro-tailor` command

## 1. Problem

RFC 044 (Strong-fit autonomous tailoring loop) shipped on 2026-05-24.
Strong-fit rows that landed in Notion **before** that date carry an
`archetype-pick` resume (e.g. `resume_ver = "pm-builder"`) rather than
a tailored DOCX/PDF generated from the row-specific JD. Once a row sits
in Notion as `To Apply`, the regular `prepare --phase commit` no
longer touches it — commit only runs against fresh `Inbox` rows.

Operator needs a single command that:

1. Lists every Strong row currently in `To Apply` whose `resume_ver`
   is not a tailored-resume file path.
2. Routes each one through the same Strong-tailoring loop the regular
   prepare pipeline uses (RFC 044 §"Loop semantics").
3. Writes the tailored DOCX/PDF on disk and updates the existing
   Notion page's `Resume Version` field to point at the new PDF.
4. Leaves the cover letter alone — operator has already shipped the
   existing CL to themselves; regenerating it is a separate concern
   (G-17 reuse policy is more complex; see BL-133 §Out of scope).

The command is a one-time-per-row sweep; once a row has a tailored
file, future `retro-tailor` runs skip it.

## 2. Non-goals

- **Re-tailor Medium / Weak rows.** Out of scope per BL-133.
- **Re-generate cover letters.** Out of scope.
- **Auto-retry on escalation.** If the SKILL loop escalates below the
  85% threshold, the row gets an escalation entry in the same MD
  format `prepare commit` emits — operator triages it manually.
- **Pull from Notion to discover candidates.** TSV is the canonical
  per-profile ledger (CLAUDE.md §"TSV is the ledger"). Prerequisite
  step is `node engine/cli.js sync --profile <id> --apply` so Notion
  status changes are reflected before retro-tailor reads the TSV.
- **Engine-side LLM orchestration.** Engine stays PII-free + LLM-free
  (RFC 044 §"fork #1 revised"). All tailoring happens in the SKILL
  session via the existing `resume-tailor-mirror` subagent.

## 3. Command surface

```
node engine/cli.js retro-tailor --profile <id> [--dry-run]
                                                [--apply --results-file <path>]
                                                [--since YYYY-MM-DD]
                                                [--batch <N>]
```

| Flag | Phase | Effect |
|---|---|---|
| `--dry-run` (default) | recon | Scan TSV, identify candidates, print summary. **Also writes** `profiles/<id>/retro_tailor_context.json` with per-row JD payloads the SKILL consumes — same shape as `prepare_context.json.batch[]`. No mutations to TSV / Notion / artifacts. (Use `--dry-run` to force; the default behaviour without `--apply` is recon.) |
| `--apply --results-file <path>` | commit | Read SKILL-produced `results.json`, generate tailored DOCX/PDF for each `tailoredResume`, update Notion `Resume Version` field on the existing page, update TSV `resume_ver`. |
| `--since YYYY-MM-DD` | recon | Limit candidates to rows whose `updatedAt` (or `createdAt` fallback) is on/after the given date. Defensive against stale rows where the operator lost interest. |
| `--batch <N>` | recon | Cap the candidate list at N rows per run (token-budget control). Default: 30 (matches `prepare`). |

**No `--phase` flag**: only two states (recon vs commit), gated by
the presence of `--apply` + `--results-file`. Keeps the surface small.

**Why mirror `prepare`'s two-phase pattern instead of a single
"orchestrate everything" command?** Per RFC 044, the engine cannot
call LLMs (S1 PII-free contract). The SKILL session owns LLM
orchestration. Forcing retro-tailor into a single command would
require either (a) the engine spawning a SKILL subprocess — which
breaks the contract — or (b) hard-coding the operator confirmation
loop in the SKILL with no way for the engine to verify it ran. The
two-phase split is the same separation `prepare` already establishes
and tests well.

## 4. Phase 1 — recon

### 4.1 Candidate identification

A row is a retro-tailor candidate iff **all** hold:

1. `status === "To Apply"` (canonical: TSV is source of truth after
   the prerequisite `sync --apply`).
2. `fit_score === "Strong"`.
3. `resume_ver` does NOT start with `resumes/tailored/`. Empty
   `resume_ver` also qualifies (defensive — some pre-RFC-044 rows
   may have empty `resume_ver`).
4. (If `--since` given) `updatedAt >= --since` (or `createdAt` when
   `updatedAt` is empty).

**Detection signal rationale**: The tailored DOCX/PDF path
convention is fixed by `engine/modules/tailor/dispatcher.js`
`tailoredResumePath` / `tailoredResumePathPdf` →
`resumes/tailored/<companySlug>_<roleSlug>_<YYYYMMDD>.{docx,pdf}`.
After RFC 044, the commit pass writes the PDF path to TSV
`resume_ver` (BL-126 Block A). So the presence of the prefix
`resumes/tailored/` in `resume_ver` is a reliable post-RFC-044
marker. We deliberately **do not** check filesystem existence —
TSV is canonical, and a missing file would represent a separate
bug (operator's local fs vs cron fs out of sync).

We deliberately **do not** read `profiles/<id>/.tailor-state/
coverage-matrix-*.md`. The coverage-matrix files are per-batch
diagnostic artifacts (BL-D), not a per-row state ledger; rebuilding
the "did this row get tailored?" answer from MD parsing would be
fragile. TSV `resume_ver` shape is the contract.

### 4.2 JD pre-fetch

For each candidate, fetch the JD (via existing `fetchJds` + the
shared JD cache). Cache hits are free; misses re-fetch from the
ATS adapter. Rows where the URL is dead or JD fetch fails get a
stderr warn and are excluded from the context — operator can
re-run after addressing the source.

### 4.3 Output: `retro_tailor_context.json`

Written to `profiles/<id>/retro_tailor_context.json`. Shape mirrors
`prepare_context.json` so the SKILL can reuse the existing
Step 6.5 tailoring-loop prose with minimal divergence:

```json
{
  "version": 1,
  "profileId": "<id>",
  "generatedAt": "ISO timestamp",
  "mode": "retro",
  "batch": [
    {
      "key": "greenhouse:1001",
      "source": "greenhouse",
      "jobId": "1001",
      "companyName": "Stripe",
      "title": "Senior Product Manager",
      "url": "https://...",
      "notion_page_id": "...",
      "current_resume_ver": "pm-builder",
      "jdText": "<full JD body>",
      "jdStructure": { "requirements": [...], "responsibilities": [...] }
    }
  ],
  "stats": {
    "candidatesTotal": N,
    "jdFetchedOk": M,
    "jdFetchFailed": K
  }
}
```

**Why include `notion_page_id` in the context?** The SKILL passes
it straight back in `results.json` (new per-row field
`notionPageId`) so the commit phase can update the right page
without re-querying Notion by key.

### 4.4 Dry-run output

```
retro-tailor: scanned 247 rows, 18 Strong in To Apply, 12 retro candidates
JD-fetch: 12 ok, 0 failed
wrote retro_tailor_context.json (12 rows → profiles/jared/retro_tailor_context.json)
next: run the SKILL retro-tailor mode to drive the loop, then commit with
      `node engine/cli.js retro-tailor --profile jared --apply --results-file <path>`
```

## 5. Phase 2 — commit

### 5.1 Inputs

- `--results-file <path>` — JSON `{ profileId, results: [...] }`.
  Same 5 RFC 044 tailor fields per row (`tailoredResume`,
  `tailorCoverage`, `tailorEscalated`, `tailorEscalationReason`,
  `tailorEscalationDetail`) **plus** `notionPageId` (carried back
  from the context).

### 5.2 Per-row commit logic

For each row in `results`:

1. **Validate**: row must exist in TSV with `status === "To Apply"`
   and `notion_page_id` set. Skip with warn otherwise (TSV may have
   moved on between recon and commit — e.g. operator marked Applied
   in Notion and ran sync).
2. **If `tailorEscalated === true`**:
   - Do NOT mutate TSV.
   - Do NOT touch Notion.
   - Append to in-memory escalations list. Render to
     `profiles/<id>/.tailor-state/retro-escalations-<unix-ts>.md`
     at end of run (separate filename from regular tailor
     escalations to keep the audit clean).
3. **If `tailoredResume` is non-null + not escalated**:
   - Compute `docxRel` + `pdfRel` via the existing
     `tailoredResumePath` / `tailoredResumePathPdf`.
   - `generateResumeDocx` + `generateResumePdf` (same as RFC 044
     commit branch). Re-use the page-overflow warning.
   - Update TSV `resume_ver = pdfRel`, bump `updatedAt`.
   - Update Notion page via `notion_sync.updateJobPage(client,
     pageId, { resumeVersion: pdfRel }, propertyMap)`.
   - On Notion update failure: rollback TSV `resume_ver` change,
     warn, continue with next row. The DOCX/PDF files on disk
     stay (idempotent — next run finds them already-tailored and
     won't trigger because TSV still flags the row).
   - **Important**: do NOT touch `cl_path`, `cl_key`, or any CL
     artifact. Per BL-133, cover letter is explicitly out of scope.
4. **If `tailoredResume` is null + not escalated** (no auto-ship,
   no escalation — malformed SKILL output): warn + skip.

### 5.3 Notion update API

Reuse `notion_sync.updateJobPage(client, pageId, updates,
propertyMap)`. It calls `client.pages.update({ page_id,
properties: buildProperties(updates, propertyMap) })`.

**Notion SDK v5 footgun (CLAUDE.md)**: `pages.update` rejects
empty-string scalar values (url, email, phone). `buildProperties`
already filters those out — we send only `{ resumeVersion: pdfRel }`,
which is a non-empty string, so we're safe.

**Single-field update**: Only `Resume Version` is touched.
`buildProperties` skips fields that aren't in the update object,
so other Notion properties (Status, Cover Letter, Notes, etc.)
stay untouched.

**No `databases.query` involvement**: we already have
`notion_page_id` from TSV, so no dedup lookup needed.

### 5.4 Commit output

```
retro-tailor commit:
  tailored: 8 generated, 1 dry-run, 0 failed
  notion: 8 pages updated
  escalations: 3 (wrote profiles/jared/.tailor-state/retro-escalations-<ts>.md)
  rows skipped: 0
```

## 6. Batch semantics

BL-133 specifies "обработка идёт партиями по 5 параллельно с явным
confirmation от оператора между батчами". This is **SKILL-side
orchestration** — engine doesn't impose batch boundaries.

The engine writes the full candidate context (up to `--batch N`,
default 30) once. The SKILL session processes rows in groups of 5,
asks the operator for confirmation between groups, and accumulates
results into a single `results.json`. When the operator stops the
loop (or confirms all groups), the SKILL writes results.json and
the operator runs `retro-tailor --apply --results-file <path>`.

Engine commit can apply a partial results.json (covers only a
subset of context rows) — `results.results[]` is the source of
truth for what to write. Unprocessed context rows simply stay in
the next retro-tailor recon (they're still in `To Apply` without a
tailored `resume_ver`).

## 7. Files

**New:**

- `rfc/047-retro-tailor.md` (this file)
- `engine/commands/retro_tailor.js` — phase router (recon vs
  commit), candidate identification, JD pre-fetch, Notion update.
- `engine/commands/retro_tailor.test.js` — DOD tests below.

**Modified:**

- `engine/cli.js` — register `retro-tailor` in `KNOWN_COMMANDS`,
  wire into `defaultCommands`, extend `HELP_TEXT`.
- `README.md` — add `retro-tailor` to commands list (1 line).
- `docs/reference/cli.md` — full command reference entry.
- `CHANGELOG.md` — Unreleased section.

**Untouched (explicit):**

- `engine/commands/prepare.js` — retro-tailor is a separate command
  with its own commit logic, deliberately decoupled. A future
  refactor could extract a shared `commitTailoredRow` helper, but
  splitting `runCommit` further now would balloon the diff with
  no functional gain. See §"Open questions" below.
- `engine/modules/tailor/dispatcher.js` — reuse
  `tailoredResumePath` / `tailoredResumePathPdf` as-is.
- `engine/modules/generators/resume_docx.js`,
  `engine/modules/generators/resume_pdf_chrome.js` — reuse.
- `engine/core/notion_sync.js`, `engine/core/notion_job_page.js`
  — reuse `updateJobPage` + `makeClient` + `resolveDataSourceId`.

## 8. Test plan

Per DOD (BL-133), tests live in
`engine/commands/retro_tailor.test.js` and cover:

| Case | Setup | Expected |
|---|---|---|
| Happy path recon | 3 Strong+To Apply rows (1 with tailored path, 2 without) | Context written with 2 rows; stdout reports 1 already-tailored skipped |
| Happy path commit | results.json with 2 `tailoredResume` rows | DOCX + PDF generated; TSV `resume_ver` updated; Notion `updateJobPage` called once per row with `resumeVersion` = PDF path |
| Dry-run recon | Same as happy path but `--dry-run` (no `--apply`) | Identical to happy path — `--dry-run` is the default for recon |
| Skip already tailored | 2 rows, one with `resume_ver = "resumes/tailored/..."` | Only the non-tailored row appears in context |
| Skip Medium / Weak | 1 Strong row + 1 Medium row both in To Apply | Only Strong row in context |
| Skip Inbox / Applied | 1 Strong row in Inbox + 1 Strong row in Applied | Both excluded from context |
| Skip CL fields | commit with `tailoredResume` row | `cl_path`, `cl_key` on the TSV row unchanged before vs after |
| Escalation propagation | results.json with `tailorEscalated: true` | TSV `resume_ver` unchanged; Notion not called; escalations MD written with retro- prefix |
| Notion failure rollback | `updateJobPage` throws | TSV `resume_ver` reverts to pre-commit value; warn logged; other rows still process |
| `--since` filter | 2 candidates, one with `updatedAt` before --since | Only the recent one in context |
| `--batch` cap | 10 candidates, `--batch 5` | Context has 5 rows; stdout notes 5 deferred |
| Notion `notionPageId` echo | commit row carries `notionPageId` from context | `updateJobPage` called with that exact id (not a fresh dedup query) |

All Notion / fs / JD-fetch calls are mocked via DI (same pattern
as `prepare.test.js` `makeCommitDeps`).

## 9. Backward compatibility

- TSV schema unchanged.
- Notion DB schema unchanged. Reuses the `Resume Version` select
  (or rich_text after BL-126) field already populated by RFC 044's
  commit path.
- No new env vars.
- No new dependencies in `package.json`.
- `prepare` command behaviour unchanged.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Operator runs retro-tailor without prerequisite sync, hits rows that have moved to Applied in Notion | Phase 1 doesn't mutate anything. Phase 2 re-validates `status === "To Apply"` per row before touching Notion / TSV. |
| Token cost spike (12 rows × 6 iterations × subagent budget) | `--batch` cap (default 30, configurable). SKILL-side 5-row batch with operator confirmation between batches (BL-133). `--since` lets operator restrict scope. |
| Notion `Resume Version` is a `select` field with a closed value set | RFC 044 already writes file paths to that field (`buildJobFieldsForNotion` line 1470). If the schema is `select`, Notion auto-creates options on write. If it's `rich_text` (some profiles), works identically. Either way: not a new risk. |
| Stale `retro_tailor_context.json` from prior run leaks into next commit | Recon overwrites the context file deterministically. Commit reads from `--results-file`, not the context — so even a stale context doesn't poison commit. |
| Engine crashes between TSV save and Notion update → drift | Commit updates Notion FIRST, then mutates in-memory TSV row, then saves TSV at end of loop. On Notion failure for one row, that row's TSV stays untouched; other rows already committed are already saved. (Same per-row atomicity as RFC 022.) Implementation note: this differs from RFC 022's order (PDF→Notion→TSV) because retro-tailor has no PDF guard concern — DOCX/PDF write before Notion in the loop, then Notion, then TSV mutation. |

## 11. Open questions (non-blocking)

1. **Shared `commitTailoredRow` helper?** Both `prepare runCommit`
   and `retro_tailor` runCommit generate DOCX+PDF from
   `tailoredResume`, compute `tailoredResumePath`, and handle the
   page-overflow warning. A factor-out would reduce ~40 lines of
   duplication. **Recommendation**: defer to a follow-up BL. RFC 044
   is recent; let the patterns settle before extracting. Track as
   "P3 refactor" if duplication grows.
2. **Update Notion `Date Added` or `updatedAt` field on retro-tailor
   commit?** Currently we touch only `Resume Version`. Operator might
   want a visible signal in Notion that the row was re-tailored on a
   specific date. **Recommendation**: not in v1 — too easy to
   confuse with the original add-date. Add a `Last Tailored` date
   property in a future schema migration if needed.
3. **Should retro-tailor refuse to run if `applications.tsv` is
   newer than the most recent `sync --apply`?** Defensive guard
   against the "operator forgot sync" case. **Recommendation**: not
   in v1 — there's no on-disk marker for "last sync ran at X". A
   simple stdout reminder at the start of recon ("did you `sync
   --apply` first? Notion may have status changes you haven't
   pulled.") is enough.

## 12. Status / changelog

- 2026-05-26: draft for BL-133, M-tier.
