---
id: RFC-002
title: check command (Gmail response polling, MCP-driven)
status: implemented
tier: L
created: 2026-04-20
decided: 2026-04-20
tags: [gmail, check, mcp]
---

# RFC 002 — `check` command (Gmail response polling, MCP-driven)

**Status**: Draft 2026-04-20
**Tier**: L (new module, affects Notion state + TSV)
**Author**: Claude + Jared Moore
**Supersedes parts of**: RFC 001 §CLI (`check`), reference MVP in `../Job Search/check_emails.js`

## Problem

A candidate has dozens of active applications in the pipeline. Employers send responses to Gmail: rejections, interview invitations, requests for additional information. Manually cross-referencing the inbox against Notion statuses takes hours per week and is a source of missed events (a missed invitation = a missed opportunity).

We need a `node engine/cli.js check --profile <id>` command in AIJobSearcher that fully ports the working prototype at `../Job Search/check_emails.js` to the multi-profile architecture.

## Options

- **A. Full OAuth + `googleapis` SDK.** The command reads Gmail directly. Pros: standalone, cron-ready. Cons: OAuth bootstrap, +13 MB dependency, ~3h to a working pipeline.
- **B. Two-phase flow as in the prototype: `--prepare` / `--apply` + Gmail via Claude MCP.** Pros: zero setup, no secrets on disk, ~1.5h to a working pipeline, mirrors the proven prototype. Con: does not work in cron — requires a Claude session.
- **C. IMAP via XOAUTH2.** YAGNI — all profiles are on Gmail.

## Decision + Rationale

**Option B.** Two-phase MCP flow.

Reasons:
- The goal is "a working pipeline today" — B is faster out of the gate and requires no GCP Console.
- The core logic (classifier, matcher, parsers, filters, logs, state) is **identical** between B and A. Only the transport layer differs. Switching to A later is a localized swap.
- Jared already has MCP access to Gmail via Claude.

Cron automation (OAuth variant) is deferred to `BACKLOG.md` as a separate feature: "Gmail polling in cron: responses checked while the user sleeps."

## Architecture

### Two-phase flow

```
Phase 1: node engine/cli.js check --profile jared --prepare
  → reads applications.tsv + processed_messages.json
  → writes profiles/jared/.gmail-state/check_context.json
  → prints JSON with Gmail search batches for Claude

Phase 2: Claude executes Gmail MCP searches + reads
  → writes profiles/jared/.gmail-state/raw_emails.json
  → format: [{messageId, threadId, from, subject, body, date}, ...]

Phase 3: node engine/cli.js check --profile jared --apply
  → reads raw_emails.json + context
  → classifies, matches, builds action plan
  → in --apply: updates TSV, calls Notion updatePageStatus/addPageComment
  → appends rejection_log.md / recruiter_leads.md / email_check_log.md
  → updates processed_messages.json (last_check, prune > 30d)
```

Dry-run of phase 3 (without `--apply`) prints the plan without mutating anything.

### New / modified files

```
engine/
├── core/
│   ├── classifier.js              (new) pure rule-based classifier
│   ├── classifier.test.js
│   ├── email_matcher.js           (new) pure: email → application
│   ├── email_matcher.test.js
│   ├── email_parsers.js           (new) LinkedIn / recruiter subject parsers
│   ├── email_parsers.test.js
│   ├── email_filters.js           (new) level/location/tsv-dup filters
│   ├── email_filters.test.js
│   ├── email_logs.js              (new) rejection_log / recruiter_leads / check_log writers
│   ├── email_logs.test.js
│   ├── email_state.js             (new) processed_messages.json + context.json persistence
│   ├── email_state.test.js
│   └── notion_sync.js             (modify) add updatePageStatus(), addPageComment()
└── commands/
    ├── check.js                   (new) two-phase orchestrator
    └── check.test.js

profiles/<id>/
├── .gmail-state/                  (gitignored)
│   ├── check_context.json         (written by --prepare)
│   ├── raw_emails.json            (written by Claude MCP between phases)
│   └── processed_messages.json    (persistence across runs)
├── rejection_log.md               (gitignored) appended by check
├── recruiter_leads.md             (gitignored) appended by check
└── email_check_log.md             (gitignored) appended by check
```

No `modules/tracking/gmail.js`, `scripts/gmail_auth.js`, or `googleapis` — not needed in the MCP variant.

### CLI

```
node engine/cli.js check --profile <id> --prepare
node engine/cli.js check --profile <id>                  # dry-run of phase 3
node engine/cli.js check --profile <id> --apply          # mutate TSV + Notion
node engine/cli.js check --profile <id> --since 2026-04-15 --prepare
```

Default without flags in phase 3 = dry-run (symmetric with `sync`).

