# Gmail cron — autonomous `check --auto`

Runbook for the autonomous email-tracker. Two execution modes share the same
code path:

- **Local (manual)** — `node engine/cli.js check --profile <id> --auto` on your
  Mac. No Claude / MCP needed. Useful for one-off runs and debugging.
- **Remote (cron)** — fly.io machine runs the same command at 8am PST daily.
  Phase 2 (deferred). Phase 1 ships the `--auto` flag and OAuth wiring.

This document covers Phase 1 setup. Phase 2 (fly.io) lands in a follow-up.

---

## 1. One-time setup per profile

You'll do this once per profile (e.g. once for `jared`, once for `lilia`).

### 1a. Create a Google Cloud OAuth client

1. Go to <https://console.cloud.google.com/projectcreate> — create a new
   project (e.g. `ai-job-searcher-jared`). One project per profile keeps
   audit trails clean. Skip if you already have one.
2. Inside the project, go to **APIs & Services → Library**, search "Gmail
   API", click **Enable**.
3. **APIs & Services → OAuth consent screen** → **External** (unless you
   have a Workspace org). App name: `ai-job-searcher`. User support email:
   your own. Add the scope `https://www.googleapis.com/auth/gmail.readonly`
   (search by name). Add yourself as a **Test user** (your Gmail address).
   Save.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Desktop app**
   - Name: `ai-job-searcher-cli` (any)
5. Copy the **Client ID** and **Client Secret**.

### 1b. Add credentials to root `.env`

```
JARED_GMAIL_CLIENT_ID=...apps.googleusercontent.com
JARED_GMAIL_CLIENT_SECRET=GOCSPX-...
```

For Lilia:

```
LILIA_GMAIL_CLIENT_ID=...apps.googleusercontent.com
LILIA_GMAIL_CLIENT_SECRET=GOCSPX-...
```

The `.env` is gitignored. Pre-commit hook also blocks `GOCSPX-` strings.

### 1c. Run the consent flow

```
node scripts/gmail_auth.js --profile jared
```

What happens:

1. Local HTTP server starts on `http://localhost:3000`.
2. Your default browser opens Google's consent screen.
3. Pick the right Gmail account, click **Allow**.
4. Google redirects to `http://localhost:3000/oauth-callback?code=...`.
5. The script exchanges the code for a refresh-token and writes it to
   `profiles/jared/.gmail-tokens/credentials.json` (mode 600, gitignored).
6. The script also writes a ready-to-run fly-secrets command to
   `profiles/jared/.gmail-tokens/fly-secret-command.sh` (mode 600,
   gitignored). Run it once when you do Phase 2 (fly.io cron) — then
   `rm` the file. The refresh-token is never echoed to stdout or the
   shell's history.

If consent screen says "This app isn't verified" — that's expected for a
Desktop app in Testing mode. Click **Advanced → Go to ai-job-searcher
(unsafe)**. You're approving an app you yourself just created.

