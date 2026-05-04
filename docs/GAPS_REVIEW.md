# Gaps Review — user-facing backlog

Все 33 гэпа из SPEC, в формате «что сейчас / что станет», без техники. Для триажа перед Phase 3.

Severity:
- **High** — реальный риск регрессии или потери качества (1 активный, 1 закрыт 2026-05-04).
- **Medium** — поведение работает, но отклоняется от ожиданий или заложена мина (4 активных, 6 закрыто 2026-05-04).
- **Low** — мелкая шероховатость в DX или edge case (9 активных, 3 закрыты 2026-05-04).
- **Trivial** — косметика / документационная зацепка (7 активных, 2 закрыты 2026-05-04).

Цена fix'а:
- **XS** — несколько строк, без RFC.
- **M** — пара файлов + тесты, в рамках дня.
- **L** — архитектурное изменение, требует RFC.

---

## High (2)

### G-7 — Geo-фильтр неполный
- **Сейчас**: только Workday умеет фильтровать по локации, и то через per-target конфиг. Если профилю реально нужно отсечь, скажем, Европу или гибрид-с-обязательным-офисом — это сделать негде. У Jared сейчас geo-предпочтение «бери всё» (это ок), но у Lilia geo критичен (no-relocate, конкретный регион), и engine не умеет это выразить.
- **Станет**: профиль декларирует geo-предпочтение один раз (`geo_preference: any` для Jared, конкретные правила для Lilia); все 11 адаптеров уважают его автоматически.
- **Цена**: L (нужен RFC, единая модель geo, миграция конфигов).

### G-17 — Cover letter генерируется с нуля каждый раз
- **Сейчас (закрыто 2026-05-04)**: SKILL Step 8 переписан в template-first flow. Claude находит ближайший подходящий entry в `cover_letter_versions.json` (template-variants shape для Lilia или library-of-letters shape для Jared), копирует proof-параграфы (P2 + P3) verbatim, перегенерирует только company-specific параграфы (P1 hook + при необходимости P4 close), и применяет Humanizer только к новому тексту. Tone стабильный по всему батчу (proof identical), tokens примерно вдвое меньше. `clBaseKey` записывается в results.json для аудита (видно, какие письма реюзают одну базу).
- **Цена**: M. **Closed 2026-05-04**.

---

## Medium (10)

### G-1 — Статус «To Apply» означает две разные вещи
- **Сейчас**: «To Apply» используется и для свежих находок после scan, и для готовых к отправке. По коду они разделены двумя guard'ами, но семантически путано.
- **Станет**: явные раздельные состояния (например, «New» → «To Apply»). Понятно по статусу, что с записью делать.
- **Цена**: L (миграция статусов в Notion + код).

### G-3 — Title requirelist не работает централизованно
- **Сейчас**: список «обязательных слов в названии роли» поддержан в конфиге, но фактически каждый адаптер фильтрует по-своему inline. Поведение fragmented.
- **Станет**: requirelist обрабатывается в одном месте, все адаптеры одинаково его уважают.
- **Цена**: M.

### G-4 — Кросс-платформенные дубли проскакивают
- **Сейчас**: одна и та же вакансия с GH и Lever может попасть в pipeline дважды, если URL отличается. Fuzzy-сравнение по нормализованному названию написано, но не используется.
- **Станет**: одна вакансия = одна запись, независимо от платформы.
- **Цена**: XS (включить уже написанный нормализатор в dedup).

### G-10 — SKILL переспрашивает про размер батча
- **Сейчас (закрыто 2026-05-04)**: SKILL Step 2 говорит «Proceed without confirmation — the CLI's `--batch N` flag already gates batch size; Claude does not re-prompt the user». Default 30; для другого размера — re-run pre-phase с `--batch <N>`.
- **Цена**: XS. **Closed 2026-05-04**.

### G-11 — SKILL переспрашивает про unknown tier
- **Сейчас (закрыто 2026-05-04)**: SKILL Step 5.7 «Auto-tier unknown companies» — Claude назначает S/A/B/C сам по profile-flavor критериям (Jared: AI-native big-tech / fintech vs early-stage; Lilia: regional health systems vs single-clinic). Результаты идут в `results.companyTiers`, commit-фаза персистит в `profile.json.company_tiers` (one-shot per company). Без user prompts.
- **Цена**: M. **Closed 2026-05-04**.

