# RFC 001 — Multi-profile Job Search Pipeline

**Status**: Approved 2026-04-19
**Tier**: L (new subproject, architecture, migration, 2+ users)
**Author**: Claude + Jared Moore

## Проблема

Два раздельных кодбейса (`Job Search/` у Jared, `Profile B Job Search/` у второго профиля) реализуют похожий pipeline. Новые фичи появляются у Jared и не попадают второму профилю — чтобы он их получил, надо копировать код вручную. Это дорого и ведёт к drift'у: CL-генерация уже расходится, filter-rules оформлены по-разному, Notion-схемы неконсистентны.

Нужен единый движок, который обслуживает оба профиля из общего кода и масштабируется на третьего пользователя / будущий SaaS.

## Варианты

- **A. Новый подпроект `AIJobSearcher/` с per-profile конфигами.** Единый движок, `profiles/jared/` и `profiles/profile_b/` с данными. Старые папки не трогаем — они остаются read-only fallback.
- **B. Shared library (npm-пакет) + два потребителя.** Переделать оба существующих проекта на общую либу. Минус: ломаем работающие MVP, пока либа не стабилизируется — у Jared поиск работы встанет. Противоречит требованию "старые проекты не трогать".
- **C. Форкнуть Jared в the second profile и синхронизировать руками.** Технический долг не решён — тот же drift, просто быстрее на старте. Не решает задачу "обновления у обоих".

## Выбрано + почему

**Вариант A.** Новый `AIJobSearcher/` движок с profile-оверлеем.

Причины:
- Старые проекты продолжают работать — у Jared активный поиск работы, риск ноль.
- Единый кодовый путь: фича пишется один раз, доступна обоим после `--profile X`.
- Архитектура годится для SaaS: профиль — это данные, движок — сервис.
- GitHub-публикация естественна (движок + `_example` профиль как стартовый kit).

## Архитектура

### Каталоги

```
AIJobSearcher/
├── engine/                           # shared code, no PII
│   ├── modules/
│   │   ├── discovery/                # ATS/board adapters (auto-registered by index.js)
│   │   │   ├── greenhouse.js
│   │   │   ├── lever.js
│   │   │   ├── ashby.js
│   │   │   ├── smartrecruiters.js
│   │   │   ├── workday.js
│   │   │   ├── calcareers.js
│   │   │   ├── usajobs.js
│   │   │   ├── indeed.js
│   │   │   └── index.js              # auto-discovery of adapters
│   │   ├── tracking/
│   │   │   └── gmail.js              # reads per-profile OAuth tokens
│   │   └── generators/
│   │       ├── resume_docx.js        # master format
│   │       ├── resume_pdf.js         # export for submission
│   │       └── cover_letter_pdf.js
│   ├── core/
│   │   ├── filter.js
│   │   ├── dedup.js
│   │   ├── notion_sync.js            # hybrid: direct API + MCP queue (as Jared now)
│   │   ├── validator.js
│   │   ├── fit_prompt.js             # assembles per-profile fit prompt for Claude
│   │   └── profile_loader.js
│   └── cli.js                        # node engine/cli.js <cmd> --profile <id>
├── profiles/
│   ├── _example/                     # committed to git, template for new users
│   │   ├── profile.example.json
│   │   ├── filter_rules.example.json
│   │   └── resume_versions.example.json
│   ├── jared/                        # gitignored (personal data)
│   │   ├── profile.json
│   │   ├── filter_rules.json
│   │   ├── resume_versions.json
│   │   ├── cover_letter_versions.json
│   │   ├── cover_letter_template.md
│   │   ├── salary_matrix.md
│   │   ├── company_preferences.tsv   # per-profile overlay on shared companies
│   │   ├── calcareers/
│   │   ├── interview-coach-state/    # copied (not linked) from old project
│   │   ├── applications.tsv          # per-profile pipeline
│   │   ├── cover_letters/
│   │   ├── resumes/
│   │   ├── jd_cache/
│   │   └── .gmail-tokens/            # OAuth tokens
│   └── profile_b/                        # gitignored
│       └── ...                       # same structure
├── data/                             # shared master pool, gitignored
│   ├── jobs.tsv                      # all jobs from all sources, dedup
│   └── companies.tsv                 # all companies across platforms (ats_source + ats_slug)
├── skills/
│   └── job-pipeline/SKILL.md         # unified skill with --profile flag
├── rfc/
│   └── 001-multi-profile-architecture.md
├── incidents.md
├── BACKLOG.md
├── .env.example
├── .gitignore
├── CLAUDE.md
├── README.md
└── package.json
```