If port 3000 is taken: `GMAIL_AUTH_PORT=3030 node scripts/gmail_auth.js
--profile jared` (and add `http://localhost:3030/oauth-callback` to your
OAuth client's redirect URIs in the Google Cloud console).

If the script reports `no refresh_token in response`: revoke the prior
consent at <https://myaccount.google.com/permissions> → Security →
Third-party apps → ai-job-searcher → Remove access, then re-run.

---

## 2. Local smoke test

Dry-run first (no Notion writes, no TSV writes):

```
node engine/cli.js check --profile jared --auto
```

This:
- Fetches emails since `last_check` (or 30 days, whichever is newer).
- Classifies them.
- Prints a JSON plan.
- Does not write anything.

Then commit with `--apply`:

```
node engine/cli.js check --profile jared --auto --apply
```

This:
- Same fetch + classify.
- Pushes status updates + comments to Notion.
- Updates `applications.tsv`, appends `rejection_log.md` /
  `recruiter_leads.md` / `email_check_log.md`.
- Saves processed message ids and bumps `last_check`.

Override the cursor for a back-fill (e.g. re-check the past 30 days):

```
node engine/cli.js check --profile jared --auto --since 2026-04-01T00:00:00Z --apply
```

`--since` is clamped to 30 days ago — Gmail search has a hard floor.

---

## 2bis. Phase 2 — fly.io cron deploy

Once Phase 1 is green locally, ship the same code to a fly.io machine that
fires `--auto --apply` daily at 8am PT for every profile.

### 2bis.a Prerequisites

- `flyctl` installed: <https://fly.io/docs/hands-on/install-flyctl/>
- Logged in: `fly auth login` (one-time)
- Phase 1 already done — refresh-tokens already saved per profile

### 2bis.b One-time bootstrap

```
./scripts/deploy_fly.sh --bootstrap
```

This creates:
- App `ai-job-searcher-cron` (region `sjc`)
- Volume `ai_job_searcher_data` 1GB at `/data`

Then it fails fast on missing secrets (expected — you haven't set them yet).

### 2bis.c Set secrets

For each profile, secrets must be set on fly. **Never paste them into your
shell history**: instead, use the helper file written by `gmail_auth.js`.

```
# Refresh-token (value already saved by Phase 1):
sh profiles/jared/.gmail-tokens/fly-secret-command.sh

# Other per-profile secrets (read from your local .env):
fly secrets set \
  JARED_NOTION_TOKEN="$(grep '^JARED_NOTION_TOKEN=' .env | cut -d= -f2-)" \
  JARED_GMAIL_CLIENT_ID="$(grep '^JARED_GMAIL_CLIENT_ID=' .env | cut -d= -f2-)" \
  JARED_GMAIL_CLIENT_SECRET="$(grep '^JARED_GMAIL_CLIENT_SECRET=' .env | cut -d= -f2-)" \
  --app ai-job-searcher-cron
```

Repeat for `lilia`. After the refresh-token is set on fly, **delete the
helper file** so it doesn't linger in the repo dir:

```
rm profiles/jared/.gmail-tokens/fly-secret-command.sh
rm profiles/lilia/.gmail-tokens/fly-secret-command.sh
```

The local `credentials.json` stays — Mac runs need it.

### 2bis.d First deploy

```
./scripts/deploy_fly.sh
```

The script verifies app + volume + every required secret before running
`fly deploy`. Build takes ~2 minutes. The supercronic process starts on
boot and waits for 8am PT.

### 2bis.e Smoke

Trigger one cron line manually inside the running container:

```
fly ssh console -a ai-job-searcher-cron \
  --command 'node /app/engine/cli.js check --profile jared --auto'
```

Expect a JSON plan in stdout with `emailsFound: <n>` and no errors. Then
the same with `--apply` for a real run. Check Notion DB for any new
comments / status changes.

### 2bis.f Logs

```
fly logs -a ai-job-searcher-cron        # tail
fly logs -a ai-job-searcher-cron --json # structured
```

Each cron line prints stdout/stderr; supercronic adds a one-line summary
when the job completes (`job succeeded` / `job failed`).

### 2bis.g State on the volume

The 1GB volume at `/data` keeps `processed_messages.json`, `applications.tsv`,
log files, etc. — survives machine restarts and deploys. To inspect:

```
fly ssh console -a ai-job-searcher-cron --command 'ls -la /data/profiles/jared'
```

State on Mac and state on fly are deliberately not synced. Notion is the
source of truth for status; each side's `processed_messages.json` prevents
re-processing on its own side.

### 2bis.h Updating the schedule

Edit `cron/check.cron` and redeploy. supercronic reloads on container
restart, which `fly deploy` does automatically.

### 2bis.i Rolling back

```
fly releases -a ai-job-searcher-cron     # find a known-good version
fly deploy --image registry.fly.io/ai-job-searcher-cron:<version>
```

---

## 3. Operational notes

### Token rotation

Refresh-tokens don't expire automatically. They're invalidated when:
- You revoke the app at myaccount.google.com.
- 6 months of inactivity (we run daily — never inactive).
- Password change with "Sign out everywhere".
- The Cloud project is deleted.

If you see `invalid_grant` errors from `--auto`, re-run `gmail_auth.js`.

### Multiple Gmail accounts

Each profile gets its own OAuth client and its own refresh-token. Profiles
never share credentials. The `loadCredentials` helper looks up env vars
prefixed by the uppercased profile id (`JARED_*`, `LILIA_*`).

### Read-only scope

We only ever request `gmail.readonly`. The script will not (cannot) send,
delete, or modify mail. If you see a different scope in the consent screen,
something is wrong — abort.

### State sync between Mac and fly.io (Phase 2)

After Phase 2 ships, two parallel state stores will exist (Mac local +
fly.io volume). They're deliberately not auto-synced. Notion is the source
of truth for status; the per-side `processed_messages.json` prevents
re-processing on its own side.

If one side processes the same email the other side already saw, you get
one extra Notion comment. Status itself is idempotent.

### Failures

Phase 1 surfaces errors to stderr and exits non-zero. Phase 3 will add a
Notion-comment notification to a per-profile ops page.

For now, if cron silently fails on fly: `fly logs --app
ai-job-searcher-cron` or `fly ssh console`.

---

## 4. Troubleshooting

| Error | Likely cause | Fix |
|---|---|---|
| `missing JARED_GMAIL_CLIENT_ID` | Env vars not set | Add to root `.env`. |
| `gmail_oauth: missing refresh_token` | OAuth never run | Run `scripts/gmail_auth.js --profile jared`. |
| `invalid_grant` during fetch | Refresh-token revoked | Re-run `gmail_auth.js`. |
| `port 3000 already in use` | Another process on 3000 | `GMAIL_AUTH_PORT=3030 ...` and update OAuth redirect URI. |
| `no refresh_token in response` | Prior consent without `prompt=consent` | Revoke at myaccount.google.com → re-run. |
| Notion 401 | `JARED_NOTION_TOKEN` stale | Refresh the integration token in Notion settings. |
| Empty `emailsFound` after long absence | `last_check` more than 30 days ago | Pass `--since <ISO>` to widen the window (clamped to 30d). |

---

## 5. What got built (Phase 1)

- `engine/modules/tracking/gmail_oauth.js` — googleapis wrapper. Pure: takes
  credentials in, returns emails out. 28 unit tests.
- `scripts/gmail_auth.js` — one-time OAuth consent. Captures token on
  localhost:3000.
- `engine/commands/check.js --auto` — single-process flow. Reads fresh
  `processed_messages` from disk, fetches via OAuth, classifies, applies.
  9 unit tests covering the new path.
- Refactored `runApply` to share `processEmailsLoop` + `applyMutations`
  with `runAuto` (no behavior change for `--apply`).
