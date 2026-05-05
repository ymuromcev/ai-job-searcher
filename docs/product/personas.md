# Personas

This file is the canonical persona reference for everything in public
docs, RFCs, ADRs, runbooks, audits, and the changelog. Whenever a
public document needs to refer to a real candidate the engine is
serving, it does so through one of the aliases defined here.

Real-candidate identifiers — legal names, contact details, Notion
workspace ids, profile-internal slugs — are mapped to these aliases
in `private/personas-real.md`, which is gitignored. That file exists
so the maintainer and Claude can resolve an alias back to a concrete
profile when running the engine, without leaking the mapping into the
public surface. If you are reading this in the public repo, the
real-name mapping is intentionally not here.

The aliasing convention is consonant-style: a role keyword paired
with an alliterative first name (`PM-Pete`, `Healthcare-Hannah`). New
aliases follow the same shape so they remain easy to recognize as
personas rather than real people.

## PM-Pete

- **Profile id**: opaque slug. Per [ADR-005](../architecture/adrs/005-profile-id-convention.md),
  new profiles use random slugs (`p_<hex6>`); two legacy profiles
  retain their original strings as accepted technical debt.
- **Role target**: Senior or Principal AI Product Manager. Open to PM
  roles tagged "AI / ML", "Platform", or "GTM" depending on
  archetype, but the seniority floor is firm.
- **Industry weight**: AI infrastructure, fintech, devtools. Sample
  tier-S/A targets are well-known names in those segments — model
  providers, payments and lending, developer-platform companies — but
  the persona is generic; the specific tier list is per-deployment
  data, not a feature of the persona.
- **Geography**: US-wide. Open to remote-first and hybrid; no
  relocation constraint.
- **ATS coverage**: Greenhouse, Lever, Ashby, Workable, RemoteOK,
  USAJOBS (gated behind a free API key plus registered email;
  activation is a backlog follow-up).
- **Key constraints**: Tier-S and Tier-A targets dominate the
  pipeline. Salary floor is calibrated by Tier × Level ×
  cost-of-living using the salary calculator added in Stage 13 (see
  the [changelog](../../CHANGELOG.md)). Below-floor roles are
  filtered out before reaching Notion.
- **Cover-letter voice**: Precise, narrative-led, infra-curious.
  Short concrete examples beat broad claims. Light on adjectives.
- **Resume archetypes**: AI infra PM, GTM PM, Platform PM. The
  archetype is assigned during `prepare` and drives both the resume
  version and the cover letter template.
- **Notion hub flavor**: `pm`. Full PM workflow with all status
  columns (`To Apply / Applied / Interview / Offer / Rejected /
  Closed / No Response / Archived`), interview-coach subpage
  included, full salary and resume-version tables in the hub.
- **Origin RFC**: [RFC 001 — multi-profile architecture](../../rfc/001-multi-profile-architecture.md)
  (initial profile; the engine was extracted from this candidate's v1
  prototype).

## Healthcare-Hannah

- **Profile id**: opaque slug (legacy; see [ADR-005](../architecture/adrs/005-profile-id-convention.md)).
- **Role target**: Medical assistant, front office, or receptionist
  roles in healthcare-adjacent settings. Some clinical-support roles
  in scope; no licensed-clinician roles.
- **Industry weight**: Outpatient clinics, dental practices,
  pediatric offices, dermatology, urgent care. Regional small
  employers dominate the pool; large healthcare systems are a smaller
  share.
- **Geography**: Sacramento, CA metropolitan area. Strict commute
  radius (roughly thirty miles), schedule-bound. No relocation, no
  remote.
- **ATS coverage**: Companies database is pre-seeded from a
  hand-curated tier list of regional clinics (around ninety-nine
  historical applications imported from the prior prototype). Active
  gaps in coverage for Workday tenants, Indeed, and clinic-bespoke
  ATSes; tracked under backlog item `BL-Indeed-adapter` (gitignored
  backlog file).
- **Key constraints**: Schedule is rigid (school pickup is
  non-negotiable). No relocation. Manual research dominates
  discovery, because the regional clinic pool does not run on
  PM-friendly ATSes — most postings live on Indeed, on Workday
  tenants belonging to large hospital systems, or on the clinic's own
  bespoke careers page.
- **Cover-letter voice**: Warm, concrete, schedule-aware. References
  real clinic operations rather than abstract claims. Schedule
  constraints are *not* mentioned to the recruiter — the cover letter
  and outreach copy stay neutral on availability and reveal
  scheduling needs only at the interview stage. See the maintainer's
  note `feedback_recruiter_location.md` for the rationale behind this
  rule.
- **Resume archetypes**: Front office, Medical assistant. Two
  archetypes is enough for the role surface; a third was considered
  and dropped.
- **Notion hub flavor**: `healthcare`. Compressed workflow: shorter
  status pipeline, no interview-coach subpage, manual-first emphasis
  in the hub copy. The flavor is set per-profile in `profile.json`
  and consumed by `build_hub_layout.js`.
- **Origin RFC**: [RFC 010 — Workday activation](../../rfc/010-lilia-workday-activation.md)
  (the persona's adapter coverage gap motivated the Workday work).

## Adding a new persona

When a new candidate joins the engine, add a persona block to this
file before the deploy. The flow is:

1. **Pick an alias.** Follow the consonant-name pattern: a role
   keyword (`PM`, `Healthcare`, `Design`, `Data`) plus an
   alliterative first name (`Pete`, `Hannah`, `Diana`, `Dan`). The
   alias should make the role context obvious to a reader who knows
   nothing else about the candidate.
2. **Assign a `profile_id`.** Lowercase letters, digits, hyphens, and
   underscores, between two and thirty-two characters, starting with
   a letter. The id becomes the directory name (`profiles/<id>/`) and
   the env-var prefix (`<ID>_NOTION_TOKEN`).
3. **Document constraints here.** Copy the section structure used by
   `PM-Pete` and `Healthcare-Hannah`. Fill role target, industry
   weight, geography, ATS coverage, key constraints, cover-letter
   voice, resume archetypes, Notion hub flavor, and origin RFC. Keep
   it generic — no real names, no real company tier list, no salary
   numbers.
4. **Run the wizard.** Send the candidate the intake template, parse
   the answers, deploy the profile. Full runbook:
   [docs/runbooks/new-profile.md](../runbooks/new-profile.md).

The mapping from the new alias to the real candidate's identifying
details goes into `private/personas-real.md`, never into this file.
