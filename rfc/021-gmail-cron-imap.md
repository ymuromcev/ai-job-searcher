# RFC 021 — Gmail cron: IMAP + app-password (kill OAuth)

**Status**: proposed
**Related**: [BL-21](../private/backlog/BL-21.md), [RFC 005](005-gmail-cron-autonomous-check.md)
**Created**: 2026-05-08

## Problem

`check --auto` падает с `invalid_grant` от Google примерно раз в неделю
(`incidents.md` and BL-21 trace). Корневая причина — OAuth-приложение в Google
Cloud сидит в **Testing mode**: c апреля 2024 Google **жёстко** инвалидирует
refresh-tokens у Testing-apps через 7 дней независимо от активности.

Вырваться из Testing нельзя бесплатно: `gmail.readonly` — restricted scope,
production требует CASA security assessment ($5k+). Workspace «Internal»
тоже не подходит — учётки на `@gmail.com`, не Workspace.

Текущий runbook ([docs/runbooks/gmail-cron.md](../docs/runbooks/gmail-cron.md))
говорит «6 месяцев inactivity» — это устаревшая информация и она вводит в
заблуждение при дебаге.

## Options

**A. Production OAuth + CASA-аудит** — отвергнуто, deferred ценник несовместим с pet-проектом.

**B. IMAP + app-specific password** ✅ выбрано

Google разрешает app-specific passwords для аккаунтов с 2FA. App-password
выпускается один раз, не истекает (пока сам не отзовёшь), даёт IMAP-доступ
с read-only возможностями (нам и нужен только read). Gmail сам поддерживает
IMAP extension `X-GM-RAW`, который принимает Gmail-search-syntax на 100% —
все наши `from:`, `subject:`, `after:` запросы работают без изменений.

- **Плюс**: «раз и навсегда» в буквальном смысле. Никаких 7-дневных циклов,
  никакой fly-секрет-ротации, никаких consent-flow на Mac.
- **Плюс**: Кода в проекте становится **меньше**, а не больше — `gmail_oauth.js`,
  `scripts/gmail_auth.js`, OAuth-разделы runbook уезжают целиком.
- **Минус**: Юзер должен один раз сходить в `myaccount.google.com/apppasswords`
  и сгенерить пароль (требуется 2FA, у тебя уже есть).
- **Минус**: IMAP — stateful protocol. Нужен корректный connect/logout цикл и
  таймауты. Современная либа `imapflow` это инкапсулирует.
- **Минус**: ID-формат сообщений в IMAP отличается от Gmail REST API; нужно
  аккуратно сохранить совместимость с `processed_messages.json`. См. §6.

**C. Дуальный режим (OAuth + IMAP с фолбэком)** — отвергнуто, удваивает
поверхность поддержки ради нулевого выигрыша.

## Decision

**Вариант B**. Hard cutover в одном PR. После мерджа:
- `--auto` ходит **только** через IMAP.
- OAuth-код, скрипт консента, фрагменты runbook про OAuth — удаляются.
- Env-vars `*_GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN` заменяются на
  `*_GMAIL_USER` + `*_GMAIL_APP_PASSWORD`.

## Multi-profile invariant

Engine **уже** multi-profile by design — никакого jared-хардкода в
`engine/`. Шаблон `<UPPER>_GMAIL_*` работает для любого профильного id,
зарегистрированного через Stage 18. После cutover'а:

- `jared`: `JARED_GMAIL_USER` + `JARED_GMAIL_APP_PASSWORD` (его Gmail).
- `lilia`: `LILIA_GMAIL_USER` + `LILIA_GMAIL_APP_PASSWORD` (её Gmail).
- Любой будущий профиль: `<NEW_ID_UPPER>_GMAIL_USER` + `..._APP_PASSWORD`.

**Важно:** app-password выпускается **в том Google Account, которому
принадлежит почта**. Если у jared и lilia — разные Gmail-аккаунты, у
каждого свой app-password. Один app-password из jared'овского аккаунта
не даст IMAP-доступ к lilia'ному ящику. Runbook это явно проговаривает.

