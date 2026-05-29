# CLI reference

Reference for the AI Job Searcher CLI. Authoritative behavior lives in `engine/cli.js` and `engine/commands/*.js`; this document mirrors that surface.

## Overview

Single entry point:

```bash
node engine/cli.js <command> [flags]
```

Every command takes `--profile <id>`. The CLI does not run interactively — all inputs come from flags, files, and per-profile state on disk.

Commands:

| Command | Purpose |
| --- | --- |
| `scan` | Run discovery adapters, append fresh jobs to shared pool and per-profile pipeline. |
| `validate` | Pre-flight checks: TSV hygiene, company-cap, URL liveness, retro blocklist sweep. |
| `prepare` | Two-phase fresh-row triage: filter / URL / JD / salary, then commit fit + cover letter + Notion page. |
| `sync` | Pull from Notion into per-profile applications.tsv. Notion is source of truth for status. |
| `check` | Two-phase Gmail response polling (status updates + comments). |
| `answer` | Two-phase application Q&A reuse + push to Notion Application Q&A DB. |
| `indeed-prep` | Print Indeed scan playbook for a browser MCP. Phase 1 of the Indeed ingest flow. |
| `reclassify` | Re-run the email classifier across historical `OTHER` entries in `processed_messages.json` (30-day window). Dry-run by default. |
| `retro-tailor` | Re-tailor Strong rows already in `To Apply` whose resume predates the RFC-044 tailoring loop. Recon by default; `--apply --results-file` commits. |

The dispatcher also runs deterministic pre-command hooks (BL-151 / RFC 054). Today both `scan` and `prepare` auto-trigger `sync --apply` before their main work runs, so downstream filters / cap counters / fit-eval read fresh Notion state. The sync command itself also archives engine-tailored CV/CL files for rows whose status moved past `To Apply` (Applied / Interview / Offer / Rejected / Closed / No Response). The pre-hook is suppressed by `--no-sync`; `scan --dry-run` also suppresses it for parity with the prior dry-run-never-mutates behaviour.

## Global flags

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--profile <id>` | string | — | Required. Profile id under `profiles/<id>/`. Matched against `^[a-z][a-z0-9_-]*$`. |
| `--dry-run` | boolean | false | Print planned changes without writing. |
| `--apply` | boolean | false | Commit mutations. Required by `sync` for any TSV write, by `validate` for retro-sweep archival, by `check` to mutate TSV + Notion, and by `answer --phase push`. No-op for `scan` (always writes; use `--dry-run` to preview). |
| `--verbose` | boolean | false | Verbose logging. With `--verbose`, secret values of length ≥ 6 are also masked in stdout. |
| `-h`, `--help` | boolean | false | Print help text and exit 0. |

The `--profile <id>` regex is applied by `engine/core/profile_loader.js` `validateId`. Path traversal is blocked: `profiles/<id>/` must resolve strictly inside the configured profiles dir.

Per-command flags: `--phase <pre|commit|search|push>`, `--results-file <path>`, `--batch <n>`, `--prepare`, `--since <iso>`, `--no-sync`, `--no-callout`, `--auto`, `--company <name>`, `--role <title>`, `--question <text>`. Each is documented under the command that consumes it.

## Commands

### scan

Synopsis: `node engine/cli.js scan --profile <id> [--dry-run] [--no-sync] [--verbose]`

Runs every discovery adapter declared in `profile.modules` (entries shaped as `discovery:<name>`). Reads the shared companies pool (`data/companies.tsv`), filters per-profile visibility (`profile` column), then per-profile whitelist/blacklist, runs each adapter, dedups against `data/jobs.tsv`, and applies `filter_rules` (title / company / location / geo). `company_cap` is **not** applied at scan time — it is an apply-time safeguard enforced inside `prepare --phase pre` (step 4) so that 50-500-role frontier AI labs still surface in `Inbox` and `prepare` decides which 3 are worth promoting to `To Apply`. Fresh accepted jobs are appended to `data/jobs.tsv` and to `profiles/<id>/applications.tsv` with `status: Inbox` (TSV-only staging — `prepare --phase commit` later transitions `Inbox → To Apply` or `Inbox → Archived`; see [RFC 014](../../rfc/014-status-split-new-vs-toapply.md)). Filter rejections are also appended to applications.tsv as `status: Archived` so the per-profile audit is complete; reasons go to `filter_rejections.log` (jsonl).

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--profile <id>` | string | — | Required. |
| `--dry-run` | boolean | false | Skip TSV writes; report counts only. Suppresses the auto-sync pre-hook. |
| `--no-sync` | boolean | false | Skip the auto-sync pre-hook (BL-151 / RFC 054). |
| `--verbose` | boolean | false | Adapter-level warn lines + secret-redactor count. |

