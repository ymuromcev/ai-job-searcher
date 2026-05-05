# Onboard a new profile

Walk a maintainer through onboarding a new candidate end-to-end via the
Stage 18 wizard. The output is a working `profiles/<id>/` directory plus
a populated Notion workspace (Companies DB + Jobs Pipeline DB), ready
for the first `scan`.

This runbook assumes you are starting from a clean state — no existing
`profiles/<id>/` directory, no existing Notion DBs for the candidate.
If the candidate has a prior prototype to import, see step 7.

## 1. Prerequisites

Before sending the intake template, make sure you have:

- **Notion integration token** for the workspace where the new profile
  will live. The candidate generates this in their Notion settings and
  pastes it directly into the maintainer's `.env` — never into the
  intake form.
- **Parent page URL** in the candidate's Notion workspace. The wizard
  creates the Companies DB and the Jobs Pipeline DB as children of this
  page. The integration must be shared on the parent page.
- **Resume archetypes**, at least one. An archetype is a role flavor
  (for example `ai_infra_pm`, `gtm_pm`, `front_office`,
  `medical_assistant`). Each archetype gets its own resume version and
  cover-letter template.
- **Tier list** of target companies (`tier_s` / `tier_a` / `tier_b` /
  `tier_c`). The wizard seeds the Companies DB from these.

Pick a persona alias (`PM-Pete`, `Healthcare-Hannah`, ...) and document
it in [`docs/product/personas.md`](../product/personas.md) before the
deploy. The persona alias is what every public doc references; the real
name lives only in `private/personas-real.md`.

## 2. Send the intake template

Send the raw markdown file to the candidate:

```
scripts/stage18/intake_template.md
```

They fill it in offline. Answers may be in any language; `yes` / `no`
and Cyrillic equivalents are both accepted by the parser. Sections A–K
cover identity, career, preferences, companies + tiers, resume
archetypes, cover-letter voice, Notion parent, discovery modules,
`.env` checks, and optional flags. Secrets are never asked for in the
intake — only `yes/no` confirmation that the maintainer has set the
token in `.env`.

## 3. Parse the intake

The candidate sends back the filled file (for example
`intake_filled.md`). Parse it:

```bash
# Dry run: prints JSON to stdout, no writes.
node scripts/stage18/parse_intake.js --input intake_filled.md

# Apply: persists to profiles/<id>/.stage18/intake.json plus a backup of
# the raw markdown.
node scripts/stage18/parse_intake.js --input intake_filled.md --apply
```

The profile id comes from `intake.identity.profile_id`. Format:
lowercase, starts with a letter, two to thirty-two characters,
alphanumerics plus underscore. Reserved names (`example`, `test`,
`default`, `template`) are blocked.

`validateIntake` requires `identity.profile_id`, `identity.full_name`,
`identity.email`, `notion.parent_page_url`, at least one resume
archetype, and `env_checks.env_notion_token_set=true`. If any of these
are missing the parser exits non-zero; fix the intake and re-run.

## 4. Add the Notion token to `.env`

Append the token to the root `.env` using the namespaced key:

```
{PROFILE_ID_UPPERCASE}_NOTION_TOKEN=secret_xxx
```

For example, a profile with id `p_a8f2c1` uses the key
`P_A8F2C1_NOTION_TOKEN`. New profiles use random `p_<hex6>` slugs
(see [ADR-005](../architecture/adrs/005-profile-id-convention.md)).
Never paste the token in chat or in the intake form. The candidate
enters it directly into `.env` themselves.

## 5. Deploy the profile

Run the orchestrator. It is idempotent — re-running is safe; each
sub-step checks state and adopts existing resources by title where
possible.

```bash
# Dry run: prints the plan, no writes to disk or Notion.
node scripts/stage18/deploy_profile.js --profile <id>

# Apply: generate files, provision DBs, seed companies.
node scripts/stage18/deploy_profile.js --profile <id> --apply
```

The orchestrator runs four phases:

1. **Generators** — write `profile.json`, `filter_rules.json`,
   `resume_versions.json`, `cover_letter_template.md`, and
   `cover_letter_versions.json` skeleton.
2. **Companies DB** — create under the parent page, idempotent.
3. **Jobs Pipeline DB** — create under the parent page; the
   `Company` relation is wired to the Companies DB id from phase 2.
4. **Seed companies** — bulk insert from the tier list, deduped by
   name.

Per-step state is recorded under `profiles/<id>/.stage18/state.json` so
re-runs skip already-completed phases.

## 6. Build the hub layout

The orchestrator stops short of the hub UI because subpage titles and
copy benefit from a maintainer review. Build the hub explicitly:

```bash
# For PM-Pete-style profiles (default flavor).
node scripts/stage18/build_hub_layout.js --profile <id> --apply

# For Healthcare-Hannah-style profiles, set profile.flavor first.
# In profiles/<id>/profile.json:
#   "flavor": "healthcare"
# Then run the same command. The healthcare flavor emits a shorter
# manual-first workflow without an interview-coach subpage.
```

The hub builder creates four subpages (Candidate Profile, Workflow,
Target Tier, Resume Versions) plus a three-column body with callout,
links, and a `link_to_page` to the Jobs DB.

## 7. Optional: import a prior prototype

If the candidate had a partial prior pipeline (for example a manual
spreadsheet plus a few cover letters), set the import flags in the
intake (section J) and `deploy_profile.js` will copy templates,
versions, generated files, and TSV rows into the new profile. For a
full Notion-side import (existing prototype Jobs DB), follow the
prototype-Notion path in
[backfill-tsv](backfill-tsv.md).

## 8. Smoke test

Verify the profile end-to-end:

```bash
node engine/cli.js scan --profile <id>
node engine/cli.js validate --profile <id>
node engine/cli.js prepare --profile <id> --phase pre --batch 1
node engine/cli.js sync --profile <id> --apply
```

Confirm: the Jobs DB receives at least one page, the TSV has at least
one row with a `notion_page_id`, the cover letter file is referenced in
the row, and the Companies relation resolves correctly.

## 9. Common pitfalls

- **Forgetting `--profile`** — every command requires it. The CLI
  errors out, but tests sometimes hide this.
- **Wrong profile-id format** — uppercase, leading digit, hyphen at
  start, or a reserved name will fail in `parse_intake`. Fix the
  intake and re-run.
- **Parent page not shared with the integration** — Notion returns
  401 from `create_companies_db.js`. Re-share the parent page with the
  integration in Notion's UI, then re-run.
- **`.env` typo in the env-var prefix** — `loadSecrets` returns
  `null` for the token and the wizard fails before the first Notion
  call. The error message names the missing key.
- **Re-running after a partial failure** — `state.json` keeps each
  step idempotent; the second `--apply` run picks up where the first
  one stopped.

## See also

- [RFC 004 — onboarding wizard](../../rfc/004-onboarding-wizard.md)
- [Multi-profile isolation model](../architecture/multi-profile.md)
- [Personas](../product/personas.md)
- [CLI reference](../reference/cli.md)