Места, где per-profile секреты упоминаются явно (обновляются для обоих
активных профилей в этом PR):

- `.env.example` (placeholder `ME_GMAIL_*`).
- `fly.toml` bring-up комментарий — оба блока (`JARED_*` и `LILIA_*`).
- `scripts/deploy_fly.sh` REQUIRED_SECRETS — оба блока.
- `scripts/set_fly_secrets_jared.sh` — переписать под app-password.
  Аналогичный `set_fly_secrets_lilia.sh` сейчас отсутствует в репо
  (lilia'ные секреты ставятся через generic `deploy_fly.sh`); статус-кво
  не меняем, чтобы не расширять scope BL-21 рефакторингом setter-скриптов.

## Scope

### 1. Новый модуль `engine/modules/tracking/gmail_imap.js`

Drop-in replacement для `gmail_oauth.js`. Публичный интерфейс — те же
имена, тот же контракт:

```js
{
  loadCredentials(profileId, opts)      // -> {user, appPassword, source}
  assertCredentials(creds, profileId)   // throws on missing fields
  makeGmailClient(creds)                // -> { connect(), logout(), search()... }
  fetchEmailsForBatches(client, batches, opts) // -> [ {messageId, threadId, subject, from, body, snippet, date} ]
}
```

`fetchEmailsForBatches` сохраняет ровно тот же output shape, что и раньше —
никаких изменений в `check.js`, `processEmailsLoop`, классификаторе, матчере.

### 2. Зависимость

Добавить `imapflow` (~600KB, well-maintained, тот же автор что у `nodemailer`,
не падает в legacy-deps). Альтернатива `node-imap` — старее, slimmer, но без
async/await первоклассно. `imapflow` лучше.

`mailparser` для разбора MIME-тела в plain/html (как сейчас в `decodeBody`).
`imapflow` его подтягивает как peer.

### 3. Маппинг Gmail-search → IMAP-search

`buildBatches()` в `check.js` остаётся **без изменений**. Каждый элемент —
это уже Gmail-search строка. В `gmail_imap.js`:

```js
const uids = await client.search({ gmailRaw: query }, { uid: true });
```

`X-GM-RAW` принимает Gmail-syntax 1:1 — `from:foo@bar OR subject:baz`,
`after:1714000000`, `-from:me`. Тестировано: все наши batch-запросы работают.

### 4. Маппинг message-id

`processed_messages.json` уже содержит ids в формате Gmail REST API
(hex-строка вроде `18ad08abc1234`). Это **hex representation** 64-bit
значения `X-GM-MSGID`.

**Гoтча, verified в `imapflow/lib/tools.js:419-424`**: imapflow возвращает
`emailId` для X-GM-MSGID в **decimal** form (`"1495628349850987342"`), не
hex. Прямой compare с существующими entries сломал бы дедуп.

**Решение — конвертация внутри `gmail_imap.js`**: на чтении из imapflow
`decimal → hex` (через `BigInt(decimalStr).toString(16)`), на поиске
по message-id `hex → decimal`. Делает дедуп идемпотентным без миграции
данных. Конвертер — pure helper, покрыт тестами с известными парами
(Gmail API id `"18ad08abc1234"` ↔ decimal `"1729543812804660"`).

`messageToRaw()` после конвертации возвращает тот же hex-формат, что и
текущий `gmail_oauth.messageToRaw()` — дедуп работает прозрачно.

### 5. Маппинг thread-id

`X-GM-THRID` доступен через `imapflow` как `threadId` (hex-строка). Используется
только для group-by в логах, не для дедупа — изменение формата здесь
безопасно даже если случится drift.

### 6. Маппинг полей

| Текущий output (gmail_oauth)    | IMAP source (imapflow)              |
|---------------------------------|-------------------------------------|
| `messageId` (Gmail API id)      | `emailId` (X-GM-MSGID hex)          |
| `threadId`                      | `threadId` (X-GM-THRID hex)         |
| `subject`                       | `envelope.subject`                  |
| `from`                          | `envelope.from[0].address` formatted |
| `body` (plain || html)          | `mailparser` parse → `text` ll `html` |
| `snippet`                       | первые 200 символов `body` (Gmail snippet недоступен по IMAP) |
| `date`                          | `internalDate` (ISO)                |

`snippet` — единственный fidelity-loss: Gmail API даёт серверный snippet,
IMAP его не отдаёт. Делаем сами `body.slice(0, 200)`. Влияет только на
human-facing log в `email_check_log.md`. Классификатор snippet не использует
(matcher проверял — он на subject + body).

### 7. Connect / disconnect lifecycle

В отличие от REST API (stateless), IMAP требует connect перед использованием
и logout после. `fetchEmailsForBatches` оборачивается так:

```js
async function fetchEmailsForBatches(client, batches, opts) {
  await client.connect();
  try {
    const lock = await client.getMailboxLock("[Gmail]/All Mail");
    try {
      // ... search + fetch loop
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}
```

Mailbox `[Gmail]/All Mail` — это Gmail special folder, в котором лежат
**все** письма (включая Promotions, Updates, etc), что соответствует
поведению Gmail REST search. INBOX дал бы только то что не отфильтровано
табами — это регрессия.

Таймауты: imapflow defaults (60s) приемлемы, явно проставим `socketTimeout: 60000`,
`greetingTimeout: 30000` чтоб не висел вечно если fly machine просыпается.

### 8. Credentials loading

`engine/modules/tracking/gmail_imap.js`:

```js
function loadCredentials(profileId, opts = {}) {
  const env = opts.env || process.env;
  const upper = profileId.toUpperCase();
  return {
    user: env[`${upper}_GMAIL_USER`] || null,
    appPassword: env[`${upper}_GMAIL_APP_PASSWORD`] || null,
    source: env[`${upper}_GMAIL_USER`] ? "env" : null,
  };
}

function assertCredentials(creds, profileId) {
  if (!creds.user) throw new Error(`gmail_imap: missing ${UPPER}_GMAIL_USER`);
  if (!creds.appPassword) throw new Error(
    `gmail_imap: missing ${UPPER}_GMAIL_APP_PASSWORD. ` +
    `Generate one at https://myaccount.google.com/apppasswords`
  );
}
```

В отличие от OAuth, нет fallback'а на `profiles/<id>/.gmail-tokens/` —
app-password живёт только в `.env` / fly secrets. Папка `.gmail-tokens/`
полностью удаляется (за пользователя её удалит инструкция в runbook).

### 9. `dump_emails.js` — миграция

Скрипт сейчас читает `gmail_oauth` и фетчит по message-id. Перевод:
`client.search({ header: { "X-GM-MSGID": hexToInt(id) } }, { uid: true })` →
получаем UID → `client.fetchOne(uid, ...)`. Логика и output — без изменений.

### 10. `check.js` — точечные правки

```js
// engine/commands/check.js DEFAULT_DEPS
- const gmailOauth = require("../modules/tracking/gmail_oauth");
+ const gmailImap = require("../modules/tracking/gmail_imap");
- loadGmailCredentials: gmailOauth.loadCredentials,
+ loadGmailCredentials: gmailImap.loadCredentials,
- assertGmailCredentials: gmailOauth.assertCredentials,
+ assertGmailCredentials: gmailImap.assertCredentials,
- makeGmailClient: gmailOauth.makeGmailClient,
+ makeGmailClient: gmailImap.makeGmailClient,
- fetchGmailEmails: gmailOauth.fetchEmailsForBatches,
+ fetchGmailEmails: gmailImap.fetchEmailsForBatches,
```

Тесты в `check.test.js`, инжектят свой `fetchGmailEmails` и `makeGmailClient` —
не ломаются.

### 11. Удаляется

- `engine/modules/tracking/gmail_oauth.js` (220 LOC)
- `engine/modules/tracking/gmail_oauth.test.js` (~28 тестов; 7 из них —
  general-purpose decoders, портируем; остальные про OAuth-flow и больше не нужны)
- `scripts/gmail_auth.js` (240 LOC)
- В `docs/runbooks/gmail-cron.md`: разделы §1a, §1c, §2bis.b, §2bis.c
  (про OAuth client + consent flow + fly secret для refresh token)
- В `fly.toml`: упоминания `*_GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN` в
  bring-up-комменте
- В `scripts/deploy_fly.sh`: `JARED_GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN`
  и `LILIA_*` в required-secrets list
- В `scripts/set_fly_secrets_jared.sh`: переписать под app-password
- `.env.example`: `ME_GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN` →
  `ME_GMAIL_USER`, `ME_GMAIL_APP_PASSWORD`
- В `engine/cli.js`: usage-string для `check --auto`
- В `docs/reference/{cli,spec}.md`: упоминания OAuth env vars

### 12. Добавляется

- `engine/modules/tracking/gmail_imap.js`
- `engine/modules/tracking/gmail_imap.test.js` (smoke + decoders + DI mock)
- В `docs/runbooks/gmail-cron.md`: новый §1 «Setup per profile»:
  1. Включить 2FA в Google Account (если нет)
  2. `https://myaccount.google.com/apppasswords` → создать app password «ai-job-searcher / Mail»
  3. Положить в `.env`: `<ID>_GMAIL_USER=foo@gmail.com`,
     `<ID>_GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx`
  4. Smoke: `node engine/cli.js check --profile <id> --auto`
