# Architecture

AI Job Searcher is a multi-profile job-search pipeline. A single Node engine
drives discovery, filtering, generator output, and Notion sync for any number
of independent candidate profiles. Profile data (configs, resumes, TSV
state, Notion DB ids) lives under `profiles/<id>/`; the engine treats each
profile as a parameter, never a hard-coded identity. Operators run commands
locally; Notion is the human-facing UI; Gmail polling is delegated to a
Claude MCP session because no OAuth lives on disk.

## C4 L1 — System context

```mermaid
graph LR
  Operator((Operator))
  Engine[AI Job Searcher engine]
  Notion[(Notion workspace)]
  Gmail[(Gmail inbox<br/>via Claude MCP)]
  ATS[(ATS sources<br/>Greenhouse / Lever / Ashby / Workday / USAJOBS / RemoteOK / ...)]
  FS[(Local filesystem<br/>profiles/, data/)]

  Operator -->|CLI commands| Engine
  Engine -->|push pages, comments, status| Notion
  Notion -->|pull status changes| Engine
  Engine -->|prepare batches / read raw_emails| Gmail
  Engine -->|read public job listings| ATS
  Engine <-->|read configs, write TSV + artifacts| FS
```

The operator is the only human in the loop — they author profile configs,
trigger commands, and review generated artifacts before submitting. ATS
sources are read-only (public APIs and feeds). Notion is bidirectional:
the engine creates and updates pages; the operator hand-edits status and
notes that the engine pulls back into TSV. Gmail is read-only and goes
through Claude MCP, not a direct API binding.

## C4 L2 — Containers

```mermaid
graph TB
  subgraph Engine
    CLI[engine/cli.js<br/>command router]
    Discovery[engine/modules/discovery/*<br/>ATS adapters]
    Generators[engine/modules/generators/*<br/>resume DOCX/PDF, CL PDF]
    Core[engine/core/*<br/>filter, dedup, validator,<br/>notion_sync, fit_prompt,<br/>profile_loader, jd_cache,<br/>url_check, salary_calc,<br/>classifier, email_*]
  end

  subgraph Data
    Profiles[(profiles/&lt;id&gt;/<br/>configs + TSV + artifacts)]
    Shared[(data/<br/>jobs.tsv, companies.tsv)]
  end

  CLI --> Discovery
  CLI --> Generators
  CLI --> Core
  Discovery --> Core
  Generators --> Core
  Core <--> Profiles
  Core <--> Shared
```

Profile is data; engine is service. Adding a new candidate is a directory
under `profiles/` plus a row of namespaced env vars in `.env`; no engine
code changes.

## Data stores

| Store | Scope | Role |
|---|---|---|
| `profiles/<id>/applications.tsv` | per-profile | Canonical pipeline state. Status, fit, salary, paths to generated CL and resume, Notion page id. |
| `data/jobs.tsv` | shared | Cross-profile dedup pool keyed by `(ats_source, job_id)`. No PII. |
| `data/companies.tsv` | shared | Master company pool with ATS slugs. Populated as profiles discover new vendors. |
| `profiles/<id>/` Notion Jobs DB | per-profile | Operator-facing card board. Bidirectional sync. |
| `profiles/<id>/` Notion Companies DB | per-profile | Tier table; relation target for Jobs.Company. |
| `profiles/<id>/` Notion aux DBs | per-profile | Application Q&A bank, Job Platforms registry. |

TSV schema history (v1 → v2 → current) lives in
[docs/reference/tsv-schema.md](docs/reference/tsv-schema.md).

## Where to look next

| Question | Document |
|---|---|
| Why multi-profile in the first place? | [ADR-001 Multi-profile architecture](docs/architecture/adrs/001-multi-profile.md) |
| How data moves between TSV, Notion, Gmail | [data-flow.md](docs/architecture/data-flow.md) |
| C4 L3 — module-by-module breakdown | [overview.md](docs/architecture/overview.md) |
| What every CLI flag does | [cli.md](docs/reference/cli.md) |
| How to onboard a new profile | [new-profile.md](docs/runbooks/new-profile.md) |
| Profile isolation rules | [multi-profile.md](docs/architecture/multi-profile.md) |
| Active design proposals | [rfc/README.md](rfc/README.md) |
