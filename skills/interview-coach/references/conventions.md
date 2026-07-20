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

## 1c. Bilingual konspekt — two-column table, Russian LEFT, English RIGHT

**Rule (candidate-confirmed 2026-06-16).** When producing an interview
**konspekt** (the prep document with the candidate's spoken lines — Q&A
scripts, positioning, opening frames, the "what you say" material), render
every spoken line as a **two-column Markdown table**. "Spoken line" is
broad — it also covers **the questions the candidate asks the interviewer**
and the **cheat-sheet / one-screen recap** section. If the candidate could
read it off the screen to say it (or to recall what to say), it is
two-column. Do not leave a section single-language because it "looks like a
summary" — the cheat sheet gets RU left / EN right too:

```
| 🇷🇺 Говоришь так | 🇬🇧 English |
|---|---|
| <full Russian rendering of the line> | <full English rendering of the line> |
```

- **Left column = full Russian.** This is what the candidate reads to
  *recall the thought* before/while speaking. It must be the complete
  line, not a one-sentence gloss or a summary.
- **Right column = full English.** This is the word-level fallback — the
  candidate glances right only when a specific word escapes him. It must
  also be the complete line, parallel to the Russian.
- **Never** invert this (English primary, Russian as a short gloss
  underneath). That is the exact failure the candidate flagged: he reads
  Russian to load meaning fast and speaks English; an English-primary
  layout with a one-line Russian gloss is useless to him.
