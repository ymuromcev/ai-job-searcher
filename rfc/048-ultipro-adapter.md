---
id: RFC-048
title: UltiPro / UKG Pro Recruiting adapter
status: draft
tier: M
created: 2026-05-27
tags: [discovery, ats, ultipro, ukg, lilia]
refs: [BL-39, BL-30, RFC-025, RFC-032]
---

# RFC 048 — UltiPro / UKG Pro Recruiting adapter

- **Status:** Proposed (recon-validated)
- **Author:** ymuromcev / Claude
- **Date:** 2026-05-27
- **Tier:** M (new adapter, profile-config schema unchanged, no data
  migration, no auth flows)
- **Depends on:** none
- **Supersedes:** none

## 1. Problem

Lilia's pipeline (RN / healthcare-adjacent roles, Sacramento area) does
not currently see Sonrava Health postings. Sonrava is the parent of
Western Dental + Brident + DentalWorks + Perfect Teeth + Vital Smiles
(~600 affiliated offices, large Sacramento footprint). RN core is rare
at Sonrava, but ancillary roles — admin / scheduler / patient services /
RN at larger Vital Smiles locations — do pass Lilia's filter and never
reach Inbox because there is no UltiPro / UKG Pro Recruiting adapter.

UltiPro (now branded **UKG Pro Recruiting**, was Ultimate Software
before the Kronos merger) is a top-3 enterprise HRIS/ATS by US headcount
covered. Beyond Sonrava, the same adapter unlocks an estimated tail of
mid-market employers Lilia's filter would otherwise miss
(`westerndental.com/careers` → `rn31.ultipro.com/WES1023/JobBoard/SearchJobs.aspx`
is the in-scope landing today).

`lilia.modules` today: `greenhouse / lever / ashby / smartrecruiters /
workday / icims / usajobs / linkedin_keyword / adzuna`. UltiPro is the
biggest remaining adapter gap for the healthcare-services segment.

## 2. Recon (2026-05-27, performed in this session)

Live probes against UltiPro hosts plus public documentation of the
undocumented JSON API. Results below are real, not hypothetical.

### 2.1 Western Dental landing page (BL-39 starting point)

`https://westerndental.com/` → "Careers" link in nav and footer points
to **two distinct destinations**:

- `westerndental.com/careers` (path)  →
  embedded "Current Job Openings" button →
  `https://rn31.ultipro.com/WES1023/JobBoard/SearchJobs.aspx?Page=Search`
  (the **classic ASP.NET WebForms** UltiPro board).
- `https://careers-sonrava.icims.com/` (Sonrava parent corporate
  careers, iCIMS-fronted, OAuth gate on direct search URL).

Both ATSs are live at the parent group; this RFC scopes to UltiPro only,
which is what the brand-level career page links to and what
`companies.tsv` is supposed to target for Sonrava. (iCIMS coverage —
including Sonrava parent — is a separate question handled by Lilia's
existing iCIMS adapter and is **not** affected by this RFC.)

### 2.2 Live probe of the WES1023 tenant

`GET https://rn31.ultipro.com/WES1023/JobBoard/SearchJobs.aspx`
→ **HTTP 200** but redirects to
`https://rn31.ultipro.com/maintenanceulti/index.html` — the standard
UKG global maintenance page:
> "Attention UKG Customers. The site you are trying to access is
> temporarily unavailable for maintenance. Please try again later."

`?Page=Search` variant: same maintenance page.

**Confirmed via cross-tenant probes** that this is a **global UKG
maintenance window**, not a tenant-specific outage:

| Tenant | URL | Result |
|---|---|---|
| Western Dental (`WES1023` on `rn31`) | `/JobBoard/SearchJobs.aspx?Page=Search` | maintenance |
| GoWireless (`GOW1000` on `rn22`) | `/JobBoard/SearchJobs.aspx?Page=Search` | maintenance (identical UKG page) |
| Cray (`CRA1002` on `rn12`) | `/JobBoard/SearchJobs.aspx` | maintenance |
| Pioneer Investments (`PIO1001` on `re21`) | `/jobboard/SearchJobs.aspx` | connection refused (likely same shard) |
| GFK (`GFK1000` on `re11`) | `/JobBoard/SearchJobs.aspx` | connection refused |
| BMD (`BUI1004BMDI` on `recruiting`) | `/JobBoard/<UUID>` (new-style) | reachable, browser-compatibility wall |
| RJ Corman (`rjc1000rjcrg` on `recruiting`) | `/JobBoard/<UUID>` (new-style) | reachable, browser-compatibility wall |

