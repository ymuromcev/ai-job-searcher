# RFC 023 — Onboarding rewrite: AI-driven skill as the primary path

**Status**: accepted
**Related**: [BL-4](../private/backlog/BL-4-onboarding-ux-rewrite-fidbek-davida.md), [RFC 004](004-onboarding-wizard.md)
**Created**: 2026-05-11
**Accepted**: 2026-05-11 — user approved; defaults stand for both open questions (one CL sample, warn on Notion workspace mismatch)

## Problem

The current onboarding (`scripts/stage18/`) is a hybrid that satisfies
nobody. A developer (David Shekunts) tried to onboard from the README
alone, in a single sitting, without a Claude session, and got stuck.
Five specific complaints, all reproducible:

1. **Intake template lives outside the repo.** README instructs to
   save the filled questionnaire to `~/intake_filled.md`. People do
   not want third-party project artifacts in their home directory.
2. **Profile id is unexplained.** `profiles/<id>/` appears in the
   docs with no definition of what `id` is, where it comes from, or
   how to pick one.
3. **Ownership of intake is ambiguous.** The README is silent on
   whether the user fills the questionnaire by hand or by talking
   to Claude.
4. **"Paste this entire file into chat" is unmoored.** No mention
   of which chat (Claude Code? claude.ai?) or what prompt to use.
5. **Manual steps mix with "and then Claude does the magic" with
   no boundary**, making it impossible to follow without already
   knowing the shape of the system.

David's framing: pick one of two clean models, don't mix them.

- **Track A — fully programmatic.** No Claude in the loop. User
  edits `intake.md`, runs `deploy_profile.js`, then `scan`. Every
  README step is a concrete bash command.
- **Track B — fully AI-driven.** User starts a Claude session,
  Claude asks questions, fills the intake, validates, deploys.

The current state is a third, accidental track — half of A and half
of B, with neither side fully working.

## Decision

**Track B is primary. Track A is technical reference only.**

Rationale: the day-to-day product (`/job-pipeline prepare`, fit-scoring,
cover letter generation) is unusable without Claude. A user who
successfully onboards through Track A and then can't use the pipeline
the next day has wasted their time. Pretending Track A is a coequal
on-ramp is dishonest about what the project is.

A new skill `onboard-profile` becomes the supported path. The README
points at it. Track A survives as a single paragraph in
`scripts/stage18/README.md` aimed at forkers who want to script their
own onboarding (e.g. for CI fixtures).

## User-level shape

User clones the repo, installs deps, runs `claude` in the repo root,
and says:

```
Onboard me as profile bob
```

Claude (via the `onboard-profile` skill) runs through six question
blocks, writes `profiles/bob/intake.md` as it goes (same markdown
format `parse_intake.js` already understands), then invokes
`parse_intake.js` + `deploy_profile.js` and a smoke `scan`. End to
end < 20 minutes for a typical user.

### The six blocks

| # | Block | What Claude asks | What gets written |
|---|---|---|---|
| 1 | Identity | display name, location, primary track | intake.md section A (identity) |
| 2 | Resume archetypes | names + 1-line descriptions; user drops PDFs into `profiles/bob/resumes/` | intake.md section E (resume_archetypes); verified file presence |
| 3 | Cover letter voice | one CL example pasted into chat; optional voice notes | intake.md section F (cover_letter); `profiles/bob/memory/cl_voice_sample.md` |
| 4 | Filters | title requirelist/blocklist, company cap, min salary, location filter | intake.md sections B+C+D (career, preferences, companies) |
| 5 | Notion | integration token (added to `.env` by user, never read by skill), workspace page URL | intake.md section G + I (notion + env_checks); triggers `create_companies_db.js` + `create_jobs_db.js` via deploy |
| 6 | Job sources | which sources to enable; per-source credential setup | intake.md section H (modules); per-source `.env` entries |

After Block 6: `deploy_profile.js --profile bob --apply` runs, then
`engine/cli.js scan --profile bob` as a smoke check. Skill reports
success or surfaces the first failure with a remediation hint.

### Skill copy is English

Every line the skill says to the user is English. This is a public
repo and anyone forking it sees the skill. Russian remains for
internal artifacts under `private/`.

## Reuse map

The skill is mostly a question shepherd over the existing pipeline.
The heavy lifting already exists and is **not touched**:

- `scripts/stage18/parse_intake.js` — unchanged. Already parses the
  markdown intake into `intake.json`. The skill writes markdown in
  exactly the format it expects.
- `scripts/stage18/deploy_profile.js` — unchanged. Reads intake,
  generates `profile.json`, `filter_rules.json`, `resume_versions.json`,
  `cover_letter_versions.json`, creates the two Notion DBs.
- `scripts/stage18/generators/*` — unchanged.
- `engine/core/profile_loader.js` — unchanged. Already validates
  `^[a-z][a-z0-9_]{1,31}$`.

What's new:

- `skills/onboard-profile/SKILL.md` — the question script and the
  invocation contract.
- `skills/onboard-profile/SKILL.test.js` — manifest smoke tests
  (same pattern as `skills/job-pipeline/SKILL.test.js`).

