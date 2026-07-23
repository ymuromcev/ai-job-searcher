---
id: RFC-064
title: Prep company-research stage — mandatory 8-step screen inside the prep konspekt
status: accepted
tier: M
created: 2026-07-23
tags: [interview-coach, skill, prep, company-research, konspekt]
---

# RFC 064 — Prep company-research stage: mandatory 8-step screen inside the prep konspekt

- **Status:** Accepted (approved 2026-07-23)
- **Tier:** M (SKILL.md `prep` section + `references/commands/prep.md` rework + smoke test + VERSIONS.md bump; no engine, no new command, no schema migration)
- **Skill:** `interview-coach` (vendored at `skills/interview-coach/`)
- **Refs:** `profiles/jared/interview-coach-state/constraints.md` (rule 4 — JD triage defers to Notion), konspekt convention rule 1c/1d, job-pipeline `analyze` mode (post-response go/no-go — sibling, not this)
- **Date:** 2026-07-23

## 1. What changes for the user

Today `prep [company]` produces a konspekt whose research front-matter
(the 📖 sections) is light: "what is this call", "who is the interviewer",
"what we don't know", "what they'll assess + gaps". The depth that made the
LawnStarter screen strong — primary-source JD, anti-requirements,
business-model read, verified-vs-unverified reputation, interviewer freshness,
culture vocabulary, US comp mechanics — was produced **by hand**, not forced
by the workflow. So it is inconsistent across companies.

After this change, `prep` **always** opens with a systematic **8-step
company + role research stage**. Those 8 steps *are* the 📖 sections of the
konspekt — there is no separate `company-screen.md` file. The 🗣️ speech
sections (positioning, two-column 🇷🇺/🇬🇧 anchors, concerns, questions,
cheat-sheet) stay exactly as they are and now read from a much stronger
research base.

Concretely, when the user runs `prep [company]`:

- The konspekt's front-matter is the 8-step screen (business model → role from
  primary source → people → fit-map → risks/landmines → reputation
  verified/unverified → culture vocab → comp mechanics).
- Each research claim is tagged verified vs unverified, and unverified numbers
  (competitor marketing, forum figures) are explicitly marked "don't state".
- Anti-requirements (JD disqualifiers) are extracted, not just requirements —
  so a story that would trip a disqualifier is flagged as a **landmine**.
- All 8 steps always run at full depth, even for a 15-min coffee chat — the
  research is what tells the candidate whether the call is worth taking. Only
  the 🗣️ speech sections downstream scale to the round.
- The file stays **living**: re-running `prep` for a later round with the same
  company updates the same konspekt, and debriefs append (the Virto pattern).

Nothing about the command surface changes: no new command, no new flag, no new
file path. `research` (lightweight target-list triage) is untouched.

## 2. Why now

