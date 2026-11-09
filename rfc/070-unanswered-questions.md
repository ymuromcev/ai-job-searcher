---
id: "070"
title: "Questions the bot could not answer: an owner queue in Notion, re-apply once answered"
status: accepted
decided: 2026-11-09
tier: M
created: 2026-11-09
related: [RFC 009, RFC 068, RFC 069]
backlog: BL-231
---

# RFC 070 — Questions the bot could not answer

Status: accepted (owner approved the user-level image, BL-231, 2026-11-09) · builds on RFC 069

## Problem

RFC 069 lets the nightly bot decide on its own: a required question without an honest answer skips the row as `no_honest_answer` and the night moves on. Those rows are lost for good — the same question ("Do you have a valid driver's license?", "Have you worked at <company> before?") stops a job every night, and nothing tells the owner which facts the bot is missing. Owner, 2026-11-09: keep a base of such questions he can open and answer; before applying, the bot retries the jobs it could not answer once an answer is there.

## Outcome (approved image)

- The base is the existing Notion **Application Q&A** database (RFC 009) with a "Waiting for answer" view. Each blocking question appears once (the same question across companies is one entry) with its companies, jobs and links.
- The owner writes the answer and sets **Answered**, or sets **Skip such jobs** — the bot then stops applying to jobs that ask it.
- Every night, before submission, the bot pulls the answered questions into its standing answers, finds the stuck jobs whose every blocker is now answered, and queues them. The answers pass the same truth review.
- The morning report says "re-submitted thanks to your answers: N" and "waiting for your answer: M" with the link to the view.
- Out of scope: Ashby / Workday / captcha forms (never submitted anyway); "prove you are human" and "no AI was used" questions are never put in the base.

## Design

### Source of truth for blockers

`apply_note` of rows with `apply_state=skipped` and `apply_note="no_honest_answer: <q1>; <q2>"` (written by `apply --phase submit`). Draft files also list optional unanswered fields; those never block, so they are ignored. Rows count only while `status=To Apply`, `applied_date` empty, and the form is not Ashby.

### Question identity (`core/owner_questions.js`, pure)

`questionKey(label, company)`: the company's name (and its bare form without Inc / LLC …) becomes `<company>`; the trailing required marker, case and punctuation are dropped. "Why do you want to work at Acme?" (Acme) and "… at Beta?" (Beta) are one entry, shown as "Why do you want to work at <company>?". Exact key match only — no fuzzy matching, so an answer never lands on a different question.

Excluded: bot checks ("not a robot", "type the secret word", captcha) and AI certifications (an AI term plus certify / without / not used / own words …).

### Notion schema (Q&A database)

Added idempotently on the first `--apply` push (`qa_notion.ensurePendingSchema`, SDK v5 `dataSources.retrieve` / `dataSources.update`): `Status` (select: Waiting for answer / Answered / Skip such jobs), `Question key` (rich text), `Jobs` (rich text: "Company — Title — URL" per line). Rows without a Status stay ordinary bank answers; Waiting / Skip rows are filtered out of every bank read (`apply --phase pre`, board, weekly report). A `Status` property of another type stops the push with a clear error. The view itself cannot be created through the API: the owner (or Claude via the Notion MCP) adds a "Waiting for answer" view filtered on Status and may put its link into `profile.json` → `notion.application_qa_waiting_view_url`; otherwise the report links the database.

### Command `questions` (dry-run by default, `--apply` writes)

`node engine/cli.js questions --profile <id> [--phase pull|requeue|push] [--apply]`, all three phases in this order by default:

1. **pull** — Notion entries `Answered` with a non-empty Answer → `apply_defaults.standing_answers`; `Skip such jobs` → new `apply_defaults.skip_questions`. Both tagged `notion_page_id`; tagged entries are replaced on every pull (an entry the owner moves back to Waiting disappears), the owner's untagged entries are never touched. The merged file must validate before it is written. The drafter and the truth review already read `standing_answers` as a source (BL-229); `apply --phase pre` now also fills an exact-key match itself (`source: "standing"`) and stops a form that asks a skip-rule question (`no_honest_answer: owner_skip: <q>`).
2. **requeue** — a blocked row whose every blocker has a standing answer → `apply_state=queued`, `apply_note=requeued:<date> answers`; a row with a skip-rule blocker keeps `skipped` with `apply_note=no_honest_answer: owner_skip: <blockers>` (reverted when the rule is lifted). The TSV write re-reads the file under its lock and touches a row only if it is unchanged since the plan. Requeued keys go to `.apply-state/questions.json` (kept 30 days).
3. **push** — the remaining open blockers, grouped by key, become "Waiting for answer" entries (Question, Status, Question key, Jobs, Company, Role, Category). An existing Waiting entry gets its job list updated; Answered / Skip entries are never touched or duplicated. `.apply-state/questions.json` gets the waiting count and the view link.

Requeue extends the existing pattern of `requeue` (RFC 069 §8) rather than adding a new TSV writer path: same lock, same re-check-on-fresh-row rule, same `requeued:<date>` note shape.

### Nightly wiring

- `night-apply.md` Step 2b: `questions --profile <id> --apply` after the scan, before the first prepare / apply round — answers given during the day reach tonight's queue.
- `submit-ready`, on its first run after the window closes: runs the same command in process before it writes the morning report, so questions that blocked rows during the night are in Notion by the time the owner reads the notification. A failure there never stops the notification.
- Morning report (`core/morning_report.js`): `answers: { resubmitted, waiting, view_url }` + `answers_line`; resubmitted = jobs submitted tonight whose key is in the requeued log. Shown in the notification and on the board's first tab (with the link).

## Identity & PII

No new personal fields in the repo. The owner's answers live where his other standing answers already live (`profiles/<id>/apply_defaults.json`, gitignored) and in his Notion database. Logs print question text and row keys, never answers.

## Risks

- **A normalized key merges two different questions.** Only company names and punctuation are normalized; the rest of the text must match exactly.
- **The owner's answer is wrong for one company.** He sees the job list per entry before answering; a company-specific question carries `<company>` and should be answered generically, or marked Skip.
- **Notion schema drift** (renamed property, wrong type) → push stops with an error, pull / requeue still run.

## Verification

Unit tests (no network): key normalization and exclusions, note parsing, row planning (requeue / skip rule / waiting / stuck), grouping, merge into apply_defaults, Notion schema patch and pending pages, the command end to end on a temp profile with a fake Notion (dry run writes nothing; apply pulls, requeues, pushes, writes state; changed-row guard; schema failure), `apply` deterministic standing answers + skip rule, morning report counts, submit-ready runs the step before the report and survives its failure.
