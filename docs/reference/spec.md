---
title: "Engine behavioral spec"
status: stable
type: reference
tags: [reference, spec, contracts]
---

# Engine behavioral spec

Behavioral contracts for `ai-job-searcher`: per-command inputs, outputs,
side effects, exit codes, and the configuration / state schemas they
read and write. Reference-genre per Diátaxis — facts only, no narrative.

For prose:

- Architecture and module map → [`../architecture/overview.md`](../architecture/overview.md).
- Cross-pipeline data movement → [`../architecture/data-flow.md`](../architecture/data-flow.md).
- CLI flags and exit codes → [`cli.md`](cli.md).
- TSV columns → [`tsv-schema.md`](tsv-schema.md).
- Notion property gating and serialization → [`notion-schema.md`](notion-schema.md).

When this page disagrees with the code, the code wins. Reproducible
failing test is the fastest path to a fix.

## Cross-cutting contracts

### Status set

The Jobs Pipeline DB in Notion uses exactly eight statuses. The
per-profile TSV uses those eight plus one TSV-only staging status,
`Inbox`, for fresh-after-scan rows. Names match byte-for-byte
(case-sensitive) between Notion and code.

```
Notion (8): To Apply / Applied / Interview / Offer / Rejected / Closed / No Response / Archived
TSV (9):    Inbox + the eight above
```

`Inbox` rows by definition have `notion_page_id == ""` and are never
replicated to Notion. `prepare --phase commit decision=to_apply`
transitions `Inbox → To Apply` and creates the Notion page in the same
step. Source: [RFC 014](../../rfc/014-status-split-new-vs-toapply.md).

Canonical roles in code:

| Role | Members | Used by |
|---|---|---|
| `ACTIVE_STATUSES` | `To Apply`, `Applied`, `Interview`, `Offer` | `commands/check.js`, `commands/validate.js` cap check |
| `SKIP_STATUSES` | `Inbox`, `Rejected`, `Closed`, `Archived`, `No Response` | `commands/check.js` |
| `RETRO_SWEEP_STATUSES` | `Inbox`, `To Apply` | `commands/validate.js` |
| `CAP_ACTIVE_STATUSES` | `To Apply`, `Applied`, `Interview`, `Offer` | `commands/prepare.js` |
| Default for new TSV row from `scan` | `Inbox` | `core/applications_tsv.js:appendNew` |
| Default for new row from `check` (LinkedIn / recruiter) | `Inbox` | `commands/check.js` |

### Filter rules — canonical flat shape

`profile_loader.normalizeFilterRules()` is the only consumer of the
on-disk shape. Every downstream module sees flat:

```jsonc
{
  "company_blocklist": [ "Acme", "Globex", ... ],
  "title_blocklist":   [ { "pattern": "VP", "reason": "..." }, ... ],
  "title_requirelist": [ { "pattern": "...", "reason": "..." }, ... ],
  "location_blocklist":[ "India", "London", "EMEA", ... ],
  "company_cap":       { "max_active": 3, "active_statuses": [...], "overrides": { ... } },
  "domain_weak_fit":   [ ... ],
  "early_startup_modifier": [ ... ],
  "priority_order":    [ ... ]
}
```

The on-disk file (`profiles/<id>/filter_rules.json`) may be **flat** or
**nested** (legacy prototype shape). Both are accepted by the
normalizer. Consumers (`filter.js`, `prepare.js`, `email_filters.js`,
`validate.js`) only see flat.

### Filter semantics

| Layer | Rule | Comparison |
|---|---|---|
| Title blocklist | Block if any pattern matches a slash-split part of title | Word-boundary regex (`\b...\b`), case-insensitive. Slash-titles (`"PM / Sr PM"`) pass if any one part survives. Comma is a suffix, not a split point. |
| Title requirelist | Pass only if at least one pattern matches | Same regex shape as blocklist. Applied **before** blocklists. Currently enforced inside `prepare` only; some adapters also do an inline regex pre-filter. |
| Company blocklist | Exact lowercase equality on company name | Substring is intentionally **not** used — `"Stripe"` blocker does not block `"Stripe Identity"`. |
| Location blocklist | Substring match, case-insensitive, with a US-marker safeguard | Skipped entirely when the location string contains `"united states"`, `"usa"`, `", us"`, `"(us)"`, or `"u.s."`. Word-boundary is **not** used (short codes like `UK` need substring). |
| Company cap | `count(active_statuses for company) >= max_active` blocks | `validate` reports `>` (already over); `prepare` blocks `>=` (would push over). `Inbox` is excluded — pre-triage rows do not consume cap. |

