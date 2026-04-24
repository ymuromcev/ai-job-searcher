---
name: job-pipeline
description: "Multi-profile job-search pipeline — scan ATS adapters, validate the pipeline, prepare Inbox jobs (fit scoring, CL gen, Notion push), sync with Notion, and check Gmail for responses. Trigger on: /job-pipeline, /job-pipeline scan, /job-pipeline validate, /job-pipeline sync, /job-pipeline prepare, /job-pipeline check, or when user asks to scan/validate/sync/prepare/check jobs for a specific profile (see the `profiles/` directory for the current list)."
---

# job-pipeline — Multi-profile Job Search Pipeline

Single engine, per-profile data. All commands take `--profile <id>`. Currently supported profiles: **jared**.

## Commands

- **`/job-pipeline scan`** — Discover new jobs across configured ATS adapters (greenhouse / lever / ashby / smartrecruiters / workday / calcareers / usajobs / indeed / remoteok). Append to shared pool + per-profile pipeline.
- **`/job-pipeline validate`** — Pre-flight: TSV hygiene, company-cap check, URL liveness on active applications.
- **`/job-pipeline sync`** — Reconcile per-profile applications with Notion. **Default = dry-run**, must pass `--apply` to commit.
- **`/job-pipeline prepare`** — Two-phase processing of Inbox jobs: mechanical pre-phase (filter / URL check / JD fetch / salary) + Claude LLM phase (geo check / fit score / CL gen / Notion push).
- **`/job-pipeline check`** — Two-phase Gmail response check: `--prepare` builds Gmail search batches for Claude MCP, `--apply` consumes Claude-written emails and updates Notion + TSV + logs.

If no mode is specified, show this help and ask which to run.

---

## Required context per session

Before running any command, verify:

1. **Profile id**. Ask the user which profile (default to `jared` only when explicitly requested).
2. **Working directory** = `ai-job-searcher/` (public repo clone at `~/Desktop/Claude Code/ai-job-searcher/`). All commands resolve `data/` and `profiles/` relative to cwd.
3. **Secrets in env**. For profile `<id>`, the CLI reads `<ID_UPPER>_*` env vars only:
   - `JARED_NOTION_TOKEN` (required for sync)
   - `JARED_USAJOBS_API_KEY`, `JARED_USAJOBS_EMAIL` (required if discovery:usajobs is enabled)
4. **Companies pool**. `data/companies.tsv` must exist. Bootstrap once with:
   ```
   node engine/bin/seed_companies.js
   ```
   (parses 247 targets from the legacy `Job Search/find_jobs.js`).

---

## Step-by-step

### scan

```
node engine/cli.js scan --profile <id> [--dry-run] [--verbose]
```

1. Load `profiles/<id>/profile.json` → enabled discovery modules + filter rules.
2. Load `data/companies.tsv` → group targets by adapter source.
3. Apply per-profile `discovery.companies_whitelist/blacklist`.
4. Invoke each enabled adapter via `engine/core/scan.js` orchestrator (errors per source isolated, do not block the run).
5. Dedupe new jobs against `data/jobs.tsv` master pool by `(source, jobId)`.
6. Atomically write `data/jobs.tsv` + append fresh rows to `profiles/<id>/applications.tsv` with `status="Inbox"`.

`--dry-run` prints planned writes without touching disk.

### validate

```
node engine/cli.js validate --profile <id> [--dry-run]
```

Read-only checks. Exit 0 if clean, 1 if any issue:

- **TSV hygiene** — both `data/jobs.tsv` and `profiles/<id>/applications.tsv` parse cleanly.
- **company_cap** — counts active applications per company against `profile.filter_rules.company_cap.max_active` plus per-company overrides. Active = Inbox / To Apply / Applied / Interview / Offer.
- **URL liveness** — HEAD-pings each active application URL with concurrency 8, falls back to GET on 405/501. Reports any 4xx/5xx/timeout. Skipped under `--dry-run`.

### sync

```
node engine/cli.js sync --profile <id> [--apply] [--verbose]
```

Bidirectional reconcile with the profile's `notion.jobs_pipeline_db_id`:

- **Push** — applications with empty `notion_page_id` and non-Archived status → create Notion pages, persist returned page id back to TSV.
- **Pull** — fetch all Notion pages, match by `key` field (`<source>:<jobId>`), apply Notion's `status` and `notion_page_id` to local TSV (Notion wins on status).

Default mode prints the plan and runs the read-only pull preview. **Pass `--apply` to actually mutate Notion and TSV.**

