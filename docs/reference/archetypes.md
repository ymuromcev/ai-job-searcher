# Resume archetypes — what they are and how to author one

Archetypes are the **cheap, honest tailoring layer for LOW-fit roles**. Each is a
pre-built resume cut (`versions[<key>]` in `profiles/<id>/resume_versions.json`)
aimed at one vacancy cluster. For **Strong** fits the pipeline tailors a resume
from scratch (`skills/job-pipeline` Step 6.5); archetypes are what **Weak / Medium**
rows get (Step 7 picks the closest existing key). So an archetype's only job is:
**sell the candidate to its cluster as hard as the truth allows.**

This doc is the single source of the archetype model. Read it before authoring a
new profile's archetypes, before editing `resume_versions.json` by hand, or before
extending the onboarding flow.

## The model (apply to every archetype)

1. **Archetype ≠ identity.** The candidate's *master* profile carries one anchored
   identity (for `jared`: Senior IC PM, transactional-e-commerce / conversion head;
   AI is HOW, not WHAT). An archetype is the **opposite** move: it leans into what
   its cluster hires for, **not** into the master's head noun. Do not "fix"
   archetypes to match the master's anchor — that confusion is exactly what this
   doc exists to prevent.

2. **Lean into the cluster.** Lead `title` / `summary` with whatever that cluster
   hires for. A fintech cluster leads fintech; an AI-product cluster leads AI; an
   analytics cluster leads analytics. The order/headline is the cluster's, not the
   master's.

3. **WHAT may differ from the master — when the proof is real.** The master's
   "AI = HOW, never WHAT" rule governs the **master only**. An archetype may put AI
   / fintech / analytics in the WHAT (headline) position **when the candidate has a
   real achievement behind it** — e.g. jared's AI archetype leads AI because AI Job
   Searcher, custom MCP servers, and AI pre-scoring are real shipped work, not a
   reframe.

4. **Honest hook is the gate.** Create or keep an archetype only when there is at
   least a partial **real** hook to that cluster. No real proof → do not invent one;
   drop the archetype. A *thin* honest transfer ("regulated funnels" → healthcare,
   "money movement + KYC" → crypto) is allowed as an opportunistic bridge **if the
   candidate opts in** — keeping it is the candidate's call, never the tool's.

5. **Bullets come from real achievements, never fabricated to fit the cluster.**
   Reframe real outcomes toward the cluster's language; do not author new
   accomplishments. The achievement source of truth is the storybank
   (`interview-coach-state/coaching_state.md` → `## Storybank`); fit scoring reads
   the same bank (`engine/core/fit_digest.js`), so an invented archetype bullet
   would diverge from what fit can defend.

6. **Mirror the cluster's own titles.** Use the title the postings use, even when it
   is not the master's preferred label — e.g. CalCareer state-government roles are
   literally classified "IT Delivery Manager", so the govtech archetype keeps that.
   This is correct cluster-mirroring, not a downgrade.

7. **No inflation.** Never bump seniority or scope past the truth. Senior stays
   Senior (not Staff) unless the candidate actually held the higher level.

## Where the model is applied

- **`skills/onboard-profile` (Block 3)** — authors a profile's first archetypes from
  intake. The authoring agent applies this model when writing each cut's
  title / summary / bullets.
- **`scripts/stage18/generators/resume_versions.js`** — mechanically maps the
  authored intake into `resume_versions.json`. It does **not** decide positioning;
  positioning is the author's job under this model.
- **`skills/job-pipeline` (Step 7)** — picks the closest **existing** archetype key
  for a Weak / Medium row; it never invents a key and never rewrites positioning.
- **Manual edits** to `resume_versions.json` must follow this model too.

## See also

- [RFC 060](../../rfc/060-master-profile-realign.md) — master / archetype split:
  the anchor governs the master; archetypes lean to the cluster.
- [`engine/core/fit_digest.js`](../../engine/core/fit_digest.js) — fit scores a
  vacancy against the same real achievements an archetype must draw from.
