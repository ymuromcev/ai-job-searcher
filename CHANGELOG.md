# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Status**: stub (RFC 018 phase 1). The full v0.21.0 entry covering the documentation overhaul plus retrospective entries for prior stages will be drafted in phase 4 of [RFC 018](rfc/018-documentation-system.md).

## [Unreleased]

### Changed

- **`applications.tsv` schema v3 → v4** (BL-9, 2026-05-05). Added four columns to persist Claude's fit verdict per row: `fit_score` (`Strong` / `Medium` / `Weak`), `fit_rationale`, `fit_evaluated_at`, `skip_reason` (SKILL-level only: `weak_fit` / `duplicate`). Subsequent `prepare` runs will skip already-evaluated rows instead of re-paying the SKILL cost. Auto-upgrade on read from v1 / v2 / v3 with empty fit columns; writes always emit v4. Engine-level skips (company cap, blocklists, geo) continue to be recomputed each run and are not persisted. See [docs/reference/tsv-schema.md](docs/reference/tsv-schema.md).
- **`prepare --phase pre` skips already-evaluated rows** (BL-9, 2026-05-05). New filter step runs before `applyPrepareFilter`: rows with `fit_score=Weak` or `skip_reason ∈ {weak_fit, duplicate}` no longer reach URL-check / JD-fetch / SKILL judgement. They appear in `prepare_context.json` `skipped[]` with reasons `already_evaluated_weak` / `already_evaluated_duplicate` and a new `stats.alreadyEvaluated` counter. Dramatically reduces token cost on repeat runs once fit verdicts have been persisted.
- **`prepare --phase commit` persists fit verdict for every decision** (BL-9, 2026-05-05). SKILL results JSON now carries `fitScore` / `fitRationale` / `skipReason` on every result (`to_apply` / `skip` / `archive`). Engine writes them to TSV columns `fit_score` / `fit_rationale` / `skip_reason` and stamps `fit_evaluated_at = now` whenever a `fit_score` is present. Validators reject invalid values (`fitScore` must be Strong/Medium/Weak; `skipReason` must be weak_fit/duplicate) with a stderr warning instead of corrupting the column. Stdout summary surfaces `fitWritten` count. Downgraded-to-skip rows (invalid resumeVer) still capture the verdict so they are not re-evaluated next run.

### Added

- RFC 018 — Documentation system overhaul (phase 1: foundation: directory tree, `.obsidian/` baseline, link + language audit scripts, RFC frontmatter back-fill).

### Notes

- Pre-RFC-018 history is being reconstructed from git log + project memory in phase 4. See [README.md](README.md) and [CLAUDE.md](CLAUDE.md) "Stage" history for the interim record.
