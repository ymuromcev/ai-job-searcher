---
id: RFC-010
title: Workday tenants for Lilia (healthcare)
status: implemented
tier: M
created: 2026-05-02
decided: 2026-05-02
tags: [discovery, workday, healthcare]
---

# RFC 010 — Workday tenants for Healthcare-Hannah (healthcare)

**Status**: Approved 2026-05-02 (user confirmed option A)
**Tier**: M (activation of existing adapter + tenant config + tests)
**Author**: Claude + repo owner (Healthcare-Hannah)
**Depends on**: [RFC 008 — Companies as Notion source of truth](./008-companies-as-notion-source-of-truth.md) (RFC 008 introduced per-profile companies — this RFC uses the same model)

## Problem

Healthcare-Hannah's discovery currently works only via the Indeed flow:
- 73 healthcare companies in `profile.json.discovery.companies_whitelist`.
- Realtime/recurring scan via Greenhouse / Lever / Ashby / SmartRecruiters / Workday is activated in `profile.json.modules`, but **not a single healthcare tenant** is in `data/companies.tsv` under `source=workday`. Currently there are only 3 fintech (PayPal, Capital One, Fidelity), targeted at PM-Pete.
- Indeed flow is one-shot: on 2026-04-28 we loaded 33 jobs, that's it. Without recurring discovery, new positions at major healthcare networks do not arrive.

Meanwhile, major healthcare networks (Kaiser, Sutter, UC Davis Health, etc.) **publish jobs on Workday at least partially** — it's the most standard enterprise ATS for healthcare and finance. Activating the adapter for them gives a recurring scan without browser-script-ingest sessions.

## Recorded decisions (proposed)

