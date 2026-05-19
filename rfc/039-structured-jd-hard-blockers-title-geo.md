---
id: RFC-039
title: Structured JD extract + hard_blockers module + title-encoded geo pre-reject
status: approved
approved: 2026-05-19
author: Claude (via Jared)
tier: L
created: 2026-05-19
refs:
  - BL-89
  - RFC-034
  - RFC-013
  - feedback_pipeline_fit_score_arch
  - audit-2026-05-18-pipeline
---

# RFC 039 — Structured JD extract + hard_blockers module + title-encoded geo pre-reject

## Approval (2026-05-19)

Approved per user, all open-question recommendations accepted:

- **§7.1 JD-extract cache** — out of scope (heuristic is fast; revisit
  if perf becomes a concern).
- **§7.2 `required_skills_excluded` source** — explicit only via
  `filter_rules.hard_blockers` (no auto-inference from archetypes in
  v1).
- **§7.3 Title-geo pattern table** — code-table v1 in
  `geo_enforcer.js`; promote to `filter_rules` only if profiles
  diverge.
- **§7.4 `min_years` interpretation** — ±3-line co-occurrence rule
  (conservative; prefer false-negative over archiving a real fit).
- **§7.5 Multi-code rows in `skipped[]`** — first code in `reason`,
  full list in `reasons[]`. Stats aggregate on `reason`.

Implementation tracked under BL-89.

## 1. Problem

Audit 2026-05-18 surfaced three failure modes that share a single root
cause: **work the engine could do deterministically is currently
deferred to the SKILL.** Each one is independently painful; together
they justify one architectural pass.

### 1.1 Raw JD shipped to SKILL on every entry

`engine/commands/prepare.js` `buildBatchEntry` (line 333) attaches
`entry.jdText` — the **entire** fetched JD body — to every batch row.
A typical 30-row batch carries 60–150K tokens of JD prose into the
SKILL prompt window. SKILL Step 4 only needs requirements, role
focus, and a few structural signals to judge fit. Everything else is
context the model re-reads on every entry, every iteration, every run.

Existing `engine/core/jd_extract.js` already pulls **two** fields
(`schedule`, `requirements`) heuristically. It is the obvious place to
extend, but its current `requirements` regex is a one-liner that
returns ~500 chars — not a structural decomposition.

### 1.2 Hard blockers reach the LLM as `fit_score: Weak`

