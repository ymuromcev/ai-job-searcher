# RFC 022 — `prepare --phase commit`: atomic per-row Notion push

**Status**: accepted
**Related**: [BL-23](../private/backlog/BL-23.md), [RFC 014](014-status-split-new-vs-toapply.md), [RFC 019](019-cl-layout-md-pdf-split.md)
**Created**: 2026-05-11
**Accepted**: 2026-05-11 — user approved option A (per-row Notion fail → row stays Inbox silently, batch continues; next run picks up)

## Problem

Сегодня `prepare` для каждой вакансии делает Notion-страницу **раньше**,
чем PDF cover letter лежит на диске. По шагам в `skills/job-pipeline/SKILL.md`:

1. **Step 9** — SKILL вызывает Notion MCP, создаёт страницу в Jobs
   Pipeline DB. В поле `Cover Letter` пишет имя PDF (`<clKey>.pdf`),
   но самого PDF ещё нет.
2. **Step 10** — SKILL пишет `results.json` со всеми `to_apply` и
   полученным `notionPageId`.
3. **Step 11** — `prepare --phase commit` (engine) читает `results.json`,
   обновляет TSV, и **только тут** генерит сам PDF на диск.

Между шагами 1 и 3 в Notion **уже висит** страница со ссылкой на
несуществующий файл. На практике юзер открывает Notion, видит «10 готовых
к подаче вакансий», тыкает в первую — и не находит PDF, потому что
engine ещё не доехал до commit. Получается каша из «готовых» и «не
готовых» вакансий, неотличимых визуально.

Симптомы:
- В Notion вакансии появляются раньше PDF.
- Если SKILL крашнется между Step 9 и Step 10 — страница в Notion есть,
  TSV не обновлён → row остаётся `Inbox`, но Notion видит её как «To Apply»
  (sync такое не реконсилит, потому что match по `key`).
- Если engine крашнется в commit — страница уже есть, PDF ещё нет → юзер
  видит «битую» вакансию в Notion.

## Root cause

Notion-page-creation **владеет SKILL**, а PDF-generation **владеет engine**.
Два процесса, два IO-сайдэффекта, нет atomicity. Step 9 был так
устроен исторически, потому что SKILL уже сидит внутри Claude-сессии с
Notion MCP — проще было «дотянуться» оттуда, чем учить engine ходить
в Notion. Но с RFC 019 (engine пишет PDF/MD) engine **уже** обзавёлся
правильным местом для всех side effects одной вакансии — `runCommit`.

Заодно: с 2026-05-04 (commit `4f85ed2`) sync **pull-only**. CLAUDE.md
прямо говорит «New Notion pages are created exclusively by `prepare`'s
commit phase» — но это аспирация, не реальность. Этот RFC закрывает gap.

## Decision

**Step 9 переезжает из SKILL в engine `runCommit`.** На каждый
`decision: "to_apply"` row engine делает атомарный per-row проход:

```
PDF + MD на диск  →  Notion page  →  TSV mutation (status, notion_page_id, …)
```

Если любой шаг провалился — row остаётся `Inbox`, без `notion_page_id`,
без `cl_key`/`resume_ver`. Следующий run `prepare` подберёт row снова
(он попадает в `filterAlreadyEvaluated` с `fit_score=Strong/Medium`,
но без `notion_page_id` → переоценивается заново; см. §Idempotency).

В Notion **никогда** не появляется страница с PDF-именем, которого нет
на диске. Точка.

## User-level образ результата

Согласован в BL-23, 2026-05-11. Воспроизведён здесь как контракт:

- `/job-pipeline prepare` делает fit-scoring + CL gen как сейчас
  (качество не меняется).
- В commit-фазе engine **атомарно per-row**: PDF на диск → Notion-page
  → TSV update.