Outputs and side effects:

- Appends to `data/jobs.tsv` (shared pool).
- Appends to `profiles/<id>/applications.tsv` (`status: Inbox` for passed rows, `Archived` for filter-rejected).
- Appends to `profiles/<id>/filter_rejections.log` (one JSON object per line).
- BEFORE running, auto-triggers `sync --apply` (Notion → TSV pull + archive sweep) unless `--dry-run` or `--no-sync` (BL-151 / RFC 054).

Example:

```bash
node engine/cli.js scan --profile <id>
```

Common errors:

- `companies pool is empty at data/companies.tsv` — run `node engine/bin/seed_companies.js` first.
- `no targets after applying profile filters — nothing to scan` — every target was excluded by whitelist / blacklist / per-profile visibility.
- `warn: no adapter for source "<name>"` — entry in companies.tsv references an unregistered adapter.
- `warn: auto-sync failed` — non-fatal; usually missing `<ID>_NOTION_TOKEN` in env.

### validate

Synopsis: `node engine/cli.js validate --profile <id> [--dry-run] [--apply] [--dedup]`

Pre-flight pipeline checks. Default mode is dry-run; `--apply` is required to commit retro-sweep archives. Steps:

1. Load `applications.tsv` (and `data/jobs.tsv`); fail on parse errors.
2. `company_cap`: count active applications per company against `filter_rules.company_cap.max_active` (with overrides). Active statuses default to `Applied / To Apply / Interview / Offer`.
3. `url_liveness`: HEAD-ping each active row's `url` with bounded concurrency. SSRF-hardened: requires http(s), rejects loopback / link-local / private IPv4 and IPv6, no redirect follow, no GET fallback.
4. `retro_sweep`: re-apply `company_blocklist`, `title_blocklist`, `location_blocklist`, and `geo` policy to rows in `Inbox` or `To Apply`. Reports matches by default; with `--apply`, sets `status: Archived` and writes `updatedAt`.

