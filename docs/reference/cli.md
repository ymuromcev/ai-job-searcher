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

The dispatcher also runs deterministic post-command hooks. Today the only hook is `scan → sync`: a successful `scan` automatically chains a `sync --apply` (suppressed by `--no-sync` or `--dry-run`).

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

Runs every discovery adapter declared in `profile.modules` (entries shaped as `discovery:<name>`). Reads the shared companies pool (`data/companies.tsv`), filters per-profile visibility (`profile` column), then per-profile whitelist/blacklist, runs each adapter, dedups against `data/jobs.tsv`, and applies `filter_rules` + `company_cap`. Fresh accepted jobs are appended to `data/jobs.tsv` and to `profiles/<id>/applications.tsv` with `status: Inbox` (TSV-only staging — `prepare --phase commit` later transitions `Inbox → To Apply` or `Inbox → Archived`; see [RFC 014](../../rfc/014-status-split-new-vs-toapply.md)). Filter rejections are also appended to applications.tsv as `status: Archived` so the per-profile audit is complete; reasons go to `filter_rejections.log` (jsonl).

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--profile <id>` | string | — | Required. |
| `--dry-run` | boolean | false | Skip TSV writes; report counts only. Suppresses the auto-sync hook. |
| `--no-sync` | boolean | false | Skip the post-scan auto-sync hook. |
| `--verbose` | boolean | false | Adapter-level warn lines + secret-redactor count. |

Outputs and side effects:

- Appends to `data/jobs.tsv` (shared pool).
- Appends to `profiles/<id>/applications.tsv` (`status: Inbox` for passed rows, `Archived` for filter-rejected).
- Appends to `profiles/<id>/filter_rejections.log` (one JSON object per line).
- On success, automatically runs `sync --apply` unless `--dry-run` or `--no-sync`.

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

Synopsis: `node engine/cli.js validate --profile <id> [--dry-run] [--apply]`

Pre-flight pipeline checks. Default mode is dry-run; `--apply` is required to commit retro-sweep archives. Steps:

1. Load `applications.tsv` (and `data/jobs.tsv`); fail on parse errors.
2. `company_cap`: count active applications per company against `filter_rules.company_cap.max_active` (with overrides). Active statuses default to `Applied / To Apply / Interview / Offer`.
3. `url_liveness`: HEAD-ping each active row's `url` with bounded concurrency. SSRF-hardened: requires http(s), rejects loopback / link-local / private IPv4 and IPv6, no redirect follow, no GET fallback.
4. `retro_sweep`: re-apply `company_blocklist`, `title_blocklist`, `location_blocklist`, and `geo` policy to rows in `Inbox` or `To Apply`. Reports matches by default; with `--apply`, sets `status: Archived` and writes `updatedAt`.

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--profile <id>` | string | — | Required. |
| `--dry-run` | boolean | true (implicit) | Default mode. URL liveness is skipped under dry-run; retro-sweep matches are reported only. |
| `--apply` | boolean | false | Run URL liveness against the network and commit retro-sweep archival. |

Outputs and side effects:

- With `--apply`: rewrites `profiles/<id>/applications.tsv` for any row archived by retro-sweep.

Example:

```bash
node engine/cli.js validate --profile <id> --apply
```

Common errors:

- `error: profile not loaded` — `profiles/<id>/profile.json` missing or malformed.
- `company_cap: <n> violation(s)` — caps exceeded; tune `filter_rules.company_cap` or archive duplicates.
- `url_liveness: <n> URL(s) blocked by SSRF guard` — adapter emitted a private-network URL; report bug against the adapter.
- Exit 1 when any issue is reported and `--apply` was not passed.

### prepare

Synopsis: `node engine/cli.js prepare --profile <id> --phase <pre|commit> [--mode <fresh|topup>] [--batch <n>] [--need <k>] [--results-file <path>] [--dry-run]`

Two-phase fresh-row triage. `--phase pre` enriches every fresh row (status `Inbox` or `To Apply` without `notion_page_id`) with URL-liveness, JD fetch, salary calc, and writes `prepare_context.json` for the `job-pipeline` skill to consume. `--phase commit` reads a SKILL-produced results file and applies decisions: `to_apply` flips status to `To Apply`, generates the cover letter, picks resume archetype, pushes the Notion page, and back-fills `notion_page_id` / `salaryMin` / `salaryMax` / `clPath`. `archive` flips status to `Archived`. `skip` is a no-op.

`--phase pre` runs in one of two modes (BL-9 Step 4):

