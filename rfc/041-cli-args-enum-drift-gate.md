---
id: RFC-041
title: Pre-commit gate — CLI arg-enum / behaviour drift between cli.md and code
status: approved
approved: 2026-05-19
author: Claude (via Jared)
tier: M
created: 2026-05-19
refs:
  - BL-104
  - BL-97
  - BL-98
  - BL-80
---

# RFC 041 — Pre-commit gate for CLI arg-enum / behaviour drift

## Approval (2026-05-19)

Approved per user, all open-question recommendations accepted:

- **§6 AST vs regex** — regex with escape hatch (`// cli-args-gate-ignore`);
  AST is a follow-up only if false-positive rate is high after a month.
- **§6 Warn vs hard-fail first release** — two-commit migration: ship
  warn-only (`CLI_ARGS_GATE_MODE=warn`) first, flip to `block` in the
  immediate follow-up commit once baseline is clean.
- **§6 Bullet-style enum annotations** — out of scope for v1; trust
  the synopsis line and pipe-table cell only.
- **§6 Behaviour-level drift** — separate BL ticket, not this RFC.

Implementation tracked under BL-104; BL closes on the block-mode flip
commit (not on warn-mode or baseline-fix commits).

## 1. Problem

The repo has two pre-commit gates aimed at keeping `engine/` and
`docs/reference/cli.md` in lockstep:

- **BL-97 — CHANGELOG-required-for-engine.** If a non-test file under
  `engine/` is staged, `CHANGELOG.md` must also be staged. Catches
  silent code changes that never show up in release notes.
- **BL-98 — KNOWN_COMMANDS ↔ cli.md sync.** Diffs the list of command
  names in `engine/cli.js#KNOWN_COMMANDS` against the `### <cmd>`
  headings in `docs/reference/cli.md`. Catches adding/removing whole
  commands without touching the reference.

Both gates pass at **command-name** granularity. Neither inspects
**what arguments a command accepts** or **what enum values those
arguments allow**.

### BL-80 walkthrough — the gap

In BL-80 we removed `--mode weak-fallback` from `engine/commands/prepare.js`
(and the matching error message in `engine/cli.js` that listed valid
modes). The intent was to collapse `prepare --phase pre` down to two
modes — `fresh` and `topup` — because the autonomous loop no longer
needed a third pass.

What actually happened in the diff:

1. `engine/commands/prepare.js` — `weak-fallback` branch deleted. ✅
2. `engine/cli.js` — `error: unknown --mode "..." (valid: fresh, topup, weak-fallback)` left intact (oversight). ❌
3. `docs/reference/cli.md` — `--mode <fresh|topup|weak-fallback>` synopsis, three-bullet description, and example block referencing `--mode weak-fallback` all left intact. ❌
4. `CHANGELOG.md` — entry added. ✅ — BL-97 passed.
5. `KNOWN_COMMANDS` — unchanged. ✅ — BL-98 passed.

Both existing gates green-lit the commit. The drift was only caught
later when a SKILL invocation followed the docs, ran
`prepare --phase pre --mode weak-fallback`, and got `unknown --mode`
back from the CLI — confusing because the error message itself still
advertised the removed value as valid.

The hole: there is no gate that reads, for each command, *the set of
flags the code accepts and the enum values it validates* and compares
that to *the flags and enum values the reference doc documents*.

This RFC fills that hole as a separate gate so the failure mode in
BL-80 becomes a blocked commit with a precise message.

## 2. Decision

Add a third gate, `scripts/check_cli_args_sync.js`, distinct from
BL-98's command-name check. The gate runs in pre-commit and CI, fails
the commit on detected drift, and warns (without failing) when its
own heuristics cannot analyse a command.

Scope of the gate, in priority order:

1. **Flag drift per command.**
   - Code-only flag → fail: `undocumented flag "--foo" in command "prepare"`.
   - Doc-only flag → fail: `stale doc — flag "--bar" documented for "prepare" but not referenced in code`.
2. **Enum-value drift per flag.**
   - For flags whose accepted values are a literal closed set in code
     (e.g. `--mode fresh|topup`, `--phase pre|commit`), extract that
     set and compare to the documented set.
   - Fail when the two sets differ: `--mode accepts [fresh, topup] in code but docs list [fresh, topup, weak-fallback]`.