- Если PDF упал — Notion-page не создаётся, TSV остаётся `Inbox`.
- Если Notion упал — PDF на диске, TSV остаётся `Inbox`.
- Idempotency: row с непустым `notion_page_id` пропускается.
- В Notion видны ТОЛЬКО полностью готовые вакансии.

## Options considered

**A. Поменять порядок шагов в SKILL** — Step 9 ↔ Step 11. SKILL сначала
просит engine сгенерить PDF, потом сам делает Notion-page.

Отвергнуто: всё равно два процесса, всё равно нет atomicity. Если
engine commit упал между PDF-write и SKILL-call — PDF есть, страницы
нет, TSV не обновлён. Status quo в зеркале.

**B. Перенести Step 9 в engine, выкинуть из SKILL** ✅ выбрано

Engine получает прямой `@notionhq/client` (он уже есть в репо —
`notion_sync.createJobPage`, `company_resolver.makeCompanyResolver`).
Всё IO одной вакансии в одной транзакции, в одном процессе.

- **Плюс**: настоящая per-row atomicity без двухфазного commit'а.
- **Плюс**: SKILL **меньше** — Step 9 + Step 9.0 skip-guard уходят
  целиком (~50 строк инструкций).
- **Плюс**: results.json меньше — `notionPageId` больше не передаётся.
- **Плюс**: engine уже умеет всё нужное (см. §Reuse).
- **Минус**: engine трогает Notion в `prepare` (раньше только `sync` и
  `check` это делали) — расширяет surface area. Mitigated: используем
  уже существующие helpers, не пишем новый код.

**C. Двухфазный commit (write-ahead log + rollback)** — отвергнуто как
overengineering. Distributed transactions нам не нужны: «failed → next
run» уже даёт правильную семантику.

## Reuse — что engine уже умеет

Ничего нового писать не нужно. Достаточно склеить существующие
кусочки:

| Что нужно                       | Где это есть                                       |
|---------------------------------|----------------------------------------------------|
| `Client` factory                | `engine/core/notion_sync.js → makeClient`          |
| Поле property map               | `engine/commands/sync.js → DEFAULT_PROPERTY_MAP`   |
| Create job page                 | `engine/core/notion_sync.js → createJobPage`       |
| Company lookup-or-create + tier | `engine/core/company_resolver.js → makeCompanyResolver` |
| Resolve data_source_id          | `engine/core/notion_sync.js → resolveDataSourceId` |
| Property type conversion        | `engine/core/notion_sync.js → buildProperties`     |
| Token loading                   | `engine/core/profile_loader.js → loadSecrets`      |

Единственное чего нет — **per-profile DEFAULT_PROPERTY_MAP exporter**.
Сейчас `DEFAULT_PROPERTY_MAP` приватный в `sync.js`. Поднимаем его в
`engine/core/notion_sync.js` и реиспользуем из обоих команд. Это
сам по себе sane refactor (один источник правды для shape Jobs DB).

## Scope

### 1. Поднять `DEFAULT_PROPERTY_MAP` в `engine/core/notion_sync.js`

Переезд констант + экспорт. `commands/sync.js` импортирует оттуда
вместо локальной копии. Никаких изменений в shape карты. Делается
одним commit'ом перед основной работой, чтобы основной diff не
тонул в boilerplate-перемещениях.

### 2. Новый module `engine/core/notion_job_page.js`

Тонкий orchestrator: получает «всё что нужно для одной to_apply row»
и пушит в Notion. Pure-ish (берёт client, не лазит в env / диск).

```js
// engine/core/notion_job_page.js
async function pushJobPage({
  client,
  jobsDbId,
  propertyMap,
  companyResolver,        // makeCompanyResolver instance, см. §3
  jobFields,              // см. §4 — все поля для buildProperties
}) {
  const companyPageId = await companyResolver.resolve(jobFields.companyName);
  const job = { ...jobFields, companyRelation: companyPageId ? [companyPageId] : null };
  const page = await createJobPage(client, jobsDbId, job, propertyMap);
  return { pageId: page.id };
}
```

