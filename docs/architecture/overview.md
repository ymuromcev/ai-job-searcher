# Architecture overview (C4 L3)

This is the component-level map of the engine. For the system-context and
container view, see [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md). For
data movement narratives, see [`data-flow.md`](data-flow.md). For
behavioral contracts (per-command inputs, outputs, schemas), see
[`../reference/spec.md`](../reference/spec.md).

The engine is a CLI plus a set of pure(-ish) modules. The CLI is the only
side-effectful entry point; modules under `engine/core/` and
`engine/modules/` operate on data passed to them and return plans or
artifacts. Profile data is loaded once per invocation through
`profile_loader`; nothing else reads `profiles/` directly.

## 0. Mental model

> **Profile = data. Engine = service.**

Every piece of code in `engine/` must work for any profile. Every
piece of personal or preference data lives in `profiles/<id>/`. When
adding something to `engine/`, ask: *would this be correct for a
different candidate with different targeting, different resume
archetypes, different Notion schema?* If not, it belongs under
`profiles/<id>/` or in a per-profile config file.

Three invariants follow:

1. **No `profiles/` reads outside `profile_loader`.** The loader is the
   single read-point for `profile.json`, namespaced secrets, and
   normalized filter rules.
2. **TSV is the ledger.** `profiles/<id>/applications.tsv` is canonical
   per-profile state. Notion is a view on top, not a source of truth
   except for `status` and `notion_page_id`.
3. **Pure helpers, isolated side effects.** `core/*` and most of
   `scripts/stage18/*` are pure functions over in-memory objects. The
   filesystem, network, and `process.exit` live in `commands/*` and
   the CLI glue. Tests target the pure helpers; side-effect code is
   tested with faked Notion clients and mocked `fetchFn` from
   `modules/discovery/_http.js`.

## 1. Module map

### `engine/core/`

| Module | Responsibility | Consumed by |
|---|---|---|
| `profile_loader.js` | Single read point for `profiles/<id>/`. Validates id, loads `profile.json`, normalizes `filter_rules.json` (flat shape; synthesizes legacy `title_requirelist` from RFC 030 `role_targets.tracks[].patterns` when present), reads namespaced secrets from `.env`. | every `engine/commands/*` |
| `paths.js` | Resolves canonical paths inside a profile root. | loader, commands, generators |
| `filter.js` | Title (positive requirelist + negative blocklist) / company / location matcher. Case-insensitive substring with word boundaries; US-marker safeguard skips location blocklist when "United States" is asserted. Positive title gate is sourced from `role_targets` via the loader shim (RFC 030). | `commands/scan.js`, `commands/validate.js`, `email_filters.js` |
| `dedup.js` | Cross-profile dedup against `data/jobs.tsv` and per-profile `applications.tsv`. Keys on `(ats_source, job_id)`. | `commands/scan.js` |
| `validator.js` | URL liveness, company cap, TSV hygiene checks. Powers `validate`. | `commands/validate.js` |
| `applications_tsv.js` | v3 schema reader/writer (auto-upgrades v1 → v2 → v3 on read; always writes v3). `appendNew` defaults `status="Inbox"` (TSV-only staging, [RFC 014](../../rfc/014-status-split-new-vs-toapply.md)). | every command that touches TSV |
| `jobs_tsv.js` | Shared `data/jobs.tsv` reader/writer. | `commands/scan.js`, dedup |
| `companies.js` | `data/companies.tsv` reader/writer. | `commands/scan.js`, `company_resolver.js` |
| `company_resolver.js` | Lookup-or-create company in the per-profile Notion Companies DB; in-memory cache. | `commands/sync.js` (push) |
| `notion_sync.js` | Hybrid Notion client wrapper. Direct API for fast ops (`updatePageStatus`, `addPageComment`, `createJobPage`), batch queue for bulk push. SDK v5 compliant — uses `dataSources.query` and skips empty values. | `commands/sync.js`, `commands/check.js`, `commands/prepare.js` |
| `fit_prompt.js` | Assembles the per-profile fit-evaluation prompt. | `commands/prepare.js` |
| `jd_cache.js` | JD fetch + cache for Greenhouse and Lever (others fall back to live fetch). | `commands/prepare.js`, `jd_extract.js` |
| `jd_extract.js` | Pulls structured fields out of a JD (title, level hints, salary band). | `commands/prepare.js` |
| `url_check.js` | HEAD+GET probe with SSRF guard and board-root detection. | `validator.js`, `prepare.js` |
| `salary_calc.js` | Pure tier × level salary calculator with cost-of-living adjustment. | `commands/prepare.js` |
| `geo_enforcer.js` | Profile-geo policy (allowed states, remote-only, hybrid radius). | `commands/prepare.js`, `email_filters.js` |
| `classifier.js` | Rule-based email classifier. Returns one of `REJECTION / INTERVIEW_INVITE / INFO_REQUEST / ACKNOWLEDGMENT / OTHER`. | `commands/check.js` |
| `email_matcher.js` | Matches email → application via company tokens and role disambiguation. | `commands/check.js` |
| `email_parsers.js` | LinkedIn-alert and recruiter-subject parsers. | `commands/check.js` |
| `email_filters.js` | Level / location / TSV-dup / ATS-domain filters for inbound email. | `commands/check.js` |
| `email_state.js` | `processed_messages.json` and `check_context.json` persistence; 30-day prune. | `commands/check.js` |
| `email_logs.js` | Append-only writers for `rejection_log.md`, `recruiter_leads.md`, `email_check_log.md`. | `commands/check.js` |
| `qa_categorize.js`, `qa_dedup.js`, `qa_notion.js` | Application-answers categorization, dedup, and Notion bank sync. | `commands/answer.js` |
| `scan.js` | Orchestrates discovery adapters: enabled-set, parallel fetch, normalize, filter, dedup. | `commands/scan.js` |