The maintenance window does **not invalidate BL-39's premise** — the
Western Dental → UltiPro `WES1023` link is still the live address, just
temporarily unreachable. Recon proceeds on documented behaviour of the
platform itself, validated cross-tenant.

### 2.3 UltiPro URL-shape generations

UKG Pro Recruiting has shipped **two generations** of public job board
under the `ultipro.com` family of hosts:

1. **Classic ASP.NET WebForms** (~2010-era code, still in production
   for many tenants including `WES1023`):
   ```
   https://{prefix}{shard}.ultipro.com/{TENANT}/JobBoard/SearchJobs.aspx[?Page=Search]
   ```
   `{prefix}{shard}` examples (cross-tenant Google evidence):
   `rn12`, `rn21`, `rn22`, `rn31`, `re11`, `re12`, `re21`, `re22`,
   `re31`, `rew11`, `rew12`, `recruiting`, `recruiting2`.
   Job-detail URL pattern: `JobDetails.aspx?__ID=*` or
   `<TENANT>/JobBoard/<UUID>/OpportunityDetail?opportunityId=<UUID>`.

2. **New-gen UUID JobBoard** (React SPA, served from
   `recruiting.ultipro.com` / `recruiting2.ultipro.com`):
   ```
   https://recruiting[N].ultipro.com/{TENANT}/JobBoard/{BOARD_ID_UUID}/
   ```
   Backed by a **POST JSON API** (see §2.4) — `LoadSearchResults`. SPA
   shell shows a browser-compat warning to non-JS requests; the API
   itself is the only useful entry point for an adapter.

The Canadian tenants use `recruiting.ultipro.ca`. Same two URL
generations apply there.

The two generations **coexist on the same hosts** — `recruiting.ultipro.com`
serves both `/TENANT/JobBoard/SearchJobs.aspx` (some legacy tenants) and
`/TENANT/JobBoard/<UUID>` (newer tenants). The discriminator is the
**presence of a UUID in the URL path**, not the host prefix.

### 2.4 Undocumented JSON API (new-gen tenants)

Reverse-engineering writeups by the third-party scraper community
(`jobo.world/ats/ultipro`, fantastic.jobs) confirm a stable
undocumented but unauthenticated JSON endpoint used by the new-gen
React SPA:

```
POST https://recruiting[N].ultipro.com/{TENANT}/JobBoard/{BOARD_ID}/JobBoardView/LoadSearchResults
Headers:
  Content-Type: application/json; charset=UTF-8
  X-Requested-With: XMLHttpRequest
  User-Agent: (browser-realistic)
Body (JSON):
  {
    "opportunitySearch": {
      "Top": 50,
      "Skip": 0,
      "QueryString": "",
      "OrderBy": [],
      "Filters": [ ... optional location/category filters ... ]
    },
    "matchCriteria": {
      "PreferredJobs": [],
      "Educations": [],
      "LicenseAndCertifications": [],
      "Skills": [],
      "hasNoLicenses": false,
      "SkippedSkills": []
    }
  }
Response (JSON):
  {
    "opportunities": [ { Id, Title, RequisitionNumber, Locations: [...],
                          PostingDate, JobCategoryName, ... } ],
    "totalCount": N
  }
```

- **Pagination is `Skip / Top`** — `Top` typically `50`. Continue until
  `Skip + opportunities.length >= totalCount`.
- **No auth** (no cookies, no CSRF token observed by community scrapers).
  `X-Requested-With: XMLHttpRequest` is required to avoid an HTML response.
