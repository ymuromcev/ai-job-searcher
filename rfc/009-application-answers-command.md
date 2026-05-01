# RFC 009 — `/job-pipeline answer` command + Notion Q&A integration

**Status**: Draft 2026-04-30 (требует approve пользователя)
**Tier**: L (новая команда, Notion shared-state writes, изменение SKILL.md, retro-data ingest)
**Author**: Claude + Jared
**Зависит от**: [RFC 008](./008-companies-as-notion-source-of-truth.md), Stage 16 follow-up Q&A migration

## Проблема

Пользователь обнаружил баг: `/job-pipeline answer` генерит ответы на application-вопросы (Why X? / Influences? / Motivation?), но **никогда не сохраняет их в Notion Q&A БД**, хотя такая БД существует, наполнена 31 ответом и подключена в `profile.json`.

Текущее состояние:
- В [profile.json](../profiles/jared/profile.json): `notion.application_qa_db_id = ca4fa9e8-b3a6-4ccb-bcc2-3a13ff6b06ae`.
- Схема: `Question (title) | Answer (rich_text) | Category (select) | Role (rich_text) | Company (rich_text) | Notes (rich_text)`. Categories: Behavioral, Technical, Culture Fit, Logistics, Salary, Other, Experience, Motivation.
- В DB лежат 31 запись (24 Experience + 5 Motivation + 2 Technical) — историческая база типовых ответов.
- В `engine/commands/` команды `answer` нет. В `skills/job-pipeline/SKILL.md` — слово "answer" встречается только в подзаголовках Humanizer/Guard Rails ("prepare / answer modes"), но самого флоу нет: ни в списке команд, ни в step-by-step.
- Когда вызывается `/job-pipeline answer …`, скилл интерпретирую вручную: загружаю memory, генерю ответ, сохраняю локально. Без reuse существующих ответов из БД, без пуша обратно.

Итог: каждый раз ответы пишутся с нуля (стилевая дрифт + лишние токены), накопленный архив не используется, новая работа не накапливается.

## Зафиксированные решения (после согласования с пользователем 2026-04-30)

| # | Решение |
|---|---------|
| 1 | **Reuse-first**: перед генерацией поиск в Notion Q&A DB по ключу `company\|\|role\|\|question[:120]` (lowercased). Match → показать существующий ответ + предложить reuse / regenerate / edit. |
| 2 | **Auto-push в Notion после approve**: на сигналы "пойдет" / "good" / "submitted" / "залил" — пишем в Q&A DB. Дополнительно — локальный `.md` бэкап в `application_answers/`. Без явных подтверждений типа `--apply` (для symmetry с CL flow). |
| 3 | **Auto-categorize с показом для подтверждения**: эвристика по тексту вопроса определяет Category из 8 опций. Перед пушем показываем выбранную категорию вместе с draft. |
| 4 | **Retro-add сегодняшних Linear + Figma ответов** (3 Q&A entries) в DB одноразовым прогоном после имплементации. |
| 5 | Команда работает per-profile (как остальные). DB берётся из `profile.notion.application_qa_db_id`. |
| 6 | Дедуп: тот же ключ `company\|\|role\|\|question[:120]`. При совпадении в DB — НЕ создаём дубль; если ответ переписан — UPDATE существующей page. |

## Архитектура

### Новая команда

```
node engine/cli.js answer --profile <id> [subcommand] [options]
```

Поскольку основной use case интерактивный (Claude генерит → юзер апрувит → Claude пушит), команда — **гибрид CLI + skill flow**, как `prepare` и `check`. Three-phase:

#### Phase 1 — search (CLI)

```
node engine/cli.js answer --profile <id> --phase search \
  --company "<Company>" --role "<Role>" --question "<question text>"
```

Прогоняет дедуп-ключ, делает Notion query по `application_qa_db_id` с фильтром `Question contains <head>` AND `Company == <Company>` AND `Role == <Role>`. Возвращает JSON:

