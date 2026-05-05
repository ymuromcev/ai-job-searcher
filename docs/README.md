# Documentation hub

This directory contains the project's documentation, organized by genre per the [Diátaxis framework](https://diataxis.fr/).

## Map

| Section | Genre | Audience | Contents |
|---|---|---|---|
| [product/](product/) | Explanation (why) | Anyone | Vision, anonymized personas |
| [architecture/](architecture/) | Explanation + reference (what) | Engineers, Claude agents | C4 overview, data flow, multi-profile model, ADRs |
| [runbooks/](runbooks/) | How-to | Maintainer | Step-by-step operational guides |
| [reference/](reference/) | Reference | Engineers | CLI, TSV schema, Notion schema, behavioral spec |
| [audits/](audits/) | Explanation (historical) | Anyone | Anonymized one-time audit reports |

## Top-level docs (repo root)

- [README.md](../README.md) — landing, quickstart, links here
- [ARCHITECTURE.md](../ARCHITECTURE.md) — C4 L1–L2 overview (deep dive in [architecture/overview.md](architecture/overview.md))
- [CHANGELOG.md](../CHANGELOG.md) — version history (Keep a Changelog format)
- [DEVELOPMENT.md](../DEVELOPMENT.md) — dev principles, doc-maintenance triggers, tier rules
- [CONTRIBUTING.md](../CONTRIBUTING.md) — how to contribute
- [CLAUDE.md](../CLAUDE.md) — AI agent rules
- [incidents.md](../incidents.md) — anonymized postmortems
- [rfc/](../rfc/) — design proposals (see [rfc/README.md](../rfc/README.md))

## Conventions

- **Markdown only.** All docs use `.md`.
- **Relative links.** Use the form `[text](../path/file.md)` (relative MD link). Wikilinks `[[]]` are forbidden (break GitHub render).
- **English only** for everything in this directory and the rest of the public repo. Private notes (`private/`, gitignored) may use any language.
- **Anonymized.** Real candidate names never appear in tracked files. See [product/personas.md](product/personas.md) for the persona aliases used.
- **Single source of truth.** Each fact lives in one file; others link to it.

## Doc maintenance

When you change code, the [doc-maintenance trigger table](../DEVELOPMENT.md#doc-maintenance-triggers) tells you which docs to update. Pre-commit + CI enforce link integrity (`npm run docs:check`) and language policy (`npm run docs:lang`).
