# AI Job Searcher — Claude Code notes

Project-level instructions for Claude Code (or any AI agent) working in
this repo. Human-facing overview lives in [README.md](README.md);
architecture detail lives in [ARCHITECTURE.md](ARCHITECTURE.md) and
[docs/architecture/](docs/architecture/).

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

## Post-merge cleanup

After a PR is merged, run `/post-merge-cleanup` (slash command) or
`~/.claude/hooks/post_merge_cleanup.sh` directly. Defaults to
`--dry-run`; pass `--apply` to actually delete the local branch +
worktree. Remote branch is auto-deleted on merge (since 2026-05-17).

## Mental model for AI assistants

> **Profile = data. Engine = service.**

Operational guidance for an agent working in this repo. Architecture
detail lives in `ARCHITECTURE.md` and `docs/architecture/`; this
section is just the things to keep in your head while editing code.

- **Read `profile.json` first.** Every command takes `--profile <id>`
  and the loader is the single read-point for `profiles/<id>/`. The
  loader validates the id (`^[a-z][a-z0-9_]{1,31}$`, no path traversal,
  no reserved names), normalizes `filter_rules.json` into the flat
  shape, and reads namespaced secrets from `.env`. Nothing else in
  the codebase touches `profiles/` directly.
- **TSV is the ledger.** `profiles/<id>/applications.tsv` is canonical
  per-profile state. Notion is a view on top. Do not write the TSV
  directly from new code paths; go through `engine/core/applications_tsv.js`.
- **`Inbox` is TSV-only.** Fresh `scan` rows default to `status="Inbox"`
  with empty `notion_page_id`. The transition `Inbox → To Apply` and
  Notion page creation happen atomically inside `prepare --phase commit`.
  Notion never sees `Inbox`. See [RFC 014](rfc/014-status-split-new-vs-toapply.md).
- **`prepare` is two-phase.** Phase 1 (`--phase pre`) is a
  deterministic CLI: filter, URL-check, JD-fetch, salary-calc, write
  `prepare_context.json`. Phase 2 is the `job-pipeline` skill (LLM)
  reading that JSON and writing a `results.json` decision plan. Phase
  3 (`--phase commit`) is again a deterministic CLI: read the results,
  mutate the TSV, generate artifacts, create the Notion page.
- **`check` writes JSON for MCP.** Gmail reads happen inside Claude
  via the Gmail MCP for the two-phase flow. `check --prepare` writes
  the batch plan to `profiles/<id>/.gmail-state/check_context.json`;
  the operator's Claude session writes `raw_emails.json` next to it;
  `check --apply` consumes both. The `--auto` variant exists for cron
  and fetches over IMAP using a per-profile app-password
  (`<ID>_GMAIL_USER` + `<ID>_GMAIL_APP_PASSWORD` — RFC 021).
- **`sync` is pull-only since 2026-05-04.** Notion → TSV reconcile
  only. The push phase, the Stage 16 `push_manifest.json` gate, and
  the Inbox callout updater were all removed in commit `4f85ed2`.
  New Notion pages are created exclusively by `prepare`'s commit
  phase. Do not re-add a push path without an RFC.
- **Pure helpers, isolated side effects.** `core/*` and most of
  `scripts/stage18/*` are pure functions over in-memory objects. The
  filesystem, network, and `process.exit` live in `commands/*` and
  the CLI glue. New helpers default to pure; tests assume it.
- **Notion SDK v5 footguns.** `databases.create({properties})` silently
  drops the properties — use `initial_data_source: { properties }`.
  `databases.query` is gone — use `dataSources.query`. Empty-string
  url / email / phone values fail validation in `pages.update` —
  `buildProperties` filters them out, do not undo that.
- **Adding things, the short version.** New adapter →
  `engine/modules/discovery/<name>.js`, use `ctx.fetchFn` (never raw
  `fetch`), add a test with a faked `fetchFn`, opt the profile in via
  `modules: ["discovery:<name>"]`. New command → `engine/commands/<name>.js`,
  register in `engine/cli.js` `KNOWN_COMMANDS`, add arg-parse + happy-path
  tests. New profile → run `scripts/stage18/`; do not hand-copy.
- **Behaviour change touching multiple files.** Add an RFC at
  `rfc/NNN-title.md` first and wait for explicit approval before
  writing code. Tier M / L gates this; see `DEVELOPMENT.md`.

For architecture details see [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/architecture/](docs/architecture/).

## What's out of scope

- Hosted / SaaS deployment. Self-host only.
- Onboarding flows for non-technical users. This is a personal tool
  first; the code is public for transparency, not as a product.
- Windows support. Targets macOS + Linux (Node 20+).
