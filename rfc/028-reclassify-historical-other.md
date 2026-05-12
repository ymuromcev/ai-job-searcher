---
id: RFC-028
title: "Reclassify historical OTHER (IMAP transport)"
status: accepted
author: Claude (via Jared/Lilia)
created: 2026-05-12
refs:
  - BL-44
  - RFC-021
  - BL-21
tier: M
---

# RFC 028 — Reclassify historical OTHER (IMAP transport)

## 1. Goal

After RFC 021 (BL-21, OAuth→IMAP cron transport) and the classifier
widening for ATS multi-step interview invites, **future** `check --auto`
ticks correctly tag e.g. dentemploy multi-step invites as
`INTERVIEW_INVITE`. But **historical** entries already persisted in
`profiles/<id>/.gmail-state/processed_messages.json` with
`type: "OTHER"` are not re-evaluated. Lilia's Apr 29 + May 1 dentemploy
invites are still mis-labelled there; an unknown number of others may
exist across both profiles.

This RFC introduces `engine/cli.js reclassify` — a one-shot CLI to
re-fetch each `OTHER` message body via IMAP, run it through the current
classifier, and emit a per-row report. Dry-run by default; mutates
`processed_messages.json` only with `--apply`; updates Notion only with
`--apply --notion` and per-row operator confirmation.

## 2. Non-Goals

- **No new transport.** Uses the same `gmail_imap.js` that BL-21 / RFC 021
  installed for `check --auto`. No new credentials, no OAuth resurrection.
- **No window extension.** 30 days = `email_state.MAX_DAYS`. Anything
  older has already been pruned from `processed_messages.json`. Out of
  scope to recover; the email is gone from our state-of-record.
- **No `--all` cross-profile loop.** One profile per invocation. Two
  invocations cover the current profile set (Lilia, Jared).
- **No cron auto-sweep.** Operator-triggered only. If a future cron mode
  is wanted, separate RFC.
- **No classifier changes.** Pure consumer of `engine/core/classifier.js`.
- **No `check` changes.** `check --auto` and `--prepare`/`--apply` are
  untouched.

## 3. Design

### 3.1 User-level command shape

```
node engine/cli.js reclassify --profile lilia
node engine/cli.js reclassify --profile lilia --apply
node engine/cli.js reclassify --profile lilia --apply --notion
node engine/cli.js reclassify --profile lilia --since 2026-04-15
node engine/cli.js reclassify --profile lilia --limit 50 --verbose
```

On fly:

```
fly ssh console -a ai-job-searcher-cron \
  -C "node /app/engine/cli.js reclassify --profile lilia"
```

Dry-run output (per row):

```
[12/34] lilia | 2026-04-29 | DentEmploy
  OTHER → INTERVIEW_INVITE
  evidence: "interview invitation"
  source: 18ad08abc1234
```

Summary at the end: `34 OTHER scanned · 7 reclassified (5 INTERVIEW_INVITE, 2 REJECTION) · 27 unchanged · 0 errors`.

### 3.2 Algorithm

1. Load profile + IMAP credentials via `gmail_imap.loadCredentials`,
   assert via `gmail_imap.assertCredentials`. Fail fast on missing
   `{ID}_GMAIL_USER` / `{ID}_GMAIL_APP_PASSWORD`.
2. Load `processed_messages.json`. Filter to entries with
   `type === "OTHER"`. Apply `--since` clamp (floor at `now - 30d`).
   Apply `--limit` if set.
3. Open one IMAP connection via `gmail_imap.makeGmailClient(creds)`.
   Resolve `[Gmail]/All Mail` via SPECIAL-USE `\All` flag (already
   handled by `resolveAllMailMailbox`).
