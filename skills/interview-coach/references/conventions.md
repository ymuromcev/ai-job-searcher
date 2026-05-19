# Conventions — Claude behavior rules for interview-coach

Cross-cutting rules that constrain *Claude's own behavior* when running any
command in this skill (especially `prep`, `practice`, `mock`, `analyze`,
`debrief`, `feedback`). These are not coaching technique — coaching technique
lives in `cross-cutting.md`, `rubrics-detailed.md`, `differentiation.md`,
`challenge-protocol.md`. This file is about how the assistant *acts*: what
it writes, what it refuses to fabricate, and how it surfaces its own mistakes.

If any of these rules conflict with the rest of the skill, **these win**.
They exist because each one was earned the hard way — a real prep brief
broke under real interview pressure and the candidate had to recover.

---

## 1. English in 🗣️ sections — short anchor phrases, not long scripts

**Top-level rule (revised 2026-05-19).** A 🗣️ section in a `prep` brief is
**not** a script the candidate reads aloud in English. It is a **Russian
(or candidate's narrative-language) summary of *what to say*, plus short
English anchor phrases (1-5 words each) that are short enough to recall
under pressure.**

The original premise — "write English the way you'll read it under
pressure" — was already a refinement. The 2026-05-19 refinement is one
level deeper: under real ESL pressure, the candidate **does not read long
English at all**. He reads the Russian summary to load *what to say*, then
delivers it in his own English, using the anchor phrases as memory hooks.

This rule unblocks ESL candidates from the failure mode of trying to read
several full English sentences off the screen during a live call and
freezing on cadence/word retrieval.

**🗣️ block structure (canonical):**

```
**О чём говорить:**
- Russian bullet 1 (meaning, not exact phrase)
- Russian bullet 2
- Russian bullet 3
- [last bullet — "Скажи цифру X и сделай паузу."]

**Anchor phrases:**
- `English phrase 1` (1-5 words)
- `English phrase 2`
- `English phrase 3`
- [3-6 short anchors total]
```

The Russian bullets are read **before** the call — they load the
*meaning*. The anchor phrases are the only English on screen, and they are
short enough that the candidate either recalls them verbatim or paraphrases
in his own English without losing the point.

**Long polished English formulations (Earned secret, opening line,
positioning headline) are allowed**, but only when:

1. The formulation is genuinely polished (catchy, memorable, earned).
2. It is paired with a Russian one-liner describing the meaning.
3. It is marked: *"если не вспомнил буквы — скажи своими словами, идея
   важнее"* — i.e., recall the idea, not the exact English string.

This carve-out covers things like a 10-second hook ("I scaled an Alpha
Bank API channel to $500,000 per month in recurring revenue") which is
short enough and polished enough that the candidate may want to deliver
it verbatim. But even then — Russian meaning above, English below, plus
the fallback instruction.

**Anchor phrases formatting rules (carried over from previous version of
this rule — these are still correct):**

Every English anchor phrase that the candidate will *speak aloud* during
an interview must be written in a form that maps cleanly onto pronunciation.
The guiding principle is *"write it the way you'll read it under pressure"*
— not "spell out everything," not "stay terse." Specifically:

- **Plain digits stay as digits.** `30%`, `15 minutes`, `2026`, `13 years`
  are readable as-is. Do NOT convert these to `thirty percent`,
  `fifteen minutes`, etc. — that level of spell-out is harder to read, not
  easier.
- **Compressed money notations get expanded.** `$500K/mo`, `$30k/mo`,
  `$140-190K` — the combination of currency symbol + abbreviation + slash
  breaks ESL reading under pressure. Use one of two approved forms:
  - `$500,000 per month` (currency symbol + full number + per month)
  - `500K USD per month` (no leading `$`, explicit USD, `per month`)
  Pick whichever fits the surrounding sentence better. Both are
  approved by the candidate as of 2026-05-17.
- **Symbols inside quotes are replaced by words or punctuation:**
  arrows (`→`), plus-as-conjunction (`+`), slash-as-"or" (`/`),
  multiplier (`10x` → `10 times`), range arrows (`0→1` → `0 to 1`).
- **Technical acronyms stay as acronyms.** `MCP`, `JD`, `RFC`, `LLM`,
  `API`, `ATS`, `KPI`, `OKR`, `SDK`, `SaaS`, `B2B`, `B2C` — these are
  pronounced letter-by-letter or as a known word, and the candidate
  already knows them. Do NOT expand them to "Model Context Protocol,"
  "the written job description," "design doc," "large language models,"
  etc. — that expansion was the previous (wrong) version of this rule.
- **Product and technology names** stay as written. `Claude Sonnet 4.5`,
  `Synoptix`, `GPT-4` — but if the number is part of the product name and
  needs to be pronounced, the candidate can read it naturally
  (`"Claude Sonnet 4.5"` → *"Claude Sonnet four point five"* on the
  candidate's side; just don't force this in the written form).

**Scope.** This rule applies ONLY to **quoted English content the candidate
will speak aloud**:

- Anchor lines, opening lines, comp-band lines, closing lines in `prep` briefs
- All entries in `anchor_phrases_en.md`
- `practice` and `mock` scripts
- 30-second pitches, headlines, positioning formulas, hype lines

It does NOT apply to:

- The Russian (or other narrative-language) commentary, instructions,
  headers, tables, or schema text. Those keep normal numbers, normal
  punctuation, normal acronyms.
- English documentation in skill files (SKILL.md, references/, command
  docs). These are for the coach to read, not the candidate to speak.

**Why.** The default candidate for this skill is ESL (English as a second
language). The original failure mode (2026-05-14, Ross Burton prep,
Synoptix Round 2): symbols like `$500K/mo`, `0→1`, `10x` were too dense
for fast reading under pressure. The first attempted fix overshot — every
number got spelled out, every acronym got expanded, which made the brief
*harder* to read because the candidate could read digits and acronyms
fine; what they couldn't read was compressed monetary notation and
symbolic shorthand. This rule reflects the second iteration:
candidate-confirmed (2026-05-17) that digits and acronyms are fine, only
compressed money and symbolic shorthand break.

**Examples.**

| Do not write | Write |
|---|---|
| `$500K/mo` | `$500,000 per month` or `500K USD per month` |
| `$30k/mo` | `$30,000 per month` or `30K USD per month` |
| `$140-190K` | `$140,000 to $190,000` or `140K to 190K USD` |
| `0→1`, `0->1` | `0 to 1` |
| `10x` | `10 times` |
| `→` (arrow inside a quote) | `that means`, `which gives`, or just punctuation |
| `+` (as conjunction) | `and` |
| `/` (as "or" inside a quote) | `or` |
| `40 A/B tests` | `40 A B tests` or `40 experiments` |

| Keep as-is (do NOT change) | Reason |
|---|---|
| `30%` | digit + `%` reads fine |
| `15 minutes`, `13 years` | digits read fine |
| `2026`, `Q4` | dates and quarter codes read fine |
| `MCP`, `JD`, `RFC`, `LLM`, `API`, `ATS`, `KPI`, `OKR`, `SDK` | known acronyms |
| `Claude Sonnet 4.5`, `GPT-4`, `Synoptix` | product names |

**How to apply.**

1. Before showing the user any `prep` brief, `practice` script, or anchor
   file, scan every quoted English line. Hunt specifically for:
   `$` followed by digits + `K`/`M`/`B`/`k`/`m`/`b` followed by `/` or
   `per`; arrows; `+` between two nouns; `/` used as "or";
   number+`x` patterns.
2. This check is **part of DoD for `prep`, `practice`, `mock`, `hype`**.
   Run it before delivery, not after the candidate complains.
3. Positioning formulas (30-second pitch, headline) get the strictest
   pass — these are memorized verbatim, symbols will trip the recall.
4. **Do not over-correct.** Plain digits and standard acronyms are
   readable. Spelling them out makes the brief harder to scan, not easier.

---

## 1b. Russian narrative is Russian — don't sprinkle English jargon

**Rule.** When the narrative-language commentary, headers, instructions, or
analysis text is in Russian (or any other non-English language), keep it
in that language. Do NOT splice in English jargon words that have perfectly
good native equivalents.

**Why.** The candidate (2026-05-17) flagged the sentence:
> *"Если он задаст softball AI-domain вопрос — это сигнал, что он подтверждает smell test, не interrogate'ит. Отвечай чисто, не пересказывай весь stack."*

Six English jargon words in one Russian sentence make it unparseable
under reading pressure. This is the same root cause as rule 1 (don't make
the candidate decode under load) — just applied to narrative instead of
spoken quotes.

**What stays in English inside Russian narrative (allowed):**

- **Quoted lines** the candidate will speak aloud — these are English by
  definition and follow rule 1.
- **Proper names** — Investigo, Synoptix, Alpha Bank, Anthropic,
  Claude Sonnet, Calendly, GitHub.
- **Skill command names** — `prep`, `practice`, `mock`, `hype`, `debrief`,
  `stories`, `analyze`, `feedback`.
- **Well-established acronyms in Russian PM/tech speech** — MCP, API, JD,
  RFC, LLM, KPI, OKR, ATS, STAR, B2B, B2C, ARR, MRR, CR, MAU. These are
  read as acronyms in Russian conversation too.
- **Numbered round labels** — Round 1, Round 2, Round 3 (or "раунд 1" if
  consistently translated).

**What does NOT belong in Russian narrative (replace with Russian):**

| English jargon (bad) | Russian replacement (good) |
|---|---|
| `softball` (vopros) | мягкий вопрос / простой вопрос |
| `smell test` | проверка «звучишь ли как реальный кандидат» |
| `interrogate'ит` | будет копать вглубь |
| `stack` | стек технологий / технический набор |
| `lane` | направление / специализация |
| `native vocabulary` | его родной язык |
| `pitch decks` | презентации |
| `probe` (noun/verb) | проверка / прощупает |
| `placement'ы` | размещения кандидатов / устроенные кандидаты |
| `forwardable` | пересылаемый |
| `relationship-driven` | строит на отношениях |
| `push'нёт` | надавит |
| `freeze'нешь` | зависнешь |
| `pivot` (in narrative) | разворот / смена темы |
| `meta-обсуждай` | обсуждать на мета-уровне / рефлексировать вслух |
| `narrative` (as a thing) | повествование / рассказ / линия |
| `counter-narrative` | контраргумент / контр-линия |
| `recovery line` | фраза-восстановление |
| `backup` (story) | запасная (история) |
| `timebox` | временное ограничение |
| `production, in daily use` | в продакшене / в ежедневной работе |
| `cold start` | холодный старт (допустимо как термин) |
| `framing` | формулировка / подача |

**How to apply.**

1. Before delivering any file with Russian narrative — re-read each
   paragraph. If you see more than 1-2 English words per sentence that
   are NOT in the allowed list, rewrite the sentence in Russian.
2. Cyrillic + English-morphology hybrids (`push'нёт`, `freeze'нешь`,
   `interrogate'ит`, `placement'ы`) are the worst offenders — they're
   the ones most likely to trip ESL reading. Hunt these specifically.
3. This applies to `prep` briefs, `practice` / `mock` setup text,
   `hype` routines, `debrief` notes, and any other narrative the
   candidate reads.

## 2. No fabricated commercial profile

**Rule.** Do not assign a commercial-profile label (B2B / B2C / enterprise /
SaaS / marketplace / payments / advisory / etc.) to a storybank case based
on its **tag** or **title** in `coaching_state.md → Storybank`. Use the
label only if it is (a) explicit in `Story Details → S###` for that case, or
(b) confirmed by the candidate in the current session.

If the commercial profile is unknown — **say "commercial profile TBD"** in
the prep brief and ask the user before generating downstream framing.

**Why.** Tags and titles are dense: "S005 Alfa MFI", "S008 SMMACC",
"S003 Credit Mentor". The temptation to extrapolate a frame from those four
words is high — and the frame is almost always wrong. (Source: 2026-05-14
Ross Burton prep — I built an "enterprise B2B bridge" frame off three
case titles. All three commercial profiles were fabricated. Ground truth:
SMMACC = marketplace for online businesses; Credit Mentor = B2C AI mentor
for credit health; Alfa = one partnership deal owned end-to-end, not "ten
plus B2B integrations".) An interviewer catches this in thirty seconds.
On a founder or hiring-manager round, that fabrication is an immediate
no-hire.

**How to apply.**

1. Before using a B2B/B2C/enterprise/marketplace label for a case, check
   `Story Details → S###` for an explicit commercial-profile field. If
   absent, do not assume.
2. If you need the profile to build the brief — **ask the candidate**, one
   or two lines per case, before generating: *"Quick check on S008 SMMACC —
   is this B2B, B2C, marketplace? Who pays, who uses, what was your
   scope?"* Ask before writing the brief, not after.
3. If the candidate has framed the case as a "B2B bridge" under an
   enterprise-track concern — apply this rule **especially carefully**.
   That is the situation where the temptation to invent a convenient frame
   is highest.
4. Prefer *"commercial profile TBD — needs candidate confirmation"* in the
   brief to a fabricated label.
5. If you have already shipped a fabrication — admit it directly per
   rule 3 below. List each specific fabrication, ask for ground truth,
   rewrite from scratch. Do not patch.

**Schema support.** Storybank should include a `Commercial Profile` column
so this fact is captured once, in the case detail, and not re-guessed each
time. When migrating coaching_state.md, add the column with empty values
and prompt the candidate to fill it during the next `stories improve` or
`prep` session.

---

## 3. Admit mistakes directly

**Rule.** When the assistant has made a real mistake — wrong file path,
wrong branch, broken assumption, fabricated content (see rule 2), skipped
DoD step, missed a requirement from a BL task, claimed a test was green
when it was red — report it **directly and immediately**. One sentence
naming what happened, followed by a concrete fix plan, followed by an
explicit ask for OK before any destructive recovery (discard, reset,
delete, force-push, full rewrite of a user-visible artifact).

**Why.** The user (2026-05-08): *"Ты молодец, что признаешь свои ошибки —
это очень правильно. Я не буду за тебя ругаться на такое, такое бывает."*
The cost of a quiet "self-fix" is much higher than the cost of admitting:
if the assistant tries to silently migrate from wrong path to right path,
the candidate may later run into the unclean state and lose trust. A clear
admission plus a small fix plan is cheaper.

**How to apply.**

- **First thing in the reply.** One sentence naming the error. No
  defensive softeners ("it seems", "perhaps", "looks like"). No blaming
  the tool. Direct: *"I made a mistake — X."* / *"I fabricated Y."* /
  *"I shipped the brief with symbols in the quotes — that breaks ESL
  reading."*
- **Concrete plan next.** Exact files / lines / artifact to fix. If the
  fix is destructive (rewrite a user-visible file from scratch, reset a
  branch, delete a worktree), ask for OK before executing.
- **No ritual.** Skip the long apology arc. State, plan, ask. Move on.
- **Applies to.** Wrong path / branch / worktree confusion; fabricated
  facts (commercial profile, company history, candidate background);
  skipped DoD step; forgotten requirement from a BL task; CLAUDE.md rule
  violation (e.g., made a product decision without asking); broken
  assumption in coaching state (wrong story used, wrong dimension
  scored); tests claimed green that were red.
- **Does not apply to.** Edge cases the candidate didn't account for
  (not the assistant's mistake) or situations where the assistant
  followed an explicit instruction and that instruction led to a
  problem (report neutrally, don't apologize).

---

## 4. Factual hygiene — don't conflate two distinct facts into one

**Rule.** When narrating the candidate's history (in a `prep` brief, a
`practice` setup, a `mock` reset, a debrief, or anywhere else) — before
combining two pieces of context into a single sentence, **check whether
they are actually one fact or two separate facts**. If two — narrate them
separately, even at the cost of an extra sentence. Compressing two facts
into one "summary" almost always distorts at least one of them.

**Why.** The 2026-05-17–19 Ross Burton prep iterations: the candidate's
Alpha Bank tenure has **two distinct directions**, which I repeatedly
collapsed into one "partnership":

| Direction (correct) | What I mistakenly wrote |
|---|---|
| **API channel** — inbound credit card applications from partner companies. Candidate owned this end-to-end. $500,000 per month in recurring revenue from one integration. | "Партнёрство с банком на $500K/mo" |
| **MFO line** — candidate launched a new line of business: selling declined credit card applications to microfinance organizations. | (Erased entirely, folded into "the partnership") |

Combining them into "one Alpha Bank partnership" cost the candidate
**two pieces of evidence**: one direction is *integration ownership*
(API), the other is *launching a new line of business* (MFO). Different
competency signals, different stories, different concerns countered. An
interviewer probing scope would catch the conflation in one follow-up
question.

The mistake is mechanical, not semantic: the assistant pattern-matches
"both happened at Alpha Bank → one thing." But the candidate's mental
model has two distinct ledgers, and the storybank should reflect that.

**How to apply.**

1. **When narrating any candidate history fact**, ask: is this one fact
   or two? Markers that suggest two:
   - Two different products / channels / business lines at the same
     company.
   - Two different scopes ("owned end-to-end" vs. "launched" — these
     are not the same skill signal).
   - Two different time periods at the same company (early role vs.
     promotion).
   - Two different stakeholder groups (B2B partners vs. internal team).
2. **If two — separate them**, even at the cost of an extra sentence.
   `"At Alpha Bank, candidate owned the API channel (inbound credit card
   apps from partners, $500,000 per month recurring revenue) and
   separately launched the MFO line (selling declined cards to
   microfinance orgs — new line of business for the bank)."`
3. **In a 🗣️ block**, if both directions are relevant, use the
   non-repetition extension pattern: first layer = the most concrete
   direction (one set of anchors). Extension layer = the second direction
   (separate anchors). Do not merge them in one bullet list.
4. **In `Story Details`**, both directions can live under one S### entry,
   but the STAR breakdown should make the two ledgers visible — separate
   Situation / Task / Action / Result for each, or one combined narrative
   with explicit `Direction 1:` / `Direction 2:` labels.
5. **If the candidate corrects a conflation** — apply rule 3 (admit
   directly), then re-narrate both facts separately and confirm the new
   formulation with the candidate before persisting.

**Schema support.** When a `Story Details → S###` entry covers a
multi-direction case, prefer adding sub-sections to one S### entry
(`Direction 1`, `Direction 2`) over splitting into two S### IDs — the
storybank stays compact, but the directions stay visible.

**Related rules.** This is adjacent to rule 2 (no fabricated commercial
profile) but distinct: rule 2 is about *labels*, rule 4 is about
*compression of distinct facts*. A case can have a verified commercial
profile (rule 2 satisfied) and still get its two internal directions
mashed into one sentence (rule 4 violated).

---

## How these rules surface

These rules are loaded at the top of every command's instruction set:

- `prep`: Rule 1 (🗣️ format — Russian summary + English anchor phrases)
  and Rule 2 (no fabrication) gate the output. Rule 1b (Russian narrative
  stays Russian) gates the prose. Rule 4 (factual hygiene) gates every
  candidate-history fact narrated in the brief. Rule 3 governs how to
  handle a fabrication or conflation caught mid-session.
- `practice`, `mock`: Rule 1 gates every line the candidate will speak.
  Rule 4 gates how candidate history is described in the setup text.
- `analyze`, `debrief`, `feedback`: Rule 2 governs how to label cases
  pulled from the storybank. Rule 4 governs how to narrate candidate
  history when scoring. Rule 3 governs how to report when scoring or
  attribution turns out wrong.
- `stories`: Rule 2 governs the `Commercial Profile` field — ask, don't
  guess. Rule 4 governs multi-direction cases — surface both directions
  in `Story Details`, do not collapse.
- `hype`: Rule 1 governs the anchor lines and the opening line.

When in doubt, this file wins. The cost of breaking one of these rules
is higher than the cost of being slightly slower or less polished.