`--dedup` is a standalone subtask (skips steps 2-4): collapse rows in `applications.tsv` that resolve to the same canonical key after stripping ATS prefixes recursively. Catches the legacy `lever:abc` ↔ `lever:lever:abc` collision pattern produced by the discovery key-prefix migration. Winner per group: row with `notion_page_id` → higher status (`Offer > Interview > Applied > To Apply > Inbox > No Response > Rejected > Closed > Archived`) → newer `updatedAt` → shorter key. Loser fields (`fit_score`, `cl_path`, `location`, etc.) are merged into the winner only when the winner's field is empty. Groups whose rows disagree on company or url path are flagged as **suspicious** and never auto-collapsed. Default: dry-run report. With `--apply`: rewrites TSV after backing up to `applications.tsv.pre-dedup-<timestamp>`.

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--profile <id>` | string | — | Required. |
| `--dry-run` | boolean | true (implicit) | Default mode. URL liveness is skipped under dry-run; retro-sweep matches are reported only. |
| `--apply` | boolean | false | Run URL liveness against the network and commit retro-sweep archival. With `--dedup`: rewrite TSV. |
| `--dedup` | boolean | false | Standalone: collapse legacy-prefix collisions in `applications.tsv`. Default report-only; with `--apply`, rewrites TSV after backup. |

Outputs and side effects:

- With `--apply` (no `--dedup`): rewrites `profiles/<id>/applications.tsv` for any row archived by retro-sweep.
- With `--dedup --apply`: rewrites `profiles/<id>/applications.tsv` (deduped) and writes `applications.tsv.pre-dedup-<timestamp>` backup beside it.

Example:

```bash
node engine/cli.js validate --profile <id> --apply
node engine/cli.js validate --profile <id> --dedup            # dry-run report
node engine/cli.js validate --profile <id> --dedup --apply    # rewrite TSV
```

Common errors:

- `error: profile not loaded` — `profiles/<id>/profile.json` missing or malformed.
- `company_cap: <n> violation(s)` — caps exceeded; tune `filter_rules.company_cap` or archive duplicates.
- `url_liveness: <n> URL(s) blocked by SSRF guard` — adapter emitted a private-network URL; report bug against the adapter.
- Exit 1 when any issue is reported and `--apply` was not passed.

### prepare

Synopsis: `node engine/cli.js prepare --profile <id> --phase <pre|commit> [--mode <fresh|topup>] [--batch <n>] [--need <k>] [--results-file <path>] [--dry-run] [--no-sync]`

Two-phase fresh-row triage. `--phase pre` enriches every fresh row (status `Inbox` or `To Apply` without `notion_page_id`) with URL-liveness, JD fetch, salary calc, and writes `prepare_context.json` for the `job-pipeline` skill to consume. `--phase commit` reads a SKILL-produced results file and, for every evaluated row, flips status to `To Apply`, generates the cover letter (when `clParagraphs` is present), pushes the Notion page, and back-fills `notion_page_id` / `salaryMin` / `salaryMax` / `clPath`. A legacy `decision` field on a row is tolerated — the engine logs one warning per run and ignores it.

`--phase pre` runs in one of two modes (BL-9 Step 4):

- `--mode fresh` (default) — runs the full filter / URL / JD / salary pipeline, persists the unconsumed (still-eligible) tail as `deferredQueue[]` keys on the context, and rewrites `prepare_context.json`.
- `--mode topup` — reads the existing `prepare_context.json`, pulls the next `--need K` keys from `deferredQueue`, re-validates them against the current TSV (drops committed / Weak / duplicate rows), URL-checks + JD-fetches, and **appends** new entries to `batch[]`. Use this after a SKILL run where Strong + Medium fell below `batchSize` so the next operator turn picks up where the last one left off without a fresh scan. Default `--need` is `batchSize - currentBatch.length` (the deficit). Errors out if `prepare_context.json` is missing.

Both modes write `stats.inboxExhausted: bool` to the context. The SKILL loop reads this to know when to stop iterating: `true` means no more fresh rows in TSV outside the current batch (excluding `duplicate`-flagged rows).

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--profile <id>` | string | — | Required. |
| `--phase <pre\|commit>` | string | — | Required. Anything else exits 1. |
| `--mode <fresh\|topup>` | string | `fresh` | Used by `--phase pre`. `topup` appends to an existing context. Unknown mode → exit 1. `weak-fallback` was removed in RFC 034 (BL-80); passing it exits 1 with a migration hint. |
| `--batch <n>` | int | 30 | Used by `--phase pre --mode fresh`. Target alive rows after URL-check. The pre phase keeps pulling from the filter-passed pool until `--batch` rows are alive or the pool is exhausted. |
| `--need <k>` | int | deficit | Used by `--phase pre --mode topup`. Number of new alive entries to append. Default fills the deficit (`batchSize - len(currentBatch)`). |
| `--results-file <path>` | string | — | Required for `--phase commit`. JSON produced by the SKILL. |
| `--dry-run` | boolean | false | `pre`: skip writing `prepare_context.json`. `commit`: skip TSV write. |
| `--no-sync` | boolean | false | Skip the auto-sync pre-hook (BL-151 / RFC 054). |

