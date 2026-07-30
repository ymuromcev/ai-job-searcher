# prep exam — Exam-Round Prep Workflow

Invocation: `prep exam [company]`. Read this file instead of the `screening` / `manager` flow in `prep.md` whenever `kind: exam`.

**When this flow applies.** The round tests a closed discipline where answers are right or wrong and a canonical source exists: probability and statistics, A/B testing and experiment design, SQL, credit-risk or unit-economics metrics, financial math. Signals: the employer says "live discussion with questions and problems", "we'll calculate on a napkin", "technical section", or names a syllabus.

**When it does not.** Open-ended system design, product-sense cases, behavioral rounds. Those keep the boundaries in `prep.md` § "Open-format coaching boundaries".

**Goal.** Not to sell the candidate. To make them able to answer correctly, out loud, under time pressure, in the interview language.

## Why this flow exists

It was written from a documented failure: `profiles/jared/interview-coach-state/2026-07-29_PREP-POSTMORTEM_plata-section1.md` (findings F1–F41). Three independent causes, each of which this flow blocks by construction:

1. The employer's scope document was read on day two, after the candidate pushed. Readiness was therefore measured against the coach's own route, and "100% covered" was sayable with a scope row empty. → § Scope source precedence, § Curriculum table.
2. Material that didn't land was **deleted** rather than repackaged. The coach literally said "forget the interval-overlap thing, I brought it up for nothing"; the interviewer asked exactly that two days later. → § Debts ledger.
3. Fifty minutes went to guessing the format, abstractions were taught without numbers, and the cheat-sheet row schema was re-decided per block. → § Teaching protocol, § Cheat-sheet entry schema.

The same rule had been written in prose four times in three days and regressed every time. So the mechanisms below are **artifacts to fill and checks that fail**, not reminders.

## Core invariant — status transitions in the curriculum table

Every curriculum row carries a status: `не начат` → `объяснён` → `отработан вслух`.

**The status is moved at the moment of transition, before moving to the next topic.**

_Failure mode:_ if you explained a topic and moved on without moving its status, you have violated the invariant. Stop, move it, continue. "I'll fill in the statuses at the end" is forbidden — that is exactly how a whole session's progress became an unverifiable guess.

This cannot be enforced by a hook: there is no reliable trigger for "a topic was just explained". It is enforced socially instead — the table is in a file the candidate reads, and `scripts/round_audit.js` reports any row still `не начат` the moment readiness is claimed.

## Scope source precedence

The list of topics comes from exactly one place, in this order:

1. **A document from the employer** (prep guide, agenda, syllabus, take-home brief). If one exists, read it **before** teaching anything, and copy its topic lines **verbatim** into the curriculum table. Paraphrase is forbidden: a paraphrase is already the coach's synthesis and it hides divergence from the real scope.
2. **The recruiter's or interviewer's written description** of the round, quoted.
3. **The candidate's recollection**, explicitly marked as such in the round file (`scope_source: recollection`) — the weakest case, and the one where an extra clarifying question to the recruiter is worth asking.

Two hard rules:

- **The document outranks the candidate's own prediction.** If the candidate says "they won't ask the formulas" and the document says "questions and problems", the document wins. Agreeing with the candidate here is how mechanics went un-drilled and got asked.
- **The document outranks the coach's route.** Progress is a fraction over the table, never an impression. Saying "85%" while a scope row is empty is a defect.

## Assembly order — the whole scope before the first case

The five steps run **in this order**, and the order is the point. Step 4 comes after step 2 because a case assembled before the scope is known becomes a *filter*: topics the case happens not to touch quietly disappear, which is the same failure as deleting a debt.

1. **Source.** Name a concrete canonical material and pin it in `sources:`. Not "I know statistics" — "Wasserman, All of Statistics, ch. 10". For topics with no canonical material (behavioral framing, company-specific practice), write literally `мой синтез` in the source cell so the candidate sees where reliability drops and where to double-check the coach.
2. **Scope.** Topic rows verbatim from the scope source, each mapped to a section of the pinned material — **and to whatever that section rests on**. The textbook itself states its prerequisites; taking them from the source rather than from your own sense of what's needed is what keeps the descent free of holes. Added prerequisite rows are marked `+ prerequisite`. An empty source cell is a defect (detector 1).
3. **Grounding.** Find where the employer's domain overlaps something the candidate has actually run, and take the dataset from there. For a card-portfolio round with a candidate who ran a credit-card funnel, the numbers are his funnel's. This is what makes the top of every pyramid already-known — there has to be something to descend *from*.
4. **Cases.** Only now build the pyramids: small ones first, then the big one that consumes them (§ Что считается кейсом, § Матрёшка). Every topic row from step 2 must end up reachable from some apex; coverage is checked by detector 10, not by memory.
5. **Drilling.** Descend each pyramid apex-first (§ Разворачивание), then re-ascend and re-answer the apex question whole.

