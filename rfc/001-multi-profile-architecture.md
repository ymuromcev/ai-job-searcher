---
id: RFC-001
title: Multi-profile Job Search Pipeline
status: implemented
tier: L
created: 2026-04-19
decided: 2026-04-19
tags: [architecture, multi-profile]
---

# RFC 001 — Multi-profile Job Search Pipeline

**Status**: Approved 2026-04-19
**Tier**: L (new subproject, architecture, migration, 2+ users)
**Author**: Claude + Jared Moore

## Problem

Two separate codebases (`Job Search/` for Jared, `Profile B Job Search/` for the second profile) implement similar pipelines. New features land in Jared's codebase and never reach the second profile — syncing them requires manual copying. This is expensive and leads to drift: CL generation has already diverged, filter rules are structured differently, and Notion schemas are inconsistent.

We need a single engine that serves both profiles from shared code and scales to a third user or a future SaaS product.

## Options

- **A. New subproject `AIJobSearcher/` with per-profile configs.** Single engine, `profiles/jared/` and `profiles/profile_b/` for data. Old folders are left untouched — they remain as read-only fallback.
- **B. Shared library (npm package) + two consumers.** Refactor both existing projects to use a common library. Downside: breaks working MVPs while the library stabilizes — Jared's job search goes offline. Contradicts the requirement to not touch old projects.
- **C. Fork Jared into the second profile and sync manually.** Technical debt remains unresolved — the same drift, just slower at the start. Does not solve the "both get updates" requirement.

## Decision + Rationale

**Option A.** New `AIJobSearcher/` engine with profile overlay.

Reasons:
- Old projects keep working — Jared has an active job search, zero risk.
- Single code path: a feature is written once and available to both profiles after `--profile X`.
- Architecture is SaaS-ready: the profile is data, the engine is a service.
- GitHub publication is natural (engine + `_example` profile as a starter kit).

## Architecture

### Directory structure

```
AIJobSearcher/
├── engine/                           # shared code, no PII
│   ├── modules/
│   │   ├── discovery/                # ATS/board adapters (auto-registered by index.js)
│   │   │   ├── greenhouse.js
│   │   │   ├── lever.js
│   │   │   ├── ashby.js
│   │   │   ├── smartrecruiters.js
│   │   │   ├── workday.js
│   │   │   ├── calcareers.js
│   │   │   ├── usajobs.js
│   │   │   ├── indeed.js
│   │   │   └── index.js              # auto-discovery of adapters
│   │   ├── tracking/
│   │   │   └── gmail.js              # reads per-profile OAuth tokens
│   │   └── generators/
│   │       ├── resume_docx.js        # master format
│   │       ├── resume_pdf.js         # export for submission
│   │       └── cover_letter_pdf.js
│   ├── core/
│   │   ├── filter.js
│   │   ├── dedup.js
│   │   ├── notion_sync.js            # hybrid: direct API + MCP queue (as Jared now)
│   │   ├── validator.js
│   │   ├── fit_prompt.js             # assembles per-profile fit prompt for Claude
│   │   └── profile_loader.js
│   └── cli.js                        # node engine/cli.js <cmd> --profile <id>
├── profiles/
│   ├── _example/                     # committed to git, template for new users
│   │   ├── profile.example.json
│   │   ├── filter_rules.example.json
│   │   └── resume_versions.example.json
│   ├── jared/                        # gitignored (personal data)
│   │   ├── profile.json
│   │   ├── filter_rules.json
│   │   ├── resume_versions.json
│   │   ├── cover_letter_versions.json
│   │   ├── cover_letter_template.md
│   │   ├── salary_matrix.md
│   │   ├── company_preferences.tsv   # per-profile overlay on shared companies
│   │   ├── calcareers/
│   │   ├── interview-coach-state/    # copied (not linked) from old project
│   │   ├── applications.tsv          # per-profile pipeline
│   │   ├── cover_letters/
│   │   ├── resumes/
│   │   ├── jd_cache/
│   │   └── .gmail-tokens/            # OAuth tokens
│   └── profile_b/                        # gitignored
│       └── ...                       # same structure
├── data/                             # shared master pool, gitignored
│   ├── jobs.tsv                      # all jobs from all sources, dedup
│   └── companies.tsv                 # all companies across platforms (ats_source + ats_slug)
├── skills/
│   └── job-pipeline/SKILL.md         # unified skill with --profile flag
├── rfc/
│   └── 001-multi-profile-architecture.md
├── incidents.md
├── BACKLOG.md
├── .env.example
├── .gitignore
├── CLAUDE.md
├── README.md
└── package.json
```

### Shared vs per-profile (separation rule)

**Shared (engine + `data/`)**:
- All module code (discovery adapters, generators, sync).
- `data/jobs.tsv` — master job pool. Deduped by `(ats_source, job_id)`.
- `data/companies.tsv` — master company pool with `ats_source + ats_slug`. When a new platform is onboarded or a company is added for any profile, the record goes into the shared pool and is available to everyone.
- Platform adapters: add a file to `engine/modules/discovery/` and it automatically becomes available to both profiles via `modules:` in profile.json.

