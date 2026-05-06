# RFC 019 — CL layout: MD/PDF split + per-company subfolders

**Status**: proposed
**Related**: [BL-14](../private/backlog/BL-14.md), [BL-9](../private/backlog/BL-9.md)
**Created**: 2026-05-06

## Problem

1. Cover letters сейчас пишутся только в `.md` — для подачи в ATS приходится конвертить вручную.
2. Все CL валятся плоско в `profiles/<id>/cover_letters/`. После 350+ заявок — свалка, нельзя глазами найти CL по компании.
3. `engine/modules/generators/cover_letter_pdf.js` существует (pdfkit, прод-ready) и протестирован, но **никем не вызывается** — SKILL пишет `.md` сам, engine prepare commit только обновляет TSV.
4. Архитектурно неверно: запись файла CL живёт в SKILL (AI), а должна — в engine (код), per code-first principle.

## Options

**A. Engine двигает файлы после SKILL**
SKILL пишет `.md` в плоский `cover_letters/`, engine commit phase двигает в `cover_letters_md/<Company>/`, парсит контент обратно в параграфы, рендерит PDF.

- **Плюс**: zero-touch на SKILL.md.
- **Минус**: грязный flow — файл живёт в неверном месте секунды-минуты, потом мигрирует. Парсить MD обратно в параграфы — extra step с потенциальными edge cases (отступы, табуляция, escape). Архитектурно остаётся code-first violation.

**B. SKILL отдаёт параграфы → engine пишет всё** ✅ выбрано

SKILL Step 8e больше не пишет файл. Вместо этого включает `clParagraphs: string[]` в results.json. Engine prepare commit читает параграфы, пишет MD + PDF в правильные пути.

- **Плюс**: code-first соблюдён, engine — единственный writer файлов CL, чистый mental model. Параграфы уже в нужной структуре (массив), не надо парсить MD.
- **Минус**: SKILL.md меняется, требуется один прогон для обкатки нового формата.

## Decision

**Вариант B.**

## Scope

### 1. Engine: `prepare commit` пишет MD + PDF

`engine/commands/prepare.js`, `runCommit()`:

- Для каждого `decision: "to_apply"` с `clParagraphs`:
  1. Slugify company name → `companySlug`.
  2. `mdPath = profiles/<id>/cover_letters_md/<companySlug>/<clKey>.md`
  3. `pdfPath = profiles/<id>/cover_letters/<companySlug>/<clKey>.pdf`
  4. `mkdirSync({recursive: true})` для обеих подпапок.
  5. Write MD: параграфы джойнятся `\n\n`.
  6. Call `generateCoverLetterPdf({paragraphs}, pdfPath)`.
  7. Запись `cl_path` в TSV → **PDF path** (относительный от профиля или абсолютный — см. ниже).

`cl_path` формат: **относительный от `profiles/<id>/`**, например `cover_letters/Affirm/Affirm_..._20260505.pdf`. Это согласовано с тем, как resume_path сейчас хранится (относительные).

Notion `Cover Letter` (rich_text) — **имя файла PDF** (`Affirm_..._20260505.pdf`), без пути. Используется для поиска по диску / Drive.

Idempotency: если PDF уже существует — **не перегенерировать**. Если MD уже существует — overwrite (новый прогон prepare = свежий контент).

### 2. SKILL update

`skills/job-pipeline/SKILL.md` Step 8e и Step 10 schema:

- Step 8e: убрать «Save the CL as ...md». Заменить на «Include the CL paragraphs as `clParagraphs: string[]` in the results.json entry. Engine writes the .md and .pdf files in commit phase.»
- Step 10 results schema: добавить `"clParagraphs": ["P1...", "P2...", "P3...", "P4..."]` в example для `decision: "to_apply"`. Поле обязательно для to_apply, отсутствует для skip/archive.
- Step 9 Notion `Cover Letter` field: уточнить — `<clKey>.pdf` (с расширением), не filename stem.

### 3. Slugify helper

`engine/core/company_slug.js` (new):

- `slugifyCompany(name: string): string`
- Правила: replace `&` → `and`, replace not-alphanumeric → `_`, collapse multiple `_` → single, trim leading/trailing `_`. **Preserve case** (`Affirm`, не `affirm`).
- Edge cases: empty → `_unknown`. Pure-symbol → `_unknown`.
- Тесты для: simple name, ampersand, comma+dot (`Stripe, Inc.` → `Stripe_Inc`), hyphen, multiple spaces, unicode (`Авито` → `_unknown` после non-alphanumeric — приемлемо для текущего scope, profiles US-only).

