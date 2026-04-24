# Stage 18 — Onboarding Wizard (questionnaire-based)

Generic onboarding for new profiles. Replaces the ad-hoc "copy Jared's configs and edit" flow we used for the first profile.

Full design: [rfc/004-onboarding-wizard.md](../../rfc/004-onboarding-wizard.md).

## Flow

```
  ┌─────────────────────────────────────────────┐
  │ 1. User copies intake_template.md,          │
  │    fills it in, sends back.                 │
  └─────────────────────────────────────────────┘
                      │
                      ▼
  ┌─────────────────────────────────────────────┐
  │ 2. parse_intake.js  → intake.json           │
  │    (validates required fields)              │
  └─────────────────────────────────────────────┘
                      │
                      ▼
  ┌─────────────────────────────────────────────┐
  │ 3. deploy_profile.js                        │
  │    ├─ generators: profile.json, filter_rules,│
  │    │  resume_versions, cover_letter_*        │
  │    ├─ Notion: create_companies_db → jobs_db  │
  │    ├─ seed_companies (tiers from §D)         │
  │    └─ import_prototype (optional, §J)        │
  └─────────────────────────────────────────────┘
                      │
                      ▼
            manual follow-ups
            (aux DBs, hub layout, first scan)
```

## Runbook

Everything defaults to `--dry-run`. Pass `--apply` to write.

### Step 1 — send the template

Email/message the raw file to the user:

```
scripts/stage18/intake_template.md
```

They fill it in (any language, `yes`/`no`/`да`/`нет` both work) and send it back as e.g. `intake_filled.md`.

### Step 2 — parse intake

```sh
# Dry-run: parse + print JSON to stdout, don't touch disk.
node scripts/stage18/parse_intake.js --input intake_filled.md

# Apply: persist to profiles/<id>/.stage18/intake.json + intake.md.backup.
node scripts/stage18/parse_intake.js --input intake_filled.md --apply
```

Profile id is taken from `intake.identity.profile_id`. `--profile` is advisory only.

### Step 3 — confirm secrets in `.env`

Before running `deploy_profile`, make sure the root `.env` has the profile's Notion token:

```
<PROFILE_ID_UPPER>_NOTION_TOKEN=secret_xxx
```

Never ask the user for the token — they paste it into `.env` themselves.

Optional per-profile keys (only if those modules are enabled):

```
<PROFILE_ID_UPPER>_USAJOBS_API_KEY=
<PROFILE_ID_UPPER>_USAJOBS_EMAIL=
```

### Step 4 — deploy

```sh
# Dry-run: print plan, no writes.
node scripts/stage18/deploy_profile.js --profile <id>

# Apply: generate files, provision DBs, seed companies, optional prototype import.
node scripts/stage18/deploy_profile.js --profile <id> --apply
```

Idempotent. Re-run is safe — each sub-script checks state + adopts by title.

### Step 5 — follow-ups (manual)

