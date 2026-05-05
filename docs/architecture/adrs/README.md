# Architecture decision records (ADRs)

Short, frozen records of architectural decisions taken in this codebase. Each ADR follows the Nygard format — three sections (Context / Decision / Consequences) — and is around fifty lines.

## ADR vs RFC

The repository uses two complementary documents:

- **RFC** ([`rfc/`](../../../rfc/)) — forward-looking design proposal that gates a non-trivial change. Written before the code, ~150–300 lines, reviewed and approved by the maintainer before implementation begins.
- **ADR** (this directory) — decision crystallized after implementation. Short (~50 lines), Nygard format, written once the dust has settled so future readers can recover the "why" without rereading the full RFC.

In practice, most accepted RFCs spawn one ADR. Small decisions that did not need a full RFC can skip straight to an ADR. See [RFC 018 §8 rule 5](../../../rfc/018-documentation-system.md) for the canonical distinction.

## Index

| ID | Title | Status | Decided |
|---|---|---|---|
| [001](001-multi-profile.md) | Profile is data, engine is service | accepted | 2026-04-19 |
| [002](002-notion-as-ui.md) | Notion as the operator UI, TSV as the engine store | accepted | 2026-04-22 |
| [003](003-mcp-vs-oauth.md) | Gmail reading via Claude MCP, not stored OAuth | accepted | 2026-04-20 |
| [004](004-fly-vs-launchd.md) | Local-only operation under launchd, no cloud host | rejected (for now) | 2026-05-05 |

## Authoring

New ADRs follow the four files above:

- File name: `NNN-short-slug.md`, sequential numbering.
- Three top-level headings: `Context`, `Decision`, `Consequences`. Optional `References` section at the bottom linking to the RFCs and earlier ADRs the decision builds on.
- Status values: `accepted`, `superseded`, `rejected`.
- When superseded, add a `superseded-by:` line at the top and link forward to the new ADR; do not delete the old one.

The ADR table above is the canonical index — kept in sync manually when a new ADR is written or status changes.
