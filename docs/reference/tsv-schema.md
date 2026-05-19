# TSV schema reference

Authoritative source: `engine/core/applications_tsv.js`. This document
mirrors the constants exported there. When the code and this page disagree,
the code wins — file an issue.

## Overview

Two TSV files participate in the pipeline:

| File | Scope | PII | Owner |
|---|---|---|---|
| `profiles/<profile_id>/applications.tsv` | Per-profile pipeline. Canonical state for every job that has entered the funnel for that candidate. | Yes (URLs, status, page ids). Gitignored. | `engine/core/applications_tsv.js` |
| `data/jobs.tsv` | Shared master pool across profiles. Used only for cross-profile dedup at scan time. | No (no profile-specific fields). Gitignored. | `engine/core/jobs_tsv.js`, consumed by `engine/core/dedup.js` |

Both files are tab-separated with a header row first. Field separators
inside values are normalized to a single space at write time
(`escapeField` strips `\t \r \n`).

## Schema v5 (current)

`HEADER` / `HEADER_V5` constant in `engine/core/applications_tsv.js`.
Twenty columns. Schema rev'd from v4 → v5 on 2026-05-18 (BL-93 / RFC 038)
to persist the full multi-element `locations[]` array from discovery,
instead of collapsing to `locations[0]`. The on-disk column is renamed
`location` → `locations` and carries a JSON-encoded array of strings.

| # | Column | Type | Required | Description |
|---|---|---|---|---|
| 1 | `key` | string | yes | Primary key. Format `"<source>:<jobId>"`. Used for exact dedup against the master pool. |
| 2 | `source` | string | yes | Discovery adapter id (e.g. `greenhouse`, `lever`, `ashby`, `workday`, `remoteok`, `calcareers`, `usajobs`, `manual`, `builtin`). |
| 3 | `jobId` | string | yes | Stable id from the source ATS. May be a numeric string, slug, or UUID. |
| 4 | `companyName` | string | yes | Display name from the source. Resolved to a Companies-DB relation at sync time. |
| 5 | `title` | string | yes | Posted role title. |
| 6 | `url` | string | yes | Application URL. |
| 7 | `locations` | JSON string[] | no | Every entry from the discovery `NormalizedJob.locations` array, JSON-encoded. Empty array (`"[]"`) when the source did not provide any. Notion `Location` is rendered as `locations.join(", ")` on push. |
| 8 | `status` | enum | yes | One of the nine pipeline statuses below. |
| 9 | `notion_page_id` | string | no | Notion page id once the row has been pushed. Empty before push. |
| 10 | `resume_ver` | string | no | Resume archetype id used (key from `resume_versions.json`). |
| 11 | `cl_key` | string | no | Cover-letter archetype id (key from `cover_letter_versions.json`). |
| 12 | `salary_min` | number-as-string | no | Computed by `salary_calc.js` during `prepare`. |
| 13 | `salary_max` | number-as-string | no | Computed by `salary_calc.js` during `prepare`. |
| 14 | `cl_path` | string | no | Filesystem path of the rendered cover letter (PDF). |
| 15 | `createdAt` | ISO timestamp | yes | First time the row entered the pipeline. |
| 16 | `updatedAt` | ISO timestamp | yes | Last write to the row. |
| 17 | `fit_score` | enum | no | Claude's fit verdict from `prepare --phase commit`: `Strong` / `Medium` / `Weak` / `""`. Empty until the row passes through the SKILL. |
| 18 | `fit_rationale` | string | no | Short free-text rationale (≤ ~200 chars typical). Written together with `fit_score`. |
| 19 | `fit_evaluated_at` | ISO timestamp | no | When the SKILL run that wrote `fit_score` happened. Engine reads this to decide whether to re-evaluate (currently: never re-evaluate once written). |
| 20 | `skip_reason` | enum | no | Engine-side persisted skip reason. Today only `duplicate` is set by the engine. `weak_fit` was previously written by the SKILL `decision="skip"` path; that path was removed in RFC 034 (BL-80) but the value may persist on historical rows. Engine-level filter skips (`company_cap`, `title_blocklist`, etc.) are recomputed each run and **not** persisted here. |

## Status values

The TSV maintains a nine-status set. Notion DBs only track eight — the
`Inbox` state is local-only and never pushed.

### Active

