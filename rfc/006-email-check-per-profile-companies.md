# RFC 006 — `check` company set: per-profile coverage + ATS fallback + backfill

**Status**: Superseded by [RFC 008](./008-companies-as-notion-source-of-truth.md) on 2026-04-30
**Tier**: M (изменения в `engine/commands/check.js` + миграция `Job Search/SKILL_check.md` + одноразовый backfill)
**Author**: Claude + Jared Moore
**Дополняет**: [RFC 002 — check command](./002-check-command.md)
**Связан с**: [RFC 007 — industries-as-relations (planned)](./007-industries-as-relations.md) — следующая итерация архитектуры

## Проблема

Текущая реализация `check --prepare` ([engine/commands/check.js:107-127](../engine/commands/check.js)) строит `activeJobsMap` только из строк, у которых одновременно:
- `status ∈ {To Apply, Applied, Interview, Offer}`
- `notion_page_id` set

Это даёт ~88 компаний для Jared (из ~250+ tracked). Все остальные компании — невидимы. Конкретные пропуски за сегодня: Robinhood, Hippo Insurance, Marqeta, Deel, TabaPay.

Параллельные проблемы:
- Письма от ATS-доменов (greenhouse/lever/ashby/workday), где имя компании только в body — частично теряются.
- Легаси-прототип `Job Search/check_emails.js` всё ещё гоняется через `Job Search/skills/job-pipeline/SKILL_check.md` и держит ту же ошибку.
- Lily вообще ни разу не запускала check через engine (нет `profiles/lilia/.gmail-state/`) → её ответы (включая dental-приглашения) обрабатываются вручную.

## Зафиксированный дизайн

### Источник company set (general-purpose, оба профиля)

```js
function buildCompanySet(profile, apps, globalCompaniesTsv) {
  // 1. Если whitelist непустой — это source of truth для профиля
  const wl = profile.discovery?.companies_whitelist;
  if (wl && wl.length > 0) {
    return uniqueCaseInsensitive([...wl, ...apps.map(a => a.companyName).filter(Boolean)]);
  }
  // 2. Иначе — глобальный пул минус blacklist + applications
  const bl = new Set((profile.discovery?.companies_blacklist || []).map(s => s.toLowerCase()));
  const fromGlobal = globalCompaniesTsv.map(c => c.name).filter(n => !bl.has(n.toLowerCase()));
  return uniqueCaseInsensitive([...fromGlobal, ...apps.map(a => a.companyName).filter(Boolean)]);
}
```

**Эффект для текущих профилей:**
- Jared (`whitelist: null`) → 250 fintech из `data/companies.tsv` + ~250 уникальных из его applications.tsv (с дедупом ~300 штук всего).
- Lily (`whitelist: [75 healthcare]`) → 75 whitelist + ~75 уникальных из applications.tsv (с дедупом ~80-100 штук).

**Изоляция автоматическая** (никаких per-profile веток в коде):
- Разные Gmail-инбоксы (`ymuromcev@gmail.com` vs `liliachirova@gmail.com`).
- Разные `applications.tsv`.
- Разные whitelist'ы.

**Это временное решение**. Правильная архитектура — единый company catalog с industry-relations к профилям — описана в RFC 007.

### Изменения в `engine/commands/check.js`

#### 1. Новая функция `buildCompanySet` (см. выше)

Экспортируется отдельно для тестируемости.

#### 2. `buildActiveJobsMap` — без изменений

Эта функция нужна для **матчинга** письма к конкретной активной заявке (Notion page id). Расширять не надо — Notion-update делается только для активных заявок.

#### 3. Новый ATS-fallback batch в `buildBatches`

После company-batches и LinkedIn/recruiter добавляется:

```js
const ATS_DOMAINS = [
  'greenhouse.io', 'myworkday.com', 'ashbyhq.com',
  'lever.co', 'icims.com', 'smartrecruiters.com',
  'workable.com', 'rippling.com', 'eightfold.ai'
];
batches.push(
  `from:(${ATS_DOMAINS.map(d => `@${d}`).join(' OR ')}) ${searchWindow} -from:me`
);
```

Это ловит письма, где company name есть только в теле.

#### 4. 2-уровневый matcher в `processPipeline`

```js
// 1. Active match → Notion update
match = findCompany(email, activeJobsMap)
if (match) { /* нормальный flow с status+comment */ }

// 2. Inactive match → лог "matched but inactive", без Notion-mutation
else {
  const inactiveMatch = findCompanyInSet(email, allCompaniesList)
  if (inactiveMatch) {
    row.action = "matched: inactive company, no Notion update"
    row.company = inactiveMatch
  }
}
```

Даёт телеметрию "видим письмо от X, но он Closed" без шума в Notion.

#### 5. Расширенный `check_context.json`

```diff
{
  "profileId": "...",
  "epoch": ...,
  "batches": [...],
- "companyCount": 88,
+ "activeCompanyCount": 88,
+ "totalCompanyCount": 257,
  "activeJobsMap": {...},
+ "allCompaniesList": ["Affirm", "Robinhood", ...],
  "processedIds": [...]
}
```

### Подготовительные шаги до запуска

1. **Скопировать processed-state Jared** из легаси:
   ```bash
   cp "Job Search/processed_email_ids.json" "ai-job-searcher/profiles/jared/.gmail-state/processed_messages.json"
   ```
   (с конвертацией формата если нужно — проверить схему).

2. **Создать `.gmail-state/` для Lily**:
   ```bash
   mkdir -p "ai-job-searcher/profiles/lilia/.gmail-state"
   ```
   processed_messages.json создастся при первом `--apply`.

