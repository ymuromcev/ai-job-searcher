# Architecture overview (C4 L3)

This is the component-level map of the engine. For the system-context and
container view, see [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md). For
data movement narratives, see [`data-flow.md`](data-flow.md).

The engine is a CLI plus a set of pure(-ish) modules. The CLI is the only
side-effectful entry point; modules under `engine/core/` and
`engine/modules/` operate on data passed to them and return plans or
artifacts. Profile data is loaded once per invocation through
`profile_loader`; nothing else reads `profiles/` directly.

## 1. Module map

### `engine/core/`

| Module | Responsibility | Consumed by |
|---|---|---|
| `profile_loader.js` | Single read point for `profiles/<id>/`. Validates id, loads `profile.json`, normalizes `filter_rules.json` (flat shape), reads namespaced secrets from `.env`. | every `engine/commands/*` |
| `paths.js` | Resolves canonical paths inside a profile root. | loader, commands, generators |
| `filter.js` | Title / company / location blocklist matcher. Case-insensitive substring; US-marker safeguard skips location blocklist when "United States" is asserted. | `commands/scan.js`, `commands/validate.js`, `email_filters.js` |
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

**`sync`**. Bidirectional reconcile between `applications.tsv` and the
per-profile Jobs Pipeline DB. Push side honors
`.stage16/push_manifest.json` when present (migration gating). Pull side
reads Notion-side status changes and updates TSV. Default dry-run;
`--apply` writes.

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

## 7. Open architectural questions

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
