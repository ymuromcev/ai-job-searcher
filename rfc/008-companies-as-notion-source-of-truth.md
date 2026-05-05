---
id: RFC-008
title: Companies as Notion source of truth + per-profile check
status: implemented
tier: L
created: 2026-04-30
decided: 2026-04-30
supersedes: RFC-006
tags: [notion, companies, schema]
---

# RFC 008 — Companies as Notion source of truth + per-profile check

**Status**: Draft 2026-04-30 (requires user approve)
**Tier**: L (data migration, new sync phase, check refactor, tests across 2 profiles)
**Author**: Claude + PM-Pete
**Absorbs**: [RFC 006](./006-email-check-per-profile-companies.md), [RFC 007](./007-industries-as-relations.md)
**Depends on**: [RFC 002 — check command](./002-check-command.md)

## Problem

Three related problems:

1. **Email check misses companies**: the current `check --prepare` builds the watchlist only from ~88 active applications (`status ∈ {To Apply, Applied, Interview, Offer}` + `notion_page_id`). All other companies are invisible. Today we found misses: Robinhood, Hippo Insurance, Marqeta, Deel, TabaPay.

2. **No physical company → profile link**: `data/companies.tsv` (250 fintech companies) has no `profile` column. The binding holds by luck — the table happens not to overlap with Healthcare-Hannah's healthcare companies. Any addition of "not my" companies breaks isolation.

3. **Does not scale**: Healthcare-Hannah's 75 healthcare companies live in `profile.json.discovery.companies_whitelist` (this is a config, not a DB). Adding a 3rd profile requires either bloating the whitelist or branching in code.

Meanwhile **everything is already correct in Notion**:
- 2 per-profile Companies DBs: `Jared — Companies` (DB `7aac7a15-...`), `Lilia — Companies` (DB `39e5a762-...`).
- Schema is identical: `Name | Industry (multi_select) | Tier | Company Size | Remote Policy | Website | Careers URL | Notes`.
- Industry in PM-Pete's DB is configured with 18 options (FinTech, BNPL, Payments, Lending, Crypto, Banking, Insurance, HealthTech, Marketplace, SaaS, Martech, AI/ML, HR Tech, Real Estate, Healthcare, Transportation, Retail, Construction).
- Healthcare-Hannah's Notion has 77 companies with industries set (but the schema options are still empty — need to copy from PM-Pete's or accept freeform).

The engine doesn't use any of this right now. `data/companies.tsv` and Notion live in parallel.

## Locked-in decisions

| # | Decision |
|---|---------|
| 1 | Notion Companies DB (per-profile) = **single source of truth** for company metadata. |
| 2 | **Industries are mandatory** for every company. This is the rule. Validate will fail if it's violated. |
| 3 | Extend `engine/commands/sync.js` with a new phase: **Companies (Notion → `data/companies.tsv`)**. One-way (Notion → local). |
| 4 | A **`profile`** column in `data/companies.tsv` (value = `jared` / `lilia`). Binding is automatic via the fact of belonging to the profile's Notion DB. |
| 5 | Helper `companiesForProfile(profileId, allCompanies)` in `engine/core/companies.js`. Used by all commands. |
| 6 | The engine applies Notion directly via `NOTION_TOKEN` (ready for standalone cron). |
| 7 | Default profile = `jared`. For others — explicit command (`--profile lilia`). |

## Architecture

### Extended `data/companies.tsv`

```
name | profile | industries | tier | company_size | remote_policy | website | careers_url | ats_source | ats_slug | notion_page_id | extra_json
Affirm | jared | FinTech,Lending,BNPL | S | Scaleup | Remote-first | https://affirm.com | https://www.affirm.com/careers | greenhouse | affirm | <notion-uuid> |
Kaiser Permanente | lilia | Healthcare,Hospitals | A | Enterprise | Hybrid | https://kp.org | ... | indeed | kaiser-sac | <notion-uuid> |
```

`industries` is comma-separated because it's a multi_select. `notion_page_id` is there for reverse maintenance.

### New phase in `engine/commands/sync.js`

```
node engine/cli.js sync --profile jared --apply
  Phase 1 (existing): pipeline (Notion) ↔ applications.tsv
  Phase 2 (new):     companies (Notion) → data/companies.tsv (only jared-rows, full overwrite)
```

Sync for Healthcare-Hannah is the same, but updates only lilia-rows.

