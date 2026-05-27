---
name: onboard-profile
description: "Guide a new user through creating their first profile end-to-end: walk the questionnaire in chat, write profiles/<id>/intake.md as you go, then run parse_intake.js + deploy_profile.js to provision the profile and its Notion databases. Trigger on: /onboard-profile, /onboard, or when the user asks to onboard / create a new profile / set up a profile / continue onboarding."
---

# onboard-profile — AI-driven profile onboarding

This skill turns the questionnaire onboarding into a chat conversation.
You ask one block of questions at a time, write the answers to
`profiles/<id>/intake.md` after each block (so the user can resume if
the session drops), and at the end you run the deploy scripts that
actually provision the profile.

**You drive the conversation.** The user opens Claude Code, types
"onboard me as profile bob" (or just "onboard me" — then you ask for
the id), and answers your questions. They never edit a file by hand.
They never paste tokens into chat.

---

## Repo location

The tool is installed at `~/.ai-job-searcher/` (fixed path, RFC 048).
**Run every Bash command in this skill from `~/.ai-job-searcher/`.**
Either `cd ~/.ai-job-searcher` once at the start of execution, or prefix
each command with `cd ~/.ai-job-searcher && ...`. All relative paths in
this document (`profiles/<id>/...`, `engine/cli.js`, `scripts/stage18/...`)
resolve from there.

If `~/.ai-job-searcher/` does not exist when you start, the tool is
not installed. Tell the user to run, in a fresh Claude Code chat:
"install job-searcher from https://github.com/ymuromcev/ai-job-searcher".

---

## Trigger phrases

- `/onboard-profile`, `/onboard`
- "onboard me", "onboard me as profile <id>", "create a profile for me"
- "set up a new profile", "set up profile <id>"
- "continue onboarding [for <id>]" → resume mode

If no profile id is in the trigger, ask for one before starting Block 0.

---

## Profile id rules

A profile id is the directory name under `profiles/` and the prefix
for env vars (e.g. profile `bob` → `BOB_NOTION_TOKEN`).

- regex `^[a-z][a-z0-9_]{1,31}$` — lowercase letters, digits, and
  underscores; must start with a letter; 2-32 chars.
- Reserved names you cannot use: `_example`, `example`, `default`,
  `test`. This list is enforced by `scripts/stage18/_common.js`'s
  `validateProfileId` — picking a reserved id will crash the deploy
  step at the end.
- If the user gives an invalid id, explain the rule and ask again.
  Do not silently rewrite their choice.

---

## Pre-flight (Block 0 — runs before any question)

Before the first question, verify the environment is set up:

1. **Working directory**: confirm you're at the repo root. Look for
   `package.json` with `"name": "ai-job-searcher"`. If not, ask the
   user to `cd` into the cloned repo and re-run.
2. **Dependencies installed**: check `node_modules/` exists. If not,
   tell the user to run `npm install` first.
3. **`.env` file exists**: check the repo-root `.env`. If not, ask
   the user to create an empty `.env` file (or to copy `.env.example`).
   Do not create it for them — they own that file.
4. **Profile directory free**: check `profiles/<id>/`. If it already
   exists, ask:
   - **overwrite** — delete the directory and start fresh
   - **resume** — read the existing `intake.md` and continue from the
     first incomplete block
   - **pick another id** — start over with a new id
   - **cancel** — exit the skill

If all four checks pass, announce "Ready to onboard profile `<id>`.
I'll ask 6 blocks of questions, ~3 minutes each. Type `skip` to defer
a block. Let's go." and proceed to Block 1.

---

## How you write `intake.md`

The intake file mirrors `profiles/_example/intake.template.md`. It
has 10 sections (A–K). The 6 conversation blocks below map to these
sections — you accumulate answers in memory during a block, then
**append the section to `profiles/<id>/intake.md` when the block
completes**.

A handful of template fields are intentionally **not** asked in the
conversation; they're either redundant with what you derive from
other answers or defaulted by `deploy_profile.js`:

- `seniority` — derive from Q2.3 (level) or leave blank.
- `current_role` — derive from Q2.1 + Q1.4 if mentioned, else blank.
- `salary_currency` — defaults to USD; only set explicitly if the
  user volunteers a different currency.
- `flags.watcher_enabled` — defaults to `no`; users with the Notion
  Watcher pattern can flip it later by editing profile.json.

When in doubt, omit the field. `parse_intake.js` is lenient and the
generators have sane defaults.