Outputs and side effects:

- `--phase pre` writes `profiles/<id>/.skill-state/prepare_context.json` (alive rows + JDs + salary plan + filter context).
- `--phase commit` rewrites `profiles/<id>/applications.tsv`. May also write generated cover-letter / resume artifacts under `profiles/<id>/cover_letters/tailored/` and `resumes/tailored/` (the archive-eligible layout — BL-152 / RFC 054), and create Notion pages.

Example (autonomous loop driven by the SKILL — operator runs only `/job-pipeline prepare`):

```bash
# Iteration 1
node engine/cli.js prepare --profile <id> --phase pre --mode fresh --batch 30
# (SKILL judges; if Strong+Medium < 30 and !inboxExhausted)
# Iteration 2
node engine/cli.js prepare --profile <id> --phase pre --mode topup --need 18
# (SKILL judges new entries; iterations 3 likewise; loop ends when target met or inboxExhausted)
# Push all evaluated rows to Notion
node engine/cli.js prepare --profile <id> --phase commit --results-file profiles/<id>/.skill-state/results.json
```

> Since RFC 034 (BL-80), `prepare --phase commit` pushes every evaluated row to Notion as `To Apply` regardless of `fitScore`. The operator triages Strong / Medium / Weak in Notion. Legacy `results.json` files carrying a `decision` field are accepted (one warning logged per run) and the field is ignored.

Common errors:

- `error: --phase <pre|commit> is required` — missing or invalid `--phase`.
- `--phase commit requires --results-file <path>`.
- `results file invalid` — schema-validation failure against the SKILL contract (per-row `key`, optional `archetype` / `clParagraphs` / `salaryMin` / `salaryMax`).
- `error: --mode "weak-fallback" was removed in RFC 034 (BL-80)` — pass `--mode fresh` or `--mode topup`.

### sync

Synopsis: `node engine/cli.js sync --profile <id> [--dry-run] [--apply] [--no-callout]`

One-way pull from the per-profile Notion Jobs Pipeline DB into `applications.tsv`. Notion is source of truth for `status` and `notion_page_id`; both are reconciled by row `key` (or composite `source:jobId` when present). Push is intentionally absent — rows reach Notion only through `prepare`.