| # | Decision | Alternative |
|---|---------|---------------|
| 1 | Tenant registration via **shared `data/companies.tsv`** (as for PayPal/Capital One/Fidelity for PM-Pete). We do not make a per-profile target list. | Per-profile `profile.json.discovery.workday.tenants[]` — rejected: duplicates the existing mechanism, breaks consistency. |
| 2 | Healthcare-Hannah's `profile.json.discovery.companies_whitelist` already contains exact names (Kaiser Permanente / Sutter Health / UC Davis Health). We guarantee **strict match of the `name` field** in TSV — otherwise scan will discard the target. | Add aliases / fuzzy match — no, scan filter is currently lowercase exact name (see `applyTargetFilters` in `scan.js`). |
| 3 | **Tenant slugs / `dc` / `site` are determined by the user** (through Lilia or WebSearch on the user's side). Claude does NOT guess — this is a rule from BACKLOG. | Claude guesses — rejected, the cost of error = silent 404 on each scan. |
| 4 | The adapter already filters by `searchText` (POST body). We use it so that tenants return only relevant roles (admin/scheduler/front-desk healthcare), not all 5000 Kaiser jobs. | Without `searchText` — rejected: we'll hit `MAX_JOBS_PER_TENANT=200` with word filters, lose signal. |
| 5 | Cross-profile isolation rests on **Healthcare-Hannah's whitelist** + the fact that these healthcare tenants will not appear in PM-Pete's whitelist (he has `companies_whitelist: null`, but there is no `target_industries` filter on scan — so the risk that PM-Pete's pipeline gets Kaiser healthcare jobs is real). | See "Risks" section. |

## Architecture

### Changes in `data/companies.tsv`

Add N rows (N = number of approved tenants, expected 3-5):

```
name                  ats_source  ats_slug         extra_json
Kaiser Permanente     workday     <slug>           {"dc":"<dc>","site":"<site>","searchText":"medical receptionist"}
Sutter Health         workday     <slug>           {"dc":"<dc>","site":"<site>","searchText":"patient access"}
UC Davis Health       workday     <slug>           {"dc":"<dc>","site":"<site>","searchText":"medical receptionist"}
...
```

The `<slug>` / `<dc>` / `<site>` fields are confirmed by the user before commit.

### Changes in `profile.json` (Lilia)

**Not needed.** `modules: ["...", "discovery:workday", ...]` is already there. The whitelist already contains the required names.

### Changes in code

**Not needed** (if tenant slugs are correct). Adapter, scan orchestrator, filters — everything works as-is.

## Verification plan

### Pre-merge (mocks)

1. `engine/modules/discovery/workday.test.js` — already covers map / pagination / per-tenant failure isolation. We don't change it.
2. **Add a unit test** in `engine/commands/scan.test.js` (or adjacent): scenario "Lilia + Workday tenants in companies.tsv with healthcare names + Healthcare-Hannah's whitelist → adapter gets only healthcare targets, no PayPal/Capital One/Fidelity". The goal is to lock in the behavior of `applyTargetFilters` for a mixed pool.

### Post-merge (live smoke)

1. `node engine/cli.js scan --profile lilia --dry-run` — should output:
   - `scanning N targets across M sources for profile "lilia"` — N includes healthcare tenants.
   - `discovery summary: ... workday: <N> returned` — without 4xx/5xx errors.
2. Check `result.fresh.length` — are there real jobs. If 0 on three tenants in a row with `searchText="medical receptionist"` — this is a signal that either the tenant slug is wrong, or these networks don't publish receptionists on Workday (we need a second source for them — backlog).
3. If OK — `--apply` run, jobs into Healthcare-Hannah's `applications.tsv`. Then the regular `validate` / `prepare` flow.

## Risks

### R1 — Guessed tenant slugs give 404 / redirect

The highest risk. Workday slug ≠ company domain name on the public web. For Capital One, slug = `capitalone`, dc = `wd12`, site = `Capital_One` — three independent parameters, none derivable from the name.

**Mitigation**: rule #3 (Claude does not guess). Before adding to TSV — the user confirms each triple (slug/dc/site) with a link to a working URL of the form `https://{slug}.{dc}.myworkdayjobs.com/{site}/`. The adapter handles per-tenant failures in isolation (`runTargets` catches exceptions per target), so a broken tenant won't kill the scan, but it won't be useful either.

### R2 — Cross-profile leakage (PM-Pete gets healthcare)

PM-Pete has `companies_whitelist: null` → `applyTargetFilters` lets all targets through, including new healthcare ones. If Healthcare-Hannah's Workday tenants land in `data/companies.tsv`, on the next `scan --profile jared` Kaiser/Sutter will also be scanned and end up in PM-Pete's `applications.tsv`.

**Mitigation (3 options, choose before commit)**:

- **A.** Add healthcare names to PM-Pete's `profile.json.discovery.companies_blacklist`. Minimally invasive, but requires maintaining the list when adding new tenants.
- **B.** Use the mechanism from RFC 008 (`profile` column in `companies.tsv` + `companiesForProfile` filter). Cleaner, but RFC 008 isn't implemented yet.
- **C.** Enable a whitelist for PM-Pete (explicit list of fintech names). Strictest, but requires manual maintenance of ~80 names.

**Recommendation: A** as a tactical fix now + add a BACKLOG entry to switch to B when RFC 008 is implemented.

### R3 — Healthcare tenants return thousands of irrelevant jobs

Kaiser Permanente is a major employer; Workday may have tens of thousands of positions. Without `searchText` we'll hit `MAX_JOBS_PER_TENANT=200` on a random sample.

**Mitigation**: rule #4 (`searchText` required). Per-tenant `searchText` is selected to fit Healthcare-Hannah's key roles from `target_roles`: "medical receptionist", "patient access", "patient services", "front desk". You can have 1-2 rows per tenant with different `searchText` if you need to cover multiple role types.

### R4 — Low signal-to-noise even with searchText

Healthcare Workday jobs may turn out to be mostly nursing/clinical roles (RN, LVN, MA), which are in Healthcare-Hannah's `cert_blockers`. Scan will pull them, then `validate` will filter, but noise in `applications.tsv` will remain.

**Mitigation**: after the first live smoke, look at signal/noise. If noise > 80% — add a pre-filter in the Workday adapter (e.g., drop titles containing RN/LVN/MA/CNA). Not now, leave in backlog.

## Implementation plan (after approve)

1. **The user provides**: a list of tenants with verified `slug` / `dc` / `site` / optionally `searchText`. Minimum 1, recommended 3-5.
2. Decision on R2 (cross-profile leakage): A / B / C.
3. **Code**:
   - Append rows to `data/companies.tsv`.
   - If R2-fix A is chosen — add healthcare names to `profiles/jared/profile.json.discovery.companies_blacklist`.
   - Add a unit test for cross-profile isolation in `engine/commands/scan.test.js`.
4. **Smoke**:
   - `npm test` — all 524+ tests green.
   - `node engine/cli.js scan --profile lilia --dry-run` — N targets, 0 adapter errors on new tenants.
   - `node engine/cli.js scan --profile jared --dry-run` — should NOT include healthcare tenants.
5. **Code-review agent** on the diff.
6. Show user: diff + smoke output. Approve → commit.
7. Live `--apply` run for Healthcare-Hannah — pull real jobs.

## Recorded decisions (after research 2026-05-02)

### Tenants

Out of 5 requested S/A-tier healthcare networks, **3 are confirmed on Workday** (the rest are on Taleo / iCIMS / NEOGOV / UC HR — out of scope for this RFC):

| Name (matches whitelist) | slug | dc | site | URL |
|---|---|---|---|---|
| Sutter Health | `sutterhealth` | `wd1` | `SH` | `https://sutterhealth.wd1.myworkdayjobs.com/SH` |
| Fresenius Medical Care | `freseniusmedicalcare` | `wd3` | `fme` | `https://freseniusmedicalcare.wd3.myworkdayjobs.com/fme` |
| SCAN Health Plan | `scanhealthplan` | `wd108` | `scancareers` | `https://scanhealthplan.wd108.myworkdayjobs.com/scancareers` |

The remaining major networks (Kaiser, CommonSpirit/Dignity, UC Davis Health, Shriners, HearingLife, Sacramento County) are on other ATS. Coverage — separate RFC (new adapter for iCIMS / Taleo / NEOGOV), record in BACKLOG.

### searchTexts strategy

`data/companies.tsv` deduplicates rows by `(source, slug)` — you can't put 8 rows for one tenant. Solution: **extend the adapter** so that `extra_json` supports `searchTexts: string[]` (array) OR `searchText: string` (legacy). If an array — the adapter loops over queries and dedupes results by `jobId` (`externalPath`).

8 queries per tenant cover Healthcare-Hannah's `target_roles`:

```
patient access, patient services, scheduler, front desk,
receptionist, admissions, intake coordinator, authorization
```

Noise from RN/LVN/MA is cut off already on the Healthcare-Hannah `validate` side via `cert_blockers` — a post-filter, a separate pipeline step.

### R2-fix: B (structural — `profile` column in `data/companies.tsv`)

**Changed after review with the user**: A (blacklist for PM-Pete) was rejected as non-extensible (each healthcare addition = manual patch for PM-Pete). Instead, B is implemented — a minimal subset of RFC 008 without migration to Notion-as-source-of-truth:

- `data/companies.tsv` extended with a fifth column `profile` (values: `<id>` / empty / `both`).
- `engine/core/companies.js` — `parseLine` is backward-compatible (4-col rows read as `profile=""`), `serialize` writes 5-col, new helper `filterByProfile(rows, profileId)` + `rowVisibleToProfile()`.
- `engine/commands/scan.js` — added pre-filter `filterCompaniesByProfile` BEFORE whitelist/blacklist. Profile visibility is a structural gate.
- `data/companies.tsv` migrated: 248 fintech rows → `profile=jared`, 4 healthcare rows (Sutter/Fresenius/SCAN/Indeed Lilia) → `profile=lilia`. Backup: `data/companies.tsv.pre-rfc010`.
- `profiles/jared/profile.json.discovery.companies_blacklist` reset to `[]` — no longer needed.

The long-term full RFC 008 (Notion as source of truth for companies, sync companies → TSV, industry as relations) remains in the backlog as a separate L task.

## Related

- BACKLOG #1 (Active queue, 2026-05-02) — this RFC closes.
- RFC 008 — long-term solution for R2 (per-profile companies).
- `incidents.md` 2026-05-02 — Healthcare-Hannah's cron is currently disabled until the classifier fix is verified; this RFC is independent, but when enabling, we need to check that workday targets do not give the classifier new false-positive triggers.
