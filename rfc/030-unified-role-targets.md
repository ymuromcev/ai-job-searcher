---
id: RFC-030
title: Unified role-targets — single source of truth for scan filter and LLM fit score
status: accepted
author: Claude (via Jared)
tier: M
created: 2026-05-13
decided: 2026-05-13
refs:
  - BL-56
  - BL-37
  - BL-51
---

# RFC 030 — Unified role-targets

## 1. Problem

"Which role-tracks does this profile accept?" is currently encoded in
**three** independent places with three different semantics. They drift,
and the LLM phase already paid the price.

| Source | Shape | Reader | Purpose |
|---|---|---|---|
| `profiles/<id>/filter_rules.json` → `title_requirelist.patterns[]` | regex strings + `reason` | `engine/core/filter.js` (scan) | Mechanical gate: archive if no title match |
| `profiles/<id>/profile.json` → `target_roles[]` | human-readable role names | LLM (via memory bundle) | Narrative cue in prompt |
| `profiles/<id>/memory/user_resume_key_points.md` → "Bridge-mode booster" line | freeform prose | LLM (via memory bundle) | Soft instruction to LLM |
| `skills/job-pipeline/SKILL.md` → "Fit Score (domain fit only)" §755-764 | prose | LLM (skill body) | Defines Strong/Medium/Weak — **does not say role-track is non-factor** |

### Concrete failure (2026-05-12)

`prepare_results_20260512_182159.json`: 22 of 52 results were `decision=skip`,
17 of which were PM-adjacent (FDE / Solutions Engineer / TPM / Product
Ops / BizOps) — exactly the tracks BL-37 added under bridge-mode. Each
was rejected with rationale variants of "not PM track". Mechanical
filter passed them through (PM-adjacent patterns are in
`title_requirelist`). LLM rejected them anyway.

Root cause: the LLM weighed its general prior "this profile is PM" more
heavily than (a) the narrative `target_roles` list, (b) the
"Bridge-mode booster" prose buried in `user_resume_key_points.md`, and
(c) the absent explicit guidance in SKILL.md that role-track must not
factor into Fit Score.

### Why a quick-fix is wrong

Initial instinct was to add `acceptable_role_tracks` to
`filter_rules.json` and duplicate it into memory. This adds a **fourth**
source of truth without removing any of the three existing ones. The
next pivot will re-stage the same bug.

This RFC commits to one source.

## 2. Goals

- One file is **the** definition of "which role-tracks this profile
  accepts". Editing it changes both scan filter and LLM fit behaviour.