### Dedup keys

| Key | Format | Where used |
|---|---|---|
| Primary | `"<source_lowercase>:<jobId_trimmed>"` | Every adapter, `data/jobs.tsv`, `applications.tsv`, in-batch dedup. |
| Fuzzy (cross-platform) | `"<normalizeCompany(name)>::<normalizeTitle(title)>"` | `applications_tsv.appendNew` to catch GH-↔-Lever migrations. `normalizeCompany` lowercases, strips ASCII punctuation, collapses whitespace, strips trailing `Inc`/`LLC`/`Ltd`/`Corp`/`Co`. |

`scan` uses primary in-batch (`dedupeJobs`) and primary cross-run
(`dedupeAgainst data/jobs.tsv`). `applications_tsv.appendNew` uses
primary plus fuzzy, returning `fuzzyDuplicates[]` for the summary
counter.

### `profile.json` schema

Per-profile config at `profiles/<id>/profile.json`. Top-level keys:

```jsonc
{
  "id": "<lowercase-id>",
  "identity": { "name", "email", "phone", "location", "linkedin", "website" },
  "discovery": {
    "keywords": [...], "locations": [...], "results": N,
    "companies_whitelist": [...], "companies_blacklist": [...]
  },
  "modules": [ "discovery:greenhouse", "discovery:lever", ..., "tracking:gmail" ],
  "filter_rules_file": "filter_rules.json",
  "company_tiers": { "S": [...], "A": [...], "B": [...], "C": [...] },
  "company_aliases": { ... },                  // optional
  "resume": { "versions_file": "resume_versions.json", "templates_dir": "..." },
  "cover_letter": { "versions_file": "cover_letter_versions.json", "template": "..." },
  "notion": {
    "jobs_db_id": "...", "companies_db_id": "...",
    "application_qa_db_id": "...", "job_platforms_db_id": "...",
    "workspace_page_id": "...",
    "property_map": { ... }                    // optional, overrides defaults
  },
  "hub": { "subpages": { "candidate_profile": "...", "workflow": "...", ... } },
  "preferences": { "salary_target_tier": "...", "format": "...", ... },
  "flavor": "pm" | "healthcare",               // hub-layout flavor
  "geo": { "countries": [...], "states": [...], "radius_miles": N }   // RFC 013, planned
}
```

Profile id is validated against `^[a-z][a-z0-9_]{1,31}$` and cannot be
a reserved name. Path traversal is blocked: the resolved profile root
must live strictly inside the configured profiles dir. Source:
[ADR-005 — profile id convention](../architecture/adrs/005-profile-id-convention.md).

### `applications.tsv` and shared pools

For column-by-column types and v1→v2→v3 upgrade rules, see
[`tsv-schema.md`](tsv-schema.md). Summary:

- `profiles/<id>/applications.tsv` — per-profile, 16 columns, append-only
  by row, mutable by status. Default for new rows from `scan` is
  `status="Inbox"`, `notion_page_id=""`.
- `data/jobs.tsv` — shared master pool across profiles. Append-only.
  `(source, jobId)` dedup. No PII.
- `data/companies.tsv` — shared ATS-target list with `extra_json` for
  per-target Workday geo (`appliedFacets`, `locationAllow`) and a
  `profile` column that is either an id or a comma list.

`location` lives in column 7 of `applications.tsv` (Stage G-5 / Schema
v3). Auto-upgrade reads v1 / v2 transparently; save always writes v3.
Push to Notion `Location` is **gated** by
`profile.notion.property_map.location` (default off, opt-in).

### Env-var namespacing

