---
id: RFC-036
title: cl_base_matcher.js — deterministic CL base entry pick
status: proposed
author: Claude (via Jared)
tier: M
created: 2026-05-18
refs:
  - BL-90
  - RFC-022
  - RFC-034
---

# RFC 036 — cl_base_matcher.js: deterministic CL base entry pick

## 1. Problem

Cover-letter generation (SKILL.md Step 8, lines 285-326) is
template-first: the model copies P2 (core proof) and usually P3
verbatim from an entry in `profiles/<id>/cover_letter_versions.json`
and only writes P1 freshly. The base-entry choice is governed by a
prose priority list in SKILL.md §8b:

1. Same company + same role focus
2. Same company, different role
3. Same archetype (`resumeVer`), different company
4. Closest archetype

The match is pure logic (exact-equal on `companyName`, set-overlap on
title tokens, equality on `resumeVer`) but it lives in prose and the
LLM re-runs it every batch row.

### Drift surface

- Same JD on two runs can land on different `clBaseKey` — P2 verbatim
  flips between archetypes, defeating the template-first contract.
- Two `cover_letter_versions.json` shapes (template-variants for
  `lilia`, library for `jared` — SKILL.md:295-296) force the model to
  detect shape and apply different rules.
- We pay tokens to re-derive the same answer every batch row, and
  emit `clBaseKey` as a string the engine can't validate against the
  actual file.

BL-90 (audit 2026-05-18 §5): of the LLM steps in the pipeline, base
entry selection is the cheapest to lift to code — no judgement, just
lookup + ordered fallback. RFC 034 already locked the SKILL output
schema; this RFC pushes one more piece of policy down into the engine.

## 2. Decision

New pure module `engine/core/cl_base_matcher.js`:

```js
pickBaseEntry({ job, profile, resumeVer, coverLetterVersions })
// → { baseKey: string | null, shape: "template-variants" | "library" | "empty",
//     p2: string | null, p3: string | null, p4: string | null,
//     score: number, reason: string }
```

`prepare --phase pre` calls `pickBaseEntry` for every batch row and
attaches the result as `entry.clBase` in `prepare_context.json`. The
SKILL reads `entry.clBase.{p2, p3, p4}` directly and only regenerates
P1 (and P3 when the matcher flags low confidence).

## 3. Matching algorithm

### 3a. Template-variants shape (`lilia`)

Single canonical base: `defaults.{p2, p3, p4_template}`.

- `baseKey = "defaults"`, paragraphs copied from `defaults.*`.
- `score = 1`, `reason = "template-variants:defaults"`.
- The `letters` array is left untouched as tone reference for P1.

Priority rules are moot — there is only one base.

### 3b. Library shape (`jared`)

Each top-level key maps to `{ filename, paragraphs: [p1, p2, p3, p4] }`.
Iterate every entry, compute a score, pick the max. Tiebreak:
declaration order in the JSON file.

Per-entry score (sum of components):

| Component | Weight | Trigger |
|---|---|---|
| Same company (exact, case-insensitive) | **+10** | `entry.company == job.companyName` after normalization |
| Same archetype (`resumeVer` match) | **+5** | `entry.archetype == resumeVer` (optional entry field — §5) |
| Title-keyword overlap | **+3 × overlap** | tokenize entry's `role` + `job.title`, lowercase, drop stopwords, intersect |
| JD-body keyword density | **+1 × hits, cap +5** | each archetype keyword (`profile.resume_archetypes[resumeVer].keywords`) found in `job.jdText` |

Threshold for confident match: **score ≥ 8**. Below threshold, the
matcher still returns the highest scorer but adds `low_confidence` to
`reason` — that's exactly the SKILL.md:314 "regenerate P3 if focus
differs" rule, made explicit.

`reason` encodes which components fired:
`"company_exact+archetype_match+title:2"`. Easy to grep on audit.

### 3c. Empty / missing file

Cold-start: returns
`{ baseKey: null, shape: "empty", p2: null, p3: null, p4: null,
   score: 0, reason: "empty_library" }`.
SKILL falls back to writing all four paragraphs from scratch using
`cover_letter_template.md` (SKILL.md:298 path).

## 4. Integration into prepare

Wire point: `engine/commands/prepare.js` `buildBatchEntry` (lines
291-361). Order in the pre-phase pipeline:

