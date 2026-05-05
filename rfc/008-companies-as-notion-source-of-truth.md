---
id: RFC-008
title: Companies as Notion source of truth + per-profile check
status: implemented
tier: L
created: 2026-04-30
decided: 2026-04-30
supersedes: RFC-006
tags: [notion, companies, schema]
---

# RFC 008 — Companies as Notion source of truth + per-profile check

**Status**: Draft 2026-04-30 (требует approve пользователя)
**Tier**: L (миграция данных, новая фаза sync, рефактор check, тесты на 2 профиля)
**Author**: Claude + Jared
**Поглощает**: [RFC 006](./006-email-check-per-profile-companies.md), [RFC 007](./007-industries-as-relations.md)
**Зависит от**: [RFC 002 — check command](./002-check-command.md)

## Проблема

Три связанные проблемы:

1. **Email check пропускает компании**: текущий `check --prepare` строит watchlist только из ~88 active заявок (`status ∈ {To Apply, Applied, Interview, Offer}` + `notion_page_id`). Все остальные компании — невидимы. Сегодня обнаружены пропуски: Robinhood, Hippo Insurance, Marqeta, Deel, TabaPay.

2. **Нет физической связки company → profile**: в `data/companies.tsv` (250 fintech компаний) колонки `profile` нет. Привязка держится на удаче — таблица случайно не пересекается с Лилиными healthcare компаниями. Любое добавление "не моих" компаний ломает изоляцию.

3. **Не масштабируется**: Лилины 75 healthcare компаний живут в `profile.json.discovery.companies_whitelist` (это конфиг, а не БД). Добавление 3-го профиля требует либо раздувания whitelist, либо ветвлений в коде.