### Why top-down at all

Documented, candidate-reported, 2026-07-29: after section 1 he had learned the primitives and still could not apply them — *"знание с другой стороны"*. Definitions are indexed the way the textbook indexes them; the interview asks in the shape of a situation ("here's the readout, what do you do"). When the storage context and the retrieval context don't match, the knowledge is not available under load. Same mechanism as the English rule — you don't get to choose the shape of the question, so you store in that shape.

This does **not** relax the source requirements. Every primitive still comes from the pinned material with a derivation; what changes is that it arrives as the answer to a question the case already raised, and it arrives with a visible parent.

## Что считается кейсом

A unit is a **case** when it ends in a decision that has an owner and a price for being wrong, and it can be stated **without naming a single statistical instrument**. A unit is a **step** when it names the apparatus and no one owns its outcome. A step has a right answer; a case has a wrong decision and a bill.

| Кейс | Шаг |
| --- | --- |
| Эксперимент закончился, что говорим команде? | Посчитать p-value для метрики |
| Делинквенси в новой когорте выше — сигнал или шум? | Посчитать стандартную ошибку |
| Трафика на три теста, инициатив семь — что берём? | Проверить нормальность распределения |

Detector 12 reads the apex text and reports one that names the apparatus. The fix is never to delete the pyramid — it is to restate the apex as the decision that step was serving. If no such decision exists, the topic has no standalone applied meaning and belongs inside another topic's descent, marked `служебное`.

## Матрёшка — small pyramids, then the big one

Each small pyramid is complete on its own: apex → descent to primitives → re-ascent → the candidate answers the apex question out loud. Several small pyramids then compose into a big one, and the big apex is a decision that **cannot be made without the smaller verdicts** — not a sum of topics.

```
K1 · малый — Тест на активации дал +2.1%, катим?
K2 · малый — Делинквенси в новой когорте выше: сигнал или шум?
K3 · малый — Сколько ждать до решения, хватит ли объёма?
K4 · большой — Трафика на три теста, инициатив семь: что берём и как меряем,
               чтобы через квартал можно было честно сказать, что сработало
```

**At the big level the primitives are not re-taught.** The descent from a big apex stops at the small apexes — those nodes are already closed, and the file references them as `[K1]`, `[K2]`. The big pyramid teaches composition and trade-offs only: what you pay when three questions share one traffic budget. This is what keeps the structure from becoming bulky, which is the whole reason for the nesting.

**Some topics have no small apex by nature.** Multiple comparisons, peeking at an unfinished test, sample-ratio mismatch — these exist *because* there are many experiments, so their applied meaning appears only at the big level. They are assigned there, and detector 10 counts coverage **across all levels at once** precisely so that nobody invents a fake small case to satisfy a per-level count.

**Statuses do not multiply.** The big pyramid is its own row in the curriculum table with the same three statuses. There is no fourth status like «собрал вместе» — composition is a topic, and it gets said out loud like every other one.

## Разворачивание — from the apex down

Each pyramid is written into the round file as nested bullets under `### <id> · <уровень> — <вершина>`. A node states the question **in the shape it arrives in**, then the answer after `→`, then the curriculum row it maps to:

```markdown
### K1 · малый — Тест на активации дал +2.1%, катим?

- Как понял, что значимо? → p-value ниже порога значимости `[тема 4]`
  - Что такое p-value? → вероятность увидеть такой результат или сильнее, если разницы нет `[тема 4]`
    - Что значит «если разницы нет»? → нулевая гипотеза и распределение результата при ней `[тема 3]`
      - Почему распределение известно? → ЦПТ: среднее по большой выборке нормально `[тема 2]`
  - Что такое порог значимости? → уровень α, выбранный заранее, цена ложного «катим» `[тема 5]`
- Хватило ли объёма, чтобы этому верить? → мощность и MDE `[тема 6]`
```

Two mechanical rules, both checked:

- **Every answering node carries a `[тема N]`, a `[K<n>]`, or the mark `мой синтез`.** A node with none of the three is a primitive you brought in from outside the pinned source — detector 11. This is what makes «это нужно для этого» structural: each primitive has a parent that explains why it is there, and a source that says it is true.
- **Every curriculum row is reachable from some apex** — detector 10. The two allowed fixes for an unreachable row are: extend a case with another decision, or mark the row `служебное` naming the node it lives under. Dropping the row is not one of them.

