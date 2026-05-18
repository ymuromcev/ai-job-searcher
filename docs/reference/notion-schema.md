# Notion schema reference

Authoritative sources:

- `scripts/stage18/property_map.js` — feature-gated Jobs Pipeline property map.
- `engine/core/notion_sync.js` — property serialization (`buildProperties`, `toPropertyValue`).
- `engine/core/company_resolver.js` — Companies DB lookup-or-create.

When this page disagrees with the code, the code wins.

## Overview

Each profile owns one Notion workspace page. The wizard
(`scripts/stage18/deploy_profile.js`) provisions four databases under
that page plus a hub layout of subpages. Every database is per-profile —
no cross-profile sharing — to keep PII isolated.

| Database | Role | Created by |
|---|---|---|
| Jobs Pipeline | Canonical funnel. One page per row of `applications.tsv`. | `scripts/stage18/create_jobs_db.js` |
| Companies | Source of truth for company metadata. Target of the `Company` relation in Jobs. | `scripts/stage18/create_companies_db.js` |
| Application Q&A | Reusable answers to common application questions. Read by `answer` command. | Stage 16 (manual on legacy profiles, hub setup for new ones) |
| Job Platforms | One row per active discovery adapter — operational catalog. | Stage 16 (same) |

The hub page also hosts four subpages (Candidate Profile, Workflow,
Target Tier, Resume Versions) and a three-column body. See
[Hub layout](#hub-layout) below.

The Jobs Pipeline property set is **feature-gated** — fields are only
created if the triggering module is active. A profile that does not
enable `prepare` will not get salary or fit-score columns. This is why
two live profiles can have substantially different schemas:
`PM-Pete` runs every module and ends up with the maximal set;
`Healthcare-Hannah` runs a smaller set and her DB is correspondingly
narrower.

## Jobs Pipeline DB

### Identity

The page title is the role title (`Title`).

### Core properties (always emitted)

Source: `CORE_FIELDS` in `scripts/stage18/property_map.js`.

| Internal key | Notion field | Type |
|---|---|---|
| `title` | `Title` | title |
| `companyName` | `Company` | relation → Companies DB |
| `source` | `Source` | select |
| `jobId` | `JobID` | rich_text |
| `url` | `URL` | url |
| `status` | `Status` | status |
| `key` | `Key` | rich_text |
| `dateAdded` | `Date Added` | date |
| `notes` | `Notes` | rich_text |

`Source` ships with default options for every shipped adapter
(`greenhouse`, `lever`, `ashby`, `workable`, `smartrecruiters`,
`workday`, `remoteok`, `calcareers`, `usajobs`, `manual`, `builtin`).

### `prepare`-gated

Source: `GATED_GROUPS["prepare"]`. Always-on for v1 because `prepare`
is a core command.

| Internal key | Notion field | Type |
|---|---|---|
| `salaryMin` | `Salary Min` | number |
| `salaryMax` | `Salary Max` | number |
| `salaryExpectations` | `Salary Expectations` | rich_text |
| `workFormat` | `Work Format` | select (`Remote` / `Hybrid` / `Onsite` / `Any`) |
| `city` | `City` | rich_text |
| `state` | `State` | rich_text |
| `fitScore` | `Fit Score` | select (`Strong` / `Medium` / `Weak`) |
| `resumeVersion` | `Resume Version` | select (options seeded from `resume_versions.json`) |
| `coverLetter` | `Cover Letter` | rich_text (filename stem) |
| `datePosted` | `Date Posted` | date |
| `dateApplied` | `Date Applied` | date |

### `check`-gated

Source: `GATED_GROUPS["check"]`. Always-on for v1.

| Internal key | Notion field | Type |
|---|---|---|
| `lastFollowup` | `Last Follow-up` | date |
| `nextFollowup` | `Next Follow-up` | date |

### `discovery:calcareers`-gated

Source: `GATED_GROUPS["discovery:calcareers"]`. Only present on profiles
that enable the CalCareers adapter.

| Internal key | Notion field | Type |
|---|---|---|
| `classification` | `Classification` | rich_text |
| `jobControlId` | `Job Control ID` | rich_text |
| `soqRequired` | `SOQ Required` | checkbox |
| `soqSubmitted` | `SOQ Submitted` | checkbox |
| `finalFilingDate` | `Final Filing Date` | date |

### `watcher`-gated

Source: `GATED_GROUPS["watcher"]`. Only present when
`profile.flags.watcher_enabled === true`.

| Internal key | Notion field | Type |
|---|---|---|
| `watcher` | `Watcher` | people |

### Status options

Eight unified options. The set was finalized during Stage 8 when the
two live profiles were aligned.

| Status | TSV equivalent | Notes |
|---|---|---|
| `To Apply` | `To Apply` | Default for new pages pushed by `prepare`. |
| `Applied` | `Applied` | |
| `Interview` | `Interview` | Set by `check` on `INTERVIEW_INVITE`. |
| `Offer` | `Offer` | |
| `Rejected` | `Rejected` | Set by `check` on `REJECTION`. |
| `Closed` | `Closed` | |
| `No Response` | `No Response` | |
| `Archived` | `Archived` | |

The TSV `Inbox` state is local-only and never reaches Notion.

**Caveat:** Notion's create API rejects programmatic status-option
edits (`toNotionSchema` emits an empty options block). The wizard
prints a follow-up to add the eight options manually in the UI.

### Industry rollup

The Jobs DB exposes `Industry` as a rollup over the `Company` relation,
not a property of the job. The underlying value lives on the Companies
DB row. Wired up during Stage 13.

## Companies DB

Per RFC 008, Companies is the canonical source for company metadata.
The Jobs DB references it through the `Company` relation; the resolver
(`engine/core/company_resolver.js`) does lookup-by-title with an
in-memory cache and creates a row when missing.

### Properties

Core (always present):

| Field | Type | Notes |
|---|---|---|
| `Name` | title | Company display name. |
| `Tier` | select | `S` / `A` / `B` / `C`. Drives prioritization in `prepare`. |
| `Industry` | select or multi_select | Rolled up into Jobs DB. |
| `Website` | url | Marketing site. |

Stage 16 extension (always present on new profiles):

| Field | Type | Notes |
|---|---|---|
| `Careers URL` | url | Direct careers page. |
| `Size` | select or rich_text | Headcount band. |
| `Remote Policy` | select or rich_text | Remote / hybrid / onsite stance. |
| `Why Interested` | rich_text | Free-form note from the candidate. |

Profile-specific extensions are allowed. The `healthcare` flavor adds:

| Field | Type | Notes |
|---|---|---|
| `Specialty` | select or multi_select | Medical or dental specialty. |
| Schedule constraint fields | varies | Sacramento-area on-site availability tracking. |

### Seeding

The wizard seeds the DB from the intake's tier list during deploy
(`scripts/stage18/seed_companies.js`). Re-running is idempotent — the
script reads `state.json` and skips already-seeded rows, with an
adopt-by-title fallback.

## Application Q&A DB

Origin: Stage 16. Used by the `answer` command (RFC 009) as a reusable
answer bank.

| Field | Type | Notes |
|---|---|---|
| `Question` | title | Canonical wording. |
| `Answer` | rich_text | Approved response. |
| `Category` | select | Categorization for retrieval. |
| `Last Used` | date | Optional. |

## Job Platforms DB

Origin: Stage 16. Operational catalog of discovery adapters. One row
per platform (status: active / planned / disabled). About nine rows
seed for a maximal profile.

| Field | Type | Notes |
|---|---|---|
| `Platform` | title | Adapter name. |
| `Status` | select | `active` / `planned` / `disabled`. |
| `Notes` | rich_text | Free-form. |

## Property serialization

`engine/core/notion_sync.js#buildProperties` walks the property map and
calls `toPropertyValue` per field. Two behaviors worth knowing:

- **Empty values are skipped.** `value === undefined || value === null
  || value === ""` is treated as missing — the property is not included
  in the request body. Notion's API rejects `{url: ""}`, `{email: ""}`,
  and similar with HTTP 400 ("should be populated or null"). The fix
  lives in `buildProperties` itself; do not work around it in callers.
- **Type-driven dispatch.** The supported types are `title`, `rich_text`,
  `select`, `status`, `multi_select`, `url`, `email`, `phone_number`,
  `number`, `checkbox`, `date`, `relation`. Anything else throws.

## SDK and access

The engine pins `@notionhq/client` to the v5 line. Three v5-specific
shapes matter:

- Reads use `client.dataSources.query`. The container `database_id` is
  resolved to a `data_source_id` lazily by `resolveDataSourceId`.
- Database create accepts schema under `initial_data_source.properties`,
  not at the top level. Stage 16 incident: an earlier `databases.create`
  call put `properties` at the top level — Notion silently dropped them
  with only an SDK warning. The wizard now uses the correct shape.
- Status updates use `client.pages.update`; comments use
  `client.comments.create` (with optional `mention` rich-text).

## Hub layout

Set up by `scripts/stage16/build_hub_layout.js` (legacy path) for new
profiles via the Stage 18 wizard's follow-up step. The workspace page
hosts:

- Four subpages: `Candidate Profile`, `Workflow`, `Target Tier`,
  `Resume Versions`. The latter two are auto-populated from
  `profile.json` and `resume_versions.json`; the former two start
  empty.
- A three-column body: a `Callout` block tracking the current
  `toApplyCount`, links to each subpage, and `link_to_page` blocks
  for the four databases.
- A sentinel block at the end of each subpage so re-runs of the
  layout script are idempotent (already-populated subpages are
  skipped).

The hub has two flavors selected by `profile.flavor`:

| Flavor | Default | Workflow content |
|---|---|---|
| `pm` | yes (back-compat) | Full PM funnel with interview-coach references. |
| `healthcare` | opt-in | Compressed manual-first workflow. Triggers table is `Applied → Interview → Offer`; no interview-coach. |

## Schema migration history

| Stage | Change |
|---|---|
| 13 | Companies as relation target; `Industry` as rollup; per-profile Companies DB created and seeded. Resolver added. |
| 16 | Jobs DB +9 properties; Companies DB +4 properties; Application Q&A and Job Platforms DBs added. Status options must be added manually in the UI. |
| 18 | Property map made feature-gated; wizard provisions the four DBs + hub layout end-to-end. |

## See also

- [TSV schema reference](tsv-schema.md)
- [CLI reference](cli.md)
- [Architecture overview](../architecture/overview.md)
- [ADR-002 — Notion as UI](../architecture/adrs/002-notion-as-ui.md)
- [RFC 008 — Companies as Notion source of truth](../../rfc/008-companies-as-notion-source-of-truth.md)
- [RFC 004 — Onboarding wizard](../../rfc/004-onboarding-wizard.md)
