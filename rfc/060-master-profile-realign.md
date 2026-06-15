# RFC 060 — Master profile realign к реальному профилю Jared

- **Status:** Proposed
- **Created:** 2026-06-14
- **Tier:** L (multi-artifact, идентичность, влияет на резюме + фильтр + LinkedIn)
- **Related backlog:** BL-189 (stage 1, ✅ done), BL-192 (stage 2 — fit по достижениям), BL-191 (stage 3 — архетипы + фильтр-прогон), BL-190 (stage 5 — LinkedIn). Stage 4 (regenerate) — в составе 2–3, отдельного BL нет.
- **Supersedes positioning in:** career_narrative (resume_versions.json), coaching_state.md anchor 2026-06-10

## Problem

Текущий master profile инвертирован. `career_narrative` открывается
«AI-native Senior Product Manager… My deepest expertise is in fintech» — AI
подан как идентичность, fintech как предметная область. Два независимых
сигнала это бьют:

1. **Evgeniy Myskov (Virto, Head of Product):** «слишком финтех» — домен-
   mismatch для marketplace-роли.
2. **Ivan Bakhmat (LinkedIn-критика, validated):** «резюме общее; PO с
   хайповыми ИИ-словами. Платят за понимание предметной области, не за AI».

Реальный профиль (разбор 2026-06-10 + уточнение кандидата 2026-06-14): не
финтех и не «AI-native» как голова, а **Senior IC PM с craft в conversion и
аналитике**, домен — транзакционный e-commerce, рынки marketplace + fintech,
лидерство как доказательство сеньорности.

## Anchor (источник правды — всё ниже наследует отсюда)

Главная рамка выбрана кандидатом 2026-06-14: **Senior IC PM, craft-forward**
(лидерство и аналитика — пруф сеньорности, не заголовок).

- **WHAT:** Senior Product Manager на транзакционных e-commerce продуктах —
  conversion-воронки, онбординг, checkout, партнёрские интеграции,
  UX-эксперименты, аналитика с нуля.
- **WHERE:** marketplaces и fintech (перечислением, fintech — один из, не
  «главная экспертиза»).
- **Craft (вперёд):** conversion-оптимизация · UX-эксперименты · партнёрские
  интеграции и монетизация · аналитика с нуля (Alfa, Credit Mentor).
- **Leadership (2-й слой, пруф сеньорности):** вёл до 12 PM; собрал команду из
  5 в Alfa; управлял 3 dev-командами (15 человек).
- **HOW:** AI-native в исполнении (модификатор к execution, не к личности).
- **Канонический порядок везде:** WHAT → WHERE → HOW. Головное слово — `ecom`,
  не `AI`.

**Принцип:** anchor пишется один раз. Меняется anchor → пересматриваются все
артефакты. Не наоборот. Артефакт, расходящийся с anchor, — баг.

## Stages (каждая = BL со своим гейтом «образ результата → ОК → исполнение → проверка»)

| # | Стадия | Что | Файл | BL | Гейт |
|---|--------|-----|------|----|------|
| 0 | Anchor | Зафиксировать anchor в RFC + coaching_state.md | RFC 060, coaching_state.md | этот RFC | ✅ согласован 2026-06-14 |
| 1 | Master profile content | `career_narrative` + alfa leadership cluster (12 PM/5/15) + analytics-from-scratch; привязка к ролям | resume_versions.json | BL-189 | ✅ done 2026-06-15 |
| 2 | Fit по достижениям | Перепаять скоринг фита: оценивать вакансию против РЕАЛЬНЫХ достижений (achievements-digest из resume_versions.json), а не рукотворного доменного rubric. Убрать `user_resume_key_points.md` как доменную прослойку. Хард-фильтры/блокеры остаются | prepare.js, SKILL.md, pipeline-fit-evaluator, генератор digest | BL-192 | образ → ОК (пересмотрено 2026-06-15) |
| 3 | Архетипы + фильтр-прогон | Прогон на пуле под новый фит → реальные кластеры Strong/Medium; пересмотр 16 версий ПОД них; hard-фильтры `filter_rules.json` под реальный домен (bridge-треки BL-37 НЕ трогаем) | versions{}, filter_rules.json | BL-191 | образ → ОК |
| 4 | Regenerate + validate | `node scripts/build_master_profile.js --profile jared` + генерация digest; домен/craft считывается, варианты целы | master_profile.md, fit_profile | в составе 2–3 | проверка |
| 5 | LinkedIn | Headline + About под тот же anchor (вставляет кандидат руками) | — | BL-190 | образ → ОК |

