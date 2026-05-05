# Gaps Review — user-facing backlog

Все 33 гэпа из SPEC + 6 Lilia-profile-блокеров (L-1…L-6, добавлены 2026-05-04), в формате «что сейчас / что станет», без техники. Для триажа перед Phase 3.

Severity:
- **High** — реальный риск регрессии или потери качества (1 активный, 1 закрыт 2026-05-04).
- **Medium** — поведение работает, но отклоняется от ожиданий или заложена мина (4 активных, 6 закрыто 2026-05-04).
- **Low** — мелкая шероховатость в DX или edge case (9 активных, 3 закрыты 2026-05-04).
- **Trivial** — косметика / документационная зацепка (7 активных, 2 закрыты 2026-05-04).
- **Lilia-profile-blocker** — недо-реализованная per-profile конфигурация, из-за которой engine для Лили работает по Джаредовским дефолтам (1 будущий L-tier RFC, 4 закрыто 2026-05-04 — Commit A + B, 1 verification-only).

Цена fix'а:
- **XS** — несколько строк, без RFC.
- **M** — пара файлов + тесты, в рамках дня.
- **L** — архитектурное изменение, требует RFC.

---

## High (2)

### ~~G-7~~ — Geo-фильтр неполный (closed 2026-05-04)
- **Закрыто**: поглощено L-4 (RFC 013). Profile-level `profile.json.geo` block с режимами `metro` / `us-wide` / `remote-only` / `unrestricted` уважается единым `engine/core/geo_enforcer.js` через `filter.js` ДО append'а в TSV. Все 11 адаптеров фильтруются автоматически. SKILL Step 3 читает `prepare_context.batch[i].geo_decision` из engine, не делает WebFetch.
- **Цена**: L. **Closed 2026-05-04** (Commit C, RFC 013).

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

---

## Lilia profile-level blockers (план 2026-05-04)

Шесть отдельных дыр, найденных при подготовке к боевому prepare для Lilia после head-to-head Джареда. Все шесть — следствие общей архитектурной болячки: **engine читает дефолты вместо per-profile конфигов**. Фарминтех-зарплаты в `salary_calc.js`, PM-tone в Humanizer'е, US-only-no-region geo-чек в SKILL — всё это для Лили (healthcare, Sacramento metro, нерелокации) даёт системно плохой вывод.

Архитектурный принцип фикса: «профиль декларирует — engine читает per-profile через `profile_loader` — SKILL потребляет уже разрешённое из `prepare_context`». Никаких Lilia-specific хардкодов в engine.

### L-1 — Зарплатная матрица per-profile
- **Сейчас**: `engine/core/salary_calc.js` имеет хардкоженную `DEFAULT_SALARY_MATRIX` (фарминтех PM/Senior/Lead, $120-330K). `parseLevel(title)` распознаёт только Lead/Senior/PM. Лиле для Medical Receptionist в Kaiser посчитает $180-230K (Tier S × «PM») — катастрофа в Notion `Salary Expectations`.
- **Станет**: `profile.json.salary` block с собственной матрицей и режимом разбора уровней (`level_parser: "pm" | "healthcare" | "default"`). Healthcare-режим распознаёт Junior/IC vs Senior (по `Lead`/`II`/`III` в title). Engine читает per-profile, дефолт остаётся для back-compat Джареда.
- **Цена**: M. Сабтаски: schema → salary_calc refactor → profile_loader extension → SKILL Step 6 update → тесты parity для Джареда + healthcare фикстуры.
- **Статус**: Open. Запланировано в Commit A.

### L-2 — Memory как формальная часть профиля
- **Сейчас**: SKILL Step 1 / Humanizer Rules ссылаются на `profiles/<id>/memory/user_writing_style.md` + `user_resume_key_points.md`. У Джареда есть, у Лили нет → fallback на `resume_versions.json` не описывает тон письма. Humanizer-defaults применяет PM-калибровку (numbers in every paragraph, confident practitioner) к Лиле — overqualified-tone в её CL, ровно то, что её `cover_letter_template.md` запрещает.
- **Станет**: `profile.json.memory` block: `{writing_style_file, resume_key_points_file, feedback_glob}`. Engine pre-phase читает все указанные файлы и складывает в `prepare_context.memory`; SKILL берёт оттуда (детерминизм + меньше токенов). Если профиль не задал — fallback цепочка как сейчас.
- **Цена**: XS-M (schema + одна функция в `profile_loader` + SKILL Step 1 update + тесты).
- **Статус**: Open. Запланировано в Commit A.

