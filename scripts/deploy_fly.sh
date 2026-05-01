#!/usr/bin/env bash
# Deploy ai-job-searcher-cron to fly.io.
#
# Idempotent: re-running just rolls a new image. The one-time setup steps
# (app creation, volume creation, secrets) are gated on existence checks.
#
# Usage:
#   ./scripts/deploy_fly.sh                 # deploy current code
#   ./scripts/deploy_fly.sh --bootstrap     # also create app + volume
#   ./scripts/deploy_fly.sh --check         # dry-run: only run pre-flight
#
# Requires `flyctl` installed and authenticated (`fly auth login`).
# See docs/gmail_cron.md §2 for the full Phase 2 runbook.

set -euo pipefail

APP_NAME="ai-job-searcher-cron"
REGION="sjc"
VOLUME_NAME="ai_job_searcher_data"
VOLUME_SIZE_GB="1"

# Secrets that MUST be set on fly before the cron can run. We DO NOT read
# their values — only verify each name appears in `fly secrets list`. The
# user sets them via `fly secrets set <NAME>=...` themselves (the deploy
# script never sees the value).
REQUIRED_SECRETS=(
  JARED_NOTION_TOKEN
  JARED_GMAIL_CLIENT_ID
  JARED_GMAIL_CLIENT_SECRET
  JARED_GMAIL_REFRESH_TOKEN
)
# Optional secrets — checked but not required. Add the corresponding cron
# line in cron/check.cron once they're set.
OPTIONAL_SECRETS=(
  LILIA_NOTION_TOKEN
  LILIA_GMAIL_CLIENT_ID
  LILIA_GMAIL_CLIENT_SECRET
  LILIA_GMAIL_REFRESH_TOKEN
)

BOOTSTRAP=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --bootstrap) BOOTSTRAP=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

log() { printf "  %s\n" "$*"; }
ok()  { printf "  ✓ %s\n" "$*"; }
warn(){ printf "  ⚠ %s\n" "$*"; }
err() { printf "  ✗ %s\n" "$*" >&2; }

# 0. flyctl present?
if ! command -v fly >/dev/null 2>&1; then
  err "flyctl not installed. See https://fly.io/docs/hands-on/install-flyctl/"
  exit 1
fi
ok "flyctl found"

# 1. Authenticated?
if ! fly auth whoami >/dev/null 2>&1; then
  err "not logged in. Run: fly auth login"
  exit 1
fi
ok "fly auth ok ($(fly auth whoami 2>/dev/null))"

# 2. App exists? Use `fly status -a` directly — exits 0 iff app exists for
# the current user. (`fly apps list | grep` is fragile across versions.)
APP_EXISTS=0
if fly status -a "$APP_NAME" >/dev/null 2>&1; then
  APP_EXISTS=1
  ok "app '${APP_NAME}' exists"
else
  warn "app '${APP_NAME}' does not exist yet"
  if [[ "$BOOTSTRAP" -eq 1 ]]; then
    log "creating app..."
    fly apps create "$APP_NAME" -o personal --machines || true
    ok "app created"
    APP_EXISTS=1
  else
    err "rerun with --bootstrap to create the app, or 'fly apps create ${APP_NAME}' manually"
    exit 1
  fi
fi

# 3. Volume exists? `fly volumes list` is grepped — name appears as a column.
VOLUME_EXISTS=0
if fly volumes list -a "$APP_NAME" 2>/dev/null | grep -qw "$VOLUME_NAME"; then
  VOLUME_EXISTS=1
  ok "volume '${VOLUME_NAME}' exists"
else
  warn "volume '${VOLUME_NAME}' does not exist"
  if [[ "$BOOTSTRAP" -eq 1 ]]; then
    log "creating ${VOLUME_SIZE_GB}GB volume in ${REGION}..."
    fly volumes create "$VOLUME_NAME" -a "$APP_NAME" --region "$REGION" --size "$VOLUME_SIZE_GB" --yes
    ok "volume created"
    VOLUME_EXISTS=1
  else
    err "rerun with --bootstrap to create the volume"
    exit 1
  fi
fi

# 4. Required secrets all set?
log "checking required secrets (${#REQUIRED_SECRETS[@]} total)..."
SECRETS_LIST=$(fly secrets list -a "$APP_NAME" 2>/dev/null || true)
MISSING=()
for s in "${REQUIRED_SECRETS[@]}"; do
  # `fly secrets list` formats names with leading "* " and table padding,
  # e.g. " * JARED_NOTION_TOKEN     │ ...". Use word-boundary grep so any
  # row containing the exact name as a token matches.
  if ! grep -qw "$s" <<<"$SECRETS_LIST"; then
    MISSING+=("$s")
  fi
done
if [[ "${#MISSING[@]}" -gt 0 ]]; then
  err "missing secrets:"
  for m in "${MISSING[@]}"; do
    err "  - $m"
  done
  err ""
  err "Set them with:"
  err "  fly secrets set NAME=value -a ${APP_NAME}"
  err ""
  err "For GMAIL_REFRESH_TOKEN, use the file written by scripts/gmail_auth.js:"
  err "  source profiles/<id>/.gmail-tokens/fly-secret-command.sh"
  exit 1
fi
ok "all required secrets set"

# 4b. Optional — warn but don't fail.
if [[ "${#OPTIONAL_SECRETS[@]}" -gt 0 ]]; then
  for s in "${OPTIONAL_SECRETS[@]}"; do
    if ! grep -qw "$s" <<<"$SECRETS_LIST"; then
      warn "optional secret unset: ${s} (related profile cron line should be commented out)"
    fi
  done
fi

# 5. Profile dirs ready on volume? (best-effort warn — we can't inspect the
#    volume from outside, but we can remind.)
warn "remember: profiles/<id>/.gmail-tokens/credentials.json is NOT shipped"
warn "          in the image (.dockerignore'd). For fly cron, the engine reads"
warn "          the refresh-token from the *_GMAIL_REFRESH_TOKEN secret instead."

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  ok "pre-flight passed (--check, no deploy)"
  exit 0
fi

# 6. Deploy.
log "deploying..."
fly deploy -a "$APP_NAME"
ok "deploy complete"

log ""
log "Smoke test (manual one-shot inside the container):"
log "  fly ssh console -a ${APP_NAME} --command 'node /app/engine/cli.js check --profile jared --auto'"
log ""
log "Tail logs:"
log "  fly logs -a ${APP_NAME}"