What moves:

- `scripts/stage18/intake_template.md` →
  `profiles/_example/intake.template.md`. Lives next to the example
  profile because that *is* the schema demo. Closes David's
  complaint #1 (intake should live inside the repo, not at `~/`).
  `scripts/stage18/parse_intake.js` and `deploy_profile.js` keep
  reading by absolute path from `--input`, so the move is invisible
  to them.

What changes:

- `README.md` — the "Quick start" + "First profile" sections become
  a single short flow (clone, install, `claude`, say one phrase).
  The wizard runbook moves into the skill itself.
- `scripts/stage18/README.md` — shrinks. The "Runbook" section keeps
  enough detail for Track A (developers scripting onboarding
  themselves) but is no longer presented as the primary path.

What stays:

- Markdown as the intake format. No new dependency. No YAML
  migration. The format is fine; the problem was *where* the file
  lived and *who* filled it.
- All engine code. Onboarding is upstream of the pipeline; this
  rewrite does not touch `engine/`.
- All existing profiles. The deployed artifacts (`profile.json`,
  etc.) are unchanged in shape.

## Idempotency and resumability

- **Partial intake.** The skill writes to `profiles/<id>/intake.md`
  after each block completes (not at the end). If the Claude session
  drops mid-onboarding, the user re-enters the repo, says
  `continue onboarding for bob`, and the skill reads the existing
  intake.md, finds the first incomplete block, and resumes there.
- **Existing profile.** If `profiles/<id>/` already exists when the
  skill starts, it asks: overwrite, pick a new id, or treat the
  existing profile as already onboarded.
- **Re-running on a finished profile** is a no-op with a status report:
  "profile bob is already onboarded — last deploy 2026-05-09, scan
  returned 14 jobs yesterday."

## Failure surface

The skill's job is to make failures legible.

- **Bad profile id.** Caught at first mention. Skill explains the
  rule and asks again.
- **PDFs not found in `resumes/`.** Skill lists what it sees and
  what's missing; user drops the missing ones and says `recheck`.
- **`.env` token missing.** Skill says exactly which variable name
  to add; does not read the value. Recheck on user signal.
- **Notion API 401.** Skill says "the token is rejected — check that
  the integration has access to the parent page", offers retry of
  Block 5 without losing other blocks.
- **`deploy_profile.js` fails partway.** Same atomicity story as
  RFC 022: each side effect is checked, the skill reports which
  ones landed and how to redo the rest. Existing `deploy_profile.js`
  is already idempotent per BL-3.

## Test plan

Skill itself is a markdown contract — its tests are about the manifest
shape (analogous to `skills/job-pipeline/SKILL.test.js`):

- frontmatter present and named `onboard-profile`
- six blocks documented in the order specified
- explicit mention of writing to `profiles/<id>/intake.md` inside the
  repo (closes David #1)
- explicit statement that the skill does not read secrets, only checks
  env-var presence
- block 5 mentions both `<ID_UPPER>_NOTION_TOKEN` and the env var
  presence check
- resumability: skill writes intake.md after each block, can resume
  from partial state

End-to-end smoke (manual, documented in BL-4): fresh clone, fresh
test profile id, walk the skill to completion, confirm `scan` returns
≥ 1 job for a known source.

## Migration

- Existing profiles (`jared`, `lilia`) are untouched. They were
  onboarded with the old wizard; their generated artifacts are stable.
- `scripts/stage18/intake_template.md` is moved to
  `profiles/_example/intake.template.md` in one commit. No format
  change. The old location is removed in the same commit — a
  `git mv` is enough. Any external references in docs are updated
  in lockstep.

## Out of scope

- Resume content generation. The user brings their own resume cuts
  as PDFs. The skill never authors a resume.
- Legacy application import. If a future profile wants to backfill
  applications from another tracker, that's a separate task (see
  open BL on Stage 16 import if needed).
- Prerequisites install. `git`, `node ≥ 20`, `npm install` — the
  skill assumes they're done. README pre-flight covers them.
- Multi-user / team profiles. `profiles/<id>/` is single-tenant.
- Hosted onboarding. This is local-only by design.

## Open questions

1. **Should block 3 (CL voice) accept multiple samples up front, or
   start with one and expand iteratively after the first real
   `prepare` runs?** Default in this RFC: one sample. Add more later
   through normal CL-archetype editing.
2. **Should the skill warn about Notion workspace mistakes (wrong
   workspace selected, integration installed in the wrong
   workspace)?** Probably yes, with a "open this URL to verify"
   prompt — but the implementation is in Notion API land and depends
   on what `whoami` exposes. Tracked as a TODO inside the skill.

## Definition of Done

- A first-time user, given only the README, gets to a working `scan`
  in under 20 minutes without asking anyone for help.
- All five of David's complaints are addressed (point-by-point check
  in BL-4 closing notes).
- The skill is idempotent: re-running on a finished profile reports
  status, does not mutate.
- Track A documented as a one-paragraph reference, not a parallel
  on-ramp.
- README "Get started" section is four lines.
- Tests green; code-reviewer subagent finds no P0/P1.
