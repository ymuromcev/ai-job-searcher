# RFC 002 — `check` command (Gmail response polling, MCP-driven)

**Status**: Draft 2026-04-20
**Tier**: L (new module, affects Notion state + TSV)
**Author**: Claude + Jared Moore
**Supersedes parts of**: RFC 001 §CLI (`check`), reference MVP in `../Job Search/check_emails.js`

## Проблема

У кандидата в пайплайне десятки активных заявок. Работодатели присылают ответы в Gmail: отказы, приглашения на интервью, запросы дополнительной информации. Ручная сверка инбокса со статусами в Notion — часы работы в неделю и источник пропусков (потерянное приглашение = потерянная вакансия).

Нужна команда `node engine/cli.js check --profile <id>` на AIJobSearcher, которая полностью переносит рабочий прототип `../Job Search/check_emails.js`, но под мульти-профильную архитектуру.

## Варианты

- **A. Полный OAuth + `googleapis` SDK.** Команда сама читает Gmail. Плюсы: standalone, cron-ready. Минусы: OAuth-bootstrap, +13 MB зависимости, ~3ч работы до рабочего пайплайна.
- **B. Двухфазный flow как в прототипе: `--prepare` / `--apply` + Gmail через Claude MCP.** Плюсы: 0 setup, 0 секретов на диске, ~1.5ч до рабочего пайплайна, повторяет проверенный прототип. Минус: не работает в cron — требует Claude-сессию.
- **C. IMAP через XOAUTH2.** YAGNI — все профили на Gmail.

## Выбрано + почему

**Вариант B.** Двухфазный MCP-flow.

Причины:
- Цель "рабочий пайплайн сегодня" — B быстрее на старте и не требует GCP Console.
- Core-логика (classifier, matcher, parsers, filters, logs, state) в B и A **идентична**. Отличается только transport layer. Переход на A позже — локальная замена.
- У Jared уже есть MCP-доступ к Gmail через Claude.

Автоматизация через cron (OAuth-вариант) — отложена в `BACKLOG.md` как отдельная фича "Gmail polling в cron: ответы проверяются пока пользователь спит".

## Архитектура

### Двухфазный flow

```
Phase 1: node engine/cli.js check --profile jared --prepare
  → читает applications.tsv + processed_messages.json
  → пишет profiles/jared/.gmail-state/check_context.json
  → печатает JSON с Gmail search batches для Claude

Phase 2: Claude исполняет Gmail MCP searches + reads
  → пишет profiles/jared/.gmail-state/raw_emails.json
  → формат: [{messageId, threadId, from, subject, body, date}, ...]

Phase 3: node engine/cli.js check --profile jared --apply
  → читает raw_emails.json + context
  → классифицирует, матчит, строит план
  → в --apply обновляет TSV, вызывает Notion updatePageStatus/addPageComment
  → дописывает rejection_log.md / recruiter_leads.md / email_check_log.md
  → обновляет processed_messages.json (last_check, prune > 30d)
```

Dry-run третьей фазы (без `--apply`) печатает план без мутаций.

### Новые/изменённые файлы

```
engine/
├── core/
│   ├── classifier.js              (new) pure rule-based classifier
│   ├── classifier.test.js
│   ├── email_matcher.js           (new) pure: email → application
│   ├── email_matcher.test.js
│   ├── email_parsers.js           (new) LinkedIn / recruiter subject parsers
│   ├── email_parsers.test.js
│   ├── email_filters.js           (new) level/location/tsv-dup filters
│   ├── email_filters.test.js
│   ├── email_logs.js              (new) rejection_log / recruiter_leads / check_log writers
│   ├── email_logs.test.js
│   ├── email_state.js             (new) processed_messages.json + context.json persistence
│   ├── email_state.test.js
│   └── notion_sync.js             (modify) add updatePageStatus(), addPageComment()
└── commands/
    ├── check.js                   (new) two-phase orchestrator
    └── check.test.js

profiles/<id>/
├── .gmail-state/                  (gitignored)
│   ├── check_context.json         (written by --prepare)
│   ├── raw_emails.json            (written by Claude MCP between phases)
│   └── processed_messages.json    (persistence across runs)
├── rejection_log.md               (gitignored) appended by check
├── recruiter_leads.md             (gitignored) appended by check
└── email_check_log.md             (gitignored) appended by check
```

Никаких `modules/tracking/gmail.js`, `scripts/gmail_auth.js`, `googleapis` — не нужны в MCP-варианте.

### CLI

```
node engine/cli.js check --profile <id> --prepare
node engine/cli.js check --profile <id>                  # dry-run третьей фазы
node engine/cli.js check --profile <id> --apply          # мутация TSV + Notion
node engine/cli.js check --profile <id> --since 2026-04-15 --prepare
```

Default без флагов на фазе 3 = dry-run (симметрично `sync`).

### Классификатор (`classifier.js`)

