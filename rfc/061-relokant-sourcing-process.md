# RFC 061 — Повторяемый процесс сорсинга relokant-sweet-zone компаний

- **Status:** Accepted (mechanism chosen by candidate 2026-06-23)
- **Created:** 2026-06-23
- **Tier:** M (новый skill + pure-хелпер + новый артефакт + docs; PII-данные в profiles/)
- **Related backlog:** BL-200 (этот RFC), BL-66 (outreach-канал), BL-199 (target-лист e-com), BL-201 (LinkedIn-нетворк-слой, потребитель targets.tsv)

## Problem

Канал «relokant sweet zone» (CIS-rooted, команда продукта+инженеров
по-прежнему русскоязычная, продаёт в US/EU, mid-size, НЕ глобализована)
дал первый невод 2026-06-22: 9 компаний в `ru_friendly_targets.tsv`.

Один ресёрч-пасс — не дно рынка. Чтобы канал жил, нужен **повторяемый
свип** по ещё-не-тронутым источникам с дедупом против двух списков:
уже-взятых (`ru_friendly_targets.tsv`) и уже-отсеянных
(`ru_friendly_rejects.tsv`, которого пока нет). Без памяти отсева каждый
прогон заново «открывает» Miro/Wrike и жжёт токены.

## Decision (механизм — выбран кандидатом 2026-06-23)

**Standalone Claude skill `relokant-sweep` с ручным запуском.** Не cron,
не engine CLI-команда. Причины:

- Свип — это **LLM-driven web-research + суждение** (классификация по
  sweet-zone, US-viability «сделает ли исключение как Virto»), а не
  детерминированный fetch. Не ложится на `engine/` discovery-паттерн
  (BL-200 явно выводит scan-движок из scope).
- Авто-cloud-агент крутил бы токен-тяжёлый research+LLM без глаза
  кандидата в моменте → риск галлюцинированных компаний. Ручной запуск
  держит человека в петле на дешёвой стадии.
- `/schedule` поверх того же скилла можно навесить позже как опцию, не
  меняя механику (каденс-напоминание раз в 2–4 недели — в docs, не в код).

**Дедуп — на коде, не на доверии к модели.** Маленький pure-хелпер
гарантирует, что LLM физически не дописывает уже-известное имя.

## Образ результата (наследует BL-200)

### 1. Новый артефакт `profiles/jared/ru_friendly_rejects.tsv`

Память отсева. Схема (TAB-separated, с заголовком):

```
name	reason	note	date
```

- `reason` ∈ `too_globalized | wrong_market | other`.
- Заполняется текущим отсевом (см. §Seed ниже).
- Гитигнорится как весь `profiles/jared/` (контракт репо).

### 2. Pure дедуп-хелпер `scripts/relokant/sweep_dedup.js`

Чистая функция + тонкий CLI. Никакого engine/, никакой сети.

- `normalizeName(s)` — lowercase, trim, схлопывание пробелов, отрезание
  легальных суффиксов (`inc`, `ltd`, `gmbh`), снятие диакритики — чтобы
  «Virto Commerce» == «virto commerce, inc.».
- `partitionCandidates(candidateNames, knownNames)` →
  `{ fresh: [...], dupes: [...] }`. Чистая, тестируемая.
- `loadKnownNames(targetsPath, rejectsPath)` — читает первую колонку
  обоих TSV (rejects может отсутствовать → пустой набор), возвращает
  нормализованный Set. Единственная I/O-точка.
- CLI: `node scripts/relokant/sweep_dedup.js <name1> <name2> ...`
  печатает, какие из переданных имён `FRESH`, какие `DUP`. Скилл зовёт
  его перед дозаписью.

Тест `scripts/relokant/sweep_dedup.test.js` — нормализация + партиция на
фикстурах (без файловой системы для чистых функций).

### 3. Skill `skills/relokant-sweep/SKILL.md`

Документированный workflow одного прогона:

