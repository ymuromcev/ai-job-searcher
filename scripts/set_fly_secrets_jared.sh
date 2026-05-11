#!/usr/bin/env bash
# Set Jared's secrets on fly.io for ai-job-searcher-cron.
#
# Reads values from local .env. Never echoes secret values. Uses one fly call
# (atomic — single restart).
#
# Run AFTER:
#   .env has JARED_NOTION_TOKEN / JARED_GMAIL_USER / JARED_GMAIL_APP_PASSWORD
#   (Generate the app-password at myaccount.google.com/apppasswords — see
#    docs/runbooks/gmail-cron.md §1.)
#
# Usage: ./scripts/set_fly_secrets_jared.sh
#
# Idempotent: re-running just rolls a new release with same values.

set -euo pipefail

ENV_FILE=".env"
APP_NAME="ai-job-searcher-cron"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found (run from repo root)" >&2
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
JARED_USER=$(extract_env "JARED_GMAIL_USER")
JARED_APP_PASS=$(extract_env "JARED_GMAIL_APP_PASSWORD")

echo "Setting 3 Jared secrets on $APP_NAME..."

fly secrets set \
  JARED_NOTION_TOKEN="$JARED_NOTION" \
  JARED_GMAIL_USER="$JARED_USER" \
  JARED_GMAIL_APP_PASSWORD="$JARED_APP_PASS" \
  --app "$APP_NAME"

echo "✓ done"
