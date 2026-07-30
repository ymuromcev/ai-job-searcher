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

This cannot be enforced by a hook: there is no reliable trigger for "a topic was just explained". It is enforced socially instead — the table is in a file the candidate reads, and `scripts/round_audit.py` reports any row still `не начат` the moment readiness is claimed.

## Scope source precedence

The list of topics comes from exactly one place, in this order:

1. **A document from the employer** (prep guide, agenda, syllabus, take-home brief). If one exists, read it **before** teaching anything, and copy its topic lines **verbatim** into the curriculum table. Paraphrase is forbidden: a paraphrase is already the coach's synthesis and it hides divergence from the real scope.
2. **The recruiter's or interviewer's written description** of the round, quoted.
3. **The candidate's recollection**, explicitly marked as such in the round file (`scope_source: recollection`) — the weakest case, and the one where an extra clarifying question to the recruiter is worth asking.

Two hard rules:

- **The document outranks the candidate's own prediction.** If the candidate says "they won't ask the formulas" and the document says "questions and problems", the document wins. Agreeing with the candidate here is how mechanics went un-drilled and got asked.
- **The document outranks the coach's route.** Progress is a fraction over the table, never an impression. Saying "85%" while a scope row is empty is a defect.

## The four steps

1. **Source.** Name a concrete canonical material and pin it in `sources:`. Not "I know statistics" — "Wasserman, All of Statistics, ch. 10". For topics with no canonical material (behavioral framing, company-specific practice), write literally `мой синтез` in the source cell so the candidate sees where reliability drops and where to double-check the coach.
2. **Scope.** Topic rows verbatim from the scope source, each mapped to a section of the pinned material. An empty source cell is a defect (audit detector 1).
3. **Grounding.** One running dataset from the candidate's own experience for the whole round. Every formula is computed on it. Abstractions with no numbers attached are forbidden (`conventions.md` rule 11).
4. **Drilling.** Explain → ask a numeric question → give an explicit verdict out loud → move the status.

## The round file

Path: `profiles/<id>/interview-coach-state/rounds/<YYYY-MM-DD>_<company>_<kind>.md`. Create it **before the first teaching message**, and show the candidate the filled curriculum table before starting to teach.

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

- Определение: …
- Для меня: …
- Формула: … Вытекает из: …
- 🗣️ Если спросят: «одна проговариваемая реплика целиком»
```

- `Формула:` without `Вытекает из:` is a defect — a formula the candidate cannot re-derive collapses under a follow-up. Blocked at write time by `prep_freeze_guard.py`.
- `🗣️ Если спросят:` is one complete sentence the candidate can read aloud cold, in the interview language. For English rounds it obeys `conventions.md` rule 1 (full words, no symbols) and rule 5 (vocabulary from the Reword mastered set). One line per likely trap — not a script for the whole answer.
- A topic marked `отработан вслух` with no `🗣️` line is a defect (detector 6).

## Teaching protocol — per topic, in this order

1. **Target answer first.** Before explaining anything, say what a passing spoken answer to the interviewer's likely question sounds like. The candidate must know what they are aiming at; theory without a target is the failure mode "we walked the topics but never walked the interview".
2. **Explain from the pinned source**, grounded on the running dataset. Three input numbers, everything else derived — the candidate understands via a derivation ladder, so give the ladder, not the result.
3. **Ask a numeric question.** Not "clear?" — a question with an arithmetic answer.
4. **Give an explicit verdict.** Correct / partially correct with the exact missing piece / wrong with the correction. Never assume comprehension from silence or from a confident tone.
5. **Move the status.** `объяснён` after step 4 lands; `отработан вслух` only after the candidate has said the whole answer out loud once, unaided.
6. **Write the cheat-sheet entry** in the schema above, in the same session.

Invented terminology is forbidden. If you use a term that is not in the pinned source, flag it as your own coinage in the same sentence — an unflagged invented term sends the candidate into the interview with vocabulary the interviewer has never heard.

## Mock rules for exam rounds

- A mock must cover the format declared in `scope_source`, not an adjacent section. Drifting into the wrong section of the syllabus is a documented failure (F: the day-before mock drifted into section 5).
- Ask only material that has been taught. A mock question on untaught material tests the coach, not the candidate.
- Follow-up pressure is mandatory: after a correct answer, ask "why", "and if n doubles", "what breaks this". Interviewers do.

## Freeze — T minus 4 hours

Four hours before `datetime`, writes to the round's files are blocked by `prep_freeze_guard.py`. New material that close to the call is not preparation.

If something genuinely important surfaces inside the freeze window, open a debt row and say so plainly. The remaining time goes to reading aloud what already exists.

## Readiness DoD — run before the word "готов"

- [ ] every curriculum row is `отработан вслух`
- [ ] no open debts (every `Закрыт` filled)
- [ ] every topic has a cheat-sheet entry and the schema validates
- [ ] the mock covered the format declared in `scope_source`
- [ ] the freeze was respected

If something is not ok — fix it, don't ask.

**The words "готов" and "100%" are forbidden until this checklist passes**, and the final verdict on readiness belongs to the candidate, not the coach. The coach shows the table and the checklist; the candidate says whether they are ready. See the banned-phrase list in `conventions.md` § Тон.

## Audit and incident log

- `/interview-coach audit` runs `scripts/round_audit.py` over the active round files and prints what is not closed. Run it before any readiness claim, between topics, and before a mock.
- Non-trivial breakages during prep go into `rounds/<...>_INCIDENTS.md` **at the moment they happen** — blameless: what broke, why, what changed so it doesn't repeat. Reconstructing this history afterwards from session logs costs hours.

## Forbidden in this flow

- The sections `📖 A. Компания за 60 секунд`, `📖 D. Карта соответствия`, `🗣️ 5. Твоё позиционирование` — an exam is not a pitch (detector 8).
- Deflecting subject-matter depth with "you need a domain expert" — see `prep.md` § "Exam rounds override these boundaries".
- Progress expressed as a percentage that is not a fraction over the curriculum table.
- Teaching a topic whose source cell is empty.
