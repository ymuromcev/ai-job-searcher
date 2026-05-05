# Architecture overview (L3)

> **Status**: stub (RFC 018 phase 1). Drafted in phase 2.

This will be the deep-dive companion to the L1+L2 view in [/ARCHITECTURE.md](../../ARCHITECTURE.md). Source material:

- Existing `docs/SPEC.md` (architectural sections — to be extracted)
- Existing `docs/ai-assistant-notes.md` (mental model, directory tour — to be merged here)
- RFCs 001 (multi-profile), 012 (relational data model), 016 (unified JD cache)

Sections planned:

1. Mental model (profile = data, engine = service)
2. Directory tour (`engine/`, `profiles/`, `data/`, `scripts/`, `rfc/`, `docs/`)
3. Discovery layer (adapter contract, auto-registry, scan orchestrator)
4. Core layer (filter, dedup, validator, JD cache, Notion sync, fit prompt)
5. Generators (resume, cover letter)
6. Tracking (Gmail two-phase MCP flow + cron variant)
7. Notion as UI (Jobs DB, Companies DB, hub)
