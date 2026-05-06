# Development principles

**This is the canonical place for architecture and development principles.**
Not CLAUDE.md (that file is for AI assistant behaviour rules only).

---

## Code-first principle

AI is used only where it genuinely adds value. Everything deterministic
must be implemented in engine code — not delegated to a skill or prompt.

**Use AI for:**
- Fit scoring and geo validation (requires judgment)
- Cover letter generation (requires natural language)
- Email classification (requires understanding context)

**Do NOT use AI for:**
- Pipeline steps that always run in sequence (e.g. scan → sync)
- Data transformations with known input/output shapes
- Filtering by rules expressible as code
- Any step where the output is fully determined by the input

Rule of thumb: if a user without Claude could run the feature by
following a fixed script, it belongs in the engine. If it requires
understanding or creativity, it belongs in the skill.

This ensures the pipeline works for users who don't use Claude at all.

---

## Adding a new pipeline step

If two commands should always run in sequence and neither step requires AI,
wire them as a `PIPELINE_HOOKS` entry in `engine/cli.js` — not in the skill.
See the `scan → sync` hook as the canonical example.

For the full recipe (file layout, registration, tests) see
[docs/runbooks/adding-pipeline-step.md](docs/runbooks/adding-pipeline-step.md).

---

## Task tiers

The same tier scheme used in `~/.claude/skills/dev-workflow/SKILL.md`
applies here. Pick the highest tier the task could plausibly fit.

| Tier | Scope | Gates | Examples |
|---|---|---|---|
| **XS** | < 20 lines, single file, isolated bugfix | smoke test only | typo, off-by-one, hard-coded-string fix |
| **M** | feature spanning 2+ files, no schema change | RFC optional, code review, tests | new flag, new adapter, new validator step |
| **L** | architecture, security, migration, multi-profile | RFC mandatory + maintainer approve, code review, `/security-review`, tests | TSV schema bump, new pipeline phase, profile-id rename, threat-model-touching change |

If unsure: pick the higher tier. Cost of unnecessary RFC ≪ cost of
unreviewed Tier L change.

---

## Doc-maintenance triggers

When you change code, the table below tells you which docs to update.
Pre-commit and CI enforce link integrity (`npm run docs:check`) and
language policy (`npm run docs:lang`); the audit script runs both
(`npm run docs:audit`).

| If you change… | …update | Why |
|---|---|---|
| `engine/cli.js` flags, `engine/commands/*.js` contracts | [docs/reference/cli.md](docs/reference/cli.md), [docs/reference/spec.md](docs/reference/spec.md) | reference docs lose value the moment they drift |
| TSV columns (`engine/core/applications_tsv.js`) | [docs/reference/tsv-schema.md](docs/reference/tsv-schema.md), CHANGELOG.md | schema-change events are the spine of project history |
| Notion property maps (`engine/core/notion_sync.js`, stage helpers) | [docs/reference/notion-schema.md](docs/reference/notion-schema.md), runbook for the affected DB | new operators reproduce setup from these |
| New ATS adapter under `engine/modules/discovery/` | [docs/runbooks/adding-adapter.md](docs/runbooks/adding-adapter.md) (recipe), [docs/architecture/overview.md](docs/architecture/overview.md) (adapter inventory) | mental model + recipe stay in sync |
| Profile setup (`scripts/stage18/`) | [docs/runbooks/new-profile.md](docs/runbooks/new-profile.md) | onboarding script is the source for that runbook |
| Multi-profile invariant (anything in `engine/core/profile_loader.js`, `.env` namespacing) | [docs/architecture/multi-profile.md](docs/architecture/multi-profile.md), ADR if the rule changes | ADR pointer matters for future readers |
| Architectural decision worth crystallizing | new ADR in [docs/architecture/adrs/](docs/architecture/adrs/) + index update | ADR is the durable artifact; RFC is the proposal |
| User-visible behaviour change | CHANGELOG.md (Keep a Changelog format) | release notes |
| Postmortem-worthy incident | incidents.md (root, anonymized) | blameless record |
| Anything PII-adjacent (names, profile-ids, emails, real company tier maps) | re-run `npm run docs:audit`, check `.git-hooks/pii-patterns.txt` | catch leaks before they ship |

If the change is Tier L, also: write the RFC in `rfc/`, get explicit
maintainer approve, then update the ADR / docs above before merging.

---

## Documentation conventions

- **English only** in the public repo. Private notes (`private/`,
  gitignored) may use any language. See RFC 018 §15 for the full policy.
- **Anonymized.** Real candidate names never appear in tracked files —
  use persona aliases (PM-Pete, Healthcare-Hannah). Profile-id literals
  on disk are accepted tech debt per
  [ADR-005](docs/architecture/adrs/005-profile-id-convention.md);
  newly authored docs use placeholders (`<id>`, `<PROFILE_ID>`).
- **Diátaxis taxonomy.** Every doc fits one of: explanation (`product/`,
  `architecture/`), how-to (`runbooks/`), reference (`reference/`),
  audit/historical (`audits/`). Mix-genre docs split.
- **Single source of truth.** Each fact lives in one file; others link.
- **Relative MD links only.** No wikilinks. Pre-commit blocks the latter
  in CI.
- **Frontmatter.** Every doc carries `--- title status type? tags? ---`.
  RFCs add `tier`, ADRs add `decided`.

---

## Workflow

For day-to-day cadence (when to write an RFC, when to run smoke,
multi-agent review pattern, security review levels) see the canonical
skill: `~/.claude/skills/dev-workflow/SKILL.md`. Trigger via
`/dev-workflow` or by mentioning a new feature / refactor / migration.

For the documentation map see [docs/README.md](docs/README.md).

---

## Backlog (private/, gitignored)

**Source of truth: `private/backlog/*.md`** — one file per task, with
frontmatter (`id`, `title`, `status`, `priority`, `tier`, `created`,
`refs`, `tags`, optional `closed`, `blocked_by`). Body = `## Context`,
`## Plan`, `## Notes`.

**Hub: `private/backlog.base`** — Obsidian Bases file with 4 table views
(Active / Blocked / Archived / All) + a Cards view. The first column
**Open** is `file.name` — click to open the task. Other columns are
frontmatter fields, editable inline by double-click.

**Add a new task** (operator):
1. Open `private/backlog.base` in Obsidian → click `+ New` (top right).
2. Fill cells: Title, Priority (P0–P3), Tier (XS/M/L), Tags.
3. Status defaults to `planned`. Save (`Cmd-S`).
4. The new file appears under `private/backlog/` — Claude can read it
   immediately.

**Work a task** (Claude):
1. Read `private/backlog/<id>.md` for full context.
2. Update frontmatter as work progresses:
   - `planned → in_progress` when starting
   - add `blocked_by: <reason>` + `status: blocked` if waiting
   - `status: done` + `closed: YYYY-MM-DD` when finished
3. Append progress notes to `## Notes` section.
4. Don't delete archived tasks — they're history.

**Title doubles as summary** — keep it short and self-explanatory; the
operator scans the table by Title alone.

**Template:** `private/backlog/_template.md` (excluded from views via
`file.name != "_template"`). Copy when starting from outside Bases.

**Original wall-of-text source archived** at
`private/audit-internal/BACKLOG-source-2026-05-05.md` (kept verbatim,
not maintained — only for recovering content lost in the migration).
