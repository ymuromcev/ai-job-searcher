# RFC 043 — Master Profile schema + build script

- Status: **accepted**
- Date: 2026-05-24
- Approved: 2026-05-24
- Refs: BL-124 (this RFC's parent), BL-123 (autonomous Strong-fit tailoring loop — depends on BL-124)
- Tier: M (per `DEVELOPMENT.md` — schema change touching multiple files + new script)

## Problem

`profiles/jared/` сегодня содержит **два независимых источника правды** про карьеру:

1. **`profiles/jared/resume_versions.json`** (100 КБ, 2903 строки) — career scaffold:
   - `contact`, `shared_roles[]` (5 ролей: credit_mentor, alfa, croc, ferma, smmacc), `shared_projects[]`, `shared_sections` (education, certifications, skillsFixed)
   - `shared_experience` — per-role bullets для ferma/smmacc/croc
   - `versions[]` — **16 архетипов** (ConsumerGrowth, PaymentsInfra, AI_Platform, …), каждый с per-role bullets (`creditMentorBullets`, `alfaBullets`, …), `skillsProduct`, `skillsDomain`, `summary`
   - Bullets — массивы `{text, bold}` объектов (inline-bold для docx-генератора)
   - Один и тот же achievement может фигурировать в нескольких архетипах в перефразированном виде; явной связи между «версиями одного факта» в схеме нет

2. **`profiles/jared/interview-coach-state/coaching_state.md`** (100 КБ, 425 строк) — storybank:
   - 15 STAR-историй (S001–S015), билингв RU/EN в 2-column tables
   - Каждая история: Context → Situation/Task/Action/Result/Earned Secret
   - Meta-разделы: career narrative gaps, story seeds reference, итерации полировки
   - **Уникальное преимущество** — фактаж в развёрнутой форме, который не влезает в bullet

BL-123 проектирует autonomous Strong-fit tailoring loop, где subagent **строит CV с нуля под конкретную JD из master profile** (не из готового архетипа). Чтобы loop имел качественную фактическую базу, subagent должен видеть **всё** — career scaffold + STAR-истории — единым взглядом.

Сейчас он не может: два файла в разном формате, нет общей структуры ролей, bullets не дедуплицированы между архетипами, нет visibility-системы.

## Approach

### Двухфайловая архитектура

**Файл A — `profiles/<id>/master_profile.md` (derived)**

Generated build-скриптом из `resume_versions.json`. Содержит:

- Contact
- Career Narrative (один абзац-обобщение из всех summaries архетипов или ручной overwrite)
- Visibility Schema (определение enum + список variants = архетипов профиля)
- Roles (5 штук) — каждая с:
  - `Visibility: always|variant-specific|on-request|reference-only`
  - `Variants: [archetype, …]` (если variant-specific)
  - Company context (что компания делала, размер, домен)
  - Title, dates, team scope
  - **Dedupe bullets** — один achievement = одна запись с тегом `used_in: [ConsumerGrowth, PaymentsInfra, AnalyticsData]`; перефразировки сворачиваются в один canonical bullet + alternates
  - Technologies (если есть в источнике)
- Education (с Visibility)
- Certifications
- Skills Inventory — flat union всех `skillsProduct` ∪ `skillsDomain` ∪ `skillsFixed` из всех архетипов
- Languages (для Jared'а: RU native, EN business)
- Notes — gaps, side projects, метаданные

**STAR-стории в master НЕ дублируются.** Master содержит секцию:

```markdown
## STAR Stories
Полные STAR-истории см. `profiles/jared/interview-coach-state/coaching_state.md`
(15 stories: S001–S015, billingual RU/EN, with Earned Secrets).

Tailoring subagent должен читать оба файла параллельно.
```

**Файл B — `profiles/<id>/interview-coach-state/coaching_state.md` (manual primary)**

**Не трогаем.** Остаётся primary source-of-truth для STAR. Юзер правит вручную (interview prep workflow). Добавил новую историю S016 → она автоматически доступна tailoring-subagent'у при следующем `prepare`, никакой пересборки не нужно.

### Why derived + manual вместо single source

- **Master = derived** — пересобирается из `resume_versions.json` (который сейчас primary для Weak/Medium архетипного flow и должен таким остаться для обратной совместимости). Build script — единственный пишущий канал в master.
- **Storybank = manual** — STAR-истории пишутся интерактивно с interview-coach скилом, который правит coaching_state.md. Хранить «derived storybank» в master = дублирование, рассинхрон, лишний rebuild при каждом добавлении истории.
- Tailoring-subagent читает **2 файла одним заходом** (~200 КБ суммарно — пренебрежимая нагрузка для контекста).

### Visibility System

Берём enum из olegvg resume-tailor SKILL:

| Value | Meaning | Behavior |
|---|---|---|
| `always` | Include in all resume variants | Always consider for inclusion |
| `variant-specific` | Only in variants listed in `Variants` field | Include only if target variant matches |
| `on-request` | Never include unless user explicitly asks | Skip by default |
| `reference-only` | Alias/metadata, not content | Never include |

**Variants** для Jared'а — 16 архетипов из `resume_versions.json/versions[]`:
`ConsumerGrowth`, `ConsumerLending`, `Risk_Fraud`, `AI_Platform`, `SpendCards`, `PaymentsInfra`, `AnalyticsData`, `HealthTech`, `LogisticsOps`, `Marketplace`, `VerticalSaaS`, `Crypto_Wallets`, `DigitalModernization`, `ProductOps`, `TrustSafety_Policy`, `Revenue_BizOps`.

Будущие bridge-варианты (BL-121, ещё не открыт) добавятся туда же — схема позволяет.

**Initial visibility assignment**: build script размечает Visibility на основе того, в скольких архетипах фигурирует роль:

- Если роль фигурирует во **всех** архетипах (≥15/16) → `always`
- Если в **подмножестве** → `variant-specific` + `Variants: [список]`
- На MVP все 5 ролей Jared'а фигурируют везде → все `always` (юзер может вручную пометить SMMACC как `on-request` если захочет — это manual override post-generation)

### Build script: `scripts/build_master_profile.js`

```
node scripts/build_master_profile.js --profile <id>
```

**Behavior:**

- **Input:** `profiles/<id>/resume_versions.json`
- **Output:** `profiles/<id>/master_profile.md`
- **Idempotency:** повторный запуск без изменения source → байт-в-байт identical output (для diff'а; файл gitignored, но в worktree персистентен)
- **Triggered manually** на этом этапе. Никаких pre-commit hooks, cron, watch-режима — это OUT of scope (см. ниже)
- **Manual overrides** — если юзер вручную правил master_profile.md после генерации, script:
  - **MVP**: перезаписывает без предупреждения (юзер должен либо коммитить изменения в `resume_versions.json` как source-of-truth, либо знать что rebuild затрёт правки)
  - **Future iteration**: поддержка marker-блоков `<!-- manual-start -->...<!-- manual-end -->` которые preserved при rebuild. Не сейчас.

**Dedupe algorithm для bullets:**

1. Для каждой роли пройти по всем `versions[*].<roleBullets>` массивам
2. Кластеризация по semantic similarity (для MVP — exact-match по нормализованному тексту: lowercase, strip punctuation, collapse whitespace). Сложнее — embedding-cluster — out of scope для MVP.
3. Один кластер → одна master-запись с `used_in: [archetypes]` тегом + список перефразировок как alternates
4. Если bullet встречается только в одном архетипе → `used_in: [archetype]`, без alternates

Это compromise: не идеальный dedupe, но достаточный чтобы tailoring-subagent видел «канонический факт + варианты формулировки».

**Smoke test** (`scripts/build_master_profile.test.js`):
- Запускает build на `profiles/_example/` synthetic data (если есть resume_versions.json там; если нет — на fixture внутри теста)
- Проверяет: output file exists, содержит все 5 expected role headers, valid markdown, idempotent (запуск 2 раза → identical output)

### Mapping: resume_versions.json → master_profile.md

| Source | Target |
|---|---|
| `contact` | `## Contact` |
| `shared_roles[*]` | `## Roles → ### <role>` (один заголовок на роль) |
| `versions[*].<roleBullets>` | `### <role> → Achievements (dedupe across archetypes)` |
| `shared_experience` (ferma/smmacc/croc role-level bullets) | Merged в `### <role> → Achievements` для тех ролей |
| `shared_projects[*]` | `## Personal Projects` |
| `shared_sections.education` | `## Education` |
| `shared_sections.skillsFixed` ∪ `versions[*].skillsProduct` ∪ `versions[*].skillsDomain` | `## Skills Inventory` (union, dedupe) |
| `certifications` | `## Certifications` |
| (нет в source) | `## Career Narrative` — placeholder для manual fill ИЛИ автогенерация из summaries (decided in implementation) |
| (нет в source) | `## Languages` — placeholder для manual fill (RU native, EN business для Jared'а) |
| (нет в source) | `## STAR Stories` — статичная ссылка на coaching_state.md |

### Обратная совместимость

`resume_versions.json` остаётся **primary** для:

- Текущий job-pipeline Step 7 (archetype gate для Weak/Medium fits) — не трогаем
- `node engine/cli.js prepare` — selects одну из 16 версий по архетипу, рендерит в docx
- Это **намеренное дублирование** на этом этапе. После стабилизации master может стать single source, а `resume_versions.json` — derived. Не сейчас.

`coaching_state.md` остаётся **primary** для:

- Interview-coach скил
- Любая ручная правка STAR-историй
- Master ссылается, не копирует

## Decision

Принимаем двухфайловую архитектуру (master derived + storybank manual). Build script — детерминистический, manual trigger, dedupe по exact-match нормализованного текста.

Путь master: **`profiles/<id>/master_profile.md`** (per-profile, gitignored как и весь `profiles/<id>/` non-example).

Visibility system берём из olegvg как есть.

## Definition of Done (этот RFC)

- [x] Schema master_profile.md описана
- [x] Mapping resume_versions.json → master описан
- [x] Build script behavior описано (input/output/idempotency/dedupe)
- [x] Visibility система описана + initial assignment rule
- [x] Storybank reference policy описана (не дублируем, ссылаемся)
- [x] Обратная совместимость с resume_versions.json + coaching_state.md явная

После approve этого RFC → BL-124 Plan Step 3 (build script implementation).

## Out of scope

- **Deduplication automation** между master и resume_versions.json (одна single запись правды) — отдельный потенциальный BL после стабилизации формата
- **Embedding-based bullet clustering** — exact-match достаточно для MVP
- **Auto-rebuild master** при изменении `resume_versions.json` (pre-commit hook / watch / cron) — manual rebuild на первой итерации
- **Manual override preservation** (marker-блоки внутри master) — future iteration
- **Per-profile generalization** — фокус на Jared'е. `profiles/_example/` обновляем минимально (placeholder master или fixture для smoke-теста)
- **STAR storybank migration в новый формат** — coaching_state.md остаётся как есть
- **Visibility editing UI** — юзер правит руками если нужно

## Open questions для имплементации

1. **Career Narrative** — пустой placeholder с TODO для юзера, ИЛИ автогенерация (concat summaries из 3-4 ключевых архетипов)? Decision: **placeholder + TODO** на MVP — narrative сильно зависит от того, как юзер себя позиционирует, не хочу автогенерировать неверно.
2. **`profiles/_example/`** — добавить туда synthetic `master_profile.md` для документации формата, или достаточно fixture в тесте? Decision: **fixture в тесте** + краткий пример в `docs/architecture/` — _example профиль не нуждается в master, он демонстрирует структуру.
3. **Career Narrative ручной override** — где хранится, чтобы rebuild не затирал? **Future iteration** — пока MVP перезаписывает.

## Notes

- Olegvg master-profile-schema (`~/.claude/plugins/cache/resume-tailor-wrapper/resume-tailor/1.0.0/skills/resume-tailor/SKILL.md` строки 30-100) — берём структуру + Visibility как scaffold, дополняем нашими полями (used_in tagging, STAR reference).
- Storybank format defined by global feedback: `feedback_storybank_first_person` (STAR от я), `feedback_storybank_translation_format` (2-column table при переводе).
- Не блокирует разработку BL-123 RFC, но блокирует финальный тест BL-123 (subagent должен иметь master чтобы прочитать).
