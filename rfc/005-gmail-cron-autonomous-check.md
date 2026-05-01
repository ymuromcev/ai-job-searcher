# RFC 005 — Autonomous Gmail Check (cron via fly.io)

**Status**: Draft — awaiting approval
**Tier**: L (security: OAuth tokens at rest, autonomous email reading, remote execution)
**Author**: Claude (sonnet), 2026-04-27
**Depends on**: RFC 002 (check command — MCP two-phase flow)

---

## 1. Problem

`check` currently requires a Claude Code session — it's a two-phase flow: `--prepare` emits Gmail batches → human pastes them into Claude MCP → MCP fetches emails → writes `raw_emails.json` → `--apply` consumes it. Nice for control, useless for "run while user sleeps."

User goal (verbatim): *"чтобы то, что работает сейчас по ручному запуску, работало самостоятельно. И пусть запускается где-то в 8 утра по PST и остается так же возможность запустить вручную, если надо."*

## 2. Goals

- **Autonomous daily run** at 8am PST, regardless of Mac state (off / asleep / closed lid).
- **Manual run still works** locally on Mac — same code path, same end result.
- **Per-profile isolation** — Jared's Gmail credentials never touch Lilia's runs.
- **Read-only access** — `gmail.readonly` scope. Never send/delete/modify mail.
- **Fail safe**: a failed run logs and exits, doesn't corrupt state. Next day's run handles transient issues.
- **Failure notification**: any cron failure posts a Notion comment to a per-profile ops page so the user knows the scan didn't run. Approved 2026-04-27.

## 3. Non-goals

- Real-time email processing (push notifications, IMAP IDLE). Daily batch is enough.
- Web UI for state inspection. Logs + Notion are the UI.
- Multi-region failover. Single fly.io machine in `sjc` is plenty.
- ~~Notification on failure beyond log file (deferred to BACKLOG).~~ → **APPROVED in scope**: Notion-comment to per-profile ops page (cheapest path — already have Notion token).

## 4. Architecture

### 4.1 Three components

```
┌─────────────────────────────┐      ┌────────────────────────┐
│ engine/modules/tracking/    │      │ scripts/gmail_auth.js  │
│   gmail_oauth.js            │      │ (one-time consent)     │
│ — googleapis SDK wrapper    │      │                        │
│ — fetchEmailsForBatches()   │      │ Local browser → token  │
└──────────────┬──────────────┘      └───────────┬────────────┘
               │                                  │
               │ used by                          │ writes refresh-token to
               ▼                                  ▼
┌─────────────────────────────────────────────────────────────┐
│ engine/commands/check.js                                    │
│   --auto flag: prepare → gmail_oauth.fetch → apply (single  │
│   process). Existing --prepare/--apply MCP flow untouched.  │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Two execution paths, same code

**Local (manual)** on Mac:
```
node engine/cli.js check --profile jared --auto
```
- Reads creds from local `.env` (`{ID}_GMAIL_CLIENT_ID`, `{ID}_GMAIL_CLIENT_SECRET`)
- Reads refresh-token from `profiles/<id>/.gmail-tokens/credentials.json`
- Writes state (TSV updates, processed_messages.json, log files) to local profile dir
- Notion writes hit Notion API directly

**Remote (cron)** on fly.io machine:
- Same command, same flags, same code
- Reads creds from fly secrets (env vars in container)
- Reads refresh-token from `/data/profiles/<id>/.gmail-tokens/credentials.json` (mounted volume)
- Writes state to `/data/profiles/<id>/` (volume — survives machine restart)
- Notion writes hit Notion API directly

### 4.3 fly.io setup

- **One machine**: `shared-cpu-1x` 256MB (cheapest tier, fits Node fine)
- **One volume**: 1GB persistent storage at `/data` for state files
- **Cron via supercronic** inside the container (not external scheduler — keeps it simple, machine stays warm)
- **Region**: `sjc` (San Jose, closest to PST)
- **Schedule**: `0 8 * * *` in `America/Los_Angeles` TZ → 8am PST/PDT daily
- **Free tier fit**: 3 shared-cpu-1x + 3GB volume = free. We use 1+1GB. Within budget.

### 4.4 OAuth flow

- **Per-profile separate Google Cloud project** — user creates one project per profile, generates OAuth client (Desktop app type), saves `client_id` + `client_secret` to root `.env` as `{ID}_GMAIL_CLIENT_ID` / `{ID}_GMAIL_CLIENT_SECRET`
- **One-time consent** locally:
  1. `node scripts/gmail_auth.js --profile jared`
  2. Script starts local HTTP server on `localhost:3000`
  3. Opens browser to Google consent URL with `redirect_uri=http://localhost:3000/oauth-callback`
  4. User clicks "Allow", Google redirects back with code
  5. Script exchanges code for refresh-token, saves to `profiles/jared/.gmail-tokens/credentials.json`
  6. Script prints next-step: `fly secrets set JARED_GMAIL_REFRESH_TOKEN=<token> --app ai-job-searcher-cron`
