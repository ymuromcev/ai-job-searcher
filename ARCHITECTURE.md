# Architecture

> **Status**: stub (RFC 018 phase 1). Full content written in phase 2.

## L1 — System context (TBD)

A one-screen description of what the system does and who/what it interacts with (operator, candidate, Notion, Gmail, ATS sites). To be drafted in phase 2 of [RFC 018](rfc/018-documentation-system.md).

## L2 — Containers (TBD)

The major runtime parts: `engine/cli.js`, the discovery module set, generators, Notion sync, Gmail check (MCP-driven), the per-profile data tree. Drafted in phase 2.

## See also

- [docs/architecture/overview.md](docs/architecture/overview.md) — L3 detail (component-level), once phase 2 lands
- [docs/architecture/data-flow.md](docs/architecture/data-flow.md) — TSV ↔ Notion ↔ Gmail flow
- [docs/architecture/multi-profile.md](docs/architecture/multi-profile.md) — isolation model
- [docs/architecture/adrs/](docs/architecture/adrs/) — decision records
- [DEVELOPMENT.md](DEVELOPMENT.md) — dev principles
