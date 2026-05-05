# RFC 013 — Profile-level geo enforcement across all ATS adapters

**Status**: Draft v2 — awaiting approval to start implementation
**Tier**: L (architectural — единый geo-контракт для всех 11 adapters + SKILL Step 3 refactor + миграция конфигов обоих профилей; per `DEVELOPMENT.md` требует RFC + approve до кода)
**Author**: Claude (sonnet), 2026-05-04
**Triggered by**:
- Incident 2026-05-02 — 485 Fresenius global jobs (Германия, Бразилия, Индия, …) попали в Лилин inbox при Roseville-only setup.
- L-4 в `docs/GAPS_REVIEW.md` (поглощает G-7).
**Depends on**: RFC 001 (multi-profile architecture). Не блокирует RFC 012 (relational data model).
**Replaces**: stub v1 этого же файла.

> Примечание: GAPS_REVIEW v текущей редакции называет этот документ «RFC-005». Это устаревшая ссылка — реальный номер `013` (005 занят `005-gmail-cron-autonomous-check.md`). Tracker будет поправлен в commit'е, закрывающем L-4.

---

## 1. Problem

Профиль декларирует свою локацию (`identity.location`, `preferences.locations_ok`, `preferences.work_format`), но **engine ничего из этого не использует** для глобальной фильтрации discovery. Решение принимается в трёх несинхронных местах:

1. **`engine/core/filter.js`** — поддерживает `location_blocklist` (substring deny-list с US-marker safeguard). Применяется ко всем 11 adapters в scan-time. Это **deny-list**, не whitelist — глобально отсечь регион нельзя.
2. **`engine/modules/discovery/indeed.js`** — единственный adapter, читающий `discovery.indeed.filters.location_whitelist` / `location_blocklist`. Только для Лили, только для Indeed feed'а.
3. **SKILL Step 3** — Claude по `jdText` принимает решение `geo: "us-compatible"` через WebFetch. Не использует `profile.geo`, не различает Лилину «Sacramento metro only» vs Джаредовскую «US-wide OK». Решение нестабильное (зависит от LLM-вывода) и ре-фетчит JD без необходимости.

Последствия:

- **Лиля**: 485 Fresenius global jobs (Германия / Бразилия / Индия) приходят как `geo: "us-compatible"` в SKILL Step 3, потому что `jdText` упоминает «US» где-то в boilerplate. Не релоцируется → блокер для боевого prepare.
- **Джаред**: 12 Workday tenants (PayPal, Capital One, Fidelity) показывают global postings → попадают в inbox с UK / Singapore / India локациями. Менее критично (он open to remote), но шум большой.
- **Любой следующий профиль**: при добавлении нового профиля придётся повторить hack про `discovery.indeed.filters.location_whitelist` или жить с deny-list-only.

## 2. Goals

- **Единый источник истины**: профиль декларирует geo один раз → все 11 adapters + validate retro-sweep + SKILL Step 3 уважают.
- **Положительная политика** (whitelist), не только deny-list. «Только Sacramento metro + Remote» нельзя выразить через `location_blocklist`.
- **Multi-profile корректно**: shared company target → каждый профиль фильтрует сам, никакого global state.
- **Back-compat**: отсутствие блока `profile.geo` = режим `unrestricted` = текущее поведение Джареда не меняется.
- **Детерминизм**: SKILL Step 3 не делает WebFetch — читает `prepare_context.batch[i].geo_decision` уже разрешённое engine'ом.
- **Закрывает G-33** как побочный эффект (retro-sweep начинает уважать positive geo policy после миграции TSV location).

## 3. Non-goals

