---
title: "Gap review (2026-05)"
status: archived
dated: 2026-05-05
tags: [audit, archive]
---

# Gaps Review — user-facing backlog

All 33 gaps from SPEC plus 6 Healthcare-Hannah-profile blockers (L-1…L-6, added 2026-05-04), in "what is now / what it becomes" form, no implementation detail. For triage before Phase 3.

Severity:
- **High** — real risk of regression or quality loss (1 active — RFC 012; 1 closed 2026-05-04).
- **Medium** — behavior works but deviates from expectations or carries a latent mine (3 active, 7 closed).
- **Low** — small DX rough edge or edge case (5 active, 5 closed).
- **Trivial** — cosmetic / documentation hook (5 active in BACKLOG, 4 closed).
- **Healthcare-Hannah-profile-blocker** — under-implemented per-profile config that makes the engine fall back to PM-Pete defaults for Healthcare-Hannah (6 closed 2026-05-04 — Commit A + B + C + L-6).

Fix cost:
- **XS** — a few lines, no RFC.
- **M** — a couple of files plus tests, within a day.
- **L** — architectural change, requires RFC.

---

## Summary table (triage — what to take into work)

Sort: Open → Done; within each — Gaps → Development tasks; then Severity High → Trivial; then Cost XS → L. The **"What improves"** column is pain → value, to decide "take it now or not". Per-item details are in the sections below.

| Status | ID             | Sev    | Cost | What improves                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | -------------- | ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open   | BL #5          | High   | M    | Interview Coach works for Healthcare-Hannah (currently only under PM-Pete — PM/fintech). When she starts interviewing — a parameterized skill is ready, no scrambling under pressure.                                                                                                                                                                                                                                                  |
| Open   | G-29           | Low    | XS   | **Operations**: cron on fly.io exists for both profiles, but: (a) need `fly deploy` with `62743d8` (entrypoint chown-fix for PM-Pete's EACCES); (b) `fly secrets set <PROFILE_ID>_GMAIL_*` (`<PROFILE_ID>_GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN` — Healthcare-Hannah's failure 2026-05-01). Then `fly logs` to verify.                                                                                                                  |
| Open   | G-14           | Low    | M    | JD cache for all platforms, not only GH/Lever. Currently Workday/SR/Ashby JDs are read via WebFetch → different fitScore on repeat prepare for the same job. Determinism. **RFC 016 drafted 2026-05-05** (per-platform fetchers — Workday `jobInfo`, Ashby GraphQL+fallback, SR REST, RemoteOK/Indeed/USAJOBS pass-through from `rawExtra`, CalCareers cheerio scrape; cache `_index.json` + TTL 14d/5d feature-flagged); awaiting approve. |
| Open   | BL #7.2        | Low    | XS   | USAJOBS activation: 5 minutes — register on usajobs.gov + 2 vars in `.env`. Federal jobs flow into PM-Pete's pipeline.                                                                                                                                                                                                                                                                                                                |
| Open   | BL #7.5        | Low    | XS   | Restore Current.com row in companies.tsv when you spot the job manually and provide an apply-host. Simple edit.                                                                                                                                                                                                                                                                                                                       |
| Open   | BL #4          | Medium | M    | Onboarding UX rewritten into one of the clean tracks (A — programmatic, B — AI-driven). Right now README mixes "Claude magic" + "run a script", David got stuck for one evening session. Blocker until you pick A/B.                                                                                                                                                                                                                  |
| Open   | BL #7.1        | Medium | M    | CalCareers adapter returns ~58 CA government jobs into PM-Pete's pipeline (was in prototype, not ported). A relevant role class if you want a stable government source.                                                                                                                                                                                                                                                                |
| Open   | BL #7.4        | Medium | M    | Klarna in pipeline via Deel adapter (migrated from Lever). Currently removed from companies.tsv — not scanned. **RFC 017 drafted 2026-05-05** (recon pending — `__NEXT_DATA__` probe + Deel ToS); awaiting approve before code.                                                                                                                                                                                                       |
| Open   | BL fit-prerank | Medium | M    | prepare picks top-N by fit, not first-N by date. Right now Stripe Risk-PM may be deep in the queue and never reach a batch until you grind through the FIFO tail. **RFC 015 drafted 2026-05-05** (TSV `fit_cached` column v2→v3, LLM scorer + heuristic fallback, sort `fit_cached DESC` in pre-phase, cost ~$0.08/scan for PM-Pete); awaiting approve.                                                                                |
| Open   | BL #8.1 (new)  | Medium | M    | **iCIMS adapter** (RFC 018) — surfaced during BL #8 research 2026-05-05. Public job-board pages, HTML scraping. Covers 9–12 companies in Healthcare-Hannah's whitelist: CommonSpirit family ×3 (Dignity Health, Mercy San Juan, DHMF), Sonrava (DSO ×560 locations), Demant family ×3 (HearingLife, Birdsong, CQ Partners), NVISION, Dialysis Clinic, Shriners. Highest ROI on healthcare ATS gap. Details in `BACKLOG.md` under #8.   |
| Open   | BL #8.2 (new)  | Low    | M    | **NeoGov / GovernmentJobs adapter** (RFC 019) — surfaced during BL #8 research 2026-05-05. Public RSS / JSON. Covers Sacramento County (Tier A) + potential replacement of unstable CalCareers (BL #7.1). Details in `BACKLOG.md` under #8.                                                                                                                                                                                            |
| Open   | BL #6          | Low    | M    | Documentation for contributors and for yourself a year from now: ARCHITECTURE / vision / personas / 4 ADRs / CHANGELOG. Right now understanding architecture means reading the code.                                                                                                                                                                                                                                                  |
| Open   | RFC 012        | Low    | L    | Proper relational model (companies/jobs/profiles + join tables). Blocks RFC 008 (Notion-as-source) and proper support for >2 profiles. Big migration, but lifts technical debt for all future features.                                                                                                                                                                                                                                |