Interview screens are increasingly recorded and transcribed (Metaview on the
LawnStarter screen; Capital One's Power Day panels). The notes go to the
hiring team verbatim. Demonstrated understanding of the business — *why this
role is the lever for their economics* — scores points that a generic "I'm a
growth PM" answer does not. The candidate's cold applications now go out via
an external auto-apply bot and job-pipeline `analyze` already handles the
early go/no-go. By the time `prep` runs, the decision to invest is made and an
interview is real — this is exactly where deep, systematic company research
pays for itself, and exactly where it is currently left to chance.

## 3. Design

**No new command. No new artifact.** The 8-step screen is a mandatory stage at
the front of the existing `prep` workflow, and its output is the 📖 portion of
the existing prep konspekt in `interview-coach-state/`.

This is an evolution of two things `prep.md` already has:

- `### Structured Research Step` (prep.md:291) — expanded from a short prompt
  into the 8-step protocol below.
- `#### Company Knowledge Sourcing (Critical)` (prep.md:301) — the Tier 1/2/3
  (verified / general / unknown) discipline, reused and made load-bearing for
  every research claim.

The konspekt Output Schema (prep.md:470+) is re-sectioned so its 📖
front-matter carries all 8 steps; the 🗣️ sections are unchanged.

## 4. Best-of synthesis (source of the 8 steps)

The 8 steps are the union of what worked across three real screens. Each step
adopts the strongest treatment observed:

| Step | Best source | What the step adopts |
|---|---|---|
| 1. Pull JD from source | LawnStarter | Primary JD via ATS API (e.g. Workable `apply.workable.com/api/v2/...`), never a paraphrase; reconcile against the candidate's copy; **canon = candidate's copy**; record divergences (salary band) explicitly. + Capital One: stack context that reframes the role (Discover acquisition). |
| 2. Requirements + **anti**-requirements | LawnStarter | Extract disqualifiers, not only requirements. On LawnStarter this removed a phantom gap (Python/ML explicitly *not* required) and flagged one story (S011, single-product pricing) as a **landmine**. |
| 3. Business model | Virto + Capital One + LawnStarter | Product, customer, and **how they make money** (not "what they do"); why this role is the lever for their economics; plain-words framing + honest "why this genuinely interests you" hooks (Virto); "how to read it" (capital-efficient → margin, not growth-at-any-cost). |
| 4. Reputation recheck | LawnStarter | verified (Trustpilot/BBB) vs unverified (competitor GreenPal's take-rate claims) kept **separate**; competitors filtered out of sources; confirm negatives are about *this* company, not dragged from an adjacent file. |
| 5. People | Virto + LawnStarter + Capital One | Recruiter + hiring manager; incremental HM dossier built across sessions with a full career map → fit/gap (Virto); interviewer's product philosophy becomes the scoring rubric + **freshness check** on stale press releases (LawnStarter); calibrate the interviewer's *actual* power/scope (Capital One). Find the personal-resonance hook. |
| 6. Fit map | LawnStarter + Capital One | Every JD requirement → a specific storybank story; **landmines marked explicitly** (stories not to lead with, given the anti-requirements). |
| 7. Culture layer | LawnStarter (§7b) | Pull their exact lexicon (careers video, values, JD) → mirror the tone **without quoting verbatim**; tie each marker to a candidate story. |
| 8. Comp / benefits | LawnStarter (§6) | US comp mechanics for the candidate: base net-of-tax, equity in a private company, PTO, 401k, healthcare; what is **missing** from the posting → ask. Hooks into the existing `salary` command. |
| Cross-cutting | Capital One (§8) | Sensitive topics (e.g. the Honey affiliate scandal): hold in reserve, **surface only if the interviewer raises it**, note risk symmetry, never lead with it. |

## 5. The 8 steps formalized (input → output)

Each step names its input, its output into the konspekt, and its sourcing rule.

1. **Pull JD from source.** In: JD URL / ATS id / candidate's pasted copy.
   Out: canonical JD text in the konspekt role section. Rule: primary source
   only; if JS-rendered, hit the ATS API; reconcile with the candidate's copy;
   canon = candidate's copy; list divergences.
2. **Requirements + anti-requirements.** In: canonical JD. Out: requirement
   list + explicit disqualifier list. Rule: a disqualifier that matches a
   candidate story marks that story as a landmine (feeds step 6).
3. **Business model.** In: company site, filings, press. Out: product /
   customer / revenue mechanic / why-this-role-is-the-lever + honest interest
   hooks. Rule: "how they earn", not "what they do".
4. **Reputation recheck.** In: Trustpilot / BBB / Glassdoor / forums. Out:
   verified table + unverified list marked "don't state". Rule: separate
   competitors from sources; confirm negatives are about this company.
5. **People.** In: LinkedIn / TheOrg / interviews / press. Out: recruiter +
   hiring-manager dossier, freshness-checked, with a resonance hook. Rule:
   press releases can be stale — verify current seat; mark hypotheses as
   hypotheses.
6. **Fit map.** In: requirements (step 2) + storybank. Out: requirement →
   story table with landmines marked. Rule: every claim points to a real story.
7. **Culture layer.** In: careers video / values / JD language. Out: their
   lexicon + tie-in to candidate stories. Rule: mirror, never quote verbatim.
8. **Comp / benefits.** In: JD comp + market. Out: US-comp mechanics read +
   what-to-ask list. Rule: net-to-net; equity liquidity realism; flag omissions.

**No depth scaling — all 8 steps always run.** Even for a 15-minute coffee
chat, the full screen runs, because the research itself is what tells the
candidate whether the call is worth taking at all. There is no compressed
tier: a short round gets the same 8-step research front-matter as an onsite;
only the 🗣️ speech sections downstream scale to the round's length and format.
This deliberately diverges from the tiered Research Depth Levels in
`research.md` — `research` is triage, `prep` is commitment.

## 6. How the konspekt schema changes

The current Output Schema 📖 1–4 expand into the 8-step research front-matter;
🗣️ 5–8 and the cheat-sheet are unchanged. Proposed section map (final
numbering to confirm at review):

| New 📖 section | Carries step | Was |
|---|---|---|
| 📖 A. Company in 60 seconds | 3 (business model) | new depth on old §1 |
| 📖 B. Role from the primary source | 1 + 2 (JD + anti-reqs) | new |
| 📖 C. People | 5 | old §2 (interviewer), deepened |
| 📖 D. Fit map | 6 | old §4 (assess/gaps), restructured |
| ⚠️ E. Risks & landmines | 2 (landmines) + honest gaps + what is NOT a gap | new |
| 📖 F. Reputation + unverified | 4 | new |
| 📖 G. Culture vocabulary | 7 | new |
| 📖 H. Comp / benefits | 8 | ties to `salary` |
| 🗣️ 5–8, 📖 9, 🗣️ 10 | — | unchanged (positioning, anchors, concerns, questions, plan, cheat-sheet) |

The 🗣️ anchor tables keep konspekt rule 1c/1d verbatim: spoken lines are the
`| 🇷🇺 Говоришь так | 🇬🇧 English |` two-column table, full text both sides.

## 7. Files touched

- `skills/interview-coach/SKILL.md` — `### prep` entry + State Update Triggers
  note that prep now writes the 8-step screen; Command Registry line unchanged.
- `skills/interview-coach/references/commands/prep.md` — expand
  `### Structured Research Step`, make `#### Company Knowledge Sourcing` the
  per-claim gate, re-section the Output Schema per §6, add depth-scaling note.
- `skills/interview-coach/SKILL.test.js` — smoke assertions (see §9).
- `skills/interview-coach/VERSIONS.md` — one-line entry on ship.

No engine files. No `profiles/` writes from code (the konspekt is authored by
the coach at runtime, as today).

## 8. Boundaries with adjacent tools

- **`research`** (interview-coach) — stays lightweight: target-list triage,
  "should I even look". Not touched.
- **`decode`** (interview-coach) — restricted by constraints.md rule 4:
  single-vacancy structural breakdown only, no batch, no fit verdict that
  contradicts Notion. The prep screen's step-1 primary-JD pull is a
  single-vacancy read for an interview already in hand — within rule 4.
- **job-pipeline `analyze`** — the earlier gate: post-response Go/Pass/
  Conditional, "should I invest at all", chat-only, no writes. The prep screen
  is downstream: the decision to invest is already made; this prepares the
  interview. No overlap in purpose.
- **constraints.md** — JD triage / dedup / fit scoring stay in the Notion
  pipeline; this RFC adds no batch behaviour and no fit verdict surface.

## 9. Testing

Smoke test in `SKILL.test.js` (Node built-in runner, no framework), asserting
the doc contract so drift is caught at review:

- `prep.md` documents an 8-step research stage (the eight step names present).
- `prep.md` still marks Company Knowledge Sourcing as verified/unverified
  (Tier 1/2/3) and requires anti-requirement extraction.
- The Output Schema still contains the 🗣️ two-column konspekt table (rule 1c)
  and the 📖 research front-matter.
- No separate `company-screen.md` path is introduced (guard against the
  reverted design): the dossier lives in the konspekt.

## 10. Non-goals

- No new command, flag, or file artifact.
- No batch company research or target-list scoring (that is `research`).
- No fit verdict that competes with the Notion pipeline (constraints rule 4).
- No change to the 🗣️ speech sections, anchor-table format, or rule 1c/1d.
- No engine or `profiles/`-code changes.

## 11. Resolved decisions (approved 2026-07-23)

1. **Section placement:** the 8-step company research is one of the **first**
   konspekt sections, before the 🗣️ Q&A. The §6 map (📖 A–H ahead of 🗣️ 5+)
   stands.
2. **No depth scaling:** all 8 steps always run at full depth, including for a
   15-minute coffee chat — the research is what tells the candidate whether the
   call is worth taking. Only the 🗣️ speech sections scale to the round.