## 2. CLI commands

The router lives at `engine/cli.js`. Every command takes `--profile <id>`.
Full flag reference: [`../reference/cli.md`](../reference/cli.md).

**`scan`**. Runs the profile's enabled discovery adapters, normalizes
records, applies filter rules, deduplicates against the shared and
per-profile pools, and appends fresh rows to `applications.tsv` with
`status="Inbox"` and an empty `notion_page_id`. No Notion writes.
`Inbox` is TSV-only — `prepare --phase commit` is what transitions
`Inbox → To Apply` (or `Inbox → Archived`).

**`validate`**. Pre-flight on the pipeline: URL liveness for active rows,
company-cap warning, TSV-schema sanity, and a retro blocklist sweep that
re-applies updated `filter_rules.json` to existing rows. Default reports
findings; `--apply` mutates TSV.

**`prepare`**. Two-phase. `--phase pre` picks fresh `Inbox` rows
(or `To Apply` rows still missing `notion_page_id`), runs URL check, fit scoring (via Claude),
salary calc, geo enforcement, JD-extract, and writes a `results.json`
plan. `--phase commit` reads the approved plan and executes: generates
resume + cover letter, creates Notion page (resolving the Company
relation through `company_resolver`), and writes back the artifact paths.

**`sync`**. One-way pull from the per-profile Notion Jobs Pipeline DB
into `applications.tsv`. Notion is the source of truth for `status`
and `notion_page_id`; TSV is reconciled to match. Push was removed in
commit `4f85ed2` (2026-05-04) — Notion pages are created exclusively
by `prepare --phase commit`, so creation is atomic with cover-letter
generation, fit scoring, and Company-relation resolution. Default
dry-run; `--apply` writes only the local TSV.

**`check`**. Two-phase Gmail flow driven by Claude MCP. `--prepare`
writes a Gmail-batch JSON to `profiles/<id>/.gmail-state/`; the operator
runs MCP searches and writes `raw_emails.json`; `--apply` (or dry-run
default) classifies, matches, and emits a status-update plan plus log
appends. Detail in [`data-flow.md`](data-flow.md) and
[ADR-003 MCP vs OAuth](adrs/003-mcp-vs-oauth.md).

**`answer`**. Stores and retrieves application Q&A pairs from a
Notion-backed answer bank, deduping on question hash and categorizing
by topic. (RFC 009 documented this command under the working name
`application-answers`; the dispatcher exposes it as `answer`.)

## 3. Discovery adapters

All adapters live in `engine/modules/discovery/` and self-register via
`index.js`. Each adapter exports a normalized job record (see
`_normalize.js` and `_types.js`). Profile config selects which adapters
run via the `modules: ["discovery:<name>", ...]` array.