---

## Failure modes / how to recover

- **`companies pool is empty`** — run `node engine/bin/seed_companies.js` once.
- **`missing JARED_NOTION_TOKEN`** — load it from `~/.bashrc` / `.env`. Token format: `ntn_…`.
- **`adapter source mismatch` or `no adapter for source X`** — profile.json references an unknown discovery module. Either remove from `modules` or add the adapter file.
- **HTTP 429 from greenhouse/lever** — adapters retry with exp backoff up to 3 attempts; on persistent 429, the source is reported in the summary and the rest of the run continues.
- **CalCareers HTML changed** — sanity warn `ResultCount marker missing` indicates upstream changed; investigate `engine/modules/discovery/calcareers.js` regexes.

---

## Anti-patterns — do NOT

- **Do not** run any command without `--profile` — the CLI will refuse and print help.
- **Do not** invoke `sync` without `--apply` and assume it will write — it always defaults to dry-run.
- **Do not** invoke `check --apply` without first running `check --prepare` + the Phase-2 Gmail MCP reads — the script will error on missing `raw_emails.json`.
- **Do not** edit `data/jobs.tsv` or `profiles/<id>/applications.tsv` by hand while a scan is running. Atomic-rename protects against partial writes but not against logical conflicts.
- **Do not** commit `data/` or `profiles/<id>/` to git — both are in `.gitignore` for a reason. Only `profiles/_example/` is committed.
- **Do not** mix profiles in one process. Each CLI invocation loads exactly one profile's secrets — never load `JARED_*` and `PAT_*` together.

### prepare

The `prepare` command is split into two phases: **pre** (mechanical, runs CLI) and the **SKILL phase** (LLM-heavy, Claude executes).

#### Phase 1 — pre (CLI)

```
node engine/cli.js prepare --profile <id> --phase pre [--batch 30] [--dry-run]
```

Runs automatically without Claude. Outputs `profiles/<id>/prepare_context.json` with:
- All Inbox jobs that passed title blocklist + company cap filter.
- URL liveness result per job (`urlAlive`, `urlStatus`).
- JD text from Greenhouse / Lever APIs if available (`jdText`, `jdStatus`).
- Salary range from Company Tier × Role Level (`salary` object or null).
- `skipped` list with reasons (filter blocked / URL dead).
- `stats` summary.

#### Phase 2 — SKILL (Claude executes)

After the CLI writes `prepare_context.json`, the user invokes `/job-pipeline prepare`. Claude then:

**Step 1 — Load memory**

Read before anything else:
- `profiles/<id>/memory/user_writing_style.md`
- `profiles/<id>/memory/user_resume_key_points.md`
- Any `profiles/<id>/memory/feedback_*.md` files

If memory files are missing: fall back to `profiles/<id>/resume_versions.json`.

**Step 2 — Read prepare_context.json**

```
Read profiles/<id>/prepare_context.json
```

Report stats: `inboxTotal` / `afterFilter` / `inBatch` / `urlAlive` / `urlDead`. Ask user to confirm before proceeding if batch is larger than 10.

**Step 3 — Geo validation (per job)**

For each job in `batch` where `urlAlive = true`:

Use WebFetch on the job URL (or `jdText` if already fetched) to confirm the role is US-compatible:
- Allowed: Remote / Remote USA / Worldwide / no location restriction.
- Excluded: Europe-only, UK-only, India-only, EMEA, APAC, or any explicit non-US restriction.
- If `jdText` is present: scan it directly (no WebFetch needed).
- If URL is dead or JD unavailable: mark `geo = "unknown"`, proceed.

**Step 4 — Fit scoring (per job)**

Apply **Fit Score** rules from `## Global Guard Rails` below. Assign one of: `Strong` / `Medium` / `Weak`.

Write a 1-sentence fit rationale (concrete domain overlap, not generic praise). This goes into the Notion `Notes` field.

Early-startup modifier: if company is pre-Series B or <50 employees — downgrade one level.

**Step 5 — Filter: geo + fit**

Skip (mark `decision: "skip"`) any job where:
- `geo` is confirmed non-US, OR
- `fitScore` is `Weak`

Report skipped jobs with reason to the user before continuing.

**Step 6 — Salary (auto-fill)**

For each remaining job:
- If `prepare_context.batch[i].salary` is non-null: use it as-is.
- If null (unknown company tier): flag to user, do NOT invent a range.

**Step 7 — Archetype selection (per job)**