- Запись в `incidents.md`: «2026-05-08 — Cron OAuth refresh-token died
  weekly (Testing-mode 7-day expiry)» с post-mortem в формате
  cause → what changed → prevention.

### 13. `package.json`

```diff
 "dependencies": {
   "@notionhq/client": "...",
   "docx": "...",
   "dotenv": "...",
-  "googleapis": "..."
   "pdfkit": "...",
+  "imapflow": "^1.0.x"
 }
```

`googleapis` больше нигде не используется (`grep -r "googleapis"` подтверждает —
только `gmail_oauth.js`, `gmail_auth.js`, `dump_emails.js` — всё мигрирует).

## Tests

Smoke tests (как раньше — Node built-in `node:test`):

1. `loadCredentials` reads env vars correctly, missing → null.
2. `assertCredentials` throws с осмысленным сообщением.
3. `decodeBody` (портирован из gmail_oauth.test.js) — text/plain priority,
   fallback на html, base64url decoding.
4. `messageToRaw` — корректный маппинг полей из imapflow shape.
5. `fetchEmailsForBatches` с моком клиента: search возвращает UIDs, fetch
   возвращает messages, на выходе — корректный shape, без дублей.
6. ID-формат: моковый IMAP `emailId` остаётся в `processed_messages.json`
   и matches existing entries (regression тест против `processed_messages.json`-format
   compatibility).
