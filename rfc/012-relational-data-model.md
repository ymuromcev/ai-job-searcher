---
id: RFC-012
title: Relational data model — companies / ATS targets / jobs / profiles
status: draft
tier: L
created: 2026-05-05
tags: [data-model, migration, schema]
---

# RFC 012 — Relational data model: companies / ATS targets / jobs / profiles

**Status**: Draft (stub — to be expanded in fresh session)
**Tier**: L (data model migration touching every command, both profiles, all gitignored data files)
**Author**: Claude + repo owner
**Blocks**: RFC 013 (profile-level geo enforcement) — a normalized model is needed in order to uniformly propagate `profile.geo` into all adapters.

## Problem

The current model is denormalized and every incremental change adds tech debt:

- `data/companies.tsv` has a `profile` column (added in RFC 010 part B). This is a half-join: for Sutter Health to belong to Healthcare-Hannah — a separate row with `profile=lilia`. If PM-Pete also wants Sutter — we add a second row. If both — `profile="jared,lilia"` (comma-list parser hack).
- `data/jobs.tsv` — shared pool, no profile awareness. OK for discovery, but reconcile is harder.
- `profiles/<id>/applications.tsv` — denormalized: every row duplicates job fields (title, url, companyName) that are already in jobs.tsv.

The user's point: **"all lists should be in one file each. And we join profiles to them."** — which is a normal relational model.

## Target model

```
data/companies.tsv         — pure list (id, name, website?, industry?)
data/ats_targets.tsv       — pure list (id, company_id, source, slug, extras_json)
data/jobs.tsv              — pure pool (id, ats_target_id, title, url, locations, postedAt, ...)
data/profile_companies.tsv — JOIN N:M (profile_id, company_id, why?, geo_overrides?)
profiles/<id>/applications.tsv — JOIN with per-profile state (profile_id, job_id, status, notion_page_id, cl_path, salary_min, salary_max, ...)
```

Alternative: a single SQLite database `data/db.sqlite` with the same tables + indexes. To be considered at the RFC stage.

## What changes

- **schema files**: 5 new (see above) with migration of the existing 3 (companies.tsv, jobs.tsv, applications.tsv).
- **`engine/core/companies.js`** is split into companies + ats_targets + profile_companies loaders.
- **`engine/core/applications_tsv.js`** loses duplicate fields (companyName, title — come via join).
- **`engine/commands/*`** — every command (scan/prepare/sync/check/validate) is rewritten for the join model.
- **Notion sync** — Company relation already exists; loading company-name from master DB instead of from a TSV row will be added.
- **Migration scripts** — conversion of existing data for PM-Pete (252 companies + ~1500 applications) and Healthcare-Hannah (4 companies + ~600 applications) to the new model + backups + rollback.

## Plan / open questions

To-do — detailed plan in a new session. Key questions:

1. TSV vs SQLite? TSV — git-friendly, simple. SQLite — real constraints, indexes, transactions.
2. ID schema: natural keys (`source:slug` for ats_targets) or UUID? Natural ones are more readable in diffs.
3. Migration in one step or a dual-write transition period?
4. Notion as source of truth for `companies` (RFC 008 thread) — absorbed by this RFC or kept separate?

## Out of scope

- Changing the Notion DB schema (separate RFC if needed).
- Per-profile filter_rules.json — stays per-profile (not a master DB entity).

## References

- [RFC 008 — Companies as Notion source of truth](./008-companies-as-notion-source-of-truth.md) — related topic, may merge.
- [RFC 010 — Workday tenants for Healthcare-Hannah](./010-lilia-workday-activation.md) part B — added the `profile` column (the denormalization that this RFC fixes).
- [RFC 013 — Profile-level geo enforcement](./013-profile-geo-enforcement.md) — will be built on 012.