Тестируется через DI-моки `client` + `companyResolver`. Никакого fs,
никакого процесса.

### 3. Изменения в `engine/commands/prepare.js → runCommit`

Между текущим CL-file-write loop (lines 1413–1503) и `saveApplications`
call (line 1529) — вставляется **Notion-push pass**.

Высокоуровневый pseudocode:

```js
// 1. Build notion client + resolvers ONCE per commit run
const secrets = deps.loadSecrets(profileId, env);
const token = secrets[`${profileId.toUpperCase()}_NOTION_TOKEN`];
if (!token) {
  stderr("warn: NOTION_TOKEN missing — skipping Notion push, rows stay Inbox");
  return saveAndExit();
}
const client = deps.makeNotionClient(token);
const jobsDbId = profile.notion.jobs_pipeline_db_id;
const companiesDbId = profile.notion.companies_db_id;
const propertyMap = profile.notion.property_map || DEFAULT_PROPERTY_MAP;
const companiesDataSourceId = await deps.resolveDataSourceId(client, companiesDbId);
const resolver = deps.makeCompanyResolver({
  client, companiesDbId, companiesDataSourceId,
  companyTiers: { ...(profile.company_tiers || {}), ...tierUpdates },
  log: stdout,
});

// 2. Per-row push (only rows that mutated to "To Apply" in the in-memory pass)
const pushStats = { created: 0, skipped: 0, failed: 0 };
for (const r of results) {
  if (r.decision !== "to_apply") continue;
  const app = byKey[r.key];
  if (!app) continue;
  // Idempotency: row already has a page (legacy or prior failed run carried
  // notion_page_id from SKILL). Skip.
  if (app.notion_page_id) {
    pushStats.skipped++;
    continue;
  }
  // PDF must exist on disk — otherwise the Cover Letter field would point
  // at a missing file. clResults pass writes the PDF; if that row failed
  // (PDF not on disk), we must NOT push.
  if (r.clKey) {
    const slug = deps.slugifyCompany(app.companyName);
    const pdfAbs = path.join(profileRoot, `cover_letters/${slug}/${r.clKey}.pdf`);
    if (!deps.fileExists(pdfAbs)) {
      stderr(`warn: skipping Notion push for ${r.key} — PDF missing at ${pdfAbs}`);
      // Revert the in-memory To Apply flip — this row stays Inbox.
      app.status = "Inbox";
      app.cl_key = ""; app.resume_ver = ""; app.cl_path = "";
      pushStats.failed++;
      continue;
    }
  }
  // Build the job payload for Notion. See §4 for field origins.
  const jobFields = buildJobFieldsForNotion({ app, r, prepareContext, profile, now });
  try {
    const { pageId } = await deps.pushJobPage({
      client, jobsDbId, propertyMap, companyResolver: resolver, jobFields,
    });
    app.notion_page_id = pageId;
    pushStats.created++;
  } catch (err) {
    stderr(`warn: Notion push failed for ${r.key}: ${err.message}`);
    // Atomic rollback in-memory: this row never reached "To Apply".
    app.status = "Inbox";
    app.cl_key = ""; app.resume_ver = ""; app.cl_path = "";
    pushStats.failed++;
  }
}
stdout(`notion: ${pushStats.created} created, ${pushStats.skipped} skipped (already pushed), ${pushStats.failed} failed`);

// 3. saveApplications — same as today
deps.saveApplications(applicationsPath, apps);
```

`--dry-run` semantics: print «would push N pages», don't call Notion,
don't mutate `app.notion_page_id`. Status flips to "To Apply" happen
in-memory (as today), but the rollback path is dry-run aware (no PDF
check, no Notion call → no rollback needed).

### 4. Источники полей для `buildJobFieldsForNotion`

Per Step 9 schema (SKILL.md:389–411), Notion-page нужны:

