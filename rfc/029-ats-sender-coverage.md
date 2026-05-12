---
id: RFC-029
title: "ATS-sender search coverage in `check` tick"
status: accepted
tier: M
created: 2026-05-12
refs:
  - RFC-020
  - RFC-022
  - BL-44
  - BL-45
---

## Goal

Close the IMAP-search gap that hides interview invites, rejections, and
acknowledgments coming through **ATS aggregator domains** (dentemploy,
greenhouse, lever, workday, ashby, etc.) — emails whose `from` is the
ATS platform and whose `subject` is the position title (NOT the
pipeline company name). The current `buildBatches` query only matches
emails when the company token appears in `from` or `subject`, so any
ATS-mediated email where the company name lives only in the body is
invisible to `check --auto` (and to the operator-driven prepare/apply
flow).

Concrete failing case: Lilia received 4 emails from
`interview@dentemploy.com` between 2026-04-29 and 2026-05-11 about a
First Round Interview at **Make a Smile**, scheduled for 2026-05-12
12:30 PDT. None of the 4 emails reached `processed_messages.json` —
the check tick never queried for them.

## Non-goals

- Reclassifying already-processed emails. That's RFC 028 / BL-44.
- Per-profile ATS overrides. We deliberately use **one shared list**
  so a new ATS becomes discoverable for every profile the moment it's
  added (operator request).
- Auto-discovery of new ATS domains via heuristic / ML. New domains
  are added by editing one file — explicit, reviewable, no surprise
  expansions.
- "Scan everything in inbox window" approach. Too noisy; we keep the
  query targeted via the explicit sender allowlist.
- Catching ATS emails when neither the from-domain matches nor the
  pipeline company is mentioned in subject. By construction unmatched.

## Design

### Single source of truth

`engine/core/email_filters.js` already exports `ATS_DOMAINS` (used to
bypass the recruiter-outreach branch). We extend it to be the
canonical list used in three places:

1. **Recruiter-branch bypass** (existing `isATS(from)` call).
2. **IMAP search batch** (NEW — covered by this RFC).
3. **Recruiter-outreach batch exclusion** (replace hardcoded
   `-from:greenhouse -from:lever ...` with a helper derived from
   `ATS_DOMAINS`).

### New batch in `buildBatches`

`engine/commands/check.js:buildBatches` gains one extra batch:

```
from:(dentemploy.com OR applicantemails.com OR greenhouse-mail.io OR
      hire.lever.co OR myworkdayjobs.com OR ashbyhq.com OR
      smartrecruiters.com OR icims.com OR bamboohr.com OR
      jobvite.com OR workable.com OR taleo.net OR jobot.com OR
      paycomonline.com OR breezy.hr OR gem.com OR paradox.ai OR
      eightfold.ai OR ...)
<searchWindow> -from:me
```

Domains come from `ATS_DOMAINS` joined with ` OR `. Joining once in a
helper (`atsFromInclusions()`) avoids drift.

### Helper functions

`engine/core/email_filters.js` exports:

- `atsFromInclusions()` → `"from:(d1 OR d2 OR ...)"` for use in the
  new batch.
- `atsFromExclusions()` → `"-from:d1 -from:d2 ..."` for use in the
  recruiter-outreach batch (replaces hardcoded exclusion).

### Extended `ATS_DOMAINS` list

Add to current 13-domain list:

- `dentemploy.com` — dental-industry ATS (Lilia's gap).
- `applicantemails.com` (with `send.applicantemails.com`) — generic
  ATS used by many small businesses (Sacramento Natural Dentistry case
  on Lilia's pipeline).
- `paycomonline.com` — Paycom ATS.
- `breezy.hr` — Breezy HR.
- `gem.com`, `paradox.ai`, `eightfold.ai` — modern recruiting platforms.
- `myworkday.com` (in addition to existing `myworkdayjobs.com`) — Workday
  notification domain variant.

Other known ATSes already in the list: `greenhouse-mail.io`,
`hire.lever.co`, `ashbyhq.com`, `smartrecruiters.com`, `icims.com`,
`bamboohr.com`, `jobvite.com`, `workable.com`, `taleo.net`, `jobot.com`,
`ashby.com`.

### Classifier coverage for the dentemploy case

The dentemploy invite body contains "Schedule your Interview" /
"schedule your interview by clicking the link below". Current
`INTERVIEW_INVITE` regex `/schedule (an? )?(interview|...)/i` does NOT
match "schedule **your** interview" because `(an? )?` only accepts
"a "/"an "/empty between "schedule" and "interview".

**Patch**: relax to `/schedule (?:[a-z]+\s+)?(interview|phone screen|...)/i` —
allows any single word (`your`, `the`, `our`, `my`, `a`, `an`) between
`schedule` and the interview noun. Tested for false-positive risk on
JD-body text containing "schedule flexibility" / "schedule" (no match,
no interview-noun follows).

Add `/first round interview/i` and `/round (one|1|two|2) interview/i` —
ATS scheduling emails routinely use "First Round Interview" in subject;
this is unambiguous intent.

### Backfill / recovery

After deployment, run `node engine/cli.js check --apply --profile lilia`
once. The new ATS batch picks up the 4 dentemploy emails (they're in
All Mail, not in processed_messages.json), classifies them, matches
"Make a Smile" via body, and:

- INTERVIEW_INVITE on email #1 → status update Make a Smile → Interview.
- Other 3 emails: status idempotent (Interview → Interview = no-op),
  comment per email logs the audit trail.

Same one-time backfill on Jared catches any pending ATS-only emails
in his pipeline.

### `ats_unmatched` logging

When an ATS email is fetched but `findCompany` returns null (body
mentions a company NOT in pipeline), it goes through normal "unmatched"
path. No special handling needed — existing `check.js` already logs
unmatched emails to `check_log` with a clear marker. The operator
reviews unmatched emails in the daily summary.

## Test plan

1. **`email_filters.test.js`**:
   - `isATS("hello@send.applicantemails.com")` → true (substring match
     on `applicantemails.com`).
   - `isATS("interview@dentemploy.com")` → true.
   - `isATS("noreply@indeed.com")` → false (Indeed is JOB_ALERT, not
     ATS).
   - `atsFromInclusions()` returns string starting with `from:(` and
     containing all `ATS_DOMAINS` joined with ` OR `.
   - `atsFromExclusions()` returns string with `-from:<each>` for all
     `ATS_DOMAINS`.

2. **`check.test.js`**:
   - `buildBatches` output includes ATS batch as the LAST batch
     (after recruiter batch).
   - ATS batch has form `from:(...) <window> -from:me`.
   - Recruiter batch exclusion uses `atsFromExclusions()` (no hardcoded
     `-from:greenhouse` etc.).
   - Batch count grows by exactly 1 from previous baseline.

3. **`classifier.test.js`**:
   - "schedule your interview" → INTERVIEW_INVITE.
   - "schedule the interview" → INTERVIEW_INVITE.
   - "schedule a interview" / "schedule an interview" / "schedule
     interview" still match (regression).
   - "schedule flexibility required" → NOT INTERVIEW_INVITE (no
     interview-noun follows).
   - "First Round Interview" → INTERVIEW_INVITE.
   - "Round 2 interview" → INTERVIEW_INVITE.
   - Full dentemploy body fixture → INTERVIEW_INVITE.

## Risks / rollback

- **False-positive risk on relaxed `schedule (?:[a-z]+\s+)?(interview|...)/`**:
  any JD-body text saying "schedule team interviews monthly" would
  now match. Mitigated by ATS-sender allowlist gating most of the noise
  before classify(), and by REJECTION running first (real rejections
  saying "we'd schedule interviews with others" → REJECTION wins).
  Tests cover both directions.
- **ATS batch query length**: current 13 domains + ~7 additions = 20.
  Query stays ~600 chars, well under Gmail's X-GM-RAW limit. Future
  domain additions remain safe up to ~50 domains.
- **Rollback**: revert single commit. `ATS_DOMAINS` list change is
  additive (no removed entries). Existing tests + tests new in this
  RFC must all pass before deploy.

## Definition of Done

- [ ] `ATS_DOMAINS` extended with dentemploy, applicantemails, paycom,
  breezy, gem, paradox, eightfold, myworkday.
- [ ] `atsFromInclusions()` / `atsFromExclusions()` helpers in
  `email_filters.js`.
- [ ] `buildBatches` in `check.js` adds the ATS batch + uses
  `atsFromExclusions()` in the recruiter batch.
- [ ] Classifier patterns relaxed for "schedule X interview" + added
  "first round interview" / "round N interview".
- [ ] Tests: filters + check + classifier (≥ 8 new).
- [ ] `npm test` green, lint clean, prettier clean.
- [ ] Code-reviewer subagent — 0 blockers (or fixed).
- [ ] Incidents.md entry (missed dentemploy invite, severity HIGH).
- [ ] Backfill `check --apply --profile lilia` on fly — Make a Smile
  → Interview in Notion.
- [ ] Same on Jared (no regressions).
- [ ] BL-45 closed.

## Process note

Discovered while validating BL-44 (`reclassify` command) on Lilia's
data. Reclassify dry-run found 0 OTHER → typed transitions, but
probing the inbox surfaced a separate gap: 4 dentemploy interview
invites that never entered `processed_messages.json` at all. The
reclassify command can only fix what's already in the log; this RFC
fixes what was missing from the log.