3. **"Could not analyse" path.**
   - When the heuristic cannot statically determine the enum set
     (dynamic construction, computed strings, etc.), the gate
     **warns** and exits 0 for that flag. The flag-presence check
     still applies.

Out of scope, called out explicitly:

- **Semantic / behaviour drift inside a command body.** E.g.
  `--mode fresh` now silently skips an upstream step. That is
  behaviour-level, not arg-level. A future test-level gate covers
  this; this RFC does not.
- **JSDoc / schema-driven generation of cli.md.** A full
  generate-docs-from-code approach is a separate L-tier project. The
  scope here is verification, not generation.
- **Cross-doc enum drift** (e.g. `docs/reference/spec.md` listing the
  same enum). The gate only diffs code ↔ `cli.md`. Other reference
  docs are covered by their own gates or by their own RFCs.

## 3. Implementation

### 3.1 File layout

- `scripts/check_cli_args_sync.js` — new gate script.
- `.git-hooks/pre-commit` — append a stanza that calls the new gate
  after the existing PII / secret block, after BL-97 / BL-98 stanzas
  if present, scoped to the staged file set (see 3.4).
- `.github/workflows/test.yml` — add a `Check CLI args sync` step
  after `Lint` and before `Run tests`. Runs on push to `main` and on
  every pull request.

### 3.2 Code-side parse (per command)

For each `cmd` in `KNOWN_COMMANDS`:

1. Read `engine/commands/<cmd>.js` (one file per command, by
   convention — see `engine/commands/prepare.js`).
2. Extract the set of flags the command references. Heuristic regex
   set, run in order; first hit wins:
   - `args\["--([a-z][a-z0-9-]*)"\]` (object-style access)
   - `args\.([a-z][a-z0-9-]*)` filtered against the known
     `parseArgs` schema in `engine/cli.js#PARSE_OPTIONS` (so we don't
     catch arbitrary identifiers)
   - `argv\.includes\("--([a-z][a-z0-9-]*)"\)` (positional-style
     parsing if present)
   - `--([a-z][a-z0-9-]*)` inside template literals in stderr
     messages (catches help text and validation errors)
3. Extract enum values per flag. Pattern set:
   - `if \([a-zA-Z_]+ !== "([^"]+)" && [a-zA-Z_]+ !== "([^"]+)"` and similar inequality chains
   - `\[[\s"',]*"fresh"[\s"',]*,[\s"',]*"topup"[\s"',]*\]` — explicit array literals assigned to a name like `VALID_MODES`
   - `valid:\s+[a-z, ]+` inside stderr messages — e.g. `error: unknown --mode "${mode}" (valid: fresh, topup)`
   - When two of the above sources agree, that's the canonical set.
     When they disagree, the gate reports the disagreement as
     drift (the user has to reconcile inside the file).
