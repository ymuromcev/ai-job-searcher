# Multi-profile isolation model

> **Status**: stub (RFC 018 phase 1). Drafted in phase 2 (source: [RFC 001](../../rfc/001-multi-profile-architecture.md)).

This document will explain:

- The "profile = data, engine = service" rule
- Per-profile directory layout (`profiles/<id>/`)
- Per-profile secret namespacing in root `.env` (`{PROFILE_ID_UPPERCASE}_NOTION_TOKEN` etc.)
- Shared master pool (`data/`) — gitignored, dedup-only, no PII
- Notion isolation: each profile gets its own Jobs DB + Companies DB + workspace page
- How the engine picks profile-specific behavior (CLI `--profile <id>`, `profile_loader`)

See also: [overview.md](overview.md), [adrs/](adrs/) (when ADR-001 is published).