Pure-функция:
```js
classify({ subject, body }) → {
  type: 'REJECTION' | 'INTERVIEW_INVITE' | 'INFO_REQUEST' | 'ACKNOWLEDGMENT' | 'OTHER',
  evidence: 'matched pattern snippet'
}
```

Регексы — полный порт из `check_emails.js:114-137`. Порядок проверки: REJECTION → INTERVIEW → INFO → ACK → OTHER. Первый совпавший тип возвращается.

### Матчер (`email_matcher.js`)

Pure-функция:
```js
matchEmailToApp(email, activeJobsMap) → {
  company, job, confidence: 'HIGH'|'LOW', reason
} | null
```

Алгоритм — полный порт из `check_emails.js:152-205`:
1. `companyTokens(name)` — отбросить LLC/Inc/stop-words, токены > 3 символов.
2. Pass 1: совпадение токена в `from` или `subject` → HIGH.
3. Pass 2: совпадение в body с word-boundary → HIGH.
4. Role disambiguation: exact title → keywords (skip PM common words). LOW если не смогли различить.

Также экспортируем: `parseLevel(role)`, `archetype(resumeVersion)`.

### Парсеры (`email_parsers.js`)

Pure-функции:
- `parseLinkedInSubject(subject)` → `{role, company} | null` (RU + EN варианты из прототипа).
- `parseRecruiterRole(subject)` → `string | null`.
- `extractSenderName(from)` → `string`.

Порт `check_emails.js:234-260`.

### Фильтры (`email_filters.js`)

Pure-функции:
- `isLevelBlocked(title, rules)` → boolean.
- `isLocationBlocked(text, rules)` → boolean.
- `isTSVDup(company, role, rows)` → boolean.
- `isATS(from)` → boolean (против `ATS_DOMAINS`).
- `matchesRecruiterSubject(subject)` → boolean (против `RECRUITER_SUBJECT_PATTERNS`).

Порт `check_emails.js:54-74, 224-267`.

### Логи (`email_logs.js`)

Side-effectful (файловые аппенды), но каждая функция принимает путь как параметр:
- `appendRejectionLog(path, rejections)` — порт `check_emails.js:619-654`.
- `appendRecruiterLeads(path, leads)` — порт `check_emails.js:269-283`.
- `appendCheckLog(path, logRows, actionCount, rejections, inboxAdded?, recruiterLeads?)` — порт `check_emails.js:658-700`.
- `buildSummary(...)` — pure, порт `check_emails.js:702-722`.

### State (`email_state.js`)

- `loadProcessed(path)` → `{processed: [{id, date, company, type}], last_check}`.
- `saveProcessed(path, data)` — prune > 30d.
- `loadContext(path)`, `saveContext(path, ctx)`.
- `loadRawEmails(path)`.

### Оркестратор (`commands/check.js`)

**`--prepare` фаза** (порт `runPrepare`, `check_emails.js:287-367`):
1. Load profile + `applications.tsv`.
2. Compute cursor epoch (saved.last_check clamp to 30d) или из `--since`.
3. Build `activeJobsMap` — apps с `notion_page_id` set и status ∈ {Applied, To Apply, Phone Screen, Onsite, Offer}.
4. Build Gmail batches:
   - По 10 компаний на батч: `(from:(tokens) OR subject:(tokens)) after:<epoch> -from:me`.
   - Фикс-батч LinkedIn alerts: `from:jobalerts-noreply@linkedin.com after:<epoch>`.
   - Фикс-батч recruiter outreach (subject keywords, ATS exclude) — копия из прототипа.
5. Write `check_context.json`.
6. Печатаем JSON: `{epoch, batchCount, companyCount, batches}` для Claude.

**`--apply` / dry-run фаза** (порт `runProcess`, `check_emails.js:371-597`):
1. Load `check_context.json` + `raw_emails.json`.
2. Filter already-processed by messageId.
3. Для каждого письма — ветка:
   - **LinkedIn** (from contains jobalerts-noreply@linkedin.com): parse → dedup+filter → Inbox row OR skip.
   - **Recruiter outreach** (matchesRecruiterSubject + !isATS): parse role → extract client company from body → Inbox OR `recruiter_leads.md`.
   - **Normal**: classify → matchEmailToApp → по type (REJECTION / INTERVIEW / INFO / ACK / OTHER) строим план с {statusUpdate, comment, rejectionLogEntry}.
4. Печатаем полный план.
5. Если `--apply`:
   - TSV save (merged Inbox rows + status updates).
   - Notion: `updatePageStatus` + `addPageComment` per plan item.
   - Append `rejection_log.md`, `recruiter_leads.md`, `email_check_log.md`.
   - Save `processed_messages.json` (append new ids, bump `last_check`, prune > 30d).
6. Return `errors > 0 ? 1 : 0`.

### Маппинг тип → Status + комментарий