```json
{
  "key": "figma||product manager, ai platform||why do you want to join figma?",
  "matches": [
    {
      "pageId": "...",
      "question": "...",
      "answer": "...",
      "category": "Motivation",
      "exact": true|false
    }
  ],
  "schema": { "categories": ["Behavioral", ...] },
  "category_suggestion": "Motivation"
}
```

Если `matches[0].exact` — Claude показывает существующий ответ, спрашивает reuse/regen.
Если matches partial / empty — Claude генерит новый, опираясь на Humanizer Rules + memory (как сейчас).

#### Phase 2 — SKILL (Claude генерит и/или показывает)

Логика:
1. Если CLI вернул `exact match` → показать existing answer + сказать `[reuse] / [regenerate] / [edit]`.
2. Иначе → запустить generation (Humanizer Rules + memory как сейчас) → показать draft + suggested category.
3. Если есть partial matches (тот же company+role, другая формулировка вопроса) — показать их как reference.

#### Phase 3 — push (CLI)

Вызывается после approve пользователя.

```
node engine/cli.js answer --profile <id> --phase push \
  --results-file profiles/<id>/.answers/draft_<timestamp>.json
```

Где draft файл (Claude пишет перед вызовом):

```json
{
  "company": "Figma",
  "role": "Product Manager, AI Platform",
  "question": "Why do you want to join Figma?",
  "answer": "AI Platform is the leverage layer at Figma...",
  "category": "Motivation",
  "notes": "210-char short version. Field: Additional Information.",
  "key": "figma||product manager, ai platform||why do you want to join figma?",
  "existingPageId": null
}
```

CLI:
- Если `existingPageId` — UPDATE этой page (Answer + Category + Notes).
- Иначе — CREATE новой page в `application_qa_db_id`.
- Записывает локальный backup в `profiles/<id>/application_answers/<Company>_<role-slug>_<YYYYMMDD>.md` (как уже делал вручную).
- Возвращает `{ pageId, action: "created"|"updated", url }`.

### Категоризация (эвристика)

Чистая функция в `engine/core/qa_categorize.js` с тестами:

```js
function categorize(question) {
  const q = (question || "").toLowerCase();
  if (/why (do you|are you) (want|interested|excited|join)/.test(q)) return "Motivation";
  if (/(motivat|look forward|excit)/.test(q)) return "Motivation";
  if (/(influence|mentor|admire|inspire)/.test(q)) return "Behavioral";
  if (/(tell me about a time|describe a situation|conflict|disagree)/.test(q)) return "Behavioral";
  if (/(salary|compensation|expectations)/.test(q)) return "Salary";
  if (/(visa|sponsor|relocat|start date|notice)/.test(q)) return "Logistics";
  if (/(culture|values|team)/.test(q)) return "Culture Fit";
  if (/(experience with|worked on|tools|stack|technical)/.test(q)) return "Experience";
  return "Other";
}
```

Покрывается тестами с фикстурами на Figma "Why join", Linear "Influences", Linear "Motivation", "Salary expectations", "Visa status" и т.д.

### SKILL.md изменения

В `## Commands` (строка 8) добавить:

```
- **`/job-pipeline answer`** — Generate or reuse application answers (Why join? / Influences? / Motivation? etc.). Three-phase: search Notion Q&A DB by dedup key → reuse if exact match else generate via Humanizer Rules → push answer back to Notion + local .md backup. Per-profile DB at `profile.notion.application_qa_db_id`.
```

Добавить новую секцию `### answer` после `### check`, со step-by-step как у других команд (Phase 1 / Phase 2 SKILL / Phase 3). Внутри — точные шаги по reuse → generate → categorize → push.

В `## Anti-patterns` добавить:

```
- **Do not** generate a new answer without first running `--phase search` and inspecting matches. Reuse before regenerate.
- **Do not** push to Q&A DB without user approval (signals: "пойдет" / "good" / "submitted" / "залил"). Same shared-state rule as CL push.
```

### Files affected

