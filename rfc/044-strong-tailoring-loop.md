# RFC 044 — Autonomous Strong-fit tailoring loop (lexical mirror)

- Status: **approved** (2026-05-24 by user)
- Date: 2026-05-24
- Refs: BL-123 (this RFC's parent), BL-122 (validate-first спайк, который привёл к этой архитектуре), RFC 022 (two-phase prepare), RFC 043 (master profile schema — input contract), RFC 038 (TSV schema v4)
- Tier: L (per `DEVELOPMENT.md` — multi-file architectural change + new subagents + new pipeline branch + new output format)

## Problem

BL-122 Step 1 показал: установленный `olegvg/resume-tailor-plugin` даёт **~50%** того, что нужно. Хороший workflow scaffold, но **прескрипция тейлоринга прямо противоречит Scale.jobs research**:

- olegvg: «Use semantic variants (not exact repetition) across mentions» + «Cap at 3 appearances per keyword».
- Scale.jobs (2025): резюме на 80%+ JD-match даёт callback в 3-5× чаще; ATS НЕ понимает синонимы — «Agile frameworks» в резюме не засчитается, если в JD «SAFe methodology»; нужен **дословный mirror**.

Тест на Plaid PM подтвердил: ATS-формула вернула 92%, но coverage table содержала 10 строк вместо ~40 нужных, большинство JD-фраз («own a product area», «shape the roadmap», «open finance») в CV отсутствовали.

Кроме того сегодня **Weak/Medium fit eval идёт последовательно** в `prepare commit` — это упирается в latency LLM-запросов и линейно деградирует с размером batch'а.

## Approach (high level)

Внутри `prepare commit` добавляется **batch-dispatch слой**:

- **Weak/Medium fit** — продолжают идти через существующий archetype-pick flow, но в виде **параллельных subagents** (`pipeline-fit-evaluator`). Архетипная логика не меняется. Цель — снизить latency, не менять качество.
- **Strong fit** — каждая параллельно запускается через новый subagent `resume-tailor-mirror`, который:
  - Читает **master profile целиком** (RFC 043 output) + JD + опциональный профильный контекст.
  - **НЕ читает архетипы** из `resume_versions.json/versions[]` — собирает CV структуру с нуля.
  - Внутри — autonomous loop с lexical mirror: tailor → coverage → если < 85% и % растёт → переписать → повторить.
  - Exit: ≥85% **ИЛИ** no-growth (delta < +1pp за итерацию) **ИЛИ** iteration cap.
  - Escalation: `<85% no-growth` ИЛИ `≥85% uncertain_about_fact`.
- **Auto-ship** (≥85% без escalation): engine получает paragraphs от subagent'а, рендерит DOCX через `resume_docx.js` (РЕЮЗАЕМ, не меняем), пишет в `profiles/<id>/resumes/tailored/`, обновляет Notion-страницу.
- **Escalation**: запись в `profiles/<id>/.tailor-state/escalations-<ts>.md` + сводная таблица в конце batch'а в stdout. Notion не трогается, статус остаётся `To Apply`.

## Architectural decisions (forks → choices)

| # | Развилка | Решение | Обоснование |
|---|---|---|---|
| 1 | Pipeline integration point | **SKILL-driven loop, engine consumes enriched `results.json`** (orchestration в Phase 1.5 SKILL session, между fit-eval и handoff в `runCommit`) | Node engine не имеет Anthropic SDK / LLM invocation path — добавлять его означало бы сломать PII-free + LLM-free контракт (S1 security tier). SKILL уже исполняет LLM-вызовы (Phase 2 two-phase prepare), переиспользуем эту же сессию для tailor-loop через Task tool. Trade-off: SKILL-сессия должна довести loop до конца перед `prepare --phase commit`, но это уже инвариант Phase 2 today. |
| 2a | Subagent topology | **Два раздельных пула** | Slow Strong loop не блокирует Weak/Medium throughput. Pool sizing настраивается независимо. |
| 2b | Output format для Strong | **DOCX через существующий `resume_docx.js`** | Реюз без новых системных зависимостей (weasyprint = `uv` + `brew` install). Косметика — отдельный follow-up если понадобится. |
| 3 | `lexical_coverage` контракт | См. §Subagent contracts ниже | Заимствует pattern cover-letter paragraphs (RFC 019 / BL-14): subagent emits structured data, engine writes files. |
| 4 | Escalation surface | **MD-отчёт + stdout сводка** | Минимум инфраструктуры. TSV bump отложен — нет use case «следующий запуск должен помнить escalated state», `applications.tsv` уже хранит `fit_score` и Notion status. Если фонит → отдельный BL для TSV schema v5. |
| 5 | Auto-ship boundary | **Subagent возвращает данные, engine пишет PDF + Notion** | Сохраняет invariant RFC 022 «engine owns Notion writes», совместимо с revert-to-Inbox идемпотентностью (`prepare.js:1741-1753`). |
| 6 | JD-phrase extraction | **LLM-only внутри subagent'а** | Per BL-123 §163. Hybrid с heuristic — follow-up если воспроизводимость станет проблемой. Используем `extractJDStructure` (`engine/core/jd_extract.js`) как pre-extracted сырьё, но subagent волен переопределять «significance». |
| 7 | «Significant JD phrase» | **LLM judgment в subagent prompt** | Same rationale что и #6. Контракт: subagent в output возвращает список фраз с meta `{phrase, category, priority}` — мы видим что он считал significant. |

## Subagent contracts

Subagents are invoked by the SKILL via the Task tool (not by the engine). Engine never calls LLMs.

### `pipeline-fit-evaluator` (Weak/Medium parallelization)

**Цель**: обернуть существующую SKILL-логику fit-eval (Step 4 в `skills/job-pipeline/SKILL.md`) в subagent, который pipeline вызывает параллельно для batch строк.

**Input** (на каждую строку): `{ row_key, jd_text, jd_structure, profile_context }`.

**Output**: текущая SKILL-shape для одной строки — `{ row_key, fit_score, fit_rationale, cl_paragraphs, archetype_key, salary_band, … }`. Совместим с `applyFitFields` (`prepare.js:1492`). **Никаких schema изменений** — это refactor, не feature.

### `resume-tailor-mirror` (Strong only)

**Input**:

```json
{
  "row_key": "...",
  "jd_text": "...",
  "jd_structure": { "requirements": [...], "responsibilities": [...] },
  "master_profile_path": "profiles/jared/master_profile.md",
  "storybank_path": "profiles/jared/interview-coach-state/coaching_state.md",
  "profile_id": "jared",
  "target_role_title": "Plaid PM",
  "iteration_cap": 6
}
```

**Output** (одна запись на завершённый loop):

```json
{
  "row_key": "...",
  "iterations": [
    { "n": 1, "coverage_pct": 62, "missing": ["own a product area", "open finance", ...] },
    { "n": 2, "coverage_pct": 81, "missing": ["distributed teams", "scrum-of-scrums"] },
    { "n": 3, "coverage_pct": 88, "missing": ["distributed teams"] }
  ],
  "final_coverage_pct": 88,
  "exit_reason": "threshold_met",
  "escalate": false,
  "escalation_reason": null,
  "resume_data": { /* schema совместимая с resume_docx.js generateResumeDocx(data) */ },
  "coverage_table": [
    { "jd_phrase": "own a product area end-to-end", "category": "responsibility", "priority": "high", "status": "exact_match", "where": "Experience.Alfa.bullet[2]" },
    { "jd_phrase": "open finance", "category": "domain", "priority": "high", "status": "partial", "where": "Summary" },
    ...
  ],
  "uncertain_facts": []
}
```

**Поля `exit_reason`**: `"threshold_met"` | `"no_growth"` | `"iteration_cap_reached"`.
**Поля `escalate`+`escalation_reason`**:
- `escalate=true, reason="no_growth_below_threshold"` — `final_coverage_pct < 85` и last delta < +1pp. Модель застряла; нужно обогатить master profile или принять gap и шипить вручную.
- `escalate=true, reason="iteration_cap_below_threshold"` — `final_coverage_pct < 85` и last delta ≥ +1pp. Модель ещё растёт, но упёрлась в iteration cap. Можно поднять cap или принять текущий draft.
- `escalate=true, reason="uncertain_about_fact"` — `final_coverage_pct >= 85`, но `uncertain_facts[]` непустой (агент видит способ поднять выше, но не уверен в факте).
- `escalate=false` — auto-ship.

**Поля `uncertain_facts`** (массив объектов): `[{ fact: "led ML team of 8", source_hint: "не нашёл в master, но мог упустить", suggested_action: "confirm or deny" }]`.

**Поля `resume_data`**: shape consumed by `resume_docx.js` `generateResumeDocx(data, outputPath)`. См. existing schema там (contact / version / sharedExperience / sharedSections / certifications / projects). Subagent **синтезирует данные под эту schema** — не пишет новый renderer.

## Loop semantics

```
iteration = 0
prev_coverage = 0
loop:
  iteration += 1
  resume_data = tailor(master, jd, prev_resume_data, missing)
  coverage_pct, missing, uncertain_facts = score(resume_data, jd)
  if coverage_pct >= 85: exit("threshold_met")
  if (coverage_pct - prev_coverage) < 1: exit("no_growth")
  if iteration >= 6: exit("iteration_cap_reached")
  prev_coverage = coverage_pct
  prev_resume_data = resume_data
```

**Iteration cap = 6** — backstop против runaway loops (~6× tailor LLM calls на одну вакансию max).
**No-growth delta < +1pp** — per BL-123 §115.
**Threshold 85%** — per BL-123 §40 (Scale.jobs research §168).

## Pipeline integration

End-to-end flow с учётом архитектурного pivot'а (loop живёт в SKILL session, engine — pure consumer):

### Phase 2 — SKILL (Claude session, LLM-side)

1. **Fit-eval** (как сегодня) — каждая строка batch'а получает `fit_score`, `cl_paragraphs`, `archetype_key`, salary_band etc. Это шаг 4 в `skills/job-pipeline/SKILL.md`.
2. **Tailor-loop** (новый шаг, Phase 1.5 относительно engine; для SKILL это просто продолжение Phase 2). Для каждой Strong-строки SKILL **invoke'ает `resume-tailor-mirror` subagent через Task tool** в loop:
   - **Loop semantics** (без изменений vs §Loop semantics ниже): tailor → coverage → exit при ≥85% / no-growth delta < +1pp / iteration cap = 6.
   - **Escalation reasons** (расширены, см. §Subagent contracts):
     - `no_growth_below_threshold` — coverage < 85, last delta < +1pp.
     - `iteration_cap_below_threshold` — coverage < 85, last delta ≥ +1pp (модель ещё росла, но упёрлась в cap).
     - `uncertain_about_fact` — coverage ≥ 85, есть `uncertain_facts[]`.
   - **Orchestration owner**: SKILL session — она держит цикл, парсит output subagent'а, решает повторять или выходить. Engine о цикле ничего не знает.
3. **Write `results.json`** — SKILL обогащает каждую Strong-строку 5 новыми полями (см. §results.json schema extension ниже). Weak/Medium строки идут as-is (новых полей нет либо они null).

### Phase 3 — engine `runCommit` (pure consumer, no LLM)

Точка изменения: `engine/commands/prepare.js` → функция `runCommit`. Engine не вызывает subagent'ов и не вызывает LLM — он читает enriched `results.json` и ветвится:

```
for row in results:
  applyFitFields(row, skill_output)
  if row.tailoredResume:               # Strong, auto-ship
    generate resume DOCX from row.tailoredResume via resume_docx.js
    # НИ archetype-pick, ни resume_versions.json НЕ читаются для этой строки
    push Notion page (resumeVersion = путь к tailored DOCX,
                      mirror_coverage_pct = row.tailorCoverage)
  elif row.tailorEscalated:            # Strong, escalation
    revertToInbox(row)                 # existing helper, идемпотентен
    accumulate into escalations[]
    # Notion не трогается, status stays "Inbox"
  else:                                # Weak / Medium / Strong без tailor data
    generate resume DOCX (archetype-based, как сегодня)
    push Notion page
  generate CL PDF (existing flow, не меняется)
  save TSV

# end of runCommit:
render escalations[] via engine/modules/tailor/escalation_report.js
  → profiles/<id>/.tailor-state/escalations-<ts>.md
print stdout summary (точно как в BL-123 §60-69)
```

**Важно про fallback**: если Strong-строка пришла из старой SKILL-версии без `tailoredResume`/`tailorEscalated` полей, engine падает на archetype-pick path — то же поведение, что для Weak/Medium. Backward compat сохраняется.

**Важно про разделение ответственности**: вся LLM-orchestration живёт в SKILL session (Phase 2). Engine — пуристский pure consumer: читает JSON, пишет DOCX/Notion/TSV, рендерит escalation MD. Никаких Anthropic SDK зависимостей в `engine/` не появляется.

## results.json schema extension

SKILL Phase 2 дописывает **5 новых полей** в каждую Strong-строку `results.json`. Для Weak/Medium-строк поля **отсутствуют либо `null`** — engine в этом случае падает на archetype-pick path.

| Поле | Тип | Семантика |
|---|---|---|
| `tailoredResume` | `object \| null` | Structured resume data, matching input schema `engine/modules/generators/resume_docx.js` `generateResumeDocx(data, outputPath)` (contact / version / sharedExperience / sharedSections / certifications / projects). Это `resume_data` из final iteration `resume-tailor-mirror`. Engine рендерит DOCX прямо из этого объекта, archetype-pick не запускается. |
| `tailorCoverage` | `number \| null` | Final `coverage_pct` (0-100). Пишется в Notion property как `mirror_coverage_pct` для auto-ship строк. |
| `tailorEscalated` | `boolean` | `true` если loop вышел в escalation; engine ревертит строку в Inbox и аккумулирует в escalations list. `false` для auto-ship. |
| `tailorEscalationReason` | `"no_growth_below_threshold" \| "iteration_cap_below_threshold" \| "uncertain_about_fact" \| null` | Причина escalation. `null` для auto-ship. См. §Subagent contracts `escalation_reason`. |
| `tailorEscalationDetail` | `object \| null` | Сырьё для escalation report: `{ iterations: [{n, coverage_pct, missing}], uncertain_facts: [...], coverage_table: [...] }`. Engine передаёт это в `escalation_report.js` без трансформации. |

**Контракт инвариантов:**
- Если `tailoredResume` non-null → `tailorEscalated === false` и `tailorEscalationReason === null`.
- Если `tailorEscalated === true` → `tailoredResume` может быть null (escalation без draft'а) либо present (есть draft, но agent просит human review — например `uncertain_about_fact`). Engine на это поведение НЕ полагается: при `tailorEscalated=true` всегда revertToInbox, draft в DOCX не пишется в v1.
- Для не-Strong строк все 5 полей absent/null. Engine идёт стандартным archetype-pick путём.

## Escalation surface

**Файл**: `profiles/<id>/.tailor-state/escalations-<YYYYMMDD-HHMMSS>.md`.

```markdown
# Tailor escalations — 2026-05-24 16:30:00

| Job | Final coverage | Exit reason | Missing / Uncertain |
|---|---|---|---|
| Acme PM | 78% | no_growth | SAFe methodology, scrum-of-scrums, distributed teams >50 |
| Brex PM | 86% | uncertain_about_fact | "led ML team of 8" — confirm or deny |

## Details

### Acme PM (row_key=ats:lever:acme:pm-2026-05-24)
- Iterations: 3 → 78%, 78%, 78% (no_growth)
- Missing high-priority JD phrases:
  - "SAFe methodology"
  - "scrum-of-scrums"
  - "distributed teams >50"
- Suggested: add these to master_profile.md or accept gap and ship manually
- JD URL: https://...
- Master profile version: source_hash=00c8f940006a

### Brex PM (row_key=...)
- Iterations: 2 → 81%, 86% (threshold_met)
- Uncertain facts (would push to 92% if confirmed):
  - "led ML team of 8" — agent сомневается, нет в master profile
- Suggested action: confirm/deny via reply
- JD URL: ...
```

**Stdout сводка** в конце batch'а — точно как в BL-123 §60-69.

## No-fabrication guard

- **Subagent self-attests**: каждая фраза CV должна иметь factual basis в master profile или быть в acquirable-skills allowance (per BL-123 §52-56).
- **Engine не верифицирует** на этом этапе (поднятие до machine-verification — потенциальный follow-up BL).
- **Output contract включает `coverage_table[].where`** — где в master profile агент нашёл основание для каждой фразы CV. Это даёт юзеру surface для ручной проверки в подозрительных кейсах.
- **`uncertain_facts[]`** — explicit channel для случаев когда агент видит improvement opportunity но не уверен в факте.

## Что мы майним из olegvg (с attribution)

Положим в `skills/job-pipeline/references/` со строкой `Adapted from olegvg/resume-tailor-plugin (MIT — verify license before commit)`:

- `ats-format-rules.md` — Format Rules (single-column / no tables / standard headings / fonts / dates / acronyms) + Anti-Patterns. Из olegvg `references/ats-rules.md` строки 1-41 + 106-129.
- `locale-en.md` — US conventions целиком из olegvg `references/locale-en.md`.
- `section-templates.md` — EN slot-marker templates из olegvg `references/section-templates.md` (без RU части).

**Переписываем (Scale.jobs противоречие)**:
- olegvg «Keyword Integration» (Stage 3.4, SKILL.md lines 337-343) → exact mirror, без «semantic variants» и «cap at 3».
- olegvg «ATS Scoring Formula» (`references/ats-rules.md` lines 75-103) → добавляем `lexical_match_rate` weight 0.3, перевзвешиваем остальное.

**Discard** для v1: AskUserQuestion стратегические Qs (Stage 2), user-facing feedback report (Stage 1.5), Review/Iteration loop (Stage 5), HTML+weasyprint pipeline (Stage 6), RU templates, Cover Letter templates (используем существующий `pickClBase` flow).

## Backward compatibility

- `resume_versions.json` остаётся primary для archetype-pick path (Weak/Medium). Не трогаем.
- `resume_docx.js` schema не меняется. Strong path синтезирует данные под существующую schema.
- TSV schema v4 не меняется (per fork #4 — TSV bump отложен).
- Notion DB schema **не меняется по умолчанию**: имя tailored-resume пишется в существующее `resumeVersion` property как путь к файлу (вместо archetype key). На pre-existing rows ничего не сломается. Если фонит — переходим к v2 с отдельной property через DB migration.
- `prepare commit` без Strong-строк в batch — поведение идентично текущему.
- Старые SKILL клиенты, не знающие про новый flow: gracefully degrade — если результат SKILL не помечает строки как Strong (потому что старая SKILL версия), Phase 2 dispatch не запускается. То же поведение что без `Strong` в batch.

## Hard iteration / token budget

- Iteration cap: 6 (захардкожено в RFC, можно повысить через ENV `JARED_TAILOR_ITERATION_CAP` для экспериментов).
- Per-job token budget: **не вводим в v1** — iteration cap уже эффективный bound. Если runaway случится — добавим в v2.

## Files (плановые изменения)

**New:**
- `rfc/044-strong-tailoring-loop.md` (этот файл)
- `engine/modules/tailor/coverage_score.js` + `.test.js`
- `engine/modules/tailor/jd_phrase_extract.js` + `.test.js`
- `engine/modules/tailor/tailor_orchestrator.js` + `.test.js` (вызов subagent, парс output, диспатч)
- `engine/modules/tailor/escalation_report.js` + `.test.js`
- `.claude/agents/resume-tailor-mirror.md` (subagent definition)
- `.claude/agents/pipeline-fit-evaluator.md` (subagent definition)
- `skills/job-pipeline/references/ats-format-rules.md` (mined from olegvg)
- `skills/job-pipeline/references/locale-en.md` (mined from olegvg)
- `skills/job-pipeline/references/section-templates.md` (mined from olegvg)
- `profiles/jared/.tailor-state/` (output dir, gitignored через `profiles/<id>`)
- `profiles/jared/resumes/tailored/` (output dir, gitignored)

**Modified:**
- `engine/commands/prepare.js` — добавить batch-dispatch слой в `runCommit`
- `engine/commands/prepare.test.js` — тесты под новый flow
- `skills/job-pipeline/SKILL.md` — Step 7 split: archetype-pick для Weak/Medium, no-op для Strong (передача в tailor)
- `README.md` — секция про tailoring loop
- `docs/architecture/overview.md` — новая секция или расширение existing

**Untouched (explicit):**
- `engine/modules/generators/resume_docx.js` — реюзаем как есть
- `engine/core/applications_tsv.js` — TSV schema не меняется
- `engine/core/notion_job_page.js` — Notion property map не меняется (см. backward compat note про `resumeVersion`)
- `engine/core/profile_loader.js`
- `engine/modules/discovery/*` — adapters не трогаем

## Tests

- `coverage_score.js` — unit-tests на чистой функции `computeCoverage(jdPhrases, resumeText)`.
- `jd_phrase_extract.js` — unit-tests на парсинг (фикстуры из 3-4 real JDs, синтетических).
- `tailor_orchestrator.js` — mock subagent (faked output JSON), проверяем loop exit conditions, escalation triggering.
- `escalation_report.js` — рендер MD из массива escalation records.
- `prepare.test.js` (extension) — integration: подаём batch с Strong/Medium/Weak, проверяем что dispatch'нул правильно, что escalation report пишется, что Notion update пропускается для escalated.
- **Acceptance** (по BL-123 §126): Plaid PM (BL-122 baseline) + 2 свежие Strong. ≥2 из 3 auto-ship ≥85%; escalations с осмысленной причиной.

## Out of scope (explicit)

- **Параллелизация самого fit-scoring** (sequential SKILL eval) — отдельный BL, требует изменения SKILL flow.
- **Cover letter под mirror** — `pickClBase` flow продолжает работать как сейчас.
- **HTML+weasyprint output** — fork #2b закрыт в пользу DOCX. Revisit как follow-up если визуально не устраивает.
- **TSV schema v5 с `tailor_status` column** — fork #4 closed в пользу MD-only. Add column в follow-up если станет нужно.
- **Acquirable skills формализация** (explicit whitelist) — на LLM-judgment в v1, per BL-123 §153.
- **Bridge-архетипы** — BL-121.
- **Machine-verified no-fabrication guard** (engine validates each CV phrase against master profile) — follow-up.
- **Notion DB schema migration** (separate `Tailored Resume` property) — follow-up если перезапись `resumeVersion` фонит.
- **Retroactive перегенерация ghosted vacancies** — sunk cost.

## Open questions (для имплементации, не блокируют approve)

1. **Subagent pool sizing** — конкретное число параллельных Strong-агентов. Стартуем с `max_concurrent_strong = 3`, увеличиваем по результатам нагрузочного теста. Anthropic API rate limit — практически не достижим при batch_size ≤ 10.
2. **`coverage_pct` formula precision** — какие именно фразы из JD берутся в знаменатель и какой штраф за partial vs missing. Стартуем: `exact_match × 1.0 + partial × 0.5 + missing × 0` / total significant. Тюним по Plaid baseline.
3. **`jd_structure` дополнительные поля** — нужны ли `nice_to_have_skills`, `company_context`, `seniority_signals` отдельно или достаточно текущей `{requirements, responsibilities}` shape. Стартуем с существующим, расширим в реализации если subagent просит.
4. **Master profile staleness detection** — если `source_hash` в `master_profile.md` frontmatter не совпадает с computed по `resume_versions.json`, warn'им юзера до запуска Strong batch'а или нет. Lean: warn.
5. **Escalation deduplication** — если та же вакансия escalated в двух последовательных runs, склеиваем escalation entries или пишем заново. Lean: всегда новый файл с timestamp.

## Notes

- **Scale.jobs research** (BL-123 §168): 80%+ match → 3-5× callback; 70% → 15% callback rate; 80% → 35%; standard ATS pass = 75%; tech roles — 5.1× boost. Целимся в 85%+ с запасом над 80%.
- **Baseline для acceptance test** (Plaid PM): `docs/resume/draft-plaid-2026-05-24.md` (gitignored). Этот draft использует olegvg-плагин «как есть», coverage ~10 фраз вместо ~40. После закрытия BL-123 перегенерируем тот же JD через новый pipeline — должно быть ощутимо «зеркальнее».
- **RFC 043 (master profile)** — input contract subagent'а. Master profile **уже существует** в `profiles/jared/master_profile.md`, smoke test пройден (BL-124 DoD).
- **olegvg plugin LICENSE** — открытый вопрос. Перед mine'ингом references проверить лицензию (cache dir не содержит LICENSE файла). Если licence MIT/Apache — добавить attribution header в каждый mined файл. Если другое — оригинальный код не копируем, пишем эквивалент с нуля используя только публичные ATS conventions.

## Status / changelog

- 2026-05-24: draft создан после inventory subagent run (BL-123 Step 1a). Все 7 архитектурных развилок закрыты (4 confirmed by user via AskUserQuestion: pool topology, output format, escalation surface, JD extraction; 3 решены по проектным конвенциям и BL-123 спеке).
- 2026-05-24: **approved by user** as-is. Старт implementation — 3 параллельных subagent'а (mining, tailor module, agent definitions) + main thread на pipeline integration.

## 2026-05-24 — fork #1 revised: SKILL-driven loop

Post-approval discovery: node engine не имеет Anthropic SDK / LLM invocation path, и добавлять его означает сломать PII-free + LLM-free контракт (S1 security tier). Pivot: tailor-loop orchestration переезжает из engine `runCommit` в SKILL Phase 1.5 (Claude session), которая уже исполняет LLM-вызовы. Engine становится pure consumer enriched `results.json`.

Последствия:
- `tailor_orchestrator.js` и `jd_phrase_extract.js` остаются в репо как **reference-only** (не вызываются из engine runtime, могут пригодиться для будущих экспериментов или unit-тестов SKILL-side логики).
- `coverage_score.js` и `escalation_report.js` **остаются используемыми**: первый может быть вызван SKILL'ом через Bash / напрямую внутри subagent reasoning; второй — engine продолжает рендерить escalation MD из `tailorEscalationDetail`.
- Новый escalation reason `iteration_cap_below_threshold` добавлен для ясности: отделяет «модель ещё росла, но упёрлась в cap» от `no_growth_below_threshold` («застряла»). User видит разницу в escalation report и решает — поднять cap или обогатить master profile.
- Добавлена секция «results.json schema extension» — контракт SKILL → engine (5 новых полей на Strong-строку).
- Sections без изменений: research summary, lexical mirror rationale, threshold rationale, loop semantics, escalation surface, no-fabrication guard, olegvg mining, tests, out-of-scope, open questions, notes.

## 2026-05-25 — acceptance test findings (BL-123 Step 14)

Acceptance test прогнали end-to-end на jared: subagent live на Calendly Staff PM (coverage 64%, 4 uncertain_facts, 22 exact-match lexical mirror hits) + engine `prepare --phase commit --dry-run` на synthetic results.json с 3 строками (escalated / tailored / archetype). Все три route'а отработали: tailored → DOCX path `resumes/tailored/<slug>-<date>.docx`, escalated → status stays Inbox + escalation report MD + stdout summary, archetype → legacy resumeVer path. Engine wire подтверждён.

Два бага, найденных живым прогоном, исправлены тем же коммитом:

1. **Storybank path**: SKILL.md Step 6.5 указывал `profiles/<id>/storybank.md` — у Jared такого файла нет, storybank живёт внутри `profiles/<id>/interview-coach-state/coaching_state.md` под секцией `## Storybank` (см. `master_profile.md` строка 486 — это документированная ссылка). SKILL.md теперь резолвит первый существующий из двух путей. Subagent doc уже был корректен (показывал coaching_state.md в примере) — туда правка не нужна.

2. **Location requirements исключены из mirror**: subagent в acceptance test'е положил "San Francisco Bay Area" и "hybrid / office 1-2 times a week" в `missing[]` и в `uncertain_facts` — но геолокация — это upstream concern, enforced в `engine/core/geo_enforcer.js` ДО того как row доходит до subagent (BL-24 «US-anywhere wins»). Если row пришёл — geo check пройден или deferred. Mirroring location в резюме — шум: candidate's location уже в `contact.location`, и это весь resume-level location signal. `.claude/agents/resume-tailor-mirror.md` §"Significance" теперь явно исключает location requirements из `missing[]` / `coverage_pct` / `coverage_table` / `uncertain_facts`.