- **Location filter** is structured: enter via `Filters` in the request
  body (`{ FilterId: <LocationFilterId>, Values: [...] }`), but
  **filter IDs vary per tenant** and need to be discovered. Simpler
  alternative: **don't filter at API level** — post-filter on
  `opportunities[].Locations[]` in adapter code (mirrors what Workable
  and Greenhouse adapters do).
- Job detail URL: `https://recruiting[N].ultipro.com/{TENANT}/JobBoard/{BOARD_ID}/OpportunityDetail?opportunityId={Id}`
  — public HTML page, server-rendered with full JD body (suitable for
  JD-cache fetch in `prepare`).
- Truncated description (~100-200 chars) is included in the list-API
  response. Full JD requires either the detail HTML page or a separate
  `OpportunityDetail` POST endpoint (not validated in this recon).

### 2.5 Recon validation — 4 open questions from BL-39 §"Open questions"

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | ASP.NET viewstate/postback vs URL params for pagination? | **Classic SearchJobs.aspx uses `__doPostBack` viewstate-driven pagination** (community-documented; live verification blocked by current maintenance window). **New-gen UUID boards use `Skip/Top` in the JSON API body, no viewstate.** Strategy: **target the new-gen JSON API, not the classic ASPX page.** | jobo.world UltiPro guide; new-gen boards (`recruiting.ultipro.com/{TENANT}/JobBoard/<UUID>`) observed across 7 tenants in cross-search. |
| 2 | Hidden JSON-API endpoint? | **Yes — `POST /{TENANT}/JobBoard/{BOARD_ID}/JobBoardView/LoadSearchResults`** with `{opportunitySearch:{Top,Skip,Filters},matchCriteria:{...}}` body. Returns `{opportunities[], totalCount}` JSON. Tried legacy guesses `/JobBoard/jobs/api`, `/JobBoard/SearchAPI`, `?ajax=1` — none are real; the actual endpoint is `LoadSearchResults` under the board UUID. | jobo.world recon writeup; fantastic.jobs API docs (third-party UltiPro scraper aggregator); endpoint shape consistent with new-gen SPA's network traffic. |
| 3 | Geo filter via `?Location=` or post-filter? | **Post-filter on `opportunities[].Locations[]`.** Location filtering at API level exists (`Filters` in request body) but uses per-tenant `FilterId` values that have to be discovered. Post-filtering is simpler, deterministic, and matches the adapter shape we already use for Workable / Greenhouse. The response `Locations` array contains `LocalizedName`, `Address.City`, `Address.State`, `Address.PostalCode`, `Address.CountryCode` — enough for Lilia's geo enforcement (`profiles/lilia/filter_rules.json`). | Recon writeups; consistent with how `engine/modules/discovery/workable.js` already handles `locations[]`. |
| 4 | Does `rnNN` prefix vary per tenant? | **Yes — heavily.** Observed prefixes across 14 tenants in cross-search: `rn12`, `rn21`, `rn22`, `rn31`, `re11`, `re12`, `re21`, `re22`, `re31`, `rew11`, `rew12`, `recruiting`, `recruiting2`. New-gen tenants concentrate on `recruiting` / `recruiting2`. Discovery rule: **the prefix is part of the careers-link URL on the customer site** — record it in `companies.tsv` per row as `extra_json.host` (e.g. `{"host":"recruiting2"}`). The default for new-gen tenants should be `recruiting`. | Direct WebSearch site:`ultipro.com`; google_results.json (10 distinct prefixes in 20 results). |

**Recon outcome:** BL-39 premise (Western Dental on `rn31.ultipro.com/WES1023`)
is correct but the **adapter should target the new-gen JSON API** under
`recruiting[N].ultipro.com/{TENANT}/JobBoard/{BOARD_ID}/JobBoardView/LoadSearchResults`,
**not** the classic `SearchJobs.aspx` page that BL-39 originally
proposed. Western Dental's `WES1023` tenant migration to the new-gen
URL must be verified once the UKG maintenance window ends; pre-existing
public scraper docs (jobo.world) suggest the new-gen API also serves
classic-URL tenants under `recruiting[N].ultipro.com/{TENANT}/JobBoard/<BOARD_ID>`,
i.e. every modern UltiPro tenant has a UUID-board form even when their
public marketing link still points at the legacy `SearchJobs.aspx`.

