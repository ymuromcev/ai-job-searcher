---
id: RFC-007
title: Industries as relations between Companies and Profiles
status: superseded
tier: L
created: 2026-04-30
decided: 2026-04-30
superseded-by: RFC-008
tags: [companies, industries, schema]
---

# RFC 007 — Industries as relations between Companies and Profiles

**Status**: Superseded by [RFC 008](./008-companies-as-notion-source-of-truth.md) on 2026-04-30
**Tier**: L (миграция данных, рефактор scan/check/prepare/sync, тестирование на 2+ профилях)
**Author**: Claude + Jared Moore
**Зависит от**: [RFC 006 — email-check per-profile companies](./006-email-check-per-profile-companies.md) (должен быть прогнан и стабилен)

## Проблема

Текущая архитектура companies-per-profile не масштабируется:

- Глобальная `data/companies.tsv` де-факто специализирована под Jared (250 fintech).
- Лилины компании (75 healthcare) живут внутри её `profile.json.discovery.companies_whitelist` — это конфиг, а не БД.
- Добавление третьего профиля (например HR/recruiter, design lead) требует либо раздувания whitelist в profile.json, либо добавления его компаний в общий companies.tsv (где они смешаются с fintech).
- В `profile.json.target_industries` уже есть теги индустрий, но они нигде не используются для фильтрации.

Каждая команда (`scan`, `check`, `prepare`, `sync`) сейчас должна вручную решать "какие компании для какого профиля" — это даёт ветвящуюся логику и риск рассинхрона между командами.

## Целевая архитектура

```
data/companies.tsv:
  name | ats_source | ats_slug | industries | extra_json
  Affirm           | greenhouse | affirm        | fintech, lending, credit |
  Stripe           | greenhouse | stripe        | fintech, payments        |
  Kaiser Permanente| indeed     | kaiser-sac    | healthcare, hospitals    |
  Cameron Park Dental Office | manual | -       | healthcare, dental       |
  ...

profile.json:
  target_industries: ["fintech", "banking", "credit", "lending"]   # Jared
  target_industries: ["healthcare", "dental", "vision", "hospitals"] # Lily

единая функция в engine/core/companies.js:
  function companiesForProfile(profile, allCompanies) {
    const targetSet = new Set(profile.target_industries.map(i => i.toLowerCase()));
    return allCompanies.filter(c => 
      (c.industries || []).some(i => targetSet.has(i.toLowerCase()))
    );
  }
```

Все команды используют `companiesForProfile()` — никаких per-profile веток.

## Ключевые задачи

1. **Industry taxonomy** — выработать справочник тегов (≤30 штук): `fintech`, `banking`, `credit`, `lending`, `payments`, `crypto`, `insurance`, `wealth_mgmt`, `healthcare`, `dental`, `vision`, `hospitals`, `dermatology`, `physical_therapy`, и т.д. Хранить в `data/industries.json` с описанием каждого.

2. **Миграция `data/companies.tsv`**:
   - Добавить колонку `industries` (comma-separated).
   - LLM-классифицировать существующие 250 fintech компаний → проставить теги.
   - Импортировать 75 Лилиных healthcare-компаний из её whitelist в `companies.tsv` с тегами.
   - Удалить `companies_whitelist` из её `profile.json` (или оставить как override).

3. **Рефактор кода**:
   - `engine/core/companies.js` — добавить `companiesForProfile(profile, allCompanies)`.
   - `engine/commands/scan.js` — переключить с `applyTargetFilters(whitelist/blacklist)` на `companiesForProfile`.
   - `engine/commands/check.js` — переключить `buildCompanySet` (RFC 006) на `companiesForProfile`.
   - Сохранить `companies_whitelist` как opt-in override (если задан — приоритет).
   - `companies_blacklist` — оставить как фильтр-исключение поверх industry-match.

4. **Тестирование**:
   - Регрессия по Jared: scan/check возвращают тот же или больший company set, чем сейчас.
   - Регрессия по Lily: scan/check возвращают её 75 healthcare без потерь.
   - Новый профиль (synthetic) — добавить через 1 строку target_industries, проверить что ничего не ломается.

5. **Backfill industries для applications.tsv** (опционально): проставить industry-теги к историческим companyName в applications.tsv для последующей аналитики ("сколько откликов по индустриям").

## Связанные изменения

- LLM-классификатор для индустрий (одноразовый скрипт): берёт name + ats_source + URL → выдаёт массив industries из таксономии.
- Миграция `applications.tsv` (optional): не обязательна для функциональности check/scan, но даёт аналитику.
- Документация: README про industry-tags и как добавлять новые.

## Риски

- **LLM-классификация может ошибаться** на edge cases (Capital One = banking? credit? оба?). Нужно ручное ревью пользователем после первого прогона.
- **Conflicting tags**: компания может фитить в несколько индустрий. Решение — массив, ANY-match.
- **Как быть с компаниями без industries** (не успели разметить) — fallback на whitelist override или текущий companies_whitelist mechanism.
- **Breaking change для других команд**, использующих `applyTargetFilters`. Нужна аккуратная миграция в одном PR.

## Open questions (требуют ответа пользователя до полной версии RFC)

1. Industry taxonomy — фиксированный список или free-form? Если фиксированный — насколько детальный (3 уровня иерархии или плоский)?
2. Поведение если компания не имеет industries — включать в выдачу `companiesForProfile` (warn) или скрывать (silent)?
3. Миграция Лилиных компаний — все 75 в `companies.tsv` или только те, что уже привлекли её внимание (через applications.tsv)?
4. `target_industries` в profile.json — точное совпадение или иерархическое (`fintech` matches `fintech.lending`)?
5. Когда планируем — после стабильного email-check (RFC 006) или параллельно?

## Acceptance criteria (черновик)

- [ ] Все команды (`scan`, `check`, `prepare`, `sync`) используют единый `companiesForProfile()`.
- [ ] Удалены ветки "если jared X иначе Y" во всём engine.
- [ ] Регрессия: для Jared нет потерь компаний vs текущее поведение.
- [ ] Регрессия: для Lily нет потерь компаний vs текущее поведение.
- [ ] Новый профиль (synthetic test) — добавляется через 1 строку конфига.
- [ ] LLM-классификация прогнана + результат отревьюен пользователем.
- [ ] README про industry-tags обновлён.

---

**Status**: Stub. До полной готовности RFC требуется:
1. Ответы пользователя на open questions выше.
2. Решение пользователя о таймлайне (после RFC 006 / параллельно / отложить).

Пока не доработан до Approved — реализация blocked.