| Status | Set by | Meaning |
|---|---|---|
| `Inbox` | `scan` (default for new rows, post-RFC 014) | Fresh from discovery. URL liveness, fit, and CL not yet generated. TSV-only. |
| `To Apply` | `prepare --phase commit` (when checks pass) | Ready to submit. Pushed to Notion. |
| `Applied` | manual or `prepare --phase commit` after submission | Application sent. |
| `Interview` | `check --apply` (on `INTERVIEW_INVITE`) or manual | Candidate is in process. |
| `Offer` | manual | Offer received. |

### Terminal

| Status | Set by | Meaning |
|---|---|---|
| `Rejected` | `check --apply` (on `REJECTION`) or manual | Closed-lost. |
| `Closed` | manual | Withdrawn or otherwise out of pipeline. |
| `No Response` | manual or future ghost-detection | No reply after follow-up window. |
| `Archived` | `validate --apply` (retro blocklist sweep) | Filtered out by post-hoc rule update. |

### Deprecated

These appear in old rows but are never written for new ones. Readers must
accept them; writers must not emit them. RFC 014 (`Inbox` split) and
profile flavor unification (Stage 8) finalized the current set.

| Old status | Replacement |
|---|---|
| `Phone Screen` | `Interview` |
| `Onsite` | `Interview` |

## Schema versioning and auto-upgrade

`load(filePath)` detects the header and returns
`{ apps, path, schemaVersion }`. Writes always emit the current header.

| Version | Header | Width | Reader | Writer |
|---|---|---|---|---|
| v5 | `HEADER_V5` (alias `HEADER`) | 20 | `rowToAppV5` (JSON-decodes `locations` cell) | `rowFor` (current; JSON-encodes `locations`) |
| v4 | `HEADER_V4` | 20 | `rowToAppV4` (wraps single-string `location` to `[location]`) | none |
| v3 | `HEADER_V3` | 16 | `rowToAppV3` (wraps `location`; synthesizes empty `fit_*` + `skip_reason`) | none |
| v2 | `HEADER_V2` | 15 | `rowToAppV2` (synthesizes empty `locations` + `fit_*` + `skip_reason`) | none |
| v1 | `HEADER_V1` | 12 | `rowToAppV1` (synthesizes empty `locations`, `salary_min`, `salary_max`, `cl_path`, `fit_*`, `skip_reason`) | none |

The reader rejects any header that does not match one of the five
constants exactly — extra or reordered columns are not tolerated.

### Recorded backups

Bulk migrations have produced these snapshot files. They are never read
by the engine; keep them under the profile directory for manual rollback
only.

| File | Origin |
|---|---|
| `applications.tsv.pre-stage16` | Pre-migration snapshot before workspace cutover for the PM-Pete profile. |
| `applications.tsv.pre-migrate-2026-04-27` | Pre-migration snapshot for the Healthcare-Hannah profile. |
| `applications.tsv.contaminated-fintech` | One-off cleanup after a cross-profile contamination during early wizard runs. |
| `applications.tsv.pre-v5-<YYYY-MM-DD>` | Written by `scripts/migrate_tsv_v4_to_v5.js` before promoting a v4 file to v5 (RFC 038). |

## `data/jobs.tsv` (shared master pool)

Subset of v3 minus per-profile fields. Used only by `engine/core/dedup.js`
to gate `appendNew` against jobs that have already been seen on any
profile. Contains no PII (no `notion_page_id`, no `cl_path`, no statuses).
See `engine/core/jobs_tsv.js` for the exact column list.

## Push gating

The Stage 16 `.stage16/push_manifest.json` allow-list that previously
gated `sync` was removed on 2026-05-04 (see comment at the top of
`engine/commands/sync.js`). Push now operates on every TSV row that
satisfies the command's own filter — there is no manifest layer.

## Future schema (draft)

RFC 012 (relational data model) proposes promoting `companyName` →
`companyId` and adding a separate `companies.tsv` in a future bump.
The TSV reader will keep auto-upgrading from v1 through the current
version on every read.

## See also

- [Notion schema reference](notion-schema.md)
- [CLI reference](cli.md)
- [Architecture overview](../architecture/overview.md)
- [RFC 014 — Status split: Inbox vs To Apply](../../rfc/014-status-split-new-vs-toapply.md)
- [RFC 012 — Relational data model](../../rfc/012-relational-data-model.md) (draft)