- `--mode fresh` (default) — runs the full filter / URL / JD / salary pipeline, persists the unconsumed (still-eligible) tail as `deferredQueue[]` keys on the context, and rewrites `prepare_context.json`.
- `--mode topup` — reads the existing `prepare_context.json`, pulls the next `--need K` keys from `deferredQueue`, re-validates them against the current TSV (drops committed / Weak / duplicate rows), URL-checks + JD-fetches, and **appends** new entries to `batch[]`. Use this after a SKILL run where Strong + Medium fell below `batchSize` so the next operator turn picks up where the last one left off without a fresh scan. Default `--need` is `batchSize - currentBatch.length` (the deficit). Errors out if `prepare_context.json` is missing.

Flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--profile <id>` | string | — | Required. |
| `--phase <pre\|commit>` | string | — | Required. Anything else exits 1. |
| `--mode <fresh\|topup>` | string | `fresh` | Used by `--phase pre`. `topup` appends to an existing context instead of rewriting it. |
| `--batch <n>` | int | 30 | Used by `--phase pre --mode fresh`. Target alive rows after URL-check. The pre phase keeps pulling from the filter-passed pool until `--batch` rows are alive or the pool is exhausted. |
| `--need <k>` | int | deficit | Used by `--phase pre --mode topup`. Number of new alive entries to append. Default fills the deficit (`batchSize - len(currentBatch)`). |
| `--results-file <path>` | string | — | Required for `--phase commit`. JSON produced by the SKILL. |
| `--dry-run` | boolean | false | `pre`: skip writing `prepare_context.json`. `commit`: skip TSV write. |

Outputs and side effects:

- `--phase pre` writes `profiles/<id>/.skill-state/prepare_context.json` (alive rows + JDs + salary plan + filter context).
- `--phase commit` rewrites `profiles/<id>/applications.tsv`. May also write generated cover-letter / resume artifacts under `profiles/<id>/cover_letters/` and `resumes/`, and create Notion pages.

Example:

```bash
node engine/cli.js prepare --profile <id> --phase pre --batch 20
# After SKILL run: 12 strong + medium, 8 short. Top up:
node engine/cli.js prepare --profile <id> --phase pre --mode topup --need 8
node engine/cli.js prepare --profile <id> --phase commit --results-file profiles/<id>/.skill-state/results.json
```

Common errors:

- `error: --phase <pre|commit> is required` — missing or invalid `--phase`.
- `--phase commit requires --results-file <path>`.
- `results file invalid` — schema-validation failure against the SKILL contract (per-row `key`, `decision`, optional `archetype` / `clPath` / `salaryMin` / `salaryMax`).

### sync

Synopsis: `node engine/cli.js sync --profile <id> [--dry-run] [--apply] [--no-callout]`

One-way pull from the per-profile Notion Jobs Pipeline DB into `applications.tsv`. Notion is source of truth for `status` and `notion_page_id`; both are reconciled by row `key` (or composite `source:jobId` when present). Push is intentionally absent — rows reach Notion only through `prepare`.

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
| `--auto` | boolean | false | Single-process autonomous flow using OAuth Gmail. Requires `<ID>_GMAIL_CLIENT_ID`, `<ID>_GMAIL_CLIENT_SECRET`, and a refresh token from `scripts/gmail_auth.js`. |
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
- `gmail credentials missing for --auto` — namespaced env vars or refresh token absent.
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

## Environment variables

Secrets are loaded by `engine/core/profile_loader.loadSecrets(profileId, env)`. Per-profile namespacing: each variable is prefixed by the uppercased profile id followed by `_`. Other profiles' secrets are never read by the running command.

| Variable | Required by | Notes |
| --- | --- | --- |
| `<ID>_NOTION_TOKEN` | `sync`, `prepare --phase commit`, `check --apply`, `answer`, the `scan → sync` hook | Internal Notion integration token. |
| `<ID>_USAJOBS_API_KEY` | USAJOBS adapter (when `discovery:usajobs` is enabled) | Free key from usajobs.gov. |
| `<ID>_USAJOBS_EMAIL` | USAJOBS adapter | Contact email registered with the API key. |
| `<ID>_GMAIL_CLIENT_ID` | `check --auto` | OAuth client id; obtained via `scripts/gmail_auth.js`. |
| `<ID>_GMAIL_CLIENT_SECRET` | `check --auto` | OAuth client secret. |

A scheduled (cron / OAuth) variant of `check` is tracked in the backlog and is not part of the supported surface today; the supported paths are `check --prepare` + `check --apply` (MCP-driven) and `check --auto` (single-process OAuth, when configured).

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