Under `--apply`, the command also archives engine-tailored CV/CL artifacts (BL-151 / RFC 054). Rows whose status moved past `To Apply` (`Applied` / `Interview` / `Offer` / `Rejected` / `Closed` / `No Response`) have their tailored DOCX/PDF moved from `resumes/tailored/` to `cv/archive/YYYY-MM/<basename>` and from `cover_letters/tailored/` to `cover_letters/archive/YYYY-MM/<basename>`. YYYY-MM is derived from the row's `updatedAt` (fallback `createdAt`, then `"unknown"`). TSV `resume_ver` / `cl_path` are rewritten to the new archive paths so Notion-linked file URLs keep resolving. Archetype paths (anything not under one of the three `tailored/` prefixes) are never moved.

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--profile <id>` | string | — | Required. |
| `--dry-run` | boolean | true (default mode) | Print pull plan without touching TSV. |
| `--apply` | boolean | false | Required to commit TSV updates and refresh the hub Inbox-callout block. |
| `--no-callout` | boolean | false | Suppress the "hub callout: not configured" hint when `notion.hub_layout.inbox_callout_block_id` is unset. |

Outputs and side effects:

- With `--apply`: rewrites `profiles/<id>/applications.tsv` for changed rows.
- With `--apply` and a configured `notion.hub_layout.inbox_callout_block_id`: updates the hub callout text to `Inbox: <n> | Updated: YYYY-MM-DD`.

Example:

```bash
node engine/cli.js sync --profile <id> --apply
```

Common errors:

- `error: profile.notion.jobs_pipeline_db_id is not configured`.
- `error: missing <ID>_NOTION_TOKEN in env`.
- `pull error: <message>` — Notion fetch failure; exits 1 even under dry-run.

### check

Synopsis: `node engine/cli.js check --profile <id> [--prepare | --apply | --auto] [--since <iso>] [--dry-run] [--verbose]`

Two-phase Gmail response polling. Phase 1 (`--prepare`) builds Gmail batch queries and writes `check_context.json` for a Claude MCP session to fetch emails into `raw_emails.json`. Phase 3 (default invocation, with `--apply` to commit) reads `raw_emails.json`, classifies each message (rejection / interview invite / info request / recruiter outreach / LinkedIn alert), matches it to active TSV rows, and plans status transitions and Notion page comments. `--auto` runs the full loop in one process via the OAuth Gmail client.

Status mapping uses the unified status set: `To Apply / Applied / Interview / Offer / Rejected / Closed / No Response / Archived`. Rejections move to `Rejected`; interview invites move to `Interview`; info requests add a Notion comment without changing status. Rows in `Rejected / Closed / Archived / No Response` are skipped.

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--profile <id>` | string | — | Required. |
| `--prepare` | boolean | false | Phase 1: build batches, write `check_context.json`, print JSON to stdout. |
| `--apply` | boolean | false | Phase 3 commit. Without `--apply`, phase 3 runs in dry-run mode (plan only). |
| `--auto` | boolean | false | Single-process autonomous flow using IMAP + app-password (RFC 021). Requires `<ID>_GMAIL_USER` and `<ID>_GMAIL_APP_PASSWORD`. Generate the app-password at <https://myaccount.google.com/apppasswords> (requires 2FA). |
| `--since <iso>` | string | saved cursor | Override cursor. Clamped to a 30-day max window. |
| `--dry-run` | boolean | true for phase 3 default | Phase 1 honors it (skip context-file write). Phase 3 default is dry-run unless `--apply` is set. |
| `--verbose` | boolean | false | In `--auto`, prints per-batch Gmail-id counts to stderr. |

Outputs and side effects:

- `--prepare`: writes `profiles/<id>/.gmail-state/check_context.json`; prints batches JSON.
- `--apply` (or `--auto --apply`): updates `applications.tsv`; calls Notion `pages.update` for status transitions and `comments.create` for info requests; appends to `email_check_log.md`, `rejection_log.md`, `recruiter_leads.md`; rewrites `processed_messages.json` (cursor + ids).

Example:

```bash
node engine/cli.js check --profile <id> --prepare --since 2026-04-01T00:00:00Z
node engine/cli.js check --profile <id> --apply
```

Common errors:

- `raw_emails.json not found` — phase 3 invoked before the MCP session wrote the file.
- `gmail credentials missing for --auto` — namespaced `<ID>_GMAIL_USER` or `<ID>_GMAIL_APP_PASSWORD` env vars absent. Generate the app-password at <https://myaccount.google.com/apppasswords>.
- `error: notion update failed` — surfaced per row; exit 1 if any row failed.

### answer

Synopsis: `node engine/cli.js answer --profile <id> --phase <search|push> [...]`

Two-phase application-question reuse. `--phase search` looks up reusable answers in the per-profile Notion Application Q&A DB by company + role + question key and prints a JSON match report. `--phase push` reads a results file, writes a local markdown backup under `profiles/<id>/application_answers/`, then creates or updates a Notion page.

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--profile <id>` | string | — | Required. |
| `--phase <search\|push>` | string | — | Required. |
| `--company <name>` | string | — | Required for `--phase search`. |
| `--role <title>` | string | — | Required for `--phase search`. |
| `--question <text>` | string | — | Required for `--phase search`. One line. |
| `--results-file <path>` | string | — | Required for `--phase push`. JSON: `{company, role, question, answer, category?, notes?, existingPageId?}`. |
| `--apply` | boolean | false | The push phase commits the Notion call regardless of `--apply` (the side-effect is the whole point of `push`); `--apply` is reserved for parity with other commands. |

Outputs and side effects:

- `--phase search`: prints a JSON object with `key`, `exact`, `partials`, `schema.categories`, `category_suggestion`. Read-only.
- `--phase push`: writes `profiles/<id>/application_answers/<Company>_<role-slug>_<YYYYMMDD>.md` (next-available numeric suffix on collision); creates or updates a page in the Application Q&A DB.

Example:

```bash
node engine/cli.js answer --profile <id> --phase search \
  --company "Acme" --role "Senior PM" \
  --question "Why are you interested in this role?"