### Shared vs per-profile (правило разделения)

**Shared (движок + `data/`)**:
- Код всех модулей (discovery adapters, generators, sync).
- `data/jobs.tsv` — мастер-пул вакансий. Дедуп по `(ats_source, job_id)`.
- `data/companies.tsv` — мастер-пул компаний с `ats_source + ats_slug`. Когда открываем новую платформу или добавляем компанию для любого профиля — запись в общем пуле, доступна всем.
- Адаптеры платформ: добавил файл в `engine/modules/discovery/` — автоматически доступен обоим профилям через `modules:` в profile.json.

**Per-profile (`profiles/<id>/`)**:
- `profile.json` — идентичность, подключённые модули, ссылки на конфиги.
- `filter_rules.json` — какие компании/роли/локации подходят.
- `company_preferences.tsv` — оверлей на shared companies: Jared хранит tier (S/A/B/C), the second profile — sonography_pivot / LA_presence.
- Resume/CL шаблоны и сгенерированные артефакты.
- `applications.tsv` — per-profile pipeline: `job_id → profile → fit, status, resume_ver, cl_key, notion_page_id`.
- Gmail-токены, Interview Coach state.

**Сценарий "discovery для одного — польза всем"**: ищем для the second profile на Indeed `OptumHealth` → запись уходит в `data/companies.tsv` с `ats_source=indeed`. Jared на следующем скане видит её в пуле, filter-rules решают, попадает ли она к нему в `applications.tsv`.

### Контракт `profile.json`

```json
{
  "id": "jared",
  "identity": {
    "name": "...",
    "email": "...",
    "phone": "...",
    "linkedin": "...",
    "location": "..."
  },
  "modules": [
    "discovery:greenhouse",
    "discovery:lever",
    "discovery:ashby",
    "discovery:smartrecruiters",
    "discovery:workday",
    "discovery:calcareers",
    "discovery:usajobs",
    "tracking:gmail",
    "generators:resume_docx",
    "generators:resume_pdf",
    "generators:cover_letter_pdf"
  ],
  "discovery": {
    "companies_whitelist": null,
    "companies_blacklist": [],
    "indeed_keywords": null
  },
  "filter_rules_file": "filter_rules.json",
  "resume": {
    "versions_file": "resume_versions.json",
    "output_dir": "resumes/",
    "master_format": "docx"
  },
  "cover_letter": {
    "config_file": "cover_letter_versions.json",
    "template_file": "cover_letter_template.md",
    "output_dir": "cover_letters/"
  },
  "fit_prompt_template": "Оцени fit вакансии для PM с фокусом на fintech. Strong = ...; Weak = ...",
  "notion": {
    "jobs_pipeline_db_id": "...",
    "companies_db_id": "...",
    "app_qa_db_id": "..."
  }
}
```

### Секреты

Все токены в корневом `.env` с namespaced ключами: `{PROFILE_ID_UPPERCASE}_{SERVICE}_{KEY}`.

Пример:
```
JARED_NOTION_TOKEN=...
JARED_USAJOBS_API_KEY=...
JARED_GMAIL_CLIENT_ID=...
PROFILE_B_NOTION_TOKEN=...
PROFILE_B_GMAIL_CLIENT_ID=...
```

Gmail OAuth refresh-токены в файлах `profiles/<id>/.gmail-tokens/` (gitignored).

### CLI

`node engine/cli.js <cmd> --profile <id> [options]`