4. **Escape hatch.** Any line containing `// cli-args-gate-ignore` is
   skipped by all regex patterns. Use this on intentionally dynamic
   constructions. The gate reports the count of escape-hatched lines
   per command at the end (so the hatch doesn't quietly grow).

The regex set lives in a `HEURISTICS` constant at the top of the
script with a comment per pattern explaining what it catches. The
script does *not* parse JS with an AST — see Open questions §6.

### 3.3 Doc-side parse

For each `### <cmd>` heading in `docs/reference/cli.md`:

1. Read the section body up to the next `### ` or end-of-file.
2. Extract documented flags from:
   - Synopsis line — `node engine/cli.js prepare --profile <id> --phase <pre|commit> [--mode <fresh|topup>] ...`. Tokens shaped `--<name>` or `[--<name> ...]`.
   - Markdown table rows where the first column starts with `` ` `` and contains `--<name>` (the flags table convention used today, e.g. `| `--mode <fresh\|topup>` | string | ... |`).
3. Extract enum values from the same tokens:
   - Synopsis: `--mode <fresh|topup>` → `{fresh, topup}`. Also accept
     `<fresh|topup|weak-fallback>`.
   - Table cell: `` `--mode <fresh\|topup>` `` (escaped pipe). The
     parser must unescape `\|` before splitting.
   - Bullet lists where a flag is described with `(allowed: a, b, c)`
     or similar — optional, see §6.

### 3.4 Pre-commit scoping

The gate only runs when at least one staged file is in the watched
set:

- `engine/cli.js`
- `engine/commands/*.js` (excluding `*.test.js`)
- `docs/reference/cli.md`

If none of those are staged, the gate exits 0 immediately. Same
pattern as BL-98.

### 3.5 Exit code semantics

- `0` — pass, or no watched files staged.
- `1` — drift detected. Print all findings, block commit.
- `2` — heuristic warning(s) only. Print warnings, do not block.

The hook treats `2` as success (warning printed to stderr). CI in
GitHub Actions also treats `2` as success but echoes a `::warning::`
annotation so the PR shows a yellow note.

### 3.6 Output format

On drift:

```
[cli-args-sync] drift detected:

  prepare:
    flag mismatch:
      - documented but not in code: --weak-fallback
    enum mismatch on --mode:
      code:  [fresh, topup]
      docs:  [fresh, topup, weak-fallback]

  check:
    flag mismatch:
      - in code but not documented: --since

  fix: update docs/reference/cli.md or the command file so both agree.
       bypass (discouraged) with `git commit --no-verify`.
```

On warning-only:

```
[cli-args-sync] could not auto-detect enum for some flags:

  answer: --phase — too dynamic to extract literal set (skipped).

  resolve by adding an explicit `// cli-args-gate-ignore` on the
  line, or by rewriting the validation to a literal `===` chain.
```

## 4. Tests

`scripts/check_cli_args_sync.test.js` — Node's built-in test runner.
Fixtures use small synthetic command files and a minimal `cli.md`
fragment, both rooted at a tmp dir; the script accepts
`--root <path>` for testability.

Cases:

1. **No watched files staged.** Stub `git diff --cached --name-only`
   to return only `README.md`. Exit 0, no output.
2. **Happy path — code and docs agree.** Fixture with `prepare.js`
   accepting `--phase <pre|commit>` and `--mode <fresh|topup>`,
   matching cli.md section. Exit 0.
3. **Code-only flag.** Code references `--new-flag`, docs do not.
   Exit 1, message names the flag and command.
4. **Doc-only flag.** cli.md documents `--ghost-flag`, code does
   not. Exit 1, message names the flag and command.
5. **Enum drift — value removed from code, still in docs.** The
   BL-80 case. Exit 1, message shows both sets.
6. **Enum drift — value added to code, not in docs.** Mirror case.
   Exit 1.
7. **Escape hatch respected.** Line marked
   `// cli-args-gate-ignore` ignored by the flag-detection regex.
   Exit 0.
8. **Heuristic gives up — warning only.** Command file with
   `const validModes = computeModes()`; gate cannot extract enum.
   Exit 2, message lists `(skipped)`.
9. **Multiple commands, mixed results.** Three commands; one drifts,
   two are fine. Exit 1, only the drifting command is reported.
10. **Disagreement between code-side sources.** `if (m !== "fresh" && m !== "topup")` paired with stderr `valid: fresh, topup, weak-fallback`. Exit 1, message names the in-file disagreement.

Coverage target: every regex in the `HEURISTICS` block exercised by
at least one positive and one negative test.

## 5. Risks

- **Heuristic false positives.** Regex-based flag detection can
  catch tokens that are not flags (e.g. `--foo` in a doc comment
  inside a command file). The escape hatch and the
  `PARSE_OPTIONS`-cross-check guard most cases, but the v1 will
  almost certainly need tuning. Mitigation: ship as warn-only for
  the first commit (§6 open question) so the user can land tuning
  fixes without blocking work.
- **Heuristic false negatives.** A genuinely dynamic enum (computed
  list from a constant elsewhere in the codebase) silently exits 2.
  Mitigation: warning is printed and CI surfaces it as a `::warning::`
  annotation; user can choose to refactor for a literal list.
- **Doc parse fragility.** `cli.md` is hand-written prose with tables
  and code blocks. Markdown changes (e.g. switching from pipe-tables
  to bullet lists) can break the doc-side parser. Mitigation: the
  doc-side parser is conservative — it only recognises the two
  current shapes (synopsis token and pipe-table cell). A `cli.md`
  rewrite that drops both is a deliberate decision and would be
  caught by the existing format-check / link-check gates first.
- **Hook latency.** Reading every command file + cli.md on every
  commit. Cheap (single-digit ms per file on this repo size), but a
  pre-commit author who runs `git commit` 50 times a day will
  notice. Mitigation: scoping in §3.4 means the gate only runs on
  commits that touch the watched files.
- **Bypass discipline.** `--no-verify` silently skips the gate, same
  as every other pre-commit check. Documented in the existing hook
  footer; CI re-runs the gate on push, so a `--no-verify` commit
  still fails on PR.

## 6. Open questions

- **AST vs regex for code-side parse.** This repo uses a hand-rolled
  `parseArgs`-based loop in `engine/cli.js`; commands access flags
  through a small set of patterns. Full AST parsing (acorn / esprima)
  is over-engineering for the v1. **Recommendation: regex with the
  escape hatch, AST as a follow-up if false-positive rate is high
  after a month of use.**
- **Warn vs hard-fail for the first release.** A clean baseline
  matters more than catching the first new drift. **Recommendation:
  ship `check_cli_args_sync.js` and the hook stanza behind an env
  flag (`CLI_ARGS_GATE_MODE=warn`) for the first commit, then flip
  to `block` in the immediate follow-up commit once the baseline is
  clean. Two-commit migration, no live wedge.**
- **Bullet-style enum annotations.** Some flags in cli.md are
  described in a bullet that says "Used by `--phase pre`. `topup`
  and `weak-fallback` append..." — the enum is implied, not in a
  pipe-separated synopsis. v1 ignores prose bullets; the parse
  trusts the synopsis line and the table cell. **Recommendation:
  out of scope for v1, revisit if drift slips through this path.**
- **Behaviour-level drift (the `--mode fresh` skips Step 7 case).**
  Not arg-level. **Recommendation: track as a separate BL ticket
  when the user wants it; would need either a snapshot test of the
  decision tree or per-step behaviour assertions. Not this RFC.**

## 7. Migration

1. **Baseline.** Run `scripts/check_cli_args_sync.js` once against
   `main` (or the active feature branch). Collect every reported
   drift. Fix it as one or more `docs:` / `chore:` commits before
   the gate goes live. Include the BL-80 leftovers (`--mode weak-fallback`
   mentions still present in cli.md or in the stderr message in
   `engine/cli.js`) in this baseline pass.
2. **Land the gate in warn-only mode.** Commit 1: add
   `scripts/check_cli_args_sync.js`, its tests, and the hook
   stanza with `CLI_ARGS_GATE_MODE=warn` default. CI adds the step
   but does not fail on exit 1 (treats it as warning).
3. **Flip to block.** Commit 2 (same PR or immediate follow-up):
   change the default to `block`, treat exit 1 as fail in CI. By
   this point, the baseline is clean and any new drift is a real
   regression.
4. **CHANGELOG.** Two entries — one per commit — under `[Unreleased]`
   in the `### Added` and `### Changed` sections. BL-97 gate will
   require it anyway.
5. **README.** No new top-level inventory change; the gate is a
   developer tool, not a user-facing module. Mention in `CLAUDE.md`
   under the existing pre-commit section if appropriate.

## 8. Approval checklist

- [ ] Scope of the gate (flag presence + literal-enum drift only)
      matches what BL-104 asked for. Semantic / behaviour drift
      explicitly out of scope.
- [ ] Regex-based v1 with escape hatch + warning exit code accepted
      as the right trade-off vs full AST parsing.
- [ ] Warn-then-block two-commit migration accepted vs single-commit
      hard-fail.
- [ ] Pre-commit scoping (only run when watched files staged)
      accepted — same pattern as BL-98.
- [ ] CI integration in `.github/workflows/test.yml` as a new step
      between `Lint` and `Run tests` accepted vs running inside the
      existing `npm test` target.
- [ ] Out-of-scope items (behaviour drift, JSDoc-driven generation,
      cross-doc enum drift in `spec.md` / `tsv-schema.md`) accepted
      as separate future tickets, not blockers for this RFC.
- [ ] `BL-104` will close on commit-2 (gate live in block mode);
      baseline-fix commits and warn-mode commit do not close the
      ticket on their own.