### G-15 — Unknown tier тихо проскакивает на этап SKILL
- **Сейчас (закрыто 2026-05-04)**: часть G-11. Каждый batch entry без tier'а попадает в `prepare_context.unknownTierCompanies`; SKILL Step 5.7 обязан назначить до commit'а; commit gate (`prepare.js` validates against `VALID_TIERS = {S,A,B,C}`) персистит. Состояние «silent pass-through» больше не существует.
- **Цена**: XS (часть G-11). **Closed 2026-05-04**.

### G-18 — Claude может выбрать несуществующий резюме-архетип
- **Сейчас (закрыто 2026-05-04)**: SKILL Step 7 имеет explicit Mandatory validation block: `resumeVer` MUST be a key in `profile.resume_versions.versions`; «Do NOT invent or paraphrase a key. If no archetype is a clear match, pick the closest existing key (or the profile's default if defined)». Backstop в `prepare --phase commit` ловит leakage (`updates.invalidArchetype` counter, downgrades to `skip` с warning'ом).
- **Цена**: XS. **Closed 2026-05-04**.

### G-21 — Notion-страницы создаются дважды разными путями
- **Сейчас (закрыто 2026-05-04)**: фикс пошёл по противоположному маршруту, чем планировалось. Вместо «один путь через sync push» удалили sync push целиком (commit `4f85ed2`); единственный путь создания страниц — `prepare` commit phase. SKILL вызывает CLI, MCP-side не пушит напрямую.
- **Цена**: M. **Closed 2026-05-04** (sync refactor: pull-only).

### G-22 — Часть полей пушится в обход CLI
- **Сейчас (закрыто 2026-05-04)**: вместе с G-21 — `sync` больше ничего не пушит, все поля идут через `prepare` (включая Notes / Fit Score / Date Added / Work Format / City / State). Маппинг живёт в одном месте — `engine/commands/prepare.js` commit-фаза.
- **Цена**: M. **Closed 2026-05-04** (часть G-21).

### G-33 — Retro-sweep не проверяет локацию
- **Сейчас**: при изменении filter rules `validate` пересматривает существующие записи на title/company, но не на локацию (потому что локация не хранится в TSV).
- **Станет**: после фикса G-5 (location в TSV) sweep пересматривает и локации тоже.
- **Цена**: XS (зависит от G-5).

---

## Low (12)

### G-2 — Slash в названии роли разбивается на варианты
- **Сейчас**: при оценке фильтрами title с `/` (например, «Receptionist/Office Manager») разбивается на части — если хотя бы одна часть проходит blocklist+requirelist, вакансия не блокируется. Это **не два TSV-record'а**, а альтернативная оценка одной вакансии. Поведение полезное (multi-role posting'и) и реально документировано в `engine/core/filter.js` header + SPEC CC-3.1, но в gap-матрице висело как «engine improvement без явного источника».
- **Станет**: явный triage-decision в SPEC и matrix — keep as-is, intent зафиксирован.
- **Цена**: XS (только текст). **Closed 2026-05-03.**

### G-5 — В TSV нет поля location
- **Сейчас**: location в TSV нет → location-фильтры на этапе validate невозможны, retro-sweep его не покрывает.
- **Станет**: location в TSV (column 7), v3 schema. Backfill из master pool. Validate retro-sweep теперь покрывает location_blocklist. Sync push: location уезжает в Notion property "Location" если профиль явно прописал в property_map (default: не пушит, обратно-совместимо).
- **Цена**: M (миграция схемы TSV + backfill + тесты). **Closed 2026-05-03.** Backfill результаты: Jared 2186/2897 заполнено (711 orphans — старые скан-снимки), Lilia 94/425 (331 orphans — Sutter Health workday не в pool). Бэкапы `applications.tsv.pre-stage-g5` сохранены для обоих профилей.

### G-6 — В companies.tsv колонка profile — comma-list
- **Сейчас**: одна компания, видимая обоим профилям (Jared+Lilia), хранится строкой `"jared,lilia"`. Хак.
- **Станет**: нормальная связь many-to-many.
- **Цена**: M (миграция схемы).

