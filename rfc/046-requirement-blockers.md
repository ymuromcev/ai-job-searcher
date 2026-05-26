---
id: RFC-046
title: requirement_blockers — regex-based JD requirement filter, profile-local extension to filter_rules
status: draft
author: Claude (via Jared)
tier: M
created: 2026-05-25
refs:
  - RFC-039
  - RFC-040
  - feedback_pipeline_fit_score_arch
  - BL-B
---

# RFC 046 — `requirement_blockers` (regex-based pre-SKILL filter)

## 1. Problem

The last prepare batch surfaced two Perplexity rows that should never
have reached the SKILL:

- **Perplexity FDE, Applied AI** — JD says
  *"Strong programming ability in Python"*. Jared has no Python.
  Engine forwarded the row; SKILL escalated as
  `uncertain_about_fact: required_python_skill`. Tokens burned, row
  still landed in operator's inbox as ambiguous.
- **Perplexity AI Policy MTS** — JD says
  *"JD or PhD required"*. Jared has a B.A. Same outcome — SKILL
  escalation, operator triage.

Both rows match the exact pattern the
`feedback_pipeline_fit_score_arch` memory rule was written to prevent:
*"Hard blockers кодируем ДО SKILL eval, никогда как fit_score=Weak"*.
They escaped because RFC 039's existing `hard_blockers` module covers
only three narrow shapes:

| `hard_blockers` category | Catches | Misses (these rows) |
| ------------------------ | ------- | ------------------- |
| `required_skills_excluded` | Skill keyword + ±3-line co-occurrence with `\b<n>\+? years\b` qualifier | "Strong programming in X" with no years number — RFC 039's `STRONG_RE` does cover `strong` as qualifier, but the **skill is not on the profile's `required_skills_excluded` list** for this candidate (Jared has no exclusion for Python configured today). |
| `years_required_max` | `\b\d{1,2}\+? years?\b` exceeding a global cap | "JD or PhD required" (degree, not years). |
| `cert_blockers` | Word-boundary deny list (`RN`, `CPC`, …) | "JD or PhD" (degree, not cert); "Java/Go/Rust" (language, not cert). |

There are two ways forward:

1. **Force-fit every new case into existing categories** — invent a
   `degree_blockers` field for PhD, add Python to `required_skills_excluded`,
   add Java/Go/Rust as separate skill entries each with their own
   `patterns` array, hope the ±3-line co-occurrence rule fires on
   prose that says *"Strong programming in"* without a years number.
2. **Add one general regex-pattern filter that the operator owns
   directly** — `requirement_blockers.patterns[]`, each entry a regex
   string with a `reason` label. Profile-local, surgical, no schema
   inflation per new shape.

Per the user constraint *"не плодить новые фильтры"*, this RFC takes
option 2: extend the existing `filter_rules.json` with one new top-
level section, run it in the same wiring slot as `hard_blockers`,
emit a parallel `requirement_blocker:*` skip-reason family.

## 2. Decision

Add `requirement_blockers` as a peer of `hard_blockers` inside
`profiles/<id>/filter_rules.json`. One module, one wiring point, one
new skip-reason family.

```jsonc
{
  // existing keys: company_blocklist, title_blocklist, hard_blockers, geo, …

  "requirement_blockers": {
    "patterns": [
      {
        "pattern": "\\b(JD|PhD|Master'?s)\\b[^.]{0,80}\\b(required|or higher|or above)\\b",
        "reason": "advanced-degree-required"
      },
      {
        "pattern": "\\bstrong\\s+(programming|coding)\\s+(ability|skills?|experience)\\s+(in|with)\\s+Python\\b",
        "reason": "python-strong-required"
      },
      {
        "pattern": "\\bproficien(t|cy)\\s+(in|with)\\s+(Java|Go(lang)?|Rust|C\\+\\+)\\b",
        "reason": "backend-language-required"
      },
      {
        "pattern": "\\b5\\+?\\s*years?\\b[^.]{0,40}\\b(SWE|SDE|software\\s+engineer)\\b",
        "reason": "swe-experience-required"
      }
    ]
  }
}
```

