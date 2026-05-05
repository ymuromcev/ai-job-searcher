# ADR-005 — Profile id naming convention

**Status**: accepted
**Decided**: 2026-05-05
**Crystallizes**: a documentation cleanup pass after RFC 018 phase 2

## Context

The engine identifies profiles by an opaque slug (`profile_id`) used as
a path component (`profiles/<id>/`), an `.env` key prefix
(`<ID>_NOTION_TOKEN`), and a CLI flag value (`--profile <id>`).
`profile_loader.validateId` enforces the regex `^[a-z][a-z0-9_-]*$`.

The first two profiles onboarded (Stages 7 and 8) used candidates'
first names as their `profile_id` strings. Those names then propagated
into:

- every example block in user-facing docs (`--profile <name>`)
- every secret key in the root `.env` (`<NAME>_NOTION_TOKEN`)
- every reference in stage logs, scripts, RFCs, and `CLAUDE.md`
- the git history of every commit since Stage 7

This is a privacy gap. Even with persona aliases (PM-Pete,
Healthcare-Hannah) used everywhere in narrative prose, the technical
identifier still ties the public repo to real people for any reader
who can correlate a profile slug to a real first name.

## Decision

1. **New profiles use random opaque slugs** of the form
   `p_<hex6>` (e.g. `p_a8f2c1`). The Stage 18 onboarding wizard will
   generate the slug; the operator never picks it. The slug is not
   meant to be memorable — it is a database key. Operators address
   profiles by persona alias in conversation and copy-paste the slug
   from the wizard output for CLI invocations.
2. **The two existing profiles keep their current slugs** as accepted
   technical debt. Renaming them today would touch every file in the
   repo (engine, scripts, RFCs, `CLAUDE.md`, skills, memory, `.env`)
   and the git history would still contain the original strings. The
   cost outweighs the marginal privacy gain at this point in the
   project.
3. **Public docs use placeholders** (`<id>`, `<PROFILE_ID>`,
   `<P_HEX>_NOTION_TOKEN`) in examples instead of literal slugs.
   Persona aliases are still used in narrative prose. The legacy slug
   strings should not appear in any newly authored doc, ADR, RFC, or
   runbook.
4. **Migration is a backlog item**, not a planned phase. It will be
   bundled with the next breaking change that already touches profile
   directory layout (e.g. RFC 012 relational data model). At that
   point, the cost of renaming amortizes against work already in
   flight.

## Consequences

**Positive:**

- New profiles do not leak candidate identity through the engine's
  technical surface.
- Public docs are clean of name literals from this point forward.
- The decision is reversible: if the rename becomes urgent, the
  backlog item carries the migration plan.

**Negative:**

- Two profiles retain candidate names in their technical identifiers.
  Anyone with read access to the public repo can still correlate slug
  ↔ persona ↔ candidate if they have the personas-real map (which is
  gitignored under `private/`).
- Git history is not rewritten. `git log -p` will continue to show
  the legacy strings in commits before this ADR.
- Operators must remember that the persona name they refer to in
  conversation is not the slug they pass to `--profile`.

**Trigger to revisit:** when RFC 012 (relational data model) or any
similar profile-touching migration lands, fold the rename into that
work and supersede this ADR.

## References

- [RFC 018 — Documentation system overhaul](../../../rfc/018-documentation-system.md)
  (the cleanup pass that surfaced this gap)
- [RFC 012 — Relational data model](../../../rfc/012-relational-data-model.md)
  (draft; the natural carrier for the rename migration)
- [ADR-001 — Multi-profile architecture](001-multi-profile.md)
- `private/backlog/BL-rename-profile-ids.md` (gitignored migration plan)