node engine/cli.js answer --profile <id> --phase push \
  --results-file /tmp/answer.json
```

Common errors:

- `--phase search requires --company, --role, and --question`.
- `--phase push requires --results-file <path>`.
- `profile "<id>" has no notion.application_qa_db_id configured`.
- `notion push failed: <message>. Local backup preserved at <path>` — the markdown backup is written before the Notion call so there is always a recoverable artifact on disk.

### indeed-prep

Synopsis: `node engine/cli.js indeed-prep --profile <id> [--dry-run]`

Phase 1 of the Indeed ingest flow. Reads the per-profile Indeed config (keywords, location, radius, fromage, filter blockers, batch hint), constructs scan URLs and a viewjob template, and prints a JSON payload that drives a Claude browser MCP session. Scaffolds an empty `raw_indeed.json` in the profile's Indeed state dir if it is missing.

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--profile <id>` | string | — | Required. |
| `--dry-run` | boolean | false | Skip directory creation and `raw_indeed.json` scaffolding. |

Outputs and side effects:

- Prints a JSON payload (`profile_id`, `generated_at`, `ingest_file`, `scan_urls`, `extraction_snippet`, `viewjob_template`, `filters`, `instructions`).
- Without `--dry-run`: creates the Indeed state dir if absent and writes `raw_indeed.json` with `[]` if absent (never overwrites).

Example:

```bash
node engine/cli.js indeed-prep --profile <id>
```

Common errors:

- `error: indeed config not found` — profile lacks the Indeed adapter config block.

### reclassify

Synopsis: `node engine/cli.js reclassify --profile <id> [--since <iso>] [--limit <n>] [--apply] [--notion] [--verbose]`

Re-evaluates historical `OTHER` entries in `profiles/<id>/.gmail-state/processed_messages.json` through the current classifier (RFC 028 / BL-44). After classifier widening (e.g. for ATS multi-step interview invites), future `check` ticks catch the new patterns, but entries already persisted as `OTHER` are never re-judged. `reclassify` closes that gap: re-fetch each `OTHER` message body over IMAP (sharing the same app-password transport as `check --auto`), classify again, and report what changed. Window is 30 days (anything older is already pruned from `processed_messages.json`). Dry-run by default — `--apply` rewrites the JSON state, `--apply --notion` additionally walks each reclassified row interactively and updates the matching Notion page (status + bot comment).

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--profile <id>` | string | — | Required. |
| `--since <iso>` | string | — | Only consider `OTHER` entries with `date >= ISO`. Clamped to a 30-day max window. |
| `--limit <n>` | int | — | Cap entries per run. Useful for smoke / staged dry-runs. |
| `--apply` | boolean | false | Rewrite `processed_messages.json` with new classifier types. Without it the command prints the plan only. |
| `--notion` | boolean | false | With `--apply`: interactive per-row prompt to update the matching Notion page status and add a bot comment. Rows in a terminal status (`Inbox`, `Rejected`, `Closed`, `Archived`, `No Response`) default the prompt to `N` — operator must explicitly type `y` to overwrite. Accepts `y`, `n`, `skip-all`, `quit`. |
| `--verbose` | boolean | false | Print per-id IMAP fetch progress to stderr and log `unchanged` rows alongside the reclassified ones. |

Outputs and side effects:

- Always prints a per-row report (`OTHER → <NewType>` with classifier evidence) and a summary line (`scanned · reclassified · unchanged · errors`).
- `--apply`: writes a timestamped backup `processed_messages.json.<iso>.bak` next to the state file, then rewrites `processed_messages.json` with the new types. `last_check` is intentionally **not** bumped — `reclassify` is not a check tick.
- `--apply --notion`: per accepted row, calls Notion `pages.update` for the proposed status transition and `comments.create` for a bot comment crediting BL-44. Type → status map: `INTERVIEW_INVITE → Interview`, `REJECTION → Rejected`, `POSITION_CLOSED → Closed`. `INFO_REQUEST` and `ACKNOWLEDGMENT` leave the page status alone (comment only).
- Partial Notion failures (status moved, comment failed) are surfaced loudly on stderr with both `page <id>` and `source <messageId>` so the operator can grep for recovery.

Example:

```bash
# Dry-run: see what the current classifier would change in the last 30 days
node engine/cli.js reclassify --profile <id>

