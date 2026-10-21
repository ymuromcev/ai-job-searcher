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
# Optional (RFC 068 — apply mailbox): JARED_APPLY_GMAIL_USER +
#   JARED_APPLY_GMAIL_APP_PASSWORD. Sent only when BOTH are present in .env;
#   `check --auto` then reads that mailbox too.
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

read_env() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2- || true
}

extract_env() {
  local key="$1"
  local val
  val=$(read_env "$key")
  if [[ -z "$val" ]]; then
    echo "error: ${key} not found in $ENV_FILE" >&2
    exit 1
  fi
  printf "%s" "$val"
}

JARED_NOTION=$(extract_env "JARED_NOTION_TOKEN")
JARED_USER=$(extract_env "JARED_GMAIL_USER")
JARED_APP_PASS=$(extract_env "JARED_GMAIL_APP_PASSWORD")

SECRETS=(
  JARED_NOTION_TOKEN="$JARED_NOTION"
  JARED_GMAIL_USER="$JARED_USER"
  JARED_GMAIL_APP_PASSWORD="$JARED_APP_PASS"
)

APPLY_USER=$(read_env "JARED_APPLY_GMAIL_USER")
APPLY_PASS=$(read_env "JARED_APPLY_GMAIL_APP_PASSWORD")
if [[ -n "$APPLY_USER" && -n "$APPLY_PASS" ]]; then
  SECRETS+=(
    JARED_APPLY_GMAIL_USER="$APPLY_USER"
    JARED_APPLY_GMAIL_APP_PASSWORD="$APPLY_PASS"
  )
elif [[ -n "$APPLY_USER" || -n "$APPLY_PASS" ]]; then
  echo "warn: only one of JARED_APPLY_GMAIL_USER / JARED_APPLY_GMAIL_APP_PASSWORD is set — apply mailbox skipped" >&2
fi

echo "Setting ${#SECRETS[@]} Jared secrets on $APP_NAME..."

fly secrets set "${SECRETS[@]}" --app "$APP_NAME"

echo "✓ done"