- **Distance API / driving time**: только match по списку cities/states. `max_radius_miles` в этом RFC — поле schema'ы для будущей геокод-интеграции, в v1 не используется (см. §10).
- **Server-side фильтр в adapters**: универсальный post-fetch фильтр в `filter.js` работает для всех 11. Workday `appliedFacets` UUIDs / Indeed `?l=&radius=` URL params — отдельный backlog item для оптимизации трафика, не часть L-4.
- **Refactor `preferences.locations_ok` / `discovery.indeed.filters.*`**: оба остаются в схеме до миграции (deprecated, читаются как fallback). Удаление — отдельный cleanup commit после стабилизации.
- **Geocoding cities в координаты**: вне scope.
- **Cover letter / resume customization по локации**: separate concern.

## 4. Proposed solution

### 4.1 Schema — `profile.json.geo` block

```jsonc
"geo": {
  "mode": "metro" | "us-wide" | "remote-only" | "unrestricted",

  // Required when mode === "metro". Substring match (case-insensitive).
  // Каждый city — minimal token, который должен встретиться в job.location.
  "cities": ["Sacramento", "Roseville", "Folsom", "Rocklin", "Citrus Heights",
             "Elk Grove", "Auburn", "Rancho Cordova", "Davis", "West Sacramento",
             "Carmichael", "Fair Oaks"],

  // REQUIRED when mode === "metro" (resolved 2026-05-04 — open question §8.1
  // closed: states обязательны, чтобы исключить города-двойники типа
  // Auburn (CA / AL / NY / WA) или Springfield. Profile_loader бросает
  // ValidationError при metro mode без states.
  "states": ["CA"],

  // Required when mode === "us-wide". ISO codes.
  "countries": ["US"],

  // Optional. Default = false (Lilia: false, Jared: true).
  // true = job с location, содержащим "Remote" / "Anywhere" / "Work from home",
  // проходит независимо от cities/states/countries.
  "remote_ok": false,

  // Optional. Substring deny-list, поверх позитивной политики. Дублирует
  // `filter_rules.location_blocklist` намеренно (чтобы geo-блок был
  // самодостаточен), engine читает обе и объединяет.
  "blocklist": ["Napa", "Stockton", "Lodi", "Vacaville", "Modesto"],

  // Reserved для будущего geocoding. В v1 НЕ используется. Документируется
  // в schema, чтобы добавление не было breaking change.
  "max_radius_miles": null
}
```

**Режимы**:

| mode | Семантика | Кому |
|---|---|---|
| `metro` | job.location должен содержать любой из `cities` (case-insensitive substring). Если `states` непуст — также любой из `states`. `remote_ok` опционально пропускает remote-роли. | Lilia |
| `us-wide` | job.location должен содержать US/USA marker (любой из `US_MARKERS` из `filter.js`) ИЛИ быть в одном из `countries` через ISO/state hint. `remote_ok` опционально пропускает «Remote». | (опционально для Джареда — alt to `unrestricted`) |
| `remote-only` | job.location должен содержать «Remote» / «Anywhere» / «Work from home». Cities/states игнорируются. | Будущие remote-only профили |
| `unrestricted` | Geo не enforces. Применяется только `blocklist` (если задан) и `filter_rules.location_blocklist`. | Jared (back-compat) — текущее поведение |

**Default**: блок `profile.geo` отсутствует ⇒ режим `unrestricted` (нулевая регрессия).

### 4.2 Архитектурные слои

```
profile.json.geo  ─────────► profile_loader.normalizeGeo()
                                       │
                                       ▼
                               profile.geo (canonical)
                                       │
       ┌───────────────────────────────┼─────────────────────────────────┐
       ▼                               ▼                                 ▼
scan.js (filterJobs:            prepare.js (pre-phase):           validate.js (retro-sweep):
  rules.geo = profile.geo)         entry.geo_decision               matchBlocklists +
       │                                │                          enforceGeo per row
       ▼                                ▼                                 │
engine/core/filter.js          engine/core/geo_enforcer.js                ▼
  matchBlocklists()              enforceGeo(job, profile.geo)      retro-sweep уважает
       │                                │                          positive geo policy
       ▼                                ▼                          (закрывает G-33)
  enforceGeo(job, rules.geo)    prepare_context.batch[i].
       │                          geo_decision: "allowed" |
       ▼                          "rejected" + reason
  reject reason: "geo_metro_miss" /
  "geo_country_miss" / "geo_blocklist"
```