All secrets in a single root `.env` (gitignored). One namespace per
profile id, prefix = `<id_uppercased_with_underscores>_`. Loader
(`profile_loader.loadSecrets`) returns the keys with the prefix
**stripped**, so engine code only ever sees `NOTION_TOKEN`,
`GMAIL_APP_PASSWORD`, etc. Per-profile prefix isolation prevents one
profile's run from reading another profile's keys.

Canonical keys (post-prefix):

| Key | Required by |
|---|---|
| `NOTION_TOKEN` | `sync`, `prepare --phase commit`, `check --apply`, `answer`, `scan→sync` hook |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | `check --auto` (IMAP, RFC 021) |
| `USAJOBS_API_KEY`, `_EMAIL` | `discovery:usajobs` adapter |
| `ADZUNA_APP_ID`, `_KEY` | `discovery:adzuna` adapter |

Source: [ADR-005 — profile id convention](../architecture/adrs/005-profile-id-convention.md), [ADR-001 — multi-profile architecture](../architecture/adrs/001-multi-profile.md).

### Geo enforcement

Current state (until [RFC 013](../../rfc/013-profile-geo-enforcement.md) lands):
geo is **per-adapter, ad-hoc**. Workday is the only adapter that
enforces server-side and post-fetch geo, configured per target via
`data/companies.tsv:extra_json`:

```jsonc
{
  "appliedFacets":  { "locationCountry": ["<wd-country-uuid>"] },
  "locationAllow":  ["United States", "Remote", "California", ...]
}
```

`locationAllow` semantics: case-insensitive substring match against the
job's `locationsText`; multi-location placeholders like `"3 Locations"`
are dropped (cannot be checked). Other adapters fall back on
profile-level `location_blocklist`. `profile.json.geo` is the planned
canonical field; not yet read by any adapter.

### Auto-sync hook

Deterministic post-command hook in the dispatcher: a successful `scan`
(exit 0, not dry-run) triggers `sync --apply` for the same profile.
`--no-sync` disables. `--dry-run` skips. Sync failure in auto mode is
**non-fatal** — warning to stderr, scan exit code unchanged. Source:
`engine/cli.js` `PIPELINE_HOOKS`.

### `flavor: "pm" | "healthcare"`

Profile-level field that selects the prose template for hub subpages
(Workflow, Triggers, callouts) only. **Does not** affect DB schema,
data flow, status mapping, or any code path outside
`scripts/stage18/build_hub_layout.js`. Default is `pm`. The
`healthcare` variant ships a manual-first short workflow without the
Interview Coach skill reference; healthcare admin interviews differ
enough from PM-style coaching that the operator-facing prose has to
diverge. Code paths are shared.

### Determinism

Pipeline commands (`scan`, `prepare`, `validate`, `sync`, `check`) are
deterministic given the same disk / Notion / Gmail state and the same
flags. They do not prompt the operator mid-run. Knobs are flags
(`--batch`, `--since`, `--apply`) or config
(`profile.json.preferences`, `filter_rules.company_cap`). The
job-pipeline skill prose is allowed to ask the operator before
committing, but the CLI contract itself never reads stdin.

## `scan`