### Classifier (`classifier.js`)

Pure function:
```js
classify({ subject, body }) → {
  type: 'REJECTION' | 'INTERVIEW_INVITE' | 'INFO_REQUEST' | 'ACKNOWLEDGMENT' | 'OTHER',
  evidence: 'matched pattern snippet'
}
```

Regexes — full port from `check_emails.js:114-137`. Check order: REJECTION → INTERVIEW → INFO → ACK → OTHER. Returns the first matching type.

### Matcher (`email_matcher.js`)

Pure function:
```js
matchEmailToApp(email, activeJobsMap) → {
  company, job, confidence: 'HIGH'|'LOW', reason
} | null
```

Algorithm — full port from `check_emails.js:152-205`:
1. `companyTokens(name)` — strip LLC/Inc/stop-words, tokens > 3 characters.
2. Pass 1: token match in `from` or `subject` → HIGH.
3. Pass 2: match in body with word-boundary → HIGH.
4. Role disambiguation: exact title → keywords (skip PM common words). LOW if unable to disambiguate.

Also exported: `parseLevel(role)`, `archetype(resumeVersion)`.

### Parsers (`email_parsers.js`)

Pure functions:
- `parseLinkedInSubject(subject)` → `{role, company} | null` (Russian + English variants from the prototype).
- `parseRecruiterRole(subject)` → `string | null`.
- `extractSenderName(from)` → `string`.

Port of `check_emails.js:234-260`.

### Filters (`email_filters.js`)

Pure functions:
- `isLevelBlocked(title, rules)` → boolean.
- `isLocationBlocked(text, rules)` → boolean.
- `isTSVDup(company, role, rows)` → boolean.
- `isATS(from)` → boolean (against `ATS_DOMAINS`).
- `matchesRecruiterSubject(subject)` → boolean (against `RECRUITER_SUBJECT_PATTERNS`).

Port of `check_emails.js:54-74, 224-267`.

### Logs (`email_logs.js`)

Side-effectful (file appends), but each function accepts a path as a parameter:
- `appendRejectionLog(path, rejections)` — port of `check_emails.js:619-654`.
- `appendRecruiterLeads(path, leads)` — port of `check_emails.js:269-283`.
- `appendCheckLog(path, logRows, actionCount, rejections, inboxAdded?, recruiterLeads?)` — port of `check_emails.js:658-700`.
- `buildSummary(...)` — pure, port of `check_emails.js:702-722`.

### State (`email_state.js`)

- `loadProcessed(path)` → `{processed: [{id, date, company, type}], last_check}`.
- `saveProcessed(path, data)` — prune > 30d.
- `loadContext(path)`, `saveContext(path, ctx)`.
- `loadRawEmails(path)`.

### Orchestrator (`commands/check.js`)

**`--prepare` phase** (port of `runPrepare`, `check_emails.js:287-367`):
1. Load profile + `applications.tsv`.
2. Compute cursor epoch (saved.last_check clamped to 30d) or from `--since`.
3. Build `activeJobsMap` — apps with `notion_page_id` set and status ∈ {Applied, To Apply, Phone Screen, Onsite, Offer}.
4. Build Gmail batches:
   - 10 companies per batch: `(from:(tokens) OR subject:(tokens)) after:<epoch> -from:me`.
   - Fixed batch for LinkedIn alerts: `from:jobalerts-noreply@linkedin.com after:<epoch>`.
   - Fixed batch for recruiter outreach (subject keywords, ATS exclude) — copied from the prototype.
5. Write `check_context.json`.
6. Print JSON: `{epoch, batchCount, companyCount, batches}` for Claude.

**`--apply` / dry-run phase** (port of `runProcess`, `check_emails.js:371-597`):
1. Load `check_context.json` + `raw_emails.json`.
2. Filter already-processed by messageId.
3. For each email — branch:
   - **LinkedIn** (from contains jobalerts-noreply@linkedin.com): parse → dedup+filter → Inbox row OR skip.
   - **Recruiter outreach** (matchesRecruiterSubject + !isATS): parse role → extract client company from body → Inbox OR `recruiter_leads.md`.
   - **Normal**: classify → matchEmailToApp → by type (REJECTION / INTERVIEW / INFO / ACK / OTHER) build plan with {statusUpdate, comment, rejectionLogEntry}.
4. Print full plan.
5. If `--apply`:
   - TSV save (merged Inbox rows + status updates).
   - Notion: `updatePageStatus` + `addPageComment` per plan item.
   - Append `rejection_log.md`, `recruiter_leads.md`, `email_check_log.md`.
   - Save `processed_messages.json` (append new ids, bump `last_check`, prune > 30d).
6. Return `errors > 0 ? 1 : 0`.