**Порядок (пересмотрен 2026-06-15, решение Джареда):** 0→1 ✅. Дальше **2 (fit по
достижениям) → 3 (архетипы + прогон на пуле)**. Сначала чиним, ЧЕМ меряется фит
(реальные достижения, не доменный rubric), потом на прогоне видим реальные
кластеры Strong/Medium и лепим архетипы + хард-фильтры под них. 4 — регенерация.
5 (LinkedIn) — последней, наследует финальный anchor.

## Open questions (решаются на соответствующих стадиях, не сейчас)

- ~~**SMMACC роль:** кофаундер vs product manager.~~ **RESOLVED 2026-06-14:**
  везде **product manager** (ищем PM-вакансии, не фаундерские — артефакты
  должны совпадать). Founder-level scope, PM title. В resume_versions.json уже
  PM; coaching_state приведён к PM. Founder-грань поднимать только если прямо
  спросят в founder-раунде.
- **Аналитика / лидерство → роли:** цифры (12 PM / 5 / 15 dev; аналитика с
  нуля в Alfa и Credit Mentor) привязать к конкретным ролям в
  shared_experience, чтобы читалось точно.

## Источник истины: банк достижений → master profile + фит (пересмотрено 2026-06-15, согласовано)

**Отменяет** ранее набросанный блок `positioning` с рукотворным `fit_domains`
rubric. Джаред отверг доменную прослойку: фит меряется по РЕАЛЬНЫМ достижениям,
не по доменным ярлыкам «Strong = эти слова».

**Аудит пайплайна (2026-06-15):** фит (Strong/Medium/Weak) ставит LLM (SKILL
Step 4 / `pipeline-fit-evaluator`), читая ТОЛЬКО `user_resume_key_points.md`
(рукотворный rubric «Domain A=Fintech, B=AI-native») + `role_targets`.
`master_profile.md` и storybank в скоринг фита НЕ попадают — только в тейлоринг
Strong-резюме потом. Этот rubric — и есть прослойка, которую убираем.

**Направление истины (decision Джареда):** банк достижений → (master profile +
фит). НЕ `resume_versions.json` → всё.

- **Банк достижений = `## Storybank` в `coaching_state.md`** — единственный
  источник достижений-фактов. Уже структурированная таблица: `ID | Title(+метрика)
  | Primary Skill | Secondary Skill | Commercial Profile | Earned Secret |
  Strength(seed/confirmed)` + детальные STAR-блоки (S001–S021). Джаред дописывает
  истории сюда на моках — одно место ручного ввода достижений.
- **fit-дайджест генерируется из таблицы банка** — компактный (~8 КБ),
  детерминированный парс. Регенерится на старте `prepare` с проверкой свежести
  (хэш файла банка). Новое достижение в банке → следующий прогон фита его видит.
  Ноль ручного синка. Кормится в `pipeline-fit-evaluator` вместо старого rubric.
- **master_profile.md:** achievement-секция тоже тянется из банка (тот же
  генератор) — новое достижение попадает в профиль без дублирования.
  `resume_versions.json` остаётся источником только ПОДАЧИ: 16 архетипов,
  career_narrative, contact, education — не фактов-достижений.
- **Strength НЕ гейтит фит (исправлено 2026-06-15):** фит считается по всем
  реальным достижениям банка — `seed` и `confirmed` одинаково. `seed/confirmed` =
  статус ревью interview-нарратива на моках, не «достижение реальное/нет».
  Гейт по `confirmed` похоронил бы еком-якорь Альфы (S006/S007/S010 — `seed`),
  что противоречит калибровке (Альфа-еком = Strong). Метаданные кладём в дайджест,
  но скор не гейтят; анти-инфляцию держит overlap-правило + регресс-тест.

**Новое правило фита (generic, без доменных таблиц):**
- Strong = JD-требование совпадает с подтверждённым достижением (метрика/исход) в банке.
- Medium = частичное / смежное пересечение.
- Weak = нет реального пересечения.
- Не мой профиль → hard-блокеры/фильтры (cert/years/skill/title/geo/company-cap)
  отсекают ДО LLM — слой остаётся как есть.
- Калибровка Джареда выпадает сама: Alfa = ecom-в-финтехе → вакансия с этим craft
  = Strong; прочий финтех без conversion-воронки = Medium. Без хардкод-таблиц.