**Done** (37 items, +1 in session 2026-05-05):

- **BL #8 → moved to BACKLOG 2026-05-05** as research-complete. Healthcare-Hannah 70-healthcare-ATS-slugs research finished: 1 supported row added to `data/companies.tsv` (WelbeHealth → greenhouse), 22 companies on unsupported platforms tasked as two follow-ups (BL #8.1 iCIMS adapter + BL #8.2 NeoGov adapter), 47 covered by Indeed catch-all, 4 ambiguous. Original goal (scan 70 companies directly) — 48/70 already work; iCIMS + NeoGov will lift that to 58/70; the rest (12 — Kaiser Taleo, UC Davis PageUp, custom sites) — explicit defer / drop. Full research results in `BACKLOG.md` section #8.

**Done** (36 items, +8 in session 2026-05-04 b):
- **Healthcare-Hannah profile-blockers** (L-1…L-6) — geo / salary / memory / JD-extract / head-to-head verification.
- **Prepare hardening** (G-10/G-11/G-12/G-15/G-17/G-18/G-19/G-20/G-21/G-22/G-23/G-25) — auto-tier, fill-up loop, CL template-first, resume-archetype validation, dedup-guard, Notion push refactor.
- **Scan parity** (G-2/G-5/G-7→L-4/G-26/BL #7.3) — slash-title alt-eval, location in TSV, geo enforcement, LinkedIn off, 27 dead slugs refreshed.
- **Doc trivial-pack** (G-27/G-28/G-30/G-31/G-32) — documented as parity / known-limitation, no fix needed.
- **Session b 2026-05-04** (G-4/G-33/G-13/G-24/G-8/G-9/G-16/G-3/G-1):
  - G-4: cross-platform fuzzy dedup in `applications_tsv.appendNew` (catches GH→Lever drift after migration). +2 tests (905/905).
  - G-33: side-effect of L-4 — retro-sweep already checked location via v3 schema; updated comment in filter.js.
  - G-13: already implemented (`SKIP_URL_CHECK_SOURCES` in `engine/core/url_check.js`); status update in SPEC.
  - G-24: documented as by-design contract — TSV is source-of-truth for appearance/removal, Notion owns statuses. SPEC Sy-1 + gap table.
  - G-8: by-design — USAJOBS opt-in, activation = registration + `.env`. Documented in BACKLOG.
  - G-9: help text for `--apply` clarified (noop for scan; preview via `--dry-run`).
  - G-16: `version: 1` in `prepare_context.json` for future schema migrations.
  - G-3: title_requirelist via `ctx.filterRules` in the_muse + remoteok adapters; +4 tests on default-fallback / regex-compile / Healthcare-Hannah-flavor / back-compat.
  - **G-1: RFC 014 (TSV-only)** — added TSV-only status `Inbox` for fresh-after-scan rows. `prepare --phase commit decision=to_apply` transitively `Inbox → To Apply` + creates Notion page. Notion DB untouched (8-status set inviolable). Backfill: `scripts/rfc014_backfill_inbox_status.js --profile <id> [--apply]`. +7 backfill tests, ~6 modified. Tests: 916/916.

Per-item Done details — in the sections below + in the "Healthcare-Hannah-batch" progress tracker.

---

## High (2)

### ~~G-7~~ — Geo filter incomplete (closed 2026-05-04)
- **Closed**: absorbed by L-4 (RFC 013). Profile-level `profile.json.geo` block with modes `metro` / `us-wide` / `remote-only` / `unrestricted` is honored by a single `engine/core/geo_enforcer.js` via `filter.js` BEFORE TSV append. All 11 adapters are filtered automatically. SKILL Step 3 reads `prepare_context.batch[i].geo_decision` from the engine, no WebFetch.
- **Cost**: L. **Closed 2026-05-04** (Commit C, RFC 013).

### G-17 — Cover letter generated from scratch every time
- **Now (closed 2026-05-04)**: SKILL Step 8 rewritten into a template-first flow. Claude finds the closest matching entry in `cover_letter_versions.json` (template-variants shape for Healthcare-Hannah or library-of-letters shape for PM-Pete), copies proof paragraphs (P2 + P3) verbatim, regenerates only company-specific paragraphs (P1 hook + when needed P4 close), and applies Humanizer only to the new text. Tone stable across the whole batch (proof identical), tokens roughly halved. `clBaseKey` is recorded in results.json for audit (visible which letters reuse the same base).
- **Cost**: M. **Closed 2026-05-04**.

---

## Medium (10)

### G-1 — Status "To Apply" meant two different things — Closed 2026-05-04 (RFC 014)
- **Resolution**: TSV-only status `Inbox` for fresh-after-scan rows. Notion DB stays 8-status (inviolable). `prepare --phase commit decision=to_apply` transitively transitions `Inbox → To Apply` AND creates a Notion page in one go. The double meaning of `"To Apply"` is gone.
- **Changes**:
  - `applications_tsv.appendNew` default → `"Inbox"`.
  - `scan.js` writes fresh rows as `Inbox`.
  - `check.js` LinkedIn/recruiter auto-rows also `Inbox`.
  - `prepare.js` fresh-row filter: `status === "Inbox" || (status === "To Apply" && !notion_page_id)` (dual for back-compat).
  - `validate.js` retro-sweep extended to `Inbox`.
  - `sync.js` callout count uses the same filter; pull is naturally safe (Inbox rows have no notion_page_id).
  - `check.js` SKIP_STATUSES extended to `Inbox`.
  - SKILL.md + `build_hub_layout.js` updated.
- **Backfill**: `scripts/rfc014_backfill_inbox_status.js --profile <id> [--apply]`. Default dry-run; `--apply` creates an `applications.tsv.pre-rfc014` backup.
- **Tests**: 916/916 (+7 backfill, ~6 modified).
- **Cost**: M (down from L — TSV-only revision saved the Notion UI step and the Notion patcher).

### G-3 — Title requirelist not centrally enforced
- **Now**: the "must-have words in role title" list is supported in config, but each adapter actually filters its own way inline. Behavior fragmented.
- **Becomes**: requirelist handled in one place, all adapters honor it the same.
- **Cost**: M.

### G-4 — Cross-platform duplicates slip through
- **Now (closed 2026-05-04)**: fuzzy was already working in `dedupeJobs` / `dedupeAgainst` at the scan-pool level, but `applications_tsv.appendNew` only deduped on exact `source:jobId`. Drift between pool and applications.tsv (after prototype migration) let GH→Lever duplicates into applications. Extended `appendNew`: builds `seenFuzzy` from existing apps, returns `fuzzyDuplicates[]`, scan command logs the counter.
- **Cost**: XS. **Closed 2026-05-04** (+2 tests).

### G-10 — SKILL re-asks about batch size
- **Now (closed 2026-05-04)**: SKILL Step 2 says "Proceed without confirmation — the CLI's `--batch N` flag already gates batch size; Claude does not re-prompt the user". Default 30; for a different size — re-run pre-phase with `--batch <N>`.
- **Cost**: XS. **Closed 2026-05-04**.

### G-11 — SKILL re-asks about unknown tier
- **Now (closed 2026-05-04)**: SKILL Step 5.7 "Auto-tier unknown companies" — Claude assigns S/A/B/C itself by profile-flavor criteria (PM-Pete: AI-native big-tech / fintech vs early-stage; Healthcare-Hannah: regional health systems vs single-clinic). Results go into `results.companyTiers`, the commit phase persists into `profile.json.company_tiers` (one-shot per company). No user prompts.
- **Cost**: M. **Closed 2026-05-04**.

### G-15 — Unknown tier silently passes through to SKILL
- **Now (closed 2026-05-04)**: part of G-11. Each batch entry without a tier lands in `prepare_context.unknownTierCompanies`; SKILL Step 5.7 is required to assign one before commit; the commit gate (`prepare.js` validates against `VALID_TIERS = {S,A,B,C}`) persists. The "silent pass-through" state no longer exists.
- **Cost**: XS (part of G-11). **Closed 2026-05-04**.

### G-18 — Claude can pick a non-existent resume archetype
- **Now (closed 2026-05-04)**: SKILL Step 7 has an explicit Mandatory validation block: `resumeVer` MUST be a key in `profile.resume_versions.versions`; "Do NOT invent or paraphrase a key. If no archetype is a clear match, pick the closest existing key (or the profile's default if defined)". Backstop in `prepare --phase commit` catches leakage (`updates.invalidArchetype` counter, downgrades to `skip` with a warning).
- **Cost**: XS. **Closed 2026-05-04**.

### G-21 — Notion pages created twice via two paths
- **Now (closed 2026-05-04)**: the fix took the opposite route from the original plan. Instead of "single path through sync push", we removed sync push entirely (commit `4f85ed2`); the only page-creation path is `prepare` commit phase. SKILL invokes the CLI; the MCP side does not push directly.
- **Cost**: M. **Closed 2026-05-04** (sync refactor: pull-only).

### G-22 — Some fields pushed bypassing the CLI
- **Now (closed 2026-05-04)**: together with G-21 — `sync` no longer pushes anything, all fields go through `prepare` (including Notes / Fit Score / Date Added / Work Format / City / State). Mapping lives in one place — `engine/commands/prepare.js` commit phase.
- **Cost**: M. **Closed 2026-05-04** (part of G-21).

### G-33 — Retro-sweep does not check location
- **Now (closed 2026-05-04)**: effectively closed earlier as a side-effect of L-4 (RFC 013). After schema v3 (G-5), TSV rows store `location`, and `validate` retro-sweep calls `matchBlocklists({location: app.location || ""})` — it now exposes both `location_blocklist` and `geo` enforcement. Today only the stale comment in `engine/core/filter.js` was updated.
- **Cost**: XS. **Closed 2026-05-04**.

---

## Low (12)

### G-2 — Slash in role title splits into variants
- **Now**: when filters evaluate a title with `/` (e.g. "Receptionist/Office Manager"), it gets split — if at least one part passes blocklist+requirelist, the job is not blocked. This is **not two TSV records**, it's an alternative evaluation of one job. Behavior is useful (multi-role postings) and is in fact documented in the `engine/core/filter.js` header + SPEC CC-3.1, but it sat in the gap matrix as "engine improvement without an explicit source".
- **Becomes**: explicit triage decision in SPEC and matrix — keep as-is, intent recorded.
- **Cost**: XS (text only). **Closed 2026-05-03.**

### G-5 — TSV has no location field
- **Now**: TSV has no location → location filters at the validate stage are impossible, retro-sweep does not cover it.
- **Becomes**: location in TSV (column 7), v3 schema. Backfill from master pool. Validate retro-sweep now covers location_blocklist. Sync push: location flows into Notion property "Location" only when the profile explicitly maps it in property_map (default: not pushed, backward-compatible).
- **Cost**: M (TSV schema migration + backfill + tests). **Closed 2026-05-03.** Backfill results: PM-Pete 2186/2897 filled (711 orphans — old scan snapshots), Healthcare-Hannah 94/425 (331 orphans — Sutter Health workday not in pool). Backups `applications.tsv.pre-stage-g5` saved for both profiles.

### G-6 — In companies.tsv the profile column is a comma-list
- **Now**: a single company visible to both profiles (PM-Pete + Healthcare-Hannah) is stored as the string `"<id1>,<id2>"`. Hack.
- **Becomes**: a proper many-to-many relation.
- **Cost**: M (schema migration).

### G-8 — USAJOBS adapter exists but is disabled
- **Now (closed 2026-05-04, by-design)**: code is there, tests green, activation is opt-in (registration on usajobs.gov + 2 vars in `.env` + uncomment in `profile.json.modules`). Long-term disabled, activated on demand. SPEC section S-5.usajobs + BACKLOG #7.2 cover this.
- **Cost**: XS. **Closed 2026-05-04**.

### G-12 — `prepare` does not refill the batch after skips + summary without reasons
- **Now (closed 2026-05-04)**: `prepare --phase pre` refills in chunks (size = max(remaining, 5)) from the `passed` pool until `aliveResults.length < batchSize` (or pool exhausted). Stats now include a `skipReasons` breakdown (`company_cap: N, title_blocklist: N, url_dead: N, …`) and a `deferred` counter (eligible jobs that did not reach URL-check, stay in queue until next pre run). SKILL Step 12 prints the breakdown verbatim from `prepare_context.stats.skipReasons`.
- **Cost**: M. **Closed 2026-05-04**.

### G-13 — Jobs with LinkedIn/Indeed/custom URL die at URL-check
- **Now (closed 2026-05-04)**: already implemented in `engine/core/url_check.js` — `SKIP_URL_CHECK_SOURCES = {linkedin, indeed, custom}`. `checkOne` short-circuits and returns `{alive: true, skipped: true}`, does not mark dead. JD pull stays with SKILL/WebFetch.
- **Cost**: XS. **Closed 2026-05-04** (was de-facto implemented earlier — only updated the SPEC + GAPS status).

### G-14 — JD cache only for GH+Lever
- **Now**: for other platforms description is fetched via WebFetch, which is non-deterministic (different responses on retries).
- **Becomes**: unified JD cache for all platforms. Not critical, but determinism improves.
- **RFC**: [016-unified-jd-cache.md](../../rfc/016-unified-jd-cache.md) drafted 2026-05-05. Per-platform fetchers (Workday `cxs/jobInfo`, Ashby GraphQL `ApiJobBoardWithTeams` + WebFetch fallback, SR REST `v1/companies/{slug}/postings`, RemoteOK/Indeed/USAJOBS pass-through from `rawExtra.descriptionHtml`, CalCareers cheerio scrape). Cache + sidecar `_index.json` (source_method, url_hash, fetched_at, content_length, schema). TTL 14d default / 5d for `webfetch_scrape`. Feature flag `JD_CACHE_UNIFIED`. Backward-compat: missing index entry → schema 0 fallback.
- **Cost**: M. Awaiting approve.

### G-20 — Re-running SKILL can create a duplicate in Notion
- **Now (closed 2026-05-04)**: SKILL Step 9.0 skip-guard — "If the matching `applications.tsv` row already has a non-empty `notion_page_id`, the page was created in a prior run — record the existing id as `notionPageId` in results.json and skip 9a–9c (no new page, no duplicate). This makes operator-reruns of the SKILL idempotent."
- **Cost**: XS. **Closed 2026-05-04**.

### G-23 — Non-existent archetype only caught at Notion page creation
- **Now (closed 2026-05-04)**: part of G-18. Early-reject landed: SKILL Step 7 has the Mandatory validation block requiring `resumeVer ∈ keys(profile.resume_versions.versions)`. Commit-phase backstop remains as a safety net (`updates.invalidArchetype` counter).
- **Cost**: XS (part of G-18). **Closed 2026-05-04**.

### G-24 — Notion page deletion is not pulled back
- **Now (closed 2026-05-04, by-design)**: contract recorded — TSV is source-of-truth for the appearance/removal of a record in pipeline; Notion owns statuses and presentation. To remove a record: (1) set `Archived` in Notion → pull picks it up, (2) delete the row from applications.tsv directly → next scan will not recreate it unless the URL comes back. SPEC Sy-1 + gap table cover this.
- **Cost**: XS. **Closed 2026-05-04**.

### G-26 — LinkedIn jobs create "To Apply" with empty URL
- **Now (until 2026-05-03)**: each such record landed in TSV without a URL → SKILL could not fetch JD → Notion cards came out without a link.
- **Becomes**: LinkedIn ingestion **disabled 2026-05-03** (per user). The prototype had no LinkedIn source, the engine added it experimentally, and the user barely used it. Email is still fetched in the Gmail batch (`from:jobalerts-noreply@linkedin.com`) and shows up in the check-log as `"skipped: linkedin disabled"`, but no TSV row is created. Re-enable instructions — in the comment above `processLinkedIn` in `engine/commands/check.js`.
- **Cost**: XS (down from M — opt-out instead of URL resolution). **Closed 2026-05-03.**

### G-29 — `--auto` mode for check exists but is not active
- **Now (partially)**: cron on fly.io is up (PM-Pete 8:00 PT + Healthcare-Hannah 8:01 PT) — `cron/check.cron`. But both failed:
  - PM-Pete 2026-05-02 — `EACCES /data/profiles/<id>/applications.tsv.tmp.*`. Fix in commit `62743d8` (`cron/entrypoint.sh` chown as root → `su-exec app`). After `fly deploy` (if not yet done) — should work.
  - Healthcare-Hannah 2026-05-01 — `missing <PROFILE_ID>_GMAIL_CLIENT_ID`. The `<PROFILE_ID>_GMAIL_*` secrets on fly are not set. Fix — `fly secrets set` (not code).
- **Notion @mentions**: written ONLY on failure (`buildFailureComment` in `engine/commands/check.js`). Successful runs go only to `email_check_log.md` + fly stdout.
- **Closure checklist**: (1) `fly deploy --app ai-job-searcher-cron` with `62743d8`; (2) `fly secrets set <PROFILE_ID>_GMAIL_CLIENT_ID=… <PROFILE_ID>_GMAIL_CLIENT_SECRET=… <PROFILE_ID>_GMAIL_REFRESH_TOKEN=…`; (3) `fly logs --app ai-job-searcher-cron --since 24h` — verify fresh successful runs for both profiles.
- **Cost**: XS (ops task, not code).

---

## Trivial (9)

### G-9 — `scan --apply` does nothing
- **Now (closed 2026-05-04)**: help text in `engine/cli.js` clarified: `--apply` is needed only for `sync` / `validate` / `check`; for `scan` it is a noop (TSV is always written), preview via `--dry-run`.
- **Cost**: XS. **Closed 2026-05-04**.

### G-16 — `prepare_context.json` has no version field
- **Now (closed 2026-05-04)**: `prepare --phase pre` writes `version: 1` as the first key of the context. Reader contract: "if absent, treat as 1". Future schema-breaking changes must bump the major version and explicitly break old consumers.
- **Cost**: XS. **Closed 2026-05-04**.

### G-19 — Unknown `decision` in commit phase silently treated as "skip"
- **Now (closed 2026-05-04)**: `prepare --phase commit` validates `decision` against `VALID_DECISIONS = {to_apply, archive, skip}`. Unknown values warn to stderr (`unknown decision "<x>" for key <key> — treating as skip`) and downgrade to `skip` with the `updates.invalidDecision` counter visible in summary.
- **Cost**: XS. **Closed 2026-05-04**.

### G-25 — Inbox callout counter is dead code
- **Now (closed 2026-05-04)**: callout-updater code removed together with sync push (commit `4f85ed2`). After Stage 8 the "Inbox" status no longer exists, the callout always showed 0 — now the callout updater itself is gone too.
- **User comment**: a counter in Notion that shows the volume of fresh jobs is desirable. That is a **separate feature** (a new push from prepare after a successful batch, or auto-update in a Notion view). Log as a BACKLOG item "inbox volume callout (To Apply without notion_page_id)" when we get to UX polish.
- **Cost**: XS. **Closed 2026-05-04** (dead code removed). Re-implementation as a feature — see BACKLOG.

### G-27 — Engine added 3 fixes in classifier vs prototype
- **Now**: engine is better than prototype (removed false matches on "not selected", bare "interview", bare "assessment"). Net plus.
- **Becomes**: documented in SPEC so it does not get rolled back.
- **Cost**: XS (text already there).

### G-28 — TSV and Notion mutations not atomic
- **Now**: a Notion 5xx mid-batch → split state (some synced, some not). Self-heals on next run.
- **Becomes**: documented as known limitation (full atomicity is expensive).
- **Cost**: XS (text).

### G-30 — `>` (validate) vs `>=` (prepare) for the cap
- **Now**: validate complains at >cap, prepare blocks at >=cap. Correct, but undocumented.
- **Becomes**: spec note added (this SPEC already covers it).
- **Cost**: XS (done).

### G-31 — SSRF guard duplicated in two places
- **Now**: prepare and validate use their own copies of the guard. Intentional — different contracts.
- **Becomes**: documented as not-a-gap.
- **Cost**: XS (done).

### G-32 — Retro sweep looks for "To Apply", prototype looked for "Inbox"
- **Now**: semantic parity after Stage 8 (statuses renamed). Not a bug.
- **Becomes**: documented as parity, not a gap.
- **Cost**: XS (done).

---

---

## Healthcare-Hannah profile-level blockers (plan 2026-05-04)

Six separate holes found while preparing the live prepare run for Healthcare-Hannah after the head-to-head for PM-Pete. All six are consequences of one architectural disease: **the engine reads defaults instead of per-profile configs**. Fintech-PM salaries in `salary_calc.js`, PM-tone in Humanizer, US-only-no-region geo check in SKILL — all of these systematically produce bad output for Healthcare-Hannah (healthcare, Sacramento metro, no relocation).

Architectural fix principle: "profile declares — engine reads per-profile via `profile_loader` — SKILL consumes the resolved values from `prepare_context`". No Healthcare-Hannah-specific hardcoding in the engine.

### L-1 — Per-profile salary matrix
- **Now**: `engine/core/salary_calc.js` has a hardcoded `DEFAULT_SALARY_MATRIX` (fintech PM/Senior/Lead, $120-330K). `parseLevel(title)` only recognizes Lead/Senior/PM. For a Medical Receptionist at Kaiser this will compute $180-230K (Tier S × "PM") for Healthcare-Hannah — catastrophic in the Notion `Salary Expectations` field.
- **Becomes**: `profile.json.salary` block with its own matrix and level-parser mode (`level_parser: "pm" | "healthcare" | "default"`). Healthcare mode recognizes Junior/IC vs Senior (by `Lead`/`II`/`III` in title). Engine reads per-profile, default kept for back-compat with PM-Pete.
- **Cost**: M. Subtasks: schema → salary_calc refactor → profile_loader extension → SKILL Step 6 update → parity tests for PM-Pete + healthcare fixtures.
- **Status**: Open. Planned in Commit A.

### L-2 — Memory as a formal part of the profile
- **Now**: SKILL Step 1 / Humanizer Rules reference `profiles/<id>/memory/user_writing_style.md` + `user_resume_key_points.md`. PM-Pete has them, Healthcare-Hannah does not → fallback to `resume_versions.json` does not describe the writing tone. Humanizer-defaults applies PM calibration (numbers in every paragraph, confident practitioner) to Healthcare-Hannah — overqualified-tone in her CL, exactly what her `cover_letter_template.md` forbids.
- **Becomes**: `profile.json.memory` block: `{writing_style_file, resume_key_points_file, feedback_glob}`. Engine pre-phase reads all referenced files and stuffs them into `prepare_context.memory`; SKILL reads from there (determinism + fewer tokens). If profile did not declare them — fallback chain as today.
- **Cost**: XS-M (schema + one function in `profile_loader` + SKILL Step 1 update + tests).
- **Status**: Open. Planned in Commit A.

### L-3 — Healthcare-Hannah memory file content sourced from her resume
- **Now**: both files missing. After L-2 the engine will look for them, and emptiness → fallback to PM defaults.
- **Becomes**:
  - `profiles/<id>/memory/user_writing_style.md` — warm, 5/10 formality, no metrics-per-paragraph rule, no "confident practitioner" defaults. Anchored to her `cover_letter_template.md` Tone Rules + Anti-patterns.
  - `profiles/<id>/memory/user_resume_key_points.md` — domain criteria for Fit Score: Strong = front-desk / patient services / scheduling / authorization in Sacramento metro + bilingual roles (RU/BG) — automatic Strong; Medium = adjacent admin / dental treatment coordinator / billing clerk; Weak = required clinical cert (CMA/RN/LVN/CPC/RDA/RDH/sonographer/RT). Domain primary keypoints for the P1 hook: pre-sonography student at Sierra College, trilingual EN/RU/BG, licensed CA Cosmetologist, immigration law case research (transferable: deadlines/databases/client communication), Starbucks 100+ customers/day under pressure.
- **Cost**: XS (content composed from her `resume_versions.json` + `cover_letter_template.md`).
- **Status**: Open. Planned in Commit A (alongside L-2 — without files there is nothing for the engine to read).

### L-4 — Flexible per-profile geo model (absorbs G-7)
- **Now (closed 2026-05-04)**: a single `profile.json.geo` model with modes `metro` / `us-wide` / `remote-only` / `unrestricted`. `engine/core/geo_enforcer.js` is a pure-function matcher; integrated into `filter.js` (scan/prepare/validate uniform). `profile_loader.normalizeGeo()` validates on load (metro requires cities+states; throws otherwise). Multi-location semantic: pass if ANY locations[] satisfies policy. Per-location blocklist short-circuit. US state code ↔ full name bidirectional matching. Bare-city safeguard: city-only match accepted when the location string contains no state info at all (preserves the Auburn-AL ambiguity defense). SKILL Step 3 reads `prepare_context.batch[i].geo_decision` (allowed/rejected) — no WebFetch.
- **Healthcare-Hannah geo**: `metro` mode with 13 Sacramento-metro cities (incl. Lincoln) + states=["CA"] + remote_ok=true + blocklist=[Napa, Stockton, Lodi, Vacaville, Modesto].
- **PM-Pete geo**: `unrestricted` + remote_ok=true (explicitly declared per RFC §8.6).
- **Cost**: L. **Closed 2026-05-04** (Commit C, RFC 013).
- **Live verification**: PM-Pete parity — 389 To Apply rows, 389 allowed, 0 rejected (zero regression). Healthcare-Hannah retro-sweep: 36 archived rows (31 geo_no_location — TSV without location field / 5 geo_metro_miss — correct state mismatches). Tests: 60 new (28 geo_enforcer + 11 profile_loader.normalizeGeo + 10 filter geo + 6 prepare geo + 4 validate geo + 1 cleanup); 903/903 passing.

### L-5 — Notion Schedule / Requirements from JD
- **Now (closed 2026-05-04)**: `engine/core/jd_extract.js` catches schedule (Full-time / Part-time / Per Diem / PRN / Contract / shift fallback / hours-per-week) and requirements (education / 1-7+ years / bilingual + specific languages / healthcare certs — BLS / CMA / RDA / RN / etc. with required/preferred tags / EMR — Epic / Cerner / Dentrix / etc.). Context scope is sentence/line, so required/preferred do not leak across bullets. `prepare.js` pre-phase pipes them into `prepare_context.batch[i].{schedule, requirements}` via DI injection of `extractFromJd`. SKILL Step 9 pushes only when `profile.notion.property_map.schedule` / `.requirements` are defined (Healthcare-Hannah has both — `select` + `rich_text`; PM-Pete has neither → his cards do not change). Tests: 25 for jd_extract (Kaiser / Sutter / Dignity / Sono Bello / Stonebrook + boundary cases) + 5 for prepare.js wiring (including PM-Pete parity — extractor may return `requirements` for a PM JD by years signal, but SKILL does not push because of gating).
- **Cost**: M. **Closed 2026-05-04** (Commit B).

### L-6 — Head-to-head verification for Healthcare-Hannah
- **Now (closed 2026-05-04)**: see `docs/audits/2026-05-04-prepare-hc.md`. Engine `profiles/<id>/cover_letter_versions.json` (581 lines, 55590 bytes) is **byte-identical** to the prototype `Lilly's Job Search/cover_letter_config.json` — `diff` empty. Shape compatible with the SKILL Step 8 template-variants branch: `defaults.{p2, p3, p4_template, availability, sign}` + `letters[]` (95 entries, 11 Sutter). Contract: P2/P3/P4 are copied from the shared defaults on every letter (byte-identical to prototype by construction), only P1 varies. 45 fresh `To Apply` rows are available for the live batch. After L-4 retro-sweep, 36 invalid rows were archived (31 no_location, 5 metro_miss — all correct).
- **Cost**: verification, not code. **Closed 2026-05-04**.

---

## Execution order (plan)

Three commits in this order, each a focus session:

### Commit A (M) — L-1 + L-2 + L-3
Profile-level configs for salary and memory:
- `profile.json.salary` block + engine refactor + tests.
- `profile.json.memory` block + engine refactor + tests.
- Healthcare-Hannah memory files (writing_style + resume_key_points).
- Healthcare-Hannah salary matrix in `profile.json`.
- SKILL Step 1 / Step 6 updates.
- PM-Pete parity tests (no old numbers shifted).

### Commit B (M) — L-5
JD extractors + Notion completeness:
- `engine/core/jd_extract.js` with extractSchedule + extractRequirements.
- `prepare.js` pre-phase pipes into `prepare_context`.
- SKILL Step 9 pushes when present in property_map (back-compat).
- 5-6 fixtures for typical healthcare JDs.

### Commit C (L) — L-4 (RFC 013) — **Done 2026-05-04**
Per-profile geo model:
- RFC 013 → approved.
- `geo_enforcer.js` (pure matcher) + filter.js integration (uniform for scan/prepare/validate) + SKILL Step 3 refactor (reads `geo_decision` from engine).
- `profile_loader.normalizeGeo()` validates the geo block on load.
- Healthcare-Hannah/PM-Pete geo blocks in profile.json.
- Live retro-sweep: PM-Pete 0 rejections (parity), Healthcare-Hannah 36 archived (31 no_location + 5 metro_miss).
- 60 new tests; 903/903 passing.

After C: **L-6** is done (head-to-head verification for Healthcare-Hannah, closed 2026-05-04 — `docs/audits/2026-05-04-prepare-hc.md`). Healthcare-Hannah-batch fully closed; next step is the live prepare run for her, on user request.

---

## Cost summary

- **L** (require RFC + migrations): G-1.
- **M** (one day of work, tests): G-3, G-6, G-14 (RFC 016 drafted), G-29, BL #7.4 (RFC 017 drafted), BL fit-prerank (RFC 015 drafted).
- **XS** (a few lines / files): BL #7.2, BL #7.5.
- **RFC drafted, awaiting approve (3 items, 2026-05-05)**: RFC 015 (fit-prerank), RFC 016 (unified JD-cache), RFC 017 (Deel adapter).
- **Closed 2026-05-04** (28 items): G-2, G-4, G-5, G-7 (absorbed by L-4), G-8, G-9, G-10, G-11, G-12, G-13, G-15, G-16, G-17, G-18, G-19, G-20, G-21, G-22, G-23, G-24, G-25, G-26, G-33, **L-1, L-2, L-3, L-4, L-5, L-6**.
- **Closed 2026-05-05** (1 item, moved to BACKLOG): **BL #8** — research complete; 1 supported ATS row added (WelbeHealth/greenhouse), follow-up adapter tasks BL #8.1 (iCIMS) + BL #8.2 (NeoGov) moved to BACKLOG section #8 with the full research dump. See the recommendation below.

## Triage recommendation

**Active queue (after the prepare blocker/QoL pack on 2026-05-04)**:

**Healthcare-Hannah blockers (priority 1 — without them the live prepare for her produces bad output)**:
- Commit A → Commit B → RFC 013 approve → Commit C → L-6 verification. See "Execution order" above.

**XS — quick wins (can be done in parallel with the Healthcare-Hannah-batch)**:
- G-4 (cross-platform dedup) — already written, needs to be enabled.
- G-13 (LinkedIn / Indeed URL-check skip).

**M — valuable behavioral fix (after Healthcare-Hannah)**:
- G-3 (centralized title requirelist).
- G-14 (JD-cache for the remaining platforms) — RFC 016 drafted 2026-05-05, awaiting approve.
- BL #7.4 (Deel adapter for Klarna) — RFC 017 drafted 2026-05-05, recon + approve pending.
- BL fit-prerank (AI scoring at scan time) — RFC 015 drafted 2026-05-05, awaiting approve.

**M — new candidates (surfaced during BL #8 research, 2026-05-05; tracked as BL #8.1 / #8.2 in `BACKLOG.md`)**:
- **iCIMS adapter** (BL #8.1, RFC 018) — 9–12 companies in Healthcare-Hannah's whitelist: CommonSpirit family ×3 (Dignity Health, Mercy San Juan, DH Medical Foundation), Sonrava (DSO ×560 locations), Demant family ×3 (HearingLife, Birdsong, CQ Partners), NVISION, Dialysis Clinic Inc., Shriners. Highest ROI on unsupported ATS.
- **NeoGov / GovernmentJobs adapter** (BL #8.2, RFC 019) — Sacramento County (Tier A) + future replacement for CalCareers (RSS / JSON public).

**Architectural (L) — discuss separately**:
- ~~G-1~~ → closed by RFC 014 (TSV-only revision, 2026-05-04). Cost downgraded L → M thanks to dropping the Notion-side migration.
- ~~G-7~~ → absorbed by L-4 in RFC 013 (closed 2026-05-04).

**Documentation (Trivial) — close as one PR**:
- G-24, G-27, G-28, G-30, G-31, G-32.

**Defer (BACKLOG)**:
- G-8 (USAJOBS) — return when needed.
- G-29 (`--auto` activation) — waits for OAuth setup.
- G-6, G-33 (part of RFC 012 — TSV schema bump).

---

## Progress tracker for Healthcare-Hannah-batch

This block is kept live — record what is closed, the date, the commit reference. After L-6 the section freezes as archival.

| ID | Status | Commit | Date | Note |
|---|---|---|---|---|
| L-1 (salary matrix per-profile) | **Done** | Commit A | 2026-05-04 | `profile.json.salary` block + `parseLevel(title, parser)` dispatcher (`pm` / `healthcare` / `default`). Healthcare-Hannah matrix S/A/B/C × MedAdmin/Coordinator/Senior. Per-profile COL config (Healthcare-Hannah: `multiplier=1.0`). PM-Pete has no block → engine defaults (parity confirmed via smoke + 12 new tests). |
| L-2 (memory in profile config) | **Done** | Commit A | 2026-05-04 | `profile.json.memory` block (`writing_style_file` / `resume_key_points_file` / `feedback_dir`). `profile_loader.loadMemory()` reads content into `profile.memory.{writingStyle,resumeKeyPoints,feedback[]}`. `prepare.js` pipes into `prepare_context.memory`. SKILL Step 1 / Voice calibration / Memory files read from context, not from disk. |
| L-3 (Healthcare-Hannah memory files content) | **Done** | Commit A | 2026-05-04 | `profiles/<id>/memory/user_writing_style.md` (warm, 5/10, anti-AI tells, voice anchors) + `user_resume_key_points.md` (Strong/Medium/Weak fit criteria + 4 experiences in priority order + differentiators). PM-Pete `profile.json` also declared his existing memory dir. |
| L-4 (geo model RFC 013) | **Done** | Commit C | 2026-05-04 | `engine/core/geo_enforcer.js` (pure matcher) + filter.js integration + `profile_loader.normalizeGeo()` + SKILL Step 3 refactor (engine-resolved decision, no WebFetch). Healthcare-Hannah metro mode (13 cities Sacramento+Lincoln, CA, blocklist 5 cities, remote_ok=true). PM-Pete explicit `unrestricted` + remote_ok=true. Live: PM-Pete 389/389 allowed (parity), Healthcare-Hannah 36 archived (31 no_location + 5 metro_miss). 60 new tests. Absorbs G-7. |
| L-5 (Schedule / Requirements push) | **Done** | Commit B | 2026-05-04 | `engine/core/jd_extract.js` + `prepare.js` pre-phase wiring + SKILL Step 9 profile-gated push. 30 new tests (25 jd_extract + 5 prepare). Healthcare JD fixtures: Kaiser / Sutter / Dignity / Sono Bello / Stonebrook. Sentence-scoped strength tagging (required/preferred). Back-compat: PM-Pete parity — his cards do not change (no fields in property_map). |
| L-6 (head-to-head Healthcare-Hannah) | **Done** | docs/audits/2026-05-04-prepare-hc.md | 2026-05-04 | `cover_letter_versions.json` byte-identical to prototype (`diff` empty, 581/581 lines, 55590/55590 bytes). Template-variants shape contract verified: P2/P3/P4 are copied from shared `defaults` (byte-identical by construction), only P1 varies. SKILL Step 8 has an explicit branch for template-variants. Healthcare-Hannah ready for the live batch. |
