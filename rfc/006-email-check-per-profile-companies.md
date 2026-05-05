---
id: RFC-006
title: check company set — per-profile coverage + ATS fallback + backfill
status: superseded
tier: M
created: 2026-04-30
decided: 2026-04-30
superseded-by: RFC-008
tags: [gmail, check, companies]
---

# RFC 006 — `check` company set: per-profile coverage + ATS fallback + backfill

**Status**: Superseded by [RFC 008](./008-companies-as-notion-source-of-truth.md) on 2026-04-30
**Tier**: M (changes in `engine/commands/check.js` + migration of `Job Search/SKILL_check.md` + one-off backfill)
**Author**: Claude + PM-Pete
**Supplements**: [RFC 002 — check command](./002-check-command.md)
**Related**: [RFC 007 — industries-as-relations (planned)](./007-industries-as-relations.md) — next architectural iteration

## Problem

The current implementation of `check --prepare` ([engine/commands/check.js:107-127](../engine/commands/check.js)) builds `activeJobsMap` only from rows that simultaneously have:
- `status ∈ {To Apply, Applied, Interview, Offer}`
- `notion_page_id` set

This yields ~88 companies for PM-Pete (out of ~250+ tracked). All other companies are invisible. Specific misses today: Robinhood, Hippo Insurance, Marqeta, Deel, TabaPay.

Parallel problems:
- Emails from ATS domains (greenhouse/lever/ashby/workday), where the company name appears only in the body, are partially lost.
- The legacy prototype `Job Search/check_emails.js` is still being run via `Job Search/skills/job-pipeline/SKILL_check.md` and carries the same bug.
- Healthcare-Hannah has never once run check through the engine (no `profiles/lilia/.gmail-state/`) → her replies (including dental invitations) are processed manually.

## Locked-in design

### Source of the company set (general-purpose, both profiles)

```js
function buildCompanySet(profile, apps, globalCompaniesTsv) {
  // 1. If the whitelist is non-empty — it is the source of truth for the profile
  const wl = profile.discovery?.companies_whitelist;
  if (wl && wl.length > 0) {
    return uniqueCaseInsensitive([...wl, ...apps.map(a => a.companyName).filter(Boolean)]);
  }
  // 2. Otherwise — global pool minus blacklist + applications
  const bl = new Set((profile.discovery?.companies_blacklist || []).map(s => s.toLowerCase()));
  const fromGlobal = globalCompaniesTsv.map(c => c.name).filter(n => !bl.has(n.toLowerCase()));
  return uniqueCaseInsensitive([...fromGlobal, ...apps.map(a => a.companyName).filter(Boolean)]);
}
```

**Effect for current profiles:**
- PM-Pete (`whitelist: null`) → 250 fintech from `data/companies.tsv` + ~250 unique from his applications.tsv (after dedup ~300 total).
- Healthcare-Hannah (`whitelist: [75 healthcare]`) → 75 whitelist + ~75 unique from applications.tsv (after dedup ~80-100 total).

**Isolation is automatic** (no per-profile branches in code):
- Different Gmail inboxes (`ymuromcev@gmail.com` vs `liliachirova@gmail.com`).
- Different `applications.tsv`.
- Different whitelists.

**This is a temporary solution**. The correct architecture — a unified company catalog with industry-relations to profiles — is described in RFC 007.

### Changes in `engine/commands/check.js`

#### 1. New function `buildCompanySet` (see above)

Exported separately for testability.

#### 2. `buildActiveJobsMap` — unchanged

This function is needed for **matching** an email to a specific active application (Notion page id). No need to expand it — Notion updates are made only for active applications.

#### 3. New ATS-fallback batch in `buildBatches`

After company-batches and LinkedIn/recruiter, the following is appended:

```js
const ATS_DOMAINS = [
  'greenhouse.io', 'myworkday.com', 'ashbyhq.com',
  'lever.co', 'icims.com', 'smartrecruiters.com',
  'workable.com', 'rippling.com', 'eightfold.ai'
];
batches.push(
  `from:(${ATS_DOMAINS.map(d => `@${d}`).join(' OR ')}) ${searchWindow} -from:me`
);
```

This catches emails where the company name appears only in the body.

#### 4. Two-level matcher in `processPipeline`

```js
// 1. Active match → Notion update
match = findCompany(email, activeJobsMap)
if (match) { /* normal flow with status+comment */ }

// 2. Inactive match → log "matched but inactive", no Notion mutation
else {
  const inactiveMatch = findCompanyInSet(email, allCompaniesList)
  if (inactiveMatch) {
    row.action = "matched: inactive company, no Notion update"
    row.company = inactiveMatch
  }
}
```

Gives telemetry "we see an email from X, but it's Closed" without noise in Notion.

#### 5. Extended `check_context.json`

```diff
{
  "profileId": "...",
  "epoch": ...,
  "batches": [...],
- "companyCount": 88,
+ "activeCompanyCount": 88,
+ "totalCompanyCount": 257,
  "activeJobsMap": {...},
+ "allCompaniesList": ["Affirm", "Robinhood", ...],
  "processedIds": [...]
}
```

### Preparatory steps before launch

1. **Copy PM-Pete's processed-state** from legacy:
   ```bash
   cp "Job Search/processed_email_ids.json" "ai-job-searcher/profiles/jared/.gmail-state/processed_messages.json"
   ```
   (with format conversion if needed — verify the schema).

