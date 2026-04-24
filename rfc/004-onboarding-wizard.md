# RFC 004 — Onboarding Wizard (Stage 18)

**Status**: Draft v2 — open questions resolved 2026-04-22; awaiting final approval to start implementation
**Tier**: L (architecture + multi-user surface)
**Author**: Claude (sonnet), 2026-04-22
**Depends on**: RFC 001 (multi-profile architecture), RFC 003 (Jared migration — Stage 16)

---

## 1. Problem

The engine now serves Jared end-to-end. Adding a second profile today means:

- Hand-crafting `profiles/<id>/profile.json` with 180+ lines across identity, company_tiers, notion property_map, modules, etc.
- Creating 4 Notion databases (Jobs, Companies, Application Q&A, Job Platforms) under a workspace page, with the right schemas and relations.
- Seeding `filter_rules.json`, `resume_versions.json`, `cover_letter_template.md`, `cover_letter_versions.json` from scratch.
- Adding secrets to `.env` under the right `{ID}_` namespace.
- Running the right scripts in the right order.

Anyone but me (Claude + Jared) would fail at this. the second profile is next, and she'll need this too — but the wizard must not be second-profile-specific.

## 2. Goals

- **Generic**: works for any Nth profile without code changes. the second profile is the first real case, not the design target.
- **Zero-interactive-CLI**: no `readline` prompts. Flow is **form → deploy-script** — Claude emits a structured questionnaire, user fills it and sends it back in chat, Claude parses into an intake file, deploy script provisions everything.
- **Idempotent**: safe to re-run after partial completion (e.g. network drop mid-Notion-creation). Same sentinel pattern Stage 16 used.
- **Re-uses Stage 16**: schema extension, hub layout, aux DB creation are already solved — wizard orchestrates them, doesn't reinvent them.
- **Secret-free anketa**: questionnaire never asks for tokens. It lists the `.env` variable names the user must populate; deploy script validates they exist before proceeding.

## 3. Non-goals

