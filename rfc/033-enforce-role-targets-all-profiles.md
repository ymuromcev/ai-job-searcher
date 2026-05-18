---
id: RFC-033
title: Enforce role_targets / title_requirelist on every profile
status: proposed
author: Claude (via Jared)
tier: M
created: 2026-05-18
refs:
  - RFC-030
---

# RFC 033 — Enforce role_targets / title_requirelist on every profile

## 1. Problem

The engine supports two filtering modes:

1. **Allowlist + blocklist** (canonical, post-RFC 030): `role_targets`
   in `filter_rules.json` synthesizes a `title_requirelist` — scan
   rejects any title that matches no track. `title_blocklist` removes
   leftover noise.
2. **Blocklist-only** (legacy fallback): when `role_targets` and
   `title_requirelist` are both absent, the engine skips the positive
   gate. Every title that doesn't hit a blocklist pattern is kept.

Mode (2) is config-drift surface, not by design. Today's state:

| Profile | `role_targets` | `title_requirelist` | Effective mode |
|---|---|---|---|
| `jared`  | 7 tracks (RFC 030) | synthesized | allowlist+blocklist |
| `lilia`  | 4 tracks (this RFC seed, 2026-05-18) | synthesized | allowlist+blocklist |
| `_example` | (template) | (template) | depends on template |

### Concrete failure (2026-05-18)

A scheduled scan + prepare run for `lilia` pushed three jobs to Notion
with `fitScore=Weak` that should never have entered her Inbox:

- Modern Health — **Product Designer** (no `designer` in blocklist; no
  positive gate to require patient-services title)
- Shriners Children's — **Clinical Research Coordinator II** (3+ yrs
  clinical research experience required)
- Kaiser Permanente — **Emergency Department Technician II**
  (Phlebotomy + BLS + 6 mo EMT/CNA/MA required; phlebotomy is in
  `resume_key_points.md` "Out of scope" list but the filter scans
  title only, and the title doesn't contain "phlebotomy")

Root cause: `lilia/filter_rules.json` had no `role_targets`. The
profile was scaffolded before RFC 030, the wizard didn't require it,
the loader didn't warn, validate didn't flag it. The blocklist alone
is fundamentally the wrong tool to express "patient-services admin
only" — that's a positive shape, not a negative one.

Once `role_targets` was added (post-incident), `validate --apply`
retro-archived 12 additional historical rows that had been sitting in
active statuses for weeks under the same gap.

## 2. Proposal

Make `role_targets` (or explicit `title_requirelist`) a **required
field** on every profile. No more silent fallback.

### 2.1 `profile_loader.js`

On load, if neither `filter_rules.role_targets` nor
`filter_rules.title_requirelist` is present (or both are empty):

- Print a warning to stderr: `profile "<id>": no role_targets /
  title_requirelist — scan will accept any non-blocked title; see
  RFC-033`.
- Exit code 0 (warn only) for now. Phase-2 of this RFC flips to
  hard-fail after a deprecation window (one release).

### 2.2 `engine/cli.js validate`

Add a check to the validate command: if the loaded profile has no
allowlist, surface it as an issue in the standard validation report
(alongside TSV hygiene, company-cap, URL liveness). Same tier as the
others — exit 1 if found.

### 2.3 `scripts/stage18/` (profile wizard)

Add an obligatory step that prompts the user for at least one
role-track. Without a track defined, the wizard refuses to write
`filter_rules.json`. The wizard already prompts for blocklists; this
adds a symmetric positive-gate step before that.

The step UX:

```
What role titles should this profile accept? (positive gate)
Examples for healthcare admin: medical receptionist, front desk,
patient services representative, scheduler, coordinator
Examples for PM: product manager, product owner, group product manager

Enter track id: <front_desk>
Enter track name: <Front Desk / Reception>
Enter title patterns (one per line, blank to finish):
  > medical receptionist
  > front desk
  > patient services representative
  > <enter>
Add another track? (y/n)
```

### 2.4 Profile template (`profiles/_example/`)

Update `_example/filter_rules.json` to include a one-track
`role_targets` placeholder so future copies inherit the shape.

## 3. Non-goals

- This RFC does **not** change the blocklist semantics. Both gates
  still apply: positive (title must match a track) AND negative
  (title must not match a blocklist pattern).
- This RFC does **not** introduce JD-body scanning for cert keywords.
  That's a separate gap (Phlebotomy cert required by JD body but
  title says "ED Tech II" → slipped through title-only filter even
  with allowlist if "ED Tech" matched a track). Tracked separately if
  the user wants it.
- This RFC does **not** retroactively flip existing profiles —
  `jared` already complies, `lilia` was migrated as part of the
  incident response (see §1). Phase-2 enforcement (hard-fail) is
  deferred to allow downstream profile-tooling to update.

## 4. Migration

| Step | When | Owner |
|---|---|---|
| Add warning in `profile_loader.js`  | This PR | engine |
| Add issue to `validate`             | This PR | engine |
| Update Stage 18 wizard              | This PR | wizard |
| Update `_example` template          | This PR | repo |
| Audit existing profiles, fix gaps   | Pre-merge | engine |
| Flip warning to hard-fail in loader | Phase-2 (next release) | engine |

`lilia` is already fixed (4 tracks added 2026-05-18). `jared` was
fixed in RFC 030. `_example` needs the template update.

## 5. Open questions

- Should the loader warning include a quick-start snippet? (Lean yes —
  copy-pasteable two-track JSON beats a doc link for cold-context
  ops.)
- Phase-2 hard-fail timing — same release, or a soak period? (Lean
  same release once template + wizard + jared/lilia are clean. No
  third-party consumers to worry about.)

## 6. Tests

- `engine/core/profile_loader.test.js` — add a case for
  no-role-targets-and-no-title-requirelist → warning emitted.
- `engine/commands/validate.test.js` — add a case where missing
  allowlist surfaces as an issue.
- `scripts/stage18/` — wizard-level test that aborts when the user
  skips role-track entry.

## 7. Decision

(Pending review.)
