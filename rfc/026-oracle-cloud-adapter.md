---
id: RFC-026
title: Oracle Recruiting Cloud (Fusion HCM) adapter
status: draft
author: Claude (via Jared/Lilia)
created: 2026-05-11
refs:
  - BL-30
  - BL-38
  - RFC-025
---

# RFC 026 — Oracle Recruiting Cloud (Fusion HCM) adapter

## 1. Goal

Add a `discovery:oracle_cloud` adapter so Lilia's pipeline can pull
public job listings from Oracle Fusion HCM Candidate Experience (CE)
career sites. Primary target: **Adventist Health** (HQ Roseville CA,
Tier S for Lilia, 1393 active reqs on 2026-05-11). Adapter is
multi-tenant by design so future Oracle Cloud customers (Blue Shield
CA, etc.) can be added as TSV rows without code changes.

## 2. Non-Goals

- **Auth flow.** Public anonymous listing only. No candidate-account
  login, no internal-only postings.
- **Other Oracle products.** Oracle Taleo (Kaiser), Oracle Peoplesoft
  Recruiting — different platforms, separate adapters if ever needed.
- **Per-tenant onboarding for non-Adventist tenants in this RFC.**
  Adapter generalises to any Oracle CE host; adding a second tenant
  is a TSV row, not a code change. But this RFC only commits to
  Adventist as the validation tenant.
- **Auto-derivation of `siteUrl`.** Each tenant configures `siteUrl`
  in `meta` directly. No magic redirect-following.

## 3. Recon summary (Phase A, 2026-05-11)

Full results in `private/backlog/BL-38.md` Progress section. Headline
findings:

| Field | Value |
|---|---|
| Endpoint | `{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` |
| Method | GET |
| Auth | none (anonymous public) |
| Required params | `finder=findReqs;siteNumber={CX}`, `onlyData=true`, `expand=requisitionList`, `limit`, `offset` |
| Response type | `application/vnd.oracle.adf.resourcecollection+json` (JSON) |
| Total Adventist reqs | 1393 active |
| Detail endpoint | `{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?finder=ById;Id={ID},siteNumber={CX}` |
| Apply URL | `{siteUrl}/job/{Id}` |

The `items[0]` wrapper is a search-state object — actual jobs are in
`items[0].requisitionList[]`. Each requisition exposes `Id` (string),
`Title`, `PrimaryLocation` (e.g. `"Roseville, CA, United States"`),
`PostedDate` (ISO date), `Department`, `JobFamily`,
`WorkplaceTypeCode`, `secondaryLocations`.

`keyword` query param is too broad to use as a precise geo filter
(searches title + JD content; `keyword=Sacramento` returned a job in
Tillamook OR because `Sacramento` appeared in the JD). The
`locationId` filter requires per-tenant geography UUIDs that aren't
discoverable without a UI session — too fragile. **Decision:
fetch tenant-wide, post-filter by `profile.geo.cities` on the
`PrimaryLocation` string.** Pattern matches `icims.js` and `workday.js`.

## 4. URL pattern & host model

Oracle Fusion HCM CE tenants live at unique hostnames that combine the
tenant's environment code and Oracle's data-center region:

```
{instance}.fa.{region}.oraclecloud.com
```

Examples:

- Adventist Health: `ecvz.fa.us2.oraclecloud.com`
- Blue Shield CA (future): TBD via recon.

The hostname is unique per tenant and not derivable from the company
name — store it in `meta.siteUrl` as a full URL to the Candidate
Experience root, e.g.
`https://ecvz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/`.
The adapter derives both API host and apply-URL base from this single
field.

The `siteNumber` (CX in Adventist's case) is the active site
identifier within the tenant's instance. Default: `CX`. Override via
`meta.siteNumber` if a tenant exposes a non-default site.

## 5. Adapter design

File: `engine/modules/discovery/oracle_cloud.js` (~120 lines).
Follows the `workday.js` shape: `runTargets` over the tenant list,
paginated fetch per tenant, normalize via `_normalize.js` helpers,
`assertJob` on output.

```js
const SOURCE = "oracle_cloud";
const PAGE_LIMIT = 200;            // Oracle accepts up to 200/page
const MAX_JOBS_PER_TENANT = 2000;  // hard cap; Adventist sits at 1393

function deriveApiBase(siteUrl) {
  // siteUrl: https://ecvz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/
  const u = new URL(siteUrl);
  return `${u.protocol}//${u.host}`;
}

function buildFinder(siteNumber) {
  return `findReqs;siteNumber=${encodeURIComponent(siteNumber)}`;
}

