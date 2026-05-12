---
id: RFC-027
title: NLX Jobsyn (Direct Employers Foundation) adapter
status: draft
author: Claude (via Jared/Lilia)
created: 2026-05-12
refs:
  - BL-41
  - BL-43
  - RFC-025
---

# RFC 027 — NLX Jobsyn (Direct Employers Foundation) adapter

## 1. Goal

Add a `discovery:jobsyn` adapter so Lilia's pipeline can pull public job
listings from the **NLX Jobsyn API** (Direct Employers Foundation public
backend). Primary validation tenant: **Dialysis Clinic, Inc. (DCI)** —
`dciinc.jobs`, Tier B for Lilia, ~270 clinics, Sacramento metro RN-roles
confirmed (8 RN postings on smoke probe, first one Dialysis Float RN at
$46–65/hr). Adapter is multi-tenant by design: the same shared NLX backend
serves many federal-contractor employers, switched via an `X-Origin` HTTP
header — future NLX tenants land as TSV rows, no code change.

## 2. Non-Goals

- **Auth flow.** Public anonymous listing only. No candidate-account login.
- **Apply-form automation.** Adapter surfaces the public job URL; apply
  flow stays with the operator.
- **Underlying ATS.** DCI's `reqid` (`2026-23420`) hints at an iCIMS
  backend, but we fetch the **listing** through NLX. Bypassing NLX to hit
  the underlying ATS is out of scope.
- **Per-tenant onboarding for non-DCI tenants in this RFC.** Adapter
  generalises to any NLX-syndicated employer; this RFC only commits to
  DCI as the validation tenant.

## 3. Recon summary (BL-41, 2026-05-12)

Full results in `private/backlog/BL-41.md`. Headline findings:

| Field | Value |
|---|---|
| Endpoint | `https://prod-search-api.jobsyn.org/api/v1/solr/search` |
| Method | GET |
| Auth | none (anonymous public) |
| Tenant select | header `X-Origin: {origin}` (e.g. `dciinc.jobs`) |
| Params | `page`, `num_items` (and optional `location`, ignored — see §7) |
| Response type | `application/json` |
| DCI total reqs | 8 (Sacramento-only probe); total tenant size unmeasured but bounded by `pagination.total` |
| Apply URL | `https://{origin}/job/{guid}` (uppercase hex GUID) |

The NLX response wraps jobs under top-level `jobs[]`. Each job exposes
(among others):

- `guid` — opaque uppercase hex (32 chars). Stable, used as `jobId`.
- `title_exact` — display title.
- `description` — Markdown-flavored JD body.
- `city_exact`, `state_short`, `location_exact` (e.g. `"Sacramento, CA"`).
- `GeoLocation` — `"lat, lon"` string.
- `date_new`, `date_updated`, `date_added`, `salted_date` — overlapping
  ISO timestamps; we use `date_new` (canonical posting date upstream)
  and fall back to `date_added` (when NLX indexed it).
- `reqid` — opaque ATS req id (probably iCIMS-side).
- `title_slug` — kebab-case slug for SEO routes (unused here).
- `company_exact`, `buid` — tenant identity (informational; we trust
  the operator-set `target.name`).

`pagination` wrapper exposes `{ total, page, page_size, has_more_pages,
offset, total_pages }`. This is the **only** signal needed to drive
pagination — we don't depend on `len(jobs) < page_size` (the heuristic
that bit oracle_cloud at the 25-row cap).

## 4. Tenant identification model

NLX runs a shared backend. The tenant is selected per-request by the
`X-Origin` header (`Wn` factory in the Nuxt bundle: `w.create({baseURL:
"https://prod-search-api.jobsyn.org/api/", headers: { ..., "X-Origin": t }})`).

For us, `target.origin` is a hostname-shaped string (e.g. `dciinc.jobs`)
sent verbatim as the `X-Origin` value. The base API URL is hardcoded.

### Header injection guard

`X-Origin` is operator-controlled (set via `extra_json` in `companies.tsv`)
but the TSV format itself is third-party-adapter-shaped. To prevent header
injection (`\r\n` smuggling) and ensure the header is well-formed, the
adapter validates `origin` matches `/^[a-z0-9][a-z0-9.-]{0,253}$/i` —
hostname-shape only, no whitespace, no control chars, ≤ 254 chars. A
malformed `origin` skips the target with a warn log.

This is the analog of `oracle_cloud.js`'s `ALLOWED_HOST_SUFFIX` SSRF
guard. Unlike oracle_cloud, there is no URL-based SSRF vector (API host
is hardcoded), so the guard exists purely to make the outbound HTTP
request safe and predictable.

## 5. Adapter design

File: `engine/modules/discovery/jobsyn.js` (~130 lines).
Follows the `oracle_cloud.js` shape: `runTargets` over the tenant list,
paginated fetch per tenant, normalize via `_normalize.js` helpers,
`assertJob` on output.

