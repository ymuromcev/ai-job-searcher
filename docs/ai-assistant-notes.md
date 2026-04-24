# Notes for AI assistants working in this repo

Supplement to [CLAUDE.md](../CLAUDE.md). CLAUDE.md is the short list of
rules; this doc explains the *why* and the shape of the codebase so
that a fresh agent (or a reviewer reading the code cold) can get
oriented fast.

## The mental model

> **Profile = data. Engine = service.**

Every piece of code in `engine/` must work for any profile. Every
piece of personal / preference data lives in `profiles/<id>/`.

When you're about to add something to `engine/`, ask: *would this be
correct for a different candidate with different targeting, different
resume archetypes, different Notion schema?* If not, it belongs under
`profiles/<id>/` or in a per-profile config file.

## Directory tour

```
engine/
  modules/
    discovery/    ATS + job-board adapters (Greenhouse, Lever, Ashby,
                  SmartRecruiters, Workday, CalCareers, USAJOBS,
                  RemoteOK, …). Auto-registered by index.js.
    generators/   Resume DOCX / PDF, cover letter PDF.
    tracking/     Gmail delegation (via MCP, not googleapis).
  core/
    filter.js            Rule-driven inclusion/exclusion.
    dedup.js             By (ats_source, job_id) → shared jobs.tsv.
    validator.js         Schema + consistency checks; retro sweeps.
    notion_sync.js       SDK v5 client, property builders, push planner.
    fit_prompt.js        Assembles per-profile fit prompt for Claude.
    profile_loader.js    Loads profile.json, secrets, filter rules.
    company_resolver.js  Looks up or creates Company relation pages.
    salary_calc.js       Tier × Level × COL → salary band.
    url_check.js         HEAD+GET+SSRF guard before JD fetches.
    jd_cache.js          Greenhouse / Lever JD fetch + disk cache.
    email_*.js           Classifier / matcher / parser / filter / state
                         for the check command.
  commands/
    scan.js      prepare.js   sync.js   validate.js   check.js
  cli.js         Dispatch + arg parse.
profiles/
  _example/      Template profile (synthetic, safe to read/copy).
  <id>/          Real profile data (gitignored).
data/            Shared master pool across profiles (gitignored).
scripts/stage18/ Onboarding wizard: intake → generated profile files
                 → Notion databases provisioned → optional prototype
                 import.
skills/job-pipeline/SKILL.md
                 Claude skill that drives the full flow. Plain prose;
                 the CLI is what actually executes.
rfc/             Architecture decisions. 001 = core split; 002 = check
                 command; 004 = onboarding wizard.
```

## Conventions

### CLI shape

Every command takes `--profile <id>`. Nothing is global. `profile_loader`
validates the id against `^[a-z][a-z0-9_]{1,31}$` and rejects
path-traversal / reserved names.

### Write paths default to dry-run

`sync`, `validate`, most `scripts/stage18/*` scripts default to dry-run
and require `--apply` to touch Notion or disk state. The tests assert
this.

### Pure helpers, isolated side effects

`core/*` and most of `scripts/stage18/*` are pure functions operating
on in-memory objects. The CLI glue (`commands/*`) is where the filesystem,
network, and process.exit live.

Tests target the pure helpers. Side-effect code is tested with faked
Notion clients and mocked `fetchFn` from `modules/discovery/_http.js`.

### Notion SDK v5

We use `@notionhq/client` v5. Relevant footguns:

- `databases.create({ properties: {...} })` silently drops the
  properties. Use `initial_data_source: { properties: {...} }`.
- `databases.query` is gone. Use `dataSources.query`.
- To resolve a db's `data_source_id`, call `databases.retrieve(dbId)`
  and read `.data_sources[0].id`.
- `pages.update` accepts property patches. Empty-string url / email /
  phone values **fail** validation — filter them out in
  `buildProperties` (we do).

### TSV is the ledger