1. URL check.
2. JD fetch.
3. Salary, geo, schedule, requirements (existing).
4. **NEW** — `pickBaseEntry({ job: entry, profile, resumeVer: null,
   coverLetterVersions })`. Result attached as `entry.clBase`.

`resumeVer` is unknown at pre-phase time (SKILL picks it in Step 7).
Pass `null`; the archetype component is skipped and only company /
title / JD-body components fire. In practice same-company + title
overlap dominate, so accuracy loss is small. Alternative (run matcher
inside SKILL via CLI helper) is more plumbing, no clear win.

Field name on the entry: **`clBase`** (camelCase, matches `clKey` /
`clBaseKey` in SKILL output).

## 5. Profile schema additions

Library entries gain three optional fields:

```json
{
  "affirm_capital": {
    "filename": "Affirm_Capital_PM.pdf",
    "paragraphs": ["P1...", "P2...", "P3...", "P4..."],
    "company": "Affirm",
    "archetype": "ConsumerLending",
    "role_keywords": ["pm", "capital", "credit"]
  }
}
```

All three optional. Matcher falls back to parsing the entry key when
fields are missing (`affirm_capital` → company `affirm`, keywords
`["affirm", "capital"]`). Lazy migration.

Optional `profile.json` override:

```json
"cl_base_matcher": {
  "weights": { "company": 10, "archetype": 5, "title": 3, "jd_body": 1 },
  "threshold": 8
}
```

Most profiles won't need this. Defaults live in the matcher module.

No additions for template-variants shape — single base, no scoring.

## 6. Backwards compatibility

- Library entries without the new fields → matcher works on key
  tokenization, scores degrade gracefully.
- Empty `cover_letter_versions.json` → `shape: "empty"`, SKILL takes
  cold-start path (unchanged).
- SKILL §8b keeps a one-paragraph fallback ("if `entry.clBase` is
  missing — engine pre-RFC 036 — use rules below") for one release.
- `clBaseKey` in `results.json` (SKILL.md:332) stays — SKILL echoes
  back what the matcher gave. Engine can now validate it against
  `coverLetterVersions` and warn on mismatch.

## 7. Tests

Unit (`engine/core/cl_base_matcher.test.js`):

- Template-variants shape returns `defaults`, score 1.
- Library shape, exact company hit → that entry wins (score ≥ 10).
- Library shape, no company hit but archetype + title overlap → wins
  by combined score.
- Library shape, no `archetype` field on entries → archetype
  component doesn't fire; matcher still picks highest by title/JD.
- Empty library → `shape: "empty"`.
- Tiebreak: ties on score → first-declared wins.
- Threshold edge: top score 7 → result includes `low_confidence`.
- Weights override from `profile.cl_base_matcher.weights` is honored.

Integration (`engine/commands/prepare.test.js`): fixture profile with
library shape → `prepare_context.json` batch entries each carry a
`clBase` object with non-null `p2`.

## 8. Migration

Single PR (M-tier):
1. Add `engine/core/cl_base_matcher.js` + tests.
2. Wire into `buildBatchEntry`; `clBase` lands on every batch entry.
3. Update `SKILL.md` §8b: "read `entry.clBase`, copy `p2`/`p3`/`p4`
   verbatim; regenerate P3 only if `clBase.reason` contains
   `low_confidence` or `role_focus_mismatch`."
4. Smoke run on `jared` (library) and `lilia` (template-variants).

Profile-side migration is opportunistic — owners add `company` /
`archetype` / `role_keywords` as they touch each entry.

## 9. Out of scope

- Generating archetypes themselves.
- ML / embedding-based matching.
- Picking `resumeVer` itself — SKILL Step 7 still owns that. May spin
  off `resume_ver_matcher` later (separate RFC).
- Bulk re-writing existing library entries with new fields.

## 10. Open questions

1. **`resumeVer` at pre-phase time** — pass `null` and skip archetype
   component (recommended) vs. run matcher inside SKILL via CLI
   helper. Recommend pass-null: simpler, marginal accuracy hit.
2. **Threshold (default 8)** — picked from §3b weight math
   (company-exact OR archetype + small title overlap). Recommend keep
   8 default, per-profile override available.
3. **`clBase` payload size** — embedding full P2/P3/P4 in every batch
   entry inflates `prepare_context.json` (~150 words per row).
   Recommend embed: SKILL avoids one more file read, engine already
   loads the file to match.
4. **Validate SKILL output `clBaseKey`** against `coverLetterVersions`
   on commit. Recommend yes — warn-only, doesn't fail the row.
