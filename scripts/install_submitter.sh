#!/usr/bin/env bash
# Install / remove the nightly submitter (RFC 069 §2, BL-225).
#
# A launchd agent runs `node engine/cli.js submit-ready --profile <id>` every
# 15 minutes. The command itself does nothing outside the profile's
# apply_window (default 02:00-11:00), so the agent can stay on all the time;
# launchd runs a missed interval when the Mac wakes up.
#
# Usage:
#   scripts/install_submitter.sh --profile <id>               # install / reinstall
#   scripts/install_submitter.sh --profile <id> --uninstall   # remove
#   scripts/install_submitter.sh --profile <id> --dry-run     # print the plist, change nothing
#
# Writes ~/Library/LaunchAgents/com.<user>.ai-job-searcher.submit-<id>.plist
# and logs to ~/Library/Logs/ai-job-searcher/submit-<id>.log. The repo path
# is where this script lives; node is whatever `command -v node` finds now.

set -euo pipefail

PROFILE=""
MODE="install"
DRY_RUN=0

usage() {
  echo "usage: $0 --profile <id> [--uninstall] [--dry-run]" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      PROFILE="${2:-}"
      shift 2 || { usage; exit 2; }
      ;;
    --uninstall) MODE="uninstall"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$PROFILE" ]; then
  usage
  exit 2
fi
# Same rule as the profile loader: lowercase id, no path tricks.
if ! printf '%s' "$PROFILE" | grep -Eq '^[a-z][a-z0-9_]{1,31}$'; then
  echo "error: invalid profile id \"$PROFILE\"" >&2
  exit 2
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
LABEL="com.$(whoami).ai-job-searcher.submit-${PROFILE}"
AGENTS_DIR="${HOME}/Library/LaunchAgents"
PLIST="${AGENTS_DIR}/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/ai-job-searcher"
LOG="${LOG_DIR}/submit-${PROFILE}.log"
DOMAIN="gui/$(id -u)"

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would run: $*"
  else
    "$@"
  fi
}

if [ "$MODE" = "uninstall" ]; then
  run launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
  run rm -f "$PLIST"
  echo "submitter for ${PROFILE} removed (${LABEL})"
  exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "error: node not found on PATH — install Node 20+ first" >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE")"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE")</string>
    <string>$(xml_escape "$REPO/engine/cli.js")</string>
    <string>submit-ready</string>
    <string>--profile</string>
    <string>$(xml_escape "$PROFILE")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$REPO")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$NODE_DIR"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG")</string>
</dict>
</plist>
EOF
}

if [ "$DRY_RUN" -eq 1 ]; then
  echo "plist: $PLIST"
  plist
  run launchctl bootout "${DOMAIN}/${LABEL}"
  run launchctl bootstrap "$DOMAIN" "$PLIST"
  exit 0
fi

mkdir -p "$AGENTS_DIR" "$LOG_DIR"
plist >"$PLIST"
# Reinstall: drop the old agent first (fails harmlessly when none is loaded).
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "submitter for ${PROFILE} installed: ${LABEL}, every 15 min, log ${LOG}"