### G-8 — USAJOBS adapter существует, но выключен
- **Сейчас**: код есть, но ни в одном профиле не активирован. Висит в коде неактивно.
- **Станет**: остаётся в коде, помечен «backlog, deferred» — вернёмся, когда будет реальная потребность в federal jobs.
- **Цена**: XS (только пометка в BACKLOG).

### G-12 — `prepare` не добирает батч после skip'ов + summary без причин
- **Сейчас (закрыто 2026-05-04)**: `prepare --phase pre` добирает chunk'ами (size = max(remaining, 5)) из `passed` пула пока `aliveResults.length < batchSize` (или пул не исчерпан). Stats теперь содержат `skipReasons` breakdown (`company_cap: N, title_blocklist: N, url_dead: N, …`) и `deferred` counter (eligible jobs не дошли до URL-check, остаются в очереди до next pre run). SKILL Step 12 печатает breakdown verbatim из `prepare_context.stats.skipReasons`.
- **Цена**: M. **Closed 2026-05-04**.

### G-13 — Вакансии с LinkedIn/Indeed/custom URL дохнут на URL-check
- **Сейчас**: эти три источника не отдают живой URL для прямого пинга, поэтому 100% таких вакансий помечаются как dead.
- **Станет**: либо ранний skip URL-check'а для этих источников, либо исключение их из ingestion.
- **Цена**: XS.

### G-14 — JD-кэш только для GH+Lever
- **Сейчас**: для остальных платформ description тянется через WebFetch, что недетерминированно (разные ответы при повторе).
- **Станет**: единый JD-кэш для всех платформ. Не критично, но детерминизм улучшится.
- **Цена**: M.

### G-20 — Повторный запуск SKILL может создать дубль в Notion
- **Сейчас (закрыто 2026-05-04)**: SKILL Step 9.0 skip-guard — «If the matching `applications.tsv` row already has a non-empty `notion_page_id`, the page was created in a prior run — record the existing id as `notionPageId` in results.json and skip 9a–9c (no new page, no duplicate). This makes operator-reruns of the SKILL idempotent.»
- **Цена**: XS. **Closed 2026-05-04**.

### G-23 — Несуществующий архетип ловится только при создании Notion-страницы
- **Сейчас (закрыто 2026-05-04)**: часть G-18. Early-reject landed: SKILL Step 7 имеет Mandatory validation block, который требует `resumeVer ∈ keys(profile.resume_versions.versions)`. Commit-phase backstop остаётся как safety net (`updates.invalidArchetype` counter).
- **Цена**: XS (часть G-18). **Closed 2026-05-04**.

### G-24 — Удаление страницы в Notion не пуллится обратно
- **Сейчас**: если оператор руками удалит page в Notion, в TSV запись останется. Поведение совпадает с прототипом.
- **Станет**: задокументировать в RFC (фикс не нужен, нужно только чёткое описание контракта).
- **Цена**: XS (только текст).

### G-26 — LinkedIn-вакансии создают «To Apply» с пустым URL
- **Сейчас (до 2026-05-03)**: каждая такая запись попадала в TSV без URL → SKILL не мог фетчить JD → Notion-карточки выходили без ссылки.
- **Станет**: LinkedIn ingestion **disabled 2026-05-03** (per user). Прототип не имел LinkedIn-источника, engine добавил экспериментально, юзер этим почти не пользовался. Email всё ещё фетчится Gmail-батчем (`from:jobalerts-noreply@linkedin.com`) и виден в check-log как `"skipped: linkedin disabled"`, но TSV-row не создаётся. Re-enable инструкция — в комментарии над `processLinkedIn` в `engine/commands/check.js`.
- **Цена**: XS (вместо M — заворот вместо URL-resolution). **Closed 2026-05-03.**

### G-29 — `--auto` режим check существует, но не активирован
- **Сейчас**: код для cron-режима готов, но ни Jared, ни Lilia не используют (check сейчас через Claude+MCP).
- **Станет**: активирован хотя бы для одного профиля. -- это разве мы не выносили на сервак?
- **Цена**: M (требует OAuth setup + хостинг).

---

## Trivial (9)

### G-9 — `scan --apply` ничего не делает
- **Сейчас**: флаг `--apply` принимается, но scan и так всегда пишет TSV. Косметический.
- **Станет**: либо убрать флаг, либо описать как noop в help.
- **Цена**: XS.