- **Token rotation**: googleapis SDK auto-refreshes access-token using refresh-token. Refresh-tokens themselves don't expire unless user revokes at console.cloud.google.com or 6 months of inactivity (we run daily → never inactive).

### 4.5 State sync between Mac and fly.io

**Decision: don't auto-sync.** Two parallel state stores, deliberate.

- 99% of runs are cron on fly. Mac state is for emergency manual debugging.
- `processed_messages.json` (per side) prevents re-processing on its own side.
- Notion is the source of truth for status — both sides update it; status set is idempotent (writing "Rejected" twice = same outcome).
- Risk: same email processed twice across sides (once by cron, once by manual) → Notion gets one extra comment. Acceptable.

If user needs Mac state to match fly state for some reason, manual command:
```
fly ssh sftp shell --app ai-job-searcher-cron
get /data/profiles/jared/.gmail-state/processed_messages.json
```

Document this in `docs/gmail_cron.md`. Don't automate.

### 4.6 Failure notification

**Path**: per-profile Notion ops page. Cheapest because we already hold `{ID}_NOTION_TOKEN`. No new secrets, no new services.

- **Setup (one-time)**: user creates a single Notion page per profile (e.g. "Cron Ops"), shares it with the same integration that already has access to Jobs/Companies DBs, pastes its id into `profile.json.notion.cron_ops_page_id`.
- **On failure** (any uncaught throw in `runAuto`):
  1. Catch at top of `check.js` `runAuto`
  2. Build a comment: `🔴 [{ISO timestamp}] check --auto failed for {profile_id}\n\n{error.name}: {error.message}\n\nStack:\n{stack first 20 lines}`
  3. Best-effort `notion.comments.create({ parent: { page_id: cron_ops_page_id }, rich_text: [...] })`
  4. Always also write to `profiles/<id>/.gmail-state/cron_failures.log` (append). Notion-post failure is itself swallowed (we don't want a notification-failure to mask the original).
  5. Process exits with code 1 → supercronic logs the non-zero exit → `fly logs` shows it
- **Cron wrapper**: `cron/check.cron` runs `node engine/cli.js check --profile X --auto || true` per profile so one failure doesn't block the other.
- **De-dup / spam prevention**: not needed at v1. If the same failure repeats 7 days in a row that's 7 comments — acceptable signal that something is broken. If it becomes noisy, throttle later (BACKLOG).
- **Test coverage**: mock `notion.comments.create` + force throw in `gmail_oauth.fetchEmailsForBatches` → assert comment posted with timestamp + error message + log line written.

### 4.7 Secrets matrix

| Secret | Where on Mac | Where on fly |
|---|---|---|
| `{ID}_NOTION_TOKEN` | root `.env` | `fly secrets set` |
| `{ID}_GMAIL_CLIENT_ID` | root `.env` | `fly secrets set` |
| `{ID}_GMAIL_CLIENT_SECRET` | root `.env` | `fly secrets set` |
| Refresh-token | `profiles/<id>/.gmail-tokens/credentials.json` (gitignored) | `fly secrets set {ID}_GMAIL_REFRESH_TOKEN=...` |

Refresh-token specifically as a secret (not file) on fly to avoid bind-mounting credentials. On Mac, file is OK because we control disk encryption.

## 5. Implementation plan

1. **`engine/modules/tracking/gmail_oauth.js`** — googleapis wrapper:
   - `loadCredentials(profileId)` — reads client_id/secret from env, refresh-token from file (Mac) or env (fly)
   - `fetchEmailsForBatches(batches, since)` — iterates batches, calls `gmail.users.messages.list` + `messages.get` for each match, returns same shape as today's `raw_emails.json`
   - Tests: mock googleapis, verify pagination, verify filter format `from:({a} OR {b}) after:{epoch}`

2. **`scripts/gmail_auth.js`** — one-time consent flow:
   - Express-free: minimal `http.createServer` on `localhost:3000`
   - Uses `googleapis` `OAuth2Client.generateAuthUrl()` with offline access
   - Captures code, exchanges, writes credentials file
   - Prints `fly secrets set` command for next step

3. **`engine/commands/check.js`** — add `--auto` flag:
   - Detection: `if (args.auto) { runAuto() } else if (args.prepare) {...} else {...}`
   - `runAuto`: same logic as `--prepare` (build batches) → `gmail_oauth.fetchEmailsForBatches(batches, since)` → same logic as `--apply` (process). Single in-memory pass, no `raw_emails.json` written.
   - State paths respect `AI_JOB_SEARCHER_DATA_DIR` env var (default: repo root) so fly container can override to `/data`

4. **fly.io infra**:
   - `Dockerfile` — `node:20-alpine` + `supercronic`, copy code, `CMD ["supercronic", "/etc/cron.d/check"]`
   - `fly.toml` — single machine, 1GB volume mount at `/data`, no public ports
   - `cron/check.cron` — `0 8 * * * cd /app && AI_JOB_SEARCHER_DATA_DIR=/data node engine/cli.js check --profile jared --auto && node engine/cli.js check --profile lilia --auto`
   - `scripts/deploy_fly.sh` — `fly deploy` wrapper with pre-flight checks (secrets set? volume created?)

5. **Tests**:
   - `gmail_oauth.test.js` — mock googleapis, exercise pagination, error cases
   - `check.test.js` — extend with `--auto` path covered (mock gmail_oauth)
   - No tests for fly.io infra (smoke = `fly deploy` + `fly logs`)

6. **Docs**:
   - `docs/gmail_cron.md` — setup runbook (Google Cloud project, OAuth client, gmail_auth, fly deploy, secrets, smoke test, troubleshooting)
   - Update `CLAUDE.md` with new flag

## 6. Cost

- fly.io free tier: 3 shared-cpu-1x machines + 3GB volume → $0/mo if we fit
- We use: 1 machine + 1GB volume → fits
- If fly.io tightens free tier: ~$5/mo for 1 shared-cpu-1x or migrate to Hetzner CX11 (€3.79/mo)

## 7. Risks

| Risk | Mitigation |
|---|---|
| fly.io free tier shrinks | Migrate to Hetzner — same Docker image, swap deployment script |
| Refresh-token revoked at Google | Cron run errors → log shows "invalid_grant" → user re-runs `gmail_auth.js` and `fly secrets set` |
| Notion API rate limit | `notion_sync` already has exponential backoff; per-day batch (~50 emails) well under limits |
| Mac local state drifts from fly state | Documented as expected — no auto-sync. Notion is truth. |
| googleapis SDK breaking change | Pin to major version, test on bump |
| 8am PST cron fires when Mac IS on AND user runs manually same morning | Both sides have own `processed_messages.json` — duplicate Notion writes happen once, idempotent |

## 8. Acceptance criteria

- [ ] `node engine/cli.js check --profile jared --auto` runs end-to-end locally without MCP. Same for lilia.
- [ ] `scripts/gmail_auth.js --profile <id>` opens browser, captures token, writes file.
- [ ] Dockerfile builds, container starts.
- [ ] `fly deploy` succeeds, machine starts, supercronic logs `crontab loaded`.
- [ ] Manual fly trigger: `fly ssh console --command "node /app/engine/cli.js check --profile jared --auto"` runs successfully.
- [ ] Cron triggers at 8am PST on the next morning, both profiles processed, log shows success.
- [ ] 7 consecutive days of green runs.
- [ ] Tests: `npm test` 524 → 540ish (new tests added). All green.

## 9. Deferred (BACKLOG follow-ups)

- Notification on failure (osascript / Pushover / Slack webhook)
- Auto state sync between Mac and fly (rsync over fly ssh)
- Multiple cron times per day (e.g. 8am + 6pm)
- IMAP backend for non-Gmail profiles (already in BACKLOG from RFC 002)
- Web UI to inspect last N runs

---

## 10. Open questions for approve

Before I start coding, please confirm:

**Q1.** **Cron schedule: 8am PST daily, both profiles back-to-back.** OK, or want different times per profile / different days?

**Q2.** **fly.io region: `sjc` (San Jose).** OK, or prefer `sea`/`lax`/other?

**Q3.** **App name on fly.io: `ai-job-searcher-cron`.** OK, or want a private suffix like `ai-job-searcher-cron-ymuromcev` (fly.io app names are globally unique)?

**Q4.** **Per-profile Google Cloud project (separate `client_id`/`client_secret` per profile)** — confirmed earlier. Just re-confirming this means **2 Google Cloud projects to set up manually** (one for jared@gmail, one for lilia@gmail). OK?

**Q5.** **State persistence on fly: 1GB volume at `/data`.** Should be enough for years of TSV + JSON state. OK?

**Q6.** ~~Failure handling: log to file only.~~ → **APPROVED 2026-04-27**: Notion-comment to per-profile `cron_ops_page_id`. Spec in §4.6.

---

## 11. Approval status (2026-04-27)

All Q1-Q6 approved by user:
- **Q1** Cron `0 8 * * * America/Los_Angeles`, jared → lilia back-to-back ✅
- **Q2** fly.io region `sjc` ✅
- **Q3** App name `ai-job-searcher-cron` (fallback `-ymuromcev` suffix if globally taken) ✅
- **Q4** Per-profile Google Cloud project (2 projects total) ✅
- **Q5** 1GB volume at `/data` ✅
- **Q6** Notion-comment failure notification to per-profile ops page ✅

→ Implementation begins.
