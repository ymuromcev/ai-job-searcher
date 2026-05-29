---
title: "Gmail cron — autonomous check --auto"
status: stable
type: runbook
tags: [gmail, cron, fly, ops]
---

# Gmail cron — autonomous `check --auto`

Runbook for the autonomous email-tracker. Two execution modes share the same
code path:

- **Local (manual)** — `node engine/cli.js check --profile <id> --auto` on
  your Mac. No Claude / MCP needed. Useful for one-off runs and debugging.
- **Remote (cron)** — fly.io machine runs the same command at 8am PST daily
  for every active profile.

Transport: **IMAP + app-specific password** (RFC 021). No OAuth, no
`googleapis`, no consent-screen flow. App-passwords don't expire, so the
cron no longer needs weekly re-authentication.

---

## 1. One-time setup per profile

Repeat for each profile (`jared`, `lilia`, …). If profiles live in
different Google Accounts, do step 1a-1b in **each** account independently.

### 1a. Enable 2FA

App-passwords require 2-Step Verification. Skip if already on.

1. `myaccount.google.com/security`
2. **2-Step Verification** → on (any second factor — SMS, Authenticator,
   hardware key — all work).

### 1b. Generate an app-password

1. `myaccount.google.com/apppasswords`
2. App name: `ai-job-searcher` (any label — appears only in the user's
   security log).
3. Copy the 16-character password Google shows. **This is the only time
   it's displayed** — store it carefully or paste straight into `.env`.

The page is gated on 2FA. If you don't see it, recheck step 1a.

### 1c. Add credentials to root `.env`

For each profile:

```
<ID_UPPER>_GMAIL_USER=foo@gmail.com
<ID_UPPER>_GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
```

The `.env` is gitignored. Pre-commit hook detects common secret prefixes.

### 1d. Local smoke test

Dry-run first (no Notion writes, no TSV writes):

```
node engine/cli.js check --profile <id> --auto
```

This:
- Fetches emails since `last_check` (or 30 days, whichever is newer).
- Classifies them.
- Prints a JSON plan.
- Does not write anything.

Then commit with `--apply`:

```
node engine/cli.js check --profile <id> --auto --apply
```

This:
- Same fetch + classify.
- Pushes status updates + comments to Notion.
- Updates `applications.tsv`, appends `rejection_log.md` /
  `recruiter_leads.md` / `email_check_log.md`.
- Saves processed message ids and bumps `last_check`.

Override the cursor for a back-fill (e.g. re-check the past 30 days):

```
node engine/cli.js check --profile <id> --auto --since 2026-04-01T00:00:00Z --apply
```

`--since` is clamped to 30 days ago — Gmail's `after:` search has a
floor that we don't try to outsmart.

---

## 2. fly.io cron deploy

The same code runs on a single fly.io machine via supercronic, firing
`--auto --apply` for every profile at 8am PT daily.

### 2a. Prerequisites

- `flyctl` installed: <https://fly.io/docs/hands-on/install-flyctl/>
- Logged in: `fly auth login` (one-time)
- §1 already done for each profile — app-passwords already in local `.env`

### 2b. One-time bootstrap

```
./scripts/deploy_fly.sh --bootstrap
```

Creates app `ai-job-searcher-cron` (region `sjc`) and volume
`ai_job_searcher_data` (1GB at `/data`). Fails fast on missing secrets —
expected, you haven't set them yet.

### 2c. Set secrets

```
fly secrets set \
  JARED_NOTION_TOKEN="$(grep '^JARED_NOTION_TOKEN=' .env | cut -d= -f2-)" \
  JARED_GMAIL_USER="$(grep '^JARED_GMAIL_USER=' .env | cut -d= -f2-)" \
  JARED_GMAIL_APP_PASSWORD="$(grep '^JARED_GMAIL_APP_PASSWORD=' .env | cut -d= -f2-)" \
  LILIA_NOTION_TOKEN="$(grep '^LILIA_NOTION_TOKEN=' .env | cut -d= -f2-)" \
  LILIA_GMAIL_USER="$(grep '^LILIA_GMAIL_USER=' .env | cut -d= -f2-)" \
  LILIA_GMAIL_APP_PASSWORD="$(grep '^LILIA_GMAIL_APP_PASSWORD=' .env | cut -d= -f2-)" \
  --app ai-job-searcher-cron
```

`scripts/set_fly_secrets_jared.sh` does this for `jared` end-to-end if
you don't want to type the line above.

### 2d. First deploy

```
./scripts/deploy_fly.sh
```

The script verifies app + volume + every required secret before running
`fly deploy`. Build takes ~2 minutes. supercronic starts on boot and
waits for the next 8am PT tick.

### 2e. Smoke

Trigger one cron line manually inside the running container:

```
fly ssh console -a ai-job-searcher-cron \
  --command 'node /app/engine/cli.js check --profile jared --auto'

fly ssh console -a ai-job-searcher-cron \
  --command 'node /app/engine/cli.js check --profile lilia --auto'
```