| Notion field            | Origin in engine                                     |
|-------------------------|------------------------------------------------------|
| Title                   | `app.jobTitle`                                       |
| Company (relation)      | resolver.resolve(`app.companyName`)                  |
| Status                  | constant `"To Apply"`                                |
| Fit Score               | `r.fitScore`                                         |
| URL                     | `app.url`                                            |
| Source                  | `app.source`                                         |
| Date Added              | `now.slice(0,10)` (YYYY-MM-DD)                       |
| Work Format             | `prepareContext.batch[k].workFormat` or `app.work_format` |
| City                    | `prepareContext.batch[k].city`                       |
| State                   | `prepareContext.batch[k].state`                      |
| Notes                   | `r.fitRationale`                                     |
| Salary Expectations     | `formatSalaryDisplay(r.salaryMin, r.salaryMax)` †    |
| Salary Min              | `r.salaryMin`                                        |
| Salary Max              | `r.salaryMax`                                        |
| Cover Letter            | `${r.clKey}.pdf`                                     |
| Resume Version          | `r.resumeVer`                                        |
| Schedule (profile-gated)| `prepareContext.batch[k].schedule` if map declares   |
| Requirements (profile-gated) | `prepareContext.batch[k].requirements` if map declares |

† `formatSalaryDisplay` — небольшая чистая хелпер-функция, формат
`"$140-190K ($165K mid)"`. Сейчас этот display-string собирал SKILL в
Step 9; перенесём в `engine/core/salary_format.js` (или в существующий
`engine/core/jd_extractor.js`).

Engine читает `prepareContext` из `profiles/<id>/prepare_context.json`
(он уже там лежит после `--phase pre`; см. `runCommit` сосед — `runPre`
пишет его на line 671). Match по `key` (Step `--phase pre` гарантирует
1-to-1 batch ↔ TSV rows). Если `prepare_context.json` отсутствует или
не содержит ключа — fallback: пушим только базовые поля из TSV, schedule
и requirements opt-out. Это случается, когда commit запускается на
старом results.json без актуального prepare_context (бывает у юзера
при многодневном цикле); тогда хуже всего — пара полей в Notion пустые,
не catastrophe.

### 5. Изменения в `skills/job-pipeline/SKILL.md`

- **Удалить Step 9** целиком (lines 379–414, ~36 строк).
- **Удалить Step 9.0** skip-guard.
- **Step 10 (results.json)** — убрать `notionPageId` из `to_apply`
  entry shape. Movement note: «`notionPageId` removed — engine creates
  the Notion page in commit phase, see RFC 022». Если SKILL легаси
  всё ещё передаёт `notionPageId` — engine принимает его как hint
  (idempotency, skip create), но новый SKILL не должен его слать.
- **Step 11 (commit phase)** — добавить bullet: «engine creates the
  Notion page atomically per row: PDF → page → TSV. Inbox rows whose
  Notion push fails stay Inbox; next run will retry.»
- **Guard rails / Notion Field Completeness** — переписать на engine-side
  contract, оставить минимум для SKILL (его задача — только
  `clParagraphs`, `fitScore`, `fitRationale`, `resumeVer`).

Sub-bullet: `companyTiers` map в results.json **остаётся** — это
вход для engine'овского resolver'а (Tier для unknown companies). Tier
у Companies DB sync'ается через resolver (existing `syncTier` logic).
Не дублируется в SKILL.

### 6. Idempotency / повторные запуски

Три сценария рестарта:

**(a) Engine crash mid-commit** (например, после Notion-page для row N,
до saveApplications). `notion_page_id` уже в Notion, но НЕ в TSV.
Следующий `prepare`:
- Step 2 `filterAlreadyEvaluated` пропускает row (он `fit_score=Strong`,
  но без `notion_page_id`). SKILL переоценит.
