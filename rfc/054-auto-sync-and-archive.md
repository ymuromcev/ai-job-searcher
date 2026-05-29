# RFC 054 — Auto-sync + archive used tailored artifacts

- Status: **proposed**
- Date: 2026-05-28
- Refs: BL-151, RFC 014 (status split: Inbox vs To Apply), RFC 022 (per-row Notion push), RFC 044 (Strong tailoring loop — `resumes/tailored/` convention)
- Tier: M

## Problem

Two operator-reported friction points (2026-05-28):

1. **Stale Notion state.** Status changes made in Notion (Inbox → Applied,
   Applied → Rejected, …) reach the local TSV only when the operator
   manually runs `node engine/cli.js sync --profile <id> --apply`.
   They forget. `prepare` then reasons over stale rows — e.g. shows a
   row as still-`Applied` while Notion has had it as `Rejected` for a
   week. The cap counter, the inbox health line, and Weak/Medium
   re-eval guards all silently consume bad input.

2. **Tailored artifacts pile up.** `profiles/<id>/resumes/tailored/`
   (RFC 044) and `profiles/<id>/cover_letters/<slug>/<clKey>.pdf`
   accumulate every generated DOCX/PDF forever, even after the
   corresponding job moved past `To Apply`. Active profiles
   accumulate hundreds of files within a month and the few
   currently-actionable docs get lost in the pile.

## Approach

One shared `runAutoSync(profileId, ctx)` helper invoked as a **pre-hook**
in `cli.js` before `scan` and `prepare` run. The hook:

1. Calls the existing `sync.js` command with `--apply` (Notion → TSV
   pull). Stdout lines prefixed with `[sync]`.
2. Runs a new pure helper `engine/core/archive_used_artifacts.js` to
   plan archive moves for tailored artifacts tied to TSV rows whose
   status moved past `To Apply`.
3. Applies the planned moves and rewrites `resume_ver` / `cl_path`
   in the TSV to the new archive paths.

Existing `node engine/cli.js sync --profile <id> --apply` also runs
the archive sweep after its Notion-pull phase — so manual invocations
behave identically.

Both auto-sync and the manual archive sweep are opt-out with `--no-sync`
on `scan` and `prepare`. `--no-sync` already existed for scan; we
re-purpose it (no semantic change for callers; we just move from
post-hook to pre-hook).

## Decisions (operator-confirmed)

| # | Decision | Value |
|---|---|---|
| 1 | Archive trigger statuses | `{Applied, Interview, Offer, Rejected, Closed, No Response}` — exactly the names `applications_tsv.js` uses. Active statuses (`Inbox`, `To Apply`, `In Review`) stay in place. |
| 2 | Sync cadence | every `scan` and `prepare` run, no caching. `--no-sync` to opt out. |
| 3 | Archive layout | `profiles/<id>/cv/archive/YYYY-MM/<original-filename>` flat by month. Mirror for `profiles/<id>/cover_letters/archive/YYYY-MM/<original-filename>`. YYYY-MM derived from row `updatedAt`, fallback `createdAt`, fallback `"unknown"`. (`applied_at` column does not exist in the v5 schema — `updatedAt` is the closest signal of the status-change moment.) |
| 4 | Archetype detection | A path is treated as a TAILORED artifact (and therefore archivable) iff it starts with `cv/tailored/`, `resumes/tailored/`, or `cover_letters/tailored/`. Any other path is treated as an archetype and **never moved**. RFC 044 convention: engine-generated tailored DOCX/PDF always starts with `resumes/tailored/`. |

## Helper contract

```js
// engine/core/archive_used_artifacts.js

planArchiveMoves({ rows, profileId, fs, now }) → {
  moves:    [{from, to, rowKey, kind: "cv" | "cl"}],
  skipped:  [{path, reason, rowKey}],
  warnings: [string],
}

applyArchiveMoves(plan, { fs, tsvUpdater, logger }) → {
  moved:    number,
  skipped:  number,
  warnings: string[],
}
```

- `rows` — array of TSV row objects from `applications_tsv.load()`.
- `profileId` — `"lilia"` / `"jared"` / etc., used to resolve the
  profile root via the caller (the helper is path-agnostic; the
  caller injects `profileRoot` into the `fs` facade or via a small
  wrapper).
- `fs` — facade `{existsSync, mkdirSync, renameSync}` so tests inject
  in-memory fakes.
- `now` — `() => Date` for time control in tests.
- `tsvUpdater(rowKey, patch)` — closes over the in-memory app list,
  applied during `applyArchiveMoves` to keep TSV → archive paths
  consistent.

Pure planning is in `planArchiveMoves`; all side effects live in
`applyArchiveMoves`. Existing `engine/commands/sync.js` calls both
and saves the TSV.

## Idempotency

