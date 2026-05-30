# RFC 057 — Classifier: acknowledgment autoresponders must not classify as interview invites

- **Status:** proposed
- **Tier:** M
- **Author:** Claude (with Jared)
- **Created:** 2026-05-30
- **Refs:** BL-157, RFC 056 (recovery run that surfaced it), `engine/core/classifier.js`

## Образ результата (user-level)

Сегодня бот иногда поднимает вакансию в **Interview** по письму, которое
на самом деле — авто-ответ «мы получили вашу заявку». После фикса:

- Письмо вида «Application Received… we are reviewing applications and
  **expect to schedule interviews** in the next couple of weeks» больше
  **не** даёт статус Interview. Оно остаётся подтверждением (ACK,
  статус карточки не меняется).
- Настоящие приглашения («we'd like to schedule **your** interview»,
  «invite you to interview», «book a time on my calendar», round-N,
  phone screen, Calendly) по-прежнему дают Interview.
- В Notion на ложные ACK больше не сыплются 🔔-комментарии про интервью.
- Поведение одинаково для всех профилей (jared, lilia) — фикс в общем
  движке.

Что НЕ входит: исправление матчинга «письмо ↔ не та вакансия»
(вторичный баг, найден в том же инциденте) — отдельная задача BL-158.
Также вне scope: ретро-переразметка уже обработанных писем (для этого
есть `reclassify` / `--reprocess-since`).

## Контекст / инцидент

2026-05-30, при верификации recovery-прогона (RFC 056) у профиля lilia
heartbeat показал `→ Interview: 3`. Разбор: все три «перехода» — это
**одно и то же** авто-письмо Workday/Sharecare, пришедшее трижды:

```
From:    sharecare@myworkday.com
Subject: Application Received for Data Entry Specialist - Medical Records (Remote)
Body:    "...we have received your application. ...We are reviewing
          applications and expect to schedule interviews in the next
          couple of weeks. If you are selected for an interview, you can
          expect an email or phone call from us..."
```

`classify()` вернул `INTERVIEW_INVITE` с evidence `"schedule interview"`.

## Root cause

Два усиливающих друг друга фактора в `engine/core/classifier.js`:

1. **Слишком широкий паттерн INTERVIEW_INVITE.**
   `/schedule (?:(?:your|the|our|my|a|an)\s+)?(interview|phone screen)/i`
   срабатывает на `"expect to schedule interviews"`:
   - артикль необязателен → ловит безартиклевую форму «schedule
     interviews»;
   - нет `\b` после `interview` → ловит множественное «interviews»;
   - нет требования, чтобы планировали интервью **получателю** — фраза
     описывает будущий процесс компании, а не приглашение.

2. **ACKNOWLEDGMENT стоит последним в `ORDER`.**
   `ORDER = [POSITION_CLOSED, REJECTION, INTERVIEW_INVITE, INFO_REQUEST,
   ACKNOWLEDGMENT]`, first-match-wins. У письма есть явный ACK-сигнал
   (`/received your application/i`, `/we have received/i`), но
   INTERVIEW_INVITE проверяется раньше и побеждает. Сильный сигнал
   «заявку получили» не может перебить слабую forward-looking фразу.

Тот же класс ошибки уже латали точечно (2026-05-02 Indeed-digest:
убрали bare `\binterview\b`/`\bavailability\b`; 2026-05-12 Tyson&Mendes:
убрали `next steps in the process`). Это следующий случай той же
болезни — forward-looking process-текст в теле ACK.

## Дизайн (на выбор, рекомендация — Вариант C)

### Вариант A — точечно ужать regex (минимум кода)
Заменить `schedule…interview` паттерн на directed-форму:
- требовать притяжательное/определённое наполнение и singular + `\b`:
  `/schedule (?:your|the|our|my)\s+(?:phone\s+)?interview\b/i`
  и отдельно `/schedule (?:a|an)\s+interview\b(?!s)/i` для «schedule an
  interview»;
- добавить негативный guard на forward-looking префиксы
  (`expect to|plan to|hope to|will|going to|aim to` + `schedule`).

Плюс: хирургично, мало риска для других типов. Минус: не лечит другие
forward-looking фразы в ACK (`share your availability`, и т. п.).

### Вариант B — ACK-precedence guard
Если текст матчит ACKNOWLEDGMENT **и** единственное доказательство
INTERVIEW_INVITE / INFO_REQUEST — это известная «process-описательная»
фраза, классифицировать как ACKNOWLEDGMENT. Реализация: пометить часть
INTERVIEW/INFO паттернов как «weak/forward-looking» и при наличии
сильного ACK демотировать.

Плюс: лечит весь класс. Минус: усложняет first-match-wins логику,
больше тест-поверхности.

### Вариант C — A + субъектный ACK short-circuit (рекомендуется)
- Применить ужатие из A.
- Добавить в ACKNOWLEDGMENT субъектные формы автоответов:
  `/application received/i`, `/application (confirmation|confirmed)/i`.
- Ввести лёгкий guard: если matched-evidence INTERVIEW_INVITE
  принадлежит «forward-looking» подсписку **и** одновременно матчит
  сильный ACK — отдать ACKNOWLEDGMENT. Подсписок forward-looking держим
  явным и маленьким (сейчас в нём только `schedule…interview`-семейство),
  чтобы не размывать настоящие инвайты.

## Идемпотентность / безопасность

- Уже обработанные письма не переразмечаются на обычных прогонах
  (dedup по `processed_messages.json`); ложные ACK из инцидента уже
  записаны → повторно карточки не тронут. Re-flip возможен только при
  явном `--reprocess-since`, который мы не запускаем.
- Карточку lilia (Clinic Administrative Assistant @ Fresenius) уже
  откатили вручную в To Apply + аудит-комментарий (2026-05-30).

## Definition of Done

- `classify()` на 3 Sharecare-фикстурах возвращает `ACKNOWLEDGMENT`
  (regression-фикстуры добавлены в `classifier.test.js`).
- Все существующие INTERVIEW_INVITE / INFO_REQUEST / REJECTION кейсы в
  `classifier.test.js` остаются зелёными (настоящие инвайты не сломаны).
- Добавлены позитивные anti-regression кейсы: «schedule your interview»,
  «we'd like to schedule», «invite you to interview», round-N, phone
  screen, Calendly → по-прежнему INTERVIEW_INVITE.
- `npm test` зелёный (вкл. prettier `--check`).
- Мульти-агентное ревью (тир M): code-reviewer по диффу.
- Прототип-комментарий в начале `classifier.js` обновлён (sync-нота),
  запись в incidents.md про этот случай.
- BL-158 заведён на вторичный матчер-баг (письмо ушло не на ту вакансию).

## Открытые вопросы

- Вариант A / B / C — какой берём? (рекомендую C)
- Нужно ли в этом же PR добавить `share your availability` в
  forward-looking подсписок, или это отдельный кейс под отдельную
  фикстуру? (предлагаю не трогать в этом PR — нет подтверждённого
  инцидента, держим PR узким).