Choose the best resume archetype from `profiles/<id>/resume_versions.json` for this specific role. Prefer the archetype whose domain keywords overlap most with the JD / job title.

Record `resumeVer` = archetype key (e.g. `"fintech-pm-v3"`).

**Step 8 — Cover letter generation (per job)**

Apply **Humanizer Rules** from `## Humanizer Rules` below throughout.

Structure (3 paragraphs + optional 4th):
1. **Hook** — Specific domain signal from the JD + candidate's most relevant achievement with a number. No "I am writing to express…" opener.
2. **Core fit** — 2-3 concrete points showing domain/skill match. Each with a metric or outcome.
3. **Why this company** — 1-2 genuine reasons based on the JD / company context. No hollow mission-statement praise.
4. **(Optional) Forward bridge** — Only if something unusual or genuinely compelling can be said. Skip if forcing it.

Close: brief, confident, no "excited to" or generic enthusiasm.

Save the CL as `profiles/<id>/cover_letters/<company>_<role-slug>_<YYYYMMDD>.md`.

Record `clKey` = filename without extension.

**Step 9 — Notion page creation (per job)**

For each job where `decision = "to_apply"`:

**9a. Resolve Company relation.** Query `profile.notion.companies_db_id` for the company by name (title match). If found — use that page id. If not — create a new Company page with `Name` = company and `Tier` from `profile.company_tiers[name]` (if known), then use the new page id.

Create a Notion page in `profile.notion.jobs_pipeline_db_id` with ALL required fields (see Notion Field Completeness in Guard Rails):
- **Title** — job title
- **Company** — relation (array with the page id from 9a)
- **Status** — "To Apply"
- **Fit Score** — Strong / Medium (from Step 4)
- **URL** — from `url`
- **Source** — from `source`
- **Date Added** — today (YYYY-MM-DD)
- **Work Format** — from JD or job listing
- **City** — from JD (or "Remote")
- **State** — from JD (or `"Any"` when unspecified / remote US-wide)
- **Notes** — fit rationale from Step 4
- **Salary Expectations** — display string like `"$140-190K ($165K mid)"`
- **Salary Min** — numeric dollar amount (e.g., 140000)
- **Salary Max** — numeric dollar amount (e.g., 190000)
- **Cover Letter** — filename stem (same as `clKey`), e.g. `Affirm_analyst-ii-credit-risk-analytics_20260420`
- **Resume Version** — select, from `resumeVer`

`Industry` is a **rollup** — do NOT set it. It is inherited automatically from the Company relation.

Record the returned `notion_page_id`.

**Step 10 — Write results file**

Write `profiles/<id>/prepare_results_<YYYYMMDD_HHMMSS>.json`:

```json
{
  "profileId": "<id>",
  "generatedAt": "<ISO timestamp>",
  "results": [
    {
      "key": "<source>:<jobId>",
      "decision": "to_apply",
      "fitScore": "Strong",
      "fitRationale": "...",
      "geo": "us-compatible",
      "clKey": "<company>_<role-slug>_<YYYYMMDD>",
      "clPath": "<company>_<role-slug>_<YYYYMMDD>.md",
      "resumeVer": "<archetype-key>",
      "notionPageId": "<uuid>",
      "salaryMin": 140000,
      "salaryMax": 190000
    },
    {
      "key": "<source>:<jobId>",
      "decision": "skip",
      "fitScore": "Weak",
      "fitRationale": "...",
      "geo": "us-compatible"
    }
  ]
}
```

**Step 11 — Commit phase (CLI)**

```
node engine/cli.js prepare --profile <id> --phase commit \
  --results-file profiles/<id>/prepare_results_<timestamp>.json
```

This updates `applications.tsv`: `to_apply` entries get `status="To Apply"`, `cl_key`, `cl_path`, `resume_ver`, `notion_page_id`, `salary_min`, `salary_max`. Run with `--dry-run` first to preview.

**Step 12 — Report to user**

Summarize:
- N jobs moved to "To Apply"
- N jobs skipped (geo / weak fit) with list
- N CLs written (paths)
- N Notion pages created
- Any warnings or anomalies

---

## Failure modes / how to recover (prepare-specific)

- **`prepare_context.json` missing** — run `--phase pre` first.
- **`jdText` is null for many jobs** — Greenhouse / Lever API may have changed; investigate `engine/core/jd_cache.js`. Geo + fit can still run from the job title + company name.
- **Notion page creation fails** — check `JARED_NOTION_TOKEN` env var and that the DB id in `profile.json` is correct. Re-run the SKILL for the failed jobs only (skip already-created ones by key).
- **Unknown company tier (salary = null)** — add the company to `profile.json.company_tiers` or `profiles/<id>/salary_matrix.md` and re-run `--phase pre`.