Always write after every block, never mid-block. The user can quit
the session at any block boundary and resume from the next block on
the next run.

**Resume detection**: if `profiles/<id>/intake.md` already has sections
A–F (for example), start from Block 5 (section G onwards). Read the
existing file, do not re-ask. Tell the user "Picking up from Block 5
(Notion). You finished blocks 1–4 last time."

---

## Block 1 — Identity (writes section A)

Ask in order, one at a time. Do not bulk-paste a list.

```
Q1.1  What's your full name? (used on resumes / cover letter signoffs)
Q1.2  What's the best email for application replies?
Q1.3  Phone number? (optional — say "skip" if you'd rather not share)
Q1.4  Where are you based? (city, state/region, country)
Q1.5  LinkedIn URL or handle?
Q1.6  Personal site or portfolio URL? (optional)
Q1.7  Pronouns? (optional)
```

For "where are you based" parse into `location_city`,
`location_state`, `location_country`. For US, normalise state to
two letters; non-US, leave the state blank if not applicable.

**Write to intake.md section A** after Q1.7. The first field in
section A **must be** `- profile_id: <id>` (using the id resolved in
pre-flight). `parse_intake.js`'s `validateIntake` requires this field
non-empty; if it's missing, the finalize step fails.

---

## Block 2 — Career context + filters (writes sections B, C, D)

These three sections are related (level, target roles, target
companies, blocklists), so handle them together as a single block.

```
Q2.1  What role are you targeting? (e.g. "Senior Product Manager")
Q2.2  How many years of relevant experience?
Q2.3  Level — pick one: IC / Senior IC / Staff / Principal / Manager / Director
Q2.4  Title keywords to *require* — e.g. "product manager, senior pm, principal pm"
Q2.5  Title keywords to *never* show — e.g. "intern, junior, contractor"
Q2.6  Work format — remote / hybrid / onsite / any?
Q2.7  Cities or regions you'd work in? (or "Remote (US)" etc.)
Q2.8  Cities or regions that are a hard no?
Q2.9  Minimum total comp (USD)?
Q2.10 Ideal total comp (USD)?
Q2.11 Industries you prefer? (e.g. fintech, AI, healthcare)
Q2.12 Industries to avoid? (e.g. defense, gambling)
Q2.13 Company sizes ok — any of: Startup, Scaleup, Mid, Enterprise

Now target companies (group them by enthusiasm):
Q2.14 Dream companies (tier S)?
Q2.15 Strong interest (tier A)?
Q2.16 Open to (tier B)?
Q2.17 Backup (tier C)?
Q2.18 Companies you would never apply to?
```

Q2.4 maps to `target_roles`; Q2.5 to `title_blocklist`. Tier lists
become `tier_s` / `tier_a` / `tier_b` / `tier_c`. Empty tiers are fine.

**Write to intake.md sections B, C, D** after Q2.18.

---

## Block 3 — Resume archetypes (writes section E + verifies files)

```
Q3.1  How many resume variants do you want to maintain?
      (Most candidates have 2-4 cuts targeted at different role types.)

For each cut:
Q3.2  Short slug (a-z 0-9 dashes only, e.g. "ai-pm" or "fintech")
Q3.3  Display title (e.g. "AI Product Manager")
Q3.4  One-sentence summary
Q3.5  3-5 highlight bullets
Q3.6  Match keywords (comma-separated, e.g. "ai, ml, platform")
```

After all archetypes are described, tell the user:

> Drop the PDF for each archetype into `profiles/<id>/resumes/`, naming
> the file `<slug>.pdf` (e.g. `ai-pm.pdf`). I'll wait. Tell me when
> you're done — I'll verify each file is present.

Use Bash `ls profiles/<id>/resumes/` to verify. For each archetype
slug, check `profiles/<id>/resumes/<slug>.pdf` exists. List any
missing files and ask the user to add them. Do not proceed until
every declared archetype has a corresponding PDF.

**Write to intake.md section E** after the file verification passes.

---

## Block 4 — Cover letter voice (writes section F + sample memory file)

```
Q4.1  Paste one cover letter you wrote recently that you're happy with.
      (I'll learn your voice from it — sentence rhythm, vocabulary,
      how you open and close.)
Q4.2  Tone — formal / conversational / punchy?
Q4.3  Length preference — short (<200w), medium (200–400w), long (400+w)?
Q4.4  Signature line — e.g. "Best, Jared"
Q4.5  Any voice notes? (e.g. "no buzzwords", "always mention impact
      in numbers", "open with a specific reason for this company")
```