### 4. Migration script

`scripts/migrate_cl_layout.js`:

- Default `--dry-run`, `--apply` для записи. `--profile <id>` обязателен.
- Алгоритм:
  1. Читает TSV профиля.
  2. Для каждой row с непустым `cl_path`:
     - Если `cl_path` уже относительный от `cover_letters/<Company>/` или `cover_letters_md/<Company>/` — skip (уже мигрировано).
     - Else: рассматривает как legacy flat path (или basename). Резолвит исходный `.md` файл в `profiles/<id>/cover_letters/<file>.md`.
     - `companySlug = slugifyCompany(row.company)`.
     - Move `.md` → `profiles/<id>/cover_letters_md/<companySlug>/<file>.md`.
     - If PDF не существует в новом месте → read MD, split by `\n\n` → paragraphs, generate PDF → `profiles/<id>/cover_letters/<companySlug>/<file>.pdf`.
     - Update TSV row: `cl_path` → новый PDF relative path.
  3. Для orphan `.md` файлов в `cover_letters/` (нет соответствующей TSV row) — оставить на месте, warning.
  4. Backup TSV перед записью: `applications.tsv.pre-cl-migrate-<ISO>`.

Idempotent: повторный запуск ничего не делает (skip-условие по uже-новым путям).

### 5. Tests

- `engine/core/company_slug.test.js` — 6+ unit для slugify.
- `engine/commands/prepare.test.js` — extend with: commit phase читает `clParagraphs`, пишет оба файла, TSV `cl_path` → PDF, idempotency (не перегенерит существующий PDF).
- `scripts/migrate_cl_layout.test.js` — synthetic profile (3 CL: 1 уже мигрирован, 1 legacy without PDF, 1 orphan). Dry-run reports plan, --apply переносит + генерит PDF.

## Non-scope

- **Notion file-attachment** для CL — требует CDN (S3 / Cloudinary), отдельный таск.
- **Edit-in-place mechanism** — если юзер отредактировал MD вручную, как переждать regen в prepare. Отдельный таск.
- **Resume layout** — резюме уже работает с PDF, не трогаем.

## Risks

- **SKILL transition**: первый прогон prepare после деплоя — Claude должен использовать новый формат results.json. Если по инерции запишет `.md` сам — engine не сломается (старый код writes `.md` вообще не было), но появится lonely `.md` без записи в TSV. Mitigation: SKILL.md явно говорит «do NOT write the file», engine логирует warning если `to_apply` row пришла без `clParagraphs`.
- **Migration с большим числом файлов** (350+ для Jared): pdfkit synchronous-ish (Promise per file), ~50ms/PDF на m1. ~17s total. Приемлемо.
- **Slugify edge case** для Lilia (healthcare имена клиник): большинство ASCII, slug сработает. Если что-то поломается — увидим в migration dry-run, поправим.

## Test plan (manual smoke)

1. Unit + integration tests pass.
2. Migration script `--dry-run --profile jared`: видим план переноса для всех ~350 CL.
3. Migration script `--apply --profile jared`: проверяем 3-5 случайных CL — MD в `cover_letters_md/<Company>/`, PDF в `cover_letters/<Company>/`, TSV обновлён, оригиналы перенесены.
4. Запуск `prepare --phase pre --profile jared` → SKILL Step 8e → results.json содержит `clParagraphs`.
5. `prepare --phase commit --profile jared --apply`: видим оба файла в правильных подпапках.
6. То же для `--profile lilia`.

## DOD

- `engine/core/company_slug.js` + тесты (≥6).
- `engine/commands/prepare.js` commit phase пишет оба файла, idempotent.
- `engine/modules/generators/cover_letter_pdf.js` подключён к prepare commit.
- `skills/job-pipeline/SKILL.md` Step 8e + Step 10 schema + Step 9 Notion field обновлены.
- `scripts/migrate_cl_layout.js` с dry-run / --apply, тестами, README.
- CHANGELOG запись.
- BL-14 закрыт (status: done, closed:date, ✅ Plan, Progress).