```
node engine/cli.js sync-companies --all --apply
  Alternative: a single pass over both profiles, full TSV overwrite.
```

Implementation — extend the existing sync.js, add a `--companies-only` flag if only this step is needed.

### Validation rule (industries are mandatory)

Sync fails if any company in Notion has no industries:

```
ERROR: "Cameron Park Dental Office" (lilia) has no Industry set in Notion.
       Industries are mandatory. Fix in Notion: <page-url>
       Or pass --skip-empty-industries to ignore (not recommended).
```

`engine/commands/validate.js` also adds a check for this rule.

### Helper `companiesForProfile`

```js
// engine/core/companies.js
function companiesForProfile(profileId, allCompanies) {
  return allCompanies.filter(c => c.profile === profileId);
}

function companiesForProfileByIndustry(profileId, allCompanies, industries) {
  // For future industry-based filtering. Profile-scoped.
  const set = new Set(industries.map(i => i.toLowerCase()));
  return companiesForProfile(profileId, allCompanies)
    .filter(c => (c.industries || []).some(i => set.has(i.toLowerCase())));
}
```

### Check fix (`engine/commands/check.js`)

#### `--prepare`

```js
// Was:
const companies = Object.keys(activeJobsMap);  // ~88

// Becomes:
const allCompanies = loadCompanies('data/companies.tsv');
const profileCompanies = companiesForProfile(profile.id, allCompanies);
const fromApps = unique(apps.map(a => a.companyName).filter(Boolean));
const watchlist = uniqueCaseInsensitive([
  ...profileCompanies.map(c => c.name),
  ...fromApps  // safety net in case sync lags behind
]);
```

`activeJobsMap` (for the Notion-write path) **does not change** — only active applications can receive a status update.

#### New ATS-fallback batch in `buildBatches`

```js
const ATS_DOMAINS = [
  'greenhouse.io', 'myworkday.com', 'ashbyhq.com', 'lever.co',
  'icims.com', 'smartrecruiters.com', 'workable.com', 'rippling.com', 'eightfold.ai'
];
batches.push(`from:(${ATS_DOMAINS.map(d => `@${d}`).join(' OR ')}) ${searchWindow} -from:me`);
```

#### Two-level matcher in `processPipeline`

```js
match = findCompany(email, activeJobsMap)
if (match) { /* normal flow: status + comment */ }
else {
  const inactiveMatch = findCompanyInList(email, watchlist)
  if (inactiveMatch) {
    row.action = "matched: inactive company, no Notion update"
    row.company = inactiveMatch
  }
}
```

#### context.json new fields

```diff
+ "watchlistCount": 257,
+ "watchlist": ["Affirm", "Robinhood", "Stripe", ...],
  "activeCompanyCount": 88,
  "activeJobsMap": {...},
```

### Notion changes (pre-work, not code)

1. **Healthcare-Hannah's Industry options** — copy from PM-Pete's schema (via MCP `notion-update-data-source`) and add healthcare-specific ones: Healthcare, Dental, Vision, Hospitals, Hospice, Physical Therapy, Skin/Aesthetics, Hearing, Eye Care, Mental Health.

2. **Fill industries on all of Healthcare-Hannah's 77 companies** — wherever empty. Her whitelist shows that 99% are Dental/Vision/Healthcare/Hospitals.

3. **Fill industries on PM-Pete's companies in Notion** where empty (if any).

4. **Backfill into Notion**: verify that all 250 companies from the current `data/companies.tsv` exist in PM-Pete's Notion DB. If any are missing — create them via MCP `notion-create-pages`.

### Migration plan (step-by-step)

| Step | What | Input | Output |
|---|---|---|---|
| 1 | **Notion audit** | Jared/Lily Companies DBs | Report: how many companies, how many with empty industries, diff vs `data/companies.tsv` |
| 2 | **Fill Healthcare-Hannah's Industry options** | List of options (see above) | Healthcare-Hannah's DB with options |
| 3 | **Fill industries on all companies** in both Notion DBs (user does it or Claude via MCP with approve) | Audit report | All companies in Notion have ≥1 industry |
| 4 | **Backfill into Notion** the missing companies from `data/companies.tsv` | Diff from step 1 | Notion DB complete |
| 5 | **Implement sync companies-phase** + validation | RFC | Code + tests |
| 6 | **Run sync** for both profiles | Notion data | New `data/companies.tsv` with all columns |
| 7 | **Implement `companiesForProfile`** + use in check | Synced TSV | Code + tests |
| 8 | **Implement ATS-fallback + two-level matcher** | RFC | Code + tests |
| 9 | **Copy PM-Pete's processed_messages** from legacy | `Job Search/processed_email_ids.json` | `profiles/jared/.gmail-state/processed_messages.json` |
| 10 | **Run check** for PM-Pete (`--prepare → MCP → --apply`) | Watchlist | Report: matched, actions, errors |
| 11 | **Backfill PM-Pete** with a one-off script for missed companies (30d window) | Diff old vs new watchlist | Report + Notion updates |
| 12 | **Run check** for Healthcare-Hannah (first time = auto-backfill 30d) | — | Report |
| 13 | **Update `SKILL_check.md`** | — | Skill calls the new CLI |
| 14 | **Rename legacy** `Job Search/check_emails.js` → `*.deprecated-2026-04-30` | — | One path for check |