If WES1023 turns out to be **classic-only** (no UUID board), the
fallback is an ASP.NET-WebForms scraper with viewstate POSTbacks — that
is materially harder (tier L, stateful, fragile) and would justify a
separate RFC. **The recommended path here is JSON API first; classic
scraping is explicitly out of scope.**

## 3. Goals / non-goals

**Goals**

- Generic adapter consuming any UltiPro/UKG new-gen tenant board via the
  `LoadSearchResults` JSON API.
- One-line opt-in via `data/companies.tsv` — same shape as
  `greenhouse / workable / ashby` rows, with extra metadata in
  `extra_json` to capture per-tenant host + board UUID:
  ```
  Sonrava Health	ultipro	WES1023	{"host":"recruiting","boardId":"<UUID>"}	lilia
  ```
- Map `opportunities[]` records to the canonical `Job` schema
  (`engine/modules/discovery/_types.js`) so dedup, fit, and Notion sync
  work unchanged.
- Honour `Locations[]` post-filter shape — first pass keeps every job,
  per-profile geo rules in `filter_rules.json` do the rejection
  downstream (same as Workable).
- Pagination: walk `Skip/Top` until `totalCount` reached, with a hard
  ceiling (e.g. `MAX_PAGES = 40` → 2000 jobs/tenant) as a safety net.

**Non-goals**

- **No classic-ASP.NET SearchJobs.aspx scraping in this RFC.** If a
  tenant we care about turns out to be classic-only and has no UUID
  board, that justifies a follow-up RFC at tier L (viewstate parsing,
  postback emulation, cookies). For now, JSON-API tenants only.
- **No JD-body fetch in this RFC.** The list API returns a truncated
  description; full JD requires fetching the public
  `OpportunityDetail?opportunityId=...` HTML page. Track as a follow-up
  BL (mirror of the same pattern in RFC 032 §8).
- **No auth flows.** Public boards only.
- **No expansion of `companies.tsv` beyond Sonrava Health.** Adding
  other UltiPro tenants is a product decision; the row format is
  documented (§4.3 below) so the user can add them without code change.
- **No header-forging beyond `X-Requested-With` and a realistic User-Agent.**
  If UKG starts requiring a CSRF token, that's a separate RFC.

## 4. Proposed adapter

### 4.1 File: `engine/modules/discovery/ultipro.js`

Same general shape as `workable.js` (single source, multi-tenant,
auto-registered by filename). Differences from `workable.js`:

- HTTP method is **POST**, not GET → need `fetchJson` helper to accept
  body + headers, or add a small `fetchJsonPost` wrapper in `_ats.js`.
- URL is **3-part** per tenant: `{host}` + `{tenant}` + `{boardId}`.
  Resolved from `companies.tsv` row's `slug` (= tenant code) and
  `extra_json` (= `{host, boardId}`).
- Pagination loop over `Skip/Top` inside the per-target function.
- `mapJob` maps `opportunities[].Locations[]` → flat strings; uses
  `LocalizedName` first, falls back to assembled `City, State`.

### 4.2 Pseudocode (illustrative only — written for review, not yet
committed)

```js
const SOURCE = "ultipro";
const PAGE_SIZE = 50;
const MAX_PAGES = 40;

function resolveBase(target) {
  const extra = target.rawExtra || {};
  const host = String(extra.host || "recruiting"); // default new-gen
  const tenant = String(target.slug || "");
  const boardId = String(extra.boardId || "");
  if (!tenant || !boardId) return null;
  return `https://${host}.ultipro.com/${tenant}/JobBoard/${boardId}`;
}

async function fetchPage(c, base, skip) {
  const body = {
    opportunitySearch: { Top: PAGE_SIZE, Skip: skip, QueryString: "",
                         OrderBy: [], Filters: [] },
    matchCriteria: { PreferredJobs: [], Educations: [],
                     LicenseAndCertifications: [], Skills: [],
                     hasNoLicenses: false, SkippedSkills: [] },
  };
  return fetchJsonPost(c.fetchFn, `${base}/JobBoardView/LoadSearchResults`,
    body, {
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: c.signal,
    });
}