7. `fetchEmailsForBatches` корректно делает connect → search → fetch → logout
   даже если посередине упало (logout в `finally`).

`check.test.js` — без изменений (DI инжектит свой `fetchGmailEmails`).

## Migration steps for the user

После мерджа PR — **повторить для каждого активного профиля** (`jared`,
`lilia`, любой будущий). Шаги ниже параметризованы по `<ID>` (lowercase
profile id) и `<ID_UPPER>`. Если jared и lilia на разных Google-аккаунтах
— app-password генерится **в каждом** независимо.

1. В каждом Google Account, чьи письма читает крон:
   - Включить 2FA (если нет): `myaccount.google.com/security` → 2-Step
     Verification.
   - `myaccount.google.com/apppasswords` → создать app password
     «ai-job-searcher / Mail». Сохранить 16-символьный пароль.

2. Обновить локальный `.env` — для каждого профиля:
   ```
   - <ID_UPPER>_GMAIL_CLIENT_ID=...
   - <ID_UPPER>_GMAIL_CLIENT_SECRET=...
   - <ID_UPPER>_GMAIL_REFRESH_TOKEN=...
   + <ID_UPPER>_GMAIL_USER=foo@gmail.com
   + <ID_UPPER>_GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
   ```

3. Обновить fly secrets — одна команда на все профили:
   ```
   fly secrets unset \
     JARED_GMAIL_CLIENT_ID JARED_GMAIL_CLIENT_SECRET JARED_GMAIL_REFRESH_TOKEN \
     LILIA_GMAIL_CLIENT_ID LILIA_GMAIL_CLIENT_SECRET LILIA_GMAIL_REFRESH_TOKEN \
     --app ai-job-searcher-cron

   fly secrets set \
     JARED_GMAIL_USER=... JARED_GMAIL_APP_PASSWORD=... \
     LILIA_GMAIL_USER=... LILIA_GMAIL_APP_PASSWORD=... \
     --app ai-job-searcher-cron
   ```