### Production readiness (for cron deploy in another session)

The engine is designed to **not depend on Claude MCP** in `--apply`:
- Notion: via `NOTION_TOKEN` in `.env`.
- Gmail: still MCP-driven (the `--prepare` phase prints batches, the `--apply` phase consumes raw_emails.json). For cron — wrapping via the `googleapis` SDK is needed (this is **another user session**, not part of this RFC).
- TSV: local read/write.

What I guarantee in this RFC: **all invasive Notion and TSV mutations happen via explicit flags (`--apply`)**, with no implicit Claude-session-bound things.

## Tests

- **`engine/core/companies.js`**: load with the new schema, `companiesForProfile` filter.
- **`engine/commands/sync.js`**: companies-phase with Notion mocks (Jared + Lily fixture); validation fails on empty industries.
- **`engine/commands/check.js`**: 
  - buildBatches → ATS-fallback batch in place.
  - processPipeline → two-level match (active → action; inactive → log).
- **`engine/commands/validate.js`**: rule about industries.
- **Integration smoke**: end-to-end on 2 fake profiles, gmail mock returns a random mix of emails.

## DOD

- [ ] Notion audit report done and shown to the user.
- [ ] Healthcare-Hannah's Industry options created (≥10 options).
- [ ] Industries filled on all companies in both Notion DBs (user approves each bulk-update).
- [ ] `data/companies.tsv` updated with the full schema via sync.
- [ ] `companiesForProfile` written + covered by unit tests (3 cases).
- [ ] sync companies-phase + tests.
- [ ] validate rule + test.
- [ ] check.buildBatches with ATS-fallback + test.
- [ ] check.processPipeline two-level matcher + tests.
- [ ] All engine tests green.
- [ ] PM-Pete's processed_messages copied.
- [ ] check run for PM-Pete, report shown.
- [ ] PM-Pete backfill run, report shown.
- [ ] check run for Healthcare-Hannah, report shown.
- [ ] `SKILL_check.md` updated.
- [ ] The old `Job Search/check_emails.js` deprecated.
- [ ] Code-reviewer subagent ran the diff.
- [ ] RFC 006 and 007 marked superseded.

## Risks

| Risk | Mitigation |
|---|---|
| Healthcare-Hannah's Industry options are empty → sync fails | Step 2 in the migration plan: create options before running sync. |
| Not all 250 fintech in `data/companies.tsv` are in PM-Pete's Notion DB | Step 4: audit + backfill into Notion. If the user doesn't want it — keep it as a warning in sync. |
| Bulk-filling industries in Notion (Healthcare-Hannah's 77 companies without industries) — many operations | First auto-classify by name (Dental Office → Dental, etc.), then user reviews, then MCP applies. |
| Sync does a full TSV overwrite → loss of data not in Notion | Backup before every sync (`.tsv.bak-YYYY-MM-DD`). Diff in the log. |
| Gmail rate limits at ~250+ companies for PM-Pete (≈25 batches) | BATCH_SIZE can be raised from 10 to 15 if we hit a wall. We've tested 11 without problems. |
| PM-Pete backfill produces false positives | Classifier drops OTHER → no action. Manual review summary before apply. |

## What is **not** in this RFC (separate tasks)

- Cron deploy on a server (another user session).
- Gmail OAuth integration via the googleapis SDK (another session).
- Industry-based filtering for scan (`profile.target_industries` ∩ `companies.industries`) — next iteration after stable 008.
- Two-way sync `companies.tsv` ↔ Notion (currently one-way Notion → TSV).

---

**Approve required before implementation.**