Today, "Python required, candidate has 0 years Python" is judged by
the SKILL fit prompt and lands as `Weak`. This violates the memory
rule `feedback_pipeline_fit_score_arch.md` ("encode hard blockers
**before** SKILL eval, never as `fit_score=Weak`") for two reasons:

1. After RFC 034, **all evaluated rows are pushed to Notion**,
   including Weak. A Python-required role with `Weak` therefore still
   lands in the operator's Notion view — exactly the outcome the
   memory rule was meant to prevent.
2. The SKILL spends ~3–5K tokens per row arguing with itself about a
   row that is structurally disqualified. The fit rationale ends up
   apologetic ("Strong PM fit but role requires hands-on Python coding
   the candidate doesn't have") — burning tokens to produce text the
   engine could emit as a one-line skip reason.

Hard blockers are **policy**, not advisory judgment. Policy belongs in
code (BL-89; RFC 034 §1 root-cause framing applies symmetrically).

### 1.3 Title-encoded geo flows past the geo filter

`engine/core/geo_enforcer.js` `enforceGeo` (line 334) inspects
`job.locations[]` — the array surfaced by the ATS adapter. It does
**not** read the job title. Postings whose ATS surfaces a generic
`["Remote"]` location but whose title explicitly says
`"Senior PM (UK/EU/India)"` or `"Product Manager — EMEA only"`
currently:

1. Pass `applyPrepareFilter`'s geo gate (locations look US-compatible).
2. Reach the SKILL.
3. SKILL.md prose (lines 194–195, pre-RFC-034) used to instruct
   `decision: archive`. After RFC 034 there is no `decision` field —
   so the row is **silently pushed to Notion as a Strong/Medium/Weak
   evaluated row** and the operator has to manually archive it.

Audit 2026-05-18 §5 logged ~12 such rows per prepare run for `jared`.
This is filter work, not judgment work.

### 1.4 The unifying root cause

In all three cases the engine has all the information it needs to
make a deterministic decision but delegates to the SKILL instead.
The fix is one architectural move: **extend `jd_extract` to produce a
structured summary, add `hard_blockers` as a pre-SKILL filter step,
and extend the geo pipeline to read the title.** Token spend drops
50–70%; Notion gets clean candidates only; Weak goes back to meaning
"model is genuinely uncertain about fit" instead of "candidate is
structurally disqualified".

## 2. Decision

1. **New module `engine/core/jd_extract.js` (extended)** —
   `extractJDStructure(rawJDText) → { requirements, responsibilities,
   salary_text, location_text, full_text_excerpt }`. Pure,
   heuristic-based, no LLM call. Backward-compatible with existing
   `extractFromJd` (kept as a thin wrapper).
2. **New module `engine/core/hard_blockers.js`** —
   `findHardBlockers({ structuredJD, profile }) → string[]` of reason
   codes. Called inside `applyPrepareFilter` so blocked rows hit
   `skipped[]` before the URL-check / JD-fetch budget is spent on
   them. Archived per RFC 035 (BL-91 contract).
3. **New helper `extractTitleGeo(title) → { excluded, marker }`** —
   added to `engine/core/geo_enforcer.js` (same module as
   `enforceGeo` — they share the same data and US-marker table).
   Called inside `applyPrepareFilter` immediately after the existing
   `enforceGeo` block; composes with it.
4. **`prepare_context.json` schema change** — the batch entry's
   `jdText` field is **deprecated** but still emitted for one release.
   A new `entry.jdStructure` carries the structured payload. SKILL
   reads `jdStructure` by default; falls back to `jdText` only if
   `jdStructure` is absent (older engine build).
5. **No SKILL prose changes for hard-blockers or title-geo.** Both
   reach the SKILL as `skipped[]` rows. The model never judges a row
   that the engine has already disqualified.

The shape of the new fields, the schema for `filter_rules.hard_blockers`,
and the precise wiring layer are spelled out in §3.

## 3. Implementation plan

### 3.1 Structured JD extract (`engine/core/jd_extract.js`)

**New pure function**: `extractJDStructure(rawJDText)`.

Output shape:

```ts
type JDStructure = {
  requirements: string[];       // bullet array, max 25 entries, each ≤ 200 chars
  responsibilities: string[];   // bullet array, max 25 entries, each ≤ 200 chars
  salary_text: string | null;   // raw salary line if surfaced (do not parse $ here)
  location_text: string | null; // raw location/work-format line if surfaced
  full_text_excerpt: string;    // first ~3K chars, fallback when no structure detected
};
```

**Heuristic strategy** (no LLM):

1. Normalize line endings, collapse runs of whitespace.
2. Detect section headings via case-insensitive regex against a fixed
   table of variants:
   - `requirements` matchers: `^\s*(Requirements?|Qualifications?|What you'?ll need|About you|Who you are|You have|Must[- ]haves?|Key skills|Required|Minimum qualifications)\b`
   - `responsibilities` matchers: `^\s*(Responsibilities|What you'?ll do|Role|Day[- ]to[- ]day|In this role|You will)\b`
   - `salary_text` matchers: `^\s*(Compensation|Salary|Pay range|Base pay|Total compensation)\b`, or inline `\$[\d,]+\s*[—–-]\s*\$[\d,]+` pattern anywhere in the body.
   - `location_text` matchers: `^\s*(Location|Work location|Where|Remote|Hybrid|Onsite)\b`.
3. For each detected section, collect lines until the next heading or
   a blank-line + heading-shaped line. Split on bullets (`-`, `•`,
   `*`, `–`) or sentence boundary if no bullets present. Cap each
   bullet at 200 chars; cap array at 25 entries; truncate by length
   rank (longest dropped first — they're usually run-on paragraphs,
   not real bullets).
4. Always populate `full_text_excerpt` = first 3000 chars of the
   normalized body. This is the **only** prose the SKILL sees as
   fallback when structure detection fails — it must be deterministic
   so two runs of the same job produce the same excerpt.
5. If neither `requirements` nor `responsibilities` is detected (the
   JD is one prose blob), set both arrays to `[]`. The SKILL still
   has `full_text_excerpt` to judge from — degraded but not broken.

**Backwards-compat**:

- Keep existing `extractFromJd(jdText) → { schedule, requirements }`
  as a thin wrapper around `extractJDStructure` + the existing
  `extractSchedule`. The `requirements` field returned by
  `extractFromJd` keeps its current ~500-char string shape (callers
  outside `prepare.js` continue to work).
- New callers should use `extractJDStructure` directly.

**Token budget target**: per-entry payload to SKILL drops from raw
JD prose (~3–5K tokens) to structured payload (~300–800 tokens). Over
a 30-row batch the budget moves from 60–150K → 10–25K. Concrete win
depends on the source mix.

### 3.2 `hard_blockers` module (`engine/core/hard_blockers.js`)

**New pure function**: `findHardBlockers({ structuredJD, profile, title })`.

Output: `string[]` of reason codes. Empty array = no hard blocker.
Multiple codes can fire on a single row (we report all).

**Reason codes** (initial set):

- `required_skill_excluded:<skill>` — JD requires a skill on the
  profile's `hard_blockers.required_skills_excluded` list.
- `years_required_max_exceeded:<n>` — JD requires more years than
  the profile's `hard_blockers.years_required_max` cap.
- `cert_required:<cert>` — JD requires a license/cert from the
  profile's `hard_blockers.cert_blockers` list (already used by
  `indeed-prep` for Lilia; centralize here).

**Profile config** (added to `filter_rules.json`):

```jsonc
{
  "hard_blockers": {
    "required_skills_excluded": [
      { "skill": "Python", "patterns": ["Python", "Django", "FastAPI"], "min_years": 1 },
      { "skill": "Go", "patterns": ["Golang", "\\bGo\\b"], "min_years": 1 }
    ],
    "years_required_max": 10,
    "cert_blockers": ["CMA", "RN", "LVN", "CPC", "RDA", "RDH"]
  }
}
```

Field-by-field:

- `required_skills_excluded[]` — list of skills the candidate **does
  not have**. Each entry has a canonical `skill` label, a `patterns`
  array of regex strings (case-insensitive, applied to
  `structuredJD.requirements[]` joined with newlines), and a
  `min_years` floor. Fire when **any** pattern matches AND the JD
  requirements text either says `\b<n>\+?\s*years?\b` with n ≥
  `min_years`, OR contains a "must have / required / strong" qualifier
  near the match. (Implementation detail: regex-based co-occurrence
  within ±3 lines of the skill pattern.)
- `years_required_max` — global cap. If JD requirements mention
  `\b1[5-9]\s*years\b` or `\b2[0-9]\s*years\b` and the value exceeds
  this cap, fire `years_required_max_exceeded:<n>`. Optional; omit
  to disable.
- `cert_blockers` — substring deny list applied to
  `structuredJD.requirements` joined. Mirrors `indeed-prep`'s
  existing `cert_blockers` (the Lilia browser-side filter). We
  centralize so it fires for all ATS adapters too, not just Indeed.

**Wiring layer**:

Hard blockers fire **inside `applyPrepareFilter`**, BUT they need the
JD body — which today is fetched AFTER `applyPrepareFilter` (the
"fill-up alive batch" step). Two options:

- **Option A (chosen)**: fire hard blockers inside the post-URL-check,
  pre-`buildBatchEntry` slot. The `fillUpAliveBatch` loop already
  produces `aliveResults`; we then fetch JDs (`fetchJdsByKey`),
  extract structure per row, and **filter the alive set against
  `findHardBlockers` before `buildBatchEntry` runs**. Blocked rows go
  into `skipped[]` with `reason: "hard_blocker:<code>"` (multi-code
  rows surface the **first** code in `reason` and the full list in
  `reasons[]`).
- **Option B (rejected)**: fire on title-only signal in
  `applyPrepareFilter` to avoid spending JD-fetch budget on doomed
  rows. Rejected because the title rarely encodes the blocker text;
  false-negative rate is too high. The URL-check + JD-fetch budget is
  cheap relative to the SKILL spend we save.

Implementation note: this introduces a new ordered step between
"JD-fetch" and "buildBatchEntry" in `runPre`. The step is small (one
loop over `aliveResults`, one call per row), but it changes the
control flow. Spell out in tests.

**Archival**: a row with a hard blocker is archived per RFC 035
(BL-91) — the engine writes `status="Archived"` and
`skip_reason="hard_blocker:<code>"` to the TSV during the pre-phase,
so re-running prepare doesn't re-evaluate it. The row never reaches
Notion.

**The memory-rule guarantee**: a row that returns a non-empty array
from `findHardBlockers` NEVER reaches the SKILL, NEVER gets a
`fit_score`, and NEVER lands in Notion. This is the architectural
enforcement of `feedback_pipeline_fit_score_arch.md`.

### 3.3 Title-encoded geo pre-reject (`engine/core/geo_enforcer.js`)

**New pure function**: `extractTitleGeo(title) → { excluded, marker }`.

Output: `{ excluded: boolean, marker: string | null }`. `marker` is
the matched phrase (for debugging / skip reason).

**Pattern table** (initial; data-driven where reasonable):

```js
const TITLE_GEO_PATTERNS = [
  // Parenthetical region tags
  { re: /\((UK|EU|EMEA|APAC|LATAM|MEA|India|Germany|France|Netherlands|UK\/EU|UK\/EU\/India|EMEA only|APAC only)\)/i, marker: "$1" },
  // Inline phrases
  { re: /\b(EMEA only|APAC only|Europe only|India only|UK only|EU only|LATAM only)\b/i, marker: "$1" },
  // "Remote - <region>" patterns
  { re: /\bRemote\s*[—–-]\s*(EMEA|APAC|LATAM|Europe|UK|EU|India)\b/i, marker: "Remote - $1" },
];
```

**Composition with `enforceGeo`** (the existing locations-based
check):

1. Compute `titleGeo = extractTitleGeo(app.title)`.
2. Compute `inclusive = titleMentionsCandidateGeo(app.title, profileGeo)`
   — does the title mention `US`, `USA`, `United States`, or any
   `accept_countries[]` value, or any US state code? Mirror BL-24's
   rule: **a US marker (or candidate's accept-list country) anywhere
   in the title wins**. `"Senior PM (US/UK/Canada)"` for a `us-only`
   candidate passes; `"Senior PM (UK/EU only)"` for the same candidate
   does not.
3. Decision:
   - If `inclusive` is true → pass (regardless of `titleGeo.excluded`).
   - Else if `titleGeo.excluded` is true → reject with
     `skip_reason: "geo_title_excluded"` and `marker: titleGeo.marker`.
   - Else → pass (no title signal either way; `enforceGeo` on
     `locations[]` decides).
4. Title-geo result is checked **before** `enforceGeo`. A title that
   says `EMEA only` overrides a `locations: ["Remote"]` value —
   "title wins" for negative signal, mirroring the audit observation.

Wiring: extend `applyPrepareFilter` to call `extractTitleGeo` in the
same block that today calls `enforceGeo`. Add `geo_title_excluded` to
the `skipped[]` reasons and to `ENGINE_SKIP_REASONS` in
`engine/core/skip_reasons.js`. Archival behavior identical to other
geo skips (RFC 035 / BL-91).

**Edge cases**:

- `"Senior PM, AI Platform (Remote — US/UK/Canada)"` for `us-only`
  candidate → `inclusive` matches `US` → pass.
- `"Product Manager — APAC"` for `us-only` → `inclusive` false,
  `excluded` true → reject `geo_title_excluded:APAC`.
- `"Backend Engineer (UK/EU/India)"` for `us-only` → `excluded` true,
  `inclusive` false → reject.
- `"Lead PM (Hybrid SF)"` — neither matches → fall through to
  `enforceGeo` on locations.
- Title `"Lead PM"` with `locations: ["London, UK", "Remote"]` → title
  silent, `enforceGeo` rejects on `us-only`. No change here.

### 3.4 Schema changes summary

- `engine/core/skip_reasons.js` `ENGINE_SKIP_REASONS`: add
  `"hard_blocker:*"` (wildcard family) and `"geo_title_excluded"`.
- `prepare_context.json`:
  - `batch[].jdStructure` — new field, the `JDStructure` shape.
  - `batch[].jdText` — deprecated but still emitted one release.
    Drop in RFC-039+1 follow-up.
  - `skipped[].reason` — new values per above.
- `filter_rules.json`: new optional top-level `hard_blockers` object
  per §3.2 schema.
- `profiles/_example/filter_rules.json`: add a synthetic
  `hard_blockers` example (no real skills, just shape demo).
- `applications.tsv` (TSV schema v5): `skip_reason` column already
  exists; new values `hard_blocker:<code>` and `geo_title_excluded`
  are valid strings — no column change. The TSV README gets a row
  added.
- `SKILL.md`: update Step 2 to mention `jdStructure` (preferred read
  path) with `jdText` as fallback. No other SKILL changes — hard
  blockers and title-geo are invisible to the SKILL by design.

## 4. Tests required

### 4.1 `jd_extract.test.js` (extended)

- `extractJDStructure` happy path: well-structured JD with both
  `Requirements` and `What you'll do` sections → both arrays
  populated, full_text_excerpt set.
- Heading variants: each entry in the matcher tables (`Qualifications`,
  `About you`, `Day-to-day`, etc.) fires.
- Bullet-style detection: `-`, `•`, `*`, `–` all parse.
- No-structure fallback: pure prose JD → both arrays empty,
  excerpt populated.
- Bullet cap: ≥ 25 bullets in source → output capped at 25, longest
  dropped first.
- Length cap: 500-char bullet → truncated to 200 chars.
- Salary/location inline detection: `"$140,000–$190,000"` anywhere
  in body → `salary_text` set even without `Compensation` heading.
- Empty/null input → `requirements: [], responsibilities: [],
  salary_text: null, location_text: null, full_text_excerpt: ""`.
- Back-compat: `extractFromJd(jdText)` still returns the
  `{ schedule, requirements }` shape; existing callers (Lilia
  prepare flow) unchanged.

### 4.2 `hard_blockers.test.js` (new)

- `required_skill_excluded`: JD says `"5+ years Python required"`,
  profile excludes `Python` with `min_years: 1` → fire
  `required_skill_excluded:Python`.
- `min_years` floor: JD says `"Familiarity with Python a plus"`
  (no `\b\d+\+? years\b` near match) → do NOT fire (it's a "nice to
  have", not required).
- Pattern alternates: `Django` in requirements with Python in
  patterns → fire (the `Python` skill bucket also catches
  framework mentions).
- `years_required_max`: JD requires `"20 years experience"`, cap=10
  → fire `years_required_max_exceeded:20`.
- `cert_blockers`: JD requires `"RN license"`, profile blocks `"RN"`
  → fire `cert_required:RN`.
- Multi-code: JD requires both Python and 15 years → return both
  codes.
- Profile with no `hard_blockers` block → always returns `[]`.
- Pure regex isolation: each test passes a fake `structuredJD`
  literal — no JD parsing in this suite.

### 4.3 `geo_enforcer.test.js` (extended)

- `extractTitleGeo`: each pattern in `TITLE_GEO_PATTERNS` fires
  (`(UK)`, `(EU)`, `(India)`, `EMEA only`, `Remote - APAC`, etc.).
- `extractTitleGeo` on plain title (`"Lead Product Manager"`) → not
  excluded.
- Inclusive marker wins: `"Senior PM (US/UK/Canada)"` with `us-only`
  profile → `extractTitleGeo` reports excluded, but the composed
  decision in `applyPrepareFilter` returns pass because the title
  also mentions `US`.
- Multi-region exclusive: `"Senior PM (UK/EU/India)"` with `us-only`
  → reject `geo_title_excluded:UK`.
- Composition with locations: title silent, `locations: ["London, UK"]`
  → reject on `enforceGeo`, NOT on title.
- Title says `APAC`, locations say `Remote` → title wins, reject
  `geo_title_excluded:APAC`.

### 4.4 `prepare.test.js` (integration, extended)

- Hard-blocker integration: fake batch with one Python-required row
  for a profile excluding Python → row appears in `skipped[]` with
  `reason: "hard_blocker:required_skill_excluded:Python"`, NOT in
  `batch[]`, NOT pushed to SKILL.
- Title-geo integration: fake batch with `"Lead PM (EMEA only)"`
  for `us-only` profile → row in `skipped[]` with
  `reason: "geo_title_excluded"`. No JD fetch attempted (title-geo
  fires inside `applyPrepareFilter`, before JD-fetch).
- `jdStructure` emitted on every batch row that has a JD body; absent
  on rows where JD fetch returned no text.
- `jdText` still emitted for one release (back-compat); covered by
  existing integration test, no new assertion needed.
- Hard-blocker rows get `status="Archived"` written to TSV per
  RFC 035.
- Title-geo rows get `status="Archived"` written to TSV per RFC 035.

### 4.5 SKILL contract test

- Assert SKILL.md mentions `jdStructure` in Step 2.
- Assert SKILL.md still tolerates a missing `jdStructure` (legacy
  engine build) — prose must say "fall back to `jdText`".

## 5. Migration

Single PR, no data migration. The new fields are additive:

- Engines on the new build emit `jdStructure` AND `jdText`. SKILLs on
  the new build read `jdStructure`; SKILLs on the old build read
  `jdText` (unchanged).
- Engines on the new build apply hard blockers + title-geo. Rows
  that previously made it to Notion as Weak (Python case) will now
  be archived pre-SKILL. **This is a user-visible behavior change**
  — the operator should expect fewer rows per prepare run, with
  `prepare_context.stats.skipReasons` carrying the new
  `hard_blocker:*` and `geo_title_excluded` counts.
- Existing TSV rows with `fit_score=Weak` from the Python case are
  NOT retroactively re-evaluated. They stay in their current state
  (already in Notion, operator triages manually). Backfill is out of
  scope for this RFC — track as a follow-up BL if the count is high.

One release later, drop `jdText` from `prepare_context.json` and
update SKILL.md accordingly (follow-up BL).

## 6. Out of scope

- Backfilling phantom `Weak` rows that should have been hard-blocked
  (separate follow-up BL).
- Pre-fetch optimization: skipping JD-fetch for rows that hard-block
  on title alone (we chose Option A in §3.2 — JD-fetch is cheap).
- LLM-based JD structure extraction (`jd_extract` stays heuristic;
  if heuristics miss too many JDs, that's a separate RFC).
- Unified `evaluateJob` shape (BL-92, separate RFC).
- Re-evaluating archived rows on demand (`prepare --re-evaluate`).

## 7. Open questions for approve

1. **JD extract cache** — should `extractJDStructure` write results
   back to TSV or a side-file (`profiles/<id>/jd_extract_cache/<key>.json`)
   to amortize cost across runs? Heuristic extract is fast (regex
   only), so the win is small per-run, but the file becomes a useful
   debug artifact. **Recommendation: out of scope for this RFC.** If
   we add caching later, the cache key is `jobs.tsv` `(source, jobId)`
   and the cache is invalidated when `jd_cache.js` re-fetches the JD.
2. **`hard_blockers.required_skills_excluded` source** — load
   automatically from `profile.json.resume_versions` archetypes
   (treat any skill NOT in any archetype as a candidate excluded
   skill), or only from explicit `filter_rules.hard_blockers`?
   **Recommendation: explicit only (v1).** Auto-inference is too
   easy to get wrong (the candidate may have unwritten skills,
   archetypes may be incomplete). Future auto-inference is a
   follow-up.
3. **Title-geo data-driven patterns** — keep `TITLE_GEO_PATTERNS` as
   a small JS regex table in `geo_enforcer.js`, or move into
   `filter_rules.json` as `geo.title_blocklist_patterns`?
   **Recommendation: code-table v1.** The set is small and largely
   universal (UK/EU/EMEA/APAC/India). If profiles diverge (e.g. a
   future EU-based candidate who DOES accept UK roles), promote to
   data-driven then.
4. **`min_years` interpretation** — when JD says `"5+ years
   experience"` without specifying which skill, should that count
   against ALL `required_skills_excluded` entries, or only the one
   whose pattern is nearest in the requirements text?
   **Recommendation: ±3-line co-occurrence rule (§3.2).** Conservative.
   False-negative > false-positive — better to let a row through to
   SKILL than to archive a real fit.
5. **Multi-code rows in `skipped[]`** — emit `reason` as the first
   matched code and `reasons[]` as the full list, or emit a
   delimited string like `"hard_blocker:cert_required:RN,required_skill_excluded:Python"`?
   **Recommendation: first code in `reason`, full array in
   `reasons[]`.** Stats aggregation keys off `reason`; full list is
   diagnostic only.

## 8. Approval checklist

- [ ] User approves the unified architecture (§2).
- [ ] User approves the `filter_rules.hard_blockers` schema (§3.2).
- [ ] User picks position on open question 1 (JD cache — recommend
      out of scope).
- [ ] User picks position on open question 2 (skill-list source —
      recommend explicit only).
- [ ] User picks position on open question 3 (title-geo data shape —
      recommend code-table v1).
- [ ] User picks position on open question 4 (`min_years`
      interpretation — recommend ±3-line co-occurrence).
- [ ] User picks position on open question 5 (multi-code shape —
      recommend `reason` + `reasons[]`).
- [ ] BL-89 flipped `status: in_progress → in_progress` (already
      there); RFC linked from the ticket.
- [ ] After approve: implementation PR with `/security-review` (L
      tier) + multi-agent code review per `dev-workflow`.