# Smoke first 5 entries since a specific date
node engine/cli.js reclassify --profile <id> --since 2026-04-15T00:00:00Z --limit 5

# Commit JSON state only
node engine/cli.js reclassify --profile <id> --apply

# Commit JSON state + walk Notion updates interactively
node engine/cli.js reclassify --profile <id> --apply --notion
```

Common errors:

- `gmail credentials missing` — namespaced `<ID>_GMAIL_USER` or `<ID>_GMAIL_APP_PASSWORD` env vars absent. Same credentials as `check --auto`; generate the app-password at <https://myaccount.google.com/apppasswords>.
- `error: IMAP batch fetch failed after retries` — transient IMAP failures retry with exponential backoff (up to 5 attempts); this surfaces only when the whole batch fails. Re-run later.
- `error: missing <ID>_NOTION_TOKEN — Notion updates skipped` — `--apply --notion` was requested but no Notion token is configured. The JSON state has already been written; rerun with `--notion` once the token is set.

### retro-tailor

Synopsis: `node engine/cli.js retro-tailor --profile <id> [--dry-run] [--apply] [--results-file <path>] [--batch <n>] [--since <iso>]`

Re-tailors Strong rows currently in `To Apply` whose resume was generated before the RFC-044 Strong-fit tailoring loop existed. Detection signal: TSV `resume_ver` does not start with `resumes/tailored/`. Two phases:

- **Recon (default)**: scan TSV, identify candidates, pre-fetch JDs (cache-aware), write `profiles/<id>/retro_tailor_context.json` with per-row JD payloads. The SKILL session reads this context and drives the same Step 6.5 tailoring loop the regular `prepare` pipeline uses, in batches of 5 with operator confirmation between batches.
- **Commit (`--apply --results-file <path>`)**: read SKILL-produced results.json, generate tailored DOCX + PDF, update TSV `resume_ver`, update existing Notion page's `Resume Version` field via `pages.update`. Cover letter is **not** regenerated.

Prerequisite: run `node engine/cli.js sync --profile <id> --apply` first so the TSV reflects current Notion statuses (rows that moved to Applied/Rejected/Closed are excluded automatically).

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--profile <id>` | string | — | Required. |
| `--dry-run` | boolean | false | Recon-only mode without writing `retro_tailor_context.json`. Without `--apply`, recon already runs read-only mutations except for the context file; `--dry-run` suppresses that single write. |
| `--apply` | boolean | false | Switches to commit phase. Requires `--results-file`. |
| `--results-file <path>` | string | — | Required with `--apply`. SKILL-produced JSON with per-row tailor fields (`tailoredResume`, `tailorCoverage`, `tailorEscalated`, `tailorEscalationReason`, `tailorEscalationDetail`) plus `notionPageId`. |
| `--batch <n>` | int | 30 | Cap candidate count per recon. Token-budget control for large backlogs. |
| `--since <iso>` | string | — | Recon only. Skip candidates whose `updatedAt` (or `createdAt` fallback) is older than the given `YYYY-MM-DD`. |