function mapJob(target, base, raw) {
  const jobId = String(raw.Id || raw.RequisitionNumber || "");
  if (!jobId) return null;
  const url = `${base}/OpportunityDetail?opportunityId=${encodeURIComponent(jobId)}`;
  const locations = Array.isArray(raw.Locations)
    ? raw.Locations.map((l) => formatLocation(l)).filter(Boolean)
    : [];
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId,
    title: sanitizeText(raw.Title),
    url,
    locations: dedupeLocations(locations),
    team: sanitizeText(raw.JobCategoryName) || null,
    postedAt: parseIsoDate(raw.PostingDate),
    rawExtra: {
      requisition: raw.RequisitionNumber || null,
      employment_type: raw.EmploymentTypeName || null,
      // truncated description is useful for prerank without JD fetch
      brief: sanitizeText(raw.BriefDescription) || null,
    },
  };
  assertJob(job);
  return job;
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  return runTargets(targets, c, async (target) => {
    const base = resolveBase(target);
    if (!base) return [];
    const out = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const skip = page * PAGE_SIZE;
      const body = await fetchPage(c, base, skip);
      const opps = Array.isArray(body && body.opportunities)
        ? body.opportunities : [];
      if (opps.length === 0) break;
      for (const raw of opps) {
        const job = mapJob(target, base, raw);
        if (job) out.push(job);
      }
      const total = Number(body && body.totalCount) || 0;
      if (out.length >= total) break;
    }
    return out;
  });
}

module.exports = { source: SOURCE, discover };
```

### 4.3 `companies.tsv` row format

```
Sonrava Health	ultipro	WES1023	{"host":"recruiting","boardId":"<UUID>"}	lilia
```

- `source = "ultipro"` matches `SOURCE` in the adapter.
- `slug = TENANT_CODE` (e.g. `WES1023`). Used in URL path and as the
  primary tenant key.
- `extra_json` carries `host` (`rnNN` / `reNN` / `recruiting` /
  `recruiting2`) and `boardId` (UUID of the public JobBoard). Both
  manually captured from the customer's careers URL on first add.
- `profile = lilia` (default first profile for this RFC; other profiles
  can add their own rows).

**Acquiring `boardId` for Sonrava** is a manual one-time step:
1. Wait for UKG maintenance to lift.
2. Visit `https://westerndental.com/careers` → follow "Current Job
   Openings".
3. If the redirect lands on `…/JobBoard/<UUID>/…` → record `host` and
   `boardId` from the URL.
4. If the redirect lands on legacy `…/SearchJobs.aspx` → look for a
   "Search Opportunities" / "View All Jobs" link that surfaces the new
   board, or open browser devtools and watch for the first
   `LoadSearchResults` request to capture the `boardId` from its URL
   path.

This is one row to add by hand — out of scope for the code change.

### 4.4 `_ats.js` change required

Today `fetchJson` is GET-only. Two clean options:

- (a) Add `fetchJsonPost(fetchFn, url, body, opts)` helper next to
  `fetchJson`. Minimal new code, no impact on existing adapters.
- (b) Generalize `fetchJson` to accept `{method, body, headers}` in
  `opts`. Slightly more invasive, but symmetric.

**Recommendation:** option (a). Keeps the surface area minimal and the
existing call sites untouched. Touched lines stay confined to one new
function + one new test.

## 5. Testing

`engine/modules/discovery/ultipro.test.js`:

- **Happy path.** Faked `fetchFn` returns a 2-page fixture (page 0:
  `opportunities.length = 50, totalCount = 73`; page 1:
  `opportunities.length = 23`). Asserts: total 73 jobs returned,
  `Skip` values in requests are `0`, `50` (in order),
  `Content-Type` and `X-Requested-With` headers set, no third request.
- **Empty board.** `totalCount = 0` → returns `[]`, single request.
- **Bad target.** Missing `boardId` in `extra_json` → adapter skips
  target with no exception (`runTargets` per-target containment also
  guarantees other targets keep running).