### check

Two-phase Gmail response checker. Reads are delegated to Claude via Gmail MCP — the script never touches OAuth.

#### Phase 1 — prepare (CLI)

```
node engine/cli.js check --profile <id> --prepare [--since <ISO>]
```

Builds a search plan without hitting Gmail:

1. Loads `profiles/<id>/applications.tsv` → picks rows where `status ∈ {Applied, To Apply, Interview, Onsite, Offer}` AND `notion_page_id` is set → forms `activeJobsMap`.
2. Computes cursor epoch: `saved.last_check` or `--since` ISO, clamped to 30 days ago.
3. Emits Gmail query batches (10 companies/batch + fixed LinkedIn batch + fixed recruiter batch).
4. Writes `profiles/<id>/.gmail-state/check_context.json`.
5. Prints JSON: `{ epoch, batches, processedIds }`.

#### Phase 2 — Gmail reads (Claude via MCP)

Claude executes in parallel:

1. For each `batches[i]` → call Gmail MCP `search_threads` with the query + `pageSize: 50`.
2. Collect all `messageId` values across threads, dedupe, remove any already in `processedIds`.
3. For each new `messageId` → call `gmail_read_message` in parallel. Build per-email object:
   ```json
   {
     "messageId": "...",
     "subject": "<headers.Subject>",
     "from": "<headers.From>",
     "date": "<headers.Date>",
     "body": "<body>"
   }
   ```
4. Write the array to `profiles/<id>/.gmail-state/raw_emails.json` via Write tool.

If 0 new IDs found → write `[]` and proceed (Phase 3 still runs to bump `last_check`).

#### Phase 3 — apply (CLI)

```
node engine/cli.js check --profile <id> [--apply]
```

Default is dry-run (plan only, no Notion writes, no TSV mutations). With `--apply`:

1. Reads `raw_emails.json` + `check_context.json`.
2. Filters out messages already in `processed_messages.json`.
3. Branches per email:
   - **LinkedIn job alert** (`from:jobalerts-noreply@linkedin.com`) → add to Inbox in TSV.
   - **Recruiter outreach** (subject matches recruiter keywords): if sender's company is in pipeline → Inbox; otherwise → `recruiter_leads.md` only.
   - **Normal pipeline** → `classifier.js` assigns one of: `REJECTION`, `INTERVIEW_INVITE`, `INFO_REQUEST`, `ACKNOWLEDGMENT`, `OTHER`. Then `email_matcher.js` resolves to a pipeline (company, role) tuple.
4. Plans Notion actions per match:
   - `REJECTION` → `Status → Rejected` + add comment.
   - `INTERVIEW_INVITE` → `Status → Interview` + add comment. (Notion DB only has `Interview` — do NOT push `Phone Screen` / `Onsite`.)
   - `INFO_REQUEST` → comment only (no status change).
   - Skips any row whose current status is `Rejected` / `Closed`.
5. With `--apply`: calls `updatePageStatus` + `addPageComment` via Notion SDK v5; appends to `profiles/<id>/rejection_log.md`, `recruiter_leads.md`, `email_check_log.md`; writes `processed_messages.json`; saves TSV.

#### Failure modes (check-specific)

- **`raw_emails.json` missing** — Phase 2 didn't run or Claude didn't write the file. Re-do Phase 2.
- **Notion 400 on status push** — a status option doesn't exist in the DB (e.g. tried pushing `Phone Screen`). The mapping lives in `engine/commands/check.js` — keep it in sync with the DB's `Status` select options.
- **Cursor epoch stuck at 30d** — `last_check` was never saved (all prior `--apply` runs were dry-run). Override with `--since <ISO>` once, then `--apply` will bump `last_check`.

---

## Global Guard Rails (prepare / answer modes)

These rules apply whenever Claude generates content or makes pipeline decisions. They reference per-profile config — do not hardcode profile-specific values here.

### Level Filter

Single source of truth: `profiles/<id>/filter_rules.json` → `title_blocklist.patterns` and `location_blocklist.patterns`. Applied as **case-insensitive substring matches** against the full title string. Never hardcode level checks inline — add/remove patterns in `filter_rules.json` only.