Outputs and side effects:

- Recon: writes `profiles/<id>/retro_tailor_context.json` (overwritten per run). Prints scanned / strong-to-apply / already-tailored / candidates counts; JD-fetch ok/failed; deferred count when above `--batch`.
- Commit: per row — generates DOCX at `profiles/<id>/resumes/tailored/<CompanySlug>_<roleSlug>_<YYYYMMDD>.docx` plus PDF (canonical for TSV / Notion). Updates TSV `resume_ver` only AFTER the Notion update succeeds (rollback semantics: on Notion failure, files on disk stay but TSV stays pointing at the old archetype value).
- Escalated rows accumulate into `profiles/<id>/.tailor-state/retro-escalations-<unix-ts>.md` (separate filename prefix from regular prepare-commit escalations).

Example:

```bash
# Recon: see what would get re-tailored
node engine/cli.js retro-tailor --profile <id>

# Limit to rows updated in the last week, cap at 5 per run
node engine/cli.js retro-tailor --profile <id> --since 2026-05-19 --batch 5

# Commit (after the SKILL session writes results.json)
node engine/cli.js retro-tailor --profile <id> --apply --results-file ./results.json
```

Common errors:

- `error: --results-file <path> is required for --apply` — commit phase needs the SKILL output. Run recon first; the SKILL session reads `retro_tailor_context.json` and writes results to disk.
- `warn: <key> status is "Applied" — skipped. Did you sync since recon?` — TSV moved between recon and commit. Re-run `sync --apply`, then re-run recon to refresh the candidate set.
- `warn: <ID>_NOTION_TOKEN missing — Notion updates skipped` — `.env` is missing the per-profile Notion token. DOCX/PDF were generated on disk, but TSV `resume_ver` was not updated. Fix `.env` and re-run.

## Environment variables

Secrets are loaded by `engine/core/profile_loader.loadSecrets(profileId, env)`. Per-profile namespacing: each variable is prefixed by the uppercased profile id followed by `_`. Other profiles' secrets are never read by the running command.

| Variable | Required by | Notes |
| --- | --- | --- |
| `<ID>_NOTION_TOKEN` | `sync`, `prepare --phase commit`, `check --apply`, `answer`, the `scan → sync` hook | Internal Notion integration token. |
| `<ID>_USAJOBS_API_KEY` | USAJOBS adapter (when `discovery:usajobs` is enabled) | Free key from usajobs.gov. |
| `<ID>_USAJOBS_EMAIL` | USAJOBS adapter | Contact email registered with the API key. |
| `<ID>_GMAIL_USER` | `check --auto` | Gmail address the IMAP login should use. |
| `<ID>_GMAIL_APP_PASSWORD` | `check --auto` | Gmail app-password (16 chars, generated at <https://myaccount.google.com/apppasswords>). |

The supported `check` paths are `check --prepare` + `check --apply` (MCP-driven) and `check --auto` (single-process IMAP, when configured per RFC 021).

The CLI loads `.env` via `dotenv` only when invoked as a binary; tests inject `env` explicitly through `runCli({ env })`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | Generic error. Examples: missing required flag, profile load failure, adapter failure, retro-sweep matches without `--apply`, Notion mutation error. |
| 2 | Configuration / schema error. Reserved; today the CLI primarily uses 0 / 1. |

`--verbose` causes uncaught errors to print their stack trace alongside the message.

## See also

- [Architecture overview](../architecture/overview.md)
- [TSV schema](tsv-schema.md)
- [Notion schema](notion-schema.md)
- [Onboarding a new profile](../runbooks/new-profile.md)
- [Adding a discovery adapter](../runbooks/adding-adapter.md)
- [RFC 002 — `check` command](../../rfc/002-check-command.md)
- [RFC 014 — Status split (Inbox vs To Apply)](../../rfc/014-status-split-new-vs-toapply.md)
- [RFC 009 — `application-answers` command](../../rfc/009-application-answers-command.md)
