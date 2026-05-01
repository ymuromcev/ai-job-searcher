#!/usr/bin/env bash
# Set Jared's secrets on fly.io for ai-job-searcher-cron.
#
# Reads values from local .env and from Phase 1's OAuth credentials file.
# Never echoes secret values. Uses one fly call (atomic — single restart).
#
# Run AFTER:
#   - scripts/gmail_auth.js --profile jared (one-time OAuth)
#   - .env has JARED_NOTION_TOKEN / JARED_GMAIL_CLIENT_ID / JARED_GMAIL_CLIENT_SECRET
#
# Usage: ./scripts/set_fly_secrets_jared.sh
#
# Idempotent: re-running just rolls a new release with same values.

set -euo pipefail

ENV_FILE=".env"
OAUTH_FILE="profiles/jared/.gmail-tokens/credentials.json"
APP_NAME="ai-job-searcher-cron"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found (run from repo root)" >&2
  exit 1
fi
if [[ ! -f "$OAUTH_FILE" ]]; then
  echo "error: $OAUTH_FILE not found — run scripts/gmail_auth.js --profile jared first" >&2
  exit 1
fi

extract_env() {
  local key="$1"
  local val
  val=$(grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2-) || true
  if [[ -z "$val" ]]; then
    echo "error: ${key} not found in $ENV_FILE" >&2
    exit 1
  fi
  printf "%s" "$val"
}

JARED_NOTION=$(extract_env "JARED_NOTION_TOKEN")
JARED_GCID=$(extract_env "JARED_GMAIL_CLIENT_ID")
JARED_GCS=$(extract_env "JARED_GMAIL_CLIENT_SECRET")
JARED_REFRESH=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("'"$OAUTH_FILE"'")).refresh_token)')

if [[ -z "$JARED_REFRESH" ]]; then
  echo "error: refresh_token field empty in $OAUTH_FILE" >&2
  exit 1
fi

echo "Setting 4 Jared secrets on $APP_NAME..."

fly secrets set \
  JARED_NOTION_TOKEN="$JARED_NOTION" \
  JARED_GMAIL_CLIENT_ID="$JARED_GCID" \
  JARED_GMAIL_CLIENT_SECRET="$JARED_GCS" \
  JARED_GMAIL_REFRESH_TOKEN="$JARED_REFRESH" \
  --app "$APP_NAME"

echo "✓ done"
