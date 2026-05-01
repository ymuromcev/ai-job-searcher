# AI Job Searcher

A personal AI agent for job search. One engine, many profiles. Built
on [Claude Code](https://www.anthropic.com/claude-code) + a small
TypeScript-free Node toolkit; all the AI lives behind the CLI.

[![tests](https://github.com/ymuromcev/ai-job-searcher/actions/workflows/test.yml/badge.svg)](https://github.com/ymuromcev/ai-job-searcher/actions/workflows/test.yml)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

## What it is

A job-search pipeline that scans ATS feeds and job boards, filters
roles against my preferences, drafts tailored cover letters, pushes
everything into Notion as a Kanban pipeline, and reads my Gmail to
move cards when recruiters reply.

I built it for myself. When a family member also needed a job search,
I rebuilt it so one codebase could serve multiple candidates without
code duplication.

## Evolution

It started as a single-user Python + AppleScript Frankenstein —
hardcoded to me, hardcoded to one Notion workspace. After ~1 month
of daily use and a clear picture of what actually mattered, I
rewrote it from scratch:

- **v1 (prototype)** — single-user, monolithic. Shipped fast, was
  good enough to land interviews, accumulated drift as fast as I
  shipped features.
- **v2 (this repo)** — engine cleanly split from profile data, so one
  deployment serves multiple candidates. Per-profile Notion DBs,
  per-profile resume archetypes, per-profile salary models.
  Onboarding a new candidate is a 10-minute markdown questionnaire
  (see [Stage 18](scripts/stage18/README.md)), not a day of copy-paste.

The old v1 codebases are not public — they predate the clean-slate
rewrite and carry personal data in their history.

## Architecture

```
engine/              shared code — no PII, no personal preferences
  modules/
    discovery/       ATS / board adapters (Greenhouse, Lever, Ashby,
                     SmartRecruiters, Workday, CalCareers, USAJOBS,
                     RemoteOK). Auto-registered.
    generators/      Resume DOCX / PDF, cover letter PDF.
    tracking/        Gmail delegation (via Claude MCP, not OAuth-on-disk).
  core/              filter / dedup / validator / notion_sync /
                     company_resolver / salary_calc / url_check /
                     jd_cache / email_* / fit_prompt / profile_loader
  commands/          scan · prepare · sync · validate · check
  cli.js             dispatch + arg parse
profiles/
  _example/          template profile, synthetic data (committed)
  <id>/              personal profile (gitignored)
data/                shared master pool (jobs.tsv, companies.tsv) — gitignored
scripts/stage18/     onboarding wizard for new profiles
skills/job-pipeline/ Claude skill that drives the flow
rfc/                 design docs (001-core split, 002-check, 004-onboarding)
```

**Mental model:** *Profile = data. Engine = service.* Anything in
`engine/` must work for any candidate; anything candidate-specific
lives in `profiles/<id>/`.

## Features

- **Scan** — Poll ~8 ATS / job-board adapters for roles at target
  companies. Dedup across profiles via shared `data/jobs.tsv`.
- **Filter** — Rule-driven (title / company / location blocklists,
  level caps, per-company active caps). Retroactive sweeps via
  `validate`.
- **Prepare** — Two-phase (pre / commit) with a human review gate.
  Assigns resume archetype, drafts cover letter with per-profile
  voice, computes a salary band from Tier × Level × cost-of-living.
- **Sync** — Push / pull against Notion. Defaults to dry-run;
  `--apply` writes. Uses Notion SDK v5 (`dataSources.query`).
- **Check** — Reads Gmail replies via Claude MCP, classifies
  (rejection / interview invite / info request / recruiter
  outreach), updates Notion status and adds comments.
- **Onboarding wizard** — A markdown intake form generates
  `profile.json` / `filter_rules.json` / `resume_versions.json` /
  cover letter templates, provisions per-profile Notion databases,
  and (optionally) imports a prior hand-rolled prototype.

## What this tool does NOT do

Set expectations explicitly:

- **Doesn't auto-apply.** It drafts cover letters and surfaces matches
  in Notion; you decide which ones to send.
- **Doesn't auto-reply to recruiters.** Email is read-only (Gmail
  OAuth scope `gmail.readonly`). `check` reads replies to update
  Notion status; the tool never sends mail.
- **Doesn't poll Gmail continuously.** `check` runs only when invoked
  (or once-a-day on a cron in `--auto` mode if you wire it up). No
  background daemon, no realtime watcher.
- **Doesn't store credentials in the repo.** Tokens live in gitignored
  `.env`, namespaced per profile.
- **Doesn't share profile data across candidates.** Each
  `profiles/<id>/` is gitignored and isolated; the only shared state
  is the master jobs/companies pool in `data/`.

## Quick start

```bash
git clone https://github.com/ymuromcev/ai-job-searcher.git
cd ai-job-searcher
npm install
npm run setup-hooks          # installs the PII pre-commit guard
npm test                     # 686 tests, no network required
```

That gets the engine + tests working. To actually run a job search you
need a profile, which means going through the onboarding wizard — the
`profiles/_example/` directory ships template *shapes* (each file has a
`.example` suffix), not a runnable profile.

## First profile

Pick a short id (e.g. `me`), then:

1. **Fill in the intake form.** Copy `scripts/stage18/intake_template.md`
   somewhere outside the repo, fill sections A–K, save as e.g.
   `~/intake_filled.md`. Any language works (yes/no/да/нет both fine).
   The first field is `profile_id` — a short slug you choose:
   lowercase letters, digits, `-`, `_`. It becomes the directory name
   (`profiles/<id>/`) and the env-var prefix (e.g. `ME_NOTION_TOKEN`).
2. **Add your Notion token to `.env`.** See
   [docs/notion-setup.md](docs/notion-setup.md) for how to create the
   integration and where to grant it page access.
   ```
   ME_NOTION_TOKEN=ntn_...
   ```
3. **Parse + deploy.** Both scripts default to `--dry-run`; pass
   `--apply` to write.
   ```bash
   node scripts/stage18/parse_intake.js --input ~/intake_filled.md --apply
   node scripts/stage18/deploy_profile.js --profile me --apply
   ```
4. **First scan.**
   ```bash
   node engine/cli.js scan --profile me
   ```

Full wizard runbook: [scripts/stage18/README.md](scripts/stage18/README.md).

## Commands

```bash
node engine/cli.js <command> --profile <id> [flags]
```

| Command | Purpose |
|---|---|
| `scan` | Poll all configured ATS adapters; append new jobs to `data/jobs.tsv`. |
| `validate` | Re-apply filter rules to the existing pool (catches retroactively-blocked jobs). |
| `prepare` | Two-phase: pre (assign archetype + draft cover letter) → commit (write artifacts). |
| `sync` | Push/pull against per-profile Notion DBs. Defaults to dry-run; `--apply` writes. |
| `check` | Read Gmail replies via Claude MCP and update Notion status. |
| `indeed-prep` | One-off helper for Indeed scraping prep (manual login flow). |
| `answer` | Generate or reuse application answers and push back to Notion Q&A DB. |

`node engine/cli.js --help` prints the same list with full flag docs.

## Discovery adapters

Nine adapters ship out of the box; enable them per profile in
`profile.json.modules`:

| Module | Source |
|---|---|
| `discovery:greenhouse` | Greenhouse-hosted careers pages |
| `discovery:lever` | Lever-hosted careers pages |
| `discovery:ashby` | Ashby-hosted careers pages |
| `discovery:smartrecruiters` | SmartRecruiters-hosted careers pages |
| `discovery:workday` | Workday tenant feeds |
| `discovery:remoteok` | RemoteOK public feed |
| `discovery:usajobs` | USAJOBS API (federal jobs; needs free API key) |
| `discovery:calcareers` | CalCareers (California state jobs) |
| `discovery:indeed` | Indeed (manual login prep via `indeed-prep`) |

New adapters live under `engine/modules/discovery/` and auto-register
via `index.js`.

## Requirements

- Node 20+
- A Notion integration token per profile (the pipeline writes to
  per-profile databases it creates during onboarding)
- Claude Code for the end-to-end flow (the `job-pipeline` skill drives
  `prepare` → human-in-the-loop review → `sync`). The CLI itself
  runs without Claude for scan / validate / filter use cases.

## Secrets

All tokens live in a root `.env`, namespaced by profile id:

```
ME_NOTION_TOKEN=ntn_...
ME_USAJOBS_API_KEY=...
ME_USAJOBS_EMAIL=...
```

The prefix is stripped automatically when the CLI loads the profile,
so engine code just sees `NOTION_TOKEN`. Multiple profiles in one
`.env` don't collide.

`.env` is gitignored; a pre-commit hook (`.git-hooks/pre-commit`,
installed by `npm run setup-hooks`) scans diffs for common leak
patterns as backup.

## Development

```bash
npm test               # Node's built-in test runner, no framework
```

- Pure helpers are the default; side-effectful code lives in
  `commands/` and `scripts/`.
- Network calls go through `modules/discovery/_http.js#defaultFetch`
  (`ctx.fetchFn` in tests) — never `fetch` directly.
- Architectural changes go through an RFC under `rfc/` before code.
- PRs welcome but please open an issue to discuss direction first —
  this is a personal tool, not an open-source product.

See [CLAUDE.md](CLAUDE.md) for agent-facing rules,
[docs/ai-assistant-notes.md](docs/ai-assistant-notes.md) for the
longer "how this codebase thinks" note.

## License

[MIT](LICENSE) © 2026 Jared Moore

## Author

**Jared Moore** — Senior AI Product Manager. Bay Area.
Contact: [ymuromcev@gmail.com](mailto:ymuromcev@gmail.com)
