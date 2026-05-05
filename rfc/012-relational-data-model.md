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
**Blocks**: RFC 013 (profile-level geo enforcement) — нужна нормализованная модель чтобы единообразно прокидывать `profile.geo` во все adapters.

## Проблема

Текущая модель денормализована и каждый incremental change добавляет tech debt:

- `data/companies.tsv` имеет колонку `profile` (added in RFC 010 part B). Это полу-join: чтобы Sutter Health был у Лили — отдельная строка с `profile=lilia`. Если Jared тоже захочет Sutter — добавляем вторую строку. Если оба — `profile="jared,lilia"` (comma-list parser hack).
- `data/jobs.tsv` — shared pool, no profile awareness. OK для discovery, но reconcile сложнее.
- `profiles/<id>/applications.tsv` — денормализован: каждая строка дублирует поля job (title, url, companyName) которые уже в jobs.tsv.

User's точка: **"все списки должны быть по одному файлу. А профили мы к ним джойним."** — что есть нормальная реляционная модель.

## Целевая модель

```
data/companies.tsv         — pure list (id, name, website?, industry?)
data/ats_targets.tsv       — pure list (id, company_id, source, slug, extras_json)
data/jobs.tsv              — pure pool (id, ats_target_id, title, url, locations, postedAt, ...)
data/profile_companies.tsv — JOIN N:M (profile_id, company_id, why?, geo_overrides?)
profiles/<id>/applications.tsv — JOIN с per-profile state (profile_id, job_id, status, notion_page_id, cl_path, salary_min, salary_max, ...)
```

Альтернатива: одна SQLite база `data/db.sqlite` с теми же таблицами + индексы. Подумать на стадии RFC.

## Что меняется

- **schema files**: 5 новых (см. выше) с миграцией существующих 3 (companies.tsv, jobs.tsv, applications.tsv).
- **`engine/core/companies.js`** разбивается на companies + ats_targets + profile_companies loaders.
- **`engine/core/applications_tsv.js`** теряет дубликаты полей (companyName, title — приходят join'ом).
- **`engine/commands/*`** — каждая команда (scan/prepare/sync/check/validate) переписывается под join-модель.
- **Notion sync** — relation Company уже есть; добавится подгрузка company-name из master DB вместо TSV-строки.
- **Migration scripts** — конвертация existing данных Jared (252 companies + ~1500 applications) и Lilia (4 companies + ~600 applications) в новую модель + backups + rollback.

## Plan / open questions

To-do — подробный план в новой сессии. Ключевые вопросы:

1. TSV vs SQLite? TSV — git-friendly, simple. SQLite — настоящие constraints, индексы, транзакции.
2. ID schema: натуральные ключи (`source:slug` для ats_targets) или UUID? Натуральные читабельнее в diff'ах.
3. Migration в один шаг или dual-write transition period?
4. Notion как источник истины для `companies` (RFC 008 thread) — поглощается этим RFC или остаётся отдельным?

## Out of scope

- Изменение Notion DB schema (отдельный RFC если понадобится).
- Per-profile filter_rules.json — остаётся per-profile (не master DB sущность).

## Ссылки

- [RFC 008 — Companies as Notion source of truth](./008-companies-as-notion-source-of-truth.md) — родственная тема, может слиться.
- [RFC 010 — Workday tenants для Лилии](./010-lilia-workday-activation.md) part B — добавил `profile` column (та denormalization, которую этот RFC чинит).
- [RFC 013 — Profile-level geo enforcement](./013-profile-geo-enforcement.md) — построится на 012.