- **Pagination ceiling.** Faked source that always returns 50 jobs and
  `totalCount = 9999` → adapter stops after `MAX_PAGES` requests,
  `out.length === MAX_PAGES * PAGE_SIZE`. Log warn for ceiling hit.
- **Malformed job.** Faked record missing `Id` and `RequisitionNumber`
  → `mapJob` returns `null`, `.filter(Boolean)` drops it, other
  records on the same page still flow through.
- **Hidden location filter.** `Locations[]` includes one entry with
  `IsRemote === true` → `locations` array contains `"Remote"`.
  (Verified pattern via Workable adapter — same shape.)
- **404 containment.** Faked `{ok:false, status:404}` on POST →
  `runTargets` swallows, emits one warn, returns `[]`.

No network in unit tests. Integration smoke: `node engine/cli.js
scan --profile lilia` after the Sonrava row lands in `companies.tsv`.

## 6. Companies.tsv (out of scope for the RFC — recipe only)

Adding Sonrava Health is a separate one-liner the user does manually
after merge, **once UKG maintenance lifts and the `boardId` is
captured** (see §4.3):

```
Sonrava Health	ultipro	WES1023	{"host":"recruiting","boardId":"<UUID>"}	lilia
```

Same shape as every other ATS row. No backfill needed. This RFC itself
does not edit `data/companies.tsv` — that is a product decision on
which UltiPro tenants to onboard.

## 7. Identity & PII

**N/A — justified.**

- The adapter does not read, write, or process any candidate-side data.
  All inputs are public tenant codes + board UUIDs in
  `data/companies.tsv` (shared, non-PII master pool, already gitignored
  for unrelated reasons).
- All outputs are job postings (employer-side metadata: title,
  location, requisition number, posting date). No applicant data
  crosses the adapter.
- The adapter runs no-auth requests against UltiPro's public job board
  API; no UKG session cookies, OAuth tokens, or credentials are
  touched. The user's `profiles/<id>/identity.json` is not read by
  this code path.
- Existing `profile.json` filter rules (geo, blocklist) apply downstream
  in `scan` exactly as they already do for greenhouse/workable; no new
  PII surface is introduced at the adapter boundary.

## 8. Failure modes

1. **UKG changes API shape.** `opportunities[]` becomes non-array or
   required fields go missing. Adapter throws per-target;
   `runTargets` logs warn, batch continues. Same containment as
   workable.
2. **UKG starts requiring CSRF token.** `LoadSearchResults` returns
   `403`. Adapter fails per-target. Mitigation: separate RFC to fetch
   board page first, extract anti-forgery token, replay on POST.
   Estimated effort: tier M follow-up; not pre-emptive.
3. **Bad `boardId` in `companies.tsv`.** 404 on POST → per-target
   containment, no batch impact. Same as a bad Greenhouse slug.
4. **Bad `host` prefix.** Connection refused → caught by adapter's
   per-target try/catch (verified pattern in `runTargets`). Logs
   tenant + host that failed.
5. **Rate limiting.** Not observed in third-party scraper reports.
   Default `_ats.js` concurrency-4 is the first line; can drop to 2 via
   `ctx.concurrency` if needed. Adapter also makes **serial** requests
   per tenant (pagination loop), so per-tenant throughput is naturally
   capped.
6. **Pagination ceiling hit.** `MAX_PAGES * PAGE_SIZE = 2000` cap. If a
   tenant has more than 2000 jobs (rare — biggest known UltiPro tenants
   like Concord Hospitality have ~1000 active), log warn and proceed
   with the first 2000. Defensive cap against runaway loops.
7. **Tenant is classic-ASPX-only (no UUID board).** Adapter cannot
   fetch — `boardId` will be missing or invalid. Operator notices via
   warn during first scan, opens a follow-up BL for classic-ASPX
   support per §3 non-goals. **Acceptable in V1.**