4. For each filtered entry: `fetchOne` by `X-GM-MSGID` (hex→decimal via
   `hexToGmailId`). Run `classifier.classify({subject, body})`.
   - On `{type: "OTHER"}` (still OTHER) — log line `unchanged`, continue.
   - On non-OTHER — collect into `results[]` with old→new + evidence.
   - On IMAP fetch error (message deleted from Gmail, transient 5xx) —
     log `error`, continue. Transient errors retry 5x with backoff.
5. Close IMAP connection.
6. If dry-run: print summary, exit 0.
7. If `--apply`: rewrite `processed_messages.json` with reclassified
   `type` values. Preserve all other fields (`id`, `date`, `company`).
   Re-run prune (`saveProcessed` already prunes >30d) and bump
   `last_check`? **No** — `reclassify` is not a `check` tick, do not
   advance the cursor. Pass `existing.last_check` through unchanged.
8. If `--apply --notion`: for each reclassified row that has a Notion
   page mapping (via `applications.tsv` `notion_page_id`), prompt
   operator:
   ```
   [12/34] DentEmploy — Dental Hygienist — OTHER → INTERVIEW_INVITE
     evidence: "interview invitation"
     source: 18ad08abc1234
     current status: To Apply
     proposed status: Interview
     update? [y/N/skip-all/quit]:
   ```
   - `y` → call `notion_sync.updatePageStatus(pageId, newStatus)` +
     `addPageComment(pageId, botComment)`.
   - `N` (default) → skip this row, continue.
   - `skip-all` → skip the rest, no further prompts.
   - `quit` → stop immediately, exit 0.
   - For terminal statuses (`Rejected`, `Closed`, `No Response`) default
     answer is N (operator must explicitly type `y`).

### 3.3 Type → Notion-status mapping

```
INTERVIEW_INVITE → "Interview"
REJECTION        → "Rejected"
INFO_REQUEST     → (no status change; comment only)
ACKNOWLEDGMENT   → (no status change; comment only)
OTHER (unchanged) → not in results[]
```

### 3.4 Bot-comment shape

Added to Notion page on `--apply --notion` confirmation:

```
🤖 Reclassified via BL-44 (RFC 028): OTHER → INTERVIEW_INVITE
evidence: "interview invitation"
source: 18ad08abc1234 (2026-04-29)
```

### 3.5 IMAP batch-fetch helper

Existing `fetchMessageByGmailId(client, hexId)` in `gmail_imap.js` opens
+ closes the IMAP connection per call. For 30-120 ids per profile on
fly's cold-start machine, that's 30-120 reconnections × ~3-5s greeting.
Too slow.

Add a sibling function:

```js
async function fetchMessagesByGmailIds(client, hexIds, opts = {}) {
  // Opens connection once, resolves [Gmail]/All Mail once, locks mailbox
  // once, iterates hexIds via client.search({emailId: decimal}) + fetchOne.
  // Returns Array<{id: hex, raw: {messageId, subject, body, ...} | null,
  // error?: string}>. Logs out at the end.
}
```

New function, additive only. `fetchMessageByGmailId` stays untouched —
`scripts/dump_emails.js` keeps working.

### 3.6 Module surface

New file: `engine/commands/reclassify.js`. Exports:

```js
module.exports = { runReclassify, DEFAULT_DEPS, clampSinceIso,
                   fetchWithRetry, buildAllJobsMap, TYPE_TO_STATUS,
                   SKIP_STATUSES };
```

`DEFAULT_DEPS` mirrors the pattern in `check.js`: every side-effect
(`loadCredentials`, `makeGmailClient`, `fetchMessagesByGmailIds`,
`classify`, `loadProcessed`, `saveProcessed`, `loadApplications`,
`updatePageStatus`, `addPageComment`, `prompt`, `sleep`, `now`) is
injectable. Tests pass mocks; CLI wires real implementations.

CLI registration in `engine/cli.js`:

- `KNOWN_COMMANDS`: add `"reclassify"`.
- `defaultCommands`: `reclassify: require("./commands/reclassify.js")`.
- New flags: `--notion`, `--limit <N>`.
- `HELP_TEXT`: add reclassify block.