3. **MCP-доступ к Лилину Gmail** — проверить через `mcp__06081052-...__list_labels` или подобное, что у Claude есть доступ к `liliachirova@gmail.com`. Если нет — пользователь подключает.

### Изменения в `Job Search/skills/job-pipeline/SKILL_check.md`

```diff
-node check_emails.js --prepare
+node ../ai-job-searcher/engine/cli.js check --profile jared --prepare
```

Step 4 → `... check --profile jared --apply`.

Step 4b (Notion MCP updates) — **удалить**. Новый engine применяет Notion напрямую через `NOTION_TOKEN` из `.env`.

Default-профиль = jared. Для Lily — явная команда `/job-pipeline check lilia` (правило пользователя).

Старый `Job Search/check_emails.js` — переименовать в `check_emails.js.deprecated-2026-04-30` после первого успешного прогона.

### Backfill (одноразовый скрипт для Jared)

`ai-job-searcher/scripts/backfill_missed_companies_jared.js` — одноразовый, после прогона удалится:

1. Загрузить старый `Job Search/email_check_context.json` (88 компаний).
2. Загрузить новый company set через `buildCompanySet(jaredProfile, apps, globalTsv)`.
3. Diff → список missed companies (~170-200).
4. Сгенерировать Gmail-batches `after:30d ago` только для missed.
5. Печатает batches в JSON для Claude → MCP search → `raw_emails_backfill.json`.
6. Process с теми же правилами, что и обычный `--apply`.
7. Отчёт: сколько писем нашлось, сколько rejection/interview/info, сколько Notion updates применено.

**Backfill применяет в Notion** (apply-mode, не dry-run). Принято Jared'ом — если за 30 дней пришёл отказ, который мы пропустили, лучше пометить сейчас, чем продолжать висеть в Applied.

Для Lily — backfill не нужен, её первый запуск автоматически возьмёт окно 30 дней (cursor стартует с now-30d при отсутствии processed_messages.json).

## Тесты

- **`buildCompanySet`** — unit:
  - whitelist непустой → берём whitelist + apps.
  - whitelist пустой/null → globalTsv (минус blacklist) + apps.
  - дедуп case-insensitive.
  - оба источника пустые → пустой Set.
- **`buildBatches`** — обновлённый: проверка что добавлен ATS-fallback батч.
- **`processPipeline`** — обновлённый: inactive-match даёт row.action=`matched: inactive`, не строит action.
- **Integration smoke**: фейковый профиль с whitelist + 3 apps → batches генерируются, mock возвращает 1 письмо от inactive company → row есть, Notion action нет.

## DOD

- [ ] `buildCompanySet` написан + покрыт юнит-тестами (4 кейса).
- [ ] `buildBatches` модифицирована, ATS-fallback батч на месте, тесты обновлены.
- [ ] `processPipeline` 2-уровневый match, тесты обновлены.
- [ ] Все тесты `engine/commands/check.test.js` зелёные.
- [ ] processed_messages Jared скопирован из легаси.
- [ ] `.gmail-state/` создан для Lily.
- [ ] MCP-доступ к Лилину Gmail подтверждён (или подключён пользователем).
- [ ] `SKILL_check.md` обновлён.
- [ ] Прогон 1 цикл `--prepare → MCP search → --apply` для Jared без ошибок.
- [ ] Прогон 1 цикл для Lily без ошибок (это её первый прогон = автоматический backfill 30d).
- [ ] `backfill_missed_companies_jared.js` написан, прогнан, отчёт показан Jared.
- [ ] Старый `Job Search/check_emails.js` помечен deprecated.
- [ ] Code-reviewer subagent прошёл по диффу (обязательно для M).
- [ ] RFC 007 stub создан, в Notion заведена задача на industry-relations refactor.

## Риски

- **Gmail rate limits.** Для Jared 250+ компаний → ~25 batches вместо 11. MCP search_threads на 25 батчей за раз — должно ок (тестировали 11 без проблем). Если упрёмся — повысить `BATCH_SIZE` с 10 до 15.
- **Лилины компании очень короткие** ("CHG Therapies LLC", "Anna G Uppal DDS Corp") → может ловить шум в `subject:(...)`. Митигация: tokenizer уже дропает `LLC/Inc/PC/DDS` — проверить что это работает.
- **MCP-доступ к Лилину Gmail** — если нет, блокатор.
- **Backfill Jared — ложные срабатывания.** Если за 30 дней попадётся newsletter/маркетинг от компании из watchlist → false positive. Митигация: классификатор должен дать OTHER → не действие.

## План реализации (по шагам)

1. Имплементить `buildCompanySet` + 4 unit-теста.
2. Обновить `buildBatches` (+ ATS-fallback) + тест.
3. Обновить `processPipeline` (2-уровневый match) + тесты.
4. `runPrepare`: вызывает `buildCompanySet`, передаёт в `buildBatches`, кладёт `allCompaniesList` в context.
5. `runApply`: использует `context.allCompaniesList` для inactive-match.
6. Запустить `npm test` — всё зелёное.
7. Code-reviewer subagent по диффу.
8. Скопировать processed_messages Jared.
9. Создать .gmail-state Lily.
10. Прогнать `--prepare → MCP → --apply` для Jared dry-run, потом apply.
11. Прогнать для Lily.
12. Обновить `SKILL_check.md`.
13. Написать и прогнать `backfill_missed_companies_jared.js` для Jared.
14. Отчёт пользователю.
15. Renaming старого скрипта.

---

**Approve required before implementation.**
