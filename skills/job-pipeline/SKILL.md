---
name: job-pipeline
description: "Multi-profile job-search pipeline — scan ATS adapters, validate the pipeline, prepare Inbox jobs (fit scoring, CL gen, Notion push), sync with Notion, check Gmail for responses, and answer application Q&A questions with reuse from a Notion-backed answer bank. Trigger on: /job-pipeline, /job-pipeline scan, /job-pipeline validate, /job-pipeline sync, /job-pipeline prepare, /job-pipeline check, /job-pipeline answer, or when user asks to scan/validate/sync/prepare/check/answer jobs for a specific profile (see the `profiles/` directory for the current list)."
---

# job-pipeline — Multi-profile Job Search Pipeline

Single engine, per-profile data. All commands take `--profile <id>`. Currently supported profiles: **jared**.

## Commands

- **`/job-pipeline scan`** — Discover new jobs across configured ATS adapters (greenhouse / lever / ashby / smartrecruiters / workday / calcareers / usajobs / indeed / remoteok). Append to shared pool + per-profile pipeline.
- **`/job-pipeline validate`** — Pre-flight: TSV hygiene, company-cap check, URL liveness on active applications.
- **`/job-pipeline sync`** — Reconcile per-profile applications with Notion. **Default = dry-run**, must pass `--apply` to commit.
- **`/job-pipeline prepare`** — Two-phase processing of `Inbox` jobs (RFC 014): mechanical pre-phase (filter / URL check / JD fetch / salary) + Claude LLM phase (geo check / fit score / CL gen / Notion push). Commit transitions row from `Inbox` → `To Apply` (decision=to_apply) or `Inbox` → `Archived` (decision=archive).
- **`/job-pipeline check`** — Two-phase Gmail response check: `--prepare` builds Gmail search batches for Claude MCP, `--apply` consumes Claude-written emails and updates Notion + TSV + logs.
- **`/job-pipeline indeed-prep`** — Phase 1 of Indeed ingest. Prints scan URLs + JS extraction snippet + filter context for the Claude browser MCP session. Phase 2 (browser fetch) is manual via Chrome MCP. Phase 3 = standard `scan` (the indeed adapter ingests the file Claude wrote).
- **`/job-pipeline answer`** — Generate or reuse application answers (Why join? / Influences? / Motivation? etc.). Three-phase: search Notion Q&A DB by dedup key → reuse if exact match else generate via Humanizer Rules → push answer back to Notion + write local `.md` backup. Per-profile DB at `profile.notion.application_qa_db_id`.

If no mode is specified, show this help and ask which to run.

---

## Required context per session

Before running any command, verify:

1. **Profile id — resolution policy**:
   - **Default profile is `jared`**. If the user invokes `/job-pipeline <cmd>` cold with no profile hint, use `jared` and do NOT ask.
   - **NLP extraction**: if the user's phrase mentions another profile by name (e.g. "для Лили", "scan Lilia's pipeline", "Lilia profile"), extract that name, lowercase it, map it to the matching `profiles/<id>/` directory, and use it. Valid profiles = subdirectories of `profiles/` (excluding `_example`).
   - **Session-sticky**: once a non-default profile is resolved in a session, keep using it for subsequent commands in the same session. Switch back to `jared` only on an explicit phrase like "switch to Jared" / "для Джареда".
   - **Ask only when ambiguous**: if the phrase mentions a name that doesn't match any profile dir, ask once (list valid profiles), then stick.
   - Always pass the resolved id to the CLI via `--profile <id>`.
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
6. Atomically write `data/jobs.tsv` + append fresh rows to `profiles/<id>/applications.tsv` with `status="Inbox"` (RFC 014 — TSV-only state for fresh-after-scan rows; transitions to `To Apply` after `prepare --phase commit decision=to_apply`). Notion DBs never see `Inbox` — they keep the 8-status set.

`--dry-run` prints planned writes without touching disk.

### validate

```
node engine/cli.js validate --profile <id> [--dry-run]
```

Read-only checks. Exit 0 if clean, 1 if any issue:

- **TSV hygiene** — both `data/jobs.tsv` and `profiles/<id>/applications.tsv` parse cleanly.
- **company_cap** — counts active applications per company against `profile.filter_rules.company_cap.max_active` plus per-company overrides. Active = `To Apply` / `Applied` / `Interview` / `Offer`. (`Inbox` is intentionally excluded — those rows are pre-triage and may yet be archived.)
- **URL liveness** — HEAD-pings each active application URL with concurrency 8, falls back to GET on 405/501. Reports any 4xx/5xx/timeout. Skipped under `--dry-run`.

### sync

```
node engine/cli.js sync --profile <id> [--apply] [--verbose]
```

Bidirectional reconcile with the profile's `notion.jobs_pipeline_db_id`:

- **Push** — bare push from `sync` is **disabled** (legacy). Notion pages are created exclusively by `prepare --phase commit decision=to_apply`, which assembles fit + CL + salary + Notion page atomically. `sync` is pull-only.
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
- **Do not** generate a new application answer without first running `answer --phase search` and inspecting matches. Reuse before regenerate is the rule for `/job-pipeline answer`.
- **Do not** push an answer to the Notion Q&A DB without an explicit user approval signal (`пойдет` / `good` / `submitted` / `залил`). Same shared-state rule as the cover-letter flow.
- **Do not** invent new Q&A categories. Use one of the 8 canonical names from the DB; the categorizer picks a default automatically.

### prepare

`prepare` is **autonomous** (BL-9 Step 5, 2026-05-05). The user invokes `/job-pipeline prepare` once. Claude orchestrates a multi-iteration loop that calls the CLI repeatedly and judges batches, until either the target (30 jobs in Notion) is met or the Inbox is exhausted. Then a single push to Notion finalizes the result.