| Adapter | Source |
|---|---|
| `greenhouse.js` | Greenhouse JSON board API per company slug. JD cache enabled. |
| `lever.js` | Lever public postings API. JD cache enabled. |
| `ashby.js` | Ashby public postings API. |
| `workday.js` | Workday tenant CXS endpoints (per-tenant slug list). |
| `oracle_cloud.js` | Oracle Recruiting Cloud / Fusion HCM Candidate Experience sites; multi-tenant via per-row `siteUrl`. SSRF-guarded to `*.oraclecloud.com` over HTTPS. |
| `jobsyn.js` | NLX Jobsyn (Direct Employers Foundation) public search API; multi-tenant via `X-Origin` header. Origin pattern-validated to prevent CRLF header injection. |
| `icims.js` | iCIMS-hosted job boards (HTML scrape); two extractor modes via per-row `htmlMode` — `icims-default` for `careers-{slug}.icims.com` and `talentbrew` for custom front-ends (e.g. CommonSpirit). SSRF-guarded to HTTPS + slug-validated. |
| `smartrecruiters.js` | SmartRecruiters posting API. |
| `usajobs.js` | USAJOBS Search API. Requires API key + email in `.env`. |
| `calcareers.js` | California state careers feed. |
| `remoteok.js` | RemoteOK JSON feed; feed-mode injection in `scan.js`. |
| `the_muse.js` | The Muse listings API. |
| `adzuna.js` | Adzuna aggregator. |
| `indeed.js` | Indeed scraper (rate-limited; ToS risk flagged in BACKLOG). |

Adding an adapter: see
[`../runbooks/adding-adapter.md`](../runbooks/adding-adapter.md).

## 4. Generators

`engine/modules/generators/` contains three artifact builders, all pure
functions of profile data + the chosen archetype:

- `resume_docx.js` — master DOCX from `resume_versions.json`. Uses the
  archetype block selected by `prepare`.
- `resume_pdf.js` — DOCX → PDF export for submission.
- `cover_letter_pdf.js` — Markdown template (`cover_letter_template.md`)
  plus per-archetype block from `cover_letter_versions.json` → PDF.

Application-answer generation lives outside `generators/` (in
`engine/commands/answer.js`) because the artifact is a Notion bank entry,
not a file on disk.

Per-profile customization: archetypes are declared in
`profiles/<id>/resume_versions.json` and
`profiles/<id>/cover_letter_versions.json`. The engine doesn't know
about specific archetypes; profiles do.

## 5. Notion sync — hybrid model

`notion_sync.js` uses two paths:

1. **Direct API** for hot operations: `createJobPage`,
   `updatePageStatus`, `addPageComment`, `companies.query`. Used by
   `prepare --phase commit`, `check --apply`, and `sync --apply`.
   Latency-sensitive; failures surface immediately to the operator.
2. **Queue** for bulk push during migration or first-time sync. Read by
   `sync` when a `push_manifest.json` is present (Stage 16 migration
   gate). Backoff with retry on rate-limit (3 req/s ceiling).

SDK v5 specifics (live in code comments and tests):

- Database queries use `dataSources.query(data_source_id, ...)` not the
  retired `databases.query`.
- Database creation uses
  `databases.create({initial_data_source: { properties }})`; the SDK
  silently drops top-level `properties`.
- Empty string values are skipped before the API call to avoid
  `"should be populated or null"` 400s.
- `pages.update` with `archived: true` is the only delete path the
  engine ever uses.

Decision rationale: [ADR-002 Notion as UI](adrs/002-notion-as-ui.md).

## 6. Companies-as-source-of-truth

Per [RFC 008](../../rfc/008-companies-as-notion-source-of-truth.md), the
per-profile Companies DB is the canonical record for company-level
metadata: tier, industry, careers URL, why-interested, remote policy.
The Jobs DB references it through a `Company` relation property; rollups
hoist `Industry` and tier fields. `data/companies.tsv` is a dedup pool
across profiles, not a source of truth — it carries ATS slugs and a
discovery timestamp, nothing operator-facing.

`company_resolver.js` is the only writer. On push, it looks up by exact
title in the profile's Companies DB; on miss, it creates a row with the
profile's tier defaults from `profile.json.company_tiers`.

## 7. Cross-module flows and design rationale

A few module boundaries deserve explicit narrative because the reasons
for them are not obvious from the call graph.

### Why `prepare` owns Notion-page creation

Until 2026-05-04 `sync` ran a `--push` phase that created and updated
Notion pages from the TSV, gated by `.stage16/push_manifest.json`. That
duplicated the property-mapping logic already living in `prepare`'s
commit phase, created two write surfaces against the same DB, and left
dead-code paths (the Inbox-callout updater always reported zero after
Stage 8). Push was removed wholesale and `prepare --phase commit` is
now the only writer:

