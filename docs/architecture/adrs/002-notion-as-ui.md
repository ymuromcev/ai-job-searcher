# ADR 002 — Notion as the operator UI, TSV as the engine store

- Status: accepted
- Decided: 2026-04-22
- Crystallizes: [RFC 008](../../../rfc/008-companies-as-notion-source-of-truth.md), supersedes earlier RFC 006/007 paths

## Context

The pipeline produces a steady stream of jobs that the maintainer has to triage, prepare, send, and follow up on. Two operator UX models were tried before this decision was crystallized:

1. **TSV-only with CLI prompts.** Fast for the engine, terrible for humans. Scanning, filtering, and grouping a thousand-row TSV from the terminal is friction-heavy; the operator stopped looking at the pipeline daily, which defeated the point.
2. **Notion-only.** Pleasant to use but lossy for the engine. Notion has rate limits, inconsistent property semantics across SDK versions, and no good way to keep an audit trail of automated edits. Dedup logic against Notion alone was slow and fragile.

What worked in practice was a hybrid: TSV for the engine, Notion for the operator. By Stage 13 the schemas had drifted enough that a Companies database was needed alongside the Jobs database, and by Stage 16 the workspace had grown to a hub with auxiliary databases (Application Q&A, Job Platforms) and a templated subpage layout. The hybrid had to be made explicit before more layers were added.

## Decision

Notion is the source-of-truth UI for the operator; the TSV is the engine's canonical data store. Sync is bidirectional with a clear conflict policy:

- **Engine-owned fields** — status transitions, salary numbers, fit scores, generated artifact paths, follow-up dates — are written by the engine to TSV, then pushed to Notion. On conflict, TSV wins.
- **Operator-owned fields** — notes, custom tags, hand-edited company metadata, free-text comments — are edited in Notion by the maintainer. On conflict, Notion wins. The engine reads these on the next pass and surfaces them where useful.
- **Companies database is authoritative for company metadata.** Tier, industry, careers URL, remote policy, "why interesting" all live there once. The Jobs database carries a relation, not duplicated company fields.
- **Push gating via manifest.** Migration-style pushes (e.g., the Stage 16 backfill of 240 historical jobs) are gated by an explicit `push_manifest.json` so partial reruns are safe.

## Consequences

Positive:

- Daily operator UX is fast: filter by tier, group by status, kanban view of the pipeline. The maintainer actually opens Notion now.
- Engine has a stable on-disk format. Tests run against TSV fixtures without needing a Notion mock for every assertion.
- Companies metadata is normalized — adding a new attribute (e.g., "specialty" for healthcare clinics) is one Notion column plus a backfill script, not a per-job rewrite.

Negative:

- Two stores means schema drift is possible. We pay for this with migration scripts (`scripts/stage16/*`) and a small incident log when the SDK changes shape (e.g., Notion SDK v5 silently dropping `properties` from `databases.create`).
- Notion API rate limits show up under bulk push. Mitigated with batching and exponential backoff in `engine/core/notion_sync.js`.
- The conflict policy is convention, not enforced by code on every field. A field that is mistakenly written by both sides will silently flip-flop until someone notices. Documented in `docs/reference/notion-schema.md` and audited per release.

## References

- [RFC 008](../../../rfc/008-companies-as-notion-source-of-truth.md) — Companies-as-truth, the load-bearing piece of this decision
- [RFC 006](../../../rfc/006-email-check-per-profile-companies.md) — superseded by RFC 008
- [RFC 007](../../../rfc/007-industries-as-relations.md) — superseded by RFC 008
- [RFC 014](../../../rfc/014-status-split-new-vs-toapply.md) — recent example of the engine-owns-status rule in action
- [ADR 001](001-multi-profile.md) — per-profile isolation also applies to Notion workspaces