Команды:
- `scan` — обойти подключённые discovery-модули, обновить `data/jobs.tsv` + `profiles/<id>/applications.tsv`.
- `prepare [--batch N]` — для новых заявок: назначить resume archetype, сгенерировать CL, создать Notion-страницу.
- `sync` — двусторонняя синхронизация с Notion.
- `check` — проверить Gmail на ответы, классифицировать, обновить Notion.
- `answer` — сгенерировать ответы на form-questions (210 char limit из Jared's feedback).
- `validate` — pre-flight: URL alive, company cap, TSV hygiene.

## Риски / что может сломаться

1. **Регрессия генераторов при переносе.** DOCX/PDF из `generate_resumes.js` у Jared — работающий код, копия которого может дать другой output.
   → Smoke-тест сравнивает output с эталоном по ключевым полям; первый прогон на одном архетипе с визуальной проверкой.

2. **Дубли в Notion.** Миграция создаёт новые страницы в новых базах; старые остаются в старых базах.
   → Новые Notion-базы создаём с нуля, дедуп внутри миграционного скрипта по `(company + job_id + source)`.

3. **Rate limits Notion** при массовой заливке всей истории (~1000 страниц Jared + ~50 the second profile).
   → Батчинг по 3 req/s (текущий лимит Notion), retry с exp backoff, checkpoint для возобновления.

4. **Concurrent scan → коллизия в `data/jobs.tsv`.**
   → Scan последовательный per profile, `flock` на `data/jobs.tsv`.

5. **Секреты в репо при публикации.**
   → `profiles/*/` в `.gitignore` (кроме `_example`), `data/*` в `.gitignore`, `.env` тоже. Grep на token patterns перед financial commit.

6. **Старые скрипты Jared ссылаются на абсолютные пути.**
   → Новый проект **полностью автономен**. Никаких симлинков/ссылок на старые папки. Interview-coach state и конфиги **копируются** на этапе миграции.

7. **Потеря interview-coach state при параллельной работе в старом и новом проекте.**
   → До финального переключения — работаем в старом проекте. Копию state'а берём одним снимком при переключении, дальше — только новый проект.

## План проверки

**Smoke-тесты (обязательны для всех, `node --test`)**:
- `engine/modules/generators/resume_docx.test.js` — генерит DOCX из тестового profile, файл существует, валидный zip.
- `engine/modules/generators/cover_letter_pdf.test.js` — PDF создан, магическое число `%PDF` на месте.
- `engine/core/filter.test.js` — тестовая вакансия проходит/не проходит правила.
- `engine/core/dedup.test.js` — два скана подряд дают 0 дубликатов.
- `engine/cli.test.js` — `--profile` загружает правильный конфиг.

**Юнит-тесты**:
- `filter.js` — blocklists, company cap, location.
- `dedup.js` — нормализация названий компаний, collision keys.
- `fit_prompt.js` — подстановка переменных.
- Discovery-адаптеры — парсинг ответа ATS API → normalized job record (моки сети).

**Интеграционные тесты**:
- `notion_sync.js` против mock (stub `@notionhq/client`) — create/update/read.
- `gmail.js` — моки Gmail API response.

**Ручная проверка (чеклист)**:
- [ ] Скан `--profile jared` даёт ≥1 новую вакансию в `data/jobs.tsv` и заявку в `profiles/jared/applications.tsv`.
- [ ] Скан `--profile profile_b` через Indeed даёт ≥1 вакансию.
- [ ] `prepare --profile jared` создаёт Notion-страницу, PDF резюме, PDF CL.
- [ ] `sync --profile jared` подтягивает статусы из Notion.
- [ ] То же для the second profile.
- [ ] Визуальная сверка PDF резюме: макет не сломан.
- [ ] Старые папки `Job Search/` и `Profile B Job Search/` **не изменены** — проверка `git status` в конце.

**Миграция данных — двухфазная**:
1. **Dry-run**: скрипт читает обе старые Notion-базы, строит `migration_plan.json`, показывает мне.
2. После approve — реальный перенос с checkpoint'ом (возобновляем с места остановки).

## План реализации по частям

Каждый этап — свой mini-approve. Между этапами — self-check по DOD (перечитать diff, прогнать тесты, `git status` старых папок).

| Этап | Что | Тесты | Approve |
|---|---|---|---|
| 1 | Scaffolding: каталоги, `package.json`, `.gitignore`, `CLAUDE.md`, `README.md`, `.env.example`, `BACKLOG.md`, `incidents.md`, RFC | — | дерево + файлы |
| 2 | Generators: resume DOCX/PDF, CL PDF — перенос из Jared as-is | smoke + unit | diff + green |
| 3 | Core: filter, dedup, validator, fit_prompt, profile_loader | unit | diff + green |
| 4 | Notion sync (hybrid) | integration с mock | diff + green |
| 5 | Discovery adapters по одному: greenhouse → lever → ashby → SR → Workday → calcareers → usajobs → indeed | unit с mock | после всех |
| 6 | CLI + skill SKILL.md | smoke | diff + dry-run |
| 7 | Profile Jared: перенос конфигов | ручной smoke: 1 resume + 1 CL | визуальная проверка |
| 8 | Profile the second profile: перенос конфигов | ручной smoke | визуальная проверка |
| 9 | Миграция dry-run | проверка `migration_plan.json` | approve плана |
| 10 | Миграция реальная с checkpoint | ручная проверка нескольких страниц | финальный approve |
| 11 | `/security-review` + `/review` на весь diff | critical fixed | финальный merge |

## Безопасность (S1 — базовый)

### Engine isolation (push-модель)

Движок — чистые функции. Модули в `engine/modules/` (generators, discovery, tracking) **не имеют** прямого доступа к `profiles/`. Данные идут снизу вверх: `profile → loader → CLI → engine`.

- **Единственная точка чтения `profiles/`** — `engine/core/profile_loader.js`. Остальные модули получают данные аргументом.
- **Валидация id**: regex `^[a-z][a-z0-9_-]*$`, `path.resolve` + проверка, что resolved-путь строго внутри `PROFILES_DIR`. Никаких `../` и абсолютных путей.
- **Per-invocation scope**: за одну CLI-команду loader вызывается ровно один раз для одного профиля. В памяти процесса — данные только активного профиля.
- **Секреты**: CLI читает только `${ID.toUpperCase()}_*` env-переменные. При `--profile jared` токены `PROFILE_B_*` в память не подгружаются.
- **Output paths**: генераторы принимают явный `outputPath`. Loader проверяет, что путь ведёт внутрь `profiles/<id>/`. Side-effect вне `profiles/<id>/` — запрещён.
- **Grep-проверка** в code-review: engine-модули не должны содержать `profiles/`, `readFileSync.*profile`, id конкретных профилей.

Для будущего SaaS (S3) — per-profile процессы/контейнеры, runtime-изоляция на уровне ОС. Сейчас overkill.

### Общие правила S1

- `.env` только локально, `NOTION_TOKEN`, `USAJOBS_API_KEY`, `GMAIL_*` никогда в коде.
- `profiles/jared/` и `profiles/profile_b/` в `.gitignore` целиком. `profiles/_example/` — только синтетика.
- `data/*.tsv` в `.gitignore`.
- Перед merge: `npm audit` на новые зависимости, `/security-review` на весь diff, grep на token patterns (`sk-`, `ntn_`, длинные base64).
- Инциденты → `incidents.md` (blameless формат).

## Что НЕ делаем в этой итерации

Отложено в `BACKLOG.md` с датой и триггером:
- SQLite/Postgres вместо TSV.
- Чистый Notion API без MCP-гибрида.
- `.env` per profile.
- Унификация Interview Coach skill.
- Markdown-vault экспорт для Obsidian.
- Self-service для the second profile.
- CI (GitHub Actions).
- Линтеры (ESLint + Prettier).
- Pre-commit hook.
- Выбор лицензии.
- GitHub-витрина (README demo, скриншоты).