```js
const SOURCE = "jobsyn";
const API_BASE = "https://prod-search-api.jobsyn.org/api/v1/solr/search";
const PAGE_SIZE = 100;            // NLX honors num_items; 100 keeps page count low.
const MAX_JOBS_PER_TENANT = 5000; // hard cap; DCI sits well under this.
const ORIGIN_PATTERN = /^[a-z0-9][a-z0-9.-]{0,253}$/i;

function buildPageUrl(page, numItems) {
  return `${API_BASE}?page=${page}&num_items=${numItems}`;
}

function isValidOrigin(origin) {
  if (typeof origin !== "string" || !origin) return false;
  return ORIGIN_PATTERN.test(origin);
}

async function fetchAllPages(fetchFn, origin, signal) {
  const all = [];
  for (let page = 1; ; page += 1) {
    if (all.length >= MAX_JOBS_PER_TENANT) break;
    const url = buildPageUrl(page, PAGE_SIZE);
    const body = await fetchJson(fetchFn, url, {
      method: "GET",
      headers: { Accept: "application/json", "X-Origin": origin },
      signal,
    });
    const { jobs, pagination } = extract(body);
    all.push(...jobs);
    if (!pagination || !pagination.has_more_pages) break;
    if (jobs.length === 0) break; // belt-and-suspenders for malformed has_more_pages
  }
  return all;
}

function mapJob(target, raw) {
  const id = raw && typeof raw.guid === "string" ? raw.guid.trim() : "";
  if (!id) return null;
  const primaryLocation = raw.location_exact
    || joinCityState(raw.city_exact, raw.state_short);
  if (!locationMatchesAllow(primaryLocation, target.locationAllow)) return null;
  return assertJob({
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId: id,
    title: sanitizeText(raw.title_exact),
    url: `https://${target.origin}/job/${id}`,
    locations: dedupeLocations([primaryLocation]),
    team: sanitizeText(raw.category_exact) || null,
    postedAt: parseIsoDate(raw.date_new) || parseIsoDate(raw.date_added),
    rawExtra: { reqid: raw.reqid || null, buid: raw.buid || null },
  });
}
```

### Per-target meta fields

Each `target` (built from `data/companies.tsv` `extra_json`) carries:

- `origin` *(required)* — hostname-shape string, sent as `X-Origin` and
  used to build the apply URL (`https://{origin}/job/{guid}`).
- `locationAllow` *(optional, array)* — substring patterns matched
  case-insensitively against the posting's `location_exact` (or
  `"{city}, {state}"` if `location_exact` is missing). Postings matching
  none are dropped client-side.

## 6. TSV row format

```
Dialysis Clinic Inc	jobsyn	dciinc	{"origin":"dciinc.jobs","locationAllow":["Sacramento","Roseville","Rocklin","Folsom","Elk Grove","Citrus Heights","Rancho Cordova","Davis","Carmichael","Fair Oaks","Antelope","North Highlands","Orangevale","Loomis","Granite Bay","Auburn","Lincoln"]}	lilia
```

Columns: `name`, `source`, `slug`, `extra_json`, `profile`. `slug` is
opaque — used as the local identifier only; not sent to NLX. NLX never
sees `slug`.

## 7. Geo filtering strategy

NLX supports a server-side `location=` query param, but we **don't use
it** for two reasons:

1. **String matching is fragile.** `location=Sacramento,+CA` matches by
   geocoded radius (unknown radius, undocumented). Adventist-like
   surprises ("Tillamook, OR matched by `keyword=Sacramento`") are
   possible.
2. **Operator-controllable post-filter is more predictable.** A flat
   substring-match over `location_exact` from the response (e.g.
   `"Sacramento, CA"`, `"Roseville, CA"`) is debuggable and consistent
   with `oracle_cloud.js`/`workday.js`/`icims.js`.

So the adapter fetches tenant-wide (no `location` query param) and
post-filters with `target.locationAllow`. The engine's `geo_decision`
pass later in `prepare --phase pre` applies `profile.geo` rules
(remote/country/blocklist) on top.

## 8. Pagination & rate limits

- `PAGE_SIZE = 100`. NLX honors `num_items` (the SPA defaults to 10;
  manual probes with `num_items=100` succeed). 100 keeps full-tenant
  pulls in a handful of pages.
- Stop condition: `pagination.has_more_pages === false`, or the page
  returns `jobs.length === 0` (defensive — should not happen if NLX
  reports `has_more_pages` correctly).
- `MAX_JOBS_PER_TENANT = 5000`. Safety cap; DCI sits well under this.
- `concurrency = 2` per `runTargets` cap. The Jobsyn backend is shared
  across many employers — be polite.
- Retry/backoff inherited from `defaultFetch`
  (`engine/modules/discovery/_http.js`). No adapter-level retry logic.