**Один enforcer**, три call-site'а. Adapters не трогаются — продолжают возвращать `NormalizedJob` с массивом `locations[]`. Filter.js маппит `locations[0]` в `location` (как сейчас) — но в v2 RFC будет читать **все** `locations[]` и пропускать job если хотя бы один элемент проходит geo-policy (важно для multi-location postings типа `["Sacramento, CA", "Remote", "Hybrid"]`).

### 4.3 Новый модуль `engine/core/geo_enforcer.js`

Pure function (testable, no I/O):

```js
/**
 * @param {string[]} jobLocations  Массив локаций job'а (NormalizedJob.locations[]).
 * @param {object}   profileGeo    Canonical блок из profile.geo (после normalizeGeo).
 * @returns {{ ok: boolean, reason: string | null, matchedBy: string | null }}
 *   ok=true  → job проходит. matchedBy = "city:Sacramento" / "remote" / "country:US" / "unrestricted".
 *   ok=false → reason ∈ { "geo_metro_miss", "geo_country_miss", "geo_remote_only_miss",
 *                          "geo_blocklist", "geo_no_location" }.
 *
 * Семантика "geo_no_location": job без locations[] (пустой массив или все строки
 * пустые). В режиме `unrestricted` — пропускаем (ok=true). В остальных — отклоняем.
 */
function enforceGeo(jobLocations, profileGeo) { … }
```

### 4.4 Wiring изменения

#### `engine/core/profile_loader.js`
- Новый `normalizeGeo(profileRaw)`: валидирует `profile.geo` (mode required, cities required для `metro`, countries required для `us-wide`), бросает на invalid shape, возвращает canonical блок. Отсутствие `profile.geo` ⇒ `{ mode: "unrestricted" }`.
- `loadProfile()` вызывает `normalizeGeo` и кладёт результат в `profile.geo` (mutate canonical, как уже делают `normalizeFilterRules` / `loadMemory` / `loadSalary`).

#### `engine/core/filter.js`
- В `matchBlocklists(job, rules)` после существующих deny-list checks добавить `enforceGeo(job.locations || [job.location], rules.geo)` если `rules.geo.mode !== "unrestricted"`. Reject reason `{kind: "geo_<reason>"}`.
- Сигнатура `filterJobs(jobs, rules, counts)` остаётся прежней — caller (scan.js) подмешивает `rules.geo = profile.geo` перед вызовом.
- `filterInputs` map в `scan.js` обновляется: вместо `location: locations[0]` передаём `locations: j.locations`. Filter учится читать оба поля (`job.locations || [job.location]`) — back-compat для тестов и старых кодпатей.

#### `engine/commands/prepare.js` (pre-phase)
- После filter (но перед URL-check) для каждого entry вызывается `enforceGeo(entry.locations || [entry.location], profile.geo)`.
- Результат сохраняется в `entry.geo_decision = enforceGeo(…).ok ? "allowed" : "rejected"` + `entry.geo_reason = enforceGeo(…).reason`.
- Если `geo_decision === "rejected"` — entry попадает в `prepare_context.stats.skipReasons[geo_<reason>]++` и НЕ попадает в `batch[]` (skip по существующему механизму).
- Если `unrestricted` — `geo_decision = "allowed"`, `geo_reason = null` (поля всё равно проставлены — для аудита и SKILL).

#### `engine/commands/validate.js` (retro-sweep)
- `RETRO_SWEEP_STATUSES` — без изменений.
- В цикле re-screen после `matchBlocklists` дополнительный вызов `enforceGeo([app.location], profile.geo)` (TSV хранит одну строку location). Reject → формирует `reason = {kind: "geo_<reason>"}`.
- `formatReason` дополняется case'ами `geo_metro_miss` / `geo_country_miss` / `geo_remote_only_miss` / `geo_no_location`.
- `--apply` поведение неизменно — archives row, как делает сейчас.

