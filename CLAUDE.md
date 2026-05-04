# AI Job Searcher — Claude Code notes

Project-level instructions for Claude Code (or any AI agent) working in
this repo. Human-facing overview lives in [README.md](README.md);
deeper AI context lives in [docs/ai-assistant-notes.md](docs/ai-assistant-notes.md).

## What this project is

A multi-profile job search pipeline. One engine, many profiles.

- `engine/` — all shared code. No personal data. Must stay PII-free.
- `profiles/<id>/` — per-candidate overlay (resume archetypes, cover
  letter voice, Notion DB ids, filter rules, applications TSV).
  Everything under `profiles/` **except** `profiles/_example/` is
  gitignored — that is the contract.
- `profiles/_example/` — template, synthetic data only, committed.
- `data/` — shared master pool (jobs.tsv, companies.tsv). Gitignored.
- `rfc/` — design docs. Add one for architectural changes before coding.
- `scripts/stage18/` — onboarding wizard for new profiles.
- `skills/job-pipeline/` — Claude skill that drives the end-to-end flow.

## Running

All CLI commands require `--profile <id>`:

```
node engine/cli.js scan --profile <id>
node engine/cli.js prepare --profile <id> --phase pre --batch 20
node engine/cli.js prepare --profile <id> --phase commit --results-file results-<ts>.json
node engine/cli.js check --profile <id> --prepare
node engine/cli.js check --profile <id> --apply
node engine/cli.js validate --profile <id>
node engine/cli.js sync --profile <id>
```

`sync` defaults to dry-run. Add `--apply` to write.

## Secrets

Namespaced in root `.env` by profile id:

- `{PROFILE_ID_UPPER}_NOTION_TOKEN`
- `{PROFILE_ID_UPPER}_GMAIL_*`
- `{PROFILE_ID_UPPER}_USAJOBS_*`

See [.env.example](.env.example). **Never** commit `.env` or prompt the
user for tokens inline — ask them to add to `.env` and read via
`profile_loader.loadSecrets(profileId, env)`.

## Tests

```
npm test          # Node's built-in test runner, no framework
```

Add a smoke test for every new module. Mock the network (no real
fetches in unit tests). Pure helpers are the default — side-effectful
code is isolated in `commands/` and `scripts/`.

## Working rules (for Claude / any AI assistant)

> **Architecture and development principles belong in
> [DEVELOPMENT.md](DEVELOPMENT.md), not here.**
> This file is for AI assistant behaviour rules only.

- **Don't invent product decisions.** If a change touches user-facing
  behaviour (pipeline steps, filters, what gets archived vs kept), ask
  before acting. Propose; don't execute.
- **Don't modify personal data.** `profiles/<id>/` (non-example) is
  off-limits unless the user explicitly asks.
- **Don't touch `.env` or read secrets.** If a task needs a token, tell
  the user what env var to add and read it at runtime.
- **Respect RFC-gating.** Architectural or multi-file behaviour changes
  go through `rfc/NNN-title.md` and explicit approval before code.
- **Keep PRs small.** One concern per change. Add a test.
- **Code + comments + var names in English.** User-facing docs stay in
  whatever language the project already uses.

## Onboarding a new profile

Use the Stage 18 wizard rather than copying an existing profile by
hand. See [scripts/stage18/README.md](scripts/stage18/README.md).

## Pre-commit hook

`npm run setup-hooks` installs a PII guard that scans the staged diff
for common leak patterns (emails, phone, real Notion UUIDs, token
prefixes). Run it once after clone. If the hook flags a false
positive, `git commit --no-verify` is available — but if in doubt,
double-check rather than skip.

## What's out of scope

- Hosted / SaaS deployment. Self-host only.
- Onboarding flows for non-technical users. This is a personal tool
  first; the code is public for transparency, not as a product.
- Windows support. Targets macOS + Linux (Node 20+).