- Resume + cover letter generation, fit scoring, and Notion-page
  creation happen together in one transaction-like block.
- The Company relation is resolved via `company_resolver.js` in the
  same step (lookup-or-create in the per-profile Companies DB).
- `sync` shrinks to pull-only; the only fields it overrides on TSV
  are `status` and `notion_page_id`. Everything else stays TSV-local.

Operator deletion of a Notion page is **not** mirrored back to TSV. To
remove a row from the pipeline, set `Archived` in Notion (pull picks
it up) or delete the row from `applications.tsv` directly.

### Why `Inbox` is TSV-only

The Notion DB has eight statuses; the TSV has nine. The extra status
is `Inbox`, used as the default for fresh `scan` rows that have not
been triaged yet. Notion never sees `Inbox`. The transition `Inbox →
To Apply` and the matching Notion page creation happen atomically in
`prepare --phase commit decision=to_apply`, so a row is either
`Inbox` (no Notion page) or `To Apply` (with a `notion_page_id`) —
no race window. Source: [RFC 014](../../rfc/014-status-split-new-vs-toapply.md).

### Why `check` is two-phase

Gmail reads happen inside Claude via the Gmail MCP, not via a heavy
SDK. Phase 1 (`check --prepare`) writes a JSON batch plan based on
the active jobs map and the cursor epoch; the operator's Claude
session executes the searches and writes `raw_emails.json`; Phase 3
(`check --apply` or default dry-run) parses, classifies, matches
against active TSV rows, and emits a status-update plan. Decision
rationale: [ADR-003 — MCP vs OAuth](adrs/003-mcp-vs-oauth.md) and
[RFC 002](../../rfc/002-check-command.md). The single-process
`--auto` variant exists for cron / fly.io use; it bypasses MCP and
fetches via IMAP with an app-password (see [RFC 021](../../rfc/021-gmail-cron-imap.md)).

### Why secrets are in one root `.env`, not per-profile

Per-profile namespacing (`<ID_UPPER>_NOTION_TOKEN`, etc.) lets a
single `.env` serve every profile. `loadSecrets(profileId, env)`
returns prefix-stripped keys, so engine code never sees another
profile's keys. Putting keys in per-profile files would have meant
N copies of GitHub-secrets policy and N pre-commit-hook entries to
audit; one file with a strict prefix discipline scales to many
profiles without that overhead.

### Why English code in a bilingual repo

The author works bilingually; user-facing skill prose (and some RFC
narrative) is optimized for the actual operator, not future grep.
Code, comments, and variable names stay English so a contributor or
reviewer reading cold has the path of least surprise. RFCs may mix
languages.

## 8. Sharp edges

Things that look weird but are intentional:

- **`scripts/stage18/_common.js` inlines its helpers** instead of
  importing from a `stage16/` peer. `stage16/` was a one-off migration
  tool excluded from the public release; `stage18/` is self-contained
  on purpose.
- **Two tests in `scripts/stage18/build_hub_layout.test.js` are
  currently red** against the shipped implementation. Known
  test/impl drift, tracked for cleanup. CI runs them anyway as a
  known-failure signal.
- **Salary calc uses a simple state-level COL multiplier** for
  US locations and falls back to `1.0` for non-US. International
  expansion would extend `salary_calc.js` first.
- **`engine/core/dedup.js` ships `normalizeCompanyName`** but the
  fuzzy key it builds is currently used by `applications_tsv.appendNew`
  only — `dedupeJobs` / `dedupeAgainst` are primary-key-only. The
  fuzzy path was added after a GH→Lever migration leaked duplicates.

## 9. Open architectural questions

These RFCs are draft and influence the next round of structural changes:

- [RFC 011 — Keyword search adapter](../../rfc/011-keyword-search-adapter.md):
  generic keyword-driven adapter for sources without per-company slugs.
- [RFC 012 — Relational data model](../../rfc/012-relational-data-model.md):
  proposes moving from TSV plus Notion to a SQLite-backed local store
  with Notion as a view. Affects every module under `core/`.
- [RFC 015 — Fit pre-rank](../../rfc/015-fit-prerank.md): bulk fit
  scoring before operator triage; reorders `prepare` queue.
- [RFC 016 — Unified JD cache](../../rfc/016-unified-jd-cache.md):
  consolidates `jd_cache.js` per-source caches into one schema.

The acceptance status of each is tracked in
[`../../rfc/README.md`](../../rfc/README.md).