## 9. Error handling

- `fetchJson` throws on non-2xx; `runTargets` catches per-tenant and
  logs `[jobsyn] {slug}: HTTP 503 …`, scan continues.
- Missing/invalid `origin` → adapter returns `[]` for that target,
  logs `[jobsyn] {slug}: invalid origin "..."`. No fetchFn invocation.
- Empty `jobs` array → adapter returns `[]`, no warning (legitimate
  "no jobs" case).
- Malformed JSON / missing `pagination` → adapter walks the first page
  and stops (defensive break on missing `has_more_pages`).
- Mid-pagination 5xx → whole target dropped (no partial-pool leak),
  same pattern as `oracle_cloud.js`.

## 10. Tests

`engine/modules/discovery/jobsyn.test.js` — ~16 cases, mirrors
`oracle_cloud.test.js`:

1. **Happy path** — 2 pages (100 + 50), `has_more_pages` true→false,
   asserts 150 jobs, mapping, X-Origin header recorded per call.
2. **Single-page short response** — page 1 with 30 jobs, `has_more_pages
   = false` → stops at page 1.
3. **`locationAllow` filter** — mixed `location_exact`, allowlist drops
   non-matching; case-insensitive; trims whitespace.
4. **Missing `origin`** — target without `origin` → returns `[]`, no
   fetchFn invocation.
5. **Invalid `origin`** — `"bad\r\nX-Injection: 1"`, spaces, empty,
   way-too-long → all rejected, no fetchFn invocation, warn logged.
6. **Mid-pagination 5xx** — page 1 ok, page 2 throws 500 → whole target
   dropped, no partial leak, warn logged.
7. **Empty jobs array** — returns `[]`, no error.
8. **Malformed body (no `pagination`)** — adapter walks 1 page and stops.
9. **Missing `guid`** — postings without GUID dropped + warn count.
10. **Per-tenant failure isolation** — one origin returns 500, another
    returns ok; jobs only from the good origin.
11. **Falls back from `location_exact` to `city_exact + state_short`**
    when `location_exact` absent.
12. **`postedAt` priority** — `date_new` wins over `date_added` when both
    present; falls back to `date_added` when only it's present.
13. **Apply URL composition** — `url === https://{origin}/job/{guid}`.
14. **X-Origin header injected** — every request carries the configured
    `origin` as `X-Origin`.
15. **`MAX_JOBS_PER_TENANT` cap** — if NLX reports `has_more_pages=true`
    forever, adapter stops at the cap and doesn't loop infinitely.
16. **Concurrency cap** — adapter caps `ctx.concurrency` to 2 even if
    the caller passes 8.

All tests use Node's built-in `test` runner. Faked `fetchFn` returns
`{ ok, status, json: async () => … }` to satisfy `fetchJson`'s contract.

## 11. Definition of Done

- RFC approved.
- `engine/modules/discovery/jobsyn.js` implemented per §5.
- Tests in `engine/modules/discovery/jobsyn.test.js` per §10, all green.
  Full suite remains green.
- `data/companies.tsv` includes one row for DCI per §6.
- `profile.modules` for Lilia includes `discovery:jobsyn`, DCI in
  `companies_whitelist`, DCI tier set to B in `company_tiers`.
- `node engine/cli.js scan --profile lilia` runs without errors,
  fetches DCI jobs, surfaces fresh Sacramento-metro reqs in
  `profiles/lilia/applications.tsv` as Inbox rows.
- Multi-agent code review (M-tier per DEVELOPMENT.md): code-reviewer
  subagent over the diff before commit.
- Inbox delta recorded in BL-43 Progress.

## 12. Open questions

- **NLX rate limits.** Public API, no `X-RateLimit-*` headers observed.
  If scans hit 429/503 in production, lower `concurrency` to 1. Out of
  scope for this RFC; address if it fires.
- **Response shape variance.** `meta.source: "solr"` suggests other
  backends might exist. Mitigation: defensive extraction (already in
  §5). If a non-Solr response surfaces with a different shape, address
  in a follow-up.
- **`X-Origin` requirement strictness.** Probing without `X-Origin`
  produces a global feed or 4xx — not tested. Adapter always sends it;
  the question is academic unless we'd want a "list-all-tenants"
  endpoint, which we don't.

## 13. Success metric

- Smoke scan against `--profile lilia` after merge: expect 5-15 fresh
  Sacramento-metro DCI postings landing in Inbox on day 1 (8 visible in
  Sacramento on 2026-05-12; some overlap with Indeed pool via fuzzy
  dedup is expected).
- Subsequent daily scans: 0-3 new postings (steady state — dialysis
  hiring is bursty around clinic openings/floats).
- Zero adapter-level errors in the scan summary for `jobsyn` source.

## 14. Approval

Awaiting user approval before implementation.