При этом **в Notion уже всё правильно**:
- 2 per-profile Companies БД: `Jared — Companies` (DB `7aac7a15-...`), `Lilia — Companies` (DB `39e5a762-...`).
- Schema идентична: `Name | Industry (multi_select) | Tier | Company Size | Remote Policy | Website | Careers URL | Notes`.
- Industry в Jared'е сконфигурирован 18 опциями (FinTech, BNPL, Payments, Lending, Crypto, Banking, Insurance, HealthTech, Marketplace, SaaS, Martech, AI/ML, HR Tech, Real Estate, Healthcare, Transportation, Retail, Construction).
- У Лили в Notion 77 компаний с проставленными индустриями (но options в схеме пока пустые — нужно скопировать из Jared'а или допустить freeform).

Engine сейчас этим не пользуется. `data/companies.tsv` и Notion живут параллельно.

## Зафиксированные решения

| # | Решение |
|---|---------|
| 1 | Notion Companies БД (per-profile) = **single source of truth** для метаданных компаний. |
| 2 | **Industries обязательны** для каждой компании. Это правило. Validate упадёт если нарушено. |
| 3 | Расширить `engine/commands/sync.js` новой фазой: **Companies (Notion → `data/companies.tsv`)**. One-way (Notion → local). |
| 4 | Колонка **`profile`** в `data/companies.tsv` (значение = `jared` / `lilia`). Привязка автоматическая через факт принадлежности к Notion DB профиля. |
| 5 | Helper `companiesForProfile(profileId, allCompanies)` в `engine/core/companies.js`. Используется всеми командами. |
| 6 | Engine применяет Notion напрямую через `NOTION_TOKEN` (готовность к standalone cron). |
| 7 | Default-профиль = `jared`. Для других — явная команда (`--profile lilia`). |

## Архитектура

### Расширенный `data/companies.tsv`

```
name | profile | industries | tier | company_size | remote_policy | website | careers_url | ats_source | ats_slug | notion_page_id | extra_json
Affirm | jared | FinTech,Lending,BNPL | S | Scaleup | Remote-first | https://affirm.com | https://www.affirm.com/careers | greenhouse | affirm | <notion-uuid> |
Kaiser Permanente | lilia | Healthcare,Hospitals | A | Enterprise | Hybrid | https://kp.org | ... | indeed | kaiser-sac | <notion-uuid> |
```

`industries` — comma-separated, потому что multi_select. `notion_page_id` — для обратного maintenance.

### Новая фаза в `engine/commands/sync.js`

```
node engine/cli.js sync --profile jared --apply
  Phase 1 (existing): pipeline (Notion) ↔ applications.tsv
  Phase 2 (new):     companies (Notion) → data/companies.tsv (только jared-rows, full overwrite)
```

Sync для Лили — то же самое, но обновляет только lilia-rows.

```
node engine/cli.js sync-companies --all --apply
  Альтернативный вариант: один проход по обоим профилям, полный overwrite TSV.
```

Реализация — extend существующего sync.js, добавить флаг `--companies-only` если нужен только этот шаг.

### Validation rule (industries обязательны)

Sync валит, если какая-то компания в Notion не имеет industries:

```
ERROR: "Cameron Park Dental Office" (lilia) has no Industry set in Notion.
       Industries are mandatory. Fix in Notion: <page-url>
       Or pass --skip-empty-industries to ignore (not recommended).
```

`engine/commands/validate.js` тоже добавляет проверку этого правила.

### Helper `companiesForProfile`

```js
// engine/core/companies.js
function companiesForProfile(profileId, allCompanies) {
  return allCompanies.filter(c => c.profile === profileId);
}

function companiesForProfileByIndustry(profileId, allCompanies, industries) {
  // For future industry-based filtering. Profile-scoped.
  const set = new Set(industries.map(i => i.toLowerCase()));
  return companiesForProfile(profileId, allCompanies)
    .filter(c => (c.industries || []).some(i => set.has(i.toLowerCase())));
}
```

### Фикс check (`engine/commands/check.js`)

#### `--prepare`

```js
// Было:
const companies = Object.keys(activeJobsMap);  // ~88

// Станет:
const allCompanies = loadCompanies('data/companies.tsv');
const profileCompanies = companiesForProfile(profile.id, allCompanies);
const fromApps = unique(apps.map(a => a.companyName).filter(Boolean));
const watchlist = uniqueCaseInsensitive([
  ...profileCompanies.map(c => c.name),
  ...fromApps  // safety net на случай если sync отстал
]);
```

`activeJobsMap` (для Notion-write path) **не меняется** — только active заявки могут получить status update.

#### Новый ATS-fallback batch в `buildBatches`

```js
const ATS_DOMAINS = [
  'greenhouse.io', 'myworkday.com', 'ashbyhq.com', 'lever.co',
  'icims.com', 'smartrecruiters.com', 'workable.com', 'rippling.com', 'eightfold.ai'
];
batches.push(`from:(${ATS_DOMAINS.map(d => `@${d}`).join(' OR ')}) ${searchWindow} -from:me`);
```

#### 2-уровневый matcher в `processPipeline`

```js
match = findCompany(email, activeJobsMap)
if (match) { /* normal flow: status + comment */ }
else {
  const inactiveMatch = findCompanyInList(email, watchlist)
  if (inactiveMatch) {
    row.action = "matched: inactive company, no Notion update"
    row.company = inactiveMatch
  }
}
```

#### context.json новые поля

```diff
+ "watchlistCount": 257,
+ "watchlist": ["Affirm", "Robinhood", "Stripe", ...],
  "activeCompanyCount": 88,
  "activeJobsMap": {...},
```

### Изменения в Notion (pre-work, не код)

1. **Лилины Industry options** — скопировать из Jared'овой схемы (через MCP `notion-update-data-source`) и добавить healthcare-специфичные: Healthcare, Dental, Vision, Hospitals, Hospice, Physical Therapy, Skin/Aesthetics, Hearing, Eye Care, Mental Health.

2. **Заполнить industries у всех Лилиных 77 компаний** — там где пусто. По её whitelist'у видно что 99% — это Dental/Vision/Healthcare/Hospitals.

3. **Заполнить industries у Jared'овых компаний в Notion** где пусто (если такие есть).

4. **Backfill в Notion**: проверить что все 250 компаний из текущего `data/companies.tsv` есть в Jared'овой Notion DB. Если каких-то нет — создать через MCP `notion-create-pages`.

### Migration plan (по шагам)

| Step | Что | Вход | Выход |
|---|---|---|---|
| 1 | **Audit Notion** | Jared/Lily Companies DBs | Отчёт: сколько компаний, у скольких пустые industries, diff с `data/companies.tsv` |
| 2 | **Заполнить Лилины Industry options** | List опций (см. выше) | Лилина DB с options |
| 3 | **Заполнить industries у всех компаний** в обеих Notion DB (юзер делает или Claude через MCP с approve) | Audit-отчёт | Все компании в Notion имеют ≥1 industry |
| 4 | **Backfill в Notion** недостающих компаний из `data/companies.tsv` | Diff из шага 1 | Notion DB полная |
| 5 | **Имплементить sync companies-фазу** + validation | RFC | Код + тесты |
| 6 | **Прогнать sync** для обоих профилей | Notion data | Новый `data/companies.tsv` со всеми колонками |
| 7 | **Имплементить `companiesForProfile`** + use в check | Synced TSV | Код + тесты |
| 8 | **Имплементить ATS-fallback + 2-уровневый matcher** | RFC | Код + тесты |
| 9 | **Скопировать processed_messages Jared** из легаси | `Job Search/processed_email_ids.json` | `profiles/jared/.gmail-state/processed_messages.json` |
| 10 | **Прогнать check** для Jared (`--prepare → MCP → --apply`) | Watchlist | Отчёт: matched, actions, errors |
| 11 | **Backfill Jared** одноразовым скриптом для missed companies (30d window) | Diff old vs new watchlist | Отчёт + Notion updates |
| 12 | **Прогнать check** для Lily (первый раз = автобэкфилл 30d) | — | Отчёт |
| 13 | **Обновить `SKILL_check.md`** | — | Skill ходит в новый CLI |
| 14 | **Renaming legacy** `Job Search/check_emails.js` → `*.deprecated-2026-04-30` | — | Один путь для check |

### Production readiness (для cron deploy в другой сессии)

Engine спроектирован так, чтобы **не зависеть от Claude MCP** в `--apply`:
- Notion: через `NOTION_TOKEN` в `.env`.
- Gmail: пока MCP-driven (фаза `--prepare` печатает batches, фаза `--apply` ест raw_emails.json). Для cron — нужна обвязка через `googleapis` SDK (это **другая сессия пользователя**, не часть этого RFC).
- TSV: локальный read/write.

Что я обеспечиваю в этом RFC: **все инвазивные мутации Notion и TSV происходят через explicit flags (`--apply`)**, без неявных Claude-сессионных вещей.

## Тесты

- **`engine/core/companies.js`**: load с новой схемой, `companiesForProfile` filter.
- **`engine/commands/sync.js`**: companies-phase с моками Notion (Jared + Lily fixture); validation падает на пустых industries.
- **`engine/commands/check.js`**: 
  - buildBatches → ATS-fallback batch на месте.
  - processPipeline → 2-уровневый match (active → action; inactive → log).
- **`engine/commands/validate.js`**: правило про industries.
- **Integration smoke**: end-to-end на 2 фейковых профилях, gmail mock возвращает рандомный mix писем.

## DOD

- [ ] Notion audit отчёт сделан и показан юзеру.
- [ ] Лилины Industry options заведены (≥10 опций).
- [ ] Industries у всех компаний в обеих Notion DB заполнены (юзер approve каждый bulk-update).
- [ ] `data/companies.tsv` обновлена с полной схемой через sync.
- [ ] `companiesForProfile` написан + покрыт юнит-тестами (3 кейса).
- [ ] sync companies-фаза + тесты.
- [ ] validate правило + тест.
- [ ] check.buildBatches с ATS-fallback + тест.
- [ ] check.processPipeline 2-уровневый matcher + тесты.
- [ ] Все тесты engine зелёные.
- [ ] processed_messages Jared скопирован.
- [ ] check прогнан для Jared, отчёт показан.
- [ ] Backfill Jared прогнан, отчёт показан.
- [ ] check прогнан для Lily, отчёт показан.
- [ ] `SKILL_check.md` обновлён.
- [ ] Старый `Job Search/check_emails.js` deprecated.
- [ ] Code-reviewer subagent прошёл по диффу.
- [ ] RFC 006 и 007 помечены superseded.

## Риски

| Риск | Митигация |
|---|---|
| Лилины Industry options пустые → sync валит | Step 2 в migration plan: завести options до прогона sync. |
| 250 fintech в `data/companies.tsv` не все есть в Jared Notion DB | Step 4: audit + backfill в Notion. Если юзер не хочет — оставить как warning в синке. |
| Bulk заполнение industries в Notion (Лилины 77 компаний без industries) — много операций | Сначала auto-классификация по name (Dental Office → Dental, и т.д.), затем юзер ревьюит, потом MCP applies. |
| Sync делает full overwrite TSV → потеря данных, которых нет в Notion | Backup перед каждым sync (`.tsv.bak-YYYY-MM-DD`). Diff в логе. |
| Gmail rate limits при ~250+ компаниях для Jared (≈25 batches) | BATCH_SIZE можно поднять с 10 до 15 если упрёмся. Сейчас тестировали 11 без проблем. |
| Backfill Jared даёт false positives | Classifier дропает OTHER → нет действия. Manual review summary перед apply. |

## Что **не** в этом RFC (отдельные задачи)

- Cron deploy на сервер (другая сессия юзера).
- Gmail OAuth integration через googleapis SDK (другая сессия).
- Industry-based filtering для scan (`profile.target_industries` ∩ `companies.industries`) — следующая итерация после стабильного 008.
- Two-way sync `companies.tsv` ↔ Notion (сейчас one-way Notion → TSV).

---

**Approve required before implementation.**
