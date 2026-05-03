#!/bin/sh
# Cron container entrypoint.
#
# Runs as root for the chown step (fly-volume contents are persistent and
# may have been written previously by a different uid — Dockerfile-time
# `chown -R app:app /data` doesn't apply at mount time). Then drops to
# the unprivileged `app` user via su-exec to run supercronic.
#
# Without this, --auto --apply mutates Notion successfully but fails on
# the subsequent TSV save with EACCES, leaving processed_messages.json
# stale → next tick re-processes the same emails → duplicate Notion
# comments. See incidents.md (2026-05-02 entry).

set -e

# Ensure /data and everything inside is writable by the app user.
# -R is intentional: any prior state (whether from a fresh fly volume,
# an upgrade from an older image, or a manual ssh session as root) is
# normalized here. Fast even with thousands of files.
chown -R app:app /data

# Drop to app user and exec supercronic. exec replaces this shell so
# signals (SIGTERM from fly's machine restart) propagate to supercronic
# directly.
exec su-exec app:app "$@"