**Per-profile (`profiles/<id>/`)**:
- `profile.json` — identity, enabled modules, references to config files.
- `filter_rules.json` — which companies/roles/locations are a fit.
- `company_preferences.tsv` — overlay on shared companies: Jared stores tier (S/A/B/C), the second profile stores sonography_pivot / LA_presence.
- Resume/CL templates and generated artifacts.
- `applications.tsv` — per-profile pipeline: `job_id → profile → fit, status, resume_ver, cl_key, notion_page_id`.
- Gmail tokens, Interview Coach state.

**"Discovery for one, benefit for all" scenario**: scanning Indeed for `OptumHealth` on behalf of the second profile → the record lands in `data/companies.tsv` with `ats_source=indeed`. Jared sees it in the pool on the next scan; filter rules decide whether it makes it into his `applications.tsv`.

### `profile.json` contract

```json
{
  "id": "jared",
  "identity": {
    "name": "...",
    "email": "...",
    "phone": "...",
    "linkedin": "...",
    "location": "..."
  },
  "modules": [
    "discovery:greenhouse",
    "discovery:lever",
    "discovery:ashby",
    "discovery:smartrecruiters",
    "discovery:workday",
    "discovery:calcareers",
    "discovery:usajobs",
    "tracking:gmail",
    "generators:resume_docx",
    "generators:resume_pdf",
    "generators:cover_letter_pdf"
  ],
  "discovery": {
    "companies_whitelist": null,
    "companies_blacklist": [],
    "indeed_keywords": null
  },
  "filter_rules_file": "filter_rules.json",
  "resume": {
    "versions_file": "resume_versions.json",
    "output_dir": "resumes/",
    "master_format": "docx"
  },
  "cover_letter": {
    "config_file": "cover_letter_versions.json",
    "template_file": "cover_letter_template.md",
    "output_dir": "cover_letters/"
  },
  "fit_prompt_template": "Evaluate job fit for a PM with a fintech focus. Strong = ...; Weak = ...",
  "notion": {
    "jobs_pipeline_db_id": "...",
    "companies_db_id": "...",
    "app_qa_db_id": "..."
  }
}
```

### Secrets

All tokens go in the root `.env` with namespaced keys: `{PROFILE_ID_UPPERCASE}_{SERVICE}_{KEY}`.

Example:
```
JARED_NOTION_TOKEN=...
JARED_USAJOBS_API_KEY=...
JARED_GMAIL_CLIENT_ID=...
PROFILE_B_NOTION_TOKEN=...
PROFILE_B_GMAIL_CLIENT_ID=...
```

Gmail OAuth refresh tokens live in `profiles/<id>/.gmail-tokens/` (gitignored).

### CLI

`node engine/cli.js <cmd> --profile <id> [options]`