Save the pasted CL example to
`profiles/<id>/memory/cl_voice_sample.md`. This file is a reference
for the operator — the engine does not auto-pipe it into CL
generation. If the user wants `prepare` to actually use the sample,
they can later set
`profile.json.cover_letter.writing_style_file` to its path. Mention
that as a follow-up; do not edit profile.json yourself here.

Convert Q4.5 voice notes into `intro_hint`, `why_interested_hint`,
`why_fit_hint`, `close_hint` if the user gives hints in that shape;
otherwise leave the fields blank and put the freeform notes into a
markdown comment in section F so the user can refine later.

**Write to intake.md section F + sample file** after Q4.5.

---

## Block 5 — Notion (writes section G, I + provisions DBs at end-of-skill)

This block has a manual step in the middle — the user has to create
a Notion integration in their browser. You wait.

```
Q5.1  I'll walk you through creating a Notion integration. Open this URL:
      https://www.notion.so/profile/integrations
      Click "New integration", name it something like "AIJobSearcher-<id>",
      select your workspace. Save it. Tell me when it's created.

Q5.2  Click "Show" next to the Internal Integration Token to reveal it,
      copy it, then open the `.env` file in this repo and add:
          <ID_UPPER>_NOTION_TOKEN=<paste-token-here>
      Save the file. Tell me when it's saved.

      I will NOT read the token. I only check that the env var is
      present in `.env`.

Q5.3  Now create an empty page in your Notion workspace where the
      Jobs Pipeline and Companies databases should live. Share that
      page with the integration you just created (click ⋯ → Add
      connections → pick your integration).
      Paste the page URL here.

Q5.4  What's the integration's name in Notion? (so I can record it
      for future reference)
Q5.5  Did you confirm the integration has access to the parent page?
      (yes / no — if no, walk through the "Add connections" step again)
```

After Q5.2, verify the env var is in `.env`:

```bash
grep -q "^<ID_UPPER>_NOTION_TOKEN=" .env
```

(Replace `<ID_UPPER>` with the actual uppercased id.) Report present /
not present. If not present, tell the user the exact line to add, do
not retry until they confirm.

After Q5.5, the parent_page_url and integration_shared status go into
section G. The env-var check result goes into section I.

**Write to intake.md sections G and I** after Q5.5. Database creation
itself happens at the end of the skill, via `deploy_profile.js`.

---

## Block 6 — Job sources (writes section H + per-source secrets)

```
Q6.1  Which job sources do you want enabled? I'll show what each needs.
      Defaults are fine for most users.

      [1] greenhouse        — Greenhouse-hosted ATS (no key needed)
      [2] lever             — Lever ATS (no key)
      [3] ashby             — Ashby ATS (no key)
      [4] smartrecruiters   — SmartRecruiters ATS (no key)
      [5] workday           — Workday tenants (no key)
      [6] remoteok          — RemoteOK board (no key)
      [7] usajobs           — US federal jobs (needs free API key)
      [8] calcareers        — California state jobs (no key)
      [9] all of the above

      Pick a subset (e.g. "1,2,3,6") or "default" (= 1-6) or "all".
```

If `usajobs` is selected:

```
Q6.2  Sign up at https://developers.usajobs.gov/apirequest/ (free).
      Add to `.env`:
          <ID_UPPER>_USAJOBS_API_KEY=<your-key>
          <ID_UPPER>_USAJOBS_EMAIL=<the-email-you-registered>
      Tell me when both are added.
```

Verify both env vars present via grep. Block until done.

**Write to intake.md section H** after the user confirms all
selected sources are configured.

**Section I bookkeeping:** if `usajobs` was selected and verified,
also append `- env_usajobs_set: yes` to section I (you already wrote
`env_notion_token_set` in Block 5). If usajobs was not selected,
write `- env_usajobs_set: no` so the field is explicit. Doing this
keeps section I aligned with `parse_intake.js`'s expected shape.

---

## Block 7 — Flags + finalize (writes sections J, K + runs deploy)

Two quick yes/no questions:

```
Q7.1  Do you have a prior prototype project to import resume/CL files
      from? (most new users: no)
Q7.2  Seed your target companies (from Q2.14-Q2.17) into the Companies
      database on deploy? (recommended: yes)
```

