# SPEC — Behavioral contracts for `ai-job-searcher`

**Status**: Draft. Phase 1 Session 1 of 3.
**Scope of this session**: cross-cutting concerns + `scan` command.
**Subsequent sessions**: `prepare` + `sync` (Session 2), `check` + `validate` (Session 3).
**Owner**: Claude + repo owner.

---

## Как читать этот документ

Этот файл — **поведенческий контракт** движка. Не описание текущего кода и не дизайн-документ; описание того, **как команда / модуль ДОЛЖНЫ себя вести**, и **на каком источнике** основано это «должны».

### Назначение

1. **Audit-цикл**: assertion'ы здесь сверяются с текущей реализацией. Расхождение = баг (или гэп spec'а), не «фича по факту».
2. **Защита от регрессий**: при изменении поведения движок-кода соответствующий контракт обновляется в том же коммите (см. `~/.claude/skills/dev-workflow/SKILL.md` Шаг 9).
3. **Мост к прототипам**: для каждого контракта зафиксирован конкретный prototype-источник, чтобы при будущей миграции / переписывании было видно «как было задумано».

### Структура контракта

Каждый контракт — это блок вида:

```
### ID — Title

**Intent**: что должно быть. Один абзац или маркеры. **Обязательно источник** в скобках:
(RFC NNN §X / incident YYYY-MM-DD / prototype: file:line / quote: BACKLOG / quote: user).

**Prototype reference**: конкретный файл:строка из `../Job Search/` или `../Lilly's Job Search/`.

**Current implementation**: конкретный файл:строка из `ai-job-searcher/engine/`.

**Gap**: расхождение Intent vs Current. Если нет — `—`.
```

### Дисциплина «Intent ≠ current code»

Соблазн при написании spec — описать текущее поведение и закрепить его как намерение. **Это antipattern**, потому что превращает багов в «фичу» и обнуляет audit. Поэтому:

- Каждый Intent-блок ссылается на **внешний к коду источник**: RFC, incident, цитата пользователя в `BACKLOG.md`, файл прототипа.
- Если для контракта нет внешнего источника — это **spec-гэп** (помечается `Intent source: NONE — gap`), а не повод подкрепить spec кодом.
- Current implementation **может** быть неполной / багованной. Это нормально — gap фиксируется, не маскируется.

### Lilia-as-fork rule

Прототип Jared (`../Job Search/`) — base of truth для всех команд и cross-cutting контрактов.

Прототип Lilia (`../Lilly's Job Search/`) — фрозен-форк Jared'а на более ранней точке. Использовать **только** там, где её домен (healthcare, schedule, geo radius, certs) **действительно требует** отличия. Каждое Lilia-specific assertion — с тегом `[domain: healthcare]` и явным обоснованием. Без обоснования → не отдельный assertion, а реюз Jared-поведения.

Если у Lilia есть behavior, которого нет у Jared (потому что у Jared появилось уже после форка) — это **универсальный intent от Jared'а**, а не Lilia-specific. Spec пишет его как general, не как domain.

### Обозначения

- `→` — переход состояния.
- `engine/...` — пути относительно корня репо `ai-job-searcher/`.
- `../Job Search/...`, `../Lilly's Job Search/...` — прототипы (рядом с репо).
- `[L8 line 230]` — строка 230 в файле, упомянутом в текущем блоке.

---

# Часть 1 — Cross-cutting

Контракты, переиспользуемые между командами. Меняются вместе с командами через них.

---

### CC-1 — Status set (8 канонических статусов)

**Intent**: Pipeline оперирует строго восемью status'ами в Notion и TSV. Их имена в Notion и в коде совпадают побайтно (case-sensitive):

```
To Apply / Applied / Interview / Offer / Rejected / Closed / No Response / Archived
```

Историческая мотивация: до Stage 8 у Jared было больше статусов (`Inbox`, `Phone Screen`, `Onsite`), у Lilia — другой набор. В Stage 8 (commit подтверждён в `CLAUDE.md` секция «Stage 8») оба DB унифицированы; код в трёх местах должен опираться на этот канонический набор. (CLAUDE.md `Stage 8` + `BACKLOG.md` § Status options divergence — closed 2026-04-27.)

Канонические **roles** статусов в коде:

| Role | Members | Used by |
|------|---------|---------|
| `ACTIVE_STATUSES` (есть активная заявка, читаем Gmail-апдейты) | `To Apply`, `Applied`, `Interview`, `Offer` | `engine/commands/check.js` |
| `SKIP_STATUSES` (терминальный — Gmail-апдейты не применяются) | `Rejected`, `Closed`, `Archived`, `No Response` | `engine/commands/check.js` |
| `PUSH_SKIP_STATUSES` (не пушим в Notion при sync, но и не апдейтим) | `Archived` (как минимум) | `engine/commands/sync.js` |
| `RETRO_SWEEP_STATUSES` (статусы, к которым `validate` применяет blocklists ретроспективно) | `To Apply` | `engine/commands/validate.js` |
| Default for new TSV row | `To Apply` | `engine/core/applications_tsv.js:appendNew()` |

**Prototype reference**: `../Job Search/job_registry.tsv` — TSV использовал старый набор (`Inbox` / `To Apply` / `Applied` / `Phone Screen` / `Onsite` / `Offer` / `Rejected` / `Archive` / `Closed`). `Inbox` означал «новая строка от scan», `Archive` — отфильтрованная при scan. Унификация — пост-прототипное решение.

**Current implementation**:
- `engine/commands/check.js:34-35` — `ACTIVE_STATUSES = ["To Apply", "Applied", "Interview", "Offer"]`, `SKIP_STATUSES = ["Rejected", "Closed", "Archived", "No Response"]`.
- `engine/core/applications_tsv.js:204` (`appendNew`) — default status `"To Apply"`.
- `engine/commands/validate.js:27,30` — retro-sweep по `To Apply`.
- `engine/commands/prepare.js:42` — `CAP_ACTIVE_STATUSES` для company_cap (4 статуса).
- `engine/commands/sync.js:1` — `PUSH_SKIP_STATUSES` включает `Archived`.

**Gap**: 
- `Inbox` исчез из канонического набора — корректно. `appendNew` теперь возвращает `"To Apply"`, что нарушает старую инвариантность «scan создаёт `Inbox`, prepare переводит в `To Apply`». Как результат, **новые строки от `scan` неотличимы от строк, готовых к применению** (notion_page_id пустой — единственный признак). См. CC-1.a ниже.
- `INTERVIEW_INVITE → "Interview"` (а не `"Phone Screen"`) — корректно, согласно Stage 8.
- `RETRO_SWEEP_STATUSES` в текущем коде включает только `To Apply`; intent — все pre-applied активные (`To Apply`). Спорный момент — стоит ли дочищать blocklist'ом `Applied` строки. Spec — оставляем только `To Apply` (после Applied поезд ушёл).

#### CC-1.a — «Свежесть» строки определяется через `notion_page_id`, не через статус

**Intent**: После Stage 8 нет отдельного «inbox»-статуса. Свежие, неподготовленные строки от `scan` имеют:
- `status = "To Apply"` (по `appendNew` default), 
- `notion_page_id = ""` (пусто),
- `cl_key = ""`, `resume_ver = ""`, `cl_path = ""` (всё пусто — материалы ещё не сгенерированы).

Команды должны различать «свежий, ещё не подготовленный» (`status="To Apply" && !notion_page_id`) и «подготовленный, ждёт submit» (`status="To Apply" && notion_page_id`). (`CLAUDE.md` Stage 8: «`prepare.js` фильтр fresh rows перешёл с `status === "Inbox"` на `status === "To Apply" && !notion_page_id`».)

**Prototype reference**: `../Job Search/find_jobs.js:main()` — добавлял строки с `status="Inbox"`, что было самоопределяющим. Текущая инвариантность — техдолг от унификации.

**Current implementation**: `engine/commands/prepare.js` — фильтр fresh-rows; `engine/commands/sync.js:planPush` — gate по наличию `cl_key OR resume_ver` (commit `d2f7d92`, см. `BACKLOG.md` § Архитектура).

**Gap**: Двойной смысл `"To Apply"` создаёт риск race'ов и confusion'а у пользователя при ручной работе в Notion. Окончательное решение — RFC 012 (нормализованная модель с `prepared_at` timestamp). Сейчас защищено двумя независимыми guard'ами (push-gate в sync, fresh-row фильтр в prepare). Spec фиксирует это явно.

---

### CC-2 — Filter rules: canonical flat shape

**Intent**: Один внутренний формат правил фильтрации, который используют все consumer'ы (`filter`, `prepare`, `email_filters`, `validate`). Профайл на диске (`profiles/<id>/filter_rules.json`) допускается в **двух shape'ах**: nested (как в прототипе) или flat (engine native). `profile_loader.normalizeFilterRules()` приводит к canonical flat и **никто кроме него nested не парсит**.

Канонический flat shape:

```jsonc
{
  "company_blocklist": [ "Toast", "Gusto", ... ],            // strings
  "title_blocklist":   [ { "pattern": "VP", "reason": "..." }, ... ],
  "title_requirelist": [ { "pattern": "...", "reason": "..." }, ... ],
  "location_blocklist":[ "India", "London", "EMEA", ... ],   // substring patterns
  "company_cap":       { "max_active": 3, "active_statuses": [...] },
  "domain_weak_fit":   [ ... ],
  "early_startup_modifier": [ ... ],
  "priority_order":    [ ... ]
}
```

Источник: Stage 15 prototype-parity pass — RFC-incident: «engine ожидал flat, а `filter_rules.json` был nested → blocklists никогда не отрабатывали при scan» (CLAUDE.md Stage 15: «**Fixes a latent prod bug: blocklists were never exercised at scan time…**»). Solution: нормализация через `profile_loader`, единый shape ниже по стеку.

**Prototype reference**: `../Job Search/filter_rules.json` (370 lines) — **nested** shape:
- `company_blocklist.companies: [{name, reason}]`
- `title_blocklist.patterns: [{pattern, reason}]`
- `location_blocklist.patterns: [strings]`
- `company_cap: {max_active: 3, active_statuses: [...]}`
- `domain_weak_fit.patterns: [...]`
- `early_startup_modifier.companies: [...]`
- `priority_order.criteria: [...]`

**Current implementation**:
- `engine/core/profile_loader.js:121-162` (`normalizeFilterRules`) — принимает оба shape'а, возвращает flat.
- `engine/core/filter.js:42-119` — потребляет flat shape (`rules.company_blocklist[]`, `rules.title_blocklist[].pattern`, `rules.location_blocklist[]`).
- `profiles/jared/filter_rules.json` — **nested** (исторически из прототипа).
- `profiles/lilia/filter_rules.json` — **flat** (свежий минимальный, из Stage 18 wizard).

**Gap**: Оба shape'а допустимы на диске — это conscious decision (не ломать импорт прототипа). Riska нет — нормализатор покрыт тестами Stage 15. Не требует фикса.

---

### CC-3 — Filter semantics

#### CC-3.1 — Title blocklist: case-insensitive, word-boundary, slash-split

**Intent**: 
1. **Case-insensitivity**: title-pattern сравнивается с lowercased title. Прототип использует case-insensitive substring (`/Job Search/find_jobs.js:572-574`); engine — word-boundary regex с `\b...\b` для предотвращения false-positive'ов типа `PRN` matching `rn` или `orthodontic` matching `do`. Word-boundary — улучшение поверх прототипа, intent эквивалентен (см. CC-3.2).
2. **Slash-titles**: title с `/` (например, `"Senior PM / Director, Growth"`) разбивается на части по `/`; если **любая** часть проходит все фильтры, job не блокируется. Иначе блок. Это для multi-role-postings, где первая часть может быть junior, а вторая — senior. (Не было явно в прототипе — **engine improvement**, см. CC-3.2 Gap.)
3. **Comma-split НЕ применяется**: title `"Senior PM, Growth"` целиком матчится одним токеном (запятая — это suffix, а не альтернатива).

Источник: CLAUDE.md Stage 15: «title blocklist regex → case-insensitive substring; … extracted `matchBlocklists()` helper».

**Prototype reference**: `../Job Search/find_jobs.js:572-574` (`applyFilterRules`) — `title.toLowerCase().includes(pattern.toLowerCase())`. Plain substring, без word-boundary, без slash-split.

**Current implementation**:
- `engine/core/filter.js:62-66` — slash-split, single clean part → pass.
- `engine/core/filter.js:93` — `\b${escapeRegex(needle)}\b` word-boundary regex.
- `engine/core/filter.js:42-119` (`matchBlocklists`) — порядок проверок: company → title → location.