Expect JSON with `emailsFound: <n>` and no errors. Then the same with
`--apply` for a real run. Check Notion DB for any new comments / status
changes.

### 2f. Logs

```
fly logs -a ai-job-searcher-cron        # tail
fly logs -a ai-job-searcher-cron --json # structured
```

Each cron line prints stdout/stderr; supercronic adds a one-line summary
when the job completes (`job succeeded` / `job failed`).

### 2g. State on the volume

The 1GB volume at `/data` keeps `processed_messages.json`, `applications.tsv`,
log files, etc. — survives machine restarts and deploys. To inspect:

```
fly ssh console -a ai-job-searcher-cron --command 'ls -la /data/profiles/<id>'
```

State on Mac and state on fly are deliberately not synced. Notion is the
source of truth for status; each side's `processed_messages.json` prevents
re-processing on its own side.

### 2h. Updating the schedule

Edit `cron/check.cron` and redeploy. supercronic reloads on container
restart, which `fly deploy` does automatically.

### 2i. Rolling back

```
fly releases -a ai-job-searcher-cron     # find a known-good version
fly deploy --image registry.fly.io/ai-job-searcher-cron:<version>
```

---

## 3. Operational notes

### App-password rotation

App-passwords don't expire automatically. They're invalidated when:

- You revoke them at `myaccount.google.com/apppasswords`.
- You change your Google password (all app-passwords are wiped).
- You turn off 2-Step Verification (same — all app-passwords wiped).

If you see `AUTHENTICATIONFAILED` from `--auto`, generate a new
app-password and re-run §1c-1d locally, then update fly secrets per §2c.

### Multiple Gmail accounts

Each profile gets its own `<ID_UPPER>_GMAIL_USER` / `_APP_PASSWORD`.
Profiles never share credentials. If two profiles live in the **same**
Google Account you can technically share an app-password — but it's
cleaner to generate a separate one per profile so you can revoke
selectively.

### Read-only by convention

The `check` command never STOREs, EXPUNGEs, or APPENDs. The `gmail_imap.js`
module exposes only fetch/search calls. Gmail's IMAP doesn't have
per-app scope limits the way OAuth does, so this is a code-level
invariant — keep it that way.

### State sync between Mac and fly.io

Two parallel state stores exist (Mac local + fly.io volume). Notion is
the source of truth for status; each side's `processed_messages.json`
prevents re-processing on its own side.

Since RFC 055, `check` runs the auto-sync pre-hook (like `scan` /
`prepare`): it pulls Notion -> TSV **additively** before reading the
local TSV, creating rows for any Notion application the local TSV did
not list. So the fly volume's `applications.tsv` is no longer a frozen
copy -- every tick it reconstructs the full active set from Notion and
the cron tracks every applied job, not just the ones present at deploy
time. Pass `--no-sync` to skip the pull (e.g. offline debugging).

If one side processes the same email the other side already saw, you
get one extra Notion comment. Status itself is idempotent.

### Failures

`--auto` surfaces errors to stderr, exits non-zero, and (Phase 3 / RFC 005
§4.6) posts an @-mention comment to the per-profile `cron_ops_page_id`
Notion page. The on-disk `cron_failures.log` in `.gmail-state/` is the
durable record.

---

## 4. Troubleshooting

| Error | Likely cause | Fix |
|---|---|---|
| `missing <ID_UPPER>_GMAIL_USER` | Env var not set | Add to root `.env` (§1c). |
| `missing <ID_UPPER>_GMAIL_APP_PASSWORD` | Env var not set | Generate at `myaccount.google.com/apppasswords` (§1b). |
| `AUTHENTICATIONFAILED` / `Invalid credentials` | App-password revoked, password changed, or 2FA disabled | Regenerate per §1b, update `.env` + fly secrets. |
| `Mailbox doesn't exist` | Localized Gmail account (e.g. `[Gmail]/Vsya pochta`) | Open `gmail.com` → Settings → Labels → enable "Show in IMAP" on All Mail. As a last resort, override the constant in `gmail_imap.js`. |
| Notion 401 | `<ID_UPPER>_NOTION_TOKEN` stale | Refresh the integration token in Notion settings. |
| Empty `emailsFound` after long absence | `last_check` more than 30 days ago | Pass `--since <ISO>` to widen the window (clamped to 30d). |

---

## 5. What got built

- `engine/modules/tracking/gmail_imap.js` — imapflow wrapper. Pure: takes
  credentials in, returns emails out. Round-trip-tested for Gmail
  message-id hex↔decimal compatibility with `processed_messages.json`.
- `engine/commands/check.js --auto` — single-process flow. Reads fresh
  `processed_messages` from disk, fetches via IMAP, classifies, applies.
- `scripts/dump_emails.js` — read-only debug helper, fetches a single
  Gmail message by its REST API hex id (same format `processed_messages.json`
  stores).

See [RFC 021](../../rfc/021-gmail-cron-imap.md) for the OAuth→IMAP cutover
rationale and [incidents.md](../../incidents.md) for the post-mortem on
the 7-day refresh-token expiry that drove this work.