- A move is planned only if `from` exists AND `to` does not.
- If `to` already exists (e.g. previous archive sweep already moved
  this file), the helper emits a `skipped: target-exists` and does
  NOT mutate TSV.
- If `from` does not exist (file was hand-deleted, or row's
  `resume_ver` / `cl_path` still points at a stale tailored path
  whose file was already moved on a previous run), the helper emits
  a `skipped: source-missing` warning and does NOT mutate TSV.
- Running the helper twice on the same TSV is a no-op the second time
  (after the first run successfully rewrites `resume_ver` /
  `cl_path` to the archive paths, those paths now point to
  `cv/archive/…` / `cover_letters/archive/…` which fail the
  archetype-detection prefix check and are skipped).

## TSV mutation contract

On a successful move:
- `resume_ver` updated to the new archive path when the move was a CV.
- `cl_path` updated to the new archive path when the move was a CL.
- `updatedAt` left **unchanged** (the row's logical status hasn't
  changed — only the file location). This keeps `applied_at`-style
  reasoning intact for downstream consumers.

## --no-sync

`scan` and `prepare` both accept `--no-sync` (already a CLI flag,
`engine/cli.js:42`). When set, the pre-hook is skipped entirely (no
sync, no archive sweep). `--dry-run` on `scan` also skips the
pre-hook for parity with current behaviour.

`sync --apply --no-sync` is a no-op contradiction — we don't add
a `--no-archive` flag at this time. If the operator wants archive-
without-pull, they can pass `--apply` and accept that the pull
phase also runs (network call to Notion is cheap relative to the
file IO of the archive sweep).

## Edge cases

| Case | Behaviour |
|---|---|
| `resume_ver` is an archetype name (e.g. `Risk_Fraud`) | Not a path → skipped silently. Archetypes are referenced by name, not path. |
| `resume_ver` is empty | Skipped silently. |
| `cl_path` is empty | Skipped silently. |
| Row status not in trigger set | No move planned for that row. |
| Target directory does not exist | Created via `fs.mkdirSync({recursive: true})`. |
| Status revert (`Applied` → `Inbox` by mistake) | The file stays in `cv/archive/…`. **Known limitation** — no auto-restore. Documented in CHANGELOG. Operator can manually `mv` the file back and update the TSV; nothing automatic. |
| Move succeeds, TSV save fails (rare) | Move is already on disk; row TSV path is stale until next save. Next auto-sync run re-plans the move, sees `from` missing → warns, skips. Self-healing. |
| Hand-edited TSV with a path that doesn't exist | `skipped: source-missing` warning, no TSV mutation. |
| Two rows referencing the same tailored file (legacy) | First wins; second emits `skipped: source-missing` on the same run. |

## Output format

Auto-sync pre-hook stdout (caller's stdout):

```
[sync] pulling Notion → TSV (lilia) ...
[sync] 3 rows status-changed: 2 → Applied, 1 → Rejected
[sync] archived 3 used artifacts → cv/archive/2026-05/, cover_letters/archive/2026-05/
```

When Notion credentials are missing for the profile:

```
[sync] skipped — no NOTION_TOKEN for lilia
```

(scan/prepare still proceed.)

When `--no-sync` is set: no pre-hook output at all.

## Open questions

- Cover letter path is currently `cover_letters/<CompanySlug>/<clKey>.pdf`
  in this codebase (`prepare.js:2221`), NOT `cover_letters/tailored/`.
  Under the operator's archetype-detection rule (#4), this means
  current CL files are treated as archetypes and **never moved**.
  This is consistent with the decision but means the CL pile-up
  problem won't be solved by this RFC for the existing CL output path.
  Recommend a follow-up BL to migrate CL output to
  `cover_letters/tailored/<slug>/<clKey>.pdf` so it picks up the same
  sweep. Out of scope here.

## Test coverage (engine/core/archive_used_artifacts.test.js)

- (a) Applied / Interview / Offer / Rejected / Closed / No Response → move-candidates.
- (b) Inbox / To Apply / In Review → stay in place.
- (c) Archetype paths (not under `tailored/`) → never moved, no warning.
- (d) Missing source file → warn, no TSV mutation, no move.
- (e) Target file already exists → skip + warn (no overwrite).
- (f) Idempotent — running the same plan twice is a no-op the second run.
- (g) YYYY-MM derived from `updatedAt` then `createdAt` fallback.
- (h) Both `resume_ver` AND `cl_path` get archived for the same row.
- (i) Row with no `cl_path` (empty) → only `resume_ver` considered.

Plus a `cli.test.js` test verifying `--no-sync` skips the pre-hook
entirely (no sync call, no archive sweep).

## Rollback

Revert the PR. Files already moved to `cv/archive/…` /
`cover_letters/archive/…` stay where they are — `resume_ver` /
`cl_path` in the TSV continue to point at the archive paths, and the
archive directories function as a normal subdirectory. No data loss.