**Gap**: 
- Word-boundary vs substring — **намеренное различие** vs прототип. Word-boundary глушит ложноположительные (Jared в прототипе несколько раз пропускал валидные роли из-за substring `rn` ⊂ `PRN`). Spec фиксирует word-boundary как intent.
- Slash-split (G-2) — **closed 2026-05-03 (Phase 3 triage).** Engine improvement без явного RFC, но поведение разумное (multi-role posting'и типа `"PM / Sr PM"` или `"Receptionist/Office Manager"` не должны полностью блокироваться, если одна из частей проходит фильтр). Behavior зафиксирован в `engine/core/filter.js` header doc-block + здесь в SPEC CC-3.1 как intent. Это не два TSV-record'а — это одна job, у которой title оценивается покомпонентно для blocklist/requirelist. Decision: **keep as-is**, retro-justification — данный SPEC.

#### CC-3.2 — Location blocklist: US-marker safeguard

**Intent**: Любой блокер локации игнорируется, если в location string присутствует один из US-маркеров: `"united states"`, `"usa"`, `", us"`, `"(us)"`, `"u.s."`. Цель — не блокировать роли «Remote (United States, India, UK)» из-за одного из non-US токенов в комбинированной строке. (CLAUDE.md Stage 15: «US-marker safeguard for location blocklist (skips blocklist when `united states` / `usa` / `, us` / `(us)` / `u.s.` present)».)

Сравнение location pattern'а с location string — case-insensitive substring. Word-boundary **не** применяется (короткие коды стран типа `UK`, `BR` валидно матчатся как substring без `\b`).

**Prototype reference**: `../Job Search/find_jobs.js:559-569` (`applyFilterRules`) — точно такой же US-marker safeguard. **Унаследован 1:1 из прототипа.**

**Current implementation**:
- `engine/core/filter.js:22` — `US_MARKERS` константа.
- `engine/core/filter.js:24-26` — `hasUsMarker(locLower)`.
- `engine/core/filter.js:97-110` (внутри `matchBlocklists`) — early-return перед location проверками.

**Gap**: —. 1:1 perfection с прототипом.

#### CC-3.3 — Company blocklist: case-insensitive exact match

**Intent**: Company блокеры — массив строк, сравнение **case-insensitive по равенству** (а не substring). Цель: не глушить компанию-родственника просто за то, что её имя — substring блокера (например, блокер `"Stripe"` не должен задевать `"Stripe Identity"` если он не в списке отдельно).

**Prototype reference**: `../Job Search/find_jobs.js:553` — `.toLowerCase()` сравнение, exact equality.

**Current implementation**: `engine/core/filter.js` (внутри `matchBlocklists`) — exact lowercase equality.

**Gap**: —.

#### CC-3.4 — Title requirelist (positive filter)

**Intent**: Если в profile задан `title_requirelist`, job проходит **только если** title матчит хотя бы один паттерн из requirelist. Применяется **до** blocklist'ов (нет смысла проверять негатив-фильтры на job, который уже не в скоупе ролей). У Jared'а requirelist реализован неявно через PM regex `/(product\s+manag)/i` в каждом адаптере прототипа. У Lilia — нет positive-фильтра на title (роли уже задаются keyword search'ом в Indeed).

Источник: код `engine/core/profile_loader.js:121-162` (нормализация — поле `title_requirelist`). Прототип: PM regex inline в адаптерах.

**Prototype reference**: `../Job Search/find_jobs.js` — PM filter inline в `scanGreenhouse` и других adapter'ах (regex `/(product\s+manag)/i` на title). Не вынесен в `filter_rules.json`.

**Current implementation**: `engine/core/profile_loader.js:121-162` нормализует поле `title_requirelist` к `[{pattern, reason}]`. Применение — TBD (**spec gap**, см. ниже).

**Gap**: Нормализатор поддерживает поле, но `engine/core/filter.js:matchBlocklists` его **не проверяет**. Сейчас requirelist никем не enforce-ится; PM-filter live из прототипа в адаптерах не перенесён в общий слой. **Это gap intent vs implementation**: либо адаптеры должны фильтровать сами (как прототип), либо общий слой должен enforce'ить requirelist. Триаж в Phase 3.

---

### CC-4 — Dedup keys

#### CC-4.1 — Primary dedup key: `source:jobId`

**Intent**: Каждое jobs-объявление однозначно идентифицируется парой (source, jobId). Format ключа: `"{source_lowercased}:{jobId_trimmed}"`. Примеры:

```
greenhouse:7666190003
lever:6c7f8a90-1b2c-3d4e-5f60-7a8b9c0d1e2f
ashby:f1e2d3c4-...
smartrecruiters:743999765432
workday:R12345
calcareers:JC-456789
usajobs:723456700
remoteok:senior-product-manager-acme
indeed:abc123def456
adzuna:1234567890
```

Источник: прототип `../Job Search/find_jobs.js:601` (`extractJobId(url, platform)`) использовал ровно этот формат с префиксом платформы. Engine унаследовал — `engine/core/dedup.js:4-8` (`jobKey`).

**Prototype reference**: `../Job Search/find_jobs.js:497` (`normalizeKey`), `:508` (`loadRegistry`), `:601` (`extractJobId`).

**Current implementation**: `engine/core/dedup.js:4-8` (`jobKey`) — `${source}:${jobId}` с lowercase source.

**Gap**: —.

#### CC-4.2 — Fuzzy dedup key (cross-platform): `company::normalized-title`

**Intent**: Для случая когда ту же роль постят на двух разных ATS (компания мигрировала с Lever на Greenhouse, или у роли два постинга с разным ID на одном ATS), используется fuzzy ключ `${normalizeCompany(name)}::${normalizeTitle(title)}`, где normalize:
- Lowercase, strip ASCII punctuation, collapse whitespace.
- Company: дополнительно strip trailing `Inc`/`LLC`/`Ltd`/`Corp`/`Co`.

Источник: прототип `../Job Search/find_jobs.js:497` (`normalizeKey`) + `:540-550` (lookup logic) — fuzzy lookup как secondary check.

**Prototype reference**: `../Job Search/find_jobs.js:497, 540-550`.

**Current implementation**: `engine/core/dedup.js:10-18` (`normalizeCompanyName`) — функция есть, lowercase + strip punctuation + collapse whitespace + strip trailing suffixes. **`engine/core/dedup.js:dedupeJobs / dedupeAgainst` её НЕ используют** — оба работают только на primary key (`source:jobId`).

**Gap**: **Significant.** Fuzzy dedup в прототипе предотвращал «один postingsпоявляется в двух ATS» дублирование. В engine — `normalizeCompanyName` существует как утилита, но в dedup-флоу не задействована. Live consequence: если компания мигрировала с Lever на Greenhouse, роль появляется дважды в TSV. **Триаж в Phase 3**: либо implement fuzzy dedup в `dedupeAgainst`, либо явно spec'ом отказаться (и удалить мёртвую утилиту).

#### CC-4.3 — `applications.tsv` дедуп ключ — primary only

**Intent**: При `appendNew` от scan'а — дедуп строго по primary key `source:jobId`. Никакой fuzzy: если job уже в `applications.tsv`, новая строка не создаётся; если нет — создаётся со status `"To Apply"` и пустым `notion_page_id`. Никакой merge fields (если нашли тот же job с обновлённым title — игнорируем). 

Это инвариант из прототипа: `job_registry.tsv` append-only, статус мутируется отдельным шагом.

**Prototype reference**: `../Job Search/find_jobs.js:main()` — append-only, dedup перед append.

**Current implementation**: `engine/core/applications_tsv.js:204-230` (`appendNew`) — dedup по `makeKey(source, jobId)`.

**Gap**: —.

---

### CC-5 — `profile.json` schema

**Intent**: Per-profile конфигурация в `profiles/<id>/profile.json`. Канонические top-level ключи (Stage 18 onboarding wizard generated):

```jsonc
{
  "id": "<lowercase-id>",                 // совпадает с именем папки
  "identity": { "name", "email", "phone", "location", "linkedin", "website" },
  "discovery": { 
    "keywords": [...], "locations": [...], "results": N, ...
    "companies_whitelist": [...], "companies_blacklist": [...]
  },
  "modules": [ "discovery:greenhouse", "discovery:lever", ..., "tracking:gmail" ],
  "filter_rules_file": "filter_rules.json",          // относительный путь
  "company_tiers": { "S": [...], "A": [...], "B": [...], "C": [...] },
  "company_aliases": { ... },                        // optional, у Lilia может отсутствовать
  "resume": { "versions_file": "resume_versions.json", "templates_dir": "..." },
  "cover_letter": { "versions_file": "cover_letter_versions.json", "template": "..." },
  "notion": { 
    "jobs_db_id": "...", "companies_db_id": "...", 
    "application_qa_db_id": "...", "job_platforms_db_id": "...",
    "workspace_page_id": "..."
  },
  "hub": { "subpages": { "candidate_profile": "...", "workflow": "...", ... } },
  "preferences": { "salary_target_tier": "...", "format": "...", ... },
  "flavor": "pm" | "healthcare",                     // hub-layout flavor
  "geo": { "countries": [...], "states": [...], "radius_miles": N }   // RFC 013, NOT YET enforced
}
```

Источник: RFC 004 (onboarding wizard) + RFC 013 (geo enforcement) + CLAUDE.md Stage 16 / Stage 18.

**Prototype reference**: **Нет одного `profile.json`.** Конфиг прототипа Jared'а распределён:
- Targets — hardcoded в `../Job Search/find_jobs.js:1-350`.
- Resume archetypes — `../Job Search/resume_versions.json`.
- CL versions — `../Job Search/cover_letter_versions.json`.
- Identity (имя, телефон, email, LinkedIn) — внутри resume_versions.json (per archetype).
- Filter rules — `../Job Search/filter_rules.json` (nested).
- Notion DB IDs — в скриптах `sync_notion.js` или env.
- Geo (Sacramento) — hardcoded в скриптах + filter_rules.

Engine consolidation в `profile.json` — **post-prototype design** (RFC 001).

**Current implementation**:
- `profiles/jared/profile.json` (top-level keys видны через `engine/core/profile_loader.js:loadProfile`).
- `profiles/lilia/profile.json` — без `company_aliases`.
- `engine/core/profile_loader.js:40-107` (`loadProfile`) — резолвит `paths.applicationsTsv`, `paths.resumesDir`, `paths.coverLettersDir`, `paths.jdCacheDir`.

**Gap**: 
- `geo` поле **отсутствует** в обоих текущих profile.json — RFC 013 ещё не реализован. Tactical fix Workday `appliedFacets` + `locationAllow` живёт в `data/companies.tsv`, не в profile (см. CC-9).
- `company_aliases` у Lilia отсутствует — это **корректно** (нет необходимости, у неё whitelist меньше и без aliases). Не gap.

---

### CC-6 — `applications.tsv` schema (v2, 15 columns)

**Intent**: Per-profile состояние всех известных jobs (свежие от scan + готовые от prepare + поданные + отвергнутые). **Append-only по строкам, mutable по статусу**: новый job → новая строка; статус job — мутирует in-place.

Schema v2 (15 колонок, tab-separated, header-line):

```
key  source  jobId  companyName  title  url  status  notion_page_id  resume_ver  cl_key  salary_min  salary_max  cl_path  createdAt  updatedAt
```

| Column | Type | Источник заполнения |
|--------|------|---------------------|
| `key` | string | `${source_lowercase}:${jobId_trimmed}` (unique) |
| `source` | string | adapter name (`greenhouse`, `lever`, ...) |
| `jobId` | string | platform-specific (gh — int, lever — UUID, ...) |
| `companyName` | string | от adapter'а, без normalization |
| `title` | string | от adapter'а, без normalization |
| `url` | string | от adapter'а |
| `status` | enum | один из 8 status'ов CC-1, default `"To Apply"` |
| `notion_page_id` | string | UUID или `""` (если не запушено) |
| `resume_ver` | string | archetype key (`ConsumerGrowth`, `MedAdmin v2`, ...) от prepare |
| `cl_key` | string | CL identifier (`affirm_consumer_platform`, ...) от prepare |
| `salary_min` | number\|"" | от prepare (RFC 002 / Stage 13) |
| `salary_max` | number\|"" | от prepare |
| `cl_path` | string | filename без extension (`Affirm_Analyst_II_v3`) от prepare |
| `createdAt` | ISO date | timestamp при `appendNew` |
| `updatedAt` | ISO date | timestamp при любой мутации |

v1 → v2 auto-upgrade на read (Stage 13). **Save всегда v2**.

Источник: CLAUDE.md Stage 13 — schema v2 со всеми 15 колонками.

**Prototype reference**: `../Job Search/job_registry.tsv` — другая схема:
- 10–12 колонок (`company`, `role`, `job_id`, `source`, `status`, `notion_id`, `date_posted`, `resume_version`, `cl_key`, `location`, [+CalCareers extras]).
- Колонка `location` присутствует (engine её удалил — переехала в `data/jobs.tsv`).
- Нет `salary_min` / `salary_max` (engine добавил в Stage 13).
- Нет `createdAt` / `updatedAt` (engine добавил).
- `notion_id` — короткий hash или `"pending"`; engine использует full UUID.

Engine schema — refactor из прототипа, mapping строки сделан в Stage 16 (`scripts/stage16/migrate_tsv_from_prototype.js`).

**Current implementation**:
- `engine/core/applications_tsv.js:rowFor()` (lines 61-79) — сериализация 15-полей.
- `engine/core/applications_tsv.js:load()` (lines 169-191) — детект v1 vs v2, auto-upgrade.
- `engine/core/applications_tsv.js:save()` (lines 193-202) — атомарная запись v2 (temp file → rename).
- `engine/core/applications_tsv.js:appendNew()` (lines 204-230) — dedup по `key`, default `"To Apply"`.

**Gap**: 
- Нет `location` колонки — **намеренно**: location живёт в shared pool `data/jobs.tsv` (см. CC-7), per-profile applications не дублируют. Это нормально, **но** при чтении applications без join'а с jobs.tsv UI/CLI не видит локацию. Окончательный fix — RFC 012 (нормализация + join). Сейчас sync.js в Notion использует поле через ad-hoc join; spec фиксирует это как known limitation.

---

### CC-7 — `data/companies.tsv` + `data/jobs.tsv` (shared pools)

**Intent**: Кросс-профайл shared state.

`data/companies.tsv` — master список ATS-targets (компания × ATS-источник × extras):

```
name  ats_source  ats_slug  extra_json  profile
```

| Column | Semantics |
|--------|-----------|
| `name` | display name компании |
| `ats_source` | `greenhouse` / `lever` / `ashby` / `workday` / `smartrecruiters` / `calcareers` / `usajobs` / `indeed` / `adzuna` / ... |
| `ats_slug` | platform-specific slug (для Workday — может быть `slug?dc=wd1&site=jobs`) |
| `extra_json` | per-target JSON: `{searchText: "PM", appliedFacets: [...], locationAllow: [...]}` (для Workday geo fix) |
| `profile` | profile id или comma-list (`"jared,lilia"`) — какой профайл видит этот target |

`data/jobs.tsv` — master pool всех увиденных jobs (cross-profile dedup):

```
source  slug  jobId  companyName  title  url  locations  team  postedAt  discoveredAt  rawExtra
```

Источник: RFC 001 (multi-profile architecture) + RFC 010 (Workday geo extras в `extra_json`) + RFC 012 (нормализация TBD).

**Prototype reference**: 
- Прототип Jared targets были inline в `find_jobs.js:1-350`. Cross-profile shared pool отсутствовал (один профайл).
- `companies.tsv` — engine introduction (Stage 5–7).

**Current implementation**:
- `data/companies.tsv` — 253 строк (header + targets).
- `data/jobs.tsv` — append-only от каждого scan'а.
- `engine/commands/scan.js:111-127` — фильтрация companies по profile + whitelist/blacklist.

**Gap**: 
- `profile` колонка — ad-hoc denormalization. RFC 012 предлагает join-table `profile_companies.tsv`. До миграции — текущий формат фиксируется как «сейчас так».
- comma-list parser в `profile` колонке (`"jared,lilia"`) — фрагильный. Spec фиксирует, что **только** RFC 012 удаляет этот hack.

---

### CC-8 — Env-var namespacing

**Intent**: Все секреты — в **одном** root-level `.env` (gitignored), с namespaced prefix `{PROFILE_ID_UPPER}_`. Нет per-profile `.env`. Loader (`loadSecrets`) для профайла `<id>` возвращает только переменные с этим префиксом, и **снимает префикс** перед передачей в engine code. Внутри engine код видит «локальные» переменные без префикса (например `NOTION_TOKEN`, `GMAIL_CLIENT_ID`), не зная имени профайла.

Преобразование `id → prefix`:
- Lowercase id `jared` → uppercase prefix `JARED_`.
- Dash `-` в id → underscore `_` в prefix (`my-prof` → `MY_PROF_`).

Канонические env-var ключи (на префикс):

```
{PFX}_NOTION_TOKEN          # required
{PFX}_GMAIL_CLIENT_ID       # check --auto (Phase 1)
{PFX}_GMAIL_CLIENT_SECRET   # check --auto
{PFX}_GMAIL_REFRESH_TOKEN   # check --auto
{PFX}_USAJOBS_API_KEY       # discovery:usajobs (Jared optional)
{PFX}_USAJOBS_EMAIL         # discovery:usajobs
{PFX}_ADZUNA_APP_ID         # discovery:adzuna
{PFX}_ADZUNA_APP_KEY        # discovery:adzuna
```

Источник: `CLAUDE.md` § Secrets, RFC 005 §3 (Gmail), RFC 011 (keyword search adapters).

**Prototype reference**: `../Job Search/.env` — без префиксов (один профайл, не нужно). `NOTION_TOKEN`, `USAJOBS_API_KEY`, `USAJOBS_EMAIL`.

**Current implementation**:
- `engine/core/profile_loader.js:164-167` (`secretPrefix`) — `id.toUpperCase().replace(/-/g, '_') + '_'`.
- `engine/core/profile_loader.js:173-182` (`loadSecrets`) — `pickEnv(env, prefix)`, возвращает stripped object.

**Gap**: —. Стабильно с RFC 001.

---

### CC-9 — Geo enforcement (current state + intent)

**Intent (target)**: Profile декларирует geo один раз в `profile.json.geo`, движок применяет этот скоуп ко **всем** adapters — server-side где возможно, post-fetch фильтр везде остальном. Не в каждом адаптере отдельно. (RFC 013.)

**Intent (current state, до RFC 013)**: Geo enforcement — **per-adapter, ad-hoc**, реализован только для Workday как tactical fix:
- Workday adapter принимает `appliedFacets` (server-side filter) и `locationAllow` (post-fetch substring match) **per target** через `data/companies.tsv:extra_json`.
- Все остальные адаптеры geo не enforce-ят. Полагаются либо на:
  - profile-level `location_blocklist` (post-fetch, но реактивный — блокеры стран);
  - adapter-specific input от profile.discovery (для keyword adapter'ов: Adzuna, the_muse, USAJOBS).

Tactical fix описан как **временный** в RFC 010 / RFC 013. Замена — RFC 013 (после RFC 012).

**Prototype reference**: `../Job Search/find_jobs.js:559-569` — единственный geo enforcement в прототипе через US-marker safeguard в location_blocklist. Workday в прототипе был с минимальным coverage (3 tenants), без `appliedFacets`.

**Current implementation**:
- `engine/modules/discovery/workday.js:77-88` (`locationMatchesAllow`) — case-insensitive substring match; `"N Locations"` patterns (мульти-локация без перечисления городов) drop'аются.
- `engine/modules/discovery/workday.js:97` — мап job → drop если no match.
- `engine/modules/discovery/workday.js:185, 200` — `droppedByLocation` counter в summary.
- Все остальные адаптеры — нет.

**Gap**: 
- 485 Fresenius global jobs incident (2026-05-02) показал, что **до tactical fix'а** Лилин Workday adapter не enforce'ил geo. Это закрыто per-target в companies.tsv.
- Jared Workday targets (PayPal, Capital One, Fidelity) **сейчас тоже без gео-фильтра**, потенциально подвержены той же дыре. Не воспроизводилось пока, но факт — gap. RFC 013 закрывает.
- `profile.json.geo` (canonical поле) **не существует** в текущих profile'ах — будет добавлено в RFC 013.

---

### CC-10 — Auto-sync hook (`scan` → `sync`)

**Intent**: После успешного `scan` (exit code 0, не dry-run) автоматически запускается `sync --apply` с тем же профайлом. Сбой `sync` в auto-режиме — non-fatal, warning в stderr. Цель: пользователь не должен помнить вызывать `sync` после каждого `scan` — это всегда правильный следующий шаг для попадания свежих rows в Notion (для prepare и check команд).

Источник: `DEVELOPMENT.md` § Adding a new pipeline step + cli.js inline.

**Prototype reference**: Прототип не имел pipeline-hooks. После `find_jobs.js` пользователь вручную вызывал `sync_notion.js`.

**Current implementation**:
- `engine/cli.js:209-225` — `PIPELINE_HOOKS`.
- Hook `scan` (lines 210-224) запускает `sync` после exit 0.
- `--no-sync` флаг отключает hook.
- `--dry-run` тоже пропускает hook.

**Gap**: —. Стабильно.

---

### CC-11 — `flavor: "pm" | "healthcare"`

**Intent**: Profile имеет поле `flavor`, которое влияет на нарратив hub-страницы Notion (build_hub_layout). Используется только для prose-текстов в Workflow / Triggers / callout subpages. **Не влияет на DB schema, не влияет на data flow, не влияет на статусы** — code paths общие.

`flavor: "pm"` — default, Jared back-compat. Workflow с упоминанием Interview Coach skill, традиционные PM-тригеры.

`flavor: "healthcare"` — Lilia, manual-first short workflow без Interview Coach. Justified domain-specific differences:
- Healthcare admin интервью часто проходят без structured PM coaching.
- Schedule constraints критичны — нужен callout с интервью-таймингом, не storyboard.

Источник: CLAUDE.md Stage 8 — добавление `profile.flavor`.

**Prototype reference**: Прототип без концепции flavor. Workflow text жил inline в `../Lilly's Job Search/skills/lilia-job-pipeline/SKILL.md` (Lilia) и `../Job Search/skills/job-pipeline/SKILL.md` (Jared).

**Current implementation**: `scripts/stage18/build_hub_layout.js` — две ветки текста. Default `pm` (back-compat).

**Gap**: —. Domain-justified: healthcare флоу действительно требует другой нарратив (CC-домен Lilia-as-fork rule).

---

# Часть 2 — `scan` command

## Высокоуровневая модель

`scan` — фаза discovery: пройти по всем enabled adapter'ам, получить от каждого список jobs, отфильтровать против profile rules, дедуплицировать против shared pool и applications.tsv, добавить fresh rows в applications.tsv, опционально записать в shared `data/jobs.tsv`. **Не пушит в Notion** (это делает `sync`, который вызывается hook'ом).

```
profile.modules + companies.tsv          (вход: какие adapter'ы и для каких targets)
       ↓
parallel adapter.discover(targets)       (выход: list of NormalizedJob[])
       ↓
filter (CC-2, CC-3)                      (drop blocklisted)
       ↓
in-batch dedup (CC-4.1)                  (drop duplicates within scan)
       ↓
cross-run dedup vs data/jobs.tsv (CC-4.1)(drop already-seen)
       ↓
appendNew → applications.tsv (CC-4.3)    (dedup vs already-applied)
       ↓
write data/jobs.tsv + applications.tsv   (если не dry-run)
       ↓
[hook] sync --apply                      (CC-10)
```

---

### S-1 — Orchestration: parallel adapters, error isolation

**Intent**: Все enabled adapters вызываются **параллельно** (не sequence — одна медленная Workday не блокирует Greenhouse). Сбой одного adapter'а **изолирован**: его jobs = `[]`, error логируется в `summary.errors`, остальные adapters продолжают.

Цель: гарантировать, что один rate-limited Lever или 5xx от RemoteOK не валит весь scan. Прототип использовал try/catch вокруг каждого `scanCompany()` ровно для этого.

Источник: прототип `../Job Search/find_jobs.js:700-750` + RFC 001 § Architecture.

**Prototype reference**: `../Job Search/find_jobs.js:700-750` — batch loop с try/catch, fail-soft.

**Current implementation**:
- `engine/core/scan.js:36-92` — `Promise.allSettled(adapters.map(a => a.discover(targets, ctx)))`.
- На каждый rejected — `{ jobs: [], error }` в summary.
- На каждый fulfilled — jobs добавляются в pool.

**Gap**: —. Семантика идентична прототипу + аккуратнее (allSettled vs nested try/catch).

---

### S-2 — Module enablement

**Intent**: Adapter активен для профайла **только если** в `profile.json.modules` есть строка `"discovery:<adapter-source>"`. Engine не запускает adapter'ы автоматически по факту наличия в registry. Цель: профайл на 8 источников, не на 11 — без ручного запуска ненужных adapter'ов (что экономит rate-limits и не плодит noise).

Дополнительные модули:
- `tracking:gmail` — для `check` (не для scan).
- `discovery:<name>` — список scan adapters.

Источник: RFC 001 + RFC 011 (keyword adapters opt-in).

**Prototype reference**: Прототип имел enable/disable inline в `find_jobs.js:main()` через `if`-blocks. У Lilia отсутствие ATS adapter'ов было захардкожено в её SKILL.md.

**Current implementation**:
- `engine/commands/scan.js:57-67` (`modulesToSources`) — extract `"discovery:<name>"`.
- `engine/modules/discovery/index.js:36-50` (`buildRegistry`) — auto-load адаптеров; не «enable», только «available».
- `engine/commands/scan.js:103-109` — пересечение enabled module list × available registry.

**Gap**: —.

---

### S-3 — Target list resolution

**Intent**: Для адаптеров типа «target-driven» (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, CalCareers) — список targets берётся из `data/companies.tsv`, отфильтрованный по двум уровням:

1. **Profile visibility filter**: строка из `companies.tsv` видна для профайла `<id>` если `row.profile === "<id>"` либо `row.profile.split(",").includes("<id>")`.
2. **Discovery whitelist/blacklist**: после profile filter применяется `profile.discovery.companies_whitelist` (allowlist by name) и `companies_blacklist` (denylist by name). Если whitelist непустой — оставить только entries из whitelist; иначе — все non-blacklisted.

Для адаптеров типа «feed» (RemoteOK, Adzuna, the_muse, Indeed) — targets не нужны; синтетический target вставляется в массив, чтобы adapter получил `targets[0]` с `feedMode: true`.

Для адаптеров типа «keyword» (Adzuna, the_muse, USAJOBS) — параметры (keywords, locations, results limit) берутся из `profile.discovery`.

Источник: CLAUDE.md Stage 12 prereq block («`feedMode` injection in scan»), RFC 011 (keyword adapters).

**Prototype reference**: `../Job Search/find_jobs.js:1-350` — hardcoded targets array. Whitelist/blacklist отсутствовал. Lilia прототип использовал inline keyword rotation в SKILL.md.

**Current implementation**:
- `engine/commands/scan.js:111-120` — load companies.tsv + profile filter.
- `engine/commands/scan.js:69-90` (`applyTargetFilters`) — whitelist/blacklist.
- `engine/commands/scan.js:122-127` — group by `ats_source`.
- `engine/commands/scan.js:129-140` — feedMode synthetic target injection для feed adapters.

**Gap**: —.

---

### S-4 — Adapter contract: input / output

**Intent**: Каждый adapter — модуль с экспортами:

```jsonc
{
  "source": "greenhouse",                 // string, lowercase, unique
  "discover": "async (targets, ctx) => NormalizedJob[]"
}
```

`targets` — массив `{ name, ats_source, ats_slug, extra_json, profile }` объектов (для target-driven), либо `[ {feedMode: true, ...profile.discovery} ]` (для feed).

`ctx` — `{ profile, secrets, logger, jdCache, urlCheck, ... }` — shared utilities. Adapter использует `secrets.NOTION_TOKEN` без префикса, `secrets.USAJOBS_API_KEY` и т.п.

`NormalizedJob` shape:

```jsonc
{
  "source": "greenhouse",                 // совпадает с adapter.source
  "jobId": "7666190003",                  // string, unique within source
  "companyName": "Affirm",                // human-readable
  "title": "Analyst II, Credit Risk Analytics",
  "url": "https://...",
  "location": "Remote (US)",              // optional, free-text
  "team": "Risk",                         // optional
  "postedAt": "2026-04-15",               // optional, ISO date
  "rawExtra": { /* opaque, written to data/jobs.tsv:rawExtra */ }
}
```

Adapter **не делает** filter, dedup, TSV-операции — это работа core. Adapter только fetch + parse + map в NormalizedJob[]. Adapter может делать early-drop по сильному signal'у (e.g. Workday `locationAllow` не передаёт post-fetch failed-match jobs дальше — но это **исключение**, домен-знание о бесполезности retry'я).

Источник: RFC 001 § Adapter contract.

**Prototype reference**: `../Job Search/find_jobs.js:300-650` — каждый `scan*()` функция возвращала массив объектов с фиксированной shape (немного варьировалась per platform). Прототип не имел формального контракта; engine унифицировал.

**Current implementation**:
- `engine/modules/discovery/<adapter>.js` — пара `{ source, discover }`.
- `engine/modules/discovery/index.js:36-50` валидирует обе ключи при load'е.

**Gap**: 
- `NormalizedJob.location` — некоторые adapters (workday) возвращают `locations` (массив), некоторые — `location` (строка). Engine рендерит `data/jobs.tsv:locations` колонку из обоих. Spec фиксирует **строка** как канонический intent, массив — implementation deviation; нормализация при map'е.
- `rawExtra` — opaque blob: что туда попадает, не специфицировано, лишь бы было JSON-serializable. Это by design.

---

### S-5 — Per-adapter intent

#### S-5.greenhouse

**Intent**: HTTP GET к `boards-api.greenhouse.io/v1/boards/{slug}/jobs`. Public API, без auth. Возвращает массив jobs (paginated через offset/total если > 50). Адаптер должен:
- Извлечь `id` (numeric) → `jobId`.
- Извлечь `title`, `location.name`, `absolute_url`.
- **НЕ** делать title-фильтрацию (PM regex) — это работа filter layer'а (см. CC-3.4 gap).

Источник: прототип `../Job Search/find_jobs.js:300-450`.

**Prototype reference**: `../Job Search/find_jobs.js:300-450` (`scanGreenhouse`).

**Current implementation**: `engine/modules/discovery/greenhouse.js`.

**Gap**: —.

#### S-5.lever

**Intent**: HTTP GET к `api.lever.co/v0/postings/{slug}?mode=json`. Public API. Возвращает flat массив. JobId — full UUID (не sequence). 

Источник: прототип `../Job Search/find_jobs.js:400-500`.

**Prototype reference**: `../Job Search/find_jobs.js:400-500` (`scanLever`).

**Current implementation**: `engine/modules/discovery/lever.js`.

**Gap**: —.

#### S-5.ashby

**Intent**: HTTP GET к `api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`. Возвращает `{jobs: [...]}` — нужно извлечь `.jobs[]`. JobId — 36-char UUID.

Источник: прототип `../Job Search/find_jobs.js:450-550`.

**Prototype reference**: `../Job Search/find_jobs.js:450-550`.

**Current implementation**: `engine/modules/discovery/ashby.js`.

**Gap**: —.

#### S-5.smartrecruiters

**Intent**: HTTP GET к `api.smartrecruiters.com/v1/companies/{slug}/postings`. Public API. Pagination через `.totalFound` и `offset`. JobId — 10+ digit integer из URL.

Источник: прототип `../Job Search/find_jobs.js:500-580`.

**Prototype reference**: `../Job Search/find_jobs.js:500-580`.

**Current implementation**: `engine/modules/discovery/smartrecruiters.js`.

**Gap**: —.

#### S-5.workday

**Intent**: HTTP POST к `<tenant>/wday/cxs/<tenant>/<site>/jobs` (Workday CXS API), public для большинства tenant'ов. **Per-target** конфигурация в `extra_json`:

```jsonc
{
  "dc": "wd1",                                         // datacenter prefix
  "site": "External",                                  // careers site name
  "searchText": "Product Manager",                     // optional keyword
  "appliedFacets": { "locationCountry": ["bc33aa3152ec42d4995f4791a106ed09"] },  // server-side US filter
  "locationAllow": ["United States", "Remote", "California", ...]  // post-fetch substring whitelist
}
```

**`locationAllow` semantics** (CC-9):
- Case-insensitive substring match (job's `locationsText` contains any allow).
- Если job's location — `"3 Locations"` или `"5 Location"` (мульти-локация без перечисления городов) → **drop**, потому что нельзя определить попадает ли в allow.
- Если `locationAllow` не задан — пропустить все.

JobId — Workday-specific (`R\d{5,}` или `JR\d{5,}` суффикс).

Источник: прототип `../Job Search/find_jobs.js:550-650` + RFC 010 (Workday tenants для Lilia) + RFC 013 (geo enforcement).

**Prototype reference**: `../Job Search/find_jobs.js:550-650`. Прототип имел минимум 3 Workday tenants (PayPal, Capital One, Fidelity), без `appliedFacets`/`locationAllow` (geo-фильтр работал через post-fetch location_blocklist).

**Current implementation**:
- `engine/modules/discovery/workday.js` — POST к `wday/cxs/...`, paginated.
- `engine/modules/discovery/workday.js:77-88` (`locationMatchesAllow`).
- `engine/modules/discovery/workday.js:97` — drop при no-match.
- `engine/modules/discovery/workday.js:185, 200` — `droppedByLocation` counter.

**Gap**: 
- `appliedFacets` + `locationAllow` — engine improvement над прототипом, родился из incident'а 2026-05-02 (485 Fresenius global jobs).
- Эти поля **per-target** в `companies.tsv:extra_json`, а не в `profile.geo` — tactical fix, описанный как такой в RFC 010 и RFC 013 (закрытие — RFC 013).
- Jared Workday targets без `locationAllow` — gap (см. CC-9).

#### S-5.calcareers

**Intent**: ASP.NET form-post emulation против `jobs.ca.gov/CalHrPublic/Jobs/JobPosting.aspx`. Iterate paginated результаты (rowCount=100). Filter (server-side) по classification ID (ITM1/ITM2/ITS1/ITS2 для Jared'а — IT Manager classes), grade level. Custom dedup key: `calcareers:<JobControlId>`.

Эктра-fields: `classification` (ITM2 etc), `final_filing_date` — попадают в `rawExtra`.

Источник: прототип `../Job Search/find_jobs_calcareers.js`.

**Prototype reference**: `../Job Search/find_jobs_calcareers.js:1-170`.

**Current implementation**: `engine/modules/discovery/calcareers.js`.

**Gap**: —. (Live использование Jared — единственный профайл с этим adapter'ом.)

#### S-5.usajobs

**Intent**: HTTP GET к USAJOBS REST API (`data.usajobs.gov`). Требует `USAJOBS_API_KEY` + `USAJOBS_EMAIL` (free tier). Filter по ExamCode (2210 IT, 0340 Program Manager у Jared), LocationName contains California / Telework, grade GS-9+. Dedup key: `usajobs:<PositionID>`.

Источник: прототип `../Job Search/find_jobs_usajobs.js` + RFC 001 + BACKLOG § Discovery sources.

**Prototype reference**: `../Job Search/find_jobs_usajobs.js:1-210`.

**Current implementation**: `engine/modules/discovery/usajobs.js` — adapter готов, но **не активирован** в `profiles/jared/profile.json.modules` (требует регистрации API key, отложено в BACKLOG).

**Gap**: **Disabled by default**, активация требует ручного шага. Spec фиксирует это явно.

#### S-5.remoteok

**Intent**: HTTP GET feed `https://remoteok.com/api`. Public, no auth. Возвращает flat array. Адаптер — feed mode (без targets). PM regex filter inline (как в прототипе) — domain-knowledge о том, что RemoteOK включает все роли, а не только PM. Dedup: `remoteok:<slug>`.

Источник: прототип `../Job Search/find_jobs_remoteok.js`.

**Prototype reference**: `../Job Search/find_jobs_remoteok.js:1-90`.

**Current implementation**: `engine/modules/discovery/remoteok.js` (Stage 12 prereq).

**Gap**: PM-regex inline в адаптере — отступление от CC-3.4 intent (filter layer). Domain-justification: RemoteOK feed — слишком noisy без early-drop, post-fetch фильтр прогоняет десятки тысяч jobs на каждом scan'е. Spec фиксирует как **adapter-level early-drop** исключение.

#### S-5.indeed

**Intent**: Browser-ingest вариант. `engine/commands/indeed_prepare.js` (отдельная команда) генерирует prebuilt search URLs + extraction snippet; Claude MCP browser сканит страницы и наполняет `profiles/<id>/.indeed-state/raw_indeed.json`. Adapter `indeed.js` нормализует этот raw файл → NormalizedJob[]. **Не делает HTTP запросы сам** (Indeed агрессивно банит; CAPTCHA после ~5–7 поисков).

Domain: только Lilia (healthcare admin), ~12 keywords × Sacramento metro + 25mi radius. Dedup: `indeed:<jobKey>`.

Источник: BACKLOG § Discovery sources — closed 2026-04-28, commit `eadaa1d`.

**Prototype reference**: `../Lilly's Job Search/skills/lilia-job-pipeline/SKILL.md:36-50` — inline keyword rotation. Прототип не имел отдельного adapter'а.

**Current implementation**: 
- `engine/commands/indeed_prepare.js` — генератор URL + snippet.
- `engine/modules/discovery/indeed.js` — нормализация.
- `profiles/lilia/.indeed-state/` — raw cache.

**Gap**: Two-phase MCP-flow (как `check`) — требует Claude-сессии для browser scan, не self-contained. Это known design decision (Indeed ToS + CAPTCHA), не gap.

#### S-5.adzuna

**Intent**: HTTP GET к Adzuna jobs API. Free-tier: `ADZUNA_APP_ID` + `ADZUNA_APP_KEY`. Keyword + location query (params из `profile.discovery`). Domain: Jared keyword adapter (Stage 11). Dedup: `adzuna:<id>`.

Источник: RFC 011 (keyword search adapter).

**Prototype reference**: Прототип не имел Adzuna; adapter — engine-only feature.

**Current implementation**: `engine/modules/discovery/adzuna.js`.

**Gap**: —.

#### S-5.the_muse

**Intent**: HTTP GET к The Muse public API. Keyword + location query. Domain: Jared keyword adapter. Dedup: `the_muse:<id>`.

Источник: RFC 011.

**Prototype reference**: Прототип не имел The Muse.

**Current implementation**: `engine/modules/discovery/the_muse.js`.

**Gap**: —.

---

### S-6 — In-batch + cross-run dedup

**Intent**: 
1. **In-batch dedup** (CC-4.1): после adapter'ов собран combined `batch[]`. Пройти по нему `dedupeJobs(batch)` — если две одинаковые `source:jobId` пришли от разных подвызовов (e.g. Greenhouse paginated с overlap), оставить первую.
2. **Cross-run dedup** (CC-4.1): `dedupeAgainst(existing, batch)`, где `existing` — load `data/jobs.tsv` (cross-profile shared pool). Если job уже там — он не fresh (был увиден прошлым scan'ом, может быть, другим профайлом). Out: `fresh[] = batch \ existing`. 

Output `pool = existing ∪ fresh` — что записывается обратно в `data/jobs.tsv`.

Источник: прототип `../Job Search/find_jobs.js:540-550` + RFC 001 § Architecture.

**Prototype reference**: `../Job Search/find_jobs.js:540-550` — registry-based dedup. Engine использует `data/jobs.tsv` как cross-run pool (прототип использовал `job_registry.tsv`, который у engine — `applications.tsv`, separate concern).

**Current implementation**:
- `engine/core/scan.js:69-76` — `dedupeJobs(batch)` then `dedupeAgainst(existing, batch)`.
- `engine/core/dedup.js:20-29` (`dedupeJobs`) — Map by key, first-occurrence wins.
- `engine/core/dedup.js:31-45` (`dedupeAgainst`) — set difference.

**Gap**: см. CC-4.2 — fuzzy dedup отсутствует. Live consequence: cross-platform тот же постинг может попасть дважды.

---

### S-7 — Per-profile applications.tsv append

**Intent**: После filter + dedup, оставшиеся jobs → `applications_tsv.appendNew(existing, fresh, { defaultStatus: "To Apply" })`. Внутри:
- Дедуп vs `applications.tsv` (CC-4.3).
- Для каждого новой строки: `key`, `source`, `jobId`, `companyName`, `title`, `url` from job; `status="To Apply"`, `notion_page_id=""`, `resume_ver=""`, `cl_key=""`, `salary_min=""`, `salary_max=""`, `cl_path=""`, `createdAt = updatedAt = now ISO`.

Это эквивалент `Inbox`-добавления в прототипе (CC-1 + CC-1.a).

Источник: CLAUDE.md Stage 8.

**Prototype reference**: `../Job Search/find_jobs.js` — append с status `"Inbox"`.

**Current implementation**: `engine/core/applications_tsv.js:204-230` (`appendNew`); вызывается из `engine/commands/scan.js:217-222`.

**Gap**: —.

---

### S-8 — Dry-run vs apply semantics

**Intent**: `--dry-run` — **не записывает** ни `data/jobs.tsv`, ни `applications.tsv`, и **не запускает** auto-sync hook. Печатает summary (что было бы добавлено по counters per source + total fresh + total dropped).

`--apply` — для `scan` **noop** (apply семантика не специфицирована для scan'а; scan по-умолчанию commit). Зарезервирован для других команд (`prepare --phase commit`, `validate --apply`, etc).

`--no-sync` — commit, но **без** auto-sync hook. Использовать для batch-runs нескольких профайлов с manual sync в конце.

Источник: RFC 001 + CLAUDE.md Stage 6 § Sync defaults to dry-run.

**Prototype reference**: Прототип не имел single-flag dry-run. `find_jobs.js` всегда писал; отдельный `validate_pipeline.js` был для проверок.

**Current implementation**:
- `engine/cli.js:19-39` — flag definitions.
- `engine/commands/scan.js:224-234` — branch на dry-run.
- `engine/cli.js:209-225` — hook respects `--no-sync` + `--dry-run`.

**Gap**: 
- `--apply` для `scan` — отстаточный hangover от шаблона CLI; не делает ничего, не логируется. Triage: либо переименовать `scan --commit` (явный default), либо принять как noop. Spec — оставляем noop, явно фиксируем.

---

### S-9 — Counters / summary

**Intent**: По завершении scan'а (apply или dry-run), на stderr / stdout печатается structured summary:

```
SCAN summary [profile=jared, modules=greenhouse,lever,...]
  greenhouse:        N jobs from M targets, K errors
  lever:             ...
  workday:           N jobs from M targets, K errors, droppedByLocation=L
  ...
  TOTAL:             X discovered, Y filtered, Z fresh added
  filter breakdown:  blocked_company=A, blocked_title=B, blocked_location=C, capped=D
  fresh:             Z rows added to applications.tsv
```

Цель — операционная видимость: пользователь видит, что adapter X упал, что Y blocked локации.

Источник: прототип `../Job Search/find_jobs.js:1050-1100` — `scan_summary.json` writeout.

**Prototype reference**: `../Job Search/find_jobs.js:1050-1100`.

**Current implementation**:
- `engine/commands/scan.js:182-199` — собирает summary.
- `engine/commands/scan.js:38-55` (`redactor`) — маскирует секреты в выводе.
- `engine/core/scan.js:78-84` — summary per source.

**Gap**: 
- Точная shape summary не зафиксирована formal'но; различные команды могут лог'ить по-разному. Не блокирующий gap — summary is debug-only, не consumed downstream.

---

# Часть 3 — Cross-cutting additions (Session 2)

### CC-12 — Determinism vs interactivity

**Intent**: Pipeline-команды CLI (`scan`, `prepare`, `validate`, `sync`, `check`) должны быть **детерминированы**: одинаковый вход + одинаковое состояние диска / Notion / Gmail → одинаковый выход. Решения «спросить пользователя по ходу» противоречат этому контракту:
- сессии Claude отличаются друг от друга по тому, сколько раз он спросил;
- автоматизация (cron, scheduled task, dispatch) не может отвечать на вопросы;
- пользователь не имеет одной точки входа: «запусти прогон, дай результат».

Прототип (Jared `Job Search/`) — **полностью детерминирован** в SKILL.md prepare:
- `Batch Size Limit: Max 30 jobs per prepare run. After filtering …, pick the top 30 by fit score (Strong > Medium > Weak), then by domain relevance to fintech. Remaining jobs stay as Inbox for the next run. Never ask the user whether to batch — just take 30 and report the rest as "deferred to next run."` — прямая цитата из `../Job Search/skills/job-pipeline/SKILL.md:142-143`.
- Для unknown salary tier — нет интерактивного гейта; стартап-tier добавляется в `salary_calculator.js` + Notion Companies DB до запуска prepare.

Engine SKILL.md (`skills/job-pipeline/SKILL.md` Step 2): `Ask user to confirm before proceeding if batch is larger than 10.` — это **deviation**, не feature.

Engine SKILL.md Step 6: `If null (unknown company tier): flag to user, do NOT invent a range.` — это полу-deviation: оставляет интерактивный гейт там, где прототип уже решал на этапе подготовки company_tiers.

**Spec rule** (Phase 3 reference):
- Любой step pipeline'а, требующий ответа пользователя `[ok / yes / confirm]` посередине — это deviation от prototype-intent. Допустимо только в local-dev / CLI helpers; в основном prepare/sync/check/validate flow — не допустимо.
- Альтернативы: задать поведение конфигом (`profile.json.prepare.batch_size`, `prepare.unknown_tier_action: "skip" | "fallback_default" | "fail"`) или флагом CLI (`--batch N`, `--on-unknown-tier=skip`).
- SKILL.md «дополняет» CLI — но **не смеет** модифицировать его контракт. Если CLI пишет result-файл с записью `decision: "to_apply"`, то commit-фаза должна это применить идентично, независимо от того, какая Claude-сессия его произвела.

**Prototype reference**: `../Job Search/skills/job-pipeline/SKILL.md:142-143, 158-160` (batch and gates), `../Job Search/find_jobs.js` orchestration.

**Current implementation**:
- CLI `prepare --phase pre`/`commit` — **детерминирован** (`engine/commands/prepare.js`).
- CLI `sync --apply` — **детерминирован** (`engine/commands/sync.js`).
- SKILL.md prepare Step 2 + Step 6 — **interactive gates**, deviation от prototype.

**Gap**:
- G-10: SKILL.md Step 2 batch>10 prompt — deviation. **Fix policy** (Phase 3): принять prototype-intent → удалить prompt, использовать `--batch` flag (default 30). Либо вынести в profile.json.
- G-11: SKILL.md Step 6 unknown-tier prompt — полу-deviation. **Fix policy**: либо явный config (`prepare.unknown_tier_action`), либо требовать pre-prepare наполнения tier'ов (как в прототипе).

---

# Часть 4 — `prepare` команда

**Сводный контракт** prepare — двухфазный orchestrator:
- **Phase 1 (`--phase pre`)**: чисто-детерминированный CLI, no LLM. Берёт «свежие» строки из applications.tsv, фильтрует, проверяет URL, тянет JD, считает зарплату, пишет `prepare_context.json`.
- **Phase 2 (SKILL)**: Claude читает context, делает gео-проверку, fit-score, выбор archetype, пишет CL, пушит в Notion, формирует results.json.
- **Phase 3 (`--phase commit`)**: чисто-детерминированный CLI, читает results.json, мутирует applications.tsv.

Главный архитектурный вопрос (см. P-3, P-5, P-7, P-8): **что должно быть в CLI, а что в SKILL.** Прототип имел гораздо больше в CLI (find_jobs.js + дополнительные .js файлы); engine вынес LLM-heavy шаги в SKILL.

---

### P-1 — Phase boundary («fresh» definition)

**Intent**: «Свежая» строка для prepare = `status === "To Apply" && notion_page_id === ""`. После commit — статус остаётся `"To Apply"`, но появляется `notion_page_id`, и строка перестаёт попадать в следующий `--phase pre`.

После Stage 8 status'а `"Inbox"` нет. До Stage 8 в прототипе fresh = `status === "Inbox"`; engine унаследовал «Inbox» concept на уровне CC-1 (см. G-1) и закрыл его двойным гвардом (`status==="To Apply" && !notion_page_id`).

Источник: CLAUDE.md Stage 8 (status unification), `engine/commands/prepare.js:204-209` комментарий.

**Prototype reference**: `../Job Search/skills/job-pipeline/SKILL.md:154` — `Collect all Inbox jobs from TSV (notion_id=pending)`.

**Current implementation**:
- `engine/commands/prepare.js:207-209` — `apps.filter((a) => a.status === "To Apply" && !a.notion_page_id)`.

**Gap**: Зависит от G-1 (двойной смысл `"To Apply"`). Закрывается RFC 012.

---

### P-2 — Filter (title blocklist + title requirelist + company cap)

**Intent**: Перед URL-check'ом отбраковываются job'ы по:
1. **company_blocklist** (CC-3.2) — company hard-block.
2. **title_requirelist** (CC-3.4) — positive gate (опц.). Проверка по slash-split parts of title с word-boundary regex.
3. **title_blocklist** (CC-3.3) — case-insensitive substring.
4. **company_cap** (CC-3.5) — max active jobs per company (`To Apply` / `Applied` / `Interview` / `Offer`); per-company `overrides`.

Order: company_blocklist → title_requirelist → title_blocklist → company_cap.

Источник: `../Job Search/skills/job-pipeline/SKILL.md:46-50` (Company Cap @ prepare), CC-3 spec.

**Prototype reference**: `../Job Search/find_jobs.js:577-581` (domain weak fit), но **company_cap** в прототипе живёт **в SKILL.md tactical step** (читает TSV awk'ом, не имеет formal'ного модуля). В engine — formal в `applyPrepareFilter`.

**Current implementation**:
- `engine/commands/prepare.js:78-165` — `applyPrepareFilter`. Возвращает `{ passed, skipped }` где skipped имеет `reason ∈ {"company_blocklist", "title_requirelist", "title_blocklist", "company_cap"}` + дополнительные поля (pattern, cap, current).
- `engine/commands/prepare.js:42` — `CAP_ACTIVE_STATUSES = ["To Apply", "Applied", "Interview", "Offer"]`.
- Comment-fallback (`p && typeof p === "object" ? p.pattern : p`) — поддерживает inline-tests без normalizeFilterRules.

**Gap**:
- G-12: Filter ratio surprise (prepare-audit findings) — для Jared 74/125 fresh row отсеялись через `company_cap`, и пользователь не понял почему. Spec: company_cap легитимен и matches prototype intent (max 3 active per company). Это не gap кода, но **DX gap**: `prepare --phase pre` summary должна явно ranj'ать reasons (`company_cap=74, title_blocklist=12, ...`), а не only показывать «after filter: N passed, M skipped».
- G-3 (см. CC-3.4) уже учтён: `title_requirelist` enforce'ится здесь, но **только в prepare**, не в scan-time для адаптеров. Adapter'ы делают inline regex (Greenhouse PM, Workday locationAllow).

---

### P-3 — URL liveness check

**Intent**: Каждый job в batch'е проверяется HEAD + GET fallback (см. CC-prereq в Stage 12), с SSRF защитой. Dead URL → переходит в `skipped` с `reason="url_dead"`. Не блокирует прогон, но и не доходит до commit.

LinkedIn, Indeed, custom-site URLs могут возвращать 403/CF-block — эти строки помечаются как `urlAlive=false`. SKILL Step 5 вместо `decision: "to_apply"` пишет `decision: "skip"` (с reason `"url_dead"`).

Источник: prepare-audit findings (8 LinkedIn rows died at URL-check), Stage 12 prereq block.

**Prototype reference**: `../Job Search/check_urls.js` (prototype helper), `../Job Search/skills/job-pipeline/SKILL.md:157` — `URL liveness check — batch all job URLs through node check_urls.js …`.

**Current implementation**:
- `engine/core/url_check.js` — `checkAll(rows, fetch, opts)` + SSRF guard + board-root detection.
- `engine/commands/prepare.js:226-230` — `urlResults = await deps.checkUrls(...); alive = filter alive; dead = filter !alive`.
- Dead скипы попадают в `context.skipped` с `reason="url_dead"`.

**Gap**:
- G-13: LinkedIn (+ Indeed scrape, custom careers) — **first-class gap** в pipeline. Adapter'а linkedin нет (prototype тоже не имел), но строки попадают в applications.tsv через manual TSV-edit или через `check.js` LinkedIn alert ingestion (`../Job Search/skills/job-pipeline/SKILL.md:333` LinkedIn alert → Inbox). Они дохнут на URL-check 8/8 раз. **Spec policy** (Phase 3): либо помечать `source="linkedin"` строки как `decision: "skip"; reason="linkedin_no_url"` до URL-check (deterministic), либо заранее фильтровать `applyPrepareFilter` по `source`. Пока — не блокер.

---

### P-4 — JD fetch + cache

**Intent**: Для alive URL'ов engine тянет полный JD text через ATS-API эндпоинты:
- Greenhouse: `boards-api.greenhouse.io/v1/boards/<slug>/jobs/<id>` → `content` field.
- Lever: `api.lever.co/v0/postings/<slug>/<id>?mode=json` → `descriptionPlain`.

Кеш на диске: `profiles/<id>/jd_cache/<slug>_<jobId>.json`. Slug derives из URL (parseSlugFromUrl).

JD text используется в SKILL Step 3 (geo) и Step 4 (fit) **вместо WebFetch**. WebFetch — fallback когда JD-API не поддерживается (Workday, SmartRecruiters, Ashby, etc.).

Источник: Stage 12 prereq block, `engine/core/jd_cache.js`.

**Prototype reference**: Прототип не имел JD-cache. Использовал WebFetch для каждого job в SKILL.md prepare (Step 5 geo + Step 6 implicit). Engine добавляет — это **plus**, не gap.

**Current implementation**:
- `engine/core/jd_cache.js` — `fetchAll(rows, jdCacheDir, deps, opts)`.
- `engine/commands/prepare.js:236-245` — fetch для alive only, results map'аются через index.
- Каждая batch entry получает `jdStatus ∈ {"cached", "fetched", "miss", "not_fetched", "skipped_dead_url"}`, и если есть text — `jdText`.

**Gap**:
- G-14: JD-cache не покрывает Workday / SmartRecruiters / Ashby / RemoteOK / CalCareers / USAJOBS / Indeed — для этих SKILL Step 3-4 ходит через WebFetch, что non-deterministic (timeout retries, IP-rate-limit). Не критично, но source of inconsistency.

---

### P-5 — Salary calculator

**Intent**: Per-job salary range = `companyTiers[companyName] × parseLevel(title) × COL-multiplier(SF/NYC hybrid)`. Pure function, no I/O, deterministic.

- `parseLevel`: regex по title, returns `"PM" | "Senior" | "Lead"`.
- Matrix: 4 tiers (S/A/B/C) × 3 levels.
- COL: +7.5% если `workFormat ∈ {Hybrid, Onsite}` AND city contains `san francisco | new york | nyc`.
- Unknown tier (companyName ∉ companyTiers) → returns `null`.

Источник: `../Job Search/skills/job-pipeline/SKILL.md:70-93` (Salary Expectations + matrix).

**Prototype reference**: `../Job Search/salary_calculator.js` + `salary_matrix.md`. Прототип использовал тот же matrix, но **с inline-обновлением** company_tiers в обоих местах (script + Notion Companies DB).

**Current implementation**:
- `engine/core/salary_calc.js:39-46` — `parseLevel`.
- `engine/core/salary_calc.js:48-59` — `adjustedSalary` (COL multiplier).
- `engine/core/salary_calc.js:63-89` — `calcSalary(companyName, title, opts)` returns `{tier, level, min, max, mid, expectation}` или `null`.
- `engine/commands/prepare.js:270-271` — call per batch entry: `if (salary) entry.salary = salary;`. Иначе — `entry.salary` отсутствует, и SKILL Step 6 «flags to user».

**Gap**:
- G-15 (deviation): Unknown-tier поведение в engine — `null` → SKILL Step 6 `flag to user, do NOT invent a range`. **Prototype intent**: tier добавляется в company_tiers (в обоих stores) **до запуска prepare**, и тогда unknown tier — operator error. Engine оставил unknown-tier как silent-pass-through, что приводит к интерактивному гейту (см. G-11). **Fix policy** (Phase 3): default policy = **prototype** → `prepare --phase pre` должна `exit 1` при unknown tier И печатать список missing companies. Опционально через `--allow-missing-tier` флаг.

---

### P-6 — `prepare_context.json` schema

**Intent**: Phase 1 → Phase 2 contract, written by CLI, read by Claude:

```json
{
  "profileId": "<id>",
  "generatedAt": "<ISO>",
  "batchSize": 30,
  "batch": [
    {
      "key": "<source>:<jobId>",
      "source": "...", "jobId": "...", "companyName": "...", "title": "...", "url": "...",
      "urlAlive": true | false,
      "urlStatus": <int>,
      "urlBoardRoot": true,                 // optional: URL is ATS root, not job-specific
      "jdStatus": "cached" | "fetched" | "miss" | "not_fetched" | "skipped_dead_url",
      "jdText": "...",                      // optional, present iff jdStatus in {cached, fetched}
      "salary": { tier, level, min, max, mid, expectation } | undefined
    }
  ],
  "skipped": [
    { "key", "reason": "company_blocklist" | "title_blocklist" | "title_requirelist" | "company_cap" | "url_dead", ... }
  ],
  "stats": { "inboxTotal", "afterFilter", "inBatch", "urlAlive", "urlDead" }
}
```

Источник: `engine/commands/prepare.js:283-296`.

**Prototype reference**: Прототипа `prepare_context.json` не было. Phase 1 prepare в прототипе = ручной запуск `find_jobs.js` (scan) + ручной запуск `validate_inbox.js` + затем сам Claude в SKILL читал TSV напрямую.

**Current implementation**: `engine/commands/prepare.js:283-307` (атомарная запись tmp + rename).

**Gap**:
- G-16: Schema не имеет `dryRun` маркера и нет «версии». Если меняется shape — нет migration. Не блокер пока, но spec'ировать в RFC 012 / 015.

---

### P-7 — SKILL Phase 2 (LLM steps 1-9)

**Intent**: После того как CLI написал `prepare_context.json`, Claude:

| Step | Действие | Прототип | Engine |
|------|----------|----------|--------|
| 1 | Load memory | `memory/user_writing_style.md` + `user_resume_key_points.md` + feedback_*.md | Same |
| 2 | Read prepare_context.json | (не было — читал TSV) | Read context, **ask user if batch>10** ← deviation (G-10) |
| 3 | Geo per job | WebFetch URL location field (no JD-cache) | Use jdText if present, else WebFetch; mark `geo: "us-compatible" / "non-us" / "unknown"` |
| 4 | Fit score per job | DOMAIN-only, 4 levels (Strong/Medium/Weak/early-startup-modifier) | Same |
| 5 | Filter geo+fit | Skip non-US OR Weak | Same |
| 6 | Salary auto-fill | use matrix; if tier unknown — ADD TIER first (operator step before prepare) | use `entry.salary` if present; **flag user if null** ← deviation (G-11) |
| 7 | Archetype selection | 12 archetypes hardcoded в SKILL.md по индустриям | from `profile.resume_versions.json` per archetype keys; preference by domain keyword overlap |
| 8 | CL generation | **assemble + humanize** (P1 hook + P2 Alfa-Bank proof + P3 AI/Credit Mentor + P4 Close), apply Humanizer Rules inline | **fresh per job**, 3-4 paragraphs, apply Humanizer Rules inline |
| 9 | Notion page create | через MCP / direct API | через MCP; 9a — resolve Company relation through Companies DB |

Источник: `skills/job-pipeline/SKILL.md:130-232` (engine), `../Job Search/skills/job-pipeline/SKILL.md:130-208` (prototype).

**Prototype reference**: `../Job Search/skills/job-pipeline/SKILL.md:130-208`.

**Current implementation**: `skills/job-pipeline/SKILL.md:130-232`.

**Gap**:
- G-10 (deviation): Step 2 batch>10 prompt — см. CC-12.
- G-11 (deviation): Step 6 unknown-tier prompt — см. CC-12.
- G-17 (architectural divergence): **Step 8 CL generation paradigm**. Prototype = **assemble** (4 fixed paragraph templates from `cover_letter_versions.json`, applied per archetype + per company). Engine = **fresh generation** (3-4 paragraphs from scratch per job). Fresh-generation теряет batch-consistency (две CL для двух job'ов одной компании могут разойтись по факту/тоне) и тратит больше токенов. **Fix policy** (Phase 3): default = **prototype** → SKILL Step 8 переписать в «load archetype template from cover_letter_versions.json + fill {{placeholders}} (company, role, JD-snippet) + run Humanizer pass once». Engine уже имеет archetype-keyed `cover_letter_versions.json` (Stage 18 generator), но SKILL'у не вшит контракт его использовать.
- G-18 (architectural divergence): **Step 7 Archetype list**. Prototype hardcoded 12 archetypes в SKILL.md (`../Job Search/skills/job-pipeline/SKILL.md:160-175`); engine читает из `profile.resume_versions.json`, but SKILL.md `skills/job-pipeline/SKILL.md:184` говорит «from `profiles/<id>/resume_versions.json`». Это **engine improvement** (per-profile flexibility), не gap. Но SKILL не enforce'ит «pick from list» — Claude может улететь и придумать архетип, которого нет в profile. **Fix policy**: validate в Step 7 что выбранный resumeVer ∈ Object.keys(profile.resume_versions.versions); иначе ругаться.

---

### P-8 — Phase 3 commit (CLI)

**Intent**: Read results.json, mutate applications.tsv. Per-row decision branching:

| `decision` | TSV mutation |
|-----------|-------------|
| `"to_apply"` | `status="To Apply"`, set `cl_key`, `cl_path`, `resume_ver`, `notion_page_id`, `salary_min`, `salary_max`, `updatedAt=now` |
| `"archive"` | `status="Archived"`, `updatedAt=now` |
| `"skip"` / unknown | no mutation (row stays `"To Apply"` без `notion_page_id`, появится снова в next `--phase pre`) |

`--dry-run` пропускает `saveApplications`.

Источник: `engine/commands/prepare.js:316-403` + Stage 13 schema v2 (cl_path / salary_min / salary_max).

**Prototype reference**: `../Job Search/skills/job-pipeline/SKILL.md:200-204` — `Update TSV: Inbox → To Apply, set resume_version + cl_key + notion_id`.

**Current implementation**:
- `engine/commands/prepare.js:316-403` (`runCommit`).
- Validation: `--results-file` required; profileId mismatch warns (not errors); apps.tsv loaded fresh; `byKey` map used for lookup.

**Gap**:
- G-19: `decision` value enum не валидируется — unknown values silently treated as `"skip"`. Trivial fix: enum-check + warn. Не блокер.

---

### P-9 — Cross-phase contract (idempotency)

**Intent**: prepare должна быть **rerun-safe**:
1. `--phase pre` идемпотентна (читает TSV + пишет context.json — context можно переписать).
2. SKILL phase идемпотентна для job'ов которые **уже** запушены в Notion: если `decision="to_apply"` повторно — должна skip создание page и просто обновить TSV. На сегодня — engine SKILL не имеет такого guard'а; повторный запуск создаст дубль page.
3. `--phase commit` идемпотентна: results.json применяется по ключу, second-time apply — no-op (поля те же).

Источник: prepare-audit findings (нет inline incident, но pattern из практики).

**Prototype reference**: Не зафиксировано в SKILL.md прототипа. На практике — пользователь не запускал prepare на одну и ту же row дважды.

**Current implementation**: `engine/commands/prepare.js:354` — `byKey` lookup; `runCommit` всегда mutate `app.status` etc.

**Gap**:
- G-20: SKILL Step 9 не имеет «if app.notion_page_id already set → skip 9a/9b». Risk низкий (P-1 filter гарантирует что только notion_page_id="" доходит до batch'а), но **operator-induced rerun** (повторный запуск SKILL на свежем results.json после ручной правки TSV) приведёт к duplicate. **Fix policy**: SKILL.md Step 9 prepend «If app.notion_page_id already set, skip create — record existing id».

---

# Часть 5 — `sync` команда

**Сводный контракт**: bidirectional reconcile между `applications.tsv` и Notion Jobs Pipeline DB. **Default = dry-run**; `--apply` mutate'ит обе стороны.

```
node engine/cli.js sync --profile <id> [--apply] [--no-callout]
```

Поведение:
- **PUSH**: `applications.tsv` → Notion. Создаёт pages для строк с пустым `notion_page_id`.
- **PULL**: Notion → `applications.tsv`. Считывает все pages, обновляет local status / notion_page_id (Notion wins).
- **Callout update**: после mutation — обновить hub Inbox callout block (если configured).

---

### Sy-1 — Push gate

**Intent**: Eligible to push = строка для которой:
1. `notion_page_id === ""` (никогда не пушили).
2. `status ∉ {"Archived", "Inbox"}` (Archived — terminal; Inbox — local-only staging до prepare; не достиг "To Apply").
3. (Opt-in, Stage 16) `key ∈ pushManifest.keys` если manifest присутствует. Manifest — `.stage16/push_manifest.json`, генерируется migration scripts'ом.

Манифест = **fail-closed**: corrupt JSON → throw (не silent allow), missing — gate disabled.

Прототипа этого gate'а не было; в прототипе sync_notion.js **только PULL** (Notion → TSV). Push pages создавался прямо в prepare-mode (Step 12 в `../Job Search/skills/job-pipeline/SKILL.md:201`).

Источник: `../Job Search/skills/job-pipeline/SKILL.md:201` (PUSH в prepare), CLAUDE.md Stage 16 (push_manifest), Stage 13 (engine sync push) + `engine/commands/sync.js:115-165`.

**Prototype reference**: Прототип `sync_notion.js` = **PULL only**. PUSH делалось в prepare через MCP / direct API.

**Current implementation**:
- `engine/commands/sync.js:111-115` — `PUSH_SKIP_STATUSES = new Set(["Archived", "Inbox"])`.
- `engine/commands/sync.js:127-146` — `readPushManifest`.
- `engine/commands/sync.js:157-165` — `planPush(apps, options)`.

**Gap**:
- G-21 (architectural divergence): sync push занимается тем, что прототип делал в prepare. Это **engine improvement** (separation of concerns: SKILL не должен звонить в Notion напрямую → CLI делает push). Но **дубль ответственности**: SKILL Step 9 уже создаёт Notion page, потом sync push повторно ищет orphan'ов. **Fix policy** (Phase 3): SKILL Step 9 → удалить (CL gen + results.json), `sync push` → читает results.json + applications.tsv, делает все Notion writes. Не критично пока — но устранит double-write riski.

---

### Sy-2 — Property mapping (TSV row → Notion page)

**Intent**: Один appToNotionJob mapper (pure function), TSV column → property_map key:

| Notion property (default) | TSV column / source | Type |
|---------------------------|---------------------|------|
| Title | `title` | title |
| Company | resolved Company DB page id (см. Sy-3) | relation (array of 1 page id) |
| Source | `source` | select |
| JobID | `jobId` | rich_text |
| URL | `url` | url |
| Status | `status` | status |
| Key | `key` | rich_text |
| Resume Version | `resume_ver` (canonical archetype gate, см. Sy-4) | select |
| Salary Min | `salary_min` (Number) | number |
| Salary Max | `salary_max` (Number) | number |
| Salary Expectations | derived `"$<min/1000>-<max/1000>K ($<mid/1000>K mid)"` (only when both bounds set) | rich_text |
| Cover Letter | `cl_path` | rich_text |

NOT pushed by sync (live в SKILL/prepare): `Fit Score`, `Notes`, `Date Added`, `Work Format`, `City`, `State`. Их пишет SKILL Step 9.

`property_map` в `profile.notion.property_map` overrides default (per-profile flexibility — Stage 18 wizard может gen'ить subset).

Источник: `engine/commands/sync.js:21-40` (DEFAULT_PROPERTY_MAP) + `64-108` (appToNotionJob).

**Prototype reference**: Прототип не имел formal property_map'а; PUSH делал inline в SKILL.md prepare (Step 12). PULL `sync_notion.js` имел inline property mapping в JS-коде.

**Current implementation**:
- `engine/commands/sync.js:64-108` — `appToNotionJob(app, companyRelationId, canonicalArchetypes)`.
- `engine/core/notion_sync.js:buildProperties` — apply property_map type-by-type.
- Empty-string skip (Stage 16 fix): `buildProperties` пропускает empty url/email/phone (was 400 Notion error).

**Gap**:
- G-22: `Notes`/`Fit Score`/`Date Added`/`Work Format`/`City`/`State` пишутся в SKILL через MCP, не через CLI. Это **double API surface**: один путь для основных полей (CLI), другой для остальных (SKILL). Если property_map поменяется, надо обновить и CLI и SKILL.md. **Fix policy**: после G-21 fix (sync push поглощает SKILL Step 9) — все 18 полей в одном mapper'е.

---

### Sy-3 — Company relation resolver

**Intent**: При push'е заполнять `Company` relation = page id из `companies_db_id`. Если page не существует — создать (`Name` = companyName, `Tier` = `companyTiers[companyName]` если known, `Industry` пустой пока — заполняется отдельным backfill). In-memory cache `Map<companyName, pageId>` per sync-run.

Если `profile.notion.companies_db_id` отсутствует — push продолжается без Company relation (warn).

Источник: CLAUDE.md Stage 13 (`company_resolver.js`), `engine/core/company_resolver.js`.

**Prototype reference**: Прототип = direct Notion API call в SKILL prepare Step 12 (`../Job Search/skills/job-pipeline/SKILL.md:201`). Resolver as separate module — engine improvement.

**Current implementation**:
- `engine/core/company_resolver.js:makeCompanyResolver({client, companiesDbId, companiesDataSourceId, companyTiers, log})` — `resolve(name)` returns page id.
- `engine/commands/sync.js:280-298` — wired in only when `flags.apply && pushPlan.length && companiesDbId`.

**Gap**: None.

---

### Sy-4 — Canonical archetype gate

**Intent**: Перед push'ем валидировать `app.resume_ver ∈ Object.keys(profile.resume_versions.versions)`. Иначе — throw. Защита от **regression** (incident 2026-04-30): mass-migration пушнул 58 garbage select-options на 259 pages, реconstruction потребовала Stage 16 retro-cleanup.

Источник: `engine/commands/sync.js:230-236` + comment `:62-64`. CLAUDE.md Stage 16 incidents.

**Prototype reference**: Прототип не имел такого gate. Resume Version в Notion DB рос «как разрастётся»; постфакт-cleanup не было до Stage 16.

**Current implementation**:
- `engine/commands/sync.js:74-86` — `appToNotionJob` throws if `resume_ver ∉ canonicalArchetypes` (set built from `profile.resumeVersions.versions`).
- Empty set → no gate (e.g. profile без resume_versions).

**Gap**:
- G-23: SKILL Step 7 не валидирует выбранный archetype против profile keys (см. G-18). В результате sync gate ловит ошибку **только** в `--apply` time, после того как Claude уже сгенерил CL и пометил results.json. **Fix policy**: G-18 + G-23 закрываются вместе — добавить enforce'мент в SKILL Step 7.

---

### Sy-5 — Pull (Notion → TSV)

**Intent**: Read all pages из Notion DB, match с local TSV по `key` field (`<source>:<jobId>`) или composite (`source` + `jobId`). Notion wins на:
1. `status` (Notion → local, override TSV).
2. `notion_page_id` (Notion id wins; защищает от lost-id incidents).

Никаких других полей не pull'ится — fit_score, notes etc. остаются TSV-only.

Pull всегда runs (read-only), независимо от `--apply`. Если `--apply` — local TSV mutation.

Источник: `engine/commands/sync.js:167-203` (`reconcilePull`), `../Job Search/sync_notion.js`.

**Prototype reference**: `../Job Search/sync_notion.js` — single-shot pull. `../Job Search/skills/job-pipeline/SKILL.md:215-228` (sync mode).

**Current implementation**:
- `engine/commands/sync.js:167-203` — `reconcilePull(apps, notionPages, propertyMap)`.
- `engine/commands/sync.js:333-355` — pull всегда runs; pull-error на `--apply` after push warns.

**Gap**:
- G-24: Pull не обрабатывает **deletion** (page deleted в Notion → local TSV не trim'ится). Эквивалентно prototype (тот тоже не обрабатывал). Не gap, но spec'ить в RFC.

---

### Sy-6 — Inbox callout update

**Intent**: После `--apply` — обновить hub Inbox callout block с `Inbox: <count> | Updated: <YYYY-MM-DD>`. `inbox_callout_block_id` per-profile в `profile.notion.hub_layout`. `--no-callout` подавляет на этот run.

Источник: `../Job Search/skills/job-pipeline/SKILL.md:111` (scan callout update).

**Prototype reference**: `../Job Search/skills/job-pipeline/SKILL.md:111` (scan), `:204` (prepare callout). Тоже single-line `Inbox: N | Updated: ...`.

**Current implementation**:
- `engine/commands/sync.js:382-405` — `updateCalloutBlock` call на `--apply`.
- 8-status set после Stage 8 — `Inbox` всё ещё считается на string-match `app.status === "Inbox"`. Это **dead code path** для текущих профилей: у Jared/Lilia после Stage 8 `Inbox` нет в status list. Counter всегда выдаст 0.

**Gap**:
- G-25: callout counter logic stale после Stage 8. **Fix policy**: либо переименовать в «To Apply (no notion_page_id)» counter (matches P-1 fresh definition), либо удалить совсем. До Phase 3 — leave as-is (counter показывает 0; не вред).

---

# Часть 6 — Open issues / spec gaps

Сводка всех `Gap` сечок выше (Sessions 1+2), для фиксирования и триажа в Phase 3 (после полного SPEC pass'а).

| Gap ID | Section | Severity | Описание |
|--------|---------|----------|----------|
| G-1 | CC-1.a | Medium | `"To Apply"` имеет двойной смысл (свежая после scan vs готовая к submit). Защищено двумя guard'ами; финальный fix — RFC 012. |
| G-2 | CC-3.1 | Low | ✅ **Closed 2026-05-03**. Slash-title split = filter-time alternative-evaluation одной вакансии (не два record'а). Retro-justification зафиксирован в CC-3.1 Gap. Keep as-is. |
| G-3 | CC-3.4 | Medium | `title_requirelist` нормализатор поддерживает поле, но `filter.matchBlocklists` его не enforce-ит. Adapter'ы делают inline (Greenhouse PM regex и т.п.) — fragmented. Решение: вынести в общий слой или явно отказаться. |
| G-4 | CC-4.2 | Medium | Fuzzy dedup (`company::normalized-title`) — `normalizeCompanyName` есть, но `dedupeAgainst` его не использует. Cross-platform дубли возможны. |
| G-5 | CC-6 | Low | ✅ **Closed 2026-05-03**. Schema v3: `location` добавлена column 7 (после `url`). Auto-upgrade v1/v2 → v3, save() пишет v3. `appendNew` тянет `locations[0]` из NormalizedJob. Validate retro-sweep теперь покрывает `location_blocklist`. Sync push location → Notion property "Location" gated через property_map. Backfill: Jared 2186/2897, Lilia 94/425, бэкапы `.pre-stage-g5`. |
| G-6 | CC-7 | Low | `companies.tsv:profile` колонка — comma-list parser hack. Закрывается RFC 012. |
| G-7 | CC-9 | High | `profile.geo` отсутствует; geo enforcement только в Workday adapter и только через per-target `extra_json`. Jared targets WD без gео-фильтра — потенциальная регрессия 485 Fresenius incident. RFC 013. |
| G-8 | S-5.usajobs | Low | USAJOBS adapter в кодовой базе, но disabled-by-default. Триаж — закрыть BACKLOG-пункт или зафиксировать как long-term disabled. |
| G-9 | S-8 | Trivial | `scan --apply` — noop. Косметический gap. |
| G-10 | CC-12, P-7 | Medium | SKILL Step 2 batch>10 prompt — deviation от prototype-intent. Prototype: deterministic top-30 by fit. Fix policy: убрать prompt, использовать `--batch` flag. |
| G-11 | CC-12, P-5, P-7 | Medium | SKILL Step 6 unknown-tier prompt — deviation. Prototype: tier добавляется в company_tiers до запуска prepare (operator step). Fix policy: `prepare --phase pre` exit 1 + список missing companies. |
| G-12 | P-2 | Low | DX gap: prepare summary не bre­akdown'ит skipped reasons (`company_cap=N1, title_blocklist=N2`). Только `passed/skipped`. Fix: print per-reason counters. |
| G-13 | P-3 | Low | LinkedIn / Indeed / custom careers URLs дохнут на URL-check 100%. Fix policy: либо early-skip на основе `source`, либо выкинуть LinkedIn ingestion из check.js. |
| G-14 | P-4 | Low | JD-cache covers только Greenhouse + Lever. Workday/Ashby/SmartRecruiters/CalCareers/USAJOBS/Indeed/RemoteOK ходят через WebFetch (non-deterministic). Не критично. |
| G-15 | P-5 | Medium | Unknown-tier silent-pass-through → SKILL gate. Prototype intent: fail-fast в pre-фазе. Связан с G-11. |
| G-16 | P-6 | Trivial | `prepare_context.json` schema без version field. Migration impossible. |
| G-17 | P-7 | High | **CL generation paradigm divergence**: prototype = assemble templates from `cover_letter_versions.json`; engine SKILL = fresh generation per job. Engine path тратит больше токенов и теряет batch-consistency. Fix policy: SKILL Step 8 → `load archetype template + fill placeholders + Humanizer pass`. |
| G-18 | P-7 | Medium | Step 7 archetype selection не enforce'ит «pick from `profile.resume_versions.versions` keys». Claude может выдумать несуществующий ключ; ловится только Sy-4 gate в sync push. Fix: validate в Step 7 + early-fail. |
| G-19 | P-8 | Trivial | `decision` enum не валидируется в commit; unknown values silently treated as `"skip"`. |
| G-20 | P-9 | Low | SKILL Step 9 не имеет «if app.notion_page_id already set → skip». Risk низкий, но operator-rerun → duplicate. Fix: prepend skip-guard в SKILL.md. |
| G-21 | Sy-1 | Medium | **Double-write architectural divergence**: SKILL Step 9 + sync push оба создают Notion pages. Prototype: всё в SKILL.md (`prepare` mode). Fix policy: удалить SKILL Step 9 push; sync push поглощает (читает results.json + applications.tsv). |
| G-22 | Sy-2 | Medium | `Notes` / `Fit Score` / `Date Added` / `Work Format` / `City` / `State` пушатся через SKILL/MCP, не через CLI sync. Двойной API surface. Закрывается через G-21 fix. |
| G-23 | Sy-4 | Low | Canonical archetype gate ловит ошибку только в `--apply` time. Связан с G-18. |
| G-24 | Sy-5 | Low | Pull не обрабатывает Notion deletion. Эквивалентно prototype. Не gap, но spec'ить в RFC. |
| G-25 | Sy-6 | Trivial | Inbox callout counter — dead code path после Stage 8 (`Inbox` нет в 8-status set). Counter всегда 0. Fix: переименовать или удалить. |
| G-26 | C-4 | Low | ✅ **Closed 2026-05-03**. LinkedIn ingestion disabled (не было в прототипе, юзер не использовал). `processLinkedIn` short-circuit'ится в `processEmailsLoop` → log-only, TSV row не создаётся. Email всё ещё фетчится для видимости в логах. Re-enable инструкция — в comment block над функцией. |
| G-27 | C-5 | Trivial | Engine добавил classifier.test.js + 3 regression fixes (`/not selected/i`, bare `\binterview\b`, bare `/assessment/`) post-prototype. Engine plus, не gap. Spec обозначает чтобы prototype не reverted. |
| G-28 | C-7 | Trivial | TSV save не атомарен с Notion mutations: Notion 5xx посередине → split-state. Self-healing на rerun. Не fixable cheaply. |
| G-29 | C-8 | Low | `--auto` существует (RFC 005), но не активирован ни для одного профиля. Закрывается activation task'ом в BACKLOG. |
| G-30 | V-2 | Trivial | `>` (validate) vs `>=` (prepare gate) — корректное расхождение, но не задокументировано. Добавить в spec note (этот SPEC покрывает). |
| G-31 | V-3 | Trivial | SSRF guard продублирован между `engine/core/url_check.js` (prepare) и `engine/commands/validate.js`. Намеренно — разные contracts. Не gap. |
| G-32 | V-4 | Trivial | Retro sweep `"To Apply"` (engine) vs `"Inbox"` (prototype) — семантическая parity post-Stage 8. Не gap. |
| G-33 | V-4 | Medium | Retro sweep не проверяет `location_blocklist` — TSV без location колонки (G-5). Закрывается RFC 012. |

---

# Phase 1 Session 1 — Definition of Done

- [x] Структура SPEC и intro (как читать, дисциплина intent ≠ current).
- [x] Cross-cutting часть: CC-1 (statuses), CC-2 (filter rules shape), CC-3 (filter semantics), CC-4 (dedup), CC-5 (profile.json), CC-6 (applications.tsv v2), CC-7 (companies.tsv + jobs.tsv), CC-8 (env-var namespacing), CC-9 (geo enforcement state), CC-10 (auto-sync hook), CC-11 (flavor).
- [x] `scan` команда: S-1 (orchestration), S-2 (modules), S-3 (target list), S-4 (adapter contract), S-5 (per-adapter, 11 adapters), S-6 (dedup), S-7 (TSV append), S-8 (dry-run), S-9 (summary).
- [x] Каждый контракт имеет Intent с источником (RFC / incident / quote / prototype) + Prototype reference + Current implementation + Gap.
- [x] Lilia diff'ы (CC-11 healthcare flavor, S-5.indeed) — domain-justified.
- [x] Список gap'ов сведён в Open issues для Phase 3 triage.

---

# Phase 1 Session 2 — Definition of Done

- [x] CC-12 «Determinism vs interactivity» добавлен — фиксирует контракт: pipeline-команды детерминированы, interactive prompts в SKILL — deviations.
- [x] `prepare` команда: P-1 (fresh definition), P-2 (filter order), P-3 (URL check), P-4 (JD cache), P-5 (salary calc), P-6 (context.json schema), P-7 (SKILL Phase 2, 9 steps with prototype-vs-engine table), P-8 (commit phase), P-9 (idempotency).
- [x] `sync` команда: Sy-1 (push gate), Sy-2 (property mapping), Sy-3 (Company resolver), Sy-4 (canonical archetype gate), Sy-5 (pull), Sy-6 (Inbox callout).
- [x] Каждый контракт имеет Intent с источником (RFC / incident / quote / prototype) + Prototype reference + Current implementation + Gap.
- [x] Архитектурные divergences из prepare-audit зафиксированы как Gaps с явной prototype-as-source-of-truth fix policy: G-10 (batch prompt), G-11 (unknown tier), G-15 (silent pass-through), G-17 (CL generation paradigm), G-21 (double-write SKILL+sync push), G-22 (split property API).
- [x] Lilia-as-fork rule сохранён: prepare/sync секции не имеют Lilia-specific исключений (engine = same path для обоих профилей).
- [x] Open issues таблица расширена G-10…G-25.

---

# Часть 7 — `check` команда

**Сводный контракт**: polling Gmail на ответы по активным applications. **Три режима**:

1. `--prepare` (CLI) — снимок состояния + Gmail-search batches → `check_context.json`. Не ходит в Gmail.
2. **MCP fetch** (Claude) — выполняет search_threads + read_message по batch'ам, пишет `raw_emails.json`.
3. `--apply` / dry-run (CLI) — читает `check_context.json` + `raw_emails.json`, классифицирует, mutate Notion + TSV + logs.

**Дополнительный режим** `--auto` (RFC 005, не из прототипа) — single-process autonomous flow с Gmail OAuth (без MCP), для cron / fly.io. Свежий read состояния с диска на каждом запуске; при exception → fallback notification в Notion ops-page + cron_failures.log.

```
node engine/cli.js check --profile <id> --prepare [--since <ISO>]
node engine/cli.js check --profile <id> [--apply]              # default = dry-run
node engine/cli.js check --profile <id> --auto [--apply] [--since <ISO>]
```

---

### C-1 — Active jobs map

**Intent**: Поставить в watchlist'е только те apps, которые имеют шанс получить email-ответ:
1. `status ∈ {"To Apply", "Applied", "Interview", "Offer"}` (CC-1 active set).
2. `notion_page_id` непустой (нечего обновлять без Notion-page).
3. `companyName` непустой (без company match не сработает).

Map keyed by company → array of `{company, role, status, notion_id, resume_version, key}`. Multi-role matching (одна компания, две вакансии) обрабатывается в C-5.

Источник: `engine/commands/check.js:193-211` + `../Job Search/check_emails.js:159` (`findCompany`).

**Prototype reference**: `../Job Search/check_emails.js:40` (`ACTIVE_STATUSES = ['Applied', 'To Apply', 'Phone Screen', 'Onsite', 'Offer']`) + map-build inline.

**Current implementation**:
- `engine/commands/check.js:61-67` — `ACTIVE_STATUSES = {"To Apply", "Applied", "Interview", "Offer"}`, `SKIP_STATUSES = {"Rejected", "Closed", "Archived", "No Response"}`.
- `engine/commands/check.js:193-211` — `buildActiveJobsMap`.

**Gap**:
- Расхождение со статусами prototype (`Phone Screen`, `Onsite`) — это **legitimate divergence** post-Stage 8 (CC-1). Не gap.

---

### C-2 — Cursor epoch

**Intent**: Gmail search window = `after:<epoch>`. Источник epoch (по приоритету):
1. `--since <ISO>` если передан (clamped to now-30d).
2. `processed_messages.json:last_check` (clamped to now-30d).
3. По умолчанию now-30d (first run).

**Hard cap 30 days** — даже если `last_check` старше, не возвращаемся дальше (Gmail rate-limit + token cost).

`last_check` обновляется ТОЛЬКО при `--apply` (включая случай 0 emails — bump cursor чтобы не остаться застрявшим). dry-run не bump'ит.

Источник: `engine/core/email_state.js:computeCursorEpoch`, `../Job Search/check_emails.js:42` (`MAX_DAYS=30`).

**Prototype reference**: `../Job Search/check_emails.js:42` + step 1 в `../Job Search/skills/job-pipeline/SKILL_check.md`.

**Current implementation**:
- `engine/core/email_state.js:computeCursorEpoch({lastCheck, sinceIso, now})`.
- `engine/commands/check.js:255-261` (prepare) и `engine/commands/check.js:856-862` (auto).
- bump cursor on 0-emails apply: `engine/commands/check.js:753-757`, `:907-910`.

**Gap**: None.

---

### C-3 — Gmail batches

**Intent**: Один batch = один Gmail-query. Структура:

1. **Company batches** — N батчей по 10 компаний:
```
(from:(comp1 OR comp2 OR ... OR comp10) OR subject:(comp1 OR ...)) after:<epoch> -from:me
```
companyTokens строит токен из имени (drops legal suffixes: Inc, LLC, Ltd; dedupes по first-token).

2. **LinkedIn batch** (fixed):
```
from:jobalerts-noreply@linkedin.com after:<epoch>
```

3. **Recruiter outreach batch** (fixed): subject pattern с recruiter-keywords (`Requirement for`, `Immediate need`, …) с exclusions для ATS senders (`-from:linkedin.com -from:greenhouse -from:lever …`).

Источник: `../Job Search/check_emails.js:152-218` (companyTokens + buildBatches), `../Job Search/skills/job-pipeline/SKILL.md:425-454`.

**Prototype reference**: `../Job Search/check_emails.js:152` + skill step 3.

**Current implementation**:
- `engine/core/email_matcher.js:companyTokens` — token extraction.
- `engine/commands/check.js:215-244` — `buildBatches(companies, searchWindow)`.
- `BATCH_SIZE = 10` (`engine/commands/check.js:69`).

**Gap**: None.

---

### C-4 — Email loop branches (5-way switch)

**Intent**: Per-email decision tree (order matters):

| Order | Branch | Trigger | Side-effect |
|-------|--------|---------|-------------|
| 1 | **LinkedIn alert** | `from contains jobalerts-noreply@linkedin.com` | `processLinkedIn` → может создать новую `"To Apply"` row (через level/location/dedup гваards) |
| 2 | **Other job-alert digest** | `isJobAlert(from, subject)` (Indeed, ZipRecruiter, Glassdoor, "+ N more new jobs") | SKIP. Их JD body содержит false-positive keywords для классификатора. |
| 3 | **Non-pipeline sender** | `isNonPipelineSender(from)` (banks, utilities, insurance) | SKIP. Transactional language overlap с ACK/INFO. |
| 4 | **Recruiter outreach** | `!isATS(from) && matchesRecruiterSubject(subject)` | `processRecruiter` → if client-name extractable → новая `"To Apply"` row, else → `recruiter_leads.md` only. |
| 5 | **Pipeline default** | otherwise | `processPipeline` — classify + match + plan action |

Order = battle-tested. Branches 2-3 добавлены post-Lilia incident (2026-05-02): Indeed digest emails embed JD body text containing «interview», «availability» → ложные INTERVIEW_INVITE.

Источник: `engine/commands/check.js:514-573` (`processEmailsLoop`). Lilia incident → `engine/core/classifier.js:44-50` comment + `email_filters.js:isJobAlert`.

**Prototype reference**: `../Job Search/check_emails.js:300-440` (single processEmail с inline branches).

**Current implementation**:
- `engine/commands/check.js:309-353` — LinkedIn branch.
- `engine/commands/check.js:355-416` — Recruiter branch.
- `engine/commands/check.js:418-510` — Pipeline branch.
- `engine/commands/check.js:514-573` — `processEmailsLoop` with order.

**Gap**:
- G-26: LinkedIn branch создаёт `"To Apply"` rows с `url=""` — это и есть G-13 root cause (later prepare URL-check 100% dies). Не gap самого check'а; cross-cuts с prepare.

---

### C-5 — Classifier

**Intent**: Pure rule-based regex classifier. Order: `REJECTION > INTERVIEW_INVITE > INFO_REQUEST > ACKNOWLEDGMENT > OTHER`. First match wins. Type → action (см. C-6).

**Prototype-parity** (engine `engine/core/classifier.js` ported from `../Job Search/check_emails.js:114-145`).

Engine исправил **3 false-positive issues** vs прототипа (regression tests в classifier.test.js):
1. `/not selected/i` removed (был вшит в ATS boilerplate "If you are not selected, keep an eye on our jobs page").
2. INTERVIEW_INVITE bare `\binterview\b` / `\bavailability\b` removed → требуют intent-context (`schedule (an?) interview`, `your interview (is|with|on)`, `share your availability`).
3. INFO_REQUEST bare `/assessment/`, `/questionnaire/` removed → требуют action-context (`complete the assessment`, `take-home assignment`).

Источник: `engine/core/classifier.js:11-97` + comment блок `:23-28, 44-50, 69-72`.

**Prototype reference**: `../Job Search/check_emails.js:114-145`.

**Current implementation**:
- `engine/core/classifier.js:11-97` — `PATTERNS`.
- `engine/core/classifier.js:101-112` — `classify({subject, body})`.

**Gap**:
- G-27 (engine improvement): эти three regression fixes делались в прототипе **inline**, без regression-tests. Engine добавил classifier.test.js. Это **plus**, не gap. Spec обозначить чтобы в будущем prototype не reverted.

---

### C-6 — Pipeline match + actions

**Intent**: На pipeline-branch'е email мапится на `(company, role)`-tuple через:
1. **`findCompany`** — extracts company from `from` domain / sender name / body, lookup в activeJobsMap (with `company_aliases` per profile).
2. **`findRole`** — search в active jobs данной компании. Strategies:
   - exact role-title substring в subject / body → `HIGH`
   - partial keyword overlap → `MEDIUM`
   - one-job-only → auto-`HIGH`
   - else → `LOW`

Action mapping (post-Stage 8 8-status set):

| Type | Confidence | Action |
|------|-----------|--------|
| REJECTION + active job | HIGH/MEDIUM | `Status → Rejected` + comment (`❌ Subject: ...`) |
| REJECTION + already in SKIP_STATUSES | any | no-op |
| INTERVIEW_INVITE + active job | HIGH/MEDIUM | `Status → Interview` + comment (`🔔 Subject: ...`) |
| INFO_REQUEST | HIGH/MEDIUM | comment_only (`📋 Subject: ...`) — no status change |
| ACKNOWLEDGMENT / OTHER | any | log only, no-op |
| any | LOW | log only, no-op |

Источник: `engine/commands/check.js:418-510` + `engine/core/email_matcher.js:findCompany/findRole`.

**Prototype reference**: `../Job Search/skills/job-pipeline/SKILL.md:467-503` (Step 5+6) + `../Job Search/check_emails.js:159-280`. **Difference**: prototype `INTERVIEW_INVITE → "Phone Screen"` (Notion option `Phone Screen` exists). Engine: `→ "Interview"` (Stage 8 unification, only `Interview` exists in new DBs).

**Current implementation**:
- `engine/commands/check.js:449-487` — REJECTION / INTERVIEW_INVITE branches.
- `engine/commands/check.js:491-501` — INFO_REQUEST.
- `engine/commands/check.js:60-67` — `INTERVIEW_INVITE → "Interview"` (CLAUDE.md Stage 8).

**Gap**: None (prototype `Phone Screen → Interview` = legitimate Stage 8 divergence).

---

### C-7 — Mutation phase (`--apply`)

**Intent**: Только под `--apply` (default = dry-run): atomic-ish apply per email pipeline:
1. Notion: для каждого `action` — `updatePageStatus` + `addPageComment`. Errors logged + counted, не блокируют остальные.
2. TSV: merge `newInboxRows` (LinkedIn + recruiter) + status updates → save через `applications_tsv.save`.
3. Logs:
   - `rejection_log.md` — append per-rejection (date / company / role / level / archetype / wasApplied).
   - `recruiter_leads.md` — append per-recruiter-no-client.
   - `email_check_log.md` — append per-run summary (logRows + actions + stats).
4. `processed_messages.json` — append per-message records `{id, date, company, type}`, prune >30d.

Notion errors **не abort'ят** loop — каждый `action` оборачивается try/catch. Final exit code = `notionErrors > 0 ? 1 : 0`.

Источник: `engine/commands/check.js:575-666` (`applyMutations`), `engine/core/email_logs.js`, `engine/core/email_state.js`.

**Prototype reference**: `../Job Search/check_emails.js:550-597` (apply phase) + `../Job Search/skills/job-pipeline/SKILL.md:480-543` (Notion + logs steps).

**Current implementation**:
- `engine/commands/check.js:601-622` — Notion mutations.
- `engine/commands/check.js:624-635` — TSV merge.
- `engine/commands/check.js:637-664` — logs + processed.

**Gap**:
- G-28 (Trivial): TSV save не атомарна с Notion mutations: если Notion 5xx посередине — половина status'ов уже обновлена в Notion, TSV mirror'ит всё. На rerun — `applied: ${X} - notionErrors`, не блокер. Не fixable cheaply.

---

### C-8 — Autonomous mode (`--auto`)

**Intent**: Single-process flow для cron / fly.io: prepare-логика + Gmail OAuth fetch + apply, без MCP-промежутка. Свежий disk-read на каждый запуск (no stale snapshot).

Pre-conditions:
- `<PROFILE>_GMAIL_*` env vars (RFC 005).
- `notion.cron_ops_page_id` + `notion.cron_ops_user_id` (per-profile, для failure notifications).

Failure path: любой uncaught throw в `runAutoBody` → `notifyFailure`:
1. Append to `cron_failures.log` on disk (durable).
2. Best-effort: post Notion comment to `cron_ops_page_id` с @mention `cron_ops_user_id` (fallback `notion.user_id`).
3. Notification failure swallowed — никогда не маскирует original error.

Источник: RFC 005 + `engine/commands/check.js:807-947` (`runAuto` + `runAutoBody` + `notifyFailure`).

**Prototype reference**: Прототип `--auto` режима **не имел**. Это engine improvement — closes BACKLOG item «Gmail cron / OAuth-based check, чтобы письма проверялись пока юзер спит» из CLAUDE.md.

**Current implementation**: `engine/commands/check.js:807-947`.

**Gap**:
- G-29 (engine plus): `--auto` существует, но **не активирован** ни для одного профиля (cron не настроен per CLAUDE.md). Это work-in-progress, не gap кода. Закрывается activation task'ом в BACKLOG.

---

### C-9 — Logs schema (rejection_log.md, recruiter_leads.md, email_check_log.md)

**Intent**: Все три log'а — append-only markdown, человеко-читаемые, с metrics-секцией. Schema:

- `rejection_log.md` — `## Rejections` table (date, company, role, level, archetype, prevApplied) + `## Metrics` (Total Applied, Rejected count/%, Pending, Interview).
- `recruiter_leads.md` — `## Leads` table (date, agency, role, contact, subject) + simple total counter.
- `email_check_log.md` — per-run `## Check: <YYYY-MM-DD HH:MM>` block with table of messageIds + classification + action.

Метрики в `rejection_log.md` recompute'ятся при каждом append (читает full TSV state).

Источник: `engine/core/email_logs.js`, `../Job Search/skills/job-pipeline/SKILL.md:505-535`.

**Prototype reference**: `../Job Search/skills/job-pipeline/SKILL.md:505-543`.

**Current implementation**: `engine/core/email_logs.js` (functions: `appendRejectionLog`, `appendRecruiterLeads`, `appendCheckLog`, `appendFailureLog`, `buildSummary`).

**Gap**: None.

---

# Часть 8 — `validate` команда

**Сводный контракт**: pre-flight checks профиля. Read-only by default; mutating только под `--apply` (retro sweep). Exit 0 если clean, 1 при любой проблеме.

```
node engine/cli.js validate --profile <id> [--dry-run] [--apply]
```

4 проверки в порядке: TSV hygiene → company_cap → URL liveness → retro blocklist sweep.

---

### V-1 — TSV hygiene

**Intent**: Парсинг `applications.tsv` (per-profile) и `data/jobs.tsv` (shared) без ошибок. Строгая schema-валидация (header line + row count + no malformed rows). На parse error — `issues++`, продолжаем остальные checks (best-effort).

Источник: `engine/commands/validate.js:202-217`, Stage 13 v2 schema (CC-6).

**Prototype reference**: Прототип не имел dedicated TSV-hygiene check. `validate_inbox.js` читал TSV inline, parse error приводил к hard crash.

**Current implementation**: `engine/commands/validate.js:202-217`.

**Gap**: None.

---

### V-2 — `company_cap` enforcement check

**Intent**: Read-only verification: для каждой компании посчитать active rows (CC-1 active set), сравнить с `filter_rules.company_cap.max_active` (+ per-company `overrides`). Violation = `count > limit`. Печатает `count > limit` per company.

Engine использует **`>`**, не `>=` (vs prepare-time gate, который `>=`). Идея: validate отслеживает **превышение**, prepare gate **предотвращает дальнейшие**.

Источник: `engine/commands/validate.js:164-181` + CC-3.5.

**Prototype reference**: `../Job Search/skills/job-pipeline/SKILL.md:46-50` Company Cap (но enforce'ится в SKILL.md prepare step, не отдельно). Prototype `validate_pipeline.js` имел свой cap-check; engine consolidate'ит сюда.

**Current implementation**: `engine/commands/validate.js:164-181` (`checkCompanyCap`).

**Gap**:
- G-30 (Trivial): `>` vs prepare-time `>=` — concrete inequality difference. Hypothetical edge: company с `max_active=3` и ровно 3 active → validate ok, prepare skip. Корректно. Но не задокументировано — добавить в spec.

---

### V-3 — URL liveness on active applications

**Intent**: HEAD-ping каждый `url` для apps в `ACTIVE_STATUSES`. **Differences vs prepare URL-check (P-3)**:

| | prepare | validate |
|---|---------|----------|
| Method | HEAD + GET fallback | HEAD-only |
| Redirect | follows | `redirect: "manual"` (status 0 / opaque) |
| 405/501 | retry GET | report indeterminate (`ok=true, indeterminate=true`) |
| SSRF | guard | guard (same) |
| Cap | unlimited | `urlCap` (default 500) |
| `--dry-run` | always runs | skips |

**Why HEAD-only here**: validate пингует **существующие** application URLs (post-apply, real candidate-facing). GET может trigger mutating ATS endpoint (e.g. "view job" counter, "apply now"). Prepare пингует **fresh** URLs до apply, риск меньше.

SSRF guard: blocks loopback / link-local / private IPv4+IPv6 / `localhost` (см. `isSafeLivenessUrl`).

Источник: `engine/commands/validate.js:76-160` + comment `:9-14`.

**Prototype reference**: Прототип не имел SSRF-hardened liveness. `check_urls.js` использовался только в SKILL prepare step (см. `../Job Search/skills/job-pipeline/SKILL.md:157`). Validate-time URL liveness — engine improvement.

**Current implementation**:
- `engine/commands/validate.js:76-106` — `isSafeLivenessUrl`.
- `engine/commands/validate.js:110-138` — `pingUrl` (HEAD-only).
- `engine/commands/validate.js:140-160` — `pingAll(concurrency=8)`.

**Gap**:
- G-31 (Trivial): Дублирование SSRF guard и url_check / pingUrl логики между `engine/core/url_check.js` (prepare) и `engine/commands/validate.js` (validate). Намеренное (разные contracts) — **не gap**. Но добавить spec note.

---

### V-4 — Retro blocklist sweep

**Intent**: Re-applies title + company blocklists to existing `"To Apply"` rows. Catches case: новый pattern в `filter_rules.json` после того как старые rows уже легли в pipeline.

`location_blocklist` **не** проверяется здесь — TSV row не имеет `location` колонки (CC-6 schema, G-5). Location blocklist applies at SCAN time only (CC-3.6).

Default = report (issues++); `--apply` = mutate (`status="Archived"`, `updatedAt=now`).

Только `RETRO_SWEEP_STATUSES = {"To Apply"}` сметается. Applied / Interview / Offer не трогаются (post-apply state — оставляем).

Источник: CLAUDE.md Stage 15 (filter parity), `engine/commands/validate.js:280-324`, `../Job Search/validate_inbox.js`.

**Prototype reference**: `../Job Search/validate_inbox.js` (post-scan safety net). Engine port + 8-status adaptation.

**Current implementation**: `engine/commands/validate.js:280-324` + `engine/core/filter.js:matchBlocklists`.

**Gap**:
- G-32: Engine retro-sweep **только** "To Apply" (status), prototype validate_inbox.js **только** "Inbox" (status). Это семантическая parity (Inbox ≡ "To Apply pre-prepare" в Stage 8 model). Не gap.
- G-33 (cross-cut с G-5): Engine не может проверить `location_blocklist` retro — TSV без location колонки. Prototype TSV тоже без location, но `validate_inbox.js` использовал `location_blocklist` через **scan_summary.json** (last-scan-snapshot). Engine не имеет такого snapshot'а. Закрывается RFC 012 (location colum в TSV).

---

### V-5 — Exit code

**Intent**: Exit code = `issues > 0 ? 1 : 0`. Issues counted: TSV parse errors + cap violations + dead URLs + blocked-by-SSRF URLs + retro-sweep matches (only когда `!--apply`; под `--apply` matches применяются и не считаются).

Источник: `engine/commands/validate.js:326-332`.

**Prototype reference**: `../Job Search/validate_inbox.js:` — exit 0 if clean, 1 if applied any fix.

**Current implementation**: `engine/commands/validate.js:326-332`.

**Gap**: None.

---

# Phase 1 Session 3 — Definition of Done

- [x] `check` команда: C-1 (active jobs map), C-2 (cursor epoch + 30d cap), C-3 (Gmail batches: company×N + LinkedIn + recruiter), C-4 (5-way email loop branches), C-5 (classifier + 3 regression fixes vs prototype), C-6 (pipeline match + actions, Stage 8 status mapping), C-7 (mutation phase + Notion error tolerance), C-8 (autonomous mode RFC 005), C-9 (logs schema).
- [x] `validate` команда: V-1 (TSV hygiene), V-2 (company_cap with `>` vs prepare's `>=`), V-3 (HEAD-only URL liveness + SSRF guard, contrasted with prepare's HEAD+GET), V-4 (retro blocklist sweep with location-omission rationale), V-5 (exit code).
- [x] Каждый контракт имеет Intent с источником + Prototype reference + Current implementation + Gap.
- [x] Stage 8 status unification зафиксирована (C-1 ACTIVE_STATUSES, C-6 INTERVIEW_INVITE→Interview, V-4 retro sweep "To Apply").
- [x] Engine improvements vs prototype выделены: classifier regression-tests (G-27), `--auto` mode (C-8 / G-29), failure notification (C-8), HEAD-only validate liveness (V-3).
- [x] Open issues таблица расширена G-26…G-33.

---

# Phase 1 SPEC — Final summary

| Session | Часть | Контракты | Gap'ы |
|---------|-------|-----------|-------|
| 1 | 1 (cross-cutting) + 2 (scan) | CC-1…CC-11, S-1…S-9 | G-1…G-9 |
| 2 | 3 (CC additions) + 4 (prepare) + 5 (sync) | CC-12, P-1…P-9, Sy-1…Sy-6 | G-10…G-25 |
| 3 | 7 (check) + 8 (validate) | C-1…C-9, V-1…V-5 | G-26…G-33 |

**Итого**: 12 cross-cutting + 9 scan + 9 prepare + 6 sync + 9 check + 5 validate = **50 контрактов**, **33 gap'а** в Open issues для Phase 3 triage.

**Архитектурные divergences vs prototype** (для приоритезации в Phase 3):
- **High**: G-7 geo enforcement, G-17 CL generation paradigm.
- **Medium**: G-1 status double-meaning, G-3 title_requirelist fragmentation, G-4 fuzzy dedup unused, G-10/G-11 SKILL interactive prompts, G-15 unknown-tier silent pass-through, G-18 archetype selection, G-21 double-write SKILL+sync, G-22 split property API, G-33 location_blocklist retro.

**Engine improvements vs prototype** (preserve, не reverted в Phase 3): G-2 slash-title split, G-9 (cosmetic), G-27 classifier regression tests, G-29 `--auto` mode, V-1 TSV hygiene check, V-3 HEAD-only liveness, C-8 failure notification.

---

**Следующий этап (Phase 2)**: audit pass — re-read SPEC vs codebase end-to-end, заполнить или скорректировать gap'ы. Никаких fixes в Phase 2.

**Phase 3** (после Phase 2): triage по prototype-as-source-of-truth policy + comparative head-to-head runs (`scan` / `validate` / `prepare --phase pre` / `sync` PULL) на одинаковом snapshot'е. Write-side pipeline (SKILL prepare phase, `sync` PUSH, `check`) сравнивается по логам ранее проведённых запусков, не вживую.

