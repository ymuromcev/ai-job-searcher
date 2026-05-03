# RFC 010 — Workday tenants для Лилии (healthcare)

**Status**: Approved 2026-05-02 (юзер подтвердил A-вариант)
**Tier**: M (активация существующего adapter'а + конфиг tenant'ов + тесты)
**Author**: Claude + repo owner (Lilia)
**Зависит от**: [RFC 008 — Companies as Notion source of truth](./008-companies-as-notion-source-of-truth.md) (RFC 008 ввёл per-profile companies — этот RFC использует ту же модель)

## Проблема

Лилин discovery сейчас работает только через Indeed-flow:
- 73 healthcare-компании в `profile.json.discovery.companies_whitelist`.
- Realtime/recurring scan по Greenhouse / Lever / Ashby / SmartRecruiters / Workday активирован в `profile.json.modules`, но **ни одного healthcare-tenant'а нет** в `data/companies.tsv` под `source=workday`. Сейчас там только 3 fintech (PayPal, Capital One, Fidelity), ориентированных на Jared'а.
- Indeed-flow одноразовый: 2026-04-28 загрузили 33 вакансии, всё. Без recurring discovery новые позиции в крупных healthcare-сетях не приходят.

При этом крупные healthcare-сети (Kaiser, Sutter, UC Davis Health и пр.) **публикуют вакансии на Workday как минимум частично** — это самый стандартный enterprise-ATS для healthcare и финансов. Активация adapter'а под них даёт recurring scan без браузерных скрипт-индест-сессий.

## Зафиксированные решения (предлагаются)

| # | Решение | Альтернатива |
|---|---------|---------------|
| 1 | Регистрация tenant'ов через **shared `data/companies.tsv`** (как для PayPal/Capital One/Fidelity у Jared'а). Не делаем per-profile target list. | Per-profile `profile.json.discovery.workday.tenants[]` — отвергнуто: дублирует существующий механизм, ломает консистентность. |
| 2 | Лилин `profile.json.discovery.companies_whitelist` уже содержит точные названия (Kaiser Permanente / Sutter Health / UC Davis Health). Гарантируем **строгое совпадение поля `name`** в TSV — иначе scan отбросит target. | Добавить алиасы / fuzzy match — нет, scan-фильтр сейчас по lowercase exact name (см. `applyTargetFilters` в `scan.js`). |
| 3 | **Tenant slugs / `dc` / `site` определяет пользователь** (через Лилю или WebSearch на стороне юзера). Claude НЕ гадает — это правило из BACKLOG. | Claude угадывает — отвергнуто, цена ошибки = молчаливый 404 на каждый scan. |
| 4 | Адаптер уже фильтрует по `searchText` (POST body). Используем его, чтобы tenant'ы возвращали только релевантные роли (admin/scheduler/front-desk healthcare), а не все 5000 вакансий Kaiser. | Без `searchText` — отвергнуто: пробьём `MAX_JOBS_PER_TENANT=200` фильтрами слов, потеряем сигнал. |
| 5 | Cross-profile изоляция держится на **whitelist Лили** + том факте, что эти healthcare-tenant'ы у Jared'а в whitelist'е не появятся (у него `companies_whitelist: null`, но фильтра по `target_industries` на scan нет — поэтому риск, что Jared'у в pipeline попадут healthcare-вакансии Kaiser, реален). | См. секцию «Риски». |

## Архитектура

### Изменения в `data/companies.tsv`