The loop has three phases of CLI invocation, all using the same `prepare_context.json` file:

| Mode | Source pool | When |
|---|---|---|
| `--mode fresh` | Inbox rows that pass blocklist / cap / URL-check (the standard pipeline) | First iteration of every run |
| `--mode topup` | `deferredQueue` (rows that passed filter but didn't fit the previous batch) | Iterations 2–3 if Strong+Medium < 30 |
| `--mode weak-fallback` | `deferredQueue` + already-Weak Inbox rows in TSV | After 3 iterations if Strong+Medium still < 30 |

#### Phase 1 — pre (CLI, called by Claude)

```
node engine/cli.js prepare --profile <id> --phase pre --mode <fresh|topup|weak-fallback> [--batch 30] [--need K] [--dry-run]
```

Runs without LLM cost. Outputs `profiles/<id>/prepare_context.json`:
- `batch[]` — jobs ready for SKILL judgement (URL-checked, JD-fetched, salary computed). Topup / weak-fallback APPEND to this array.
- `batch[i].wasAlreadyWeak: true` (weak-fallback only) — row was judged Weak in a prior run; carry over `priorFitScore` / `priorFitRationale` instead of re-judging.
- `deferredQueue[]` — TSV keys that passed the filter pipeline but weren't URL-checked yet (used by the next topup / weak-fallback call).
- `skipped[]` — engine-level skip reasons (`company_cap` / `title_blocklist` / `url_dead` / `already_evaluated_weak` / etc.).
- `stats.inboxExhausted: bool` — true when no more fresh rows remain in TSV outside the current batch (excluding `duplicate`-flagged rows). The loop must stop iterating when this flips true.
- `stats.skipReasons` / `stats.deferred` / `stats.weakFallbackRuns` etc.

#### Phase 2 — autonomous loop (Claude orchestrates)

When the user invokes `/job-pipeline prepare`, Claude runs the following loop. **Loop logic lives in the SKILL; the engine is stateless.**

```text
Step A — initialize
  iteration = 0
  verdicts = { strong: [], medium: [], weak: [] }    # per-job evaluation buckets
  Run: prepare --phase pre --mode fresh --batch 30
  Read: profiles/<id>/prepare_context.json

Step B — per-iteration evaluation loop (chase Strong)
  while True:
    iteration += 1
    new_entries = batch entries we haven't judged yet
    For each entry in new_entries:
      run Steps 1, 3, 4, 5, 5.7, 6, 7, 8 (fit + CL gen, NOT Notion push)
      append to verdicts[<fitScore-bucket>]

    # Stop conditions — keep iterating to chase more Strong even if
    # Medium is plentiful. Selection priority is Strong → Medium → Weak,
    # so 30 pure Strong always beats 15 Strong + 15 Medium.
    if len(verdicts.strong) >= 30: break
    if stats.inboxExhausted: break
    if iteration >= 3: break

    # Topup — try to find more Strong (need = how many Strong we still want)
    Run: prepare --phase pre --mode topup --need (30 - len(verdicts.strong))
    Re-read prepare_context.json → continue

Step C — weak fallback (only if needed)
  strongMedium = len(verdicts.strong) + len(verdicts.medium)
  if strongMedium < 30 AND NOT stats.inboxExhausted:
    Run: prepare --phase pre --mode weak-fallback --need (30 - strongMedium)
    Re-read prepare_context.json
    new_entries = batch entries not yet judged
    For each entry:
      if entry.wasAlreadyWeak:
        # Reuse saved verdict, do NOT spend tokens re-judging
        fitScore = entry.priorFitScore  (always "Weak")
        fitRationale = entry.priorFitRationale
        skip Step 4
        run Steps 7, 8 (CL gen) so the row is push-ready
        append to verdicts.weak
      else:
        run Steps 1, 3, 4, 5, 5.7, 6, 7, 8 as usual

Step D — pick top 30 by sequential priority
  # Sequential fill: take ALL Strong first, then Medium to fill, then Weak.
  # Mediums never bump Strongs; Weaks never bump Mediums.
  candidates = verdicts.strong + verdicts.medium + verdicts.weak  (in that order)
  final = candidates[:30]
  if len(final) < 30:
    warn user: "only N candidates found, push N instead of 30"

Step E — push final to Notion
  For each job in `final`: run Step 9 (Notion page creation)

Step F — write results + commit
  Step 10: write prepare_results_<timestamp>.json
    decision = "to_apply" for each job in `final`
    decision = "skip" for everything else evaluated this run (carries fitScore so the
               row gets persisted to TSV and won't be re-judged next prepare run)
  Step 11: prepare --phase commit --results-file <path>
  Step 12: report to user
```

**Stdout per iteration** (mirror this format so the user sees progress):

```
prepare loop iteration 1/3: 30 candidates → 8 Strong, 12 Medium, 10 Weak
prepare loop iteration 2/3: 27 new candidates → 5 Strong, 9 Medium, 13 Weak
prepare loop iteration 3/3: 21 new candidates → 2 Strong, 9 Medium, 10 Weak
loop done: 15 Strong, 30 Medium, 33 Weak (target 30)
selecting top 30: 15 Strong + 15 Medium → push to Notion
```

If `weak-fallback` runs:

```
strong+medium below target (8+5=13 of 30); falling back to weak…
weak-fallback: pulled 17 entries (12 already-Weak, 5 fresh)
final: 8 Strong + 5 Medium + 17 Weak = 30 → push to Notion
```

If `inboxExhausted`:

```
loop done: 4 Strong, 7 Medium (Inbox exhausted)
warn: only 11 candidates found, push 11 instead of 30
selecting all 11 (4 Strong + 7 Medium) → push to Notion
```

#### Anti-patterns — do NOT

- **Do not** push to Notion (Step 9) inside the iteration loop. Push happens ONCE on the top-30 final list (Step E above). Otherwise we'd create 60–90 Notion pages and only some would be marked final.
- **Do not** re-judge `entry.wasAlreadyWeak === true` rows in Step 4. The verdict is already in TSV; re-asking burns tokens. Carry `priorFitScore` / `priorFitRationale` straight into the verdict bucket.
- **Do not** keep iterating past 3 even if Strong < 30 and Inbox isn't exhausted. The cap is by design — token budget protection. After 3, the SKILL falls back to weak.
- **Do not** stop the loop just because Strong+Medium ≥ 30. Selection priority is Strong → Medium → Weak; we keep iterating to find more Strong (Mediums don't satisfy the target). Stop only on Strong ≥ 30, iter ≥ 3, or `inboxExhausted`.
- **Do not** terminate the loop early just because iteration N had 0 Strong. Strong from later iterations can still hit the target; keep going until one of the three stop conditions is true.
- **Do not** invoke `--mode topup` or `--mode weak-fallback` directly without first running `--mode fresh` (or another mode) to seed `prepare_context.json`. Topup / weak-fallback exit 1 if the context file is missing.

The reference for each Step (1, 3, 4, 5, 5.7, 6, 7, 8, 9, 10, 11, 12) is below — these describe the per-job evaluation logic that the loop above orchestrates.

After the CLI writes `prepare_context.json`, Claude then:

**Step 1 — Load memory**

Read `profiles/<id>/prepare_context.json` first. The `memory` block (populated by `profile_loader` from `profile.json.memory`) contains:
- `memory.writingStyle` — content of `profiles/<id>/memory/user_writing_style.md`
- `memory.resumeKeyPoints` — content of `profiles/<id>/memory/user_resume_key_points.md`
- `memory.feedback` — array of `{file, content}` for each `feedback_*.md` under the configured dir

Use those strings directly. If `memory.writingStyle` or `memory.resumeKeyPoints` is `null`, the per-profile file is missing — fall back to `profiles/<id>/resume_versions.json` and `profiles/<id>/cover_letter_template.md` for tone hints. Do **not** re-read the memory files from disk — the engine already loaded them.

**Step 2 — Read prepare_context.json**

```
Read profiles/<id>/prepare_context.json
```

Report stats: `inboxTotal` / `afterFilter` / `inBatch` / `urlAlive` / `urlDead`. Proceed without confirmation — the CLI's `--batch N` flag already gates batch size; Claude does not re-prompt the user. Default is 30; adjust by re-running pre-phase with a different `--batch`.

**Step 3 — Geo decision (now profile-driven, L-4 / RFC 013)**

The engine pre-phase already enforces `profile.geo` policy and surfaces the result on every batch entry. **Read `prepare_context.batch[i].geo_decision` — do NOT WebFetch for geo.**

For each job in `batch`:
- `geo_decision === "allowed"` → proceed to Step 4. The `geo_matched_by` field describes WHY it passed (`"city:Sacramento"` / `"remote"` / `"country:US"` / `"unrestricted"`) — useful when generating the fit rationale.
- `geo_decision === "rejected"` → already pruned by engine. You won't see it in `batch[]` (it's in `prepare_context.skipped[]` with reason `"geo_metro_miss"` / `"geo_country_miss"` / `"geo_remote_only_miss"` / `"geo_blocklist"` / `"geo_no_location"`). The `stats.skipReasons` breakdown shown in Step 12 includes geo-counters.
- `geo_decision` field absent (legacy `prepare_context.json` from before L-4 migration, or profile without `profile.geo` block) → fallback: WebFetch JD location, apply simple US-policy as before. Engine version post-2026-05-04 always populates `geo_decision`.

**Step 4 — Fit scoring (per job)**

Apply **Fit Score** rules from `## Global Guard Rails` below. Assign one of: `Strong` / `Medium` / `Weak`.

Write a 1-sentence fit rationale (concrete domain overlap, not generic praise). This goes into the Notion `Notes` field.

Early-startup modifier: if company is pre-Series B or <50 employees — downgrade one level.

**Step 5 — Bucket: fit (loop-aware)**

Geo filtering already happened in the engine pre-phase (Step 3 is read-only) — only entries with `geo_decision === "allowed"` reach the batch. The remaining gate is fit.

In the autonomous loop (Step B above), assign every judged job to one of three in-memory buckets — `verdicts.strong` / `verdicts.medium` / `verdicts.weak` — based on `fitScore`. **Do NOT mark anything `decision="skip"` yet.** The final skip / to_apply call is made in Step E once the top-30 is picked.

If the entry has `wasAlreadyWeak: true`, it goes straight to `verdicts.weak` with `fitScore="Weak"` carried over from `entry.priorFitScore`. No Step 4 re-judging.

Report iteration counts to the user (per the stdout format in Phase 2 above): how many landed in each bucket per iteration, what the running total is.

**Step 5.7 — Auto-tier unknown companies**

If `prepare_context.unknownTierCompanies` is non-empty, assign each company a tier (`S` / `A` / `B` / `C`). Do **not** prompt the user — the user never tiers companies manually; this is your job.

**Tier criteria** (read profile-flavor-aware):

| Tier | Jared (PM / fintech-leaning) | Lilia (healthcare RN) |
|---|---|---|
| **S** | Public big-tech / top fintech, $10B+ market cap, top brand recognition. AI-native or strong AI investment. | Major regional health systems (Kaiser, UC Davis, Sutter, Dignity), 10K+ employees, full benefits, RN union presence. |
| **A** | Late-stage / public mid-cap. Strong funding, well-known brand. AI presence non-trivial. | Large medical foundations / dialysis chains / managed care. 1K+ employees, multi-site. |
| **B** | Growth-stage Series C–E, $1–5B valuation. Recognized in their sector. | Specialty clinic chains (eye, dental, dermatology). Multi-location, regional reach. |
| **C** | Early/mid-stage Series A–B, <$1B. Less known. | Small private practices, single-clinic operations, local services. |

**Sources of signal** (use freely, in this order):
1. Company name recognition + general knowledge (size, valuation, funding round).
2. `jdText` if present — funding mentions, employee count, "Series X", "publicly traded".
3. WebFetch the company website / Crunchbase / LinkedIn for ambiguous cases (one extra fetch per unknown company is fine).

**Output**: every name from `unknownTierCompanies` MUST appear in `results.companyTiers` with a value in `{"S","A","B","C"}`. Don't skip companies — the engine treats absence as "still unknown" and the next prepare run will re-ask.

After tiering, the engine will persist the assignments to `profile.json.company_tiers` on commit (one-shot per company). It also uses them to set the Notion Companies DB `Tier` field on first push.

**Step 6 — Salary (auto-fill)**

For each remaining job:
- If `prepare_context.batch[i].salary` is non-null: use it as-is.
- If `salary` is null AND the entry has `unknownTier: true`: look up the tier you just assigned in Step 5.7, then use `prepare_context.salaryConfig` (per-profile matrix + level parser + COL config from `profile.json.salary`). When `salaryConfig` is null the engine's default fintech-PM matrix in `engine/core/salary_calc.js` applies. Pick the row at Tier × Level (level = engine `parseLevel(title, salaryConfig.levelParser)`). Compute `salaryMin` / `salaryMax` from the matrix and apply the COL adjustment defined in `salaryConfig.colAdjustment` (defaults: SF/NYC +7.5% unless Remote).
- If `salary` is null AND `unknownTier` is **not** true: this means the tier is known but the matrix doesn't cover the level — flag to user with the company name and title, do NOT invent a range.

**Step 7 — Archetype selection (per job)**

Choose the best resume archetype from `profiles/<id>/resume_versions.json` for this specific role. Prefer the archetype whose domain keywords overlap most with the JD / job title.

**Mandatory validation**: `resumeVer` MUST be a key that literally exists in `profile.resume_versions.versions`. Do NOT invent or paraphrase a key. If no archetype is a clear match, pick the closest existing key (or the profile's `default` if defined) and note the partial match in the rationale — never write a key that isn't in the file. The `prepare commit` phase will hard-fail on unknown keys, so catch the mismatch here.

Record `resumeVer` = archetype key (e.g. `"fintech-pm-v3"`).

**Step 8 — Cover letter generation (template-first, per job)**

Per G-17: do NOT write CLs from scratch. Reuse the profile's saved cover-letter library so proof paragraphs (achievements, metrics, candidate facts) stay locked across the batch and only company-specific copy is regenerated. This keeps tone consistent across same-batch letters and cuts token cost roughly in half.

**8a — Load base template.**

Read `profiles/<id>/cover_letter_versions.json` and detect its shape:

- **Template-variants shape** (Lilia and similar profiles): top-level `defaults` object with locked-down `p2`, `p3`, `p4_template`, `availability`, `sign` strings, plus a `letters` array of `{ job_id, role, company, p1 }` variants.
- **Library shape** (Jared and similar profiles): top-level keys map to entries shaped as `{ filename, paragraphs: [p1, p2, p3, p4] }`.

If `cover_letter_versions.json` is missing or empty (cold-start profile), fall back to writing all paragraphs from scratch using `profiles/<id>/cover_letter_template.md` as the structure guide. This is the only path where Step 8 generates the full letter.

**8b — Pick the base entry.**

Match priority, in order — stop at the first hit:

1. **Same company + same role focus** — exact `company` match AND role keywords overlap (e.g. existing entry for `Affirm` + `Capital`-focused, current job is `Affirm Capital PM` → reuse).
2. **Same company, different role** — useful when prior letter exists for the company. Replace P3 (why this company) sparingly; P2 proof stays.
3. **Same archetype, different company** — match the chosen `resumeVer` (Step 7) to an existing entry whose role focus aligns with the archetype (e.g. `resumeVer = ConsumerLending` → look for `lendbuzz_creditcard` / `affirm_capital` / similar entries).
4. **Closest archetype** — if no archetype-aligned entry exists, pick the most domain-adjacent one (e.g. `PaymentsInfra` → fall back to `PlatformInfra`-style entry).

In template-variants shape: `defaults.{p2, p3, p4_template}` IS the base — every letter reuses them. Only P1 varies, and the `letters` array is your reference set for tone/length on past P1s.

**8c — Rebuild the letter.**

- **P2 (Core proof)** — copy verbatim from the base entry. Do NOT paraphrase, reorder facts, or substitute different metrics. The candidate's achievements are stable; rewriting P2 introduces drift and dilutes proof.
- **P3 (Secondary proof / AI angle / why this company)** — copy verbatim from the base entry IF the role focus matches. If the new role is in a clearly different sub-domain (e.g. base is `growth-retention`, new role is `platform-API`), regenerate ONLY this paragraph. Apply Humanizer Rules.
- **P1 (Hook — company-specific)** — always regenerate. Use the JD signal + company-specific challenge as anchor. Apply Humanizer Rules. Pattern: "[Company] does [X]. The harder problem is [Y]. That's exactly what I've solved at [previous role]."
- **P4 (Close)** — for template-variants shape, fill `p4_template` placeholders (`{availability}`, etc.). For library shape, copy verbatim from base entry.

Output: a 4-paragraph CL where P2 (and usually P3) are exact copies of an existing humanized letter, and only the hook (and rarely P3) is freshly written for this company.

**8d — Final humanizer pass.**

Apply **Humanizer Rules** from `## Humanizer Rules` below to any newly-written paragraphs (typically P1, sometimes P3). The verbatim-copied paragraphs are already humanized — do NOT re-humanize them, that introduces drift.

**8e — Emit paragraphs (engine writes the files).**

Do **NOT** write the CL file yourself. Per RFC 019 / BL-14, the SKILL produces paragraphs and the engine writes both `.md` and `.pdf` in the commit phase.

In the results.json entry for this job (Step 10) include:

- `clParagraphs: string[]` — exactly the 4 finalized paragraphs (P1, P2, P3, P4) in order, no headers, no blank-line padding inside the strings. Engine joins them with `\n\n` for the MD file and feeds them to `pdfkit` for the PDF.
- `clKey` — filename stem only, no extension and no path. Convention: `<Company>_<role-slug>_<YYYYMMDD>` (e.g. `Affirm_senior-ai-pm_20260505`). Engine derives the company sub-folder by slugifying `applications.tsv.companyName` — you do not need to slugify yourself.
- `clBaseKey` — the base entry key / job_id you reused for proof paragraphs (helps audit batch consistency: if 10 letters share `clBaseKey = "affirm_capital"`, P2 is identical across them, which is the point).

Do **NOT** set `clPath` — the engine computes the canonical relative path (`cover_letters/<CompanySlug>/<clKey>.pdf`) and writes it into TSV `cl_path` itself. Sending `clPath` is harmless (it gets overridden), but it's no longer the SKILL's responsibility.

Files the engine produces on commit:

- `profiles/<id>/cover_letters_md/<CompanySlug>/<clKey>.md` — overwritten on every commit run with the fresh content from this batch.
- `profiles/<id>/cover_letters/<CompanySlug>/<clKey>.pdf` — generated via `pdfkit` if it doesn't already exist; existing PDFs are preserved (idempotent).

**Step 9 — Notion page creation (per job in the final top-N)**

This step runs ONCE per `prepare` invocation, after the autonomous loop (Step B) and weak-fallback (Step C) have settled the verdict buckets. Iterate over the top-30 sorted list (Step D above) — these are the jobs marked `decision = "to_apply"`. Do NOT push during loop iterations; that would create duplicate / over-pushed pages.

For each job in the final top-N:

**9.0 Skip-guard.** If the matching `applications.tsv` row already has a non-empty `notion_page_id`, the page was created in a prior run — record the existing id as `notionPageId` in results.json and skip 9a–9c (no new page, no duplicate). This makes operator-reruns of the SKILL idempotent.

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
- **Cover Letter** — full PDF filename **including the `.pdf` extension**, e.g. `Affirm_analyst-ii-credit-risk-analytics_20260420.pdf` (i.e. `<clKey>.pdf`). This is the value users search by in Finder / Drive to locate the actual file. Per BL-14: rich_text field, not file-attachment.
- **Resume Version** — select, from `resumeVer`

**Profile-gated fields (L-5)** — push only when `profile.notion.property_map` declares the field. If the property is absent from the map, do NOT push (back-compat: Jared has no Schedule / Requirements columns; his pages remain unchanged):

- **Schedule** — select, from `prepare_context.batch[i].schedule` (extracted by the engine from JD text — values like `"Full-time"` / `"Part-time"` / `"Per Diem"` / `"PRN"` / `"Contract"`). Skip the field when the entry has no `schedule` key (extractor returned null).
- **Requirements** — rich_text, from `prepare_context.batch[i].requirements` (short bulleted summary of education / years experience / language / certifications). Skip when the entry has no `requirements` key.

`Industry` is a **rollup** — do NOT set it. It is inherited automatically from the Company relation.

Record the returned `notion_page_id`.

**Step 10 — Write results file**

Write `profiles/<id>/prepare_results_<YYYYMMDD_HHMMSS>.json` ONCE at the end of the run, covering every job evaluated across all loop iterations (not just the final top-N).

Result entries:
- `decision: "to_apply"` — the top-N pushed to Notion in Step 9. Carries `clKey`, `clParagraphs`, `clBaseKey`, `resumeVer`, `notionPageId`, `salaryMin`, `salaryMax`, plus `fitScore` / `fitRationale`. Engine writes the MD + PDF files from `clParagraphs` on commit (BL-14 / RFC 019); do **not** include `clPath` — engine derives it from the company slug + `clKey`.
- `decision: "skip"` — every other judged row from the loop. Carries `fitScore: "Weak"` (or rarely Strong/Medium that didn't make the cut) + `fitRationale` so the engine commit phase persists the verdict and `filterAlreadyEvaluated` skips them on the next prepare run. (Strong/Medium that didn't make top-30 still get persisted; if they pass filter next time, they'll be picked up again.)

Format:

```json
{
  "profileId": "<id>",
  "generatedAt": "<ISO timestamp>",
  "companyTiers": {
    "<company-name>": "S|A|B|C"
  },
  "results": [
    {
      "key": "<source>:<jobId>",
      "decision": "to_apply",
      "fitScore": "Strong",
      "fitRationale": "...",
      "geo": "us-compatible",
      "clKey": "<Company>_<role-slug>_<YYYYMMDD>",
      "clParagraphs": [
        "P1 — company-specific hook ...",
        "P2 — core proof, verbatim from base entry ...",
        "P3 — secondary proof / why this company ...",
        "P4 — close ..."
      ],
      "clBaseKey": "<reused-entry-key-from-cover_letter_versions.json or null>",
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

**`clParagraphs` schema notes**:
- Required for `decision: "to_apply"`. If absent, the engine logs a warning and falls back to legacy behavior (no MD/PDF written this batch); the row still becomes "To Apply" in TSV/Notion but has no file. Always include it.
- Absent for `decision: "skip"` and `decision: "archive"` — no CL needed.
- Must be exactly 4 strings (P1/P2/P3/P4). Each string is one paragraph; no embedded blank lines, no markdown headers, no `\n\n` inside individual strings (engine inserts the spacing).

`companyTiers` is required only when `prepare_context.unknownTierCompanies` was non-empty. List every company from that array with the tier you assigned in Step 5.7. Engine merges this into `profile.json.company_tiers` on commit; Notion's Companies DB Tier field is updated by the SKILL itself when it creates/updates the company page in Step 9.

**Step 11 — Commit phase (CLI)**

```
node engine/cli.js prepare --profile <id> --phase commit \
  --results-file profiles/<id>/prepare_results_<timestamp>.json
```

This updates `applications.tsv`: `to_apply` entries get `status="To Apply"`, `cl_key`, `cl_path`, `resume_ver`, `notion_page_id`, `salary_min`, `salary_max`. Run with `--dry-run` first to preview.

**Step 12 — Report to user**

Summarize at the user level (BL-11 — what the user sees, not engine internals):

- **Headline**: `pushed N jobs to Notion (Strong: A, Medium: B, Weak: C)`. If N < 30, lead with `only N candidates found` and the reason (`Inbox exhausted` or `loop hit 3-iteration limit`).
- **Loop summary**: how many iterations ran, whether weak-fallback triggered. Example: `loop: 2 iterations + weak-fallback (15 already-Weak rows reused)`.
- **CL reuse breakdown**: group by `clBaseKey` — `8 reused affirm_capital, 3 reused chime_growth, 1 written from scratch`.
- **Pre-phase skips**: read from `prepare_context.stats.skipReasons` and surface the breakdown verbatim (e.g. `company_cap: 5, title_blocklist: 2, url_dead: 1`). Omit if `{}`.
- **Auto-tier assignments**: only if Step 5.7 ran — list the company → tier mapping.
- **Deferred queue**: `prepare_context.stats.deferred` — number of fresh rows that didn't make it into the batch. Mention only if non-zero AND inboxExhausted is false (otherwise queue's empty).
- **Warnings / anomalies**: any invalid resumeVer, invalid tier, fit-validation warnings the engine logged.

---

## Failure modes / how to recover (prepare-specific)

- **`prepare_context.json` missing** — run `--phase pre` first.
- **`jdText` is null for many jobs** — Greenhouse / Lever API may have changed; investigate `engine/core/jd_cache.js`. Geo + fit can still run from the job title + company name.
- **Notion page creation fails** — check `JARED_NOTION_TOKEN` env var and that the DB id in `profile.json` is correct. Re-run the SKILL for the failed jobs only (skip already-created ones by key).
- **Unknown company tier (salary = null AND `unknownTier: true`)** — assign the tier in Step 5.7 and put it in `results.companyTiers`. The commit phase persists it to `profile.json.company_tiers` automatically; no need to edit the file by hand.

### check

Two-phase Gmail response checker. Reads are delegated to Claude via Gmail MCP — the script never touches OAuth.

#### Phase 1 — prepare (CLI)

```
node engine/cli.js check --profile <id> --prepare [--since <ISO>]
```

Builds a search plan without hitting Gmail:

1. Loads `profiles/<id>/applications.tsv` → picks rows where `status ∈ {Applied, To Apply, Interview, Offer}` AND `notion_page_id` is set → forms `activeJobsMap`. (`Inbox` is excluded — those rows haven't been pushed to Notion, so no email thread can match yet.)
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
   - **LinkedIn job alert** (`from:jobalerts-noreply@linkedin.com`) → append a new TSV row with `status="Inbox"` (enters the same fresh-discovery lifecycle as scan-derived rows; next `prepare` will triage it).
   - **Recruiter outreach** (subject matches recruiter keywords): if sender's company is in pipeline → append TSV row with `status="Inbox"`; otherwise → `recruiter_leads.md` only.
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

### indeed-prep

Three-phase Indeed ingest. Indeed has no public API and Cloudflare blocks scraping; the only reliable path is opening search pages in a browser. The CLI hands Claude a *playbook*; Claude does the browser work; the next `scan` ingests the result.

**Use when**: profile has `discovery:indeed` in modules and `discovery.indeed.keywords` in `profile.json` (currently: lilia).

#### Phase 1 — playbook (CLI)

```
node engine/cli.js indeed-prep --profile <id>
```

Reads `profile.discovery.indeed` and prints a JSON payload:
- `scan_urls[]` — one entry per `keywords[]` (Indeed search URL with location/radius/fromage)
- `extraction_snippet` — JS to paste into the browser console; returns pipe-separated rows `jk|title|company|location`
- `viewjob_template` — `https://www.indeed.com/viewjob?jk={jk}` (open these to read JD before keeping)
- `filters.cert_blockers[]` — license keywords (CMA / RN / LVN / CPC / RDA / RDH …) that disqualify candidates with no clinical certs
- `filters.location_whitelist[]` / `location_blocklist[]` — geography gates
- `ingest_file` — absolute path where Phase 2 must write the result
- `instructions[]` — ordered checklist for the browser session

Side effects: creates `profiles/<id>/.indeed-state/` and seeds an empty `raw_indeed.json` if missing. **Never overwrites** an existing ingest file — re-running `indeed-prep` is safe and idempotent.

#### Phase 2 — browser (Claude via Chrome MCP)

Claude executes:

1. For each `scan_urls[].url` → open in a Chrome tab (recommend 2 in parallel to avoid CAPTCHA).
2. In each tab: paste `extraction_snippet` into the browser console; copy the pipe-separated rows.
3. Parse each row into `{ jk, title, company, location }`.
4. Apply browser-side filters in this order (reject early):
   - `location_blocklist` — skip if `location` matches any entry.
   - `location_whitelist` (if non-empty) — keep ONLY if `location` matches.
   - Title obvious-noise — driver / warehouse / nurse / therapist / physician (these never match the candidate's seeking intent).
5. For surviving rows: navigate to `viewjob_template` with the row's `jk`, fetch JD body, check for any `cert_blockers` keyword (single match → reject). Use:
   ```javascript
   document.querySelector('#jobDescriptionText')?.innerText?.substring(0,1500)
   ```
6. Capture per surviving entry: `{ jk, title, company, location, url?, postedAt? }`.
7. Overwrite `ingest_file` with the JSON array.

If 0 entries survive → write `[]`. The next `scan` will simply produce zero new applications.

CAPTCHA handling: if "Security Check" / "Один момент" appears, navigate to a different `scan_urls[].url`. If both tabs blocked, report to user — they may need to solve manually once.

#### Phase 3 — ingest (CLI)

```
node engine/cli.js scan --profile <id>
```

Standard `scan` flow: the indeed adapter (`engine/modules/discovery/indeed.js`) reads the ingest file referenced in `data/companies.tsv` (row: `Indeed (<profile>) | indeed | <slug> | {"ingestFile": "profiles/<id>/.indeed-state/raw_indeed.json"}`), normalizes entries, dedupes against `data/jobs.tsv` and `applications.tsv`, and appends fresh rows with `status="Inbox"` (RFC 014).

#### Failure modes (indeed-specific)

- **Empty payload after Phase 1** — `discovery.indeed.keywords` is empty or missing. Edit `profile.json`.
- **Phase 3 reports "ingest file not found"** — Phase 2 didn't write to the same path Phase 1 printed. Re-run Phase 1 (it's idempotent), then verify Claude's write target matches `ingest_file`.
- **Phase 3 reports "0 fresh"** — either the ingest file is empty (`[]`) or every entry is a duplicate. Check `applications.tsv` for prior `jobId` matches.
- **Cards extraction returns 0 rows** — Indeed changed selectors. Update `extraction_snippet` in `engine/commands/indeed_prepare.js` to match current `a[data-jk]` / `[data-testid="company-name"]` markup.

---

### answer

Two-phase application Q&A flow with **reuse-first** lookup against a Notion-backed answer bank. Per [RFC 009](../../rfc/009-application-answers-command.md).

**Use when:** the user invokes `/job-pipeline answer` with a question + role context, e.g. for an "Additional Information" field, a "Why X?" prompt, motivation/influences/values questions on application forms.

#### Phase 1 — search (CLI)

```
node engine/cli.js answer --profile <id> --phase search \
  --company "<Company>" --role "<Role>" --question "<question text>"
```

Prints JSON to stdout:

```json
{
  "key": "figma||product manager, ai platform||why do you want to join figma?",
  "exact": { "pageId": "...", "question": "...", "answer": "...", "category": "Motivation" } | null,
  "partials": [ /* same shape, same company+role OR same question across companies */ ],
  "schema": { "categories": ["Behavioral","Technical","Culture Fit","Logistics","Salary","Other","Experience","Motivation"] },
  "category_suggestion": "Motivation"
}
```

#### Phase 2 — SKILL (Claude executes)

**Step 1 — Parse the user request.** Extract `<company>`, `<role>`, and `<question>` from the user input. If any is missing or ambiguous, ask the user once.

**Step 2 — Run search phase.** Call the CLI Phase 1 above with the three values.

**Step 3 — Branch on results.**

- **If `exact` is non-null** → show the existing answer to the user, with category and a clear note ("Found this in your answer bank for this exact role+question. Reuse?"). Offer `[reuse] / [regenerate] / [edit]`. If reuse — skip to Step 7 with `existingPageId = exact.pageId` and unchanged answer.
- **If `partials` is non-empty** → mention them as reference ("Same role, different question: ...; Same question for Stripe: ..."), but proceed to Step 4 unless user asks to reuse one.
- **Otherwise** → go to Step 4.

**Step 4 — Load memory.** Read paths declared in `profile.json.memory`:
- `memory.writing_style_file`
- `memory.resume_key_points_file`
- Files matching `feedback_*.md` under `memory.feedback_dir`

If the `memory` block is absent or any file is missing, fall back to `profiles/<id>/resume_versions.json`.

**Step 5 — Generate the answer.** Apply [Humanizer Rules](#humanizer-rules-prepare--answer-modes) throughout. Default character limit: see `feedback_210_char_limit.md` (210 chars unless the form specifies otherwise; for essay-type questions like Linear's, ignore the default and write a fuller answer).

**Step 6 — Show + categorize.** Show draft to the user. Mention `category_suggestion` from search response and confirm or adjust. Wait for approval signals: "пойдет" / "ok" / "good" / "submitted" / "залил".

**Step 7 — Write the draft file.**

Write `profiles/<id>/.answers/draft_<YYYYMMDD_HHMMSS>.json`:

```json
{
  "company": "Figma",
  "role": "Product Manager, AI Platform",
  "question": "Why do you want to join Figma?",
  "answer": "<final approved text>",
  "category": "Motivation",
  "notes": "Optional context. E.g. 210-char short version. Field: Additional Information.",
  "existingPageId": null
}
```

If the user chose to update an existing entry, set `existingPageId` to the matched `pageId` from Phase 1.

#### Phase 3 — push (CLI)

```
node engine/cli.js answer --profile <id> --phase push \
  --results-file profiles/<id>/.answers/draft_<timestamp>.json
```

CLI:
- If `existingPageId` is set → updates Answer / Category / Notes on that Notion page.
- Otherwise → creates a new page in `profile.notion.application_qa_db_id`.
- Always writes a local `.md` backup to `profiles/<id>/application_answers/<Company>_<role-slug>_<YYYYMMDD>.md`. If a file with that name already exists today, suffix `_v2`, `_v3` etc.
- Prints JSON: `{ pageId, action: "created"|"updated", url, backupPath }`.

#### Step 8 — Report to user

Summarize:
- Action: created or updated.
- Notion URL of the page.
- Local backup path.
- Char count of the saved answer.

#### Failure modes (answer-specific)

- **`no notion.application_qa_db_id configured`** — profile.json is missing the field. For `jared` it's `ca4fa9e8-b3a6-4ccb-bcc2-3a13ff6b06ae`. For other profiles, create the Q&A DB in Notion first.
- **`missing JARED_NOTION_TOKEN`** — load it from `~/.bashrc` / `.env`. Same token used by `sync` and `check`.
- **`invalid category`** — the draft includes a category not in the canonical 8. Fix to one of: Behavioral, Technical, Culture Fit, Logistics, Salary, Other, Experience, Motivation. The categorize() helper picks a default automatically.
- **Notion 400 on create** — usually a missing required property or a Category option that doesn't exist in the DB. Categories must already be in the DB schema; do not invent new ones.
- **Search returns nothing for a clearly recurring question** — the question text drift may exceed the 120-char dedup window. Look at `partials` for near-matches.

---

## Global Guard Rails (prepare / answer modes)

These rules apply whenever Claude generates content or makes pipeline decisions. They reference per-profile config — do not hardcode profile-specific values here.

### Level Filter

Single source of truth: `profiles/<id>/filter_rules.json` → `title_blocklist.patterns` and `location_blocklist.patterns`. Applied as **case-insensitive substring matches** against the full title string. Never hardcode level checks inline — add/remove patterns in `filter_rules.json` only.

When a new over-level title slips into Inbox after a scan: add the pattern to `filter_rules.json → title_blocklist.patterns` with a `reason`, then re-run `node engine/cli.js validate --profile <id>` to surface existing Inbox rows that match.

### Company Cap

Config: `profiles/<id>/filter_rules.json → company_cap.max_active` (with optional `company_cap.overrides` per company). Active statuses for the cap: `To Apply`, `Applied`, `Interview`, `Offer`. (`Inbox` is intentionally excluded — those rows are pre-triage and may yet be archived.)

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

Level parsing is per-profile. Engine uses `profile.salary.level_parser` from `profile.json`:
- `"pm"` (default — Jared / fintech): `Lead` / `Senior` / `PM`. Catches "Lead", "Senior", "Sr.", "Sr ", and Capital One-style "Manager, Product Management" → Senior.
- `"healthcare"` (Lilia): `Senior` / `Coordinator` / `MedAdmin`. Catches "Lead" / "Supervisor" / "Senior" → Senior; "Coordinator" / "Specialist" → Coordinator; everything else → MedAdmin.
- `"default"` (single-row matrix): always returns `default`.

COL adjustment is per-profile (`profile.salary.col_adjustment`). Default for `pm`: +7.5% if hybrid/onsite in SF/NYC. For Lilia (Sacramento metro) the multiplier is 1.0 — no adjustment.

Salary matrix is per-profile (`profile.json.salary.matrix`). When the block is omitted the engine falls back to its default fintech-PM matrix (Jared parity). Company Tier values are stored per-company in the profile's Notion Companies DB and in `profile.json.company_tiers`.

The CLI surfaces the resolved config in `prepare_context.salaryConfig` — SKILL Step 6 reads it from there, never from disk.

### Notion Field Completeness

Every Notion job page MUST have ALL of: Role, Company (relation — not empty), Status, Fit Score, Job URL, Source, Date Added, Work Format, City, State, Notes (fit rationale — never batch labels), Salary expectations.

Per-profile Notion DB id: `profile.json → notion.jobs_pipeline_db_id`.

---

## Humanizer Rules (prepare / answer modes)

Apply **during** CL or answer generation — not as a separate post-pass.

### Voice calibration

Match the profile's writing style from `prepare_context.memory.writingStyle` (engine-loaded from `profile.json.memory.writing_style_file`). When the field is null, fall back to these defaults:
- Confident practitioner, not humble applicant. "I built X that delivered Y" — not "I was responsible for X."
- 7/10 formality: professional with energy and momentum.
- Have opinions; react to facts rather than just reporting them.
- Use "I" naturally — first person is honest, not unprofessional.
- Numbers in every paragraph except the close.
- Short paragraphs (2-3 sentences). Vary rhythm: short punchy sentences mixed with longer ones.
- Be specific: concrete details over vague claims.

The defaults above describe Jared's tone. Other profiles (e.g. Lilia — warm, 5/10 formality, no metrics-per-paragraph rule) will override them entirely via their `writingStyle` memory file.

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

In every prepare / answer session, read the engine-loaded memory from `prepare_context.memory`:
1. `memory.writingStyle` — writing style profile (from `profile.json.memory.writing_style_file`)
2. `memory.resumeKeyPoints` — skills / experience for matching (from `profile.json.memory.resume_key_points_file`)
3. `memory.feedback[]` — array of `{file, content}` for each `feedback_*.md` under `profile.json.memory.feedback_dir`

For the `answer` mode (no prepare_context.json available), read the same files directly from disk under the paths declared in `profile.json.memory`.

If a memory entry is null / missing: fall back to `profiles/<id>/resume_versions.json` as the source of truth for the candidate's experience. Always ask the user which archetype is most relevant rather than improvising facts.