**Where the descent stops.** A node is closed when the candidate answers it out loud in their own words. Not when you judge that they know it — «ты это знаешь» is one of the four banned phrases (`conventions.md` Rule 16), and assuming closure is exactly how primitives ended up learned-but-unusable.

**Then go back up.** After the bottom, return to the apex and have the candidate answer the original question whole. That re-ascent *is* the check that applicability assembled; without it you have taught a set of definitions in a different order.

## The round file

Path: `profiles/<id>/interview-coach-state/rounds/<YYYY-MM-DD>_<company>_<kind>.md`. Create it **before the first teaching message**, and show the candidate the filled curriculum table before starting to teach. Section order in the file: `## Программа` → `## Кейсы` → `## Долги` → `## Мок` → `## Readiness DoD`. Start from `templates/round-exam.md`.

```yaml
---
kind: exam
company: Plata
round: "Section 2 — credit risk metrics"
interviewer: "Alexey Palukhin"
datetime: 2026-08-05T14:00:00-07:00 # source of truth for the freeze; keep the offset
language: ru
scope_source: "Plata_Risk_5_Sections_Prep.docx, section 2"
sources:
  - "Wasserman, All of Statistics — ch. 6, 10"
  - "Kohavi et al., Trustworthy Online Controlled Experiments — ch. 3, 17–18"
status: prep # prep | ready | done
---
```

### Curriculum table

| #   | Тема (verbatim from `scope_source`) | Источник (section)  | Прогонный кейс                | Статус           |
| --- | ----------------------------------- | ------------------- | ----------------------------- | ---------------- |
| 1   | «доверительные интервалы»           | Wasserman 6.3       | Альфа: CR 10% → 13%, n = 4000 | отработан вслух  |
| 2   | «статистические критерии»           | Wasserman 10.1–10.4 | same                          | не начат         |

Row count is fixed by the scope source. The coach may **add** rows (a prerequisite the source assumes) but may never **drop** one. An added row is marked `+ prerequisite` in the topic cell so the fraction stays honest.

### Debts ledger

Anything that did not land, was cut for time, or was dismissed mid-explanation goes here immediately.

| id  | Дата       | Долг                                        | Почему всплыл                          | Закрыт |
| --- | ---------- | ------------------------------------------- | -------------------------------------- | ------ |
| D1  | 2026-07-27 | перекрытие CI vs интервал разности          | сказал «забудь, зря приплёл»           | —      |

Protocol:

- A debt row is **never deleted**. It gets `Закрыт: <date> — проговорено вслух`.
- ids are sequential. A **gap in the numbering means someone deleted a row**, and audit detector 4 reports it. This is the only way to make the ledger non-clearable in a directory that is outside git.
- Dismissing your own half-finished explanation ("forget it, my mistake to bring it up") without opening a debt is the specific failure this ledger exists to prevent.

### Cheat-sheet entry schema

One file per round, next to the round file, named `<same-base-as-round-file>_ШПАРГАЛКА.md`. The audit and the write guard find it by that name — a differently named file is invisible to both.

**Numbering ties the two files together.** A cheat-sheet heading is `## N.M`, where **N is the curriculum row number** and M counts entries inside that topic. This is what lets detector 7 tell a covered topic from an uncovered one mechanically, with no keyword matching. Row 2 of the curriculum is covered by `## 2.1`, `## 2.2`, and so on.

Terse — a reminder, not a textbook. Every entry:

```markdown
## 2.3 Название · СИМВОЛ

- Триггер: …
- Определение: …
- Для меня: …
- Формула: … Вытекает из: …
- 🗣️ Если спросят: «одна проговариваемая реплика целиком»
```

- `Триггер:` is the **situation in which you reach for this**, written as the moment in the case, not as a topic name: «эксперимент закончился, надо сказать, эффект это или шум». It is what makes the sheet indexable the way the interview queries it — by situation, not alphabetically. A section with a definition and no trigger is a defect (detector 13): it is the same "knowledge from the other side" the whole flow exists to prevent, just written down.
- `Формула:` without `Вытекает из:` is a defect — a formula the candidate cannot re-derive collapses under a follow-up. Blocked at write time by `prep_freeze_guard.js`.
- `🗣️ Если спросят:` is one complete sentence the candidate can read aloud cold, in the interview language. For English rounds it obeys `conventions.md` rule 1 (full words, no symbols) and rule 5 (vocabulary from the Reword mastered set). One line per likely trap — not a script for the whole answer.
- A topic marked `отработан вслух` with no `🗣️` line is a defect (detector 6).