**Что меняется в коде (stage 2):**
- Новый генератор: `## Storybank` → `profiles/<id>/fit_profile.md`
  (achievements-digest), идемпотентный, шапка «generated», freshness-хэш.
- `engine/commands/prepare.js`: в prepare_context.memory кладём digest (вместо/в
  дополнение к resumeKeyPoints); регенерация digest встроена pre-prepare.
- `.claude/agents/pipeline-fit-evaluator.md` + `skills/job-pipeline/SKILL.md`
  Step 4 / Fit rules: правило Strong/Medium/Weak → achievement-overlap; ссылку на
  rubric → на digest.
- `build_master_profile.js`: achievement-секция тянется из банка.
- `user_resume_key_points.md`: перестаёт быть доменным rubric'ом (удаляется или
  становится сгенерированным digest'ом под тем же путём — решаю по коду).
- **Guard:** coverage-тест в `validate` — история из банка, не попавшая в
  digest/профиль → ошибка (молча не теряется).
- Триггеры — код/хук (pre-prepare + validate), не «Claude вспомнит» (глобальное
  правило про автоматику).
- Тесты: регресс на pipeline-fit-evaluator (не инфлейтит всё в Strong), генератор
  digest, freshness, coverage, анти-дрейф.

**НЕ источник фита (остаётся плумбингом):** discovery-keywords (что СКАНИМ —
отдельно от фита), Notion id, ATS-модули, company-tiers, geo, bridge-треки BL-37.
Дрейф profile.json (hub.intro/key_strengths «AI-native/fintech») — косметика, на
фит не влияет, чиним отдельным cleanup.

### Multi-profile: ОДНА логика для всех профилей (2026-06-15)

Структура/код едины: дайджест генерится из банка достижений КАЖДОГО профиля
одной кодовой дорожкой; фит читает его одинаково. Никаких opt-in/legacy.

- **Структура/код — едины.** Все профили: банк → digest → фит. Профиль без
  банка/digest = ошибка валидации/CI, а не тихий старый путь.
- **Контент — у каждого свой.** Realign касается ТОЛЬКО jared; у каждого свой
  банк, своя истина. Уравниваем рельсы, не смысл.
- **lilia:** её достижения — из её банка (её `coaching_state.md` / storybank),
  lossless, домен её. gitignored personal data — правим структурно, с явного
  согласия Джареда.
- **Будущие профили (Stage 18 wizard):** заводят банк + генерацию digest сразу;
  обновить шаблон/визард.
- **Тесты единообразны per-profile:** валидный банк → digest; coverage +
  анти-дрейф гоняются одинаково; фикстура-профиль проверяет полный цикл.

## NOT in scope

- Переписывание STAR-историй / storybank (домен-якорь там уже есть).
- Удаление fintech как рынка — остаётся как один из, не как «главная
  экспертиза».
- Автоматическая публикация в LinkedIn (нет доступа; копию готовим, вставляет
  кандидат).

## Status of work as of 2026-06-15

- **Стадия 1 (BL-189) — ✅ done.** career_narrative + alfa leadership cluster
  (12 PM/5/15) + analytics-from-scratch; master profile регенерирован, 16
  архетипов целы.
- **Пивот дизайна (согласован 2026-06-15):** рукотворный `positioning`/`fit_domains`
  rubric ОТМЕНЁН. Источник истины = **банк достижений** (`## Storybank` в
  `coaching_state.md`). Фит меряется по реальным достижениям; master profile + фит
  — производные от банка. Аудит показал: сегодня фит читает только устаревший
  `user_resume_key_points.md`, не master profile/storybank.
- **Стадия 2 переопределена** → «Fit по достижениям»: генератор fit-дайджеста из
  банка (freshness-хэш, pre-prepare) → перепайка `pipeline-fit-evaluator` +
  SKILL Step 4 на achievement-overlap → master profile achievement-секция из банка
  → coverage-тест в `validate` → убрать доменный rubric. Фит по всем реальным
  достижениям (seed + confirmed), strength скор не гейтит.
- **Дальше (стадия 2, КОД — следующий шаг):** написать генератор digest + перепайку
  фита + тесты (регресс на инфляцию Strong, freshness, coverage, анти-дрейф). Триггеры
  в коде/хуке. Затем стадия 3: прогон на пуле → реальные кластеры → архетипы +
  hard-фильтры под них.
- **Открытый вопрос на потом:** master profile achievement-секция — генерить из
  банка полностью или держать кластеры в resume_versions с coverage-guard'ом;
  решаю при написании генератора (точность vs объём правок build_master_profile.js).