- SKILL получит свежий verdict, передаст в commit.
- Engine commit увидит, что для `app.companyName` company-page есть
  (resolver cache miss → lookup hit), и попробует **создать новую**
  Jobs page → дубль.

Fix: до Notion-create делаем **dedup lookup** в Jobs DB по `key` field
(который мы пишем в propertyMap). Если страница уже есть — берём её
id, не создаём дубль. Это добавляет один `dataSources.query` per
to-apply row, но дешевле, чем guard-row в TSV.

Pseudocode:
```js
// inside pushJobPage, before createJobPage:
const existing = await client.dataSources.query({
  data_source_id: jobsDataSourceId,
  filter: { property: propertyMap.key.field, rich_text: { equals: app.key } },
  page_size: 1,
});
if (existing.results.length > 0) {
  return { pageId: existing.results[0].id, dedup: true };
}
```

**(b) SKILL crashes between iterations** — same recovery path. Engine
never sees the partial results, no harm.

**(c) Legacy run** — old SKILL still sends `notionPageId`. Engine
honours it (skip create), behaviour identical to today minus the bug
we're fixing.

### 7. `--dry-run` behavior

В dry-run engine:
- Делает все in-memory мутации (status flip, fit fields, и т.д.).
- Принтит, какие PDF бы создал.
- Принтит, какие Notion-pages бы создал (с company-resolve, но без
  side-effects — uses `client` only when `--apply`-like flag is set).
- НЕ зовёт Notion API.
- НЕ пишет TSV.

Маршрут: новый internal flag `_skipNotionPush = flags.dryRun || flags.skipNotion`.
SKILL может попросить engine «commit без Notion» через `--skip-notion`
(escape-hatch для разработки / для случая когда Notion down).

### 8. Что НЕ входит в scope

- Не меняем quality fit-scoring / CL-gen / archetype-выбор.
- Не возвращаем push в `sync` (RFC 014 решение остаётся).
- Не делаем backfill старых страниц с битыми PDF-именами (BL-22).
- Не трогаем archive/skip decisions — они и так не делали Notion-push.
- Не трогаем `check` command — он только updates existing pages, не
  создаёт.

## Multi-profile invariant

Все profile-specific вещи проходят через `loadProfile(profileId)`:
- `profile.notion.jobs_pipeline_db_id`
- `profile.notion.companies_db_id`
- `profile.notion.property_map` (может расширять / переопределять `DEFAULT_PROPERTY_MAP`)
- `profile.company_tiers`
- Token: `<UPPER>_NOTION_TOKEN`

Никакого jared-хардкода. Lilia пушит в свою Jobs DB, jared — в свою.

## Test plan

### Unit tests (`engine/core/notion_job_page.test.js`)

1. **Happy path**: mock client.pages.create + resolver.resolve →
   returns pageId; pushJobPage returns `{pageId}`.
2. **Company resolve fails** (resolver throws): pushJobPage propagates
   the error.
3. **Create fails** (Notion 503): pushJobPage propagates.
4. **All required fields wired**: assert buildProperties was called
   with `{title, companyRelation, status, fitScore, ...}`.
5. **Profile-gated fields**: if propertyMap lacks `schedule`/`requirements`,
   jobFields can carry them, pushJobPage doesn't push them (buildProperties
   silently drops unmapped fields).

### Integration tests (`engine/commands/prepare.test.js`)

Расширяем существующий suite (там уже есть `runCommit` тесты с моком
`saveApplications`):

1. **`runCommit` happy path with mock Notion client**: 3 to_apply rows
   → 3 PDF writes → 3 Notion-creates → TSV gets `notion_page_id`,
   status="To Apply". Mock client returns increasing ids.
2. **Notion-create fails for 1 of 3 rows**: 2 succeed, 1 reverts to
   `Inbox` (`notion_page_id=""`, `status="Inbox"`, `cl_key=""`).
   Other rows unaffected. TSV save runs.