### Type → Status + comment mapping

| Classifier type    | New Status    | Notion comment                                           |
|--------------------|---------------|----------------------------------------------------------|
| REJECTION          | Rejected      | `❌ Rejection received. Subject: {subject}. Status → Rejected.`  |
| INTERVIEW_INVITE   | Phone Screen  | `🔔 Interview invitation! Subject: {subject}...`          |
| INFO_REQUEST       | *(no change)* | `📋 Information request. Subject: {subject}. Action needed.` |
| ACKNOWLEDGMENT     | *(no change)* | *(no comment)*                                           |
| OTHER              | *(no change)* | *(no comment)*                                           |

Skip logic: if `status ∈ {Rejected, Closed}` — the update is not applied.

### Notion API changes

`notion_sync.js` — add:
- `updatePageStatus(client, pageId, newStatus, propertyMap)` — via `pages.update` with `toPropertyValue('status', ...)`.
- `addPageComment(client, pageId, commentText)` — via `comments.create`.

Both covered by unit tests with a mocked client (same pattern as existing `createJobPage.test.js`).

## Tests

- `classifier.test.js` — case table from the prototype + edge cases (empty subject/body, ambiguous → OTHER).
- `email_matcher.test.js` — single-role / multi-role disambiguation / no match / LLC stripping / stop-words.
- `email_parsers.test.js` — LinkedIn RU/EN formats, recruiter subject variations, unparseable → null.
- `email_filters.test.js` — level/location blocklists, ATS detection, recruiter pattern match, TSV dedup.
- `email_logs.test.js` — append-only behavior, correct headers on file creation, sorting.
- `email_state.test.js` — load/save processed, prune 30d, cursor calculation.
- `notion_sync.test.js` — updatePageStatus/addPageComment with mocked client.
- `check.test.js` — orchestration:
  - `--prepare` writes context with correct batches.
  - `--apply` with mocked raw_emails applies the plan; dry-run does not mutate.
  - Idempotency: re-running with the same raw_emails.json → 0 actions.
  - Mid-run Notion error — remaining items are still processed.
  - Already-final statuses (Rejected/Closed) are skipped.

Smoke test (manual, today):
1. Copy state files from `../Job Search/` into `profiles/jared/.gmail-state/` + `profiles/jared/*.md`.
2. `node engine/cli.js check --profile jared --prepare` → capture JSON with batches.
3. In Claude: run Gmail MCP searches + reads → write `profiles/jared/.gmail-state/raw_emails.json`.
4. `node engine/cli.js check --profile jared` → review the plan.
5. `node engine/cli.js check --profile jared --apply` → verify TSV + Notion.

## Deferred → BACKLOG.md

- **Gmail polling in cron (autonomous OAuth variant)** — core architecture is compatible; add `engine/modules/tracking/gmail.js` + `scripts/gmail_auth.js` + `--auto` flag to the command. Goal: inbox checked while the user sleeps.
- LLM fallback for ambiguous classifier results.
- IMAP backend for non-Gmail profiles.
- `check --follow-up` — reminders for applications with no response after N days.

**Included in Stage 14 (full prototype port):**
- LinkedIn job alerts → Inbox.
- Recruiter outreach → Inbox / `recruiter_leads.md`.
- Notion comment on each event.
- `rejection_log.md` auto-written.

## Security

- In the MCP variant: **no secrets on disk**. Gmail reading is delegated to Claude (which already has user OAuth via MCP).
- Logs do not write the full body — only subject + classifier evidence.
- `.gmail-state/` in gitignore.
- Notion token — same as before, in `.env` as `{ID}_NOTION_TOKEN`.

## Implementation plan (order)

1. Update `.gitignore` + `BACKLOG.md`.
2. Copy state from `../Job Search/` into `profiles/jared/` (processed, logs).
3. `core/classifier.js` + tests.
4. `core/email_matcher.js` + tests (including `companyTokens`, `parseLevel`, `archetype`).
5. `core/email_parsers.js` + tests.
6. `core/email_filters.js` + tests.
7. `core/email_state.js` + tests.
8. `core/email_logs.js` + tests.
9. `core/notion_sync.js` — `updatePageStatus` + `addPageComment` + tests.
10. `commands/check.js` + tests (both phases with mocks).
11. Register in `engine/cli.js`.
12. Manual smoke: `--prepare` → MCP Gmail → `--apply`.
13. Commit + CLAUDE.md update.

## Open questions — resolved

1. ✅ **Interview Status**: `"Phone Screen"` (as in the prototype).
2. ✅ **Transport**: MCP (two-phase flow).
3. ✅ **Existing state**: copied once from `../Job Search/` into `profiles/jared/` as the starting point.