| Classifier type    | New Status    | Notion comment                                           |
|--------------------|---------------|----------------------------------------------------------|
| REJECTION          | Rejected      | `❌ Получен отказ. Тема: {subject}. Статус → Rejected.`  |
| INTERVIEW_INVITE   | Phone Screen  | `🔔 Приглашение на интервью! Тема: {subject}...`          |
| INFO_REQUEST       | *(no change)* | `📋 Запрос информации. Тема: {subject}. Нужно ответить.` |
| ACKNOWLEDGMENT     | *(no change)* | *(no comment)*                                           |
| OTHER              | *(no change)* | *(no comment)*                                           |

Skip-логика: если `status ∈ {Rejected, Closed}` — update не применяется.

### Notion API изменения

`notion_sync.js` — добавить:
- `updatePageStatus(client, pageId, newStatus, propertyMap)` — через `pages.update` с `toPropertyValue('status', ...)`.
- `addPageComment(client, pageId, commentText)` — через `comments.create`.

Оба покрыты unit-тестами через mocked client (как existing `createJobPage.test.js`).

## Тесты

- `classifier.test.js` — таблица кейсов из прототипа + edge cases (пустой subject/body, ambiguous → OTHER).
- `email_matcher.test.js` — single-role / multi-role role disambiguation / no match / LLC stripping / stop-words.
- `email_parsers.test.js` — LinkedIn RU/EN форматы, recruiter subject variations, неразборное → null.
- `email_filters.test.js` — level/location blocklists, ATS detection, recruiter pattern match, TSV dedup.
- `email_logs.test.js` — append-only поведение, корректные заголовки при создании файла, сортировка.
- `email_state.test.js` — load/save processed, prune 30d, cursor вычисление.
- `notion_sync.test.js` — updatePageStatus/addPageComment с mocked client.
- `check.test.js` — оркестрация:
  - `--prepare` пишет context с корректными батчами.
  - `--apply` с mocked raw_emails применяет план, dry-run — не мутирует.
  - Идемпотентность: повторный запуск с тем же raw_emails.json — 0 actions.
  - Mid-run ошибка Notion — остальные обрабатываются.
  - Пропуск уже-финальных статусов (Rejected/Closed).

Smoke-test (ручной, сегодня):
1. Copy state files из `../Job Search/` в `profiles/jared/.gmail-state/` + `profiles/jared/*.md`.
2. `node engine/cli.js check --profile jared --prepare` → забираем JSON с батчами.
3. В Claude: выполнить Gmail MCP searches + reads → записать `profiles/jared/.gmail-state/raw_emails.json`.
4. `node engine/cli.js check --profile jared` → ревью плана.
5. `node engine/cli.js check --profile jared --apply` → сверка TSV + Notion.

## Deferred → BACKLOG.md

- **Gmail polling в cron (автономный OAuth-вариант)** — архитектура core совместима, добавить `engine/modules/tracking/gmail.js` + `scripts/gmail_auth.js` + `--auto` флаг в команде. Цель: проверка инбокса пока пользователь спит.
- LLM fallback для ambiguous classifier.
- IMAP-бэкенд для non-Gmail профилей.
- `check --follow-up` — напоминания о заявках без ответа N дней.

**Включено в Stage 14 (полный порт прототипа):**
- LinkedIn job alerts → Inbox.
- Recruiter outreach → Inbox / `recruiter_leads.md`.
- Notion комментарии на каждое событие.
- `rejection_log.md` автозапись.

## Безопасность

- В MCP-варианте: **нет секретов на диске**. Gmail-чтение делегировано Claude (у которого уже есть пользовательский OAuth через MCP).
- Логи не пишут полный body — только subject + classifier evidence.
- `.gmail-state/` в gitignore.
- Notion token — как и раньше, в `.env` как `{ID}_NOTION_TOKEN`.

## План реализации (порядок)

1. Обновить `.gitignore` + `BACKLOG.md`.
2. Скопировать state из `../Job Search/` в `profiles/jared/` (processed, логи).
3. `core/classifier.js` + tests.
4. `core/email_matcher.js` + tests (включая `companyTokens`, `parseLevel`, `archetype`).
5. `core/email_parsers.js` + tests.
6. `core/email_filters.js` + tests.
7. `core/email_state.js` + tests.
8. `core/email_logs.js` + tests.
9. `core/notion_sync.js` — `updatePageStatus` + `addPageComment` + tests.
10. `commands/check.js` + tests (обе фазы с моками).
11. Регистрация в `engine/cli.js`.
12. Manual smoke: `--prepare` → MCP Gmail → `--apply`.
13. Commit + CLAUDE.md update.

## Open questions — закрыто

1. ✅ **Interview Status**: `"Phone Screen"` (как в прототипе).
2. ✅ **Transport**: MCP (двухфазный flow).
3. ✅ **Existing state**: копируем один раз из `../Job Search/` в `profiles/jared/` как starting point.