Добавить N строк (N = число одобренных tenant'ов, ожидается 3-5):

```
name                  ats_source  ats_slug         extra_json
Kaiser Permanente     workday     <slug>           {"dc":"<dc>","site":"<site>","searchText":"medical receptionist"}
Sutter Health         workday     <slug>           {"dc":"<dc>","site":"<site>","searchText":"patient access"}
UC Davis Health       workday     <slug>           {"dc":"<dc>","site":"<site>","searchText":"medical receptionist"}
...
```

Поля `<slug>` / `<dc>` / `<site>` пользователь подтверждает до commit.

### Изменения в `profile.json` (Lilia)

**Не нужны.** `modules: ["...", "discovery:workday", ...]` уже есть. Whitelist уже содержит нужные имена.

### Изменения в коде

**Не нужны** (если tenant slugs корректны). Adapter, scan-orchestrator, фильтры — всё работает as-is.

## План проверки

### Pre-merge (моки)

1. `engine/modules/discovery/workday.test.js` — уже покрывает map / pagination / per-tenant failure isolation. Не меняем.
2. **Добавить unit-test** в `engine/commands/scan.test.js` (или соседний): scenario «Lilia + Workday tenants в companies.tsv с healthcare-именами + whitelist Лили → adapter получает только healthcare-targets, никаких PayPal/Capital One/Fidelity». Цель — закрепить поведение `applyTargetFilters` для смешанного pool.

### Post-merge (live smoke)

1. `node engine/cli.js scan --profile lilia --dry-run` — должен вывести:
   - `scanning N targets across M sources for profile "lilia"` — N включает healthcare-tenant'ы.
   - `discovery summary: ... workday: <N> returned` — без 4xx/5xx ошибок.
2. Проверить `result.fresh.length` — есть ли реальные вакансии. Если 0 на трёх tenant'ах подряд при `searchText="medical receptionist"` — это сигнал, что либо tenant slug неправильный, либо эти сети не публикуют ресепшинистов на Workday (нужен второй источник для них — backlog).
3. Если ОК — `--apply`-прогон, вакансии в Лилин `applications.tsv`. Затем обычный `validate` / `prepare` flow.

## Риски

### R1 — Угаданные tenant slugs дают 404 / редирект

Самый высокий риск. Workday slug ≠ название домена компании в публичном вебе. У Capital One slug = `capitalone`, dc = `wd12`, site = `Capital_One` — три независимых параметра, ни один не выводится из имени.

**Митигация**: правило #3 (Claude не гадает). До добавления в TSV — пользователь подтверждает каждую тройку (slug/dc/site) с ссылкой на работающий URL вида `https://{slug}.{dc}.myworkdayjobs.com/{site}/`. Adapter обрабатывает per-tenant failures изолированно (`runTargets` ловит exceptions per target), так что кривой tenant не убьёт scan, но и пользы от него ноль.

### R2 — Cross-profile leakage (Jared получает healthcare)

У Jared'а `companies_whitelist: null` → `applyTargetFilters` пропускает все targets, включая новые healthcare. Если Лилины Workday-tenant'ы попадут в `data/companies.tsv`, при следующем `scan --profile jared` Kaiser/Sutter тоже скан­нут­ся и попадут в Jared'ов `applications.tsv`.

**Митигация (3 варианта, выбрать перед commit)**:

- **A.** Добавить healthcare-имена в `profile.json.discovery.companies_blacklist` Jared'а. Минимально инвазивно, но требует поддержки списка при добавлении новых tenant'ов.
- **B.** Использовать механизм из RFC 008 (`profile` колонка в `companies.tsv` + `companiesForProfile` фильтр). Чище, но RFC 008 пока не реализован.
- **C.** Включить Jared'у whitelist (явный список fintech-имён). Самый строгий, но требует ручного maintenance ~80 имён.

**Рекомендация: A** как tactical fix сейчас + добавить запись в BACKLOG для перехода на B при реализации RFC 008.

### R3 — Healthcare tenant'ы возвращают тысячи нерелевантных вакансий

Kaiser Permanente — крупный работодатель, на Workday может быть десятки тысяч позиций. Без `searchText` уткнёмся в `MAX_JOBS_PER_TENANT=200` за случайной выборкой.

**Митигация**: правило #4 (`searchText` обязателен). Per-tenant `searchText` подбираем под ключевые роли Лили из `target_roles`: «medical receptionist», «patient access», «patient services», «front desk». Можно завести 1-2 строки на tenant с разными `searchText` если нужно покрыть несколько типов ролей.

### R4 — Низкий signal-to-noise даже с searchText

Healthcare Workday-вакансии могут оказаться в основном на nursing/clinical роли (RN, LVN, MA), что у Лили в `cert_blockers`. Scan их подтянет, потом `validate` отфильтрует, но шум в `applications.tsv` останется.

**Митигация**: после первого live smoke смотрим signal/noise. Если noise > 80% — добавляем pre-filter в Workday adapter (например, отбрасывать title содержащие RN/LVN/MA/CNA). Сейчас не делаем, оставляем в backlog.

## План имплементации (после approve)

1. **Пользователь предоставляет**: список tenant'ов с проверенными `slug` / `dc` / `site` / опционально `searchText`. Минимум 1, рекомендуется 3-5.
2. Решение по R2 (cross-profile leakage): A / B / C.
3. **Код**:
   - Append rows в `data/companies.tsv`.
   - Если выбран R2-fix A — добавить healthcare-имена в `profiles/jared/profile.json.discovery.companies_blacklist`.
   - Добавить unit-test на cross-profile изоляцию в `engine/commands/scan.test.js`.
4. **Smoke**:
   - `npm test` — все 524+ тестов зелёные.
   - `node engine/cli.js scan --profile lilia --dry-run` — N targets, 0 adapter errors на новых tenant'ах.
   - `node engine/cli.js scan --profile jared --dry-run` — НЕ должен включать healthcare-tenant'ы.
5. **Code-review агент** по диффу.
6. Показ юзеру: diff + smoke output. Approve → commit.
7. Live `--apply` прогон Лилин — выгрузка реальных вакансий.

## Зафиксированные решения (после ресёрча 2026-05-02)

### Tenant'ы

Из 5 запрошенных S/A-tier healthcare-сетей подтверждены **3 на Workday** (остальные на Taleo / iCIMS / NEOGOV / UC HR — вне scope этого RFC):

| Name (matches whitelist) | slug | dc | site | URL |
|---|---|---|---|---|
| Sutter Health | `sutterhealth` | `wd1` | `SH` | `https://sutterhealth.wd1.myworkdayjobs.com/SH` |
| Fresenius Medical Care | `freseniusmedicalcare` | `wd3` | `fme` | `https://freseniusmedicalcare.wd3.myworkdayjobs.com/fme` |
| SCAN Health Plan | `scanhealthplan` | `wd108` | `scancareers` | `https://scanhealthplan.wd108.myworkdayjobs.com/scancareers` |

Остальные крупные сети (Kaiser, CommonSpirit/Dignity, UC Davis Health, Shriners, HearingLife, Sacramento County) — на других ATS. Покрытие — отдельным RFC (новый adapter под iCIMS / Taleo / NEOGOV), записать в BACKLOG.

### searchTexts стратегия

`data/companies.tsv` дедуплицирует строки по `(source, slug)` — нельзя положить 8 строк на один tenant. Решение: **расширить adapter'а**, чтобы `extra_json` поддерживал `searchTexts: string[]` (массив) ИЛИ `searchText: string` (legacy). Если массив — adapter крутит loop по запросам и дедуплицирует результаты по `jobId` (`externalPath`).

8 запросов на tenant покрывают Лилины `target_roles`:

```
patient access, patient services, scheduler, front desk,
receptionist, admissions, intake coordinator, authorization
```

Шум от RN/LVN/MA отсекается уже на стороне Лилиного `validate` через `cert_blockers` — пост-фильтр, отдельный шаг pipeline.

### R2-fix: B (структурный — `profile` колонка в `data/companies.tsv`)

**Изменено по результатам ревью с юзером**: A (blacklist Jared'у) был отвергнут как нерасширяемый (каждое добавление healthcare = ручной патч у Jared'а). Вместо этого реализован B — минимальный подмножество RFC 008 без миграции на Notion-as-source-of-truth:

- `data/companies.tsv` расширен пятой колонкой `profile` (значения: `<id>` / пусто / `both`).
- `engine/core/companies.js` — `parseLine` обратно-совместим (4-col rows читаются как `profile=""`), `serialize` пишет 5-col, новый helper `filterByProfile(rows, profileId)` + `rowVisibleToProfile()`.
- `engine/commands/scan.js` — добавлен пред-фильтр `filterCompaniesByProfile` ДО whitelist/blacklist. Профильная видимость — структурный gate.
- `data/companies.tsv` мигрирован: 248 fintech-строк → `profile=jared`, 4 healthcare-строки (Sutter/Fresenius/SCAN/Indeed Lilia) → `profile=lilia`. Backup: `data/companies.tsv.pre-rfc010`.
- `profiles/jared/profile.json.discovery.companies_blacklist` сброшен в `[]` — больше не нужен.

Долгосрочный полный RFC 008 (Notion как source of truth для companies, sync companies → TSV, industry as relations) остаётся в backlog отдельной L-задачей.

## Связанное

- BACKLOG #1 (Active queue, 2026-05-02) — этот RFC закрывает.
- RFC 008 — долгосрочное решение для R2 (per-profile companies).
- `incidents.md` 2026-05-02 — Лилин cron сейчас отключён до проверки classifier-фикса; этот RFC независим, но при включении надо проверить, что workday-targets не дают classifier'у новых ложноположительных срабатываний.
