# prep — Prep Brief Workflow

## Flow selection — three kinds of prep (read before anything else)

`prep` is not one workflow. Three round kinds have different goals, different deliverables, and mutually exclusive sections. Pick the kind **first**, write it into the round file, and only then start work.

| Invocation                 | Goal                                  | Deliverable                                                       | Reference       |
| -------------------------- | ------------------------------------- | ----------------------------------------------------------------- | --------------- |
| `prep screening [company]` | sell yourself to a recruiter          | prep brief — positioning, baseline question set (rule 7), comp     | this file       |
| `prep manager [company]`   | sell yourself to the hiring manager   | prep brief — fit map, concerns + counters, stretch audit, your Qs  | this file       |
| `prep exam [company]`      | pass an exam in an exact discipline    | curriculum table with sources, drills on a running dataset, graded answers, cheat sheet | `prep-exam.md` |

The rest of this file is the `screening` / `manager` flow. For `exam`, stop here and read `references/commands/prep-exam.md`.

### Mutual exclusion — this is the anti-confusion mechanism

The round file carries `kind:` in its frontmatter, and `kind` decides which sections are even allowed:

- `kind: exam` → the sections `📖 A. Компания за 60 секунд`, `📖 D. Карта соответствия`, and `🗣️ 5. Твоё позиционирование` are **forbidden**. An exam is not a pitch.
- `kind: screening` / `kind: manager` → a curriculum table, a running dataset, and graded numeric drills are **forbidden**. These flows do not teach a discipline.

A forbidden section inside a round file is a defect caught by `scripts/round_audit.py` (detector 8). The coach is not trusted to remember the boundary — the artifact enforces it.

### Choosing the kind — never guess

1. Read `Round formats` for this company in `coaching_state.md` (the Format Discovery Protocol below writes it). If this round is recorded there, take the kind from it.
2. If the employer supplied a document describing the round (prep guide, agenda, take-home brief), **read that document before choosing the kind**. It outranks both the coach's inference and the candidate's own expectation. See "Scope source precedence" in `prep-exam.md`.
3. If the kind still cannot be determined, ask exactly one question — _"Is this a recruiter screen, a conversation with the hiring manager, or a round with calculations and technical questions?"_ — and record the answer in the round file.

Bare `prep [company]` remains valid: infer the kind by the rules above, then announce it in the pre-flight message.

### Mixed rounds — two files, not a hybrid

If a single call is part technical and part behavioral, open **both** flows as separate round files. The exam flow claims the time budget first.

**Never downgrade an exam round because the candidate predicts the mechanics won't be asked.** When the employer's document says "live discussion with questions and problems", the document wins. If torn between two kinds, pick the more demanding one.

### Required Inputs

- Company
- Role title/seniority
- Job description

### Optional Inputs

- Interviewer LinkedIn URLs or profile links
- Stage format
- Company values

### Pre-flight: announce plan and confirm

**Before running any of the Logic steps below, send the candidate one short message that names what `prep` is about to do.** Do not start discovery, do not generate output, do not run the Commercial Profile pre-check until the candidate has confirmed (or corrected) the plan.

Why this rule exists: candidates have reported losing track of what the skill is doing — a long generation begins, output appears, and they don't know what was researched, what was assumed, or what file was just written. Naming the plan in one message before execution makes the run legible and gives the candidate a chance to correct scope before work happens (e.g., "don't research interviewer X, I already met them" or "skip the JD parse, the link is stale").

**Format of the pre-flight message:**

Write in the candidate's preferred narrative language. Keep to 5-8 lines. Cover:

1. **Company and round** — what you understood ("Synoptix AI, Round 2 with Ross Burton, 2026-05-18, 30 minutes, phone screen").
2. **What the coach will do** — name the discovery and generation steps in user-level terms ("I'll do a quick discovery on the company and a deeper one on Ross's profile, parse the JD, then generate a prep brief").
3. **Which stories are likely to be used** — list the candidate's S### IDs that the coach expects to draw on ("Likely stories: S001, S005, S007"). If the storybank is empty, say so.
4. **Output file** — the absolute path of the prep brief that will be created ("Brief will land at `/Users/.../profiles/<id>/interview-coach-state/2026-05-18_synoptix-round2.md`").
5. **One question to confirm** — *"Sound right, or do you want to change anything before I start?"*

**Example pre-flight (English):**

> Quick sanity check before I run prep:
>
> - **Round**: Synoptix AI, Round 2 with Ross Burton (Investigo recruiter), Monday 2026-05-18, 30-minute phone screen.
> - **What I'll do**: discovery on Synoptix (10 min), interviewer intel on Ross (5 min), JD parse, then a prep brief — Predicted Q&A, story mapping, Day-Of Cheat Sheet, "what to do next" footer.
> - **Stories I'll likely use**: S001, S005, S007. If you want me to swap or skip any, say now.
> - **Output**: `/Users/ymuromcev/Desktop/Claude Code/ai-job-searcher/profiles/jared/interview-coach-state/2026-05-18_ross-burton-round2.md`.
>
> Sound right, or do you want to change anything before I start?

**What confirmation looks like:**

- Plain "yes" / "go" / "поехали" → proceed to Logic Step 1.
- Correction in scope ("skip interviewer intel, I already met him" / "don't use S007, retired") → acknowledge in one line, then proceed with adjusted scope.
- Question back ("what does discovery cover?") → answer in one or two lines, then re-ask for confirmation.

**When to skip pre-flight:**

- The candidate explicitly said in their message: *"just run prep, no confirmation"* or *"prep with default plan."* Honor that for this run only — do not extend to future runs.
- This is a re-run of `prep` within the same session after a confirmed pre-flight, and the scope hasn't changed (e.g., same company, same round, same stories) — say one line *"Re-running prep with the same scope as before"* and proceed.

**Failure mode this rule prevents:**

The coach launches into a 5-10 minute discovery + generation cycle, the candidate sees only intermittent tool calls, and the resulting brief surprises them ("why did you research X?", "where did this story come from?", "I didn't know you'd write to that file"). The pre-flight makes the run a conversation, not a black box.

### Logic

1. Identify interview format (see format taxonomy below). If the identified format is a presentation round, note: `present` provides dedicated content preparation coaching for presentation rounds. After this prep brief, recommend `present` for content structuring if the candidate hasn't already run it.
2. If interviewer profile links provided, research interviewer profiles and extract intelligence (see Interviewer Intelligence section below). If only names provided, ask for LinkedIn URLs.
3. **Parse the JD for competencies** (see JD Parsing Guide below). If JD Analysis exists from a previous `decode` command for this company+role, use the existing competency extraction and 6-lens analysis as the starting point. Verify it's still current (JD unchanged), then skip to Step 4. If the JD has changed since decode, re-parse and note changes.
4. Identify company interviewing culture (see company archetype intelligence below).
5. Infer top evaluation criteria (adjusted for format + culture).
6. Map candidate strengths and risks — incorporate interviewer-specific adjustments if intel available.
6.5. **Role-Fit Assessment** — With the JD parsed and candidate profile available, run the full 5-dimension fit assessment from the Role-Fit Assessment Module (`references/cross-cutting.md`). See Step 6.5 below.
7. **Check storybank status and health.** If the candidate hasn't built a storybank yet (no `coaching_state.md` with storybank entries, or storybank is empty), flag it before story mapping: "You don't have a storybank yet, so I can't map stories to predicted questions. I'll flag which competencies each question tests — once you run `stories`, we can do the mapping. Want to build your storybank now, or continue with the rest of the prep?" If a storybank exists, run an auto health check before mapping:
   - **Story count**: How many stories exist? Target: 8-12. Flag if < 6.
   - **Strength distribution**: How many at 4+? Target: at least 60%. Flag if majority are 3 or below.
   - **Earned secret coverage**: How many stories have real earned secrets vs. placeholders? Flag if < 50% have extracted earned secrets.
   - **Competency gaps for this role**: Cross-reference the JD-derived competencies (from Step 3) against the storybank's primary and secondary skills. Flag any critical competency with no story or only weak stories.
   - **Overuse risk**: Flag stories with Use Count 3+ in the current job search.
   - **Freshness risk**: Flag stories used in prior rounds at this company (from Interview Loops).
   Report the health check as a `Storybank Health` section in the output (see output schema below). If critical issues exist, suggest `stories` before continuing — but don't block the prep.