- The LLM's Fit Score has a clean, profile-supplied list of acceptable
  tracks, plus per-track guidance for how to treat domain × track
  combinations (e.g. "PM-adjacent in Strong domain → Strong, do not
  downgrade").
- Backward-compatible migration: `jared` and `_example` work end-to-end
  on day-one after the change, no other profile breaks.

## 3. Non-goals

- Re-evaluating the *content* of Jared's acceptable role-tracks. BL-37
  set them; this RFC moves them, doesn't edit them.
- Migrating other `filter_rules.json` blocks (location, company,
  salary). Only role-track / title-gate.
- Multi-profile rollout beyond `jared` + `_example`. Other profiles
  migrate when their owner needs them to.
- Changing how memory is bundled into the LLM prompt. We use the
  existing prepare_context channel.

## 4. Proposed solution

### 4.1 Three structural options

This RFC presents three options. **Default recommendation: Option B**
(new section inside `filter_rules.json`). Rationale below.

#### Option A — New file `profiles/<id>/role_targets.json`

Standalone file, referenced from `profile.json` via
`profile.role_targets_file`. Both engine and prepare-context read it.

```jsonc
// profiles/jared/role_targets.json
{
  "_description": "...",
  "tracks": [
    {
      "id": "pm",
      "name": "Product Manager",
      "patterns": ["product manager", "product management", "PM", ...],
      "fit_treatment": "primary"
    },
    {
      "id": "fde",
      "name": "Forward-Deployed Engineer / AI Solutions",
      "patterns": ["forward deployed", "forward-deployed", "ai solutions", ...],
      "fit_treatment": "bridge",
      "bridge_note": "Treat as primary track in Strong-domain companies; do not downgrade for being non-PM."
    },
    ...
  ],
  "fit_treatments": {
    "primary": "Role-track is the candidate's main target. Apply Fit Score by domain only.",
    "bridge":  "Bridge role per BL-37. In Strong-domain context, treat as Strong. Otherwise, apply standard domain logic. Do not downgrade for not being on the primary track."
  }
}
```

Pros: clean separation, one obvious place. Cons: another top-level file
per profile; another loader path; `_example` has to ship a synthetic
copy.

#### Option B — New section `role_targets` inside `filter_rules.json` (RECOMMENDED)

Keep the file count flat. `filter_rules.json` is already the gate-config
file; role-targets are a gate concern.

```jsonc
// profiles/jared/filter_rules.json
{
  "_description": "...",
  "role_targets": {
    "_description": "Single source of truth for acceptable role-tracks. Read by scan (title gate) and by LLM prepare (fit score).",
    "tracks": [
      {
        "id": "pm",
        "name": "Product Manager",
        "patterns": [
          { "pattern": "product manager", "reason": "PM role" },
          { "pattern": "PM", "reason": "PM abbreviation" }
        ],
        "fit_treatment": "primary"
      },
      {
        "id": "fde",
        "name": "Forward-Deployed Engineer / AI Solutions",
        "patterns": [
          { "pattern": "forward deployed", "reason": "FDE — top fit" },
          { "pattern": "ai solutions", "reason": "AI Solutions Engineer — close to FDE" }
        ],
        "fit_treatment": "bridge",
        "bridge_note": "Treat as primary track in Strong-domain companies; do not downgrade for being non-PM."
      }
      // ... pm-adjacent tracks
    ],
    "fit_treatments": {
      "primary": "Apply Fit Score by domain only.",
      "bridge":  "Bridge role per BL-37. In Strong-domain context, treat as Strong. Apply domain logic otherwise. Never downgrade purely for not being on the primary track."
    }
  },
  // ... rest of file unchanged
  "title_requirelist": null,  // deprecated; see role_targets
  ...
}
```

`engine/core/profile_loader.js`'s `normalizeFilterRules` synthesizes the
legacy `title_requirelist` array from the union of all `tracks[].patterns`
so `engine/core/filter.js` keeps working with no edits to its hot path.
Eventually filter.js reads `role_targets` directly; for now we keep the
diff small.

Pros: no new file; profile loader already centralizes filter access;
SKILL.md and engine read one place. Cons: `filter_rules.json` grows.

#### Option C — Top-level field in `profile.json`

Add `role_targets: {...}` directly to `profile.json`. Loader already
exposes the parsed profile to both engine and prepare-context.

Pros: minimal new plumbing. Cons: `profile.json` is currently a small
config file (~60 lines for Jared); embedding ~150 lines of track
definitions plus prose treatments blurs its role. Mixing
identity/secrets/module-config with gate rules is a smell.

#### Why B

- `filter_rules.json` is already loaded once into `profile.filterRules`
  and passed to filter + prepare. Adding `role_targets` there means **no
  new file path, no new loader, no new ignore rule**.
- `_example` already ships `filter_rules.example.json`; we extend it,
  don't add a new template.
- Engine hot path stays identical via the `normalizeFilterRules` shim;
  scan smoke tests don't change.
- The LLM channel is via `prepare_context.json` (see §4.2), independent
  of the file location.

### 4.2 LLM channel: how role_targets reaches Fit Score

`engine/commands/prepare.js` Phase 1 (mechanical) already writes
`prepare_context.json` with everything the LLM needs. We add one field:

```jsonc
// profiles/<id>/prepare_context.json
{
  "jobs": [...],
  "salaryConfig": {...},
  "roleTargets": {
    "tracks": [
      { "id": "pm", "name": "Product Manager", "fit_treatment": "primary" },
      { "id": "fde", "name": "Forward-Deployed Engineer / AI Solutions",
        "fit_treatment": "bridge",
        "bridge_note": "Treat as primary track in Strong-domain..." },
      ...
    ],
    "fit_treatments": { "primary": "...", "bridge": "..." }
  }
}
```

Note: regex patterns are deliberately **stripped** before the LLM sees
the bundle — LLM doesn't need to match titles, scan already did that.
It needs the *names* and *treatments* to reason about fit.

`skills/job-pipeline/SKILL.md` §755 ("Fit Score") gets an explicit
clause:

> **Role-track is NOT a Fit Score input.** The candidate's acceptable
> tracks are in `context.roleTargets.tracks`. Every job in this batch
> already passed the role-track gate at scan time. Apply Fit Score by
> *domain match only* per the rules below. If a job's title-derived
> track has `fit_treatment: "bridge"`, follow the corresponding
> `fit_treatments.bridge` instruction.

This removes the LLM's hidden prior. The current SKILL.md note "Level
does NOT affect fit score" already exists; this RFC adds a parallel
statement for role-track.

### 4.3 Memory cleanup

`profiles/<id>/memory/user_resume_key_points.md` "Bridge-mode booster"
section becomes a one-line pointer:

> Bridge-mode treatment of role-tracks is defined in
> `filter_rules.json → role_targets`. The engine ensures Fit Score
> respects it; do not re-state the rule in memory.

`profile.json → target_roles` becomes derived (engine builds it from
`role_targets.tracks[].name`) or is deprecated in favour of letting the
LLM read `roleTargets` from context. Decision deferred to implementation
review — both eliminate the duplication.

### 4.4 Engine changes (Option B path)

| File | Change |
|---|---|
| `engine/core/profile_loader.js` | `normalizeFilterRules` reads `role_targets.tracks[].patterns` and synthesizes the legacy flat `title_requirelist` for filter.js compat. Exposes `role_targets` separately under `profile.roleTargets`. |
| `engine/core/filter.js` | No change in Phase 1. (Phase 2 follow-up: read `roleTargets.tracks[].patterns` directly and emit per-track `reason` for archive log clarity.) |
| `engine/commands/prepare.js` | When writing `prepare_context.json`, include `roleTargets` (stripped of regex patterns — see §4.2). |
| `skills/job-pipeline/SKILL.md` | Add the "Role-track is NOT a Fit Score input" clause to §755. |
| `profiles/jared/filter_rules.json` | Add `role_targets` block. Drop the legacy `title_requirelist` key entirely — loader synthesizes from `role_targets.tracks[].patterns`. The `role_targets._description` is the breadcrumb for future readers. (Originally proposed `title_requirelist: null` as a deprecation marker; implementation chose to omit, since the synthesized list lives only in memory and the marker risked confusing readers about the empty-array footgun — see §10 R1.) |
| `profiles/jared/profile.json` | Either delete `target_roles` or convert to derived pointer. |
| `profiles/jared/memory/user_resume_key_points.md` | Replace "Bridge-mode booster" with one-line pointer. |
| `profiles/_example/filter_rules.example.json` | Add minimal `role_targets` stub. |

## 5. Migration

Single migration step per profile, no rollback period needed (both
profiles are owned by the same operator; no fleet).

1. Author the new `role_targets` block in `filter_rules.json`,
   reproducing the existing `title_requirelist.patterns` 1:1.
2. Tag each track with `fit_treatment: "primary" | "bridge"`. (For
   Jared: `pm` = primary; everything else from BL-37 = bridge.)
3. Drop the legacy `title_requirelist` key (don't leave it as `null` or
   `[]` — an explicit empty list would silently disable the gate; §10 R1).
   Run the full test suite — loader synthesizes the flat list from
   `role_targets`; scan behaviour unchanged.
4. Update memory file + SKILL.md + delete `target_roles` (or convert).
5. Re-run `prepare` against the stuck 20-job batch from 2026-05-12.
   Verify: no "not PM track" rationale; PM-adjacent jobs get a real
   fit decision (Strong/Medium/Weak by domain).

Backup `filter_rules.json.pre-rfc030-{ISO}` before mutating (consistent
with existing backup pattern around BL-51 fixes).

## 6. Acceptance criteria

- `node engine/cli.js scan --profile jared` produces identical pass/fail
  counts vs pre-RFC baseline. (Smoke evidence that loader-shim
  preserves filter behaviour.)
- `node engine/cli.js prepare --profile jared --phase pre` writes
  `prepare_context.json` containing a non-empty `roleTargets.tracks[]`
  with `id`, `name`, `fit_treatment` (no regex patterns leaked into
  LLM context).
- `skills/job-pipeline/SKILL.md` §755 contains the "Role-track is NOT a
  Fit Score input" clause. (Spot-check by grep.)
- `profiles/jared/memory/user_resume_key_points.md` no longer contains
  the freeform "Bridge-mode booster" prose paragraph; one-line pointer
  in its place.
- Regression test: re-run the LLM phase on the 17 PM-adjacent rows from
  `prepare_results_20260512_182159.json`. **Zero** of them are
  decision=skip with rationale matching `/not PM track|not.*PM role|outside PM/i`.
  They may still skip for other reasons (geo, salary, fit domain) —
  that is fine; this RFC only fixes the role-track confound.
- `npm test` green. New unit tests:
  - `profile_loader.test.js`: `role_targets → title_requirelist` shim
    works (regression).
  - `profile_loader.test.js`: when both `title_requirelist` and
    `role_targets` present, `role_targets` wins; legacy
    `title_requirelist` (without `role_targets`) still works.
  - `prepare.test.js`: `prepare_context.json` exposes `roleTargets`
    without regex patterns.

## 7. Phasing

Single phase. Tier M. No staged rollout — affects only `jared` (active)
and `_example` (template). Steps:

1. Author + approve RFC.
2. Implement engine changes + new profile blocks.
3. Run tests; run smoke `scan` + `prepare --phase pre`.
4. Manually invoke prepare Phase 2 (LLM) on the regression batch via
   `/job-pipeline prepare` and verify the acceptance test.
5. Commit. Mark RFC `implemented`.

## 8. Out of scope

- Multi-profile rollout. `lilia` and others migrate when relevant.
- Restructuring `filter_rules.json`'s other sections (location,
  company, salary). Separate concerns.