Discovery: run enabled adapters, normalize, filter, dedup, append.
**No Notion writes.** For flag table see [`cli.md` § scan](cli.md#scan).

### Orchestration

- All enabled adapters run in **parallel** via `Promise.allSettled`.
  One failed adapter yields `{ jobs: [], error }` and does not block
  the others. Errors land in `summary.errors`.
- An adapter is enabled if `profile.json.modules` contains
  `"discovery:<adapter.source>"`. Registration is via
  `engine/modules/discovery/index.js` auto-load.

### Target list resolution

Two-stage filter on `data/companies.tsv`:

1. Profile visibility: row is visible to profile `<id>` if
   `row.profile === "<id>"` or `row.profile.split(",").includes("<id>")`.
2. Per-profile whitelist / blacklist from `profile.discovery`
   (`companies_whitelist` allowlist; `companies_blacklist` denylist).
   If whitelist is non-empty, only whitelist entries pass.

For feed adapters (RemoteOK, Adzuna, the_muse) a synthetic target
`{ feedMode: true, ...profile.discovery }` is injected so the adapter
sees `targets[0]`. For keyword adapters (Adzuna, the_muse, USAJOBS)
the adapter reads keywords / locations / results from the target.

### Adapter contract

```jsonc
// module exports
{
  "source": "<lowercase-string-unique>",
  "discover": "async (targets, ctx) => NormalizedJob[]"
}
```

`ctx` provides shared utilities: `{ profile, secrets, logger,
filterRules, jdCache, urlCheck, fetchFn, ... }`. `secrets` keys are
prefix-stripped (see env-var namespacing).

`NormalizedJob` shape:

```jsonc
{
  "source": "greenhouse",
  "jobId": "7666190003",
  "companyName": "...",
  "title": "...",
  "url": "...",
  "location": "Remote (US)",        // optional
  "team": "Risk",                   // optional
  "postedAt": "2026-04-15",         // optional
  "rawExtra": { /* opaque, written to data/jobs.tsv:rawExtra */ }
}
```

Adapters do not run filter / dedup / TSV operations — that is core's
job. Adapters **may** early-drop on strong domain signals (Workday
`locationAllow`, RemoteOK PM regex) when post-fetch retry is wasteful.

### Per-adapter contracts

| Adapter | Endpoint | Auth | JobId shape |
|---|---|---|---|
| `greenhouse` | `boards-api.greenhouse.io/v1/boards/<slug>/jobs` | none | numeric |
| `lever` | `api.lever.co/v0/postings/<slug>?mode=json` | none | UUID |
| `ashby` | `api.ashbyhq.com/posting-api/job-board/<slug>?includeCompensation=true` | none | UUID |
| `smartrecruiters` | `api.smartrecruiters.com/v1/companies/<slug>/postings` | none | numeric |
| `workday` | `<tenant>/wday/cxs/<tenant>/<site>/jobs` (POST) | none for most tenants | `R\d{5,}` / `JR\d{5,}` |
| `calcareers` | `jobs.ca.gov/CalHrPublic/Jobs/JobPosting.aspx` (form-post) | none | `<JobControlId>` |
| `usajobs` | `data.usajobs.gov` REST | `USAJOBS_API_KEY` + `_EMAIL` | `<PositionID>` |
| `remoteok` | `https://remoteok.com/api` | none, feed | slug |
| `adzuna` | Adzuna jobs API | `ADZUNA_APP_ID` + `_KEY` | numeric |
| `the_muse` | The Muse public API | none | numeric |
| `indeed` | Browser-ingest via MCP, normalized from `raw_indeed.json` | n/a | jobKey |

USAJOBS is opt-in: the adapter ships and tests pass, but activation
needs operator action (register on usajobs.gov, add the two env vars,
add `"discovery:usajobs"` to `modules`). The Indeed adapter is two-phase
MCP-driven; see [`cli.md` § indeed-prep](cli.md#indeed-prep).

### Dedup, append, summary

1. **In-batch dedup** (`dedupeJobs`) — Map by primary key, first
   occurrence wins.
2. **Cross-run dedup** (`dedupeAgainst data/jobs.tsv`) — set difference.
   Survivors are `fresh[]`.
3. **Append to applications.tsv** (`appendNew`) — primary + fuzzy
   dedup against existing rows. New rows get `status="Inbox"`,
   `notion_page_id=""`, empty material columns, `createdAt = updatedAt = now`.
4. **Summary** — per-source counters (jobs, errors,
   `droppedByLocation` for Workday) plus totals
   (`discovered`, `filtered`, `fresh`, `blocked_company`,
   `blocked_title`, `blocked_location`, `capped`,
   `cross_platform_dedup`).

`--dry-run` skips both TSV writes and the auto-sync hook. `--apply`
is a no-op for `scan` (always commits unless `--dry-run`).

## `prepare`

Two-phase fresh-row triage. For flag table see
[`cli.md` § prepare](cli.md#prepare).

```
phase pre   → CLI, no LLM       → writes prepare_context.json
phase skill → Claude (skill)    → writes results.json (decisions, CL, archetype)
phase commit → CLI, no LLM      → mutates applications.tsv, generates artifacts, creates Notion page
```

### Fresh-row gate (P-1)

A row is "fresh" if `status === "Inbox"` (RFC 014 canonical) or
`status === "To Apply" && notion_page_id === ""` (back-compat for
pre-RFC014 rows). After `commit decision=to_apply` the row carries
`status="To Apply"` plus a non-empty `notion_page_id`, and never
re-enters `--phase pre`.

### Filter order in `--phase pre`

1. `company_blocklist` (CC-3 lowercase equality)
2. `title_requirelist` (positive gate; slash-split, word-boundary)
3. `title_blocklist` (slash-split, word-boundary)
4. `company_cap` (active count `>= max_active` blocks; per-company `overrides`)
5. URL liveness (HEAD + GET fallback, SSRF guard)

Skipped rows carry `reason ∈ {"company_blocklist", "title_requirelist",
"title_blocklist", "company_cap", "url_dead"}` plus reason-specific
extras. Sources with no real URL (`linkedin`, `indeed`, `custom`) skip
URL check via `SKIP_URL_CHECK_SOURCES` — they pass with `{alive: true,
skipped: true}`.

### JD fetch + cache (P-4)

Greenhouse and Lever JDs are fetched through their JSON endpoints and
cached on disk at `profiles/<id>/jd_cache/<slug>_<jobId>.json`. Each
batch entry gets `jdStatus ∈ {"cached", "fetched", "miss",
"not_fetched", "skipped_dead_url"}` plus `jdText` when present. Other
ATSes fall back to live WebFetch in the skill.

### Salary calculator (P-5)

Pure function. Returns
`{tier, level, min, max, mid, expectation}` or `null`.

- `tier ∈ {S,A,B,C}` from `profile.json.company_tiers`. Unknown
  company → `null` → ends up in `unknownTierCompanies` so the skill
  can auto-tier before commit.
- `level` from `parseLevel(title)` regex: `"PM" | "Senior" | "Lead"`.
- COL multiplier: `+7.5%` when `workFormat ∈ {Hybrid, Onsite}` and
  the city matches `san francisco | new york | nyc`.

### `prepare_context.json` schema (P-6)

Phase 1 → Phase 2 contract.

```json
{
  "version": 1,
  "profileId": "<id>",
  "generatedAt": "<ISO>",
  "batchSize": 30,
  "batch": [
    {
      "key": "<source>:<jobId>",
      "source": "...", "jobId": "...", "companyName": "...",
      "title": "...", "url": "...",
      "urlAlive": true,
      "urlStatus": 200,
      "urlBoardRoot": false,
      "jdStatus": "cached",
      "jdText": "...",
      "salary": { "tier":"A","level":"Senior","min":...,"max":...,"mid":...,"expectation":"..." }
    }
  ],
  "skipped": [
    { "key": "...", "reason": "company_cap", "current": 3, "cap": 3, ... }
  ],
  "stats": {
    "inboxTotal": 142, "afterFilter": 68, "inBatch": 30,
    "urlAlive": 27, "urlDead": 3, "deferred": 38,
    "skipReasons": { "company_cap": 41, "title_blocklist": 12, "url_dead": 3 }
  },
  "unknownTierCompanies": [ "..." ]
}
```

The reader contract: when `version` is absent, treat as `1`.
Schema-breaking changes must bump the major version and explicitly
break old readers.

### Skill phase (P-7)

After `--phase pre` the job-pipeline skill takes the context and runs
nine steps; for the prose flow see
[`../../skills/job-pipeline/SKILL.md`](../../skills/job-pipeline/SKILL.md).
Behavioral outputs the commit phase relies on:

- `decision ∈ {"to_apply", "archive", "skip"}`. Anything else is
  treated as `skip` and counted in `updates.invalidDecision`.
- `archetype` (a.k.a. `resumeVer`) — must be a key in
  `profile.resume_versions.versions`. Unknown values are rejected,
  counted in `updates.invalidArchetype`, and downgraded to `skip`.
- `clBaseKey` — id of the cover-letter template variant chosen
  (template-first flow). Recorded for audit.
- `companyTiers` — map of newly-tiered companies. Persisted to
  `profile.json.company_tiers` by the commit phase (one-shot per
  company).
- Step 9.0 skip-guard: if a row already carries `notion_page_id`,
  the skill records the existing id and skips creation. Operator-
  reruns are idempotent.

### Commit phase (P-8)

Mutations are by `key`:

| `decision` | TSV mutation |
|---|---|
| `to_apply` | `status="To Apply"`, set `cl_key`, `cl_path`, `resume_ver`, `notion_page_id`, `salary_min`, `salary_max`, `updatedAt=now`. |
| `archive` | `status="Archived"`, `updatedAt=now`. |
| `skip` (or unknown) | no mutation. |

`--dry-run` skips TSV write. `--results-file` is required.

## `sync`

One-way pull from Notion into TSV. **Default = dry-run**; `--apply`
mutates only the local TSV. Push was removed in commit `4f85ed2`
(2026-05-04); Notion pages are created exclusively by `prepare --phase
commit`. For flag table see [`cli.md` § sync](cli.md#sync).

### Pull semantics

- Read all pages from the per-profile Jobs Pipeline DB.
- Match on `key` (preferred) or composite (`source` + `jobId`).
- Notion wins on:
  - `status` — Notion → TSV override.
  - `notion_page_id` — Notion id wins (defends against lost-id
    incidents).
- No other fields pull. `fit_score`, notes, etc. stay TSV-local.
- Pull always runs (read-only); only TSV write is gated by `--apply`.

### Property mapping

Read-only Notion → TSV mapper in `reconcilePull`:

| Notion property (default) | TSV column |
|---|---|
| Status | `status` |
| Notion page id | `notion_page_id` |
| Key (`<source>:<jobId>`) | match key |

`profile.notion.property_map` overrides the default. Full property map
(all 18 fields used during page creation) lives in `prepare`'s commit
phase, not here. See [`notion-schema.md`](notion-schema.md) for the
full property-gating table.

### Manual deletion contract

If the operator deletes a Notion page by hand, pull does not trim the
TSV row. The supported ways to remove a row from the pipeline are
(1) set `Archived` in Notion (pull picks it up) or (2) delete the row
from `applications.tsv` directly (next `scan` will not recreate it
unless the URL reappears).

## `check`

Two-phase Gmail polling, plus an optional `--auto` mode that bypasses
MCP via OAuth. For flag table see [`cli.md` § check](cli.md#check).

### Active jobs map (C-1)

Watchlist requires:

1. `status ∈ ACTIVE_STATUSES = {"To Apply","Applied","Interview","Offer"}`
2. `notion_page_id` non-empty
3. `companyName` non-empty

Map keyed by company → array of `{company, role, status, notion_id,
resume_version, key}`. Multi-role per company is handled by `findRole`
(see C-6).

### Cursor epoch (C-2)

Gmail search window = `after:<epoch>`. Epoch resolution order:

1. `--since <ISO>` if provided (clamped to now-30d).
2. `processed_messages.json:last_check` (clamped to now-30d).
3. Otherwise now-30d.

**Hard cap 30 days.** `last_check` is bumped only under `--apply` —
including the zero-emails case so a stuck cursor cannot leave the
system arbitrarily far behind.

### Gmail batches (C-3)

One batch per Gmail query. `BATCH_SIZE = 10`.

1. **Company batches** — N batches of 10 companies:
   ```
   (from:(c1 OR c2 OR ... OR c10) OR subject:(c1 OR ...)) after:<epoch> -from:me
   ```
   `companyTokens` strips legal suffixes (Inc, LLC, Ltd) and dedupes
   first-token.
2. **LinkedIn batch** (fixed): `from:jobalerts-noreply@linkedin.com after:<epoch>`.
3. **Recruiter outreach batch** (fixed): subject pattern
   (`Requirement for`, `Immediate need`, …) with ATS-sender exclusions.

### Email loop (C-4)

Order matters:

| Order | Branch | Trigger | Side effect |
|---|---|---|---|
| 1 | LinkedIn alert | `from contains jobalerts-noreply@linkedin.com` | `processLinkedIn` is short-circuited as of 2026-05-03 (log-only; no TSV row created). Re-enable instructions in the comment block above the function. |
| 2 | Other job-alert digest | `isJobAlert(from, subject)` | Skip. Their JD body contains false-positive keywords. |
| 3 | Non-pipeline sender | `isNonPipelineSender(from)` (banks, utilities, insurance) | Skip. Transactional language overlaps with ACK / INFO. |
| 4 | Recruiter outreach | `!isATS(from) && matchesRecruiterSubject(subject)` | `processRecruiter` → if a client name is extractable, append a fresh `Inbox` row; else log to `recruiter_leads.md`. |
| 5 | Pipeline default | otherwise | `processPipeline` — classify + match + plan action. |

### Classifier (C-5)

Pure rule-based. Order: `REJECTION > INTERVIEW_INVITE > INFO_REQUEST > ACKNOWLEDGMENT > OTHER`. First match wins.

Three tightenings vs the prototype, covered by regression tests:

1. `/not selected/i` removed (was hitting ATS boilerplate).
2. INTERVIEW_INVITE bare `\binterview\b` / `\bavailability\b` removed
   — must include intent context (`schedule (an?) interview`,
   `your interview (is|with|on)`, `share your availability`).
3. INFO_REQUEST bare `/assessment/`, `/questionnaire/` removed — must
   include action context (`complete the assessment`, `take-home
   assignment`).

### Pipeline match + actions (C-6)

`findCompany` extracts company from `from` domain / sender name / body
and looks up in the active map (with `profile.company_aliases`).
`findRole` then disambiguates inside the company's active rows.

| Type | Confidence | Action |
|---|---|---|
| REJECTION + active | HIGH/MEDIUM | `Status → Rejected` + comment `❌ Subject: ...` |
| REJECTION + already in SKIP_STATUSES | any | no-op |
| INTERVIEW_INVITE + active | HIGH/MEDIUM | `Status → Interview` + comment `🔔 Subject: ...` |
| INFO_REQUEST | HIGH/MEDIUM | comment-only `📋 Subject: ...` (no status change) |
| ACKNOWLEDGMENT / OTHER | any | log only |
| any | LOW | log only |

`INTERVIEW_INVITE → "Interview"` is the post-Stage 8 unification — no
more `Phone Screen` / `Onsite`.

### Mutation phase (C-7)

`--apply` only:

1. **Notion** — `updatePageStatus` + `addPageComment` per action. Per-
   action errors are caught, logged, and counted; they do not abort
   the loop. Final exit code is `notionErrors > 0 ? 1 : 0`.
2. **TSV** — merge new `Inbox` rows + status updates → atomic save.
3. **Logs** — append to `rejection_log.md`, `recruiter_leads.md`,
   `email_check_log.md`.
4. **State** — append to `processed_messages.json`, prune > 30d.

TSV save is **not** atomic with Notion mutations: a Notion 5xx
mid-flight leaves Notion partially updated and the TSV mirroring the
pre-call state. Self-healing on rerun.

### Autonomous mode (C-8)

`--auto` runs prepare + Gmail IMAP fetch + apply in a single process
(no MCP). Required env: `<ID>_GMAIL_USER` and `<ID>_GMAIL_APP_PASSWORD`
(generated at <https://myaccount.google.com/apppasswords>, RFC 021).
Required config: `profile.notion.cron_ops_page_id` and `cron_ops_user_id`
for failure notifications.

Failure path — any uncaught throw in `runAutoBody`:

1. Append to `cron_failures.log` (durable disk record).
2. Best-effort Notion comment to `cron_ops_page_id`, @mentioning
   `cron_ops_user_id` (fallback `notion.user_id`).
3. Notification failure is swallowed — never masks the original error.

### Logs schema (C-9)

All three log files are append-only Markdown:

- `rejection_log.md` — `## Rejections` table (date, company, role,
  level, archetype, prevApplied) + `## Metrics` (Total Applied,
  Rejected count/%, Pending, Interview). Metrics recompute on every
  append against the current TSV.
- `recruiter_leads.md` — `## Leads` table (date, agency, role, contact,
  subject) + simple total counter.
- `email_check_log.md` — per-run `## Check: <YYYY-MM-DD HH:MM>` block
  with table of messageIds + classification + action.

## `validate`

Pre-flight checks. Read-only by default; `--apply` permits live URL
liveness and retro-sweep archival. Exit 0 if clean, 1 if any issue.
For flag table see [`cli.md` § validate](cli.md#validate).

Four checks in order:

### V-1 — TSV hygiene

Parse `applications.tsv` and `data/jobs.tsv`. Best-effort: parse
errors increment `issues++` but do not abort. Schema sanity uses
`tsv-schema.md` v3 layout.

### V-2 — Company cap enforcement check

For each company, count `ACTIVE_STATUSES` rows; compare to
`filter_rules.company_cap.max_active` (with overrides). Validate uses
`>` (already over); prepare uses `>=` (would push over). Both are
correct; the `(count == max_active)` boundary is the visible
difference.

### V-3 — URL liveness on active applications

Differences vs prepare's URL check (P-3):

| | prepare | validate |
|---|---|---|
| Method | HEAD + GET fallback | HEAD-only |
| Redirect | follows | `redirect: "manual"` |
| 405 / 501 | retry GET | indeterminate (`ok=true, indeterminate=true`) |
| SSRF | guard | guard (same shape) |
| Cap | unlimited | `urlCap` default 500 |
| `--dry-run` | always runs | skips |

HEAD-only is intentional: validate pings real candidate-facing URLs
where GET could trigger ATS-side counters or "view job" mutations.

SSRF guard blocks loopback / link-local / private IPv4+IPv6 / `localhost`
(see `isSafeLivenessUrl`).

### V-4 — Retro blocklist sweep

Re-applies `company_blocklist`, `title_blocklist`, `location_blocklist`,
and the `geo` policy to rows in `RETRO_SWEEP_STATUSES = {"Inbox","To Apply"}`.
Default reports matches; `--apply` sets `status="Archived"` and
writes `updatedAt=now`. Applied / Interview / Offer rows are not
touched (post-apply state stays).

`location_blocklist` is checked against the TSV `location` column
(Schema v3 / Stage G-5). On older v1/v2 TSVs this check is skipped.

### V-5 — Exit code

`exit = issues > 0 ? 1 : 0`. Issues counted: TSV parse errors + cap
violations + dead URLs + SSRF-blocked URLs + retro-sweep matches
(only when `!--apply`; with `--apply` matches are applied and not
counted).

## `answer`

Two-phase application Q&A reuse + Notion push. Schema-only contract;
behavior detail in [`cli.md` § answer](cli.md#answer) and
[RFC 009](../../rfc/009-application-answers-command.md).

`--phase search`: read-only lookup in the per-profile Application Q&A
DB by `(company, role, question_key)`. Prints
`{key, exact, partials, schema.categories, category_suggestion}`.

`--phase push`: requires `--results-file` JSON of shape
`{company, role, question, answer, category?, notes?, existingPageId?}`.
Writes a local Markdown backup at
`profiles/<id>/application_answers/<Company>_<role-slug>_<YYYYMMDD>.md`
(numeric suffix on collision) **before** the Notion call, so a Notion
failure leaves a recoverable artifact on disk. Then creates or
updates the Notion page.

The push side-effects regardless of `--apply` (the side effect is the
whole point of `push`); `--apply` is reserved for parity.

## `indeed-prep`

Phase 1 of the Indeed two-phase ingest. Reads the per-profile Indeed
config (keywords, location, radius, fromage, filter blockers, batch
hint), constructs scan URLs and a `viewjob` template, prints a JSON
payload. Without `--dry-run` it scaffolds an empty `raw_indeed.json`
in the Indeed state dir if absent (never overwrites). Detail in
[`cli.md` § indeed-prep](cli.md#indeed-prep).

## Open spec gaps

High-impact gaps still open at the time of writing:

- **G-7** — `profile.geo` does not yet exist; geo enforcement is
  per-adapter and only Workday is wired. RFC 013 closes.
- **G-14** — JD cache covers only Greenhouse and Lever; other ATSes
  fall back to live WebFetch (non-deterministic).
- **G-29** — `check --auto` is partially activated (deployed for both
  profiles via fly.io cron, with intermittent secret / permissions
  issues). Closure depends on a clean run for both.
- **G-33** — Retro `location_blocklist` sweep relies on TSV column 7
  (Schema v3); pre-v3 backfilled rows are not covered.

All other contract-level gaps from the Phase 1 SPEC are either closed
(most by 2026-05-04) or marked Trivial.