#### `skills/job-pipeline/SKILL.md` Step 3
Текущий текст ("Geo-decision: Claude WebFetch'ит JD, помечает as `us-compatible` / `non-us` / `unknown`, …") заменяется на:

> **Step 3 — Geo decision (now profile-driven)**
>
> Engine pre-phase already populated `prepare_context.batch[i].geo_decision`:
> - `"allowed"` → job passes profile geo policy. **No WebFetch needed.** Continue to Step 4.
> - `"rejected"` → engine already pruned this entry from the batch. (You won't see it.)
>
> Legacy fallback (for old `prepare_context.json` без `geo_decision` поля): WebFetch JD location и применить простую US-policy. Поле `geo_decision` всегда заполнено начиная с engine version пост-L-4 — fallback оставлен на случай ре-консьюминга старых контекстов.

#### Discovery adapters (11 шт)
**Не трогаются.** Universal post-fetch фильтр в `filter.js` работает для всех. `discovery.indeed.filters.location_whitelist` остаётся в Лилином `profile.json` как **deprecated** (читается indeed adapter'ом для server-side narrowing — экономит API-запросы на стороне Indeed; финальная фильтрация всё равно проходит через `filter.js` + `enforceGeo`).

Удаление `indeed.filters.*` — отдельный cleanup в follow-up commit'е (когда подтвердим что server-side filter в indeed.js не нужен — он мог давать false negatives).

### 4.5 Migration plan

**Шаг 1**: добавить блок `profile.geo` обоим профилям.

Lilia (`profiles/lilia/profile.json`):
```jsonc
"geo": {
  "mode": "metro",
  "cities": [
    "Sacramento", "Roseville", "Folsom", "Rocklin", "Citrus Heights",
    "Elk Grove", "Auburn", "Rancho Cordova", "Davis", "West Sacramento",
    "Carmichael", "Fair Oaks"
  ],
  "states": ["CA"],
  "remote_ok": false,
  "blocklist": ["Napa", "Stockton", "Lodi", "Vacaville", "Modesto"]
}
```

Jared (`profiles/jared/profile.json`):
```jsonc
"geo": {
  "mode": "unrestricted",
  "remote_ok": true
}
// или вообще не добавлять блок — engine default = unrestricted, parity 1-в-1.
```

→ Для commit'а beпредпочтём **явно** прописать `unrestricted` Джареду — для self-documentation. Поведение идентично пропуску блока (zero behavior change, проверяем тестами).

**Шаг 2**: backfill TSV location.
- TSV schema v3 (G-5) уже carries `location`. Backfill для существующих rows из master pool jobs.tsv (по `job_url`-ключу) — частично уже сделано в G-5 (Jared 2186/2897, Lilia 94/425).
- Дополнительный sweep после внедрения geo: rows с пустым location остаются нетронутыми (enforceGeo при empty location в `metro` mode → `geo_no_location` reject). User решает archives ли их через `validate --apply`.

**Шаг 3**: live retro-sweep dry-run для обоих профилей. Ожидаем:
- Lilia: ~30-50 rows из остального ~1100 в pipeline'е попадут в `geo_*` reject (старые out-of-metro rows).
- Jared: 0 rows (mode unrestricted).

**Шаг 4**: после approve dry-run output — `validate --apply` для Лили.

**Шаг 5**: `discovery.indeed.filters.location_whitelist` — оставить на месте, не удалять. Cleanup отдельным PR.

### 4.6 Test plan

**Unit**:
- `engine/core/geo_enforcer.test.js` (новый) — ~25 тестов:
  - 4 mode'а × ok/reject path × variations (multi-locations, remote_ok, states narrowing, blocklist, US-marker matching, empty locations).
  - Edge cases: location strings типа `"Sacramento, CA / Remote"`, `"Hybrid - Sacramento"`, `"United States"` без cities, `"Auburn, AL"` (Алабамский Auburn — отсекается через `states: ["CA"]`).
- `engine/core/profile_loader.test.js` — расширение: `normalizeGeo` defaults / validation errors / canonical shape.
- `engine/core/filter.test.js` — расширение: `rules.geo` интеграция, multi-locations support.
- `engine/commands/prepare.test.js` — расширение: `entry.geo_decision` populated, rejected entries не попадают в batch, stats.skipReasons имеют geo-counters.
- `engine/commands/scan.test.js` — расширение: `filterInputs` передаёт `locations[]`, geo-rejected jobs идут в `Archived`/`filter_rejections.log` корректно.
- `engine/commands/validate.test.js` — расширение: retro-sweep учитывает geo, `formatReason` для geo-кейсов.

**Parity (Jared zero regression)**:
- Smoke: scan → prepare pre-phase → validate. Counts должны совпадать с предыдущим запуском (зафиксируем в `docs/regression_baseline.md`).
- Dry-run validate retro-sweep на текущей TSV → 0 archived rows.

**Live smoke (после approve)**:
- Lilia: scan dry-run → number of `geo_*` rejects логируется.
- Lilia: validate retro-sweep dry-run → list candidates.
- User approve → validate --apply.

### 4.7 Acceptance criteria (DOD)

1. `profile.json.geo` schema валидируется в `profile_loader`, ошибки — clean message.
2. `geo_enforcer.js` экспортирует `enforceGeo(locations, profileGeo)`. ≥25 тестов passing.
3. `filter.js`, `prepare.js`, `validate.js` учитывают geo enforcer.
4. SKILL Step 3 переписан на чтение `prepare_context.batch[i].geo_decision`.
5. Lilia + Jared `profile.json` имеют блок `geo` (Lilia: metro, Jared: unrestricted).
6. Все существующие тесты passing (843+25 = 868+).
7. Jared smoke parity: scan output identical (counts равны), validate retro-sweep dry-run = 0 archived.
8. Lilia validate retro-sweep dry-run output показан пользователю → approve → apply.
9. GAPS_REVIEW трекer: L-4 → Done с commit hash. G-7 закрывается отметкой «поглощено L-4».
10. Открытие RFC 005 (gmail-cron) не задевается — `005-gmail-cron-autonomous-check.md` не трогается.

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Лиля теряет валидные роли с `location: "Hybrid"` без явного city | enforceGeo матчит ВСЕ `locations[]`; если хотя бы один проходит — job пропускается. JD типа `["Sacramento, CA", "Hybrid"]` → проходит по cities. |
| Multi-location postings типа `["San Francisco / Sacramento / Los Angeles"]` парсятся как одна строка | normalize.js уже splittит. Если adapter возвращает single string — filter.js fallback `[job.location]` всё равно даст один shot — substring match найдёт «Sacramento». |
| Jared parity сдвигается из-за `unrestricted` mode subtly | Регрессия-тесты + ручной diff scan output до/после. `unrestricted` mode = enforcer возвращает `ok: true` без проверок (только blocklist, который у Джареда пуст). |
| Auburn ambiguity (CA vs AL vs NY) | `states: ["CA"]` narrowing требуется в metro mode. Если states пуст — match по cities only (тогда False positives от Auburn AL возможны, но низкочастотны и ловятся blocklist'ом по штату/стране). |
| TSV rows с empty `location` после backfill в metro mode | enforceGeo возвращает `geo_no_location` reject. Validate retro-sweep — show only, --apply переводит в Archived. User видит список и решает per-row. |
| Indeed adapter дублирует фильтрацию (server-side `radius=25` + post-filter geo_enforcer) | Намеренно: server-side экономит API-traffic, post-filter — safety net. Cleanup отдельным PR после стабилизации. |

## 6. Rollback

- Merge без `geo` блока в `profile.json` обоих профилей: engine default = `unrestricted` → no-op.
- Если post-merge regression обнаружится — revert одного commit'а, поведение возвращается к pre-L-4 (filter.js — deny-list only).
- Backfilled TSV `location` поля — additive, ничего не теряется.

## 7. Implementation steps (sequential)

После approve пользователя:

1. `engine/core/geo_enforcer.js` + tests.
2. `engine/core/profile_loader.js`: `normalizeGeo` + integration.
3. `engine/core/filter.js`: `matchBlocklists` подключает enforcer; multi-locations support.
4. `engine/commands/scan.js`: `filterInputs` передаёт `locations[]`; smoke на Jared (parity).
5. `engine/commands/prepare.js`: pre-phase populates `entry.geo_decision`.
6. `engine/commands/validate.js`: retro-sweep учитывает enforcer; `formatReason` updates.
7. `skills/job-pipeline/SKILL.md` Step 3 переписан.
8. `profiles/lilia/profile.json` + `profiles/jared/profile.json`: добавить `geo` блок.
9. Все тесты passing. Live dry-run для Лили — output показан пользователю.
10. GAPS_REVIEW v3: L-4 → Done, G-7 → закрыт «поглощено L-4», ссылка на RFC 013 (не 005).
11. Commit C `feat(geo): profile-level geo enforcement across all adapters (L-4, RFC-013)`. Push после approve.

## 8. Resolved decisions (2026-05-04 approve-цикл)

1. ✅ **`states` narrowing для metro mode**: **REQUIRED**. `profile_loader.normalizeGeo` бросает ValidationError при `mode === "metro"` без непустого массива `states`. Защита от городов-двойников.
2. ✅ **`remote_ok` matching**: по `job.locations[]` (структурное поле). Парсинг JD на «hybrid» / «remote-friendly» — out of scope L-4.
3. ✅ **`max_radius_miles` в schema**: **оставлено** как reserved-null поле для будущего geocoding (не breaking change).
4. ✅ **`indeed.filters.location_whitelist`**: **оставлено** deprecated. Indeed adapter продолжает читать для server-side narrowing, post-filter в `filter.js` — safety net. Cleanup отдельным PR после стабилизации.
5. ✅ **TSV rows с пустым `location`**: **не пытаемся ре-геокодить**. В metro mode → `geo_no_location` reject. User через `validate --apply` переводит в Archived (как в Stage 15).
6. ✅ **Jared geo block**: **explicit** `{"mode": "unrestricted", "remote_ok": true}` для self-documentation (не пустой блок). Behavior идентичен пропуску блока.
7. ✅ **Multi-location matching (job.locations[])**: job проходит, если **хотя бы одна** локация удовлетворяет policy (важно для multi-city postings типа `["Sacramento, CA", "Hybrid"]`).

## 9. Ссылки

- Incident 2026-05-02 — root cause report (485 Fresenius).
- [GAPS_REVIEW.md L-4](../docs/GAPS_REVIEW.md) — высокоуровневое описание гэпа.
- [RFC 010 — Lilia Workday activation](./010-lilia-workday-activation.md) — `locationAllow` per-target будет deprecated в favor `profile.geo`.
- [RFC 012 — Relational data model](./012-relational-data-model.md) — orthogonal, не блокирует L-4.
- [DEVELOPMENT.md](../DEVELOPMENT.md) — Tier L требует RFC + approve до кода.

## 10. Future work (вне scope L-4)

- **Geocoding cities**: интегрировать Nominatim / Google Geocode для расчёта реальных distances. `max_radius_miles` начинает работать.
- **Server-side adapter optimization**: Workday `appliedFacets.locationCountry`, Greenhouse `?office=`, Lever `?location=`, Ashby `?locationName=`, SmartRecruiters `?location=`. Сократит входящий трафик на 30-70%.
- **Parsing JD для inferred geo**: «hybrid 2 days/week in NYC» → state machine extracts city. Сложно и нестабильно — не делаем без сильного ROI.
- **Per-target overrides**: companies.tsv колонка `geo_override` (например, Лиля разрешает одну remote-friendly компанию вне metro). Когда понадобится.