When a new over-level title slips into Inbox after a scan: add the pattern to `filter_rules.json → title_blocklist.patterns` with a `reason`, then re-run `node engine/cli.js validate --profile <id>` to surface existing Inbox rows that match.

### Company Cap

Config: `profiles/<id>/filter_rules.json → company_cap.max_active` (with optional `company_cap.overrides` per company). Active statuses: `Inbox`, `To Apply`, `Applied`, `Interview`, `Offer`.

Cap is enforced at **prepare time only** — scan always lets all jobs through. If a company already has ≥ cap active rows, excess Inbox jobs stay as Inbox (not archived); they are skipped for the current prepare run and re-evaluated next time.

### Fit Score (domain fit only)

Level does NOT affect fit score. Evaluate by domain match to the candidate's profile:

- **Strong** — core domain match (see `profiles/<id>/memory/user_resume_key_points.md` for domain specifics) plus a relevant tech or product component
- **Medium** — adjacent domain, or right domain with lesser location/format fit, or outside core domain but with a key component overlap (AI/ML, data platform, payments)
- **Weak** — outside core domain with no overlapping component
- **Early-startup modifier** (pre-Series B, <50 people): downgrade one level (Strong→Medium, Medium→Weak)

Profile-specific domain criteria: `profiles/<id>/memory/user_resume_key_points.md`.

### Salary Expectations (auto-fill at prepare time)

Determined automatically from **Company Tier × Role Level**. No JD salary analysis needed.

Level parsing rules (from title):
- "Lead" → Lead
- "Senior" / "Sr." / "Sr " → Senior
- Capital One-style "Manager, Product Management" → Senior
- Everything else → PM (mid)

Tier adjustment: +7.5% if hybrid/onsite in SF/NYC.

Salary matrix: `profiles/<id>/salary_matrix.md`. Company Tier values are stored per-company in the profile's Notion Companies DB and in `profile.json`.

### Notion Field Completeness

Every Notion job page MUST have ALL of: Role, Company (relation — not empty), Status, Fit Score, Job URL, Source, Date Added, Work Format, City, State, Notes (fit rationale — never batch labels), Salary expectations.

Per-profile Notion DB id: `profile.json → notion.jobs_pipeline_db_id`.

---

## Humanizer Rules (prepare / answer modes)

Apply **during** CL or answer generation — not as a separate post-pass.

### Voice calibration

Match the profile's writing style from `profiles/<id>/memory/user_writing_style.md`. Defaults:
- Confident practitioner, not humble applicant. "I built X that delivered Y" — not "I was responsible for X."
- 7/10 formality: professional with energy and momentum.
- Have opinions; react to facts rather than just reporting them.
- Use "I" naturally — first person is honest, not unprofessional.
- Numbers in every paragraph except the close.
- Short paragraphs (2-3 sentences). Vary rhythm: short punchy sentences mixed with longer ones.
- Be specific: concrete details over vague claims.

### Banned vocabulary (AI tells)

**Never use**: `delve`, `landscape`, `foster`, `underscore`, `pivotal`, `crucial`, `showcase`, `tapestry`, `testament`, `interplay`, `intricate`.

**No copula avoidance**: use `is`/`are`/`has` instead of `serves as`/`stands as`/`boasts`.

**No significance inflation**: no "marking a pivotal moment", "reshaping", "setting the stage".

**No superficial -ing phrases**: no "highlighting", "underscoring", "ensuring", "reflecting".

**No em dash overuse**: use commas, periods, or parentheses instead.

**No rule-of-three**: don't force ideas into groups of three.

**No negative parallelisms**: no "It's not just X, it's Y".

**No generic closers**: no "exciting times", "the future looks bright".

**No hedging**: no "potentially", "it could be argued".

**No filler**: no "in order to", "it is important to note", "due to the fact that".

**No opener clichés**: no "Dear Hiring Manager, I am writing to express my interest…", no "I am passionate about [mission]", no "excited to".

### Final anti-AI check

After writing, ask: "What makes this obviously AI-generated?" — fix any remaining tells before saving.

### Memory files (load before generating)

In every prepare / answer session:
1. `profiles/<id>/memory/user_writing_style.md` — writing style profile
2. `profiles/<id>/memory/user_resume_key_points.md` — skills / experience for matching
3. Any other feedback files in `profiles/<id>/memory/` (e.g., `feedback_*.md`)

If memory files are missing: fall back to `profiles/<id>/resume_versions.json` as the source of truth for the candidate's experience. Always ask the user which archetype is most relevant rather than improvising facts.
