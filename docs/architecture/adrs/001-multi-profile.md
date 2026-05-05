# ADR 001 — Profile is data, engine is service

- Status: accepted
- Decided: 2026-04-19
- Crystallizes: [RFC 001](../../../rfc/001-multi-profile-architecture.md)

## Context

The job-search pipeline started life as two independent MVP projects, one per candidate. Both projects were copy-paste forks of the same scripts: discovery adapters, cover-letter generators, the Notion sync layer. Within a few weeks the forks had drifted — bug fixes landed in one and not the other, filter rules diverged silently, and the Notion schemas were close enough to confuse but different enough to break shared tooling.

Two new candidates were on the horizon (PM-Pete already live, Healthcare-Hannah onboarding next, with at least one more profile expected within the year). Continuing to fork would mean four parallel codebases by mid-year, each accumulating its own latent bugs. A single shared engine was needed, but it had to keep each candidate's data fully isolated: profiles never share resumes, cover letters, recruiter contacts, or Notion workspaces.

A secondary requirement: the same job posting often appears in two profiles' searches simultaneously (e.g., a generalist role at a fintech that both an analyst and a PM might apply to). The MVPs had no way to coordinate this — each profile would re-fetch and re-process the same posting. A shared dedup pool became part of the brief.

## Decision

One shared engine codebase, multiple data-only profiles.

- **Engine code** lives under `engine/` and is profile-agnostic. Every command takes a mandatory `--profile <id>` flag.
- **Per-profile data** lives under `profiles/<id>/` — `profile.json`, `applications.tsv`, `cover_letters/`, `resumes/`, generated artifacts, state files. None of this is shared.
- **Cross-profile dedup pool** lives under `data/` — `jobs.tsv` and `companies.tsv` keyed by canonical URL/name. Dedup writes happen at scan time so two profiles never reach the prepare stage with the same job.
- **Secrets** live only in the root `.env` (gitignored), namespaced by profile id in upper case: `JARED_NOTION_TOKEN`, `LILIA_NOTION_TOKEN`, `JARED_GMAIL_*`, etc. The profile loader (`engine/core/profile_loader.js`) reads only the keys for the active profile.
- **Old MVP directories** are read-only fallback. The engine never references them and never modifies them.

## Consequences

Positive:

- Single bug-fix surface. A regression in the Lever adapter is fixed once and both profiles benefit.
- Real cross-profile dedup. The shared `data/jobs.tsv` is the only place two profiles' scan runs converge, which makes the dedup contract explicit and testable.
- CI is straightforward. One `npm test` run covers all profiles; profile-specific behavior is gated by fixtures.
- Onboarding a new profile is now a wizard run plus an `.env` patch (see [RFC 004](../../../rfc/004-onboarding-wizard.md)), not a fork.

Negative:

- Every code path must be profile-aware. Forgetting to thread `--profile` through a new command is the single largest class of regression we have seen; the CLI now refuses to start without it.
- Accidental cross-profile contamination is possible if a script misreads which profile is active (e.g., writing PM-Pete's resume into Healthcare-Hannah's directory). The mandatory CLI flag and a profile-scoped `profile_loader` are the primary mitigations; tests assert that no module reads from `profiles/` without a profile argument.
- Slightly higher cognitive load for new contributors — the `--profile` constraint shows up everywhere.

## References

- [RFC 001](../../../rfc/001-multi-profile-architecture.md) — full original design
- [RFC 004](../../../rfc/004-onboarding-wizard.md) — onboarding wizard built on top of this architecture
- [ADR 002](002-notion-as-ui.md) — Notion-as-UI, which is also keyed per profile