### L-3 — Контент memory-файлов Лили из её резюме
- **Сейчас**: оба файла отсутствуют. После L-2 engine будет их искать, но пустота → fallback PM-defaults.
- **Станет**:
  - `profiles/lilia/memory/user_writing_style.md` — warm, 5/10 formality, no metrics-per-paragraph rule, no «confident practitioner» дефолтов. Опирается на её `cover_letter_template.md` Tone Rules + Anti-patterns.
  - `profiles/lilia/memory/user_resume_key_points.md` — domain criteria для Fit Score: Strong = front-desk / patient services / scheduling / authorization в Sacramento metro + bilingual roles (RU/BG) — automatic Strong; Medium = adjacent admin / dental treatment coordinator / billing clerk; Weak = required clinical cert (CMA/RN/LVN/CPC/RDA/RDH/sonographer/RT). Domain primary keypoints для P1 hook'а: pre-sonography student at Sierra College, trilingual EN/RU/BG, licensed CA Cosmetologist, immigration law case research (transferable: deadlines/databases/client communication), Starbucks 100+ customers/day under pressure.
- **Цена**: XS (контент создаётся из её `resume_versions.json` + `cover_letter_template.md`).
- **Статус**: Open. Запланировано в Commit A (вместе с L-2 — без файлов engine'у нечего читать).

### L-4 — Гибкая geo-модель per-profile (поглощает G-7)
- **Сейчас (закрыто 2026-05-04)**: единая модель `profile.json.geo` с режимами `metro` / `us-wide` / `remote-only` / `unrestricted`. `engine/core/geo_enforcer.js` — pure-function matcher; интегрирован в `filter.js` (scan/prepare/validate uniform). `profile_loader.normalizeGeo()` валидирует на загрузке (metro требует cities+states; throws иначе). Multi-location semantic: pass if ANY locations[] satisfies policy. Per-location blocklist short-circuit. US state code ↔ full name bidirectional matching. Bare-city safeguard: city-only match accepted когда location string не содержит state info вообще (preserves Auburn-AL ambiguity defense). SKILL Step 3 читает `prepare_context.batch[i].geo_decision` (allowed/rejected) — не делает WebFetch.
- **Lilia geo**: `metro` mode с 13 городами Sacramento metro (incl. Lincoln) + states=["CA"] + remote_ok=true + blocklist=[Napa, Stockton, Lodi, Vacaville, Modesto].
- **Jared geo**: `unrestricted` + remote_ok=true (явно задекларировано per RFC §8.6).
- **Цена**: L. **Closed 2026-05-04** (Commit C, RFC 013).
- **Live verification**: Jared parity — 389 To Apply rows, 389 allowed, 0 rejected (zero regression). Lilia retro-sweep: 36 архивированных rows (31 geo_no_location — TSV без location field / 5 geo_metro_miss — корректные state mismatch'и). Tests: 60 новых (28 geo_enforcer + 11 profile_loader.normalizeGeo + 10 filter geo + 6 prepare geo + 4 validate geo + 1 cleanup); 903/903 passing.

### L-5 — Notion Schedule / Requirements из JD
- **Сейчас (закрыто 2026-05-04)**: `engine/core/jd_extract.js` ловит schedule (Full-time / Part-time / Per Diem / PRN / Contract / шифт-фолбек / hours-per-week) и requirements (education / 1-7+ years / bilingual + специфичные языки / healthcare certs — BLS / CMA / RDA / RN / etc. с required/preferred тегами / EMR — Epic / Cerner / Dentrix / etc.). Контекст-скоп — sentence/line, чтобы required/preferred не утекали между бюллетами. `prepare.js` pre-phase прокидывает в `prepare_context.batch[i].{schedule, requirements}` через DI-инъекцию `extractFromJd`. SKILL Step 9 пушит, только если `profile.notion.property_map.schedule` / `.requirements` определены (у Лили оба — `select` + `rich_text`; у Джареда нет → его карточки не меняются). Тесты: 25 на jd_extract (Kaiser / Sutter / Dignity / Sono Bello / Stonebrook + boundary cases) + 5 на prepare.js wiring (включая Jared parity — extractor может вернуть `requirements` для PM-JD по years signal, но SKILL не пушит из-за gating).
- **Цена**: M. **Closed 2026-05-04** (Commit B).

### L-6 — Head-to-head verification для Лили
- **Сейчас (закрыто 2026-05-04)**: см. `docs/lilia_prepare_head_to_head.md`. Engine `profiles/lilia/cover_letter_versions.json` (581 строк, 55590 bytes) **byte-identical** с прототипным `Lilly's Job Search/cover_letter_config.json` — `diff` пустой. Shape совместим с SKILL Step 8 template-variants веткой: `defaults.{p2, p3, p4_template, availability, sign}` + `letters[]` (95 entries, 11 Sutter). Контракт: P2/P3/P4 копируются из общих defaults на каждом письме (byte-identical с прототипом по построению), варьируется только P1. 45 fresh `To Apply` rows доступны для боевого batch'а. После L-4 retro-sweep архивированы 36 невалидных rows (31 no_location, 5 metro_miss — все корректные).
- **Цена**: verification, не код. **Closed 2026-05-04**.

---

## Очерёдность исполнения (план)

Три коммита в указанном порядке, каждый — фокус-сессия:

### Commit A (M) — L-1 + L-2 + L-3
Profile-level конфиги для salary и memory:
- `profile.json.salary` block + engine refactor + tests.
- `profile.json.memory` block + engine refactor + tests.
- Lilia memory файлы (writing_style + resume_key_points).
- Lilia salary matrix в `profile.json`.
- SKILL Step 1 / Step 6 обновления.
- Jared parity тесты (никакие старые номера не сдвинулись).

### Commit B (M) — L-5
JD extractors + Notion completeness:
- `engine/core/jd_extract.js` с extractSchedule + extractRequirements.
- `prepare.js` pre-phase прокидывает в `prepare_context`.
- SKILL Step 9 пушит при наличии в property_map (back-compat).
- 5-6 фикстур на типичные healthcare JD.

### Commit C (L) — L-4 (RFC 013) — **Done 2026-05-04**
Geo-модель per-profile:
- RFC 013 → approved.
- `geo_enforcer.js` (pure matcher) + filter.js integration (uniform для scan/prepare/validate) + SKILL Step 3 refactor (читает `geo_decision` из engine).
- `profile_loader.normalizeGeo()` валидирует geo block на загрузке.
- Lilia/Jared geo blocks в profile.json.
- Live retro-sweep: Jared 0 rejections (parity), Lilia 36 archived (31 no_location + 5 metro_miss).
- 60 новых тестов; 903/903 passing.

После C: **L-6** ✅ (head-to-head verification для Лили, closed 2026-05-04 — `docs/lilia_prepare_head_to_head.md`). Lilia-batch полностью закрыт; следующий шаг — боевой prepare для неё по запросу пользователя.

---

## Сводка по цене

- **L** (требуют RFC и миграции): G-1.
- **M** (день работы, тесты): G-3, G-6, G-14, G-29.
- **XS** (несколько строк / файлы): остальные ~14 активных.
- ✅ **Закрыто 2026-05-04** (21 шт): G-2, G-5, G-7 (absorbed by L-4), G-10, G-11, G-12, G-15, G-17, G-18, G-19, G-20, G-21, G-22, G-23, G-25, G-26, **L-1, L-2, L-3, L-4, L-5, L-6**.

## Рекомендация по триажу

**Активная очередь (после prepare blocker/QoL пакета 2026-05-04)**:

**Lilia-blockers (приоритет 1 — без них боевой prepare для неё даст плохой вывод)**:
- Commit A → Commit B → RFC 013 approve → Commit C → L-6 verification. См. секцию «Очерёдность исполнения» выше.

**XS — quick wins (можно делать в параллель с Lilia-batch'ем)**:
- G-4 (cross-platform dedup) — уже написано, надо включить.
- G-13 (LinkedIn / Indeed URL-check skip).

**M — ценный поведенческий fix (после Lilia)**:
- G-3 (centralized title requirelist).
- G-14 (JD-cache для остальных платформ).

**Архитектурные (L) — обсудить отдельно**:
- G-1 (статусы — миграция в Notion).
- ~~G-7~~ → поглощено L-4 в RFC 013 (closed 2026-05-04).

**Документационные (Trivial) — закрываем пачкой в одном PR**:
- G-24, G-27, G-28, G-30, G-31, G-32.

**Отложить (BACKLOG)**:
- G-8 (USAJOBS) — вернёмся, когда понадобится.
- G-29 (`--auto` activation) — ждёт OAuth setup.
- G-6, G-33 (часть RFC 012 — TSV schema bump).

---

## Прогресс-трекер для Lilia-batch

Этот блок ведётся вживую — фиксируем, что закрыто, дату, ссылку на коммит. После L-6 секция замораживается как archival.

| ID | Статус | Commit | Дата | Заметка |
|---|---|---|---|---|
| L-1 (salary matrix per-profile) | **Done** | Commit A | 2026-05-04 | `profile.json.salary` block + `parseLevel(title, parser)` dispatcher (`pm` / `healthcare` / `default`). Lilia matrix S/A/B/C × MedAdmin/Coordinator/Senior. COL config per-profile (Lilia: `multiplier=1.0`). Jared без блока → engine defaults (parity подтверждён smoke + 12 новых тестов). |
| L-2 (memory in profile config) | **Done** | Commit A | 2026-05-04 | `profile.json.memory` block (`writing_style_file` / `resume_key_points_file` / `feedback_dir`). `profile_loader.loadMemory()` подгружает контент в `profile.memory.{writingStyle,resumeKeyPoints,feedback[]}`. `prepare.js` пробрасывает в `prepare_context.memory`. SKILL Step 1 / Voice calibration / Memory files читают из контекста, не с диска. |
| L-3 (Lilia memory files content) | **Done** | Commit A | 2026-05-04 | `profiles/lilia/memory/user_writing_style.md` (warm, 5/10, anti-AI tells, voice anchors) + `user_resume_key_points.md` (Strong/Medium/Weak fit criteria + 4 опыта по приоритету + дифференциаторы). Jared `profile.json` тоже задекларировал свой существующий memory dir. |
| L-4 (geo model RFC 013) | **Done** | Commit C | 2026-05-04 | `engine/core/geo_enforcer.js` (pure matcher) + filter.js integration + `profile_loader.normalizeGeo()` + SKILL Step 3 refactor (engine-resolved decision, no WebFetch). Lilia metro mode (13 cities Sacramento+Lincoln, CA, blocklist 5 cities, remote_ok=true). Jared explicit `unrestricted` + remote_ok=true. Live: Jared 389/389 allowed (parity), Lilia 36 archived (31 no_location + 5 metro_miss). 60 новых тестов. Поглощает G-7. |
| L-5 (Schedule / Requirements push) | **Done** | Commit B | 2026-05-04 | `engine/core/jd_extract.js` + `prepare.js` pre-phase wiring + SKILL Step 9 profile-gated push. 30 новых тестов (25 jd_extract + 5 prepare). Healthcare JD фикстуры: Kaiser / Sutter / Dignity / Sono Bello / Stonebrook. Sentence-scoped strength tagging (required/preferred). Back-compat: Jared parity — его карточки не меняются (нет полей в property_map). |
| L-6 (head-to-head Lilia) | **Done** | docs/lilia_prepare_head_to_head.md | 2026-05-04 | `cover_letter_versions.json` byte-identical с прототипом (`diff` empty, 581/581 lines, 55590/55590 bytes). Template-variants shape contract verified: P2/P3/P4 копируются из общих `defaults` (byte-identical by construction), варьируется только P1. SKILL Step 8 explicit branch для template-variants есть. Lilia ready для боевого batch'а. |