- Interactive CLI wizard (rejected by user — "Мы создаем форму в гугле, условно").
- Full prototype migration path for generic users (Jared's Stage 16 stays one-off). A **lightweight** import branch for users who have _partial_ prototype assets (CL/resume templates + generated files) is in scope — that's the second profile's case.
- Auto-generation of resume DOCX from LinkedIn/PDF. User provides resume archetype text in the form; wizard writes `resume_versions.json`.
- Onboarding Notion DBs or pages that belong to other users (workspace-level sharing is out of scope — user invites the integration manually).
- Wizard UI (web / Google Form actual). Markdown template delivered in chat is sufficient for v1.

## 4. Proposed solution

### 4.1 Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. Claude emits intake questionnaire (Markdown template, 10 sections).  │
│    - User asks: "onboard the second profile" → Claude shows template + instructions. │
│                                                                         │
│ 2. User fills template (any editor), sends filled version back in chat. │
│    - Claude parses into JSON: profiles/<id>/.stage18/intake.json        │
│    - Validation errors → Claude highlights what's missing, asks again.  │
│                                                                         │
│ 3. User adds secrets to .env per namespaced schema Claude provides.     │
│                                                                         │
│ 4. User runs:                                                           │
│      node scripts/stage18/deploy_profile.js --profile <id>              │
│    Default dry-run, --apply mutates.                                    │
│                                                                         │
│ 5. Deploy script executes ordered stages (see §4.3), each idempotent.   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Questionnaire (intake form)

Delivered as a Markdown template `scripts/stage18/intake_template.md`. Ten sections. User fills inline under each heading. Claude parses back to structured JSON.

| § | Section | What's captured | Feeds |
|---|---------|-----------------|-------|
| A | Identity | Name, email, phone, location (city/state/country), LinkedIn, optional personal site, optional pronouns | `profile.json.identity` |
| B | Career context | Target role titles (list), title blocklist, level (IC/Staff/Manager/Director), seniority (junior/mid/senior/staff/principal), years of experience, current/last role+company | `profile.json.career`, `filter_rules.json.title_blocklist` |
| C | Preferences | Work format (remote/hybrid/onsite, any), cities/states OK, location blocklist, salary (min TC, ideal TC, currency), industries prefer, industries avoid, company sizes OK (Startup/Scaleup/Mid/Enterprise) | `profile.json.preferences`, `filter_rules.json.location_blocklist` |
| D | Target companies | S-tier dream list, A-tier strong interest, B-tier open, C-tier backup, company blocklist | `profile.json.company_tiers`, `filter_rules.json.company_blocklist` |
| E | Resume archetypes | Master resume (file path, optional), N archetypes each with: key, display title, 1-2 sentence summary bio, 3-5 highlighted bullets from master, keyword tags | `resume_versions.json` |
| F | Cover letter voice | Signature line, tone (formal/conversational/punchy), target length (short/medium/long), 4 paragraph structure hints (intro/why_interested/why_fit/close) | `cover_letter_template.md`, `cover_letter_versions.json` (defaults) |
| G | Notion | Parent workspace page URL (user creates empty page, pastes URL), integration name the user installed, confirmation they've shared the page with the integration | `profile.json.notion.workspace_page_id` (derived from URL) |
| H | Discovery modules | Which adapters to enable from the registry (greenhouse/lever/ashby/smartrecruiters/workday/calcareers/remoteok/usajobs) | `profile.json.modules` |
| I | Optional API keys | For USAJOBS (and future-gated adapters): user confirms `{ID}_USAJOBS_API_KEY` + `{ID}_USAJOBS_EMAIL` are set in `.env` — wizard does **not** ask for the value | validation step only |
| J | Prototype import (optional) | `has_prototype: yes/no`. If yes: path to prototype dir, list of assets to import (cover_letter_template / resume_versions / cover_letters-dir / resumes-dir / TSV / Notion-workspace-URL). Each checkbox'd; omitted = skipped. | `intake.prototype` block — drives §4.3 step 7 |

Full template ships in `scripts/stage18/intake_template.md` — see §8 for draft.

### 4.3 Deploy script stages

`scripts/stage18/deploy_profile.js --profile <id>` — orchestrator, default dry-run, `--apply` mutates. Steps, each idempotent:

| # | Step | Calls | Notes |
|---|------|-------|-------|
| 0 | Validate intake | (internal) | Schema-check `intake.json`; required fields present; URLs parseable; `.env` has `{ID}_NOTION_TOKEN` (and `{ID}_USAJOBS_*` if §I checked). |
| 1 | Generate profile files | (internal — new `scripts/stage18/generators/`) | Writes `profiles/<id>/profile.json`, `filter_rules.json`, `resume_versions.json`, `cover_letter_template.md`, `cover_letter_versions.json`. All additive-safe: if file exists, merge with intake and backup original to `.stage18/` sidecar. |
| 2 | Create Notion Jobs DB | new `scripts/stage18/create_jobs_db.js` | Under parent page (derived from URL). Full schema (Title + Company relation + Source + URL + Status + … — same 25 props Jared ended up with). Writes ID to `profile.json`. |
| 3 | Create Companies DB | new `scripts/stage18/create_companies_db.js` | Full schema (Name + Tier + Industry + Size + Remote Policy + Careers URL + Notes + Why Interested). Writes ID. |
| 4 | Create aux DBs | existing `scripts/stage16/create_aux_dbs.js` | Reusable. Application Q&A + Job Platforms. |
| 5 | Seed Companies | new `scripts/stage18/seed_companies.js` | Reads `company_tiers` from profile, bulk-creates rows with Tier set. |
| 6 | Seed Job Platforms | existing `scripts/stage16/seed_job_platforms.js` | Reusable. 9 adapters. |
| 7 | (Optional) Prototype import | new `scripts/stage18/import_prototype.js` | If `intake.prototype.has_prototype`: copies checked assets. Leverages Stage 16's `copy_generated_files.js` for file copy; TSV/Notion-snapshot only if user ticked them. For the second profile: only CL template + resume_versions + cover_letters/resumes dirs. |
| 8 | Build hub layout | existing `scripts/stage16/build_hub_layout.js` | Reusable. 4 subpages + 3-column body. |
| 9 | Smoke verification | (internal) | Runs `engine/cli.js validate --profile <id>` (non-destructive read). Reports count of Inbox/Applied/etc. — will be 0 on clean onboarding, non-zero if prototype import ran. |

Step order mirrors Stage 16 runbook but with §4.3.2-3 (new DB provisioning) replacing Jared's Stage 7 manual DB creation.

### 4.4 File tree added

```
scripts/stage18/
  intake_template.md           # the questionnaire
  parse_intake.js              # markdown → intake.json (pure, tested)
  parse_intake.test.js
  deploy_profile.js            # orchestrator
  generators/
    profile_json.js            # intake → profile.json
    profile_json.test.js
    filter_rules.js            # intake → filter_rules.json
    filter_rules.test.js
    resume_versions.js         # intake → resume_versions.json
    resume_versions.test.js
    cover_letter.js            # intake → template.md + versions.json
    cover_letter.test.js
  create_jobs_db.js            # new DB (full schema)
  create_jobs_db.test.js
  create_companies_db.js       # new DB (full schema)
  create_companies_db.test.js
  seed_companies.js            # tiers → Companies DB rows
  seed_companies.test.js
  import_prototype.js          # optional §7 branch
  import_prototype.test.js
  README.md                    # runbook
profiles/<id>/
  .stage18/
    intake.json                # parsed questionnaire (source of truth)
    intake.md.backup           # original markdown user sent
```

Shared helpers live in `scripts/stage16/_common.js` already — `scripts/stage18/_common.js` either extends or re-exports.

### 4.5 Idempotency & partial-state recovery

- Each step's `--apply` writes a completion marker into `.stage18/state.json`: `{"step_2": {"done": true, "db_id": "..."}, ...}`.
- Re-running `deploy_profile.js --apply` reads `state.json` and skips completed steps. Can be forced with `--force-step N` (resets that step only).
- Sentinel pattern for Notion pages: `⟡ onboarded-v1 (managed by scripts/stage18/deploy_profile.js)` on the hub page — same approach Stage 16 used for hub layout.

### 4.6 Secrets flow

User gets this note in §I of the questionnaire (and in README):

> Add to `.env` (root of AIJobSearcher/), where `<ID>` is the uppercase profile id you chose:
> ```
> <ID>_NOTION_TOKEN=secret_xxx          # required
> <ID>_USAJOBS_API_KEY=xxx              # only if you checked usajobs adapter
> <ID>_USAJOBS_EMAIL=you@example.com    # only if you checked usajobs adapter
> ```
> Do not paste these into the questionnaire. The deploy script will verify they exist but never read their values into logs or files.

`deploy_profile.js --apply` fails fast (exit 1) if a required env var is missing, with a clear message pointing back to this block.

## 5. second-profile-specific decisions

the second profile is the first real user of Stage 18. Her intake will have:

- §J (prototype import): `has_prototype=yes`, path=`../Profile B Job Search/`, assets checked: **cover_letter_template.md, cover_letter_config.json (renames to cover_letter_versions.json), resume_versions.json, cover_letters/, resumes/**. **Not** checked: TSV (doesn't exist), Notion-workspace (doesn't exist).
- §G (Notion): user (Jared) creates an empty page in shared Notion workspace, pastes URL, installs integration, shares page with it.
- §H (modules): TBD — the second profile's target role (designer / junior PM?) may need different adapters than Jared's PM-focused set. Questionnaire captures this; deploy script trusts user's selection.

The questionnaire handles this. **No second-profile-specific code path** is needed.

## 6. Testing

- Unit: every generator + parser tested with synthetic intake fixtures. No Notion calls.
- Integration: `scripts/stage18/deploy_profile.js --profile test_fixture --dry-run` against a fixture intake file — asserts all 10 steps plan the right work, no network calls.
- Live smoke: the second profile's onboarding is the live-apply test. Documented in §10 of `scripts/stage18/README.md`.

## 7. Resolved questions

- **Q1 — Anketa language**: **English template**, answers in any language (RU/EN/mixed). Parser tolerates both — field values are treated as free-text strings, keys remain English.
- **Q2 — Resume master file**: **Out of scope**. User brings their own master resume (DOCX/PDF). Wizard only writes `resume_versions.json` metadata (archetype keys + summaries + tags).
- **Q3 — Profile id validation**: **Restrict** to `[a-z0-9_]+` (lowercase, letters/digits/underscore, 2–32 chars). **Refuse** to run if `profiles/<id>/` already exists unless `--force` is passed (and even then, back up existing dir to `profiles/<id>.backup-<timestamp>/` first).
- **Q4 — Notion parent page**: **User creates manually**. Intake §G captures the URL. Wizard extracts page id from URL, verifies the integration has access (one-shot `client.pages.retrieve`), fails fast with a helpful error if not shared.
- **Q5 — Re-onboarding**: **Out of scope for v1**. Stage 18 is onboarding-only. Re-onboarding logged to BACKLOG.
- **Q6 — Property map**: **Minimal + feature-gated**, not uniform-max. Core fields always; optional fields gated by enabled modules. See §4.7.

## 4.7 Property map — feature-gated resolution

**Core fields** (always emitted into Jobs DB schema + property_map):

| Field | Type | Rationale |
|-------|------|-----------|
| `title` | title | always needed |
| `companyName` | relation (→ Companies DB) | always needed |
| `source` | select | always needed |
| `jobId` | rich_text | always needed |
| `url` | url | always needed |
| `status` | status | always needed |
| `key` | rich_text | dedup key, always needed |
| `dateAdded` | date | when scan discovered it |
| `notes` | rich_text | free-form, always useful |

**Feature-gated fields** (emitted only if the triggering module is in `intake.modules`):

| Field | Type | Gated by |
|-------|------|----------|
| `salaryMin`, `salaryMax`, `salaryExpectations` | number, number, rich_text | `prepare` module |
| `workFormat` | select Remote/Hybrid/Onsite | `prepare` module |
| `city`, `state` | rich_text each | `prepare` module |
| `fitScore` | select Strong/Medium/Weak | `prepare` module |
| `resumeVersion` | select | `prepare` module |
| `coverLetter` | rich_text (filename stem) | `prepare` module |
| `datePosted`, `dateApplied` | date each | `prepare` module |
| `lastFollowup`, `nextFollowup` | date each | `check` module |
| `classification`, `jobControlId`, `soqRequired`, `soqSubmitted`, `finalFilingDate` | rich_text, rich_text, checkbox, checkbox, date | `discovery:calcareers` in modules |
| `watcher` | person | explicit `intake.watcher_enabled: true` (default false — person field requires workspace members) |

Rationale: the second profile's profile (PM path, no CalCareers) lands at ~20 fields vs. Jared's 25. Fewer "empty" columns in her Notion UI, no migration needed because modules are additive — turning `discovery:calcareers` on later triggers a schema patch via the existing `scripts/stage16/extend_jobs_schema.js` pattern (which is idempotent).

## 8. Appendix — draft intake_template.md skeleton

(Full template delivered as `scripts/stage18/intake_template.md` on approve. Sketch:)

```markdown
# Onboarding Intake — AIJobSearcher

Fill each section. Leave `# (skip)` on any line to omit. Send the filled file
back to Claude in chat — no need to save it anywhere first.

## A. Identity
- profile_id: _ _  (lowercase, [a-z0-9_], e.g. `profile_b`)
- full_name: _ _
- email: _ _
...

## B. Career context
- target_roles:
  - _ _
  - _ _
- title_blocklist:
  - _ _
...
```

## 9. Effort estimate

- Generators + parser + tests: ~6-8h
- Jobs/Companies DB creation scripts (forked from Stage 16 patterns): ~2h
- Orchestrator + state machine: ~3h
- Intake template + docs: ~2h
- Live smoke with the second profile: ~1h (plus waiting for her to fill intake)

**Total**: ~2 days of focused work for Claude-Code + ~30min of user attention.

## 10. Rollback

- Each `--apply` step backs up target files into `.stage18/` before mutating.
- Notion mutations are additive (new DBs, new pages) — rollback = delete those objects in Notion UI.
- Profile directory can be wiped by removing `profiles/<id>/` (user action).
- No shared state is mutated — rollback doesn't affect Jared or other profiles.