The current orchestrator stops short of the hub UI because those pieces are profile-titled and benefit from user-in-the-loop. See [§follow-ups](#follow-ups) below.

## Files

| File | Role |
|---|---|
| `intake_template.md` | The questionnaire. Ten sections A–K. Send to user unchanged. |
| `parse_intake.js` | Markdown → `intake.json`. Lenient; EN/RU values OK. |
| `property_map.js` | Feature-gated Notion property_map resolver (core + per-module gated fields). |
| `generators/profile_json.js` | intake → `profile.json` (identity, modules, tiers, notion, property_map). |
| `generators/filter_rules.js` | intake → `filter_rules.json` (canonical flat shape). |
| `generators/resume_versions.js` | intake.resume_archetypes → `resume_versions.json`. |
| `generators/cover_letter.js` | intake.cover_letter → template.md + versions.json skeleton. |
| `create_companies_db.js` | Provision Companies DB under workspace page. Idempotent. |
| `create_jobs_db.js` | Provision Jobs Pipeline DB (Company → Companies relation). Idempotent. |
| `seed_companies.js` | Bulk-insert tier_* companies. Dedups by Name. |
| `import_prototype.js` | Optional: copy CL templates / versions / generated files from a prior prototype. |
| `deploy_profile.js` | Orchestrator — runs generators + Notion steps in order. |
| `_common.js` | Shared helpers (profile-id validation, Notion page-id extraction, state, intake IO). |

All pure-logic modules have `*.test.js`. Run with `node --test scripts/stage18/*.test.js scripts/stage18/generators/*.test.js`.

## State

Per-profile state lives at `profiles/<id>/.stage18/`:

```
profiles/<id>/.stage18/
  intake.json          # parsed questionnaire (source of truth)
  intake.md.backup     # raw markdown, for audit
  state.json           # per-step completion markers (idempotency)
```

`.stage18/` is gitignored (same convention as `.stage16/`).

## intake.json shape

See `parse_intake.js` — top-level keys track section letters:

```js
{
  identity: { profile_id, full_name, email, phone, linkedin, location_*, ... },
  career: { target_roles, level, years_experience, title_blocklist: [] },
  preferences: { salary_*, work_format, locations_ok, location_blocklist, ... },
  companies: { tier_s: [], tier_a: [], tier_b: [], tier_c: [], company_blocklist: [] },
  resume_archetypes: [{ key, title?, summary?, bullets?: [], tags?: [] }, ...],
  cover_letter: { tone, length, intro_hint, why_interested_hint, why_fit_hint, close_hint, signature },
  notion: { parent_page_url },
  modules: ["discovery:greenhouse", ...],
  env_checks: { env_notion_token_set: bool, env_usajobs_set: bool },
  prototype: { has_prototype: bool, prototype_path?, import_*: bool, ... },
  flags: { watcher_enabled?, include_companies_seed? }
}
```

`validateIntake` requires: `identity.profile_id`, `identity.full_name`, `identity.email`, `notion.parent_page_url`, at least one resume archetype, and `env_checks.env_notion_token_set=true`.

## Feature-gated property_map

Jared's Jobs DB has 25 properties. the second profile's doesn't need CalCareers fields or a Watcher column — her DB should be smaller.

`property_map.js` emits a core set (9 fields) plus gated groups:

| Group | Gate | Adds |
|---|---|---|
| `prepare` | always | salaryMin, salaryMax, salaryExpectations, workFormat, city, state, fitScore, resumeVersion, coverLetter, datePosted, dateApplied |
| `check` | always | lastFollowup, nextFollowup |
| `discovery:calcareers` | module enabled | classification, jobControlId, soqRequired, soqSubmitted, finalFilingDate |
| `watcher` | `flags.watcher_enabled=true` | watcher |

This guarantees the second profile's DB matches what the second profile actually uses without shipping a separate schema.

<a id="follow-ups"></a>
## Follow-ups (not orchestrated)

After `deploy_profile --apply`:

1. **Auxiliary DBs** (Application Q&A, Job Platforms). The Stage 16 scripts (`scripts/stage16/create_aux_dbs.js`, `seed_job_platforms.js`) are Jared-titled. To reuse:
   - Manually set `profile.notion.workspace_page_id` (deploy_profile already writes it).
   - Edit stage16 `create_aux_dbs.js` title strings to match the new profile (or copy the script and parametrize).
   - Or skip these DBs — the core pipeline (scan / prepare / check / sync) does not require them.
2. **Hub layout page**. `scripts/stage16/build_hub_layout.js` is Jared-specific. Copy + adapt if you want the subpage structure.
3. **Prototype migration (full)**. If the user has a prototype Notion workspace (not just local files), run `scripts/stage16/fetch_prototype_notion_jobs.js` + `migrate_tsv_from_prototype.js` against their workspace.
4. **Smoke test**:
   ```sh
   node engine/cli.js scan --profile <id>
   node engine/cli.js validate --profile <id>
   ```

## Constraints (RFC 004)

- **Questionnaire, not CLI**. No interactive prompts anywhere. User edits markdown offline.
- **No secrets in intake**. Secrets go straight to `.env`. Intake only has yes/no checks.
- **User brings the master resume**. We don't generate archetype bullets — we ask for them.
- **English template, any-language answers**. Parser is tolerant.
- **Profile isolation**. Every artifact lives under `profiles/<id>/`; no shared writes.

## Running the test suite

```sh
node --test scripts/stage18/*.test.js scripts/stage18/generators/*.test.js
```

63+ tests cover: intake parsing (RU/EN, HTML comments, list folding), property-map resolution (gate interaction, second-profile-minimal), generators (profile.json, filter_rules, resume_versions, cover_letter), Notion script pure helpers (injectCompaniesDbId, jobsDbTitle), prototype IMPORT_PLAN + copyFile/copyDir.