2. **Create `.gmail-state/` for Healthcare-Hannah**:
   ```bash
   mkdir -p "ai-job-searcher/profiles/lilia/.gmail-state"
   ```
   processed_messages.json will be created on the first `--apply`.

3. **MCP access to Healthcare-Hannah's Gmail** — verify via `mcp__06081052-...__list_labels` or similar, that Claude has access to `liliachirova@gmail.com`. If not — the user connects it.

### Changes in `Job Search/skills/job-pipeline/SKILL_check.md`

```diff
-node check_emails.js --prepare
+node ../ai-job-searcher/engine/cli.js check --profile jared --prepare
```

Step 4 → `... check --profile jared --apply`.

Step 4b (Notion MCP updates) — **delete**. The new engine applies Notion directly via `NOTION_TOKEN` from `.env`.

Default profile = jared. For Healthcare-Hannah — explicit command `/job-pipeline check lilia` (user rule).

The old `Job Search/check_emails.js` — rename to `check_emails.js.deprecated-2026-04-30` after the first successful run.

### Backfill (one-off script for PM-Pete)

`ai-job-searcher/scripts/backfill_missed_companies_jared.js` — one-off, will be removed after the run:

1. Load the old `Job Search/email_check_context.json` (88 companies).
2. Load the new company set via `buildCompanySet(jaredProfile, apps, globalTsv)`.
3. Diff → list of missed companies (~170-200).
4. Generate Gmail batches `after:30d ago` only for the missed companies.
5. Prints batches as JSON for Claude → MCP search → `raw_emails_backfill.json`.
6. Process with the same rules as a normal `--apply`.
7. Report: how many emails were found, how many rejection/interview/info, how many Notion updates were applied.

**The backfill applies to Notion** (apply-mode, not dry-run). Accepted by PM-Pete — if a rejection arrived in the last 30 days that we missed, it's better to mark it now than to keep it hanging in Applied.

For Healthcare-Hannah — no backfill is needed; her first run will automatically take a 30-day window (the cursor starts at now-30d when processed_messages.json is absent).

## Tests

- **`buildCompanySet`** — unit:
  - whitelist non-empty → take whitelist + apps.
  - whitelist empty/null → globalTsv (minus blacklist) + apps.
  - case-insensitive dedup.
  - both sources empty → empty Set.
- **`buildBatches`** — updated: verify that an ATS-fallback batch is added.
- **`processPipeline`** — updated: inactive-match yields row.action=`matched: inactive`, no action built.
- **Integration smoke**: fake profile with whitelist + 3 apps → batches are generated, mock returns 1 email from an inactive company → row is present, no Notion action.

## DOD

- [ ] `buildCompanySet` written + covered by unit tests (4 cases).
- [ ] `buildBatches` modified, ATS-fallback batch in place, tests updated.
- [ ] `processPipeline` two-level match, tests updated.
- [ ] All tests in `engine/commands/check.test.js` green.
- [ ] PM-Pete's processed_messages copied from legacy.
- [ ] `.gmail-state/` created for Healthcare-Hannah.
- [ ] MCP access to Healthcare-Hannah's Gmail confirmed (or connected by the user).
- [ ] `SKILL_check.md` updated.
- [ ] Run 1 cycle `--prepare → MCP search → --apply` for PM-Pete with no errors.
- [ ] Run 1 cycle for Healthcare-Hannah with no errors (this is her first run = automatic 30d backfill).
- [ ] `backfill_missed_companies_jared.js` written, run, report shown to PM-Pete.
- [ ] The old `Job Search/check_emails.js` marked deprecated.
- [ ] Code-reviewer subagent ran the diff (mandatory for M).
- [ ] RFC 007 stub created, task for industry-relations refactor opened in Notion.

## Risks

- **Gmail rate limits.** For PM-Pete 250+ companies → ~25 batches instead of 11. MCP search_threads against 25 batches at once — should be OK (we tested 11 without problems). If we hit a wall — raise `BATCH_SIZE` from 10 to 15.
- **Healthcare-Hannah's companies are very short** ("CHG Therapies LLC", "Anna G Uppal DDS Corp") → may catch noise in `subject:(...)`. Mitigation: the tokenizer already drops `LLC/Inc/PC/DDS` — verify that this works.
- **MCP access to Healthcare-Hannah's Gmail** — if absent, blocker.
- **PM-Pete backfill — false positives.** If a newsletter/marketing email from a watchlist company arrives within 30 days → false positive. Mitigation: the classifier should return OTHER → no action.

## Implementation plan (step-by-step)

1. Implement `buildCompanySet` + 4 unit tests.
2. Update `buildBatches` (+ ATS-fallback) + test.
3. Update `processPipeline` (two-level match) + tests.
4. `runPrepare`: calls `buildCompanySet`, passes it into `buildBatches`, puts `allCompaniesList` into context.
5. `runApply`: uses `context.allCompaniesList` for inactive-match.
6. Run `npm test` — all green.
7. Code-reviewer subagent on the diff.
8. Copy PM-Pete's processed_messages.
9. Create .gmail-state for Healthcare-Hannah.
10. Run `--prepare → MCP → --apply` for PM-Pete dry-run, then apply.
11. Run for Healthcare-Hannah.
12. Update `SKILL_check.md`.
13. Write and run `backfill_missed_companies_jared.js` for PM-Pete.
14. Report to the user.
15. Rename the old script.

---

**Approve required before implementation.**
