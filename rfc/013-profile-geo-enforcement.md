# RFC 013 — Profile-level geo enforcement across all ATS adapters

**Status**: Draft (stub — to be expanded in fresh session)
**Tier**: M (новое поле в profile.json + post-fetch фильтр + adapter-specific server-side оптимизация)
**Author**: Claude + repo owner
**Triggered by**: incident 2026-05-02 — 485 Fresenius global jobs (Германия, Бразилия, Индия, ...) попали в Лилин inbox при том что её локация Roseville, CA задана в profile.json.
**Зависит от**: [RFC 012 — Relational data model](./012-relational-data-model.md) (после нормализации legко прокидывать `profile.geo` через все командs).

## Проблема

Локация профиля **есть** в `profile.json.identity.location` ("Sacramento, CA" / "Roseville, CA"), но **никакой код её не использует** для фильтрации discovery. Каждый adapter сам решает.

В RFC 010 я добавил `locationAllow` per-target в companies.tsv для Лили (tactical fix) — но это
- (a) per-target ручной конфиг, не глобальный для профиля
- (b) применимо только к Workday adapter
- (c) Jared'а не покрывает (PayPal/Capital One (WD)/Fidelity — глобальные tenants без гео-фильтра у Jared'а — у него та же дыра)

## Целевое поведение

Профиль декларирует geo один раз → engine енфорсит для **всех** adapters:

```jsonc
// profile.json
"geo": {
  "countries": ["US"],          // ISO codes
  "regions": ["California"],    // optional state/region narrowing
  "cities": [                    // commute radius — пустой = вся страна/регион
    "Roseville", "Rocklin", "Folsom", "Sacramento", "Elk Grove",
    "Davis", "Auburn", "Carmichael", "Fair Oaks", "Yuba City"
  ],
  "remote": "us-only"            // "us-only" | "any" | "none"
}
```

## Архитектурные слои

1. **`engine/core/geo.js`** (new) — pure matcher: `geoMatches(jobLocations, profileGeo) → bool`. Тесты на разные форматы locationsText.
2. **Server-side оптимизация в adapters** (где API позволяет — fetch меньше mусора):
   - Workday: `appliedFacets.locationCountry` + `locations` UUIDs (RFC 010 уже частично)
   - Indeed: `?l=City%2C+ST&radius=N` URL params
   - Greenhouse: `?office=...` filter (где tenant выставил offices)
   - Lever: `?location=...`
   - Ashby: `?locationName=...`
   - SmartRecruiters: `?location=...`
   - RemoteOK: country filter
   - CalCareers: уже California-only (no-op)
3. **Universal post-fetch фильтр в `engine/core/scan.js`** — safety net применяется ко всем job's до записи в TSV. Adapters могут не реализовать server-side — фильтр всё равно сработает.
4. **Migration** — `profile.geo` заполняется для Jared (US-only, remote OK) и Lilia (Sacramento area, onsite preferred). Текущий Лилин `locationAllow` per-target в companies.tsv удаляется (становится частным случаем `profile.geo`).

## Плюсы перед текущим (RFC 010 part)

- Один источник истины. Добавил target — он автоматически уважает гео профиля.
- Рfaмки не дублируются между targets.
- Multi-profile корректно: shared company target → каждый профиль фильтрует сам.

## Plan / open questions

- Как `geo.regions` взаимодействует с `geo.cities`? "ИЛИ" (любой match) или "И" (city in region)?
- Workday `appliedFacets` — UUIDs tenant-specific. Нужен helper-script `scripts/workday_facet_uuids.js <slug>` для discovery (см. backlog-3 в incident report 2026-05-02).
- Remote роли: как matcher определяет что job IS remote? `locations` содержит "Remote" / "Anywhere" / специальный флаг от адаптера?
- Per-target overrides: что если Лиля хочет одну компанию вне commute radius (например remote-friendly)? Нужен ли opt-out на уровне profile_companies join (RFC 012)?

## Out of scope

- Дистанция в милях / driving time API. Только по списку cities/regions.
- Гео для cover letter / resume customization (separate concern).

## Ссылки

- Inцидент 2026-05-02 — root cause report в этой сессии (transcript).
- [RFC 010 — Workday tenants для Лили](./010-lilia-workday-activation.md) — `locationAllow` per-target будет poглощён.
- [RFC 012 — Relational data model](./012-relational-data-model.md) — этот RFC реализуется поверх 012.