If Q7.1 = yes, ask `prototype_path` and the per-import yes/no flags
from section J. If no, write `has_prototype: no` and skip the rest
of section J.

**Write to intake.md section J + K** after Q7.2.

---

## Finalize: run the deploy

Once all 7 blocks are written:

```
✓ Block 1 (Identity)        section A written
✓ Block 2 (Career+Filters)  sections B, C, D written
✓ Block 3 (Resume)          section E written + N PDFs verified
✓ Block 4 (CL Voice)        section F + voice sample written
✓ Block 5 (Notion)          sections G, I written + env var present
✓ Block 6 (Job sources)     section H written
✓ Block 7 (Flags)           sections J, K written

Running parse + deploy now...
```

Run these via Bash, in order, and surface the output:

```bash
node scripts/stage18/parse_intake.js --input profiles/<id>/intake.md --apply
node scripts/stage18/deploy_profile.js --profile <id> --apply
```

If either fails, show the error verbatim, identify which block likely
caused it (the validator error message names a field; map field →
block), and offer to redo that block. Do not retry blindly.

Then run a smoke check:

```bash
node engine/cli.js scan --profile <id>
```

Report: "Scan returned N jobs. Onboarding done. Your next move:
`/job-pipeline prepare --profile <id>` to start working through the
Inbox."

---

## Resumability

When invoked with "continue onboarding for <id>" or when the
overwrite/resume prompt picks "resume":

1. Read `profiles/<id>/intake.md`.
2. Identify which sections (A–K) are present and non-empty.
3. Map sections to blocks (A=1, B/C/D=2, E=3, F=4, G/I=5, H=6, J/K=7).
4. Announce: "Picking up from Block <N> — sections <X, Y, Z> already
   filled, last edited <timestamp>. Continue?"
5. On user yes, ask the first question of Block N.

If `intake.md` is mid-block (e.g. section E has 1 archetype but the
user said they wanted 3), ask whether to continue that block from
where it stopped or restart the block. Default: continue.

---

## Idempotency on a finished profile

If `profiles/<id>/` exists AND `profiles/<id>/.stage18/intake.json`
exists AND the file has been deployed (presence of
`profiles/<id>/profile.json`):

```
Profile <id> is already onboarded.
  Last deploy: <date from profile.json>
  Last scan:   <wc -l of profiles/<id>/applications.tsv> rows in pipeline

Re-onboarding would overwrite your profile. Choose:
  • cancel               — keep things as they are (default)
  • re-run deploy only   — re-run scripts on existing intake.md
  • restart from scratch — delete profiles/<id>/ and onboard fresh
```

---

## Secrets handling — strict rules

1. **Never read a token value.** If you need to know whether a token
   is present, use `grep -q "^<ID_UPPER>_<NAME>=" .env` and report
   present/not-present only.
2. **Never ask the user to paste a token in chat.** Always direct them
   to add to `.env` themselves.
3. **Never write secrets to `intake.md`.** Section I has yes/no
   booleans only.
4. **Never commit `.env`.** The repo's `.gitignore` covers it; if the
   user asks you to add `.env`, refuse and explain.

---

## Anti-patterns

- ❌ Asking all 6 blocks of questions at once. One question at a time.
- ❌ Bulk-pasting the intake template and asking the user to fill it.
  That's the old flow we're replacing.
- ❌ Writing `intake.md` only at the very end. Write after every
  block so the user can quit at any boundary.
- ❌ Running `deploy_profile.js` without `--apply` and calling it done.
  Always `--apply` after a successful parse.
- ❌ Skipping the env-var presence check because "the user said they
  set it". Always grep the file.
- ❌ Inventing fields the user didn't give (e.g. guessing tier_b
  companies). Empty is fine; do not fabricate.
- ❌ Talking to the user in any language other than English. The
  skill is part of a public repo and must work for any user.

---

## Test plan

Smoke test for the manifest (see `SKILL.test.js`):

- frontmatter has `name: onboard-profile`
- description mentions resume / continue / new profile triggers
- six conversation blocks documented in order (with Block 0 pre-flight
  and Block 7 finalize — 8 sections total, mapping to 6 user-facing
  question rounds + pre-flight + finalize)
- explicit "never read secrets" rule
- explicit mention of `profiles/<id>/intake.md` (the file must live
  inside the repo, never under the user's home directory)
- explicit mention of `<ID_UPPER>_NOTION_TOKEN` and the grep-based
  presence check
- resumability instructions present