| Path | Change |
|------|--------|
| `engine/commands/answer.js` | NEW. Three-phase command. |
| `engine/commands/answer.test.js` | NEW. Unit tests for phase routing. |
| `engine/core/qa_categorize.js` | NEW. Pure categorization. |
| `engine/core/qa_categorize.test.js` | NEW. ~15 fixture tests. |
| `engine/core/qa_dedup.js` | NEW. Same `dedupKey` as Stage 16 migrate script (extract for reuse). |
| `engine/core/qa_dedup.test.js` | NEW. ~5 tests (lowercase, trim, truncate, missing fields). |
| `engine/core/qa_notion.js` | NEW. Q&A-specific Notion helpers (search by key, create, update). Wraps existing `notion_sync.js`. |
| `engine/core/qa_notion.test.js` | NEW. Mocked Notion client. |
| `engine/cli.js` | MODIFY. Register `answer` command. |
| `skills/job-pipeline/SKILL.md` | MODIFY. Add command to TOC + new section + anti-patterns. |
| `profiles/jared/application_answers/*.md` | EXISTS (created manually 2026-04-30). Will become canonical local backup directory. |
| `scripts/oneoff/retro_seed_qa.js` | NEW. One-off ingest of 3 retroactive answers (2 Linear + 1 Figma) into Q&A DB. |

### Tests

Per DEVELOPMENT.md L-tier rules:
- Unit: `qa_categorize`, `qa_dedup`, `qa_notion` (mocked client) — ~25 tests total.
- Integration: end-to-end answer flow with mocked Notion HTTP, covering: exact-match reuse, no-match generate, update existing, push new.
- Smoke: real call against `application_qa_db_id` создаёт + удаляет временную page (cleanup на teardown).
- Multi-agent review: code-reviewer субагент по диффу + `/security-review` (Notion writes = shared state).

### Безопасность (S1)

- Q&A DB writes = shared state. Pushes ТОЛЬКО на явный approve-сигнал пользователя.
- Дедуп по ключу — обязателен, иначе риск дубликатов с накопительным эффектом.
- `JARED_NOTION_TOKEN` уже используется для других команд — переиспользую env var, не вводим нового секрета.
- Никаких логов с полным телом ответов в `email_check_log.md` или другие общие логи (ответы — личные данные кандидата).

### Что НЕ делаем в этом RFC

- Не делаем версионирование ответов (если переписали — старая версия теряется в Notion). Если понадобится — отдельный RFC.
- Не делаем bulk-import всех ответов из cover letters. Только Q&A.
- Не трогаем categories: используем существующий набор из 8 опций. Если нужны новые — addtive (как Stage 16 migrate сделал).
- Не делаем автокомплит вопросов (search-as-you-type). Сейчас — точечный lookup перед генерацией.

## План работ

1. **Approve этого RFC** пользователем.
2. **Phase A — pure helpers + tests** (`qa_categorize`, `qa_dedup`). Локально, без Notion.
3. **Phase B — Notion helpers + tests** (`qa_notion` с моком клиента).
4. **Phase C — `answer.js` команда**, три фазы, регистрация в `cli.js`. Юнит + integration tests.
5. **Phase D — SKILL.md** обновление + anti-patterns.
6. **Phase E — multi-agent review** (code-reviewer + `/security-review`).
7. **Phase F — retro seed** трёх сегодняшних ответов одноразовым скриптом.
8. **Phase G — smoke**: реальный прогон на одном новом вопросе end-to-end.
9. **Approve пользователя на коммит** (L-тир, без явного ok не коммитим).

## Open questions

1. **Локальный backup `.md`** — оставляем формат, который я уже сделал сегодня, или хочешь другой layout (одна папка на компанию vs flat)?
2. **Update vs append**: при редактировании уже существующего ответа — переписать `Answer` поле или добавить версию в `Notes`? По умолчанию — overwrite + сохранять старую версию в локальном `.md` backup как `_v2`.
3. **Lilia profile**: создавать ли для неё пустую Q&A DB сейчас, или отложить до того, как у неё появятся первые application questions? По умолчанию — отложить (чтобы не плодить пустые БД).

---

После твоего approve — иду по Phase A. Если есть правки по структуре — внесу до начала кода.
