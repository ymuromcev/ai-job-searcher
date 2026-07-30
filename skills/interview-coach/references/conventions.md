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

**Spoken cells carry substance only — no self-narrating labels or
persuasive tails (candidate-directed 2026-07-28, Jared).** Inside a
two-column answer, do NOT open a beat with a label that narrates the
answer's function ("Чем горжусь…", "Что это рост, а не слова…", "Как
решал…" as a standalone tag) and do NOT close it with a persuasive tail
that restates the point for effect ("Я сам был этим покупателем", "AI не
заменяет плейбук…", "но давай сперва поймём роль"). Do not repeat a beat
already stated elsewhere in the same answer. The candidate reads these
aloud; on the page they look like padding and when spoken they sound
staged. Keep the substance, cut the scaffolding around it. (He stripped
exactly these from the Splash konspekt by hand — don't reintroduce them.)

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

**Default candidate-question set — priority-ordered, two easy-to-forget
defaults included (candidate-directed 2026-07-28, Jared).** Offer a
standard set to ask, ordered by intel value, and let the candidate pick
3–4: (1) **who they're hiring for / ideal candidate** — calibrates fit,
lets the candidate close gaps live; (2) **report line + key stakeholders**
— the org map (easy to forget, add by default); (3) **benefits not in the
JD** — 401k match, bonus target, equity type; (4) **role emphasis** —
which sub-domain carries the weight; (5) **resource: dedicated squad vs
shared pool** — the real signal of ownership and impact (easy to forget,
add by default); (6) **one domain / substance question** — depth signal;
(7) **process + timeline** — the mandatory closer, **always last** so the
candidate leaves with it in hand. Reorder per what the specific candidate
most needs to learn, but the report-line and resource questions are
defaults precisely because role-tuned drafts keep dropping them.

**Segment the candidate-question set by the interviewer's role — never
hand a recruiter domain-depth questions (candidate-directed 2026-07-28,
Jared).** The set above is the *superset*. Which questions ship for a
given round depends on who is in the room, because asking the wrong
person wastes the candidate's limited airtime on "I'm not sure, the
hiring manager would know." For a **recruiter screen**, split the block
into two labelled groups: **"ask this interviewer"** — the recruiter can
actually answer these: ideal-candidate / who they're hiring for, comp &
benefits, basic org / report-line + team size, process & timeline; and
**"save for the hiring manager"** — domain-depth the recruiter reliably
fumbles: role emphasis (which sub-domain carries the weight), squad
structure (dedicated vs shared), and any strategy / constraint / "how do
you balance X" question. Keep the HM group in the konspekt (so it's ready
for the next round) but clearly marked *do not ask now*. For an HM or
panel round, the domain questions move up into "ask this interviewer."
Rule of thumb: a recruiter knows the candidate, the org basics, the money,
and the process; the hiring manager knows the domain, the team, and the
strategy. Match each question to the person who owns the answer.

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

## 1e. Never hard-wrap prose — one paragraph = one physical line

**Rule (candidate-directed 2026-07-23, Jared — stated before, re-flagged with
frustration).** Every file this skill writes is opened and edited in
**Obsidian**. Hard-wrapped prose (inserting a newline every ~72–80 chars
inside a paragraph) renders and edits as garbage there. **Do NOT hard-wrap.**

- A paragraph is **one physical line**. Let the editor soft-wrap. Never break
  a sentence across lines with a manual `\n`.
- Same inside **blockquotes**: a `> …` callout is one `>` line per paragraph,
  not one `>` line per 72 chars.
- Same inside **list items**: a bullet and its continuation are one line.
- Real newlines are only for real structure: between paragraphs (blank line),
  headers, list items, table rows, code fences, horizontal rules.
- This is not a konspekt-only rule. It applies to **every** file the skill
  emits — prep dossiers, company-research notes, debriefs, storybank prose,
  every section including the 📖 справка blocks, not just the 🗣️ tables.

**Why it keeps regressing.** When drafting long-form markdown the model
tends to visually wrap at terminal width. That instinct is wrong for a
file the human reads in an editor. Write the paragraph as one unbroken line
regardless of how long it looks in the tool output.

---

## 1f. Konspekt answers are sourced from story details, not paraphrased

**Rule (candidate-directed 2026-07-23, Jared — after a full konspekt draft
came back "вода без реальных достижений" and cost him a long correction
pass).** Mapping a story to a question is **not** the same as writing the
answer. The story-mapping engine tells you *which* `S###` to use; this rule
governs how the answer **text** gets built from it.

- For **every** konspekt answer (and every 🗣️ anchor / hype line), after the
  Q→`S###` mapping, **open the mapped story's `Story Details` block in
  `coaching_state.md` and lift its concrete quantified `Result` (and, where
  it sharpens the point, its `Earned Secret`) into the answer verbatim by the
  numbers.** Do not answer from memory or paraphrase the story into a generic
  claim ("grew the marketplace", "led the team"). Pull the real figures that
  are sitting in the block ($25k→$1M over 3 years, onboarding 3mo→1, +$500k/mo,
  weeks→hours, ~$1M/mo LTV, +20% CR from 40+ A/B, etc.).
- **A konspekt answer that names a story but carries no concrete fact from
  that story's `Result` line is a defect, not a finished answer.** It reads as
  padding to the candidate and burns his prep time.
- If a mapped story's `Result` has **no number to pull**, that is a signal the
  mapping is wrong (pick a story that does) or the story is under-built (run
  `stories` to enrich it) — it is **not** a license to write generic prose.
- **Hard gate before showing the konspekt to the candidate:** self-check that
  **every** predicted-question answer cites at least one specific fact lifted
  from a real `Story Details` block. If any answer fails, rewrite it from the
  source **before** emitting — do not hand the candidate a draft to fix.

**Why it regressed the first time.** The skill matched the right stories
(that part worked) but nothing forced the answer body to be sourced from the
matched story's actual metrics, so the draft came out as correct-story /
generic-content. The bridge from "mapped `S###`" to "concrete answer text"
was missing. This rule is that bridge.

**Case answers follow STAR, reshaped from the source — not rebuilt
(candidate-directed 2026-07-28, Jared).** When the question asks for a case
(proudest accomplishment, "tell me about a time", conflict, failure), the
answer follows STAR (Situation–Task–Action–Result). The storybank stories
already *are* STAR, so either **take the mapped story's STAR as-is** if it
fits the question cleanly, or **reshape its emphasis / syntax so the
S-T-A-R maps onto what this specific question tests** — a conflict story
re-cut to foreground the structural lesson over the drama, a launch story
re-cut to foreground the decision under constraint. Reshape the *framing*,
never the *facts*: do not rebuild the story from scratch and do not invent
beats to make it fit (Rule 13).

---

## 1g. Question headings in the candidate's scanning language, not the interview language

**Rule (candidate-directed 2026-07-28, Jared — after a live recruiter
screen).** In the 🗣️ likely-questions section, the **heading** of each
question (the `### Q3. …` line the candidate scans to find the block) is
written in the **candidate's own reading language**, not the language the
interview is conducted in. For Jared that means the Q-headings are in
**Russian**, even though the answers are delivered in English.

- The heading is an **index / locator**, not a script. Under live pressure
  the candidate is scanning the konspekt to jump to the right block fast;
  he finds it fastest in the language he reads fastest. The English trigger
  is already understood **by ear** when the interviewer says it — he does
  not need it repeated on the page.
- Do **not** duplicate the English question in the heading. The candidate's
  words: "я легко понимаю вопрос, а искать мне ответ проще на русском."
  An English heading actively slows his scan and earns nothing.
- This governs the **heading only**. The spoken answer stays two-column
  (RU left / EN right per 1c); the strategy caption stays in the narrative
  language. Only the section/question **titles** switch to the scanning
  language.
- Generalize by candidate: use the language recorded as the candidate's
  preferred reading/narrative language for all structural headings the
  candidate navigates by. If a candidate interviews and reads in the same
  language, this is a no-op.

**Why.** In a real Splash recruiter screen the English Q-headings made the
candidate hunt for his own answers mid-call. He understands the spoken
English fine; the bottleneck was *locating* the prepared answer, and a
Russian heading is the faster key.

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

## 7. Recruiter-screen baseline question set — always predicted, never role-only

**Rule (candidate-directed 2026-07-24, Jared — after the LawnStarter / Kate Acuzar screen asked four standard recruiter questions the konspekt had not predicted, and he tangled on them live under English load).** A `prep` konspekt for any recruiter / HR / talent screen **must** include prepared answers for the standard screen-mechanics questions **in addition to** the role-specific ones. Role-specific questions (pricing, AI, the domain) layer *on top of* this baseline, never *instead of* it.

Baseline set every recruiter-screen konspekt predicts — each as its own predicted-question section (Rule 1d), each answer sourced from a real story (Rule 1f):

- **Tell me about yourself** / walk me through your background.
- **Where are you in your career + what are you looking for next** (motivation).
- **Why this company / why this role.**
- **Your strengths / "superpowers" you'd bring** — often phrased "besides [the obvious one], what else?"
- **Your gap / weakness / what you want to get better at.** Pre-write one real, non-fatal development area plus what you are doing about it. Improvised, this question tangles every time.
- **Proudest accomplishment + what was hard about it + how you made the key decisions** — the multi-part phrasing is the default; prepare all three parts, not just the accomplishment.
- **A [core-competency] decision you owned** — reasoning, trade-offs, alternatives not taken, outcome (role-specific, e.g. pricing).
- **How you use AI in your day-to-day work.**
- **The 3×3 reference block** — for each of the last ~3 roles: *who did you report to*, *how would they rate you 1–10*, *why did you leave*. Pre-write a per-role line for all three. The short / low-rated / bad-fit role especially needs a clean pre-built framing — do **not** leave the candidate to volunteer a low number and a negative role-fit story live.
- **Salary expectations.**
- **Logistics** — work authorization, location / timezone, remote, availability / start date.
- **Your questions for us.**

The four that most often surprise a role-tuned konspekt (and did at LawnStarter): **strengths, gap/weakness, proudest-accomplishment-and-how-decided, and the 3×3 report-to / rate / why-leave block.** If any baseline item is missing from a recruiter-screen konspekt, that konspekt is incomplete — add it before emitting.

**Why.** A konspekt built around the *role's* hard questions (pricing, AI) can pass the recruiter's role-fit probes and still get the candidate tangled on the generic mechanics every screen contains — which is exactly what happened on 2026-07-24: pricing / AI / salary landed (they were predicted), while strengths / gap / proudest / 3×3 were unpredicted and drew visible flailing under live English load. For this candidate the improv cost is real (spoken English under load is the bottleneck, not interview mechanics), so a pre-built anchor is the difference between a clean answer and a stall. The baseline questions are cheap to predict — they recur in every screen — so there is no reason to ever miss them.

---

## 8. Recognize the interview format before predicting questions

**Rule (calibrated 2026-07-24 on the LawnStarter / Kate Acuzar screen, where the konspekt predicted from the JD and missed the entire behavioral / reference half of a structured screen).** Before building a `prep` konspekt, **classify the interview format** and predict the question flow **from that format's canonical template**, not only from the job description. The JD gives you the *role-specific* questions; the format gives you the *structural* ones — and structured screens spend most of their time on the structural set.

Formats and their tells:

- **Recruiter / HR behavioral screen** — motivation → strengths → a strength-in-action example → weakness/gap → proudest accomplishment (STAR) → one core-competency probe → salary → logistics. Predict this whole spine for any first-round recruiter call.
- **Topgrading / reference screen** — the tell is *"on a scale of 1–10, how would they rate you"* and *"who did you report to / why did you leave"* walked across the **last ~3 roles** in order. If you see any one of these, predict the full 3×3 block (report-to / rate 1–10 / why-leave per role).
- **Hiring-manager chronological walkthrough** — "walk me through your career start to now"; per-role deep dives on decisions and trade-offs.
- **Competency / panel** — scenario and "tell me about a time…" per competency.
- **Founder round** — vision, zero-to-one, why-you-specifically, culture-add.

**How to apply.** At the top of a prep, state the inferred format (and the stage — recruiter vs HM vs panel) with a confidence note, then predict that template's spine first and layer the JD-specific questions on top. When the stage is known from the invite ("recruiter screen", "VP chronological"), use that stage's template directly. A konspekt that predicts only JD-flavored questions for a structured screen misses ~half the real questions (LawnStarter: recall ~44%).

---

## 9. Consolidate positioning questions — one theme, not five sections

**Rule (calibrated 2026-07-24 on the LawnStarter screen, where five separate predicted sections — tell-me-about-yourself, recent roles, environments, why-company, why-fit — all covered one theme and consumed ~40% of the konspekt, while the recruiter asked one open motivation question and spent the rest on behavioral questions the konspekt under-covered).** "Tell me about yourself", "your recent roles", "what environments have you worked in", "why this company", "why are you a fit" are **one theme** — identity + motivation + fit — answered from the **same** material. Collapse them into **at most two** konspekt sections (one "about you + what you're looking for", one "why this company / role"). Do not spend five near-duplicate sections on positioning.

Reallocate the freed prediction budget to the **behavioral + reference mechanics** (strengths, weakness/gap, proudest-accomplishment STAR, the 3×3 block) — that is where structured screens actually spend their time, and where the misses happen.

**Also — demote low-yield sections to a one-liner.** Work-authorization / logistics gets a single ready line, not a full section, **unless** the role has real visa friction. (Evidence: green-card / work-auth prep went unused on both the Virto and LawnStarter screens — a US-based, US-authorized candidate is rarely asked this in a screen.)

---

## 10. Log a prediction scorecard after every real interview

**Rule (candidate-directed 2026-07-24, Jared — "обновлять скилл на реальных интервью").** After every real-interview debrief, record a **prediction scorecard** in `coaching_state.md` under `## Interview Intelligence → ### Prediction Scorecard`: which predicted questions were asked, which real questions were **not** predicted, and the two rates — **recall** (of the questions actually asked, how many the konspekt predicted) and **precision** (of the questions predicted, how many were actually asked). List the misses (asked-but-unpredicted) and the dead-preps (predicted-but-unasked).

This closes the feedback loop the whole skill depends on: recurring **miss** categories get promoted into the Rule 7 baseline; recurring **dead-preps** get demoted (Rule 9); persistent format surprises sharpen Rule 8. The scorecard is the evidence that keeps prediction honest instead of drifting on vibes.

**How to apply.** In any `analyze` / `debrief` / `feedback` run on a real interview, produce the scorecard as part of the debrief and write it to the Prediction Scorecard table before closing the turn. First data point: LawnStarter / Kate Acuzar 2026-07-24 — recall ~44%, precision ~50%; misses = strengths, gap, proudest-STAR, 3×3 mechanics; dead-preps = environments, why-fit-as-its-own-Q, work-auth.

---

## 11. Technical / quantitative prep — one running dataset, case→use→mechanism, zero un-quantified words

**Rule (candidate-directed 2026-07-26, Jared — codified after a full matstat/A-B prep session for the Plata / Palukhin round degraded into decontextualized formula-drilling and cost him ~40 minutes of policing the assistant's behavior).** When coaching any **technical / exact-science topic** — mathematical statistics, A/B testing, probability, SQL, metrics math, unit economics, any subject where a wrong number is a wrong answer — run the session in this exact protocol. It overrides the assistant's default "answer the question in front of me" instinct, which is the failure mode this rule exists to kill.

**The protocol (non-negotiable order and shape):**

1. **Follow the candidate's own topic list, strictly in order.** At the start of each step, name two things: which item of *their* brief / JD / test we are on → the specific topic under discussion. Never jump ahead past an unfinished check; never reorder for the assistant's convenience.
2. **ONE running case for the whole section, ONE dataset inside a topic — and the case is built AFTER the whole scope is known.** A case assembled before the topic list is complete works as a filter: topics it happens not to touch quietly vanish. Where the subject allows, split into **nested cases** — small pyramids whose apex is a real decision (`эксперимент закончился, что говорим команде`), then one big pyramid whose apex needs the small verdicts (`трафика на три теста, инициатив семь`); at the big level the primitives are not re-taught. A unit that names the apparatus (`посчитать стандартную ошибку`) is a step, not a case. Pick a single concrete case the candidate actually lived (Plata: the credit-card application-form A/B — group A long form, group B short form, metric = conversion) and hold it across every topic. Inside a topic, hold ONE dataset and compute *every* measure and formula on it. It is forbidden to grab a fresh fragment of numbers per idea, or to start from a truncated hypothesis and bolt later terms onto it. The case is the spine; the theory hangs off it.
3. **Per concept, three mandatory parts, in this order: use → mechanism → check.** (a) the moment in the case where a decision is stuck and this concept is what unblocks it, plus what the candidate does and says there — i.e. the target answer in the shape the interviewer asks for; (b) why it works: the plain-words definition and the formula *computed on our concrete numbers*; (c) a numeric question with an explicit graded verdict. **Amended 2026-07-29 (candidate-directed):** the earlier order was definition → formula → purpose, and it produced exactly the failure he reported after Plata section 1 — *"примитивы выучил, применить сложно, знание с другой стороны"*. Definitions get indexed the way the textbook indexes them, while the interview asks in the shape of a situation; when the storage context and the retrieval context differ, the knowledge is not available under load. So the concept is entered from the decision that needs it, never from its definition. Full protocol, including the nested-case structure and the coverage check: `references/commands/prep-exam.md`.
4. **Medium depth, ZERO abstractions.** Essence + example + formula, no gratuitous expansion. But every qualitative word — "много / мало", "большой / маленький разброс", "однородно", "typical", "spread out" — is banned unless backed by a number or a formula. Statistics is exact: judge spread by the coefficient of variation (σ/mean) or a direct σ comparison, never "by eye". If the assistant writes a size/quality word without a number attached, that is a defect.
5. **Whole topic in one message; verification as a question-block at the end.** Move to the next topic only after the candidate says "дальше" (or equivalent). Do not spoon-feed one concept per message, and do not advance on the assistant's own initiative.
6. **Verify for real — grade every answer explicitly.** Mark each candidate answer right / wrong / incomplete, compute the correct value yourself, and never attribute knowledge the candidate has not demonstrated (a past failure: telling him "ты всё знаешь" before he had shown a single definition). Real verification is the point of the exercise, not a courtesy.
7. **Primary term always comes from THEIR file.** If the candidate's brief / JD / test uses a term (Plata: "стандартное отклонение"), use exactly that as the primary term — never a synonym or acronym the assistant prefers ("СКО"). One term per concept to minimise load; alternative names go only in the cheat sheet, only as secondary labels, never as the primary.
8. **Cheat sheet is a separate short file, grown concept by concept, as DEFINITION ENTRIES (validated format 2026-07-27, Jared — "вот такая шпаргалка мне и нужна").** Write it to `..._ШПАРГАЛКА.md` alongside the session state — never into the big konspekt. Each concept is one entry: a heading `## N.N Название · СИМВОЛ` — the standard symbol/notation for the quantity after a ` · ` separator (e.g. `Дисперсия · σ²`, `Биномиальное распределение · Bin(n, p)`, `Стандартная ошибка доли · SE`, `p-значение · p`) — followed by exactly five parts as bullets, in this order: **Триггер** (the situation in which the candidate reaches for this, written as the moment in the case — this is what makes the sheet findable by situation instead of alphabetically, added 2026-07-29); **Определение** (plain-words definition using the official term); **Для меня** (what it means for the candidate's real work and how it is applied); **Формула** — the formula computed on our running numbers, AND, mandatory, a `Вытекает из:` clause naming the earlier concept(s) the formula is built from (e.g. "SE = √(p(1−p)/n) … вытекает из стандартного отклонения наблюдения (3.2), делённого на √n по ЦПТ (3.1)"). The `Вытекает из` chain is the whole point of the format: it makes each number visibly flow from the previous one — the candidate rejected the earlier table-row format precisely because the numbers read as disconnected ("новые цифры, не связаны с тем, что прошли; математика — это когда одни значения высчитываются из других"). A formula entry with no derivation pointer is a defect. Do **not** revert to the old `Название | Что это | Формула | На нашем примере | Зачем` table format. One running case for the whole file; every formula's terms get their own entry (a cheat sheet missing a formula's terms is "дырявая"). Prose teaching still lives in the chat message, never in the ШПАРГАЛКА.
9. **Serve the actual interview goal, not corner-completeness.** The session exists so the candidate can *reason aloud correctly under live pressure* on the real questions the interviewer asks — not so every theoretical corner is drilled. Weight depth by interview relevance; do a **mock** (candidate reasoning aloud on a real question in the round's language) before the interview — that is what the round actually tests, and skipping it is the biggest miss.

**Why.** The candidate is anxious, the stakes are high, and matstat is not his daily tool. Vague abstractions, attributed-but-unproven knowledge, fresh datasets per concept, and robotic "next / compact" pushes destroy trust and burn the exact time the prep was meant to save. He said it plainly: "проверяй, что я реально знаю, правильно это или нет", and "ты действуешь согласно цели или просто как болванчик отрабатываешь несвязно отдельные вопросы?" This rule is the answer to that.

**How to apply.** Enter this protocol immediately on any technical prep — do not re-derive it live or make the candidate re-specify the format. It is the standard for `prep` / `practice` / `mock` whenever the subject is quantitative. Related: rule 1e (one physical line per paragraph — the cheat-sheet and konspekt are read in Obsidian), rule 6 (capture new ground-truth facts as they surface). This mirrors the memory file `feedback_technical_prep_format.md`; if the two ever diverge, the more specific candidate correction wins and both get updated.

---

## 12. Answer architecture — one question one job; identity opener; craft ≠ results; logical arc

**Rule (candidate-directed 2026-07-28, Jared — after a Splash
recruiter-screen konspekt where Q1 dumped every metric and Q2/Q3/Q4
recited the same stories+numbers three times, costing a long correction
pass).** The *set* of predicted-question answers must be architected so
each answer does distinct work. Four sub-rules:

1. **The opener is identity, not a metrics dump.** "Tell me about
   yourself" is answered high-level *about the person* — role tenure →
   current domain → trajectory → current mode — with 2–3 hooks the
   interviewer pulls on. Numbers are **not** crammed here; they are
   distributed to the specific later questions that ask for them. Explicit
   carve-out from Rule 1f (see below).
2. **One question, one job — no story carries two adjacent answers.** Each
   predicted question tests something different; do not let the same
   story+numbers headline two neighbouring answers, and give each negative
   fact (a flop, a burnout, "didn't take off") exactly **one** home rather
   than smearing it across several answers. Canonical split for the early
   cluster:
   - *tell me about yourself* → **identity** (sub-rule 1)
   - *walk me through your experience / recent roles* → **highlight reel**
     — results and numbers, one line each (Rule 1f in full force here)
   - *tell me about your [domain] experience* → **the craft: what you
     actually DID** — the process, how the work happened day-to-day —
     proving the candidate is an operator, not a metric-reciter
   - *proudest / hardest / how you decided* → **one deep-dive** on a single
     case with the judgment layer (what was hard, how decided)
3. **At least one answer shows HOW, separate from WHAT.** There must be a
   "craft" answer about *how the candidate worked* (process, decisions,
   what they built to make the work possible) distinct from the *results*
   answers. Recruiters distrust pure metric recitation — the craft answer
   is the proof the person did the job, not just memorised outcomes. It
   carries process, not a numbers recap (second carve-out from Rule 1f).
4. **Sequence the anchors as a logical arc.** Order the predicted-question
   sections: **identity → what you did → why leaving / why them / what you
   want → self-assessment (strengths / weakness / 3×3) → logistics (salary,
   work-auth).** The interviewer can jump anywhere; the candidate navigates
   by heading — but the default reading order must be a coherent story, not
   a shuffled bag.

**Seniority framing rides the same architecture.** Frame the "what you're
looking for" and salary answers to the JD's seniority band. If the JD
targets mid (not senior / lead), do **not** coach the candidate to insist
on the title or argue level — sell ownership and scope, let the rounds
prove level. Reading the band wrong and coaching a title fight is a
self-inflicted rejection.

**Relationship to Rule 1f (no conflict, explicit carve-out).** 1f — "every
answer lifts a concrete `Result` fact, no generic prose" — governs the
**result-bearing** answers: the highlight reel and the deep-dive. The
**identity opener** and the **craft answer** are the two carve-outs: the
opener carries positioning hooks, the craft answer carries the *how*.
Numbers still appear across the set — they are just placed where the
question asks for them, not dumped into Q1. A craft answer built from
invented process detail is a Rule 13 violation; a craft answer that is
vague hand-waving is a Rule 1f-style defect — pull the real process from
the candidate (Rule 13), don't pad.

**Why.** Splash screen (2026-07-28): Rule 1f, read alone, pushed every
answer toward a metric dump, so Q1 became a numbers wall and Q2/Q3/Q4
repeated the same three stories. The candidate rebuilt the arc by hand: Q1
→ identity, Q2 → highlights, Q3 → the actual work, Q4 → one deep-dive. This
rule encodes that architecture so the next konspekt ships it by default.

**How to apply.** After story-mapping and before writing answers: (1) label
each predicted-question section with its *job* (identity / highlight /
craft / deep-dive / motivation / self-assessment / logistics); (2) verify
no story+number pair headlines two adjacent sections; (3) verify at least
one craft answer exists; (4) order the sections into the arc; (5) confirm
the opener has hooks, not a metric dump. Part of DoD for any konspekt.

---

## 13. Never invent operational texture — ask for the real "how"

**Rule (candidate-directed 2026-07-28, Jared — the single largest
time-sink of the Splash prep: the assistant invented *how* the candidate
did the work, the candidate caught and corrected it, repeatedly).** Do not
fabricate the **mechanism** of how the candidate did something — team
structures, process cadences, who they sat with, what they analysed, "ran a
weekly health-check", "sat down with each aggregator and dissected their
economics", "built the channel from scratch" — when that texture is **not**
in `coaching_state.md` (storybank row or `Story Details`). Plausible
invented process detail is the #1 correction-pass generator: it reads right
to the assistant and wrong to the candidate, who then has to catch every
fabricated beat.

When the real "how" is missing, **stop and ask** 1–3 targeted questions
before drafting that answer — e.g. *"For the partner channel — did you
build it, or inherit it and find growth in it? What did the day-to-day work
actually look like?"* — then write from the answer and capture it as
ground-truth per Rule 6.

**Distinct from neighbouring rules.** Rule 2 = fabricated *labels*
(commercial profile). Rule 4 = *compressing* two real facts into one. Rule
1f = answer *substance* must lift a real `Result` metric. **Rule 13 =
inventing the *process / how* that no source states.** A single answer can
satisfy 2, 4 and 1f (right label, both facts separate, real number) and
still violate 13 by wrapping that real number in an invented workflow.

**Why.** Splash (2026-07-28): the assistant wrote "I sat with each
aggregator and dissected their economics" (he inherited the channel and
optimised it) and "five teams, an owner on each, a weekly health-check"
(invented outright). Both had to be ripped out. The metric was real; the
*how* around it was fiction — and fiction about process is as
disqualifying to an interviewer as a fabricated number.

**How to apply.** Before writing any answer whose force comes from *how the
work was done* (not just the result): check the process detail is in
storybank / `Story Details`. If it is not there — do not invent it, ask. A
one-line question to the candidate always beats a plausible guess. Part of
DoD for any konspekt with craft/process answers (Rule 12 sub-rule 3).

---

## 14. Internal consistency — causal chains hold, no cross-answer contradictions

**Rule (candidate-directed 2026-07-28, Jared).** Before delivering a
konspekt, verify two things across the whole file: (a) each answer's
narrative is a **causal chain that actually holds** (cause → effect, not a
bag of claims in sequence), and (b) **no answer contradicts a claim made
elsewhere** in the konspekt or in the candidate's real history. A konspekt
that sells one framing in Q7 and undercuts it in Q1 hands the interviewer
the contradiction.

**Why.** Splash (2026-07-28): Q7 was drafted as "this is my domain but from
a side of the table I haven't sat on yet — that makes me stronger", while
Q1 and the Credit Mentor story established he *had* worked exactly that
side. The two answers contradicted; the candidate caught it. Separately,
the Q1 opener had to be re-cut into a real causal chain (consumer lending →
set up the same monetisation the company uses → off the back of prior bank
experience on the other side) because the first draft was a sequence of
facts with no connective logic.

**How to apply.** As a delivery gate: (1) read each answer and check the
beats form a because-chain, not a list; (2) scan for any claim a
*different* answer or the candidate's known history falsifies — a "first
time", a "haven't done", a "new to me" that another answer contradicts is
the classic tell. Fix before emitting. Part of DoD for any konspekt.

---

## 15. Stretch audit — pre-script the honest framing for every натяжка

**Rule (candidate-directed 2026-07-28, Jared — the root cause of his
in-interview freezing).** The candidate does not freeze on hard questions;
he freezes when the role's language asks him to claim something that, said
plainly, feels to him like a lie. At Splash the word was *"marketplace"*:
in his own head Alfa is **a side of** a lending marketplace, not a
marketplace, so "I have marketplace experience" registered as a натяжка
(overstatement) — and rather than say it, he tangled, defaulted to a
non-fintech story that *was* literally true, and never aired his strongest
fit. **The fix is not "be more confident." The fix is to find every stretch
during `prep` and hand him a framing that is 100% true, defensible, and
still lands the point — so his honesty instinct becomes the script instead
of the thing that derails him.** His own analogy: this is exactly what he
did packaging his green-card case — the facts were real, the *framing* was
built deliberately in advance, not improvised under pressure.

**Stretch audit — a mandatory `prep` step.** Before writing answers, scan
the positioning for every place where the role's language, the JD, or a
predicted question maps onto the candidate's real history at an **angle** —
where saying it the interviewer's way would require a claim the candidate
would flinch at as an overstatement. Typical shapes:
- a **category the candidate was adjacent to, not inside** ("marketplace",
  "growth", "platform", "0→1") — he owned *a side / a slice / the
  downstream* of it, not the whole;
- a **scope inflation** ("led / owned / built" where he influenced,
  inherited-and-grew, or ran one part);
- a **domain the role assumes** that he touched from a neighbouring seat;
- a **seniority or title gap** between what he did and what the level implies.

**For each stretch, pre-write three things into the konspekt** (a short
`⚠️ Натяжка` note under the relevant answer, or a dedicated `## Скользкие
формулировки` block if several cluster):
1. **The honest reframe** — the one line that is fully true *and* still
   claims the fit. Never "Alfa is a marketplace"; always "I ran **one side**
   of exactly this model — the bank end that takes traffic from lending
   marketplaces." The stretch is dissolved by naming the real relationship
   precisely, not by inflating or by retreating.
2. **The question-split** — because the same word means two questions.
   *"Did you BUILD a marketplace?"* → the genuinely-true story (SMMACC, both
   sides from scratch). *"Do you KNOW the lending marketplace?"* → Alfa
   lender side + Credit Mentor aggregator side. Pre-deciding which story
   each phrasing pulls is what stops the freeze-and-grab-the-wrong-one.
3. **The one-line bridge to the strongest fit** — so a stretch becomes a
   launchpad, not a place to survive: "…so I've now sat on both ends of the
   integration Splash sits in the middle of."

**How to apply.** Run the stretch audit as an explicit pre-flight line item
for `prep` ("scanning for натяжки and pre-scripting the honest framings"),
and surface the found stretches to the candidate *by name* — "here are the
three places the role's language and your real history sit at an angle, and
the true way to say each" — so he rehearses the bridge, not the wording,
cold. Capture confirmed reframes into `coaching_state.md → Interview
Intelligence → Effective Patterns` so a stretch solved once is never
re-derived. Distinct from its neighbours: Rule 2 stops *me* from inventing a
label; Rule 4 stops *me* compressing two facts; **Rule 15 handles the case
where the fact is real but the candidate can't say it the role's way without
feeling dishonest — and pre-builds the truthful bridge he can.** Part of DoD
for any `prep` konspekt: no answer touching a known stretch ships without its
honest framing already written.

---

## 16. Тон — banned readiness phrases (§ Тон)

**Rule (from the Plata section-1 postmortem, 2026-07-29 — findings F20 /
F29 / F31 / F33).** Four phrases are forbidden in any prep, and hard-banned
in `prep exam`. Each one is not a style preference — each encodes a specific
way the prep failed, and the phrase is what let it fail quietly.

| Forbidden | What it actually does | Say instead |
|---|---|---|
| «ты это знаешь» / "you already know this" | Asserts the candidate's knowledge instead of testing it. This is how topics got marked covered that he had never once said out loud. | «проверим: [конкретный вопрос по нашим числам]» — then grade the answer. |
| «контент закрыт» / "the content is covered" | Treats *my* explaining as *his* learning. Explanation is `объяснён`; only a spoken answer is `отработан вслух`. | «объяснено — осталось проговорить вслух, статус пока `объяснён`». |
| «100% пройдено» / «ты готов» | Readiness is a fraction read off the curriculum table, not an impression. Saying it once made a half-prepped section feel finished. | «по программе: 7 из 11 в статусе `отработан вслух`, 4 открытых долга» — then let the candidate say whether that is ready. |
| «забудь, это я зря приплёл» | Retracts material mid-prep. It doesn't cost one topic — it makes the candidate distrust the whole set, at the worst possible moment. | Nothing gets retracted. If the source doesn't cover it, it was marked `мой синтез` when it was written; if it's out of scope, it's logged as a debt with a reason. |

**Readiness is declared by the candidate, never by me.** I show the
curriculum table and the audit findings; the verdict is his. Corollary: an
audit report is delivered as-is — thirteen findings are reported as thirteen
findings, never softened into «почти всё готово».

---

## How these rules surface

These rules are loaded at the top of every command's instruction set:

- `prep`: Rule 1 (🗣️ format — Russian summary + English anchor phrases)
  and Rule 2 (no fabrication) gate the output. Rule 1b (Russian narrative
  stays Russian) gates the prose. Rule 4 (factual hygiene) gates every
  candidate-history fact narrated in the brief. Rule 5 (vocabulary
  calibration) gates the spoken-English word choice in every 🗣️ block.
  Rule 3 governs how to handle a fabrication or conflation caught
  mid-session. Rule 1f gates answer **substance** — every predicted-Q
  answer must lift a concrete `Result` / `Earned Secret` fact from the
  mapped story's `Story Details` block, not paraphrase it generically.
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
- **all commands** (Rule 1e): every markdown file the skill writes uses one physical line per paragraph — never hard-wrap prose, blockquotes, or list items. The human reads these in Obsidian; manual mid-paragraph newlines render as garbage.
- **`prep` / `hype`** (Rule 1f): mapping a story to a question is not writing the answer — every konspekt answer and 🗣️ anchor lifts a concrete `Result` / `Earned Secret` fact from the mapped story's `Story Details` block; a story-named answer with no real metric is a defect and gets rewritten from source before the candidate sees it.
- **`prep` (recruiter / HR / talent screen)** (Rule 7): the konspekt must cover the standard screen baseline — tell-me-about-yourself, motivation, why-company, strengths, gap/weakness, proudest + how-decided, the core-competency decision, AI, the 3×3 report-to / rate 1–10 / why-leave block, salary, logistics, your-questions — **in addition to** role-specific questions. The four that most often surprise a role-tuned draft are strengths, gap, proudest, and the 3×3 block; a screen konspekt missing any baseline item is incomplete.
- **`prep`** (Rule 8): classify the interview format first and predict from its template (recruiter behavioral / Topgrading reference / HM chronological / competency panel / founder), then layer JD-specific questions on top — the 3×3 "rate 1–10 / why-leave last-3-roles" is a Topgrading tell.
- **`prep`** (Rule 9): positioning questions (tell-me-about-yourself / recent-roles / environments / why-company / why-fit) collapse to ≤2 sections; reallocate the freed budget to behavioral + reference mechanics; work-auth is a one-liner unless the role has visa friction.
- **`analyze` / `debrief` / `feedback`** (Rule 10): every real-interview debrief writes a prediction scorecard (recall / precision + misses + dead-preps) to `coaching_state.md → Interview Intelligence → Prediction Scorecard`, feeding Rules 7–9.
- **`prep` / `practice` / `mock` (technical / quantitative topics)** (Rule 11): one running case for the section built **after** the full scope is known, nested into small pyramids plus one big one; per concept — **use → mechanism → check** (the stuck decision and the target answer, then definition + formula computed on our numbers, then a graded numeric question), never definition-first; zero un-quantified size/quality words; whole topic then a check-block, grade every answer, primary term from their file; cheat sheet is a separate `..._ШПАРГАЛКА.md` of definition entries (`## Название · символ` → Триггер / Определение / Для меня / Формула with a mandatory `Вытекает из:` derivation pointer), all formula terms captured; weight depth by interview relevance and run a mock before the round.
- **`prep`** (Rule 12): the answer *set* is architected — identity opener (hooks, not a metric dump), one-question-one-job (no story headlines two adjacent answers, each negative fact one home), at least one craft/"how" answer distinct from the results answers, sections ordered into a logical arc (identity → what you did → why leaving / why them / what you want → self-assessment → logistics), seniority framing riding the JD band. Explicit carve-out from Rule 1f for the identity opener and the craft answer. Rule 1f gates case answers to STAR reshaped from the source (take as-is or re-cut framing, never facts).
- **`prep`** (Rule 13): never invent the *how* — team structures, process cadences, who the candidate sat with, "built it from scratch" — when no source states it; stop and ask 1–3 targeted questions, then capture the answer (Rule 6). Distinct from Rule 2 (labels) / Rule 4 (compression) / Rule 1f (metric substance).
- **`prep`** (Rule 14): delivery gate — each answer is a causal chain that holds, and no answer contradicts another answer or the candidate's real history.
- **`prep`** (Rule 15): run a **stretch audit** before writing answers — find every натяжка where the role's language maps onto the candidate's real history at an angle (adjacent category, scope inflation, assumed domain, level gap), and for each pre-write the honest reframe + the question-split (BUILD-it vs KNOW-it → different true stories) + the one-line bridge to the strongest fit. Surface the stretches to the candidate by name so he rehearses the truthful bridge cold, not improvises it under pressure. Distinct from Rule 2 (my labels) / Rule 4 (my compression): Rule 15 = the fact is real but the candidate can't say it the role's way without feeling dishonest. DoD: no answer touching a known stretch ships without its honest framing written.
- **`prep`** (Rule 1d candidate-question set): offer a priority-ordered default set — ideal candidate → report line + stakeholders → benefits → role emphasis → resource (dedicated vs shared) → domain question → process/timeline (always last). Report-line and resource are defaults because role-tuned drafts keep dropping them. **Segment the set by the interviewer's role**: for a recruiter screen, split into "ask this interviewer" (ideal candidate, comp/benefits, org basics + report-line, process/timeline) vs "save for the hiring manager" (role emphasis, squad structure, strategy/constraint questions) — a recruiter fumbles domain-depth and it wastes the candidate's airtime. Keep the HM group in the konspekt marked *don't ask now*.
- **`prep`** (Rule 1d spoken cells): answer beats carry substance only — no self-narrating labels opening a beat ("Чем горжусь…", "Как решал…" as a tag), no persuasive tails closing it, no beat repeated within the same answer. The candidate reads these aloud; they sound staged and read as padding.
- **`prep`** (Rule 1g heading language): Q-headings in the 🗣️ section are written in the candidate's scanning language (Russian for Jared), not the interview language — the heading is a locator the candidate finds fastest in his own reading language; the English question is understood by ear and not duplicated on the page. Answers stay two-column per 1c.

- **`prep exam` / `audit`** (Rule 16): four phrases are banned — «ты это знаешь», «контент закрыт», «100% пройдено» / «ты готов», «забудь, это я зря приплёл». Each one is how a prep failed quietly: asserting knowledge instead of testing it, counting my explanation as his learning, replacing a fraction with an impression, and retracting material mid-prep. Readiness is declared by the candidate off the curriculum table; audit findings are reported as-is, never softened.

When in doubt, this file wins. The cost of breaking one of these rules
is higher than the cost of being slightly slower or less polished.