## Teaching protocol — per topic, in this order

The order is **use → mechanism → check**, never definition → formula → use. A topic is entered from the node in the pyramid that needs it, so the candidate already knows which decision is blocked before hearing what the concept is.

1. **The case moment.** Name the node: which decision is stuck, and what exactly is in the way. One or two sentences. If you cannot name the decision, you are teaching a step, not a topic (§ Что считается кейсом).
2. **The working use, and the target answer.** What the candidate does and says at that moment, in the shape the interviewer will ask for — i.e. what a passing spoken answer sounds like. They must know what they are aiming at before the theory starts; theory without a target is the failure mode "we walked the topics but never walked the interview".
3. **Why it works** — explain from the pinned source, grounded on the running dataset. Three input numbers, everything else derived: the candidate understands via a derivation ladder, so give the ladder, not the result. This is where the definition and the formula finally appear.
4. **Ask a numeric question.** Not "clear?" — a question with an arithmetic answer.
5. **Give an explicit verdict.** Correct / partially correct with the exact missing piece / wrong with the correction. Never assume comprehension from silence or from a confident tone.
6. **Move the status.** `объяснён` after step 5 lands. `отработан вслух` **only after the candidate has answered the case-shaped question out loud, unaided** — the apex question or the node question, in the form it arrives in. An answer to the definition-shaped question ("what is p-value") is step 5, not closure: that is precisely the knowledge that turned out unusable.
7. **Write the cheat-sheet entry** in the schema above, in the same session.

Invented terminology is forbidden. If you use a term that is not in the pinned source, flag it as your own coinage in the same sentence — an unflagged invented term sends the candidate into the interview with vocabulary the interviewer has never heard.

## Mock rules for exam rounds

- A mock must cover the format declared in `scope_source`, not an adjacent section. Drifting into the wrong section of the syllabus is a documented failure (F: the day-before mock drifted into section 5).
- Ask only material that has been taught. A mock question on untaught material tests the coach, not the candidate.
- Follow-up pressure is mandatory: after a correct answer, ask "why", "and if n doubles", "what breaks this". Interviewers do.

## Freeze — T minus 4 hours

Four hours before `datetime`, writes to the round's files are blocked by `prep_freeze_guard.js`. New material that close to the call is not preparation.

If something genuinely important surfaces inside the freeze window, open a debt row and say so plainly. The remaining time goes to reading aloud what already exists.

## Readiness DoD — run before the word "готов"

- [ ] every curriculum row is `отработан вслух` — answered to a **case-shaped** question, not a definition-shaped one
- [ ] every curriculum row is reachable from some case apex (detector 10 clean)
- [ ] the big pyramid was answered whole, not only the small ones
- [ ] no open debts (every `Закрыт` filled)
- [ ] every topic has a cheat-sheet entry with a `Триггер:` line and the schema validates
- [ ] the mock covered the format declared in `scope_source`
- [ ] the freeze was respected

If something is not ok — fix it, don't ask.

**The words "готов" and "100%" are forbidden until this checklist passes**, and the final verdict on readiness belongs to the candidate, not the coach. The coach shows the table and the checklist; the candidate says whether they are ready. See the banned-phrase list in `conventions.md` § Тон.

## Audit and incident log

- `/interview-coach audit` runs `scripts/round_audit.js` over the active round files and prints what is not closed. Run it before any readiness claim, between topics, and before a mock.
- Non-trivial breakages during prep go into `rounds/<...>_INCIDENTS.md` **at the moment they happen** — blameless: what broke, why, what changed so it doesn't repeat. Reconstructing this history afterwards from session logs costs hours.

## Forbidden in this flow

- The sections `📖 A. Компания за 60 секунд`, `📖 D. Карта соответствия`, `🗣️ 5. Твоё позиционирование` — an exam is not a pitch (detector 8).
- Deflecting subject-matter depth with "you need a domain expert" — see `prep.md` § "Exam rounds override these boundaries".
- Progress expressed as a percentage that is not a fraction over the curriculum table.
- Teaching a topic whose source cell is empty.
- **Teaching a primitive before naming the decision it serves.** If you cannot say which node in which pyramid needs it, you are back to bottom-up and the knowledge will not be retrievable in the interview.
- **Re-teaching primitives at the big apex.** The big pyramid teaches composition and trade-offs; its descent stops at the closed small apexes.
- Assembling a case before the curriculum table is filled from the scope source.