3. **PDF-write fails for 1 of 3 rows**: that row never reaches Notion;
   stays `Inbox`. The 2 successful PDFs proceed to Notion-push.
4. **Idempotent re-run**: TSV row already has `notion_page_id` →
   `runCommit` skips Notion call entirely, leaves TSV unchanged.
5. **Legacy SKILL passes `notionPageId` in results.json**: engine
   honours it (no create), stores it in TSV.
6. **`--dry-run`**: prints planned creates, no Notion calls, no TSV
   write.
7. **`prepare_context.json` missing**: pushes base fields only; no
   crash; warning emitted.
8. **Dedup query finds existing Jobs page by `key`**: engine uses
   that id, skips create.

### Live smoke

`/job-pipeline prepare` against `jared` profile с реальным batch.
Визуальная проверка в Notion:
- Все новые `To Apply` страницы имеют PDF на диске.
- Открыть 2-3 — Cover Letter field указывает на существующий файл.
- Сделать искусственный fail (revoke `JARED_NOTION_TOKEN` temporarily,
  запустить commit, восстановить, запустить снова): первый прогон
  rows остаются `Inbox`; второй — пушит и flip'ает.

## Acceptance (Definition of Done)

- В Notion никогда не появляется страница с PDF-именем, которого нет
  на диске (визуальная проверка на jared smoke).
- Все unit + integration тесты зелёные (см. §Test plan).
- Live smoke на jared прошёл: N `to_apply` → N PDF на диске + N Notion
  pages, оба согласованы.
- SKILL Step 9 + 9.0 удалены, Step 10 не упоминает `notionPageId`.
- CLAUDE.md «New Notion pages are created exclusively by `prepare`'s
  commit phase» — теперь правда.
- BL-23 закрыт.

## Migration

- **One PR** хватит. Backward-compat для results.json: engine
  принимает `notionPageId` (legacy SKILL) и просто его пропускает, не
  крашится. После merge — обновить `skills/job-pipeline/SKILL.md` тем
  же PR.
- Никаких ENV-vars не добавляется. Никаких новых package deps.
- Один новый file: `engine/core/notion_job_page.js` + его тесты.
- Один module-level refactor: `DEFAULT_PROPERTY_MAP` → `notion_sync.js`.
- Никаких изменений в `profile.json` schema.

## Risks

- **Notion rate limit**: per-row create + per-row dedup query
  удваивает API calls vs MCP-based SKILL approach. Mitigation: top-30
  batch — это ~60 calls, well below Notion's 3 req/s limit (we add a
  trivial 200ms sleep between rows if needed; existing `sync` already
  hits it without throttling). Если станет проблемой — добавим
  semaphore.
- **Atomicity hole at write-TSV step**: PDF + Notion done, but
  `saveApplications` crash → rows have `notion_page_id` in Notion but
  not in TSV → next run will see them `Inbox` and try to create
  duplicates. Mitigation: dedup-by-`key` query (см. §6 (a)).
- **prepare_context.json drift**: если юзер запускает commit на
  «старом» results.json (с другого дня), prepare_context уже свежий с
  другого batch'а → key mismatch. Engine fallback: пушит без
  schedule/requirements/workFormat, остальное из TSV. Warning в
  stderr. Это «degraded but functional».

## Notes

- Этот RFC — последний шаг RFC 014's «New status split» trajectory.
  RFC 014 ввёл `Inbox` как TSV-only состояние; теперь `Inbox → To Apply`
  становится **по-настоящему** атомарным переходом, привязанным к
  Notion-page-creation. До этого был gap, который BL-23 закрывает.
- Tier M по DEVELOPMENT.md: RFC required (есть), unit+integration
  tests (есть), code-review subagent по диффу (план), live smoke
  (план). L не оправдан: новых архитектурных решений нет, переезд
  одного шага из SKILL в engine с reuse существующих helpers.