- **One table per spoken item — never stack.** Each distinct spoken line
  (each Q&A answer, each question the candidate asks, each opening frame)
  gets its **own** two-column table with its own header row. The table is
  the visual paragraph separator — one table = one thing to say. **Never**
  cram several questions/answers as multiple rows inside a single shared
  table: that collapses the separation the candidate relies on to find and
  deliver one item at a time. When a section has several items (e.g. "the
  questions you ask"), give each item a short bold label line + its own
  table, not one table with N rows. (candidate-flagged 2026-07-05)
- **Split each answer into beats — one row per thought.** Inside an
  item's own table, do **not** dump the whole answer as a single
  wall-of-text row. Break it at the seams of the argument (setup →
  action → number → lesson) so each row is one beat the candidate says,
  typically 4–6 rows per answer. This does **not** contradict the bullet
  above: that one forbids putting *different items* in one table; this
  one governs granularity *within* one item. One table = one answer;
  one row = one thought inside it. Rows must be a clean cut of the same
  text — split at the seams, never reword or compress to fit.
  (candidate-flagged 2026-07-20)

**Numbers (within the konspekt table):** Russian column uses symbols/
digits per the storybank convention (`+10%`, `$500k/мес`, `60x`,
`7.5M SKU`). English column: if this is an **English-spoken round** (the
candidate delivers the English aloud), spell numbers out per rule 1's
spoken-aloud logic (`ten-percent`, `half a million dollars a month`);
otherwise digits are fine. Keep a dedicated "numbers, spoken aloud" block
(spelled-out) for warm-up regardless.

**Relationship to rule 1 (no conflict).** Rule 1 governs inline 🗣️ anchor
lines — short English memory hooks, Russian "о чём говорить" bullets. This
rule (1c) governs the *konspekt body*: the two-column table IS the
"load-meaning-in-Russian, speak-in-English" mechanism rule 1 is built
around — Russian on the left loads the thought, the full English on the
right is reference, not a teleprompter to read verbatim. Under each table,
still give the short `🗣️ Anchors:` line (rule 1) as the recall hooks.

**Why.** A real konspekt (Celeste / Virto, 2026-06-16) was rebuilt with
English as the primary block and Russian collapsed to a one-line gloss.
The candidate could not use it: "мне проще посмотреть на русский текст,
чтобы быстро вспомнить, что надо говорить, и говорить на английском. А в
английскую колонку смотреть, если вдруг я забуду слово." The canonical
reference is `2026-06-07_evgeniy-myskov-hiring-prep.md` — match its
`| 🇷🇺 Говоришь так | 🇬🇧 English |` layout for every spoken line.

⚠️ **The canonical reference predates the beat-splitting bullet
(2026-07-20) and renders each answer as one monolithic row.** Copy its
*column layout*, not its row granularity. Following it verbatim is how
the Mercor konspekt (2026-07-13) shipped as wall-of-text rows and had to
be re-cut after the candidate flagged it: "ты не разбил мысли в ответах
по ячейкам". A single cell holding a whole answer is unusable while
speaking — he loses his place mid-sentence and cannot see the answer's
skeleton.

**How to apply.** Before delivering any konspekt: confirm every spoken
line is a two-column table with full text both sides, Russian left. If you
catch yourself writing a long English block with a short Russian gloss
below it — stop and flip it into the table. This is part of DoD for any
konspekt-producing run.

**Mechanical DoD check (run it, don't eyeball it).** The soft "confirm
every line" failed repeatedly (candidate had to flag §7 questions-to-
interviewer, concerns, etc. one section at a time across a single brief).
The scope is *every* sub-block under a 🗣️ H2 — Q&A, questions the
candidate asks the interviewer, concerns/objections, opening frames, the
cheat sheet — not just the obvious answer scripts. Before delivering or
after any edit to a konspekt, run this over the file and fix anything it
prints:

```bash
python3 - "$BRIEF" << 'PY'
import sys
lines = open(sys.argv[1]).read().split("\n")
spoken=False; h2=None; sub=None; buf=[]; bad=[]
def flush():
    if spoken and sub:
        t="\n".join(buf)
        if (("English" in t) or ("Anchors" in t) or ("`" in t)) and \
           ("🇷🇺 Говоришь так" not in t) and ("🇷🇺 Спрашиваешь так" not in t):
            bad.append(f"{h2} -> {sub}")
for ln in lines:
    if ln.startswith("## "): flush(); h2=ln.strip("# ").strip(); spoken="🗣️" in ln; sub=None; buf=[]
    elif ln.startswith("### "): flush(); sub=ln.strip("# ").strip(); buf=[]
    else: buf.append(ln)
flush()
print("⚠️ MISSING two-column table:\n  " + "\n  ".join(bad) if bad else "✅ all 🗣️ spoken sub-blocks are two-column")
PY
```

A 🗣️ sub-block that contains an English line, an `Anchors:` line, or any
backtick phrase but **no** `| 🇷🇺 Говоришь так |` / `| 🇷🇺 Спрашиваешь так |`
table is a violation. Green output is a precondition for delivery.

**Beat-granularity check (same DoD run).** Catches the wall-of-text row
the bullet above forbids. A single-row table for a multi-sentence answer,
or any cell over ~320 chars, means the answer was not cut into beats:

```bash
python3 - "$BRIEF" << 'PY'
import sys, re
lines = open(sys.argv[1], encoding="utf-8").read().split("\n")
sec=None; rows={}; fat=[]
for i, ln in enumerate(lines, 1):
    if ln.startswith("## "): sec = ln.strip("# ").strip()
    if ln.startswith("|") and "Говоришь так" not in ln and "Спрашиваешь так" not in ln \
       and not re.match(r"^\|[\s:-]*\|[\s:-]*\|?$", ln):
        cells = ln.split("|")[1:-1]
        rows.setdefault(sec, 0)
        rows[sec] += 1
        for c in cells:
            if len(c.strip()) > 320: fat.append(f"line {i} ({sec}): {len(c.strip())} chars")
thin = [s for s, n in rows.items() if s and "🗣️" in s and n < 2]
print("⚠️ single-row answer (not cut into beats):\n  " + "\n  ".join(thin) if thin
      else "✅ every 🗣️ table has multiple beat rows")
print("⚠️ oversized cell (split it):\n  " + "\n  ".join(fat) if fat
      else "✅ no wall-of-text cells")
PY
```

---

## 1d. Lean konspekt — default sections, cut the scaffolding

**Rule (candidate-directed 2026-07-02, Jared).** A `prep` konspekt is a
working document the candidate opens *whole* on the call and reads top to
bottom. It is not a teaching doc. Ship the lean set of sections below by
default; do NOT pad it with scaffolding the candidate already owns.

**Default section set (this order):**

1. 📖 What is this call — one paragraph.
2. 📖 Who is the interviewer / what they filter for.
3. 📖 What we don't know about this round.
4. 📖 Fit-read — why their surface maps to the candidate's craft.
5. 🗣️ Likely questions — **Q1 is always "tell me about yourself"** and IS
   the positioning / self-intro. There is **no separate positioning block** —
   that duplicates Q1. Then the round's real questions.
6. 🗣️ Questions the candidate asks — see "real recon" below.
7. 📖 Traps — **non-obvious reminders only**.

**Cut by default (do NOT emit these unless the candidate asks):**

- **The legend/preamble** at the top (the "📖 = справка, 🗣️ = речь…" line and
  the two-column explanation blockquote). The candidate knows the format.
- **A standalone positioning / headline section** separate from Q1.
- **`🗣️ Anchors:` lines** under blocks. The full English lives in the
  right column of the two-column table; short anchor hooks are redundant
  duplication. (Rule 1's *concept* — load meaning in RU, speak EN — is
  carried entirely by the two-column table per rule 1c.)
- **A "bridge phrases / мостовые фразы" block** ("let me give you a concrete
  example", etc.). An experienced candidate already has these.
- **A "cheat sheet / шпаргалка на один экран" block.** The candidate opens
  the whole konspekt, not a one-screen digest.
- **A "numbers aloud / цифры вслух" warm-up block.** The candidate rehearses
  the whole konspekt aloud before the call; a separate number drill is noise.
- **The DoD-check footer** ("DoD-чек (rule 1c): …"). That is internal
  process, not candidate-facing content. Run the check (rule 1c) but do not
  print its summary into the delivered file.

**Traps section — non-obvious only.** Do NOT list basics the candidate
cannot get wrong ("don't claim you're the founder", "don't lie about
coding"). Keep only reminders that are easy to slip under live pressure
(e.g. "don't frame 'what I want' as 'any US role'", "one case per question,
don't sprawl").

**Candidate's own questions = real recon, not one signaling question.** The
questions-the-candidate-asks block must serve *the candidate's* genuine
unknowns — who/what they're hiring for, why they reached out, what this
leads to / what the process is after this call — not just one polished
"smart" question for the interviewer's benefit. Half the call is the
candidate's due diligence; the konspekt should arm that. Include a craft/
substance question too, but lead with the transparency the candidate
actually needs.

**Deep-dive links.** For any answer the interviewer might probe further,
add clickable links to the underlying storybank entries so the candidate
can open the full STAR mid-call. Use Obsidian heading wikilinks with a
short alias: `[[coaching_state#S002 — <exact heading>|S002]]`. Pull the
exact heading text from `coaching_state.md` (grep the `#### S###` lines) so
the anchor resolves.

**Scope / generality.** This lean default is the standard. A specific
candidate who is early-stage or explicitly wants scaffolding (bridge
phrases, a number drill, a one-screen cheat sheet) can have those blocks
re-added on request — but they are opt-in, not the default. Do not
reintroduce them silently.

---

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

## 5. Vocabulary calibration — spoken English from the candidate's Reword mastered set

**Rule.** Before emitting any English the candidate will **read aloud**
(prep brief 🗣️ blocks, konspekt spoken answers, `practice` / `mock`
lines, the EN column of a `Story Details` STAR table, `hype` anchors),
calibrate the word choice against the candidate's **Reword mastered
vocabulary**. Two tiers, never silent:

- **A — auto-replace.** A word is *not* in the mastered set **and** it is
  genuinely advanced / rare / idiomatic **and** a natural synonym that
  **is** in the mastered set preserves the meaning → replace it and log
  `old → new` with a one-word reason. (Pilot examples: `tolerate → accept`,
  `make a dent → have impact`.)
- **B — watch-list, text untouched.** Any *content* word left in the
  answer that is not in the mastered set and was not auto-replaced → list
  it under the answer. Do **not** change the answer. The candidate reads
  the list and decides: knows it → ignore; shaky → drills it.

Then hand the block-B words to the **`reword-vocab` skill** to build a
drill deck (see "How to apply" step 4). Learned words re-enter `mastered`
on the next export, so they stop surfacing — the loop closes.

**Why.** 2026-07-08 pilot (Sam Tang / Capital One konspekt): the
candidate reads his answers fluently, but a handful of advanced words
occasionally surface that he'd rather swap or drill. "Absent from
mastered" alone is **not** a flag — his baseline English is fluent and
many common words (`flagship`, `breakthrough`) aren't in the deck yet are
obviously known. Over-replacing dumbs his answers down, which is worse
than leaving a known word. So replacement is **rare and light-touch**
(the pilot swapped 2 words in a 35 KB konspekt); the watch-list is the
default catch-all, and nothing not-in-mastered passes silently.

**How to apply.**

1. **Refresh the snapshot first (every time — data must be current).**
   Read `profiles/<id>/interview-coach-state/vocab_config.json`. If it is
   absent, this profile has no Reword source → **skip calibration
   entirely, no note**. If present, run from the repo root:
   `python3 skills/interview-coach/references/vocab_snapshot.py --backup <reword_backup_path> --out <snapshot_path>`
   (both values from the config). The script re-reads the live 305 MB
   backup and rewrites the small `<snapshot_path>` mastered list, so an
   updated Reword export is picked up automatically. If the script exits
   non-zero (backup missing — e.g. Drive not synced, cloud session),
   **skip calibration and the deck**, and add one line to the output:
   *"Reword backup unavailable — answers not vocab-calibrated this run."*
2. **Load the mastered list** from `<snapshot_path>` (skip `#` meta
   lines; each remaining line is one lowercased word/phrase). Note the
   `# backup_exported:` date — if the output surfaces vocabulary
   provenance, cite that date so the candidate knows how fresh it is.
3. **Apply the two tiers (A / B above).** Match case-insensitively;
   lemmatize loosely (a mastered `share` covers `sharing`, `shares`).
   **Never touch, flag, or deck:** the candidate's own domain jargon
   (funnel, conversion, monetization, retention, guardrail, proxy metric,
   north-star, cohort, MCP, CPA, affiliate, aggregator, …), proper nouns,
   numbers, or the mastered words themselves. **When unsure whether to
   auto-replace → downgrade to the watch-list.** Never force-swap a word
   that might be known, and never silently drop a not-mastered word.
4. **Build the drill deck from block B.** When the watch-list is
   non-empty, pass those words to the `reword-vocab` skill. It dedups them
   against the *full* Reword backup (mastered **and** learning) and prior
   CSVs in the canonical output dir, enriches (IPA + RU + examples), and
   writes a dated deck `<YYYY-MM-DD>-<company-or-topic>-interview.csv`.
   Report one line: *"N words → deck `<path>`, import to Reword."* Do this
   **automatically** whenever block B is non-empty; skip only if the
   candidate says "no deck" / "без дека" for that run. One deck per
   konspekt, slug from the company/role.
5. **Output shape.** Under the spoken answers, two compact blocks — 🔄
   *Replaced* (A: what → what, why) and 👀 *Check* (B: in the answer, not
   in Reword mastered) — plus the one-line deck report. Omit a block if
   it's empty.

**Interaction with Rule 1.** Calibration operates on *word choice* after
Rule 1 has set the format. A mastered-set synonym must still obey Rule 1:
in 🗣️ anchor phrases spell words out (no symbols); numbers as symbols
where Rule 1 requires. Word swaps never override the ESL format.

---

## 6. Capture new ground-truth profile facts as STAR immediately

**Rule.** Whenever the candidate reveals a new ground-truth fact about their
experience — a project, a metric, a failure, a decision, a result — that is
**not yet in the storybank**, capture it as a STAR in
`profiles/<id>/interview-coach-state/coaching_state.md` **in the same turn**,
not as a "later" follow-up. This holds in any command (`prep`, `mock`,
`analyze`, casual conversation) and even mid-prep: if a brief or a drafted
answer surfaces a fact the storybank lacks, add the story before closing the
turn — a table row in `## Storybank` + a bilingual `### Story Details` entry
(RU + EN, woven STAR + Earned Secret per Rules 1 / 1b). Assign the next free
`S###` id. If the fact is partial (missing Action/Result detail), still create
the row and mark the gaps explicitly with ⚠️ "достроить" placeholders so the
next `mock` fills them — never silently drop it. Briefs are downstream views;
the storybank is the single source of truth, so the fact lands there first.

**Why.** Ground-truth facts are the scarcest asset in interview prep. A fact
mentioned once and not captured is lost, and re-deriving it wastes the
candidate's time. Established for the `ai-job-searcher` project on 2026-06-07
at the candidate's request; applies to every profile.

---

## How these rules surface

These rules are loaded at the top of every command's instruction set:

- `prep`: Rule 1 (🗣️ format — Russian summary + English anchor phrases)
  and Rule 2 (no fabrication) gate the output. Rule 1b (Russian narrative
  stays Russian) gates the prose. Rule 4 (factual hygiene) gates every
  candidate-history fact narrated in the brief. Rule 5 (vocabulary
  calibration) gates the spoken-English word choice in every 🗣️ block.
  Rule 3 governs how to handle a fabrication or conflation caught
  mid-session.
- `practice`, `mock`: Rule 1 gates every line the candidate will speak.
  Rule 5 calibrates those spoken lines against the Reword mastered set.
  Rule 4 gates how candidate history is described in the setup text.
- `analyze`, `debrief`, `feedback`: Rule 2 governs how to label cases
  pulled from the storybank. Rule 4 governs how to narrate candidate
  history when scoring. Rule 3 governs how to report when scoring or
  attribution turns out wrong.
- `stories`: Rule 2 governs the `Commercial Profile` field — ask, don't
  guess. Rule 4 governs multi-direction cases — surface both directions
  in `Story Details`, do not collapse. Rule 5 calibrates the English
  column of any `Story Details` STAR table the candidate will speak.
- `hype`: Rule 1 governs the anchor lines and the opening line. Rule 5
  calibrates their word choice.

- **all commands** (Rule 6): when the candidate reveals a new ground-truth fact not yet in the storybank, capture it as a STAR in the same turn. Rules 1c / 1d shape konspekt output — two-column bilingual (RU left / EN right) and lean default sections.

When in doubt, this file wins. The cost of breaking one of these rules
is higher than the cost of being slightly slower or less polished.