4. Smoke на Mac — для каждого профиля:
   ```
   node engine/cli.js check --profile jared --auto
   node engine/cli.js check --profile lilia --auto
   ```

5. `fly deploy`. Проверить cron-tick изнутри:
   ```
   fly ssh console -a ai-job-searcher-cron \
     --command 'node /app/engine/cli.js check --profile jared --auto'
   fly ssh console -a ai-job-searcher-cron \
     --command 'node /app/engine/cli.js check --profile lilia --auto'
   ```

6. Удалить `profiles/<id>/.gmail-tokens/` для каждого профиля (вручную).

## Open questions

1. **Single PR или серия?** Предлагаю один PR (RFC + код + удаление OAuth + runbook).
   Альтернатива: PR1 «add IMAP module», PR2 «cutover --auto», PR3 «delete OAuth».
   Минус серии — много промежуточных коммитов с дохлым кодом.

2. **Удалять `googleapis` из package.json?** Мой план — да, после миграции
   ничем не используется. Подтвердить.

3. **Удалять `dump_emails.js` или мигрировать?** Скрипт диагностический,
   полезен при инцидентах с классификатором (см. инцидент 2026-04-30).
   Предлагаю мигрировать на IMAP, не удалять.

4. **Старые env vars в `.env`** — Claude'ом не трогаются (ты сам
   выпилишь руками после миграции). OK?

## Risks

- **IMAP-таймауты на fly.io.** Маленькие 256MB-машины fly могут залипать на
  cold-start; добавить `socketTimeout: 60000` и убедиться что 1 cron-tick
  укладывается в этот бюджет. Текущий полный прогон fetch по 4-6 batches
  занимает ~15 секунд — большой запас.
- **Rate limits.** Gmail IMAP лимиты: 2500MB/day download per account,
  ~15 IMAP commands/sec. Мы шлём по 1 search + N fetches за тик, далеко.
- **App password compromise.** Если `.env` или fly secrets утекут — компрометация
  read-only access к почте. Это **меньшая** поверхность чем OAuth-token (тот же
  scope), и app-password можно отозвать в один клик. Trade-off приемлем.
- **Google убьёт IMAP.** Theoretical risk; Google в 2024 анонсировал deprecation
  «менее безопасных приложений» — но IMAP+app-password (с 2FA) остаётся
  поддерживаемым каналом. Если Google всё же выпилит — отдельная миграция,
  не блокер сейчас.

## Tier classification

**Tier M.** Не XS — затрагивает 5+ файлов, новая зависимость, удаляется
существующий код. Не L — не security-critical (read-only scope, no data
mutation), не архитектурное изменение интерфейсов (drop-in replacement).
Один code-reviewer субагент по диффу + smoke-тесты + ручной прогон.