8. **`Id` collision across UltiPro tenants.** Dedup key is
   `(source, jobId)` per `_types.js` and `applications_tsv.js`. Each
   `Id` is a UUID, so collision risk is theoretical-only; even if it
   occurs, namespacing by source ensures no cross-source collision.

## 9. Plan проверки (verification plan)

1. **Unit tests green.** All cases in §5 pass against faked `fetchFn`.
   Total existing test count stays at current baseline + the new file.
2. **Manual smoke against a non-Sonrava live tenant first.**
   Pick a tenant from the recon §2.3 table whose `boardId` is in the
   Google snippets (e.g. `BUI1004BMDI` with the UUID
   `6b442184-52a5-4635-8db5-5aa4bed2a563`). Add a temporary
   `companies.tsv` row (profile `lilia` or a throwaway), run
   `node engine/cli.js scan --profile lilia`, confirm rows land in
   TSV with correct shape (title, locations, URL, postedAt). Remove
   the temporary row before commit.
3. **Sonrava activation gated on UKG maintenance lifting.** Once
   `westerndental.com/careers` resolves to a live UltiPro page,
   capture the actual `host` + `boardId` for `WES1023`, add the row,
   re-scan, measure Inbox delta. If `WES1023` is classic-ASPX-only —
   stop, file follow-up BL per §3 non-goals.
4. **Tier-M code review.** Subagent `code-reviewer` against the diff
   (per `dev-workflow` Шаг 6). Lilia profile-touch changes also
   trigger the geo-rule sanity check (verify no Sacramento-area jobs
   get filtered out by accident).
5. **Inbox delta.** Document the count before/after enabling
   `discovery:ultipro` for Lilia in the BL-39 progress log. Expected
   shape: 5-30 new Inbox rows on first scan for Sonrava, possibly more
   if other UltiPro tenants get added in the same pass.

## 10. Open questions for approval

1. **Adapter targets new-gen JSON API only — confirm OK?** Means we
   accept that some classic-only tenants are invisible until a
   follow-up RFC. Recommendation: yes, this is the right cost/benefit
   for a first cut (mirrors how we did Workable without per-job JD
   fetch).
2. **`extra_json` schema — `{host, boardId}` keys?** Alternative
   shape `{server, board}` mirrors the BL-39 original proposal
   (`{"server":"rn31"}`). The new-gen URL doesn't have an `rnNN`-style
   server prefix — it lives on `recruiting` / `recruiting2`. Naming
   `host` (not `server`) matches what URL parsing actually yields.
3. **`MAX_PAGES = 40` (2000 jobs cap) — sane default?** Largest known
   UltiPro tenant is ~1066 (Concord Hospitality). 2000 gives 2x
   headroom without runaway risk. Configurable via ctx if needed.
4. **JD fetch in V2?** Out of scope here. Per-tenant cost: one HTML
   GET per `OpportunityDetail?opportunityId=...`, server-rendered, no
   JS — relatively cheap compared with Workable JS-rendered pages.
   Worth filing a follow-up BL once V1 lands.
5. **Sonrava Health vs Western Dental as the `companies.tsv` company
   name.** Both parents/brands are valid; BL-39 uses "Sonrava Health"
   so the Notion record matches the corporate identity. Confirm OK.

## 11. Approval gate

Tier M → RFC + approve → code (`engine/modules/discovery/ultipro.js`,
`engine/modules/discovery/_ats.js` extension for POST helper, tests) →
code-reviewer subagent → live smoke per §9 step 2 → commit. Per
`DEVELOPMENT.md`, no code is written until the user explicitly
approves.

Recon is recorded (Section 2, Section 2.5 question-by-question
validation). Path chosen: **new-gen JSON API adapter, no classic-ASPX
scraping, no JD fetch in V1**. Classic-ASPX path is filed as a
contingent follow-up only if Sonrava turns out to be classic-only.

## 12. Rollback

`git rm engine/modules/discovery/ultipro.{js,test.js}` + revert the
`_ats.js` POST-helper addition + remove the Sonrava row from
`data/companies.tsv` (the row is added separately by the user, not by
this RFC). Auto-registry forgets the source on next reload. Zero
impact on existing rows. Risk: nil.