### 3.7 Profile + path resolution

`reclassify` reads from the same volume as `check`:

```js
const profilesDir = resolveProfilesDir(ctx, env || process.env);
profile = deps.loadProfile(profileId, { profilesDir });
```

(`resolveProfilesDir` from `engine/core/paths.js`. Picks
`AI_JOB_SEARCHER_DATA_DIR/profiles` on fly, falls back to repo-local
`profiles/` for dev.)

## 4. Test plan

`engine/commands/reclassify.test.js` — Node built-in test runner, no
framework. Mocked deps. Target: ≥15 cases, all green.

Groups:

- **clampSinceIso (4)** — null in / null out, explicit ISO passthrough,
  pre-30d clamp to floor, post-now clamp to now.
- **buildAllJobsMap (1)** — includes terminal-status rows (so
  "rejected after invite" still has page mapping).
- **TYPE_TO_STATUS (1)** — shape assertion.
- **fetchWithRetry (3)** — happy path, transient 5xx → success after
  retry, exhausted retries → throw.
- **runReclassify dry-run (5)** — no OTHER → exit 0 with summary; mixed
  OTHER reclassification → report; all-OTHER-still-OTHER → unchanged
  count; `--since` filter; `--limit` filter.
- **runReclassify --apply (2)** — JSON file mutated correctly; last_check
  NOT bumped.
- **runReclassify --apply --notion interactive (4)** — y confirms +
  calls updatePageStatus + addPageComment; N skips; skip-all halts
  further prompts; quit exits early.

Mock IMAP shape: `{ fetchMessagesByGmailIds: async (_, ids) => ids.map(
id => ({ id, raw: fixture[id] || null, error: errorFixture[id] })) }`.

## 5. Risks / rollback

- **Reclassify mis-fires on still-OTHER**: dry-run gates this — operator
  reviews report before `--apply`.
- **Notion update overwrites operator state**: per-row interactive
  prompt + default-N for terminal statuses. `skip-all` is a one-keystroke
  escape hatch.
- **IMAP connection drops mid-batch**: retry per-message with backoff;
  log error and continue. Worst case operator re-runs the command.
- **No rollback strategy on `processed_messages.json` mutation**: the
  file is small (30d window), operator can `git diff` it before commit
  if it's tracked; if not, take a copy before `--apply`. **Mitigation**:
  reclassify writes a `.bak` copy next to the file before mutating.

## 6. Done = all checked

- `engine/modules/tracking/gmail_imap.js` — `fetchMessagesByGmailIds`
  added with test coverage.
- `engine/commands/reclassify.js` — lands.
- `engine/cli.js` — registers `reclassify` + flags + HELP_TEXT.
- `engine/commands/reclassify.test.js` — ≥15 tests green.
- `npm test` exit 0, no count regression.
- `npm run lint && npm run format:check` exit 0.
- Code-reviewer subagent: 0 blockers.
- Fly redeploy.
- Dry-run on Lilia + Jared, reports shared with operator.
- Per-profile apply decisions executed.
- `BL-44.md` → done.
- `incidents.md` — entry on the "worktree drift" incident that triggered
  this redo (see RFC §7 below).

## 7. Process note (incident-driven addendum)

Originally implemented in a stale worktree (`claude/hardcore-pascal-a0dba3`)
as an OAuth-based reclassify, before `git fetch` would have shown the
`OAuth → IMAP` transport switch landed on `main` (commit `048524b`,
BL-21/RFC-021 main-numbering). That work was discarded.

Mitigation captured in `incidents.md`:

- Open a worktree → first command is `git fetch origin && git log
  origin/main --oneline -20`. Read recent main commits before planning.
- When fixing a "Decision" in a backlog file, the premise must be
  verified in **code** (greppable), not in adjacent infra (e.g. `fly
  secrets list`). Infra can lie about what code actually does.

End RFC 028.