A row that matches at least one pattern is removed from the alive set
**before SKILL eval**, archived per RFC 035 with
`skip_reason="requirement_blocker:<reason>"`, never written to Notion.
Multi-match rows surface the first matched reason in `skipped[].reason`
and the full list in `skipped[].reasons[]` (same shape as
`hard_blocker:*` per RFC 039 §7.5).

The shape mirrors RFC 039's `hard_blockers` deliberately. The two
modules occupy adjacent slots in the pipeline; an operator reading
`prepare_context.stats.skipReasons` sees `hard_blocker:*` and
`requirement_blocker:*` side by side and can keep them mentally
distinct: `hard_blocker:*` is the structured per-skill / per-cert /
per-years matcher (RFC 039's three categories), `requirement_blocker:*`
is the operator-owned regex escape hatch for everything else.

### 2.1 Why not extend `hard_blockers`?

Tempting, rejected for three reasons:

1. **Naming carries semantics.** RFC 039's `hard_blockers` schema is
   a typed object (`required_skills_excluded[]`, `years_required_max`,
   `cert_blockers[]`). Adding a fourth bag of free-form regexes inside
   would force `findHardBlockers` to grow a fourth branch with
   different output shape, and the wildcard reason
   `hard_blocker:requirement:<reason>` reads as a category mismatch.
2. **Schema migration risk.** RFC 039's
   `hard_blockers.required_skills_excluded` entries have their own
   `min_years` co-occurrence rule. A fourth category that does NOT
   want that rule (the operator's regex is already specific enough)
   either inherits it accidentally or needs a per-entry "skip
   co-occurrence" flag — both are uglier than a new sibling key.
3. **Reason-family separation lets us evolve them independently.**
   We will likely tighten or loosen `hard_blockers` over time (the
   ±3-line rule was already a 50/50 call in RFC 039 §7.4). Keeping
   `requirement_blockers` as a separate, simpler "regex hit = skip"
   contract means changes to one don't ripple into the other.

## 3. Schema

### 3.1 `filter_rules.json` addition

```jsonc
{
  "requirement_blockers": {
    "patterns": [
      {
        "pattern": "<regex string, required>",
        "flags": "<regex flags string, optional, default 'i'>",
        "reason": "<kebab-case short identifier, required>",
        "match_in": ["requirements", "full_text_excerpt"]  // optional, see below
      }
    ]
  }
}
```

Field rules:

- **`pattern`** (string, required) — JS regex source. Compiled with
  `new RegExp(pattern, flags)`. Must compile; see §6 for error
  handling.
- **`flags`** (string, optional, default `"i"`) — passed verbatim to
  `RegExp`. Default is case-insensitive because nearly every operator
  pattern wants it.
- **`reason`** (string, required) — kebab-case short label, surfaces
  in TSV `skip_reason` as `requirement_blocker:<reason>` and in
  `prepare_context.stats.skipReasons` keys. **Validated**: must match
  `/^[a-z][a-z0-9-]{1,40}$/`. Empty / non-conforming → pattern
  rejected at load with a warning; pipeline does not crash.
- **`match_in`** (string[], optional, default
  `["requirements", "full_text_excerpt"]`) — which `JDStructure`
  fields to search. Allowed values: `"requirements"`,
  `"responsibilities"`, `"full_text_excerpt"`. Order matters only for
  performance (first match short-circuits). The two defaults cover
  most operator patterns: structured requirements bullets, plus the
  raw 3K-char excerpt as fallback when the heuristic JD-extract
  missed the section heading.

Top-level `requirement_blockers` object is optional. Profiles that
do not configure it behave exactly as today (empty array → no-op,
zero added rows in `skipped[]`).

### 3.2 `ENGINE_SKIP_REASONS`

Add a second wildcard family:

```js
const REQUIREMENT_BLOCKER_PREFIX = "requirement_blocker:";

function isEngineSkipReason(reason) {
  // ... existing cases ...
  if (reason.startsWith(REQUIREMENT_BLOCKER_PREFIX)
      && reason.length > REQUIREMENT_BLOCKER_PREFIX.length) {
    return true;
  }
  return false;
}
```

Reason-format guarantee: the suffix is the `reason` label from the
matched pattern. Already validated at load (`^[a-z][a-z0-9-]{1,40}$`),
so the TSV value is always operator-readable.

### 3.3 `prepare_context.json` (no shape change)

`skipped[]` already accepts arbitrary reason strings. New rows simply
carry `reason: "requirement_blocker:<reason>"` and `reasons[]` per
existing convention. SKILL contract unchanged — skipped rows are
informational only, the SKILL never sees them as eval candidates.

## 4. Wiring layer

### 4.1 Where it fires

**Inside `applyHardBlockers` slot in `engine/commands/prepare.js`**,
not in `applyPrepareFilter`.

Reasoning: requirement_blockers need `structuredJD` (specifically
`requirements[]` and `full_text_excerpt`). `structuredJD` is produced
by `extractJDStructure(jdText)`, and `jdText` exists only after
`fetchJdsForBatch` runs — which is **after** `applyPrepareFilter`,
**after** URL-check, in the same slot as RFC 039's `applyHardBlockers`.

Cleanest path: rename `applyHardBlockers` to `applyJdBlockers`, run
both checks against the same `structuredJD` payload, return a unified
`{ aliveResults, blockerSkipped }`. The pure helper that does the
regex match lives in a new module (see §4.2); `applyJdBlockers` is
the thin glue layer that calls `findHardBlockers` and
`findRequirementBlockers` on each alive row.

Backward-compat: `applyHardBlockers` keeps its export name for one
release as a deprecation shim that re-exports `applyJdBlockers`.
Existing tests that import it continue to work.

### 4.2 New pure module `engine/core/requirement_blockers.js`

```js
/**
 * @typedef {Object} RequirementBlockerPattern
 * @property {string} pattern    Regex source.
 * @property {string} [flags]    Regex flags, default "i".
 * @property {string} reason     Kebab-case label.
 * @property {string[]} [match_in]  Default ["requirements", "full_text_excerpt"].
 */

/**
 * Compile patterns once at profile-load time. Malformed patterns are
 * dropped with a stderr warning and DO NOT throw — the pipeline keeps
 * running on the remaining patterns. Returns an array of `{ re, reason,
 * matchIn }` ready for matching.
 *
 * @param {RequirementBlockerPattern[]} rawPatterns
 * @returns {{re: RegExp, reason: string, matchIn: string[]}[]}
 */
function compilePatterns(rawPatterns) { … }

/**
 * Find requirement_blocker reason codes for a single JD against a
 * profile's compiled patterns. Pure.
 *
 * @param {object} args
 * @param {{requirements: string[], responsibilities?: string[], full_text_excerpt?: string}} args.structuredJD
 * @param {{re: RegExp, reason: string, matchIn: string[]}[]} args.patterns
 * @returns {string[]}  Reason labels (without `requirement_blocker:` prefix).
 */
function findRequirementBlockers({ structuredJD, patterns }) { … }

module.exports = { compilePatterns, findRequirementBlockers };
```

Decision: regex compilation happens **once** at the start of `runPre`
(after profile load), not per row. The compiled array is passed into
`applyJdBlockers` as a third argument. Per-row cost is O(patterns ×
fields searched).

### 4.3 Match algorithm (per row)

```text
for each pattern in compiledPatterns:
  for each field name in pattern.matchIn:
    if field === "requirements":
      text = structuredJD.requirements.join("\n")
    elif field === "responsibilities":
      text = structuredJD.responsibilities.join("\n")
    elif field === "full_text_excerpt":
      text = structuredJD.full_text_excerpt
    if pattern.re.test(text):
      codes.push(pattern.reason)
      break  // don't double-count same pattern across fields
return codes  // deduped via Set if same reason fires twice
```

Order matters only for the first-reason-wins convention in
`skipped[].reason`. We preserve declaration order from
`filter_rules.json`.

### 4.4 No JD text → no match

Same defensive rule as `applyHardBlockers`: if the row has no
fetched JD body (`jd.text` empty), the row passes through. Better to
let the SKILL judge than to false-archive on missing text.

## 5. Operator UX

### 5.1 Stats and visibility

`prepare_context.stats.skipReasons` will gain keys like:

```json
{
  "url_dead": 4,
  "hard_blocker:cert_required:RN": 1,
  "requirement_blocker:advanced-degree-required": 2,
  "requirement_blocker:python-strong-required": 1
}
```

`prepare`'s end-of-run console output already prints this map. No new
print path needed.

### 5.2 Initial pattern set for jared

The user-specified seed list (lives in `profiles/jared/filter_rules.json`,
gitignored — the user adds it post-merge per the worktree
constraint):

```jsonc
{
  "requirement_blockers": {
    "patterns": [
      {
        "pattern": "\\b(JD|PhD|Master'?s)\\b[^.]{0,80}\\b(required|or higher|or above)\\b",
        "reason": "advanced-degree-required"
      },
      {
        "pattern": "\\bstrong\\s+(programming|coding)\\s+(ability|skills?|experience)\\s+(in|with)\\s+Python\\b",
        "reason": "python-strong-required"
      },
      {
        "pattern": "\\bproficien(t|cy)\\s+(in|with)\\s+(Java|Go(lang)?|Rust|C\\+\\+)\\b",
        "reason": "backend-language-required"
      },
      {
        "pattern": "\\b5\\+?\\s*years?\\b[^.]{0,40}\\b(SWE|SDE|software\\s+engineer)\\b",
        "reason": "swe-experience-required"
      }
    ]
  }
}
```

`profiles/_example/filter_rules.json` gets the same block (with
synthetic patterns) so the schema is documented for new profiles.

### 5.3 Iteration loop

When a false-positive lands, the operator:

1. Reads `prepare_context.stats.skipReasons` to see which `reason`
   matched.
2. Reads `prepare_context.skipped[]` to find the offending row and
   inspect `reasons[]` + `url`.
3. Tightens the regex in `filter_rules.json`.
4. Re-runs `prepare --phase pre`. The row's TSV `status="Archived"`
   stays as-is (validate retro-sweep doesn't un-archive).

No code change needed for pattern iteration — it's profile-local
config. This is the value vs forcing every new pattern through a code
change.

## 6. Error handling

### 6.1 Malformed regex at load

`compilePatterns` wraps `new RegExp(pattern, flags)` in a try/catch.
On failure:

- Emit a stderr warning: `[requirement_blockers] invalid regex for
  reason='<reason>': <error message>; pattern skipped`.
- Drop the pattern from the compiled array.
- Do NOT throw. Pipeline continues with the remaining patterns.

Rationale: filter_rules is operator-edited config. A typo in one
pattern should not break the whole pipeline. The warning gives the
operator a chance to fix it; the other patterns keep working.

### 6.2 Invalid `reason` label

Validated at load (`/^[a-z][a-z0-9-]{1,40}$/`). Pattern with bad
reason → same path as malformed regex (warn + drop).

### 6.3 Invalid `match_in` value

Unknown field name → warn + drop the unknown field from the pattern's
`matchIn` array. If `matchIn` ends up empty, drop the whole pattern.

### 6.4 Tests

- Each error path has a unit test asserting `compilePatterns` returns
  the right size array and that `console.error` was called with the
  expected substring.

## 7. Tests required

### 7.1 `requirement_blockers.test.js` (new)

- `compilePatterns` happy path: 3 valid patterns → array of 3 with
  compiled `RegExp` instances.
- `compilePatterns` mixed valid/invalid: 2 valid + 1 malformed regex
  → array of 2, stderr warning emitted.
- `compilePatterns` invalid reason: bad label → dropped + warned.
- `compilePatterns` default flags: pattern with no `flags` → compiled
  with `"i"`.
- `compilePatterns` default match_in: pattern with no `match_in` →
  compiled with `["requirements", "full_text_excerpt"]`.
- `findRequirementBlockers` happy: structured JD with
  `requirements: ["JD or PhD required"]` → returns
  `["advanced-degree-required"]`.
- `findRequirementBlockers` excerpt fallback: empty `requirements[]`,
  full_text_excerpt contains pattern → still matches.
- `findRequirementBlockers` multi-pattern: JD matches two patterns →
  returns both reasons in declaration order.
- `findRequirementBlockers` no JD text: empty input → `[]`.

### 7.2 `prepare.test.js` (extended, integration)

- `applyJdBlockers` integration: batch with one row whose JD says
  "PhD required", profile has the advanced-degree pattern → row in
  `skipped[]` with `reason: "requirement_blocker:advanced-degree-required"`,
  NOT in `batch[]`, NOT pushed to SKILL.
- Row gets `status="Archived"` written to TSV per RFC 035.
- Combined hard + requirement blockers: a JD that fires BOTH (e.g.
  "RN license + PhD required") → row appears in `skipped[]` with
  first matched code in `reason` (hard_blocker fires first per
  declaration order in code), full list in `reasons[]`.
- Backward-compat: `applyHardBlockers` export still works as
  shim → existing test files importing it pass unchanged.

### 7.3 `skip_reasons.test.js` (extended)

- `isEngineSkipReason("requirement_blocker:foo")` → true.
- `isEngineSkipReason("requirement_blocker:")` → false (empty
  suffix).
- `isEngineSkipReason("requirement_blocker:UPPERCASE")` → still
  true (the validator runs at config load, not at runtime — by the
  time a reason reaches `isEngineSkipReason` it came from a
  compiled pattern, so the runtime predicate stays permissive).

### 7.4 Live-fire smoke (post-merge, manual)

- Re-run `prepare --phase pre --batch 20` on the same dataset that
  surfaced the Perplexity FDE / AI Policy rows. Assert both rows now
  appear in `prepare_context.skipped[]` with `requirement_blocker:*`
  reasons, NOT in the batch sent to SKILL.

## 8. Acceptance criteria (Definition of Done)

- [ ] `engine/core/requirement_blockers.js` exists, exports
      `compilePatterns` + `findRequirementBlockers`, pure functions.
- [ ] `engine/core/requirement_blockers.test.js` covers §7.1 cases.
- [ ] `applyHardBlockers` in `engine/commands/prepare.js` extended
      (or renamed to `applyJdBlockers`) to also call
      `findRequirementBlockers` and merge results.
- [ ] `engine/core/skip_reasons.js` exports a
      `REQUIREMENT_BLOCKER_PREFIX` and `isEngineSkipReason` accepts
      `requirement_blocker:<non-empty>`.
- [ ] `profiles/_example/filter_rules.json` documents the
      `requirement_blockers` schema with synthetic patterns.
- [ ] `prepare.test.js` integration test asserts a synthetic
      requirement_blocker row archives correctly + writes
      `status="Archived"` to TSV.
- [ ] `npm test` green.
- [ ] Live-fire smoke (§7.4) shows the two Perplexity rows
      pre-rejected on the next prepare run.
- [ ] `docs/architecture/` updated if there's a section on prepare's
      filter chain (per `feedback_doc_update_part_of_dod` memory
      rule). README mention only if `requirement_blockers` becomes
      operator-facing enough to warrant a callout — TBD at impl time.

## 9. Out of scope

- New files outside `engine/core/requirement_blockers{.js,.test.js}`
  and the `skip_reasons.js` / `prepare.js` edits. No
  `hard_blockers.json`, no new top-level filter module.
- Changes to the SKILL (`skills/job-pipeline/`). The whole point is
  that the SKILL never sees these rows.
- Global / cross-profile pattern library. Each profile owns its own
  patterns; the seed set in §5.2 is a one-time configuration for
  `jared`, not a shared default.
- Auto-generation of patterns from the candidate's resume or
  archetypes (similar to RFC 039 §7.2 — explicit only, no
  auto-inference in v1).
- LLM-assisted pattern suggestion ("you're getting 5 Python-required
  hits, want to add a pattern?"). Manual edit only.
- TSV schema change. The existing `skip_reason` column accepts the
  new strings; no migration needed.
- Backfill of historical Weak / uncertain_about_fact rows that
  should have been requirement-blocked (separate follow-up BL if the
  operator wants it; the rows already live in Notion and need manual
  triage either way).

## 10. Open questions for approve

1. **RFC location** — user constraint said
   `private/rfc/NNN-requirement-blockers.md`, but the repo has no
   `private/` directory; existing RFCs live in `rfc/`. This RFC is
   filed at `rfc/046-requirement-blockers.md` to match the repo
   convention. **Confirm `rfc/` is correct, or move to `private/rfc/`
   if there's a separate private tree the agent doesn't see?**
2. **Wiring rename: `applyHardBlockers` → `applyJdBlockers`.** The
   slot already runs after JD-fetch and already calls one
   blocker-finder; adding a second one is cleaner as a unified
   function. Keep a one-release shim export of the old name for
   tests. **Approve the rename, or keep two separate functions
   side by side?** (Recommendation: rename.)
3. **Match-in default = `["requirements", "full_text_excerpt"]`.**
   Includes the 3K-char excerpt as fallback for when
   `extractJDStructure` missed the section heading. Pro: catches more
   real blockers. Con: marginally more false positives because the
   excerpt is unstructured prose. **Approve the default, or restrict
   to `["requirements"]` only?** (Recommendation: keep both —
   Perplexity FDE / AI Policy patterns probably surface in
   requirements bullets, but a few JDs put everything in a single
   prose block and we want them caught.)
4. **Reason-label validator: `/^[a-z][a-z0-9-]{1,40}$/`.** Strict
   kebab-case, 1–40 chars. Excludes underscores. Operator-facing.
   **Approve, or relax (e.g. allow underscores)?** (Recommendation:
   kebab-case for consistency with existing engine reasons like
   `geo_metro_miss` — wait, those are snake_case. RFC 039's
   `hard_blocker:cert_required:RN` mixes families. Pick one:
   recommend kebab-case for new operator-owned labels because it
   reads better in dashboards; snake_case stays for engine-internal
   reasons like `geo_metro_miss`.)
5. **First-match vs all-match precedence between `hard_blocker:*` and
   `requirement_blocker:*` on the same row.** Recommendation: run
   `findHardBlockers` first, then `findRequirementBlockers`. If both
   fire, `reason` is the first hard-blocker code, `reasons[]` carries
   the full union. Rationale: `hard_blockers` is the more structured
   judgment (years + skill co-occurrence) and is the more meaningful
   diagnostic; `requirement_blockers` is the operator's quick
   escape hatch. **Approve precedence?**
6. **Error visibility for malformed patterns.** Recommendation:
   stderr warn at compile time, also include a one-line summary in
   `prepare_context.stats` like `requirement_blocker_pattern_errors:
   N` so it's visible in the SKILL prompt context (not actioned by
   the SKILL — just visible). **Approve adding the stats key, or
   keep error visibility stderr-only?** (Recommendation: add the
   stats key — silent config errors are the worst kind.)

## 11. Approval checklist

- [ ] User picks position on RFC location (§10.1).
- [ ] User approves schema (§3.1).
- [ ] User approves wiring location and `applyJdBlockers` rename
      (§4.1, §10.2).
- [ ] User picks position on `match_in` default (§10.3).
- [ ] User picks position on reason-label format (§10.4).
- [ ] User approves precedence between hard and requirement blockers
      (§10.5).
- [ ] User approves error-handling shape including stats key (§10.6).
- [ ] After approve: implementation per `dev-workflow` M-tier (smoke
      test + code-reviewer subagent on diff before commit).