7.5. **Commercial Profile Pre-check (fabrication guardrail).** Before generating story mapping or framing any case as "B2B bridge", "enterprise relevance", "consumer pattern", etc., verify the commercial profile of every story you plan to use. See Step 7.5 below for the protocol. This step is a hard gate — do not proceed to Step 8 with unverified profiles.
8. **Generate likely questions and story mapping.** Use `references/story-mapping-engine.md` for the full portfolio optimization protocol. This replaces simple Q→S### mapping with fit-scored, conflict-resolved, freshness-checked portfolio mapping. If no storybank exists, output competency mapping only (flag which competencies each question tests and which gap-handling patterns to prepare). When generating predicted questions for PM roles, draw from the High-Signal Question Patterns and Lenny's PM Interview Questions below in addition to JD-derived competencies.
9. Generate non-generic interviewer questions.

### High-Signal Question Patterns (for Question Generation)

When generating predicted questions (Step 8), draw from these themes identified across 150+ hiring leaders by Lenny Rachitsky (via Lenny's Podcast). These represent the question categories most commonly used by experienced interviewers — they are high-signal because they require genuine reflection and can't be gamed with rehearsed answers:

**Theme 1 — How do they handle hard stuff?**
- "Talk me through your biggest product flop. What happened and what did you do about it?" (Annie Pearl, Microsoft — "I look for people being brutally honest about how bad it was")
- "What's the hardest thing you've ever done?" (Geoff Charles, Ramp)
- "Tell me about a time you were in a challenging or highly ambiguous situation" (Jiaona Zhang, Linktree — "I look for people who look for structure and a way forward through the ambiguity")
- "Describe a time when you were part of a controversial product decision" (Yuhki Yamashita, Figma — looks for ability to represent both sides fairly)
- "Tell me about a time when you needed to disagree with your manager" (Ethan Evans, Amazon — tests backbone + disagree-and-commit)

**Theme 2 — How do they think?**
- "What's something that everyone takes for granted that you think is hogwash?" (Nikhyl Singhal, Meta — "There's no way to answer that question without being genuinely opinionated")
- "What's an unfair secret you've learned to improve a product team's velocity?" (Noah Weiss, Slack — "I mean not something that you read on Medium")
- "Tell me about something you did that worked out but not for the reason that you thought it would" (Ayo Omojola, Carbon Health — tests introspection)

**Theme 3 — How do they build, ship, and drive impact?**
- "Tell me about your most significant professional accomplishment" (Bill Carr, ex-Amazon VP)
- "Ask them about a product they shipped that is NOT cherry-picked" (Laura Schaffer, Amplitude — "This helps you learn more about their frameworks, not just their outcomes")
- "What's something that would not exist without your initiative?" (Upasna Gautam, CNN)

**Theme 4 — Who are they as people?**
- "When I ask people you've worked with about you, what will I hear?" (Andrew Bosworth, Meta CTO)
- "Fast-forward three years. What's different about you then?" (Ben Williams — tests humility and self-awareness)
- "Imagine you had a really great day at work. What are you telling your partner about it?" (Tom Conrad, CEO of Zero — reveals intrinsic motivation)
- "What question should I have asked you?" (Christina Wodtke, Stanford — "The person is an expert in themselves")

Use these patterns to enrich and diversify predicted questions beyond standard behavioral categories. Candidates who prepare for these themes will handle unexpected questions better.

### Lenny's PM Interview Questions (for PM Role Prep)

For PM-specific prep, Lenny Rachitsky maps 10 core PM interview questions to the 10 core PM jobs (via Lenny's Newsletter). When generating predicted questions for PM roles, draw from these:

1. **Impact**: "What's the most important or impactful product you shipped? What made it so important or impactful?"
2. **Collaboration**: "Tell me about a time you disagreed with an engineer on your team, and how you resolved it."
3. **Ownership**: "Share a time you shipped a product that failed. Why did it fail and what did you learn?"
4. **Leadership**: "Tell me about a time when your team didn't gel. What was the issue, and how did you deal with it?"
5. **Execution**: "Pick a project you're proud of that took 3-9 months. Walk me through it from beginning to end." (Give ~7-10 min)
6. **Strategy**: "Pick a product you worked on in the past year — talk me through your product strategy for it."
7. **Customer Insights**: "Tell me about a time you did user research that had a big impact on the product."
8. **Vision**: "Tell me the vision for one of your recent projects or teams."
9. **Planning**: "How do you get your team to commit to a deadline?"
10. **Communication**: Assessed through all other answers — look for clarity, conciseness, convincingness.

**Bonus — Decision Making** (especially for senior PM roles): "What's the biggest one-way-door product decision you've ever had to make?" This reveals decision-making process, how they balance business and user needs, and whether they de-risked the decision.

### JD Parsing Guide

The quality of predicted questions depends entirely on how well you read the JD. Don't just scan for keywords — read for what the company is actually optimizing for:

1. **Repeated themes**: If a JD mentions "cross-functional collaboration" three times, that's a primary evaluation criterion, not filler. Count how often key themes appear.
2. **Order and emphasis**: What's listed first in responsibilities? In requirements? First = highest priority in most JDs.
3. **"Nice to have" vs. "required"**: The required section is what they'll screen on. The nice-to-have section reveals what a Strong Hire looks like beyond baseline.
4. **Verb choices**: "Own" vs. "support" vs. "contribute to" — these signal the level of autonomy and scope expected. "Own end-to-end" is a very different expectation than "contribute to team efforts."
5. **Between-the-lines signals**: "Fast-paced environment" = they're understaffed. "Ambiguity" = undefined role, needs self-direction. "Stakeholder management" = political environment. "Wearing multiple hats" = small team, broad scope.
6. **What's missing**: If a PM JD doesn't mention data/analytics, that's a signal about the team's maturity. If an engineering JD doesn't mention testing, note it.

Extract the top 5-7 competencies in priority order and use them to drive question prediction and story mapping.

### Interview Format Taxonomy

Different formats require fundamentally different prep, pacing, and scoring weights. Identify which format and adjust accordingly:

| Format | Key differences | Scoring weight shift |
|---|---|---|
| **Behavioral screen** (30-45 min) | Breadth over depth. 5-8 questions, short answers. Efficiency is paramount. | Structure + Relevance weighted highest |
| **Deep behavioral** (45-60 min) | Depth. Follow-ups expected. Must sustain a story through probing. | Substance + Credibility weighted highest |
| **System design / case study** | Structured thinking visible in real-time. Process matters as much as answer. **Highly variable across companies** — run Format Discovery Protocol below before coaching. Coach focuses on communication layer, not solution correctness. | Structure + Substance weighted highest. Credibility scored on process rigor, not answer correctness. |
| **Presentation round** | Prepared content + Q&A handling. Storytelling + poise under challenge. | Structure + Differentiation weighted highest |
| **Bar raiser / culture fit** | Evaluates judgment, values alignment, and caliber vs. company bar. | Credibility + Differentiation weighted highest |
| **Hiring manager 1:1** | Fit + vision alignment. Often less structured. Read signals. | Relevance + Differentiation weighted highest |
| **Panel interview** | Multiple personas, energy management across 45-60 min. | All dimensions + stamina/adaptability |
| **Technical + behavioral mix** | Context switching between modes. Must signal both depth and breadth. **Format varies widely** — run Format Discovery Protocol below before coaching. Coach focuses on mode-switching, behavioral integration, and thinking-out-loud skills. | Substance + Structure weighted highest. Scored on communication across modes, not technical output quality. |

If the candidate doesn't know the format, prep for behavioral screen (most common) and flag: "If you can find out the format, I can sharpen this significantly."

### PM Interview Evaluation Framework

For PM roles specifically, hiring manager research compiled by Lenny Rachitsky (via Lenny's Newsletter) identifies 6 core skills assessed in PM interviews: **Communication, Collaboration, Execution, Strategy, Impact, and Product Sense**. When prepping PM candidates, ensure story coverage across all 6 dimensions — gaps in any one can be disqualifying.

Key context for PM candidates: the average PM hiring process evaluates 23 candidates per hire through a 6-stage funnel (recruiter screen → hiring manager screen → full-day interview → panel discussion → references → offer). The project/case component is consistently rated the most informative part of the evaluation by hiring managers. This means differentiation matters enormously — the candidate is competing against roughly 22 others at each stage.

### PM Product Sense Interview Framework

For PM candidates facing product sense interviews (adopted by Meta, Google, Stripe, OpenAI, Block, and many others), interview coach Ben Erez outlines a 5-step framework (via Lenny's Newsletter). The coach should use this to guide prep and evaluate readiness when the identified format includes a product sense component:

1. **Product Motivation** (3-5 min): Describe the product, the deeper human needs it addresses, competitive context, and a concise mission statement that guides all subsequent decisions.
2. **Segmentation**: Identify all stakeholders (ecosystem analysis), break into segments by behaviors/motivations/context (not demographics), prioritize using reach vs. underserved degree, and develop a specific persona.
3. **Problem Identification**: Map the user journey ("day in the life," not generic pre/during/post), discover pain points at each stage, distinguish needs (desires) from problems (obstacles), prioritize by severity × frequency.
4. **Solution Development**: Brainstorm multiple distinct approaches, evaluate using impact vs. effort, define a concrete V1 with go-to-market, assess risks and mitigations.
5. **V1 Articulation**: Outline a concrete first version, connect back to mission for a complete narrative arc.

**Baseline skill across all steps**: Clear communication — waypointing (take thinking pauses, walk interviewer through response, check in before proceeding), assumption setting (2-4 assumptions to narrow scope), and game plan articulation.

**The "Leverage Check" tactic**: Before diving into solution details, pause to verify the solution addresses the actual user problem. As Erez notes: "Interviewers aren't expecting perfection — they're looking for a thoughtful approach, solid reasoning, and clear communication."

**Top pitfalls to coach against**: thinking out loud without structure, asking the interviewer for direction, shallow segmentation (relying on demographics), confusing needs with problems, and jumping to solutions before fully exploring the problem space.

### PM Analytical Thinking Interview Framework

For PM candidates facing analytical/metrics interviews, Ben Erez outlines a parallel 5-step framework (via Lenny's Newsletter):

1. **Assumptions and Game Plan** (~1 min): Make 3-4 assumptions to narrow scope (geographic focus, platform, product maturity). Share your game plan for the 35 working minutes.
2. **Product Rationale** (~2 min thinking + ~2 min presenting): Product description, maturity level, business model, competitive landscape, and a mission statement connecting product purpose to company mission.
3. **Metric Framework** (largest time allocation, ~15 min): Map ecosystem players and their value propositions ("What's in it for me?"). Define 3-5 primary metrics per player. Define a **North Star Metric (NSM)** with guardrail metrics.
4. **Goal-Setting** (~5 min): Shift from 50,000-foot view to ground level. Pick one ecosystem player with highest leverage, map user journey backward from NSM event, score goals on Impact on NSM + Ability to Influence, and make a clear decision (no hedging).
5. **Tradeoff Evaluation** (~10 min): Identify common benefit of both options, outline pros/cons, pinpoint decision crux, state decision clearly, connect to strategy/mission/maturity, and specify what would change your mind.

**NSM definition criteria** (coach should verify candidate's metric selection against these): A valid North Star Metric must be implementable as a single data query, include a specific timeframe (daily/weekly/monthly), grow indefinitely as the product succeeds, and NOT be a ratio or average (these create false positives — "if your NSM increases while your ecosystem actually shrinks, you're getting a false positive"). Example NSMs: "total streaming hours per week" (Spotify), "total completed deliveries per week" (DoorDash).

**Key coaching insight**: "While good candidates can identify relevant metrics, what will set you apart is a cohesive story about healthy growth." The differentiator is ecosystem-first thinking — tracking value creation for all stakeholders, not just one side.

### First-Round Interview Tactics

Interview coach Erika Gemzer (93% placement rate across 200+ job seekers at Google, Meta, Uber, Airbnb, Stripe, via Lenny's Newsletter) provides a first-round-specific framework — the **Minimum Viable Interview Prep (MVIP)** — that the coach should apply when prepping candidates for phone screens and first rounds:

1. **JD Mirroring**: Paste the JD into a document, highlight keywords, create a two-column table mapping their language to the candidate's experience. When describing experience in the interview, use their language, not yours. This simple technique dramatically increases perceived fit.

2. **Memory Lane, Not Question Bank**: Pick 3-5 recent major projects (last 2-4 years) and remember every detail — context, stakeholders, challenges, decisions, results (quantified). Don't write answers to hundreds of behavioral questions — as Gemzer warns: "This is exhausting and can actually overload your brain and cause you to freeze up or even 'blackout' in an interview." Deep knowledge of 3-5 projects beats shallow prep for 100 questions.

3. **STAR++ Format**: Standard STAR plus two additions — what you **learned** and how you **evolved your approach** in future situations. The "++" is what separates a good answer from a great one.

4. **Three question formats** (candidates should recognize which they're facing): Pure behavioral (70% of questions — "Tell me about a time..."), Theoretical (20% — "How would you approach..."), Situational (10% — "Imagine you're in this scenario..."). Each requires a different response structure.

5. **Time budget for a 45-min interview**: 3-5 min intros, ~35 min interviewer questions, 5-7 min candidate questions. As Gemzer puts it: "Interviews are often won or lost by the questions you ask the interviewer at the end."

The key insight from Lenny's own PM interview guide (via Lenny's Newsletter): **practice is more important than study**. Most candidates over-index on studying frameworks and under-index on actual mock interviews. The coach should push candidates toward `practice` and `mock` early, not let them endlessly prepare in theory.

### Format Discovery Protocol (System Design / Case Study and Technical + Behavioral Mix)

These formats vary more across companies than any other interview type. A system design interview at Google looks nothing like a case study at McKinsey or a technical deep-dive at a Series B startup. Rather than prescribing how these interviews work, the coach must discover what the candidate's specific format looks like.

**Run this protocol whenever the identified format is system design/case study or technical+behavioral mix — in `prep`, `mock`, or `practice technical`.**

#### Discovery Questions (ask before any format-specific coaching)

Ask one at a time. Adapt based on responses — skip questions the candidate has already answered.

1. "What do you know about the format of this interview? Has the recruiter described it?"
2. "Is it whiteboard, take-home with presentation, live verbal walkthrough, collaborative problem-solving, or something else?"
3. "How long is the session? Is it the full time on one problem, or split across multiple?"
4. "Do you get the problem in advance, or is it presented live?"
5. "Is it solo (you present, they observe) or collaborative (you work through it together)?"
6. "Who's conducting it — an engineer, a hiring manager, a cross-functional interviewer, or a panel?"
7. For technical+behavioral mix specifically: "What's the split between technical and behavioral? Do they alternate questions, or is it segmented (first half technical, second half behavioral)? One interviewer or a handoff?"

#### If the Candidate Doesn't Know the Format

Don't guess. Help them find out:

- "Ask your recruiter directly: 'Can you describe the format of the [round name] interview? Is it a system design exercise, a case study, or something else? How long is it, and what should I expect?' Recruiters almost always answer this."
- "Check Glassdoor interview reviews for this company — search '[Company] interview questions [role]'. Take specific details with a grain of salt, but format descriptions are usually directionally accurate."
- "Look for the company's engineering or product blog — some companies describe their interview process publicly."

If they can't find out, default to a verbal walkthrough format (the most common and most coachable variant) and flag: "I'm defaulting to a verbal walkthrough format since we don't know the specifics. If you learn more about the format, tell me — it'll change how we prep."

#### Saving Discovered Format

After running Format Discovery, save the format details to `coaching_state.md` so subsequent commands don't re-ask:

- **In Profile** (general): Update the `Known interview formats` field with any new format types discovered.
- **In Interview Loops** (company-specific): Under the relevant company entry, save structured format details per round:
  ```
  - Round formats:
    - Round 1: Behavioral screen, 45min, recruiter
    - Round 2: System design, 50min verbal walkthrough, collaborative, senior engineer
    - Round 3: Technical+behavioral mix, 60min, alternating, hiring manager
  ```
  Include format type, duration, format variant (if applicable), and interviewer type for each round. This level of detail allows `mock`, `practice technical`, and `hype` to tailor their output without re-running discovery.

This prevents re-running discovery when the candidate later runs `mock`, `practice technical`, or `hype` for the same company.

#### Format Variability Acknowledgment

When coaching for these formats, be explicit that your guidance is adapted to what the candidate has described, not to insider knowledge of the company's process: "I'm working from what you've told me about the format. If anything is different on the day, the communication skills we're building — thinking out loud, asking clarifying questions, articulating tradeoffs — transfer regardless of the exact setup."

### Open-format coaching boundaries

**Scope: this section applies only to open formats — system design, case study, and technical+behavioral mix, where there is no single correct answer and no canonical source to teach from.** It does **not** apply to `prep exam` (closed disciplines with a textbook: statistics, A/B testing, SQL, credit-risk metrics, unit economics). For those, see "Exam rounds override these boundaries" at the end of this section.

In open formats this coach's value is **communication coaching** — how you structure and articulate your thinking — not domain expertise. Be explicit about this boundary upfront, not as a caveat after the fact.

#### What the Coach Can Do

- Coach the **communication layer**: how to structure thinking out loud, narrate decisions, explain tradeoffs, and make your reasoning process visible to the interviewer
- Coach **question-asking and clarification-seeking** behavior — candidates who jump to solutions without scoping the problem get penalized in almost every system design format, and this is highly coachable
- Practice **talking about past technical decisions** under scrutiny (the role drills already do this well)
- Help with the **behavioral components** of mixed-format interviews — the storytelling, credibility, and differentiation skills that transfer directly
- Coach **handling probing questions** about tradeoffs, constraints, and failure modes — these appear in every technical format regardless of company
- Coach **energy management and context-switching** across mixed-format interviews, which are often 50-70 minute marathons
- Simulate the **interpersonal dynamics** of these interviews — skeptical interviewers, ambiguous prompts, time pressure, "why not X?" challenges

#### What the Coach Cannot Do

- **Evaluate system design solutions for technical correctness.** The coach can assess whether you communicated your reasoning clearly, not whether your architecture is sound.
- **Simulate accurate problem complexity** for a specific company's interview. Practice problems here build communication skills, not domain knowledge.
- **Replicate company-specific case study formats.** A McKinsey case, an Amazon system design, and a startup technical deep-dive are fundamentally different exercises.
- **Score technical output quality.** The rubric scores communication quality — Substance (did you explain your reasoning with evidence?), Structure (could the interviewer follow your thinking?), Credibility (did you acknowledge constraints and tradeoffs?).
- **Teach open-ended architectural judgment** (which system components to choose, how to weigh framework tradeoffs for an unfamiliar stack). There is no canonical source to teach from, so the candidate must bring this judgment; the coach helps them communicate it. This is **not** a licence to refuse teaching in `prep exam`, where a canonical source exists and teaching is mandatory.

#### Specific Trigger Points

When the conversation enters these territories, name the boundary:

- **Candidate asks "Is my design correct?"** → "I can tell you whether your reasoning was clear and well-structured, but I can't evaluate the technical correctness of your architecture. For that, practice with a peer in your domain or use a domain-specific prep resource."
- **Candidate asks for a company-specific system design problem** → "I can give you a practice scenario to work through communication skills, but I can't guarantee it matches the complexity or style of [Company]'s actual interviews. The value here is practicing how you think out loud, scope problems, and articulate tradeoffs — those skills transfer regardless of the specific problem."
- **Discussion enters domain-specific technical depth** → first check the kind. In `kind: exam` this is the job — teach it from the pinned source. Only in an open format say: "This is getting into [specific domain] territory where you need a domain expert, not a communication coach. What I can help with is how you'd explain this tradeoff to an interviewer clearly and concisely."
- **Candidate asks which technical approach is better** → "I don't have the domain expertise to tell you whether approach A or B is technically superior. What I can help with is how to present your reasoning for whichever approach you choose — how to structure the comparison, name the tradeoffs, and make your decision defensible."

Don't quietly skip these topics — name the boundary so the candidate knows where to get complementary help.

#### Exam rounds override these boundaries

In `kind: exam` the boundaries above are **suspended**, and refusing to teach is a failure, not caution. The reasoning: an open system-design prompt has no single right answer, so promising to grade correctness would be a lie. A confidence interval has one correct width, a z-test has stated applicability conditions, and both live in a textbook. Where a canonical source exists, teaching from it and grading the answer against it is the coach's **duty**.

Concretely, in `prep exam`:

- Teach the subject matter from the source pinned in the round file, one topic at a time.
- State an explicit verdict on every answer the candidate gives — correct, partially correct with the exact missing piece, or wrong with the correction.
- Never deflect with "you need a domain expert." If the pinned source does not cover a topic, mark it `мой синтез` in the curriculum table so the candidate knows reliability is lower there, and teach it anyway.

This override was added after a documented failure: the coach declined subject-matter depth in a statistics round, the candidate was asked exactly that material, and two of the weak answers were topics listed verbatim in the employer's own scope document. See the postmortem referenced in `prep-exam.md`.

### Company Archetype Intelligence

Companies have interviewing cultures that transcend individual JDs. When a known company is specified, apply culture-specific coaching — **but only from verified sources**.

#### The 8-step research screen (mandatory — this is the 📖 front-matter)

`prep` **always** opens with a systematic 8-step company + role research
screen. These 8 steps *are* the 📖 sections of the konspekt (see Output
Schema → 📖 A–H); there is no separate research file. **All 8 steps always
run at full depth**, even for a 15-minute coffee chat — the research is what
tells the candidate whether the call is worth taking at all. Only the 🗣️
speech sections downstream scale to the round's length and format. (This
diverges deliberately from the tiered Research Depth Levels in `research.md`:
`research` is triage, `prep` is commitment.)

Each step has an input, an output into the konspekt, and a sourcing rule.
Every claim maps to a Company Knowledge Sourcing tier (below) — a fact is
either **verified** (cite the source) or **unverified** (label it, and for
numbers say "don't state").

1. **Pull JD from the primary source.** In: JD URL / ATS id / candidate's
   pasted copy. Out: canonical JD text in 📖 B. Rule: primary source only —
   if the page is JS-rendered, hit the ATS API (e.g. Workable
   `apply.workable.com/api/v2/accounts/<slug>/jobs/<shortcode>`); reconcile
   against the candidate's copy; **canon = the candidate's copy**; list any
   divergences (salary band especially) explicitly.
2. **Requirements + anti-requirements.** In: canonical JD. Out: a requirement
   list *and* an explicit disqualifier list in 📖 B. Rule: extract
   disqualifiers, not only requirements — this both removes phantom gaps
   (something explicitly *not* required, e.g. "Python/ML not needed") and
   flags any candidate story that trips a disqualifier as a **landmine**
   (feeds ⚠️ E and story selection in 🗣️ 6).
3. **Business model.** In: company site, filings, press. Out: product /
   customer / **how they make money** / why this role is the lever for their
   economics, in 📖 A. Rule: "how they earn", not "what they do"; add a
   one-line "how to read it" (e.g. capital-efficient → margin, not
   growth-at-any-cost) and 1–2 honest "why this genuinely interests you" hooks.
4. **Reputation recheck.** In: Trustpilot / BBB / Glassdoor / forums. Out: a
   **verified** table + an **unverified** list marked "don't state", in 📖 F.
   Rule: keep competitors' claims out of the sources; confirm every negative
   is about *this* company, not dragged from an adjacent file.
5. **People.** In: LinkedIn / TheOrg / interviews / press. Out: recruiter +
   hiring-manager dossier in 📖 C, freshness-checked, with a resonance hook.
   Rule: press releases go stale — verify the current seat (self-reported
   LinkedIn title > aggregators); mark hypotheses as hypotheses.
6. **Fit map.** In: requirements (step 2) + storybank. Out: a requirement →
   specific-story table in 📖 D with **landmines marked explicitly**. Rule:
   every claim points to a real storybank story.
7. **Culture layer.** In: careers video / values / JD language. Out: their
   exact lexicon + a tie-in to a candidate story, in 📖 G. Rule: mirror the
   tone, **never quote verbatim**.
8. **Comp / benefits.** In: JD comp + market. Out: a US-comp mechanics read +
   a what-to-ask list in 📖 H. Rule: net-to-net; equity-liquidity realism for
   a private company; flag what the posting omits. Hooks into the `salary`
   command.

Cross-cutting: sensitive topics (a scandal, a lawsuit) go into ⚠️ E held in
reserve — surface **only if the interviewer raises it**, note the risk
symmetry, never lead with it.

If the candidate provided interviewer LinkedIn URLs, run step 5 via the
Interviewer Intelligence protocol below. Present every finding with source
attribution: "From their careers page: [finding]", not "This company values
[finding]." Follow the Claim Verification Protocol from
`references/commands/research.md`.

#### Company Knowledge Sourcing (Critical)

This is a high-stakes area. Telling a candidate "Stripe values X in interviews" when you're guessing can actively hurt them. This tiering is the **per-claim gate for every one of the 8 research steps above** — no fact reaches the konspekt untagged. Every company-specific claim must be sourced to one of three tiers:

**Tier 1 — Verified (cite the source):**
Claims based on information you can actually retrieve and point to during this session:
- The company's own website (values page, careers page, leadership principles, blog posts)
- The job description the candidate provided
- Information the candidate shared from their own research
- Interviewer LinkedIn profiles (when provided)

When using Tier 1 sources, cite them naturally: "According to Stripe's careers page..." or "The JD emphasizes..." or "You mentioned that your recruiter said..."

**Tier 2 — General knowledge (label it clearly):**
Claims based on widely known public information about very well-known companies (e.g., Amazon's Leadership Principles, Google's Googleyness, Netflix's culture deck). These are acceptable but must be labeled:
- "Amazon is well known for its Leadership Principles — this is public and widely documented."
- "Google's interview process has been extensively written about publicly."

Only use Tier 2 for information that is genuinely common knowledge, not for details you're less than confident about.

**Tier 3 — Unknown (say so, don't guess):**
If you don't have real source material about a company's interview culture, **say so directly** instead of generating plausible-sounding claims. Say: "I don't have specific insider knowledge about [Company]'s interview culture. Here's what I'd recommend:"
- Search the company's website and careers page for values and culture signals
- Ask the recruiter directly: "What competencies does this interview assess?"
- Check Glassdoor interview reviews (take with a grain of salt, but useful for format/process)
- Look for the company's engineering/product blog for cultural signals

**Never do this:**
- Don't state culture claims as fact without a source ("Stripe values urgency and clear thinking in interviews" — unless you can point to where you got this)
- Don't generate fictional interview process details (number of rounds, specific formats, bar raiser processes) unless sourced
- Don't present "I've heard that..." or "Companies like this tend to..." as company-specific guidance

**Framework for any company** (ask candidate to research if unknown):
1. What does this company publicly reward? (values page, leadership principles, culture docs)
2. What gets people promoted there? (Glassdoor, Blind, LinkedIn posts from employees)
3. What's the implicit bar? (e.g., Amazon's Leadership Principles aren't just phrases — they shape what a good answer sounds like)
4. What interview quirks exist? (e.g., bar raiser process, specific evaluation rubrics)

If the candidate provides company culture context, integrate it into question prediction, story selection, and answer framing. If they don't, ask: "Do you have a sense of what this company's interview culture values beyond the JD? This can significantly sharpen your prep — and I'd rather work from what you know than guess."

#### Real reported questions — pull them and fold into the predicted set (even recruiter screens)

Before finalizing predicted questions (Step 8), search for the company's **real reported interview experience** — Glassdoor interview reviews, Reddit, Blind, "[Company] interview questions [role]". This is available even when the interviewer is unknown (recruiter screens), because it surfaces **company-level patterns**, not interviewer-level ones: the actual funnel / stages, recurring real questions, and format warnings (take-homes, exercises). Do NOT treat Glassdoor as a format-only fallback — it is a **primary source of real questions**. Fold any recurring reported question into the predicted set as its own anchor (Rule 1d section), and record the real funnel in 📖 C / ⚠️ E so the candidate knows the stages and the company's ghosting/timeline patterns.

Evidence (Splash 2026-07-28): this surfaced "tell me about a conflict with a peer", "a product you built from scratch", and a PR-review take-home — **none derivable from the JD**, all real, and one of them ("conflict with a peer") a genuine gap the JD-only draft had missed. Tier every claim per Company Knowledge Sourcing above: a reported question is Tier 1 when you can point to the review; the specific numbers / anecdotes inside a review stay unverified. This applies to **every** prep, recruiter screens included — the interviewer being unknown is not a reason to skip it, because company-level question patterns don't need the interviewer's name.

### Interview Loop Awareness

If `coaching_state.md` shows previous rounds at the same company, this is a continuation prep, not a fresh start:
- Check which stories were used in previous rounds — avoid repeating them unless the candidate is asked to go deeper.
- Review what concerns likely surfaced from previous round analysis.
- Adjust predicted questions: later rounds typically go deeper on areas the earlier rounds flagged.
- **Diff against debrief data**: If `debrief` was run after a previous round at this company, explicitly compare: what signals did the interviewer show (from debrief's Signal Reading section)? What concerns likely surfaced based on those signals? Use debrief data to sharpen predictions — "Your Round 1 debrief noted the interviewer pushed back on your team size claim. Expect Round 2 to probe Credibility harder on scope and impact."
- Note: "You used S003 and S007 in Round 1. For Round 2, prioritize S### and S### to show range. Based on your Round 1 analysis, they'll likely probe deeper on [area]."
- **Interview Intelligence cross-referencing** (light-touch rule: only surface when it changes the prep brief):
  - Check Interview Intelligence → Company Patterns for this company: real questions from past rounds, what worked/didn't, stories that landed
  - Check Interview Intelligence → Question Bank for cross-company patterns on similar roles — only when 3+ data points exist (e.g., "Leadership questions have appeared in 4 of your 5 behavioral screens")
  - Check Effective/Ineffective Patterns for guidance on story selection and framing
  - The test: "Would this prep brief be different without this data?" If yes, include it. If no, skip it.

### Interviewer Intelligence

When the candidate provides interviewer LinkedIn URLs or profile links, guide them on what to look for and help them interpret what they find. The coach cannot browse LinkedIn profiles directly — the candidate needs to share the information. This is still one of the highest-leverage prep activities — knowing who's across the table changes story selection, framing, and signal-reading.

**Input requirement**: LinkedIn URLs or profile links required — not bare names. If the candidate provides only a name, respond: "A name alone isn't reliable enough for interviewer research — too many false matches. Can you share their LinkedIn URL? Check the calendar invite, recruiter's email, or search LinkedIn directly." If the candidate shares a URL but not the profile content, ask them to share key details: "I can't browse LinkedIn directly. Can you tell me their current title, how long they've been at the company, their career path (previous roles), and any recent posts or articles? I'll use that to shape your prep."

**What to look for** (guide the candidate to extract from LinkedIn profiles, public posts, talks, articles):

1. **Role/title and tenure** — What's their functional lens? An engineering leader evaluates differently than a product VP or a people partner. How long they've been at this company vs. previous roles shapes their perspective.
2. **Career path** — Did they come up through IC or management? Startup or big co? Technical or business-side? This shapes what they value in candidates. Someone who was promoted internally values cultural alignment; someone hired externally values fresh perspective.
3. **Recent posts/articles** — What topics do they care about publicly? If they recently posted about "building high-performing teams," expect questions about team dynamics. If they wrote about technical architecture, expect depth probes. These are signals about what they'll dig into.
4. **Shared background** — Any overlap with the candidate (same school, previous company, domain, geography)? Rapport opportunity — not to manufacture connection, but to note natural common ground.
5. **Interview style signals** — Seniority and function predict likely style:
   - Senior eng leaders → tend toward depth and "how" questions
   - Product leaders → tend toward "why" and prioritization questions
   - HR/people partners → tend toward behavioral and values alignment
   - Executives → tend toward brevity, "so what," and big-picture judgment
   - Cross-functional peers → tend toward collaboration and communication style

**Evidence sourcing**: When making claims about interviewers, always say where the insight comes from — e.g., "Based on their LinkedIn, they've spent 8 years in engineering leadership..." or "I'm inferring this from their title alone, so take it with a grain of salt." Be explicit when you're guessing vs. when you have real profile data to work from.

**Public org-chart sources the coach CAN pull directly**: Unlike LinkedIn (which the coach cannot browse), **[The Org](https://theorg.com)** org-chart pages and search-indexed LinkedIn snippets are reachable via web search — use them to verify an interviewer's title, level, tenure, and team placement before the call. Calibration rules: (1) a **self-reported LinkedIn title is the most current** source — trust it over aggregators; (2) aggregators like The Org **lag** and may show a stale/lower title (e.g., "Manager" when LinkedIn says "Group PM"); (3) **map the title to the company's own ladder** — a title like "Group PM" that isn't a formal rung at that company signals scope (manages a few PMs) more than exact level. Present as: "Their LinkedIn says [title]; The Org lists [title] — at [company] that maps to roughly [scope]." 

**Privacy guardrail**: Only use publicly available professional information. Don't speculate about personal life, personality traits, or private matters. Stick to what the profile says and what they've published.

### Step 6.5: Role-Fit Assessment

With the JD parsed and candidate profile available, run the full 5-dimension fit assessment from the Role-Fit Assessment Module (`references/cross-cutting.md`).

**Assess all 5 dimensions:**
1. **Requirement Coverage**: Map JD requirements to resume. Count matches vs. gaps. Distinguish hard requirements from wish-list items.
2. **Seniority Alignment**: Does the candidate's scope of impact, years of experience, and leadership level match what the JD describes?
3. **Domain Relevance**: How transferable is the candidate's domain experience? Direct overlap, adjacent, or distant?
4. **Competency Overlap**: Map JD competencies to storybank (if available) or resume. Which competencies have strong evidence? Which are gaps?
5. **Trajectory Coherence**: Does this role make sense as the candidate's next career move?

**Classify each gap as frameable or structural:**
- **Frameable gaps**: The candidate lacks the exact experience but has a credible bridge narrative. These become concern counters. Example: "No direct healthcare experience, but led regulatory compliance at a fintech — the regulated-industry skills transfer."
- **Structural gaps**: Real limitations that narrative can't fully bridge. These should be named honestly. Example: "The role requires managing a team of 20+ and your largest team was 4. That's a real gap interviewers will probe."

**Output the verdict** (Strong Fit / Investable Stretch / Long-Shot Stretch / Weak Fit) with evidence.

If a `research` fit assessment already exists for this company, compare: "Research flagged this as an Investable Stretch based on limited data. Now that I have the JD, I'm upgrading to Strong Fit because [reason]" or "The JD confirms the domain gap I flagged earlier — this is still a stretch, and here's our plan for it."

For Stretch or Weak verdicts, adjust the rest of the prep brief accordingly — Likely Concerns should prioritize the structural gaps, and story mapping should deliberately address frameable gaps.

When generating Likely Concerns, pull from the Role-Fit Assessment's gap classification. Frameable gaps get full counter-evidence strategies. Structural gaps get honest framing + what the candidate brings instead (Pattern 3 from Gap-Handling Module).

### Step 7.5: Commercial Profile Pre-check (fabrication guardrail)

This is a hard gate before story mapping. It enforces `references/conventions.md` rule 2 — **never assign B2B / B2C / Marketplace / Advisory / Internal / enterprise labels to a case from its tag or title alone**.

**Protocol:**

1. **Identify the candidate stories.** From storybank, select the top N stories likely to be deployed (typically the same set that will appear in story mapping for this brief — up to 8).

2. **Read Story Details for each.** For each story, read its `## Story Details → #### S###` entry in `coaching_state.md` and check the `Commercial Profile:` field.
   - If the field has a value (B2B / B2C / Mixed / Marketplace / Advisory / Internal / N/A) → ✅ verified, use it.
   - If the field is blank or missing → ❌ unverified, go to Step 3.
   - If the column does not exist in Storybank table → run the Schema Migration Check from SKILL.md first to add the column and matching field to each Story Details entry, then re-check.

3. **Lazy prompt for unverified stories.** Before generating story mapping, ask the candidate in one message (in their preferred narrative language):

   > *"Прежде чем продолжить prep, нужен быстрый ground-truth по нескольким кейсам — у этих стори в storybank нет подтверждённого commercial profile, а в брифе я буду фреймить их относительно роли. Одна строка на кейс:"*
   >
   > - **S003 — Credit Mentor**: B2C / B2B / marketplace / advisory / mixed / internal?
   > - **S005 — Alfa MFI**: B2C / B2B / marketplace / advisory / mixed / internal?
   > - **S008 — SMMACC**: B2C / B2B / marketplace / advisory / mixed / internal?
   >
   > *"Если кейс смешанный — напиши обе стороны (например, 'marketplace — businesses pay listing, both pay transaction'). Если не помнишь — напиши 'TBD', я в брифе отмечу."*

   List **only the unverified stories**, not the whole storybank. Keep it to one batch per `prep` run — do not loop one-by-one.

4. **Wait for the candidate's response, then persist.** When the candidate answers:
   - Write each confirmed value to the `Commercial Profile:` field of the corresponding `Story Details → #### S###` entry in `coaching_state.md`.
   - Also update the `Commercial Profile` cell of the corresponding Storybank table row.
   - For any "TBD" or refusal, leave the field blank but record in Coaching Notes: "[date]: Candidate declined to confirm commercial profile for [S###] — will re-ask on next prep that uses this story."
   - Save mid-session per Mid-Session Save Protocol.

5. **Proceed to Step 8 with the verified labels.** When framing any story in the brief (story mapping, "best positioning," concern counters):
   - If verified → use the label as-is.
   - If TBD → write "**commercial profile: TBD — candidate to confirm**" inline next to the story in the brief output. Do not invent.

**When to skip Step 7.5:**

- No storybank exists yet → no stories to verify, proceed.
- All planned stories already have verified Commercial Profile → log "Commercial Profile pre-check: all stories verified, no prompt needed" in your internal trace (do not surface to candidate) and proceed.
- Triage mode (interview < 24h) AND verified profiles cover the top 3 stories → skip the prompt even if other stories are unverified, because asking 5 yes/no questions before a same-day interview adds noise.

**Output marker in the brief:**

In the `Story Mapping → Notes` column for each row, append `(profile: B2B verified)` or `(profile: TBD)` based on the verification status. This makes the verification status visible in the final brief.

**Failure mode to avoid:**

The recurring failure (caught 2026-05-14 on Ross Burton prep) is to skip Step 7.5, invent commercial profiles from story titles, build a coherent-sounding "enterprise B2B bridge" narrative, and ship the brief. The candidate then catches the fabrication and the brief has to be rewritten from scratch. Step 7.5 exists specifically to make this failure impossible — if executed, fabrication cannot happen.

### Output Schema

**Applies to `kind: screening` and `kind: manager` only.** `kind: exam` has its own deliverable — do not emit this brief for an exam round (sections A, D and 5 are forbidden there; see "Mutual exclusion" at the top of this file).

The prep brief has two parts in a **fixed, strict order — do not reorder**:

1. **📖 A–H research front-matter** — the 8-step company + role screen (see
   "The 8-step research screen" above). This is the systematic research base,
   always present, always full-depth.
2. **Sections 5–10 (🗣️ speech, with 📖 §9 plan inside)** — positioning, Q&A,
   concerns, questions, plan, cheat sheet. These read from the front-matter and
   scale to the round.

Visual markers separate reference material from speaking material.

**Section markers (use as prefixes in section headers):**

- **📖 = read once, reference material.** Context the candidate skims before the call to load mental state. Not memorized.
- **⚠️ = risk / do-not-trip.** Landmines, structural gaps, and sensitive topics the candidate holds in reserve. Read carefully, act defensively.
- **🗣️ = learn and speak.** Material the candidate actually delivers in the interview. Russian summary of *what to say* + English anchor phrases (1-5 words each) that are short enough to recall under pressure. No long English scripts to read aloud — those break under ESL pressure. See `references/conventions.md` rule 1.

**Header line (always include at the top of the brief):**

> `📖 = справка, читай один раз. ⚠️ = риск, не наступи. 🗣️ = речь, опорный конспект (смысл по-русски + anchor phrases на английском). После любой 🗣️ фразы — пауза, дай интервьюеру среагировать.`

(Translate to the candidate's narrative language if not Russian. The header is the orientation device — without it, the markers don't land.)

**The structure — 📖 A–H research front-matter, then sections 5–10 (🗣️ speech + 📖 §9 plan), strict order:**

```markdown
# Prep — [Company] [Round/Stage] — [Interviewer] — [Date]

📖 = справка, читай один раз. ⚠️ = риск, не наступи. 🗣️ = речь, опорный конспект (смысл по-русски + anchor phrases на английском). После любой 🗣️ фразы — пауза, дай интервьюеру среагировать.

Файл лежит по абсолютному пути — указать здесь, в шапке.

---

## 📖 A. Компания за 60 секунд

Связный параграф (research step 3 — business model): продукт / клиент / **как они зарабатывают** (не «что делают»), почему именно эта роль — рычаг для их экономики. Одна строка «как это читать» (напр. capital-efficient → маржа, не рост любой ценой) + 1-2 честных хука «почему тебе это реально интересно» — без натяжки.

Каждый факт — verified (сайт / JD / filings, с источником) или помечен как догадка. Стартовый контекст раунда (что за звонок, где компания в воронке кандидата, длительность, формат, дата/время) — одной фразой в начале параграфа.

## 📖 B. Роль из первоисточника

**JD из первоисточника (step 1).** Канонический текст вакансии — primary source, не пересказ. Если страница JS-рендерится — тянем ATS API (напр. Workable `apply.workable.com/api/v2/accounts/<slug>/jobs/<shortcode>`). Сверить с копией кандидата; **canon = копия кандидата**; расхождения (особенно вилка зарплаты) выписать явно.

**Requirements + anti-requirements (step 2).** Два списка:

- **Требования** — что реально нужно.
- **Anti-requirements / дисквалификаторы** — что вычёркивает кандидата, ИЛИ что явно **НЕ** требуется (снимает фантомный гэп, напр. «Python/ML не нужен»).

Дисквалификатор, совпавший с историей кандидата, помечает её как **landmine** — уходит в ⚠️ E и влияет на выбор истории в 🗣️ 6.

## 📖 C. Кто такой [Interviewer Name] и что он на самом деле ищет

Связный параграф про интервьюера (research step 5) — функциональная линза, фон, специализация, что он скорее всего фильтрует. Заканчивается одной чёткой фразой: «Поэтому твоя задача за N минут — Y». То, что раньше было «Critical Reframe», живёт здесь как замыкающая мысль параграфа.

**Freshness-check:** пресс-релизы устаревают — подтвердить текущую позицию (self-reported LinkedIn title > агрегаторы вроде The Org); гипотезу помечать как гипотезу. Найти **resonance hook** — естественную общую почву, не натянутую.

Если есть инсайд от рекрутёра / кого-то, кто видел этого интервьюера — sub-секция `### Инсайд от [имя]` с прямой цитатой (без редактуры). Цитата стоит больше пересказа. Panel → отдельный параграф на каждого.

## 📖 D. Карта соответствия (fit map)

Role-Fit Assessment как **bullets / параграф, не таблица**. Прохожу по 5 измерениям:

- **Requirement Coverage** — что покрыто резюме, что нет (одна фраза).
- **Seniority Alignment** — скоуп, лидерство, годы.
- **Domain Relevance** — насколько домен переносим.
- **Competency Overlap** — карта JD-компетенций на storybank, где сильное, где гэп.
- **Trajectory Coherence** — логичен ли этот шаг как next career move.

Под каждым — конкретика, не «Strong / Moderate / Weak» вакуумно.

Затем таблица **requirement → конкретная история storybank** (research step 6). Каждое требование из §B → реальный S###. **Landmines помечены явно** — истории, с которых НЕ начинать (из anti-requirements §B).

Verdict (Strong Fit / Investable Stretch / Long-Shot Stretch / Weak Fit) — в одну строку в конце.

## ⚠️ E. Риски и landmines

- **Landmines** — истории / темы, которые триггерят дисквалификатор из §B. Не вести с них.
- **Frameable gaps** — что бридж-нарративом покрывается (counter-line готовим в 🗣️ 7).
- **Structural gaps** — что нарративом не покрыть; называем честно, готовимся к probing.
- **Что НЕ гэп** — фантомные требования, снятые в §B. Не извиняться за то, чего не просят.
- **Чего мы не знаем** — короткий честный список реальных unknowns, влияющих на готовность (формат / длительность / фокус интервьюера не подтверждены, качество историй storybank). Мета-калибровка, не «что могу узнать».
- **Sensitive topics** — щекотливое (скандал, иск, публичный факап): держать в резерве, поднимать **только если интервьюер сам заговорил**, отметить симметрию риска, никогда не вести с этого.

## 📖 F. Репутация: verified vs unverified

Две группы, разделять жёстко:

- **Verified** (Trustpilot / BBB / Glassdoor — с источником): факты, которые можно называть на звонке.
- **Unverified** (форумы, заявления конкурентов, маркетинговые цифры): помечены **«не называть»**.

Конкурентов отфильтровать из источников; убедиться, что каждый негатив — про **эту** компанию, а не притянут из соседнего файла.

## 📖 G. Словарь культуры

Их точный лексикон (careers video / values page / язык JD) → зеркалить тон **без дословного цитирования**. Каждый маркер культуры привязать к конкретной истории кандидата (research step 7).

## 📖 H. Комп и бенефиты

US-comp механика под кандидата (research step 8): base net-of-tax, equity в частной компании (реализм ликвидности), PTO, 401k, healthcare. Что **отсутствует** в постинге → в список «спросить на звонке». Считать net-to-net. Хук в команду `salary`.

## 🗣️ 5. Твоё позиционирование

**Headline** (одна строка, выучить дословно). Russian: смысл. English (1-2 коротких anchor phrase): то, что произносится.

Headline — это ответ на вопрос «расскажи о себе», который ты даёшь **первым**. Дальше — расширения по non-repetition principle:

**Если попросит больше (30-секундная версия):**
- Только **новые слои**, не повтор+добавка. Headline уже сказан — не повторяй его, добавь следующий уровень глубины.
- Russian bullets: о чём говорить.
- Anchor phrases: 3-5 английских фраз по 1-5 слов.

**Если попросит ещё шире:**
- Ещё один слой, опять без повтора предыдущих.

Принцип non-repetition: каждое расширение **дополняет**, не повторяет. Кандидат не должен в третий раз произносить ту же headline — это сигнал «у меня одна история и я её мну».

## 🗣️ 6. Вероятные вопросы и истории

7-10 блоков, каждый — Q&A в стандартном формате:

```
### Q[N]. [Текст вопроса на русском или английском, как услышит]

**Зачем спросит:** 1-2 предложения — что он на самом деле проверяет этим вопросом (компетенцию, концерн, signal).

**Когда применять:** одна строка — на каких триггерах эта история подходит, а на каких нет. Помогает не использовать её на неправильном вопросе.

**О чём говорить:**
- Russian bullet 1 (смысл, не дословная фраза).
- Russian bullet 2.
- Russian bullet 3.
- [последний bullet — «Скажи цифру / факт X и сделай паузу.»]

**Anchor phrases:**
- `English phrase 1` (1-5 слов)
- `English phrase 2`
- `English phrase 3`
- [3-6 коротких anchor'ов — это то, что произносится; не длинные предложения, а опорные точки]

**Backup история (если попросит другой пример):** [S### + одна строка чем заходит]

**Recovery line (если затупил):** одна короткая фраза по-английски, чтобы выкупить 5 секунд на сборку мысли. Дать русское описание смысла рядом.

<details>
<summary>📖 S### — [Title] — полная STAR</summary>

[Полная STAR-история из Story Details в coaching_state.md. Markdown allowed. Раскрывается одним кликом в Obsidian / GitHub / любом markdown viewer'е.]

</details>
```

Маркеры в `<summary>` блоков `<details>`:
- **📖** — полная отполированная STAR-история, лежит в storybank.
- **📝** — черновик, не финализирован, ещё нужен `stories` для доработки.

Если у вопроса есть отдельный sub-блок (например, Earned Secret для конкретной истории) — выноси в `### Q[N]+ — Earned secret для [история]` после основного блока, не мешай внутрь.

Порядок внутри Q&A блока **фиксирован**: справочная информация (Зачем / Когда) → операционка (О чём / Anchor / Backup / Recovery) → раскрывашка (`<details>`). Не перемешивать.

## 🗣️ 7. Концерны и контры

Топ-3 концерна интервьюера (из 📖 D fit-map / ⚠️ E рисков или из истории компании). Каждый — блок:

```
### Концерн N: [Одна фраза, что его насторожит]

**Почему подсветит:** 1-2 предложения.

**О чём отвечать:**
- Russian bullet 1.
- Russian bullet 2.
- Russian bullet 3.

**Anchor phrases:**
- `English phrase 1`
- `English phrase 2`
- `English phrase 3`

**Earned secret / why it lands:** одна строка — почему контра убедительна, а не отмазка.
```

Тот же порядок внутри блока: справка → операционка.

## 🗣️ 8. Твои вопросы к [Interviewer Name]

5 готовых вопросов, отсортированы **от сильнейшего к слабому**. Каждый — мини-блок:

```
### Вопрос N

**Anchor question (English):** `Точная формулировка вопроса`

**Зачем спросить (Russian):** 1-2 предложения — что ты этим сигналишь и что узнаёшь.

**Что искать в ответе:** одна строка — какой ответ хороший знак, какой плохой.
```

Сильнейший вопрос — первый. Если интервью обрезается, кандидат уходит с лучшим в кармане.

## 📖 9. План на оставшиеся часы

Adaptive footer — этот пункт встроен сюда как **логическое завершение брифа**, не отдельный аппендикс. Режим (triage / focused / full) выбирается автоматически по hours-to-interview из Interview Loop в `coaching_state.md`.

**Логика выбора режима:**

1. Прочитать дату/время интервью из Interview Loop. Если время не записано — default start-of-business этой даты.
2. Вычислить часы-до-интервью от сейчас (timestamp сессии).
3. Режим:
   - `< 24h` → **triage**
   - `24h — 7 days` → **focused**
   - `> 7 days` → **full**
4. Если дата TBD — **focused** mode, первое действие «уточнить дату у рекрутёра и пере-запустить prep».

**Constraints по режимам:**

- **Triage** — одно действие, не больше. *«Сегодня вечером: прочитать §10 cheat sheet один раз. Завтра за 15 минут до звонка — ещё раз. Это весь план.»* Не рекомендовать `practice` / `stories` / `mock` — добавляет тревогу, не пользу. Если есть критический storybank gap — назвать его «accepted gap», не домашка.
- **Focused** — максимум одно действие в день. Drill 1 `practice` каждые 1-2 дня, не каждый день. Канун интервью — `hype` + отдых, не новый drilling.
- **Full** — недельная гранулярность, не дневная. 2-3 milestone'а в неделю, кандидат self-schedule'ит внутри.

**Содержимое секции:**

- **Что у тебя есть** (3-5 буллетов): абсолютный путь к этому брифу, абсолютный путь к anchor_phrases_en.md если есть, топ-3 истории готовые к deploy, самый вероятный концерн, ссылка на §10 cheat sheet того же файла.
- **Что делать дальше** (по режиму, dated + command-attached): triage / focused / full plan.
- **Одна строка summary** (всегда): `Recommended next command: [command] — [why, 8 words или меньше]`.

**File path requirement:** в «Что у тебя есть» использовать **абсолютные пути**. Это единственное место в брифе, где абсолютные пути обязательны.

## 🗣️ 10. Day-of cheat sheet

Эта секция — **указатель, не пересказ**. Кликабельные markdown-ссылки на якоря секций того же файла, чтобы за 15 минут до звонка кандидат прыгнул в нужное место, а не перечитывал весь бриф.

Формат:

```markdown
За 15 минут до звонка — пробежать глазами это.

**Что вспомнить:**
- Твоё позиционирование → [§5](#-5-твоё-позиционирование)
- Твои истории и anchor phrases → [§6](#-6-вероятные-вопросы-и-истории)
- Концерны и контры → [§7](#-7-концерны-и-контры)
- Твои вопросы к интервьюеру → [§8](#-8-твои-вопросы-к-interviewer-name)

**Три anchor-numbers закрепить:**
- `[number] [unit]` ([что это, 1 строка])
- `[number] [unit]` ([что это])
- `[number] [unit]` ([что это])

**Один reminder:**
- [Одна фраза про энергию / темп / то, что важно держать в голове весь звонок]
```

**Syntax якорей в markdown:** заголовок `## 📖 5. Твоё позиционирование` → якорь `#-5-твоё-позиционирование` (эмодзи срезается, цифра и слова кириллицей сохраняются, пробелы → дефисы, нижний регистр). Cyrillic-якоря работают в Obsidian (подтверждено эмпирически 2026-05-19). В GitHub markdown viewer'е работают через перцент-энкодинг — Obsidian-формат с кириллицей пишем как есть.

Если интервью — мульти-раундовое и cheat sheet будет открываться на разных раундах, anchor-numbers могут быть разные — это ок, секция переписывается под раунд.

---

[конец брифа]
```

**Section ordering — НЕ переставлять.** Порядок (📖 A–H research front-matter → 🗣️ §5–8 → 📖 §9 → 🗣️ §10) выверен эмпирически: сначала систематический ресёрч (8-шаговый screen как справочная база), потом материал для разговора, потом мета-план, потом cheat sheet как навигация. 8-шаговый ресёрч всегда идёт первым и на полной глубине (RFC 064) — именно он говорит кандидату, стоит ли вообще выделять время на звонок. Любая перестановка ломает «нарратив» брифа.

**Когда что-то не применимо:** если у тебя нет данных про 📖 C (recruiter не дал ничего про интервьюера) — оставь параграф коротким и честно скажи «У нас минимум интел — что знаем: X. Чего не знаем: Y». ⚠️ E (блок «Чего мы не знаем») дублирует это явно. Не выдумывай.