`profiles/<id>/applications.tsv` is the canonical per-profile pipeline.
Notion is a view on top. The TSV has a schema version header (v2 at
time of writing); loaders auto-upgrade v1 → v2 on read.

### Profile contract

A `profile.json` declares:
- `id`, `identity` (name, email, phone, …),
- `modules: ["discovery:greenhouse", …]` — which engine modules to
  enable,
- `notion.*_db_id` — per-profile Notion database ids,
- `company_tiers` — S/A/B/C tiering used for salary calc + filter caps,
- `filter_rules_file`, `resume.versions_file`, `cover_letter.config_file`.

The engine reads only what `modules` enables. Nothing touches data
outside the profile's own files.

## Adding things

### A new ATS / board adapter

1. Drop a file in `engine/modules/discovery/<name>.js` that exports
   `{ fetchCompanies, fetchJobsForCompany }` (or the feed variant,
   see `remoteok.js`).
2. Use `ctx.fetchFn` — never call `fetch` directly; tests depend on it.
3. Add a test alongside using a faked `fetchFn`.
4. The module is auto-registered by `discovery/index.js`.
5. A profile opts in by adding `"discovery:<name>"` to `modules` in its
   `profile.json`.

### A new engine command

1. Create `engine/commands/<name>.js` exporting
   `async function handler(ctx) { ... }`.
2. Register it in `engine/cli.js` → `KNOWN_COMMANDS`.
3. Add tests for arg parsing + at least one happy-path behavior.

### A new profile

Don't hand-copy an existing profile. Use `scripts/stage18/` — fill
`intake_template.md`, run `parse_intake.js`, then
`deploy_profile.js`. The wizard generates config files, creates Notion
databases, and (optionally) imports from a prior hand-rolled prototype.

### A behavior change that touches multiple files

Add an RFC in `rfc/NNN-title.md` first. Rough template:

```
# RFC NNN — Title

**Status:** draft | approved | implemented
**Tier:** S / M / L
**Date:** YYYY-MM-DD

## Problem

## Options (at least 2)

## Chosen + why

## Implementation outline

## Test plan

## Rollback
```

Wait for approval before writing code.

## Things that look weird but are intentional

- **English code + mixed-language prose in RFCs / user-facing skills.**
  The author works bilingually; the skill prose is optimized for the
  actual operator, not future grep.
- **`scripts/stage18/_common.js` inlines helpers** instead of
  importing from a `stage16/` peer. `stage16/` was a one-off migration
  tool; it's excluded from the public release, so `stage18/` is
  self-contained.
- **`sync` has a manifest gate.** `push_manifest.json` (optional, per
  profile) whitelists which TSV rows may be pushed to Notion. This
  exists so historical / archived TSV rows don't accidentally land in
  a fresh Notion DB during a profile migration.
- **The check command is two-phase (prepare / apply).** Gmail reads
  happen in Claude via MCP, not via `googleapis`. Phase 1 writes a
  JSON batch plan; Claude fills the raw emails into a file; phase 2
  parses, classifies, and updates state. See
  [rfc/002-check-command.md](../rfc/002-check-command.md).

## Known sharp edges

- Two tests in `scripts/stage18/build_hub_layout.test.js`
  (`buildCandidateProfileBlocks: …`) are currently red against the
  shipped implementation. Known test/impl drift, tracked for cleanup.
  CI is configured to run them anyway — visible as a known-failure
  signal until addressed.
- The `check.js` → Notion Status mapping uses `"Phone Screen"`
  historically; some pipelines have renamed that status to `Interview`.
  If your DB uses `Interview`, update the mapping in `core/classifier.js`.
- Salary calc uses a simple COL multiplier per US state. Non-US
  locations fall back to 1.0. If expanding internationally, this is
  the module to extend.

## Contact

Questions about intent / direction: open an issue or ping the author
(see `package.json`). For bugs with reproducible output, a minimal
failing test case is the fastest path to a fix.
