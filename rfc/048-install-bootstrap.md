# RFC 048 — Install bootstrap: `npx` one-liner that wires skills into Claude Code

**Status**: accepted
**Related**: [BL-137](../private/backlog/BL-137.md), [BL-4](../private/backlog/BL-4-onboarding-ux-rewrite-fidbek-davida.md), [RFC 023](023-onboarding-skill-driven.md)
**Created**: 2026-05-27
**Accepted**: 2026-05-27 — user approved D1/D2/D3 as written.

## Problem

RFC 023 made `/onboard-profile` an AI-driven skill, on the assumption
that getting the skill into the user's Claude Code is a solved problem.
It is not. Live smoke 2026-05-27: David Shekunts ran the README's
"Quick start" verbatim (`git clone → npm install → claude →
/onboard-profile me`) and got `Unknown command: /onboard-profile`. He
then tried the alternative ("open Claude Code, say install skill from
URL"). Claude (Sonnet 4.6) cloned the repo, ran tests, reported "skill
installed" — but `/onboard-profile me` still returned `Unknown command`.
Claude Code restart did not help.

Three structural reasons, none of which were addressed by RFC 023:

1. **Skills live in the wrong place for Claude Code to discover them.**
   The repo ships skills under `skills/<name>/SKILL.md`. Claude Code
   only reads `~/.claude/skills/<name>/`, `~/.claude/plugins/<name>/`,
   and `<cwd>/.claude/skills/<name>/`. Cloning the repo into a random
   folder puts the SKILL.md nowhere Claude Code looks.
2. **`.gitignore` excludes `.claude/*` (except `.claude/agents/`).**
   So we could not just move skills to `.claude/skills/` and have them
   ship with the repo — git would not track them.
3. **Even when a Claude session "installs" the repo, it does not
   reliably copy SKILL.md to the right location.** The model guesses.
   David's smoke shows the guess fails.

This RFC fixes installation, not the skill itself. Skill content from
RFC 023 stands.

## Goals

- A non-technical user (PM, designer — not just developers) can start
  using the tool from a single sentence said to Claude Code, with no
  manual file moves, no copy-paste of paths, no understanding of
  `~/.claude/`.
- Updating the tool (`git pull` equivalent) does not require re-running
  any manual steps. The next Claude Code session picks up the new
  skill content automatically.
- One install path, not two. Manual `git clone` is documented as
  developer-only, with an explicit note that it does not wire up the
  skills.

## Non-goals

- Claude Code marketplace plugin packaging. (Out of scope until there
  is demand for a public listing.)
- Windows support. (Project targets macOS + Linux per CLAUDE.md.)
- GUI installer. (Out of scope.)
- Migrating existing profiles on reinstall. (Profiles live under
  `~/.ai-job-searcher/profiles/<id>/` and are preserved across
  reinstalls; install never touches them.)

## Decisions

### D1. Symlink, not copy

`~/.claude/skills/onboard-profile` → `~/.ai-job-searcher/skills/onboard-profile/`
(and same for `job-pipeline`, `interview-coach`).

Rationale: the user's constraint is "doesn't break on tool updates".
A symlink propagates updates automatically — `npx ... install` reruns
do `git pull` in `~/.ai-job-searcher/`, and the next Claude Code
session reads the new SKILL.md through the symlink. Copy would
require re-copy on every update; if user forgets to rerun install,
their skill silently goes stale.

Risk: if user deletes `~/.ai-job-searcher/`, symlinks dangle. Mitigation:
the install script is the only documented way to install or uninstall;
manual deletion is user error. We don't ship a `--uninstall` flag in v1.

### D2. Hardcode `~/.ai-job-searcher/` as the repo location

SKILL.md text references the engine via absolute paths
(`node ~/.ai-job-searcher/engine/cli.js ...`).

Rationale: the install location is a product decision (fixed folder,
user does not choose — confirmed by user). Since it's fixed, hardcoding
is correct. Alternatives rejected:

- **`process.env.AI_JOB_SEARCHER_HOME`** — requires editing user's
  shell rc files. Fragile across tmux panes, different shells,
  Claude Code's own subshell environment.
- **`fs.realpath(__filename)` from inside the skill** — SKILL.md is
  read as text by Claude, not executed. There is no "skill cwd" to
  resolve from. Would require a wrapper script and complicates
  Claude's invocation.

Concrete form in SKILL.md: any code block that runs an engine command
uses `~/.ai-job-searcher/engine/cli.js` (tilde-expanded by the shell).
Skill instructions tell Claude: "the repo lives at `~/.ai-job-searcher/`,
run all commands from there".

### D3. Distribute via `npx github:ymuromcev/ai-job-searcher`, not npm registry

User installs via:

```
npx -y github:ymuromcev/ai-job-searcher install
```

(Equivalent shorthand: `npx -y ymuromcev/ai-job-searcher install`.)

Rationale: `npm publish` adds a release step that's easy to forget. If
Jared cuts a feature and forgets to publish, every new user gets stale
code. "Doesn't break on tool updates" means removing the step that can
be forgotten. npx-from-GitHub reads `main` HEAD on each invocation;
there's nothing to forget.

Implementation: add `bin` field to `package.json` pointing at
`scripts/install.js`. npx clones the repo into its cache, runs the
install entrypoint.

Caveat: `npx` from GitHub re-clones into npm cache each install (or
hits cache). Slightly slower than registry install. Acceptable — install
is a one-time event per machine.

## What the install script does

`scripts/install.js`, invoked by `npx github:ymuromcev/ai-job-searcher install`:

1. **Preflight.**
   - Check Node ≥ 20. If not, print `Need Node 20+. Get it at https://nodejs.org. Then rerun this command.` and exit 1.
   - Check platform is darwin or linux. If not (i.e. win32), print `Windows is not supported. Use macOS or Linux.` and exit 1.
2. **Detect existing install.**
   - If `~/.ai-job-searcher/` exists and is a git clone of
     `https://github.com/ymuromcev/ai-job-searcher.git`:
     - Run `git -C ~/.ai-job-searcher pull --ff-only`.
     - Run `npm --prefix ~/.ai-job-searcher install`.
     - Re-verify symlinks (idempotent).
     - Print `Updated to latest version. No restart needed if Claude Code is closed; otherwise restart it.`
     - Exit 0.
   - If `~/.ai-job-searcher/` exists but is **not** our repo:
     - Print `~/.ai-job-searcher/ already exists and is not a clone of ai-job-searcher. Move or rename it, then rerun.`
     - Exit 1.
3. **Fresh install.**
   - `git clone https://github.com/ymuromcev/ai-job-searcher.git ~/.ai-job-searcher`.
   - `npm --prefix ~/.ai-job-searcher install`.
   - `npm --prefix ~/.ai-job-searcher test` — run smoke. If fail, print
     `Tests failed during install. Send this output to maintainer.` and exit 1.
4. **Wire skills.**
   - For each of `onboard-profile`, `job-pipeline`, `interview-coach`:
     - Source: `~/.ai-job-searcher/skills/<name>/`
     - Target: `~/.claude/skills/<name>/`
     - If target exists and is a symlink to our source → no-op.
     - If target exists and is a symlink to something else, or a regular
       directory, or a file → move to
       `~/.claude/skills/<name>.backup-<timestamp>/`, print
       `Existing <name> moved to <backup path>.`
     - Create the symlink.
5. **Create `~/.ai-job-searcher/.env`** by copying `.env.example`
   if `.env` does not exist. Don't overwrite if it does.
6. **Run user-detection from `cwd`.**
   - If user invoked `npx ...` from inside an existing `ai-job-searcher`
     clone (any clone, not just our `~/.ai-job-searcher/`), print:
     `It looks like you ran this from inside an existing clone at <cwd>.
     This install put the canonical copy at ~/.ai-job-searcher/. You can
     delete <cwd> if you don't need it.`
     - We do NOT auto-delete. User error gets a hint, not destruction.
7. **Final message.**
   ```
   Done.
   
   Close Claude Code and open it again.
   Then in a Claude Code chat type:
   
     /onboard-profile me
   ```

## Restart-required gotcha

Claude Code reads `~/.claude/skills/` at session start, not on demand.
After install, user must restart. Three lines of defense:

1. **Final install message says it explicitly** (point 7 above).
2. **README "Quick start" says it.**
3. **Soft guard inside the skill (optional, v2).** If user invokes
   `/onboard-profile` in a session where the skill exists but symlinks
   look fresh (mtime < 5 min), we could print "Did you just install?
   Restart Claude Code." — but Claude Code intercepts `/<name>` before
   the skill runs, so this fires inside the skill only after the skill
   was found. Not v1.

## File changes summary

New:

- `scripts/install.js` — the install entrypoint.
- `scripts/install.test.js` — unit tests for each step
  (preflight, detect-existing, symlink-wire, backup-conflict),
  with `fs` mocked.

Modified:

- `package.json` — add `bin: { "ai-job-searcher": "scripts/install.js" }`.
- `README.md` — rewrite "Quick start" to the one-sentence flow.
  Add "For developers" section linking to the manual `git clone` path.
- `skills/onboard-profile/SKILL.md` — replace any relative paths to
  engine/scripts with `~/.ai-job-searcher/...`. Add a "Repo location"
  line near the top.
- `skills/job-pipeline/SKILL.md` — same.
- `skills/interview-coach/SKILL.md` — same.

Not modified:

- `.gitignore` — `.claude/*` rule unchanged; we don't put skills
  there in the repo anymore. They live in `skills/` and get symlinked
  into `~/.claude/skills/` by the install script.

## Open questions

None. D1/D2/D3 closed by user decisions 2026-05-27.

## Definition of accepted

- User reads RFC, confirms D1/D2/D3 are what they want.
- User explicitly says "accepted" before implementation.

## Implementation plan (after accept)

Single PR, tier M:

1. `scripts/install.js` + tests.
2. `package.json#bin` wiring.
3. SKILL.md path rewrites (3 files).
4. README.md "Quick start" rewrite.
5. Code-review subagent on diff.
6. Smoke: run `npx -y file://$PWD install` in a clean
   `~/.ai-job-searcher/`-less environment (Docker container or tmp
   home), verify `/onboard-profile` is discoverable in Claude Code.
7. Final smoke: send PR link to David, wait for live confirmation.
