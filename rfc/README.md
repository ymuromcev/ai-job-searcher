# RFCs — design proposals

Design documents that gate non-trivial changes. See [DEVELOPMENT.md](../DEVELOPMENT.md) for when an RFC is required (Tier M/L tasks).

## Lifecycle

| Status | Meaning |
|---|---|
| `draft` | Author working on it; not yet reviewed |
| `accepted` | Reviewed + approved; implementation may begin |
| `implemented` | Code shipped; RFC is reference history |
| `superseded` | Replaced by a newer RFC (see `superseded-by` frontmatter) |
| `rejected` | Reviewed and declined |

Status lives in each RFC's YAML frontmatter (`status: implemented`). The table below is the canonical index — kept in sync manually when status changes.

## Index

| ID | Title | Status | Tier | Decided |
|---|---|---|---|---|
| [001](001-multi-profile-architecture.md) | Multi-profile architecture | implemented | L | 2026-04-19 |
| [002](002-check-command.md) | `check` command (Gmail two-phase MCP flow) | implemented | L | 2026-04-20 |
| [004](004-onboarding-wizard.md) | Onboarding wizard | implemented | L | 2026-04-22 |
| [005](005-gmail-cron-autonomous-check.md) | Autonomous Gmail cron | accepted | L | 2026-04-27 |
| [006](006-email-check-per-profile-companies.md) | Per-profile company filter for `check` | superseded → 008 | M | 2026-04-30 |
| [007](007-industries-as-relations.md) | Industries as Notion relations | superseded → 008 | L | 2026-04-30 |
| [008](008-companies-as-notion-source-of-truth.md) | Companies DB as source of truth | implemented | L | 2026-04-30 |
| [009](009-application-answers-command.md) | `application-answers` command | implemented | L | 2026-04-30 |
| [010](010-lilia-workday-activation.md) | Workday adapter activation for Healthcare-Hannah | implemented | M | 2026-05-02 |
| [011](011-keyword-search-adapter.md) | Keyword search adapter | draft | M | — |
| [012](012-relational-data-model.md) | Relational data model | draft | L | — |
| [013](013-profile-geo-enforcement.md) | Profile geo enforcement | draft | L | — |
| [014](014-status-split-new-vs-toapply.md) | TSV status split: `Inbox` vs `To Apply` | implemented | M | 2026-05-04 |
| [015](015-fit-prerank.md) | Fit pre-rank pipeline step | draft | M | — |
| [016](016-unified-jd-cache.md) | Unified JD cache across adapters | draft | M | — |
| [017](017-deel-adapter.md) | Deel adapter | draft | M | — |
| [018](018-documentation-system.md) | Documentation system overhaul | draft | L | — |

> Index reconciled with frontmatter on 2026-05-05 (RFC 018 phase 1.e back-fill). To update: edit the frontmatter in the RFC file and reflect the change here.

## Numbering

RFCs are numbered sequentially. RFC 003 is intentionally absent (was drafted then folded into the Stage 16 migration scripts before formalization).

## Authoring

New RFCs follow the pattern of recent ones (014, 015, 018):

- Header: title, status, author, tier, what it closes/touches
- Problem / Goals & Non-goals / Proposed solution / Migration / Phasing / Acceptance criteria / Out-of-scope
- Frontmatter mandatory (see [DEVELOPMENT.md](../DEVELOPMENT.md) for schema)

ADRs (architecture decision records) live separately in [`docs/architecture/adrs/`](../docs/architecture/adrs/) and are typically distilled from accepted RFCs after implementation — shorter (~50 lines), Nygard format (Context / Decision / Consequences).