function buildPageUrl(apiBase, siteNumber, offset, limit) {
  const finder = buildFinder(siteNumber);
  return `${apiBase}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
    `?onlyData=true&expand=requisitionList` +
    `&limit=${limit}&offset=${offset}` +
    `&finder=${encodeURIComponent(finder)}`;
}

async function fetchAllPages(fetchFn, apiBase, siteNumber, signal) {
  const all = [];
  for (let offset = 0; offset < MAX_JOBS_PER_TENANT; offset += PAGE_LIMIT) {
    const url = buildPageUrl(apiBase, siteNumber, offset, PAGE_LIMIT);
    const body = await fetchJson(fetchFn, url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
    const wrapper = (body && body.items && body.items[0]) || null;
    const page = (wrapper && Array.isArray(wrapper.requisitionList)
      ? wrapper.requisitionList : []);
    all.push(...page);
    const total = Number(wrapper && wrapper.TotalJobsCount) || 0;
    if (page.length < PAGE_LIMIT) break;
    if (total && all.length >= total) break;
  }
  return all;
}

function mapJob(target, siteUrl, raw) {
  const id = raw && raw.Id ? String(raw.Id) : "";
  if (!id) return null;
  if (!locationMatchesAllow(raw.PrimaryLocation, target.locationAllow)) {
    return null;
  }
  return assertJob({
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId: id,
    title: sanitizeText(raw.Title),
    url: safeJoinUrl(siteUrl, `job/${id}`),
    locations: dedupeLocations([raw.PrimaryLocation]),
    team: sanitizeText(raw.Department) || null,
    postedAt: parseIsoDate(raw.PostedDate),
    rawExtra: {
      jobFamily: raw.JobFamily || null,
      workplaceType: raw.WorkplaceTypeCode || null,
    },
  });
}

async function discover(targets, ctx) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  const effectiveCtx = { ...c, concurrency: Math.min(c.concurrency || 2, 2) };
  return runTargets(targets, effectiveCtx, async (target) => {
    if (!target || !target.slug || !target.siteUrl) return [];
    const apiBase = deriveApiBase(target.siteUrl);
    const siteNumber = target.siteNumber || "CX";
    const raws = await fetchAllPages(c.fetchFn, apiBase, siteNumber, c.signal);
    const jobs = [];
    for (const r of raws) {
      const job = mapJob(target, target.siteUrl, r);
      if (job) jobs.push(job);
    }
    return jobs;
  });
}
```

`locationMatchesAllow` reuses the substring matcher from `workday.js`
(copied or extracted to `_normalize.js` if test demands).

### Per-target meta fields

The adapter expects each target (built from `data/companies.tsv`) to
carry:

- `siteUrl` *(required)* — full URL to CE root,
  trailing slash optional. Adapter normalizes.
- `siteNumber` *(optional, default `CX`)* — site identifier within the
  tenant.
- `locationAllow` *(optional, array)* — substring patterns for
  adapter-level geo pre-filter on `PrimaryLocation`. Populated by
  engine from `profile.geo.cities` (consistent with `workday.js`).

## 6. TSV row format

```
Adventist Health	oracle_cloud	adventisthealth	{"siteUrl":"https://ecvz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/"}	lilia
```

Columns: `name`, `source`, `slug`, `meta` (JSON), `profile`. `slug`
is opaque — used purely as the local identifier; not transmitted to
Oracle. Adapter ignores `slug` for HTTP requests (everything comes
from `meta.siteUrl` + default `siteNumber=CX`).

`siteNumber` omitted from `meta` → defaults to `CX`.
Future Adventist site change → update `meta.siteUrl` in TSV, no code.

## 7. Geo filtering strategy

Two-stage, matching `workday.js`:

1. **Adapter-level pre-filter** via `target.locationAllow`. Engine
   `core/scan.js` populates this from `profile.geo.cities` before
   handing targets to the adapter. Substring match against
   `raw.PrimaryLocation` (e.g. `["Roseville", "Sacramento", "Folsom",
   "Lodi", "Rocklin", "Auburn", "Citrus Heights"]`). Postings whose
   `PrimaryLocation` matches none are dropped before they enter the
   shared jobs pool.
2. **Engine geo-decision pass** in `prepare --phase pre` (existing
   logic) applies `profile.geo` rules (city allowlist, country
   policy, remote-only, blocklist) and surfaces `geo_decision` on
   each prepare-batch entry.

Stage 1 keeps the jobs pool clean. Stage 2 catches anything Stage 1
let through (e.g. multi-location postings where `PrimaryLocation`
matches but `profile.geo.countryPolicy` rejects).

## 8. Pagination & rate limits

- `PAGE_LIMIT = 25`. Oracle CE hard-caps the listing endpoint at 25
  rows regardless of the `limit` param sent (verified against
  Adventist 2026-05-11: `limit=30/50/100/200` all returned 25, and
  the wrapper `Limit` field echoes back 25). Earlier draft used 200;
  combined with the short-page break this silently truncated every
  tenant at 25. Final value 25 matches Oracle's behavior.
- `MAX_JOBS_PER_TENANT = 2000`. Adventist's 1393 fits in 56 pages
  at 25/page. Hard cap protects against runaway pulls if a tenant
  grows. Daily delta is small; full pagination is one-time cost per
  scan, ~10s with `concurrency = 2`.
- `concurrency = 2` per `runTargets` cap. Oracle Cloud hosts are
  shared across tenants — be polite.
- Retry/backoff inherited from `defaultFetch` (`engine/modules/discovery/_http.js`).
  No adapter-level retry logic.

## 9. Error handling

- `fetchJson` throws on non-2xx; `runTargets` catches per-tenant and
  logs `[oracle_cloud] {slug}: HTTP 503 …`, scan continues.
- Missing `siteUrl` in meta → adapter returns `[]` for that target
  (no exception); engine logs a warning.
- Empty `items` or `requisitionList` → adapter returns `[]`, no
  warning (legitimate "no jobs" case).
- Malformed JSON → `fetchJson` rejects, caught upstream.

## 10. Tests

`engine/modules/discovery/__tests__/oracle_cloud.test.js`:

1. **Happy path.** Faked `fetchFn` returns canned 2-page response
   (page 1: 200 reqs, page 2: 50 reqs, `TotalJobsCount: 250`).
   Asserts: 250 jobs returned, `jobId === Id`, `url` matches
   `{siteUrl}/job/{Id}`, `locations` populated.
2. **Pagination break on short page.** Fake returns 1 page of 50
   reqs (< `PAGE_LIMIT`). Adapter stops at page 1, returns 50 jobs.
3. **Pagination break on TotalJobsCount.** Fake returns 2 pages of
   200 each, `TotalJobsCount: 350`. Adapter stops at offset=400 with
   400 jobs (correct: TotalJobsCount only halts when offset+page ≥
   total; our cap is at offset 400 since 350 < 400).
4. **`locationAllow` filter.** Mixed-location response;
   `locationAllow: ["Roseville"]` drops non-Roseville jobs.
5. **Missing `siteUrl`.** Target with no `siteUrl` → returns `[]`,
   no fetchFn invocation.
6. **Empty `requisitionList`.** Wrapper present but empty → returns
   `[]`, no error.
7. **Non-2xx response.** `fetchFn` throws `HTTP 503` → adapter
   error contained, returns `[]`.
8. **Missing `Id`.** Requisition without `Id` field → dropped, doesn't
   crash adapter.

All tests use Node's built-in `test` runner (no jest). Faked
`fetchFn` returns `{ ok, status, json: async () => … }` to satisfy
`fetchJson`'s contract.

## 11. Definition of Done

- RFC approved.
- `engine/modules/discovery/oracle_cloud.js` implemented per §5.
- Tests in `engine/modules/discovery/__tests__/oracle_cloud.test.js`
  per §10, all green.
- `data/companies.tsv` includes one row for Adventist Health per §6.
- `profile.modules` for Lilia includes `discovery:oracle_cloud`.
- `node engine/cli.js scan --profile lilia` runs without errors,
  fetches Adventist jobs, surfaces fresh Sacramento-metro reqs in
  `profiles/lilia/applications.tsv` as Inbox rows.
- Multi-agent code review (M-tier per DEVELOPMENT.md): code-reviewer
  subagent over the diff before commit.
- Inbox delta recorded in BL-38 Progress.

## 12. Open questions

- **Oracle Cloud rate limits.** No documented public limits; if
  scanning hits 429/503 in production, lower `concurrency` to 1 or
  introduce per-host delay. Out of scope for this RFC; address if it
  fires.
- **`secondaryLocations` array.** Currently ignored. Some Adventist
  postings list a primary city in `PrimaryLocation` but additional
  cities in `secondaryLocations`. If we miss multi-location postings
  that should match Sacramento metro, expand the location matcher to
  include `secondaryLocations[].LocationName`. Defer until smoke
  reveals a gap.
- **`finder` shape variance.** Some Oracle Fusion tenants expose
  alternative finders (e.g. `findReqsByLoc`, `findReqsByFacets`).
  Out of scope — `findReqs;siteNumber=…` is the documented public
  pattern and works for Adventist.

## 13. Success metric

- Smoke scan against `--profile lilia` after merge: expect 20-60
  fresh Sacramento-metro Adventist postings landing in Inbox on day 1
  (initial seed against 1393 total reqs filtered by ~5-7 cities).
- Subsequent daily scans: 1-10 new postings (steady state).
- Zero adapter-level errors in the scan summary for `oracle_cloud`
  source.

## 14. Approval

Awaiting user approval before implementation.