1. **Load** — прочитать оба TSV → набор известных имён (через хелпер).
2. **Source rotation** — взять следующую пачку источников из ротации
   (трекать пройденное в `notes`-секции скилла или коротком state-файле
   `profiles/jared/.relokant-state/sources_log.md`):
   - релокант-трекеры;
   - VC-портфели с CIS-корнями (Runa Capital, Begin Capital,
     ex-Yandex/JetBrains/Wrike spinouts);
   - Crunchbase-фильтр founder-education CIS + HQ US/EU;
   - комьюнити (RAIN, RusBase, Telegram, tech-хабы Ереван/Тбилиси/Белград);
   - LinkedIn founder-search;
   - Habr-блоги компаний, выходящих global.
   Веб-ресёрч через `firecrawl_search` / `web_search_exa`.
3. **Classify** — каждый кандидат по 4 критериям sweet-zone + US-viability
   (софт-сигнал «сделает исключение как Virto», не «постит ли US-remote»).
4. **Dedup** — прогнать имена через хелпер; `DUP` отбросить молча.
5. **Append** —
   - sweet-zone (`FRESH`) → `ru_friendly_targets.tsv` (та же 10-колоночная
     схема), US-viable флагуется в `us_viability`;
   - отсев (`FRESH`) → `ru_friendly_rejects.tsv` с `reason`.
6. **Outreach** — по каждому новому US-viable: контакт (фаундер / Head of
   Product) + outreach-драфт (формат как для топ-3). **Только драфт,
   отправку делает юзер руками.**
7. **Report** — кратко: N исследовано, K новых sweet-zone, M отсеяно,
   сколько DUP отфильтровано.

### 4. Каденс

Раз в 2–4 недели, **ручной запуск** `/relokant-sweep`. В docs — пометка,
что при желании можно навесить `/schedule` поверх скилла. Авто-cron в
scope этого RFC не входит.

### 5. Docs

- `README.md` / `ARCHITECTURE.md` — упомянуть канал relokant + как
  запускать свип.
- Кросс-ссылка из `profiles/jared/job-search-strategy.md` (столп
  таргетинга) и `outbound-strategy.md`, если уместно.

## Seed для ru_friendly_rejects.tsv (текущий отсев)

| name | reason |
|---|---|
| Miro | too_globalized |
| Wrike | too_globalized |
| Ecwid (Lightspeed) | too_globalized |
| Preply | too_globalized |
| People.ai | too_globalized |
| inDrive | wrong_market |
| ID Finance | wrong_market |
| Skyeng | wrong_market |
| Refocus | wrong_market |
| YouTravel | wrong_market |
| Mate academy | wrong_market |

(UA-компании исключены из таргетинга решением юзера 2026-06-22 — Mate
academy сюда попадает как wrong_market/UA.)

## Out of scope

- Авто-отправка outreach (драфты да, отправка руками).
- Изменение scan-движка / discovery-адаптеров (`engine/`). Если свип
  потребует engine — отдельный RFC.
- Авто-cron через `/schedule` (опция на потом, не в этом RFC).
- Per-person CRM (это BL-201/BL-62).

## Definition of Done (= BL-200 DoD)

- [x] RFC с выбором механизма + approve.
- [ ] `ru_friendly_rejects.tsv` создан и заполнен seed-отсевом.
- [ ] `scripts/relokant/sweep_dedup.js` + тест (дедуп против обоих списков).
- [ ] `skills/relokant-sweep/SKILL.md` написан.
- [ ] Свип прогнан ≥1 раз, дедуп проверен, дал ≥1 новую sweet-zone компанию.
- [ ] Каденс задокументирован (ручной + опция /schedule).
- [ ] README / docs обновлены.

## Tests

- `sweep_dedup.test.js` — normalize (суффиксы, диакритика, регистр) +
  partition (fresh/dup на пересечении с known). Сеть не трогаем.

## Open questions

Нет. Механизм выбран; остальное — реализация.