### G-16 — `prepare_context.json` без version field
- **Сейчас**: при изменении схемы файла миграция невозможна, нужно перегенерировать.
- **Станет**: добавить `version: 1`.
- **Цена**: XS.

### G-19 — Неизвестный `decision` в commit-фазе тихо считается «skip»
- **Сейчас (закрыто 2026-05-04)**: `prepare --phase commit` валидирует `decision` против `VALID_DECISIONS = {to_apply, archive, skip}`. Unknown values warn в stderr (`unknown decision "<x>" for key <key> — treating as skip`) и downgrade to `skip` с counter'ом `updates.invalidDecision`, видимым в summary.
- **Цена**: XS. **Closed 2026-05-04**.

### G-25 — Inbox callout counter — мёртвый код
- **Сейчас (закрыто 2026-05-04)**: код callout-апдейтера удалён вместе с sync push (commit `4f85ed2`). После Stage 8 статуса «Inbox» больше нет, callout всегда показывал 0 — теперь самого callout-апдейтера тоже нет.
- **Юзер-комментарий**: каунтер в Notion должен показывать объём свежих вакансий обязательно. Это **отдельная фича** (новый push pull от prepare после успешного batch'а или auto-update в Notion view). Логировать как BACKLOG-айтем «inbox volume callout (To Apply без notion_page_id)» когда дойдёт до UX полировки.
- **Цена**: XS. **Closed 2026-05-04** (мёртвый код удалён). Re-implementation as a feature — см. BACKLOG.

### G-27 — Engine добавил 3 фикса в classifier vs прототип
- **Сейчас**: engine лучше прототипа (убрал ложные срабатывания на «not selected», bare «interview», bare «assessment»). Это plus.
- **Станет**: задокументировано в SPEC, чтобы не откатили обратно.
- **Цена**: XS (текст уже есть).

### G-28 — TSV и Notion mutations не атомарны
- **Сейчас**: Notion 5xx посередине batch'а → split state (часть синкнулось, часть нет). Self-heal на следующем запуске.
- **Станет**: задокументировано как known limitation (full atomicity дорогая).
- **Цена**: XS (текст).

### G-30 — `>` (validate) vs `>=` (prepare) для cap'а
- **Сейчас**: validate ругается при >cap, prepare блочит при >=cap. Корректно, но не задокументировано.
- **Станет**: добавлено в spec note (этот SPEC уже покрывает).
- **Цена**: XS (готово).

### G-31 — SSRF guard продублирован в двух местах
- **Сейчас**: prepare и validate используют свои копии guard'а. Намеренно — разные контракты.
- **Станет**: задокументировано как not-a-gap.
- **Цена**: XS (готово).

### G-32 — Retro sweep ищет «To Apply», прототип искал «Inbox»
- **Сейчас**: семантическая parity после Stage 8 (статусы переименованы). Не баг.
- **Станет**: задокументировано как parity, не gap.
- **Цена**: XS (готово).

---

## Сводка по цене

- **L** (требуют RFC и миграции): G-1, G-7.
- **M** (день работы, тесты): G-3, G-6, G-14, G-29.
- **XS** (несколько строк): остальные ~14 активных.
- ✅ **Закрыто 2026-05-04** (15 шт): G-2, G-5, G-10, G-11, G-12, G-15, G-17, G-18, G-19, G-20, G-21, G-22, G-23, G-25, G-26.

## Рекомендация по триажу

**Активная очередь (после prepare blocker/QoL пакета 2026-05-04)**:

**XS — quick wins**:
- G-4 (cross-platform dedup) — уже написано, надо включить.
- G-13 (LinkedIn / Indeed URL-check skip).

**M — ценный поведенческий fix**:
- G-3 (centralized title requirelist).
- G-14 (JD-cache для остальных платформ).

**Архитектурные (L)** — обсудить отдельно, делать ли вообще:
- G-1 (статусы — миграция в Notion).
- G-7 (geo enforcement) — критично для Lilia, blocker для no-relocate профилей.

**Документационные (Trivial)** — закрываем пачкой в одном PR:
- G-24, G-27, G-28, G-30, G-31, G-32.

**Отложить (BACKLOG)**:
- G-8 (USAJOBS) — вернёмся, когда понадобится.
- G-29 (`--auto` activation) — ждёт OAuth setup.
- G-6, G-33 (часть RFC 012 — TSV schema bump).