- Adding more `fit_treatment` modes beyond `primary` / `bridge` (e.g.
  `aspirational` for stretch roles). Easy to extend; not needed now.
- Letting LLM see regex patterns. Stripped at context-write time.

## 9. Open questions

- **Q1.** `target_roles` in `profile.json`: delete or convert to a
  computed pointer? Removing breaks anyone reading `profile.target_roles`
  outside the engine; I have not seen such a reader, but a search before
  commit will confirm. Default: delete.
- **Q2.** Engine-side mapping from a job's title to which track it
  matched: do we expose this in `prepare_context.json` per-job
  (`job.matchedTrack: "fde"`)? Useful for the LLM, but coupling adds
  surface. Default: not in v1; LLM infers from title + tracks list.
- **Q3.** Memory file: keep the section heading "Domain criteria for fit
  scoring" + a one-line pointer, or delete the section entirely?
  Default: keep heading, replace body with pointer (preserves
  navigability).

## 10. Risks

- **R1.** Empty explicit `title_requirelist` silently disables the gate.
  `title_requirelist: []` (or `{patterns: []}`) alongside a non-empty
  `role_targets` would, under naïve "explicit wins" logic, take
  precedence and disable the positive title gate — every job passes
  scan on title grounds. *Resolved in implementation:* loader now treats
  "explicit wins" as "explicit *non-empty* wins"; empty explicit falls
  through to synthesis. Regression tests cover both `[]` and
  `{patterns: []}` shapes.
- **R2.** LLM ignores the new SKILL.md clause and persists with "not PM
  track" rationale. Mitigation: regression test on the existing
  prepare_results batch. If it still fires, escalate from soft
  instruction to a structured-output rule in the prompt (followup,
  out of scope here). Additionally, the SKILL.md wording was split
  (post-review) into asymmetric claims — *role-track NEVER downgrades*
  (hard rule) vs *bridge MAY upgrade* (soft modifier) — to avoid the
  internal contradiction the reviewer flagged.
- **R3.** `role_targets` schema doesn't generalize to non-PM profiles
  (e.g. `lilia`, a healthcare admin). Mitigation: `fit_treatments` is
  free-form prose keyed by `fit_treatment` value, so other profiles
  can define their own treatments without engine changes.

## 11. Approval

RFC accepted by Jared 2026-05-13 (Option B, Q1=delete, Q2=defer,
Q3=keep heading + pointer). Implementation under BL-56 includes
fixes for the two serious findings from the code-review pass
(empty-array footgun in loader; SKILL.md asymmetry split).
