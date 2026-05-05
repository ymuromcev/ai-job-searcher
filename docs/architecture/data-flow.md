# Data flow

> **Status**: stub (RFC 018 phase 1). Drafted in phase 2.

This document will trace data through the pipeline:

1. **Discovery** — adapters fetch postings → in-memory job records
2. **Filter** — blocklists + geo + role checks → kept records
3. **Dedup** — against `data/jobs.tsv` + per-profile `applications.tsv`
4. **TSV append** — new rows with `status: Inbox`, no Notion page yet
5. **Pre-rank** (RFC 015, planned) — `fit_cached` populated for sorting
6. **Prepare** — operator picks a row, fit + geo + CL + Notion page created → `status: To Apply`
7. **Sync** — TSV ↔ Notion bidirectional reconcile
8. **Check** — Gmail (MCP / cron) reads inbox, classifies, updates Notion + TSV

Diagrams will be ASCII or Mermaid (rendered both in Obsidian and on GitHub).

See also: [overview.md](overview.md), [multi-profile.md](multi-profile.md).