Commands:
- `scan` — run all enabled discovery modules, update `data/jobs.tsv` + `profiles/<id>/applications.tsv`.
- `prepare [--batch N]` — for new applications: assign resume archetype, generate CL, create Notion page.
- `sync` — two-way sync with Notion.
- `check` — scan Gmail for replies, classify, update Notion.
- `answer` — generate answers to form questions (210 char limit from Jared's feedback).
- `validate` — pre-flight: URL alive, company cap, TSV hygiene.

## Risks / What Could Break

1. **Generator regression during migration.** DOCX/PDF from Jared's `generate_resumes.js` is working code; a copy of it may produce different output.
   → Smoke test compares output against a reference on key fields; first run on a single archetype with visual review.

2. **Notion duplicates.** Migration creates new pages in new databases; old pages remain in old databases.
   → New Notion databases are created from scratch; dedup inside the migration script by `(company + job_id + source)`.

3. **Notion rate limits** when bulk-importing full history (~1000 Jared pages + ~50 for the second profile).
   → Batch at 3 req/s (current Notion limit), retry with exponential backoff, checkpoint for resuming.

4. **Concurrent scan → collision in `data/jobs.tsv`.**
   → Scans run sequentially per profile, `flock` on `data/jobs.tsv`.

5. **Secrets committed to the repo on publication.**
   → `profiles/*/` in `.gitignore` (except `_example`), `data/*` in `.gitignore`, `.env` too. Grep for token patterns before any public commit.

6. **Jared's old scripts reference absolute paths.**
   → The new project is **fully self-contained**. No symlinks or references to old folders. Interview Coach state and configs are **copied** during migration.

7. **Loss of interview-coach state during parallel work in old and new projects.**
   → Until the final cutover, work in the old project. State is captured in a single snapshot at cutover time; from that point on, only the new project is used.

## Verification Plan

**Smoke tests (required for all, `node --test`)**:
- `engine/modules/generators/resume_docx.test.js` — generates DOCX from a test profile, file exists, valid zip.
- `engine/modules/generators/cover_letter_pdf.test.js` — PDF created, magic bytes `%PDF` present.
- `engine/core/filter.test.js` — test job passes/fails rules.
- `engine/core/dedup.test.js` — two consecutive scans produce 0 duplicates.
- `engine/cli.test.js` — `--profile` loads the correct config.

**Unit tests**:
- `filter.js` — blocklists, company cap, location.
- `dedup.js` — company name normalization, collision keys.
- `fit_prompt.js` — variable substitution.
- Discovery adapters — parsing ATS API response → normalized job record (network mocks).

**Integration tests**:
- `notion_sync.js` against a mock (stub `@notionhq/client`) — create/update/read.
- `gmail.js` — mocked Gmail API responses.

**Manual verification (checklist)**:
- [ ] Scan `--profile jared` yields ≥1 new job in `data/jobs.tsv` and an application in `profiles/jared/applications.tsv`.
- [ ] Scan `--profile profile_b` via Indeed yields ≥1 job.
- [ ] `prepare --profile jared` creates a Notion page, PDF resume, PDF CL.
- [ ] `sync --profile jared` pulls statuses from Notion.
- [ ] Same for the second profile.
- [ ] Visual review of PDF resume: layout is intact.
- [ ] Old folders `Job Search/` and `Profile B Job Search/` **are unchanged** — verified via `git status` at the end.

**Data migration — two-phase**:
1. **Dry-run**: script reads both old Notion databases, builds `migration_plan.json`, shows it to me.
2. After approval — real migration with checkpoint (resume from where it stopped).

## Implementation Plan

Each stage has its own mini-approval. Between stages — self-check against DOD (re-read the diff, run tests, check `git status` for old folders).

| Stage | What | Tests | Approval |
|---|---|---|---|
| 1 | Scaffolding: directories, `package.json`, `.gitignore`, `CLAUDE.md`, `README.md`, `.env.example`, `BACKLOG.md`, `incidents.md`, RFC | — | tree + files |
| 2 | Generators: resume DOCX/PDF, CL PDF — ported from Jared as-is | smoke + unit | diff + green |
| 3 | Core: filter, dedup, validator, fit_prompt, profile_loader | unit | diff + green |
| 4 | Notion sync (hybrid) | integration with mock | diff + green |
| 5 | Discovery adapters one by one: greenhouse → lever → ashby → SR → Workday → calcareers → usajobs → indeed | unit with mock | after all |
| 6 | CLI + skill SKILL.md | smoke | diff + dry-run |
| 7 | Profile Jared: config migration | manual smoke: 1 resume + 1 CL | visual review |
| 8 | Profile second profile: config migration | manual smoke | visual review |
| 9 | Migration dry-run | review `migration_plan.json` | approve plan |
| 10 | Real migration with checkpoint | manual review of several pages | final approval |
| 11 | `/security-review` + `/review` on full diff | critical issues fixed | final merge |

## Security (S1 — baseline)

### Engine isolation (push model)

The engine is pure functions. Modules in `engine/modules/` (generators, discovery, tracking) have **no** direct access to `profiles/`. Data flows bottom-up: `profile → loader → CLI → engine`.

- **Single read point for `profiles/`** — `engine/core/profile_loader.js`. All other modules receive data as arguments.
- **ID validation**: regex `^[a-z][a-z0-9_-]*$`, `path.resolve` + check that the resolved path is strictly inside `PROFILES_DIR`. No `../` or absolute paths.
- **Per-invocation scope**: a single CLI command invokes the loader exactly once for one profile. Only the active profile's data is loaded into process memory.
- **Secrets**: CLI reads only `${ID.toUpperCase()}_*` env variables. With `--profile jared`, `PROFILE_B_*` tokens are never loaded into memory.
- **Output paths**: generators receive an explicit `outputPath`. The loader verifies the path is inside `profiles/<id>/`. Side effects outside `profiles/<id>/` are prohibited.
- **Grep check** in code review: engine modules must not contain `profiles/`, `readFileSync.*profile`, or hard-coded profile IDs.

For future SaaS (S3) — per-profile processes/containers, OS-level runtime isolation. Overkill for now.

### General S1 rules

- `.env` local only; `NOTION_TOKEN`, `USAJOBS_API_KEY`, `GMAIL_*` never in code.
- `profiles/jared/` and `profiles/profile_b/` fully in `.gitignore`. `profiles/_example/` — synthetic data only.
- `data/*.tsv` in `.gitignore`.
- Before merge: `npm audit` on new dependencies, `/security-review` on the full diff, grep for token patterns (`sk-`, `ntn_`, long base64).
- Incidents → `incidents.md` (blameless format).

## Out of Scope for This Iteration

Deferred to `BACKLOG.md` with date and trigger:
- SQLite/Postgres instead of TSV.
- Pure Notion API without the MCP hybrid.
- Per-profile `.env` files.
- Unified Interview Coach skill.
- Markdown vault export for Obsidian.
- Self-service onboarding for the second profile.
- CI (GitHub Actions).
- Linters (ESLint + Prettier).
- Pre-commit hook.
- License selection.
- GitHub showcase (README demo, screenshots).
