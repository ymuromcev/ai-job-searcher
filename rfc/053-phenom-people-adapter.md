---
id: RFC-053
title: Phenom People career-site adapter
status: draft
tier: L
created: 2026-05-28
tags: [discovery, ats, phenom-people, healthcare, lilia]
refs: [BL-150, BL-145, BL-148, RFC-051, RFC-032, RFC-025]
---

# RFC 053 — Phenom People career-site adapter

- **Status:** Proposed (recon-validated)
- **Author:** ymuromcev / Claude
- **Date:** 2026-05-28
- **Tier:** L (new ATS adapter with non-trivial SSRF surface, paired JD
  fetcher, multi-tenant discovery, profile opt-in, schema migration of
  `companies.tsv` rows currently marked `phenom_people` without an
  adapter)
- **Depends on:** none (POST helper `fetchJsonPost` already landed with
  RFC 051)
- **Supersedes:** none

## 1. Problem

`data/companies.tsv` already carries at least one row with
`ats_source=phenom_people` — Oak Street Health
(`slug=cvs-oakstreet`, profile=`lilia`) — that emits a `no-adapter
warn` on every `lilia` scan. The row exists because Oak Street was
acquired by CVS Health in 2023 and CVS hires on the Phenom People
platform. BL-145's audit flagged this as a gap; BL-150 is the build
task.

Phenom People is a top-tier enterprise career-site vendor (CVS Health,
Optum / UnitedHealth Group, DaVita, Dignity Health, Aspen Dental
parent groups, Honeywell, GE Aerospace, EverCommerce, plus several
regional hospital systems). It is the dominant ATS for the
healthcare-employer tier that BL-148 / BL-145 surfaced as Lilia's
biggest remaining adapter gap, and a meaningful gap for Jared's
healthcare-adjacent tech roles (e.g. EverCommerce, healthtech SaaS).

Adapter unblocks (initial targets, profile-tagged):

| Brand | Parent (Phenom tenant) | Profile | Why blocked today |
|---|---|---|---|
| Oak Street Health | CVS Health (`CVSCHLUS`) | lilia | `phenom_people` source, no adapter |
| DaVita | DaVita (own tenant) | lilia (candidate) | Not in TSV yet; BL-148 audit flagged |
| Aspen Dental Mgmt | TAG / Aspen Dental parent | lilia (candidate) | Not in TSV yet |
| CVS Health (core) | CVS Health (`CVSCHLUS`) | lilia (candidate) | Pharmacy / Front Store roles potentially in scope |
| Optum / UHG | UnitedHealth Group | jared / lilia (candidate) | BL-148 audit; tech roles for jared, RN-adjacent for lilia |
| EverCommerce | EverCommerce (own tenant) | jared (candidate) | Verticalized SaaS for healthcare |

Only Oak Street is committed to the migration in this RFC's scope. The
rest are documented as candidate add-rows post-merge (§9), one row per
brand, no code change required.

## 2. Recon (2026-05-28, performed in this session)

Live probes against Phenom-hosted career sites plus third-party
scraper-community documentation of the undocumented `/widgets`
endpoint. Probe results are real, not hypothetical.

### 2.1 URL shapes — two coexisting fronts

Phenom tenants present **two visible URL conventions** for the public
career site:

1. **Vendor-hosted subdomain** — `careers.phenompeople.com`,
   `evercommerce.phenompeople.com`, `hrm-ir.phenompeople.com`, etc.
   Used by smaller tenants and by Phenom itself as the canonical demo
   subdomain.

2. **Customer-branded domain** — `jobs.cvshealth.com`,
   `careers.honeywell.com`, `careers.geaerospace.com`,
   `careers.optum.com` (per WebSearch hits), `jobs.dignityhealth.org`.
   These are CNAMEd to Phenom infra; same underlying SPA, same `/widgets`
   endpoint, same `cdn.phenompeople.com` asset CDN.

The discriminator is **not** the domain — it is the presence of the
`cdn.phenompeople.com/CareerConnectResources/<CAREER_SITE_ID>/`
asset prefix and an inline `refNum` value. Both conventions resolve
to the same adapter logic.

Public-search-results path is uniformly `/us/en/search-results` (or
`/global/en/search-results`) — the locale prefix is per-tenant but
the trailing `search-results` path is stable across all tenants
probed.

Job-detail path is uniformly
`/{locale}/job/{JOB_ID}/{slug-title}` (e.g.
`/us/en/job/P-103668/Data-Engineer-I`).

### 2.2 Live probe: CVS Health (Oak Street parent)

`GET https://jobs.cvshealth.com/us/en/search-results` → **HTTP 200**,
React SPA shell. Inline markers observed (extracted via WebFetch):

```
cdn.phenompeople.com/CareerConnectResources/CVSCHLUS/...
careerSiteId: "CVSCHLUS"
refNum: "dca682849fce47be8e7a21258509e92e"   (main board)
```

`GET https://jobs.cvshealth.com/us/en/jobs-oak-st-health` → **HTTP 200**,
Oak Street-branded landing page on the same CVS Phenom site. Inline:

```
cdn.phenompeople.com/CareerConnectResources/CVSCHLUS/...
careerSiteId: "CVSCHLUS"
refNum: "267ba0b4a9c44e65a996a0ae60924301"   (Oak Street brand filter)
```

**Critical recon finding:** the **same tenant** (`CVSCHLUS`) hosts
**multiple brand boards** under **different `refNum` values**. Oak
Street is not a separate Phenom tenant — it is a brand-scoped board
inside CVS's tenant. This matches how BL-145 already characterised the
row (`slug=cvs-oakstreet`, `_migration_note` references CVS bridge).

`GET https://jobs.cvshealth.com/widgets` → **HTTP 404**. The widgets
endpoint is **POST-only**; the SPA shell uses a CSRF-token cookie
flow for the first POST. See §2.3 for the actual hit.

### 2.3 Undocumented `/widgets` JSON API

Reverse-engineering writeups (jobo.world, fantastic.jobs,
jobfeedapi.com) document a stable undocumented `/widgets` POST
endpoint used by every Phenom SPA we've probed. Cross-source
confirmation of the request shape:

```
POST https://{TENANT_HOST}/widgets
Headers:
  Content-Type: application/json
  Accept: application/json
  X-Requested-With: XMLHttpRequest
  User-Agent: (browser-realistic)
Body (JSON):
  {
    "lang":          "en_global",
    "deviceType":    "desktop",
    "country":       "global",
    "pageName":      "search-results",
    "size":          20,
    "from":          0,
    "jobs":          true,
    "counts":        true,
    "all_fields":    ["category","country","city","type"],
    "clearAll":      false,
    "jdsource":      "facets",
    "isSliderEnable": false,
    "pageId":        "page20",
    "siteType":      "external",
    "keywords":      "",
    "global":        true,
    "selected_fields": {},
    "sort":          { "order": "desc", "field": "postedDate" },
    "locationData":  {},
    "refNum":        "<TENANT_OR_BRAND_REFNUM>",
    "ddoKey":        "refineSearch"
  }
Response (JSON):
  {
    "refineSearch": {
      "data": {
        "jobs": [
          { "jobId": "...",
            "reqId": "...",
            "jobSeqNo": "...",
            "title": "...",
            "location": "...",
            "locations": [ ... ],
            "category": "...",
            "type": "...",
            "postedDate": "<unix-ms or ISO>",
            "applyUrl": "...",
            "descriptionTeaser": "..." }
        ],
        "totalHits": <number>
      }
    }
  }
```

- **Pagination is `from / size`** — `size` defaults to 20 in the SPA
  but accepts up to 50 reliably (and some community scrapers report
  100 working on some tenants). Continue until
  `from + jobs.length >= totalHits`.
- **Auth: none** by default. Some tenants gate POST behind a CSRF
  token captured from a prior GET of the search-results page. If we
  hit 403 / 401 on a tenant, mitigation is a one-time GET to capture
  cookie + meta `csrf-token`, replay on subsequent POSTs. Not
  implemented in V1 (treated as a per-target failure → warn + skip).
- **Location filter** is structured but tenant-specific
  (`locationData.city.id` style nested keys). Simpler alternative:
  **don't filter at API level** — post-filter on `jobs[].locations[]`
  in adapter code (mirrors what Workable, Greenhouse, and the new
  UltiPro adapter already do).
- **JD body**: list response carries only `descriptionTeaser`
  (~100-200 chars). Full JD is on the public detail page
  `/{locale}/job/{JOB_ID}/{slug-title}` — server-rendered HTML, no
  auth, suitable for `jd_cache.js` fetch in `prepare` (§5).

### 2.4 Tenant discovery rules (refNum and careerSiteId)

`refNum` is the primary search-board identifier — **not** the tenant
itself. Recon distinguishes three flavours:

| Flavour | Example value | What scope it queries |
|---|---|---|
| Tenant-default refNum | `dca682849fce47be8e7a21258509e92e` (CVS main) | All jobs across the entire Phenom tenant |
| Brand-filter refNum | `267ba0b4a9c44e65a996a0ae60924301` (Oak Street under CVS) | Pre-filtered subset for a sub-brand |
| Geo-filter refNum | (sometimes used for country / region splits) | Pre-filtered subset by geography |

`careerSiteId` (e.g. `CVSCHLUS`) is the **tenant code** — appears in
the `cdn.phenompeople.com/CareerConnectResources/<careerSiteId>/`
asset paths. It is **not** required in the POST body but is useful
metadata for `companies.tsv` traceability (so the row's `slug` ties
back to the parent Phenom customer).

**Discovery procedure per new brand row** (one-time, manual):

1. Visit the brand's careers landing page (e.g.
   `https://jobs.cvshealth.com/us/en/jobs-oak-st-health`).
2. View source. Search for `refNum` and `careerSiteId` in the inline
   `<script>` blocks. Record both.
3. Note the **host** (`jobs.cvshealth.com`) — this is the
   `extra_json.host` for the row. Do **not** include scheme or path.
4. Note the **locale prefix** seen in the search-results URL (e.g.
   `us/en`) — record as `extra_json.locale` (default `us/en` if absent).
5. Build the TSV row per §6.3.

This procedure mirrors how BL-39 / RFC-051 documented UltiPro tenant
discovery — manual one-time tap into the customer's careers landing,
not an automated crawl.

### 2.5 Other tenants probed (cross-verification)

| Brand | Domain | Phenom? | Marker |
|---|---|---|---|
| CVS Health | `jobs.cvshealth.com` | YES | `cdn.phenompeople.com/.../CVSCHLUS/` |
| Oak Street (under CVS) | `jobs.cvshealth.com/us/en/jobs-oak-st-health` | YES (brand filter) | same CDN, distinct refNum |
| Phenom self | `careers.phenompeople.com` | YES (vendor canonical) | self-hosted |
| EverCommerce | `evercommerce.phenompeople.com` | YES | vendor subdomain |
| Honeywell | `careers.honeywell.com` (per WebSearch) | YES | Phenom-branded cookie page |
| GE Aerospace | `careers.geaerospace.com` (per jobo.world) | YES | documented example |
| HRM (Investor Relations) | `hrm-ir.phenompeople.com/jobs` | YES | vendor subdomain |
| Optum | `careers.optum.com` | likely | ECONNREFUSED during probe; deferred |
| Dignity Health | `jobs.dignityhealth.org` | likely | ECONNREFUSED during probe; deferred |
| DaVita | `careers.davita.com/us/en/search-results` | likely | 404 on direct probe — may be `jobs.davita.com`; deferred |
| Aspen Dental | (host TBC) | likely | not probed |

Six tenants confirmed via inline Phenom markers; four candidates
deferred to post-merge per-row verification (the candidate add-rows
in §9 are user product decisions, not adapter scope).

### 2.6 Open questions from BL-150 — answers

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Public JSON API or HTML-scrape? | **JSON via POST `/widgets`**. The official OAuth-gated `api.phenom.com/jobs-api/v1/jobs` is irrelevant — its access requires emailing `api-management@phenom.com`, not viable for self-hosted personal scraping. The unauth'd SPA-driven `/widgets` endpoint is the right target. | jobo.world, fantastic.jobs, jobfeedapi.com all converge on `/widgets`; live `cdn.phenompeople.com` confirms CVS uses Phenom SPA which calls `/widgets`. |
| 2 | URL shape `<company>.phenompeople.com` vs `careers.<company>.com`? | **Both coexist.** Vendor subdomains (`{tenant}.phenompeople.com`) for smaller tenants; CNAMEd customer domains (`jobs.cvshealth.com`, `careers.honeywell.com`) for enterprise. Same underlying widget endpoint. Tenant detection is via inline `cdn.phenompeople.com` marker, not the host. | §2.1, §2.5. |
| 3 | Pagination model? | **`from / size`**, 20 default, up to 50 reliable. Walk until `from + jobs.length >= totalHits`. | jobo.world; community scrapers consistent. |
| 4 | Location filter capability? | **Yes at API level** (nested `locationData`), but tenant-specific IDs make it brittle. Use **post-filter on `jobs[].locations[]`** — same pattern as Workable, Greenhouse, UltiPro. | §2.3; alignment with existing adapters. |

### 2.7 Recon outcome

BL-150's premise is correct. Adapter targets the unauth'd
`POST /widgets` JSON endpoint with `from/size` pagination, identifies
each TSV row by `(host, refNum)`, and post-filters by location
client-side. Brand-under-tenant nesting is handled by per-row refNum
(no tenant-tree traversal). JD body fetch via public detail HTML page
in `jd_cache.js`.

## 3. Goals / non-goals

**Goals**

- Generic adapter consuming any Phenom-hosted public career site via
  the unauth'd `POST {host}/widgets` API.
- One-line opt-in via `data/companies.tsv` — same shape as
  `greenhouse / workable / ashby / ultipro` rows, with `extra_json`
  capturing per-tenant `host` + `refNum` (+ optional `careerSiteId`,
  `locale`).
- Map `refineSearch.data.jobs[]` records to the canonical `Job` schema
  (`engine/modules/discovery/_types.js`) so dedup, fit, and Notion sync
  work unchanged.
- Pagination: walk `from/size` until `totalHits` reached, with a hard
  ceiling (`MAX_PAGES = 50` → 2500 jobs/tenant) as a safety net.
- JD fetcher in `engine/core/jd_cache.js`: fetch the public detail
  HTML page, strip to plain text, cache (mirrors the iCIMS / Workday /
  Workable patterns already in `jd_cache.js`).
- SSRF guards: only allow https; host must match either
  `*.phenompeople.com` OR be explicitly enumerated in a
  `PHENOM_HOST_ALLOW` set in code (mirrors Taleo's TenantHostAllow
  pattern).
- Migration: Oak Street Health row in `data/companies.tsv` flips from
  `no-adapter warn` to producing live jobs, after the migration
  commit (§9). Migration is **user-confirmed before code is written**
  — per CLAUDE.md "don't invent product decisions".

**Non-goals**

- **No use of the official `api.phenom.com` OAuth API.** It requires
  emailing Phenom for credentials; out of scope for a self-hosted
  personal tool.
- **No CSRF-token bootstrap in V1.** If a tenant gates POST behind
  CSRF, adapter logs warn + skips. Mitigation deferred to a follow-up
  RFC if a tenant we care about turns out to require it.
- **No expansion of `companies.tsv` beyond the existing Oak Street
  row.** Adding DaVita / Aspen Dental / Optum / EverCommerce rows is
  a separate product decision (§9 candidate list).
- **No header-forging beyond `X-Requested-With` and a realistic
  User-Agent.** If Phenom starts requiring a bot-detection token,
  that's a separate RFC.
- **No multi-locale fan-out per row in V1.** Each TSV row covers one
  locale (default `us/en`). Adding a second locale is a second row.
  Keeps the adapter's per-row cost predictable.
- **No structured location filter at API level.** Post-filter only.

## 4. Proposed adapter

### 4.1 File: `engine/modules/discovery/phenom_people.js`

Same general shape as `ultipro.js` (single source, multi-tenant,
auto-registered by filename). Differences from `ultipro.js`:

- URL is **2-part** per tenant: `{host}` + `{refNum}`. No board UUID
  in the URL itself — refNum is in the request body.
- Pagination loop over `from/size` inside the per-target function.
- `mapJob` reads `jobs[].locations[]` (array of objects with `city`,
  `state`, `country`) **or** falls back to the flat `location` string
  when the array is absent (older tenant configs).
- SSRF host allow: `*.phenompeople.com` OR `PHENOM_HOST_ALLOW` set
  (initially: `jobs.cvshealth.com` — that is what gets Oak Street to
  produce live jobs; everything else is gated until the user
  explicitly opts in).

### 4.2 Pseudocode (illustrative — written for review, not committed)

```js
const SOURCE = "phenom_people";
const PAGE_SIZE = 50;
const MAX_PAGES = 50;
const UA = "Mozilla/5.0 (compatible; ai-job-searcher/1.0)";

// SSRF: only allow phenompeople.com subdomains + explicit customer
// CNAMEs. Add a customer host here, never via TSV — keeps trust
// surface auditable in code.
const PHENOM_HOST_ALLOW = new Set([
  "jobs.cvshealth.com",
  // add more as adapter coverage expands (each one is a code change,
  // intentional)
]);

const REFNUM_RE = /^[a-f0-9]{32}$/;
const LOCALE_RE = /^[a-z]{2}\/[a-z]{2}$/;

function isAllowedHost(host) {
  const h = String(host || "").toLowerCase();
  if (PHENOM_HOST_ALLOW.has(h)) return true;
  return /^[a-z0-9][a-z0-9-]*\.phenompeople\.com$/.test(h);
}

function buildBody(refNum, from, size) {
  return {
    lang: "en_global",
    deviceType: "desktop",
    country: "global",
    pageName: "search-results",
    size,
    from,
    jobs: true,
    counts: true,
    all_fields: ["category", "country", "city", "type"],
    clearAll: false,
    jdsource: "facets",
    isSliderEnable: false,
    pageId: "page20",
    siteType: "external",
    keywords: "",
    global: true,
    selected_fields: {},
    sort: { order: "desc", field: "postedDate" },
    locationData: {},
    refNum,
    ddoKey: "refineSearch",
  };
}

function formatLocation(loc) {
  if (typeof loc === "string") return sanitizeText(loc);
  if (!loc || typeof loc !== "object") return "";
  const city = sanitizeText(loc.city);
  const state = sanitizeText(loc.state || loc.region);
  const country = sanitizeText(loc.country);
  return [city, state, country].filter(Boolean).join(", ");
}

function mapJob(target, raw) {
  const jobId = String(raw.jobId || raw.jobSeqNo || raw.reqId || "");
  if (!jobId) return null;
  const locale = target.locale || "us/en";
  const detailSlug = String(raw.title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  const url = `https://${target.host}/${locale}/job/${encodeURIComponent(jobId)}/${detailSlug}`;
  const fromArray = Array.isArray(raw.locations)
    ? raw.locations.map(formatLocation).filter(Boolean)
    : [];
  const fromString = raw.location ? [formatLocation(raw.location)] : [];
  const locations = dedupeLocations([...fromArray, ...fromString]);
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId,
    title: sanitizeText(raw.title),
    url,
    locations,
    team: sanitizeText(raw.category) || null,
    postedAt: parsePhenomDate(raw.postedDate),
    rawExtra: {
      careerSiteId: target.careerSiteId || null,
      refNum: target.refNum,
      employment_type: raw.type || null,
      brief: sanitizeText(raw.descriptionTeaser) || null,
      reqId: raw.reqId || null,
    },
  };
  assertJob(job);
  return job;
}

async function fetchPage(c, host, refNum, from) {
  const url = `https://${host}/widgets`;
  return fetchJsonPost(c.fetchFn, url, buildBody(refNum, from, PAGE_SIZE), {
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": UA,
    },
    signal: c.signal,
  });
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  return runTargets(targets, c, async (raw) => {
    const target = resolveTarget(raw); // pulls host/refNum/locale/careerSiteId from rawExtra
    if (!target) return [];
    if (!isAllowedHost(target.host)) {
      c.logger.warn(`[${SOURCE}] ${target.slug}: host "${target.host}" not in allow-list`);
      return [];
    }
    if (!REFNUM_RE.test(target.refNum)) {
      c.logger.warn(`[${SOURCE}] ${target.slug}: invalid refNum`);
      return [];
    }
    if (target.locale && !LOCALE_RE.test(target.locale)) {
      c.logger.warn(`[${SOURCE}] ${target.slug}: invalid locale`);
      return [];
    }
    const out = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const from = page * PAGE_SIZE;
      const body = await fetchPage(c, target.host, target.refNum, from);
      const data = body && body.refineSearch && body.refineSearch.data;
      const jobs = Array.isArray(data && data.jobs) ? data.jobs : [];
      if (jobs.length === 0) break;
      for (const r of jobs) {
        const job = mapJob(target, r);
        if (job) out.push(job);
      }
      const total = Number(data && data.totalHits) || 0;
      if (out.length >= total) break;
    }
    return out;
  });
}

module.exports = { source: SOURCE, discover };
```

### 4.3 `companies.tsv` row format

```
Oak Street Health	phenom_people	cvs-oakstreet	{"host":"jobs.cvshealth.com","refNum":"267ba0b4a9c44e65a996a0ae60924301","careerSiteId":"CVSCHLUS","locale":"us/en"}	lilia
```

- `ats_source = "phenom_people"` matches `SOURCE` in the adapter and
  the existing row already in `data/companies.tsv`.
- `ats_slug = "cvs-oakstreet"` — kept as-is from the existing row;
  acts as the natural human-readable key and the file-name slug used
  by `jd_cache.cacheKey()`.
- `extra_json` carries:
  - `host` — bare hostname (no scheme, no path). Validated against
    `PHENOM_HOST_ALLOW` (or `*.phenompeople.com`).
  - `refNum` — 32-char hex board id. Validated by regex.
  - `careerSiteId` (optional, traceability only — not sent in the
    request body).
  - `locale` (optional, defaults `us/en`).
- `profile = lilia`.

### 4.4 `_ats.js` change required

**None.** `fetchJsonPost` was added with RFC 051 (UltiPro) and is
sufficient. The Phenom adapter consumes it directly.

### 4.5 SSRF surface

This is the section the L-tier classification turns on. Phenom CNAMEs
its tenants to **customer-owned hostnames** (e.g. `jobs.cvshealth.com`),
which means the adapter must talk to hosts whose DNS the user does not
control. Mitigations layered:

1. **Host allow-list in code.** `PHENOM_HOST_ALLOW` enumerates the
   customer CNAMEs the adapter is permitted to hit. Adding a tenant
   requires a code change (intentional — every new tenant is a
   reviewed addition, not a TSV-only opt-in).
2. **`*.phenompeople.com` is allowed without enumeration.** Trust the
   vendor's own domain since the user already trusts Phenom by using
   the adapter at all.
3. **URL is built from the bare host + a hardcoded scheme + a
   hardcoded path** (`https://{host}/widgets`). The adapter does
   **not** parse a user-supplied `urlBase`. No path injection
   possible.
4. **No redirect-following.** `_http.js`'s default fetch already does
   not follow redirects by default in this codebase (verify in
   review). If it does, the adapter explicitly passes
   `redirect: "manual"` and treats 3xx as a failure.
5. **No outbound state.** Body and headers are deterministic; no
   cookies / no auth headers / no user-supplied request fields.

Compared to iCIMS / Taleo, the surface is similar (Taleo uses
`TALEO_HOST_ALLOW` for exactly this reason; same pattern carries
across). L-tier classification is justified by the cross-domain CNAME
pattern, not by raw complexity.

## 5. JD fetcher (`engine/core/jd_cache.js`)

Phenom job-detail HTML is server-rendered with the full JD body in a
predictable container. Add a `formatPhenom(html, job)` formatter +
URL builder mirroring `formatWorkable` / `formatTaleo`:

```js
const PHENOM_HOST_ALLOW = new Set([
  "jobs.cvshealth.com",
]);

function isAllowedPhenomHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (PHENOM_HOST_ALLOW.has(h)) return true;
  return /^[a-z0-9][a-z0-9-]*\.phenompeople\.com$/.test(h);
}

function buildPhenomJdUrl(job) {
  // The discovery adapter already stored the full canonical URL on
  // job.url; trust it but verify host allow + https.
  if (!job || typeof job.url !== "string") return null;
  let u;
  try { u = new URL(job.url); } catch { return null; }
  if (u.protocol !== "https:") return null;
  if (!isAllowedPhenomHost(u.hostname)) return null;
  // Reject query/fragment additions a tampered job.url might carry.
  if (u.search || u.hash) return null;
  return u.toString();
}

// HTML body containers seen on Phenom detail pages (probe + recon).
// Phenom uses a stable `<div class="jd-info">` block with the body
// inside `<div class="job-description">`. Detail pages also carry a
// `<script type="application/ld+json">` JobPosting block — same
// pattern as Taleo (RFC-032 reuses extractJsonLdJob already in
// jd_cache). Use ld+json as primary, HTML container as fallback.
function formatPhenom(html, job) {
  const ld = extractJsonLdJob(html);
  if (ld && typeof ld.description === "string" && ld.description.trim()) {
    return assembleJdFromLd(ld, job);
  }
  // HTML fallback
  const m = /<div[^>]*class="[^"]*\bjob-description\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (!m) return null;
  const body = stripHtml(m[1]).trim();
  if (!body) return null;
  return [
    `TITLE: ${job.title || ""}`,
    job.locations && job.locations.length ? `LOCATION: ${job.locations.join("; ")}` : null,
    "",
    body,
  ].filter(Boolean).join("\n");
}
```

JD fetcher edge cases:

- **404 on detail URL.** Job was removed between discovery and
  prepare. Return `not_found`. `jd_cache.fetchAll` already handles
  this status.
- **Body container drift.** ld+json fallback covers most cases.
  Returns `null` → `fetchJd` records `not_found`. Adapter does not
  poison the cache.
- **>5 MB HTML.** Truncate per `MAX_HTML_BYTES`, same pattern as
  iCIMS / Taleo.

## 6. Testing

`engine/modules/discovery/phenom_people.test.js`:

- **Happy path.** Faked `fetchFn` returns a 2-page fixture (page 0:
  `jobs.length=50, totalHits=73`; page 1: `jobs.length=23`). Asserts:
  73 jobs returned, `from` values in requests are `0, 50`,
  `Content-Type` + `X-Requested-With` headers set, body includes
  `refNum` + `ddoKey:"refineSearch"`, no third request.
- **Empty board.** `totalHits=0` → returns `[]`, single request.
- **Bad target — missing refNum.** Adapter skips, warn logged, other
  targets continue.
- **Bad target — invalid refNum shape.** `refNum="not-hex"` → skip
  with warn.
- **Bad target — disallowed host.** `host="evil.example.com"` → skip
  with warn, **no fetch performed**.
- **Pagination ceiling.** Faked source always returns 50,
  `totalHits=99999` → stops after `MAX_PAGES` requests.
- **Malformed job record.** No `jobId` / `jobSeqNo` / `reqId` →
  `mapJob` returns `null`, other records on the same page flow
  through.
- **Locations array vs string fallback.** Records with `locations[]`
  array → array used; records with only `location` string → string
  used; records with both → array preferred.
- **Locale validation.** `locale="en"` (no slash) → skip with warn.
- **404 / 403 containment.** Faked `{ok:false, status:403}` → caught
  by `runTargets`, warn, returns `[]`.

`engine/core/jd_cache.test.js` extensions:

- **Happy path.** Faked HTML with ld+json JobPosting → returns
  formatted text with TITLE / LOCATION / body.
- **HTML fallback.** No ld+json, `<div class="job-description">`
  present → returns formatted text.
- **Bad host.** `job.url` host not in allow → `buildPhenomJdUrl`
  returns `null` → `fetchJd` records `unsupported`.
- **Body missing.** No ld+json, no jd-info div → returns `null` →
  `not_found`, no cache write.

Total expected: ~12 new unit tests, no network.

## 7. `companies.tsv` migration plan

Single committed change: the existing `Oak Street Health` row gets
its `extra_json` filled in. **Before** (today):

```
Oak Street Health	phenom_people	cvs-oakstreet	{"siteUrl":"https://jobs.cvshealth.com/us/en/jobs-oak-st-health","_migration_note":"BL-72 2026-05-17: acquired by CVS Health 2023. Hiring on Phenom People — no adapter, will emit no-adapter warn until built. Keep row for visibility."}	lilia
```

**After** (post-adapter):

```
Oak Street Health	phenom_people	cvs-oakstreet	{"host":"jobs.cvshealth.com","refNum":"267ba0b4a9c44e65a996a0ae60924301","careerSiteId":"CVSCHLUS","locale":"us/en"}	lilia
```

This row edit is the **only** migration change in scope. Drop
`siteUrl` (it was a placeholder while no adapter existed). Drop the
`_migration_note` (the migration is now complete). User explicitly
confirms the row edit before code lands.

**Candidate add-rows (out of scope, documented for the user)** — to
be opted in by the user after V1 lands and adapter behaviour is
verified:

| Brand | TSV draft (host / refNum captured per §2.4 procedure) | Profile |
|---|---|---|
| CVS Health (core) | `{"host":"jobs.cvshealth.com","refNum":"dca682849fce47be8e7a21258509e92e","careerSiteId":"CVSCHLUS","locale":"us/en"}` | lilia (TBC) |
| DaVita | host+refNum TBC | lilia |
| Aspen Dental Mgmt | host+refNum TBC | lilia |
| Optum / UHG | host+refNum TBC | jared + lilia |
| EverCommerce | `{"host":"evercommerce.phenompeople.com","refNum":"TBC"}` | jared |
| Dignity Health | host+refNum TBC | lilia |

Each of those is one TSV row, no code change. Adding any of them is
a separate product decision the user takes at the time. The CVS-core
row in particular needs an extra consideration (whether Lilia wants
all-CVS results or only Oak Street brand — the existing brand-filter
refNum already isolates Oak Street, so the CVS-core row is **not
required** to unblock BL-150).

## 8. Identity & PII

**N/A — justified.**

- The adapter does not read, write, or process any candidate-side
  data. All inputs are public tenant hosts + 32-char refNum hex
  strings stored in `data/companies.tsv` (shared, non-PII master
  pool, already gitignored for unrelated reasons).
- All outputs are job postings (employer-side metadata: title,
  location, requisition number, posted date). No applicant data
  crosses the adapter.
- The adapter runs no-auth requests against Phenom's public
  `/widgets` endpoint; no Phenom session cookies, OAuth tokens, or
  credentials are touched. The user's `profiles/<id>/identity.json`
  is not read by this code path.
- The JD fetcher follows the same pattern as `formatWorkable` /
  `formatTaleo` — public HTML detail pages, no auth.
- Existing `profile.json` filter rules (geo, blocklist) apply
  downstream in `scan` exactly as they do for greenhouse / workable /
  ultipro; no new PII surface is introduced.

## 9. Failure modes

1. **Phenom changes API shape.** `refineSearch.data.jobs` becomes
   non-array or required fields go missing. Adapter throws
   per-target; `runTargets` logs warn, batch continues.
2. **Phenom starts requiring CSRF.** `/widgets` returns 401/403.
   Per-target failure → warn. Mitigation: follow-up RFC adds GET +
   cookie + meta `csrf-token` capture, replay on POST. Estimated
   effort: tier M follow-up; not pre-emptive.
3. **Bad `refNum` in `companies.tsv`.** 404 on POST or empty `jobs[]`
   → per-target containment, no batch impact.
4. **Bad `host` in TSV (not in allow-list).** Adapter never fetches;
   logs warn. SSRF surface stays closed.
5. **Rate limiting.** Not observed in third-party scraper reports.
   Default `_ats.js` concurrency-4 is the first line. Adapter also
   makes **serial** requests per tenant (pagination loop), so
   per-tenant throughput is naturally capped at one in-flight POST
   per tenant.
6. **Pagination ceiling hit.** `MAX_PAGES * PAGE_SIZE = 2500` cap. CVS
   alone may have >2500 active jobs (largest known phenom tenant);
   Oak Street brand-filter refNum is much smaller (~hundreds). Log
   warn at ceiling and proceed with first 2500. Defensive cap.
7. **Brand-filter refNum returns 0 jobs (brand temporarily idle).**
   `totalHits=0`, single request, returns `[]`. Indistinguishable
   from a healthy "no openings" state — correct behaviour.
8. **`jobId` collision across Phenom tenants.** Dedup key is
   `(source, jobId)` per `_types.js` and `applications_tsv.js`. Each
   Phenom `jobId` is a tenant-namespaced string (e.g. `P-103668` for
   Phenom self, internal `R0123456` for CVS) — collision risk is
   theoretical-only; even if it occurs, dedup by `(source, jobId)`
   means cross-tenant collisions are rare and detectable.
9. **CNAME flip.** A customer migrates their careers site to a new
   Phenom host. Adapter still works as long as the new host is in
   `PHENOM_HOST_ALLOW` (or `*.phenompeople.com`). Otherwise warn +
   skip + a new code change to add the host. Acceptable.
10. **JD body missing.** `formatPhenom` returns `null`; `fetchJd`
    records `not_found`. Job still passes through discovery
    untouched.

## 10. Implementation chunks (commit / PR plan)

L-tier work split into reviewable chunks. Each chunk is its own
commit / PR. Tests land in the same chunk as the code they cover.

| Chunk | Files | Tests | Tier locally |
|---|---|---|---|
| **C1** | RFC (this file) | — | — |
| **C2 — adapter core** | `engine/modules/discovery/phenom_people.js` + `engine/modules/discovery/phenom_people.test.js` + `engine/modules/discovery/index.test.js` adjustment (auto-registry) | unit tests §6 (10 cases) | M |
| **C3 — JD fetcher** | `engine/core/jd_cache.js` (+formatPhenom, +buildPhenomJdUrl, +PHENOM_HOST_ALLOW) + `engine/core/jd_cache.test.js` (4 cases) | §6 jd_cache extensions | M |
| **C4 — TSV migration + profile opt-in + docs** | `data/companies.tsv` (Oak Street row edit), `profiles/lilia/profile.json#modules` (add `discovery:phenom_people`), `ARCHITECTURE.md` (adapter inventory), `CHANGELOG.md` | smoke: `node engine/cli.js scan --profile lilia` shows Oak Street jobs in Inbox | XS |

C2 is the substantial chunk (~250 LOC + ~150 LOC test). C3 is small
(~80 LOC + 60 LOC test). C4 is a one-line TSV edit + one-line
profile-modules edit + docs.

Approval flow:

1. **C1 (this RFC)** → user reviews + approves before any code.
2. **C2 + C3 combined PR** (they form one logically reviewable unit
   — adapter + its JD fetcher) → code-reviewer subagent +
   `/security-review` per L-tier policy → user explicit approve →
   merge.
3. **C4 PR** → smoke test against live CVS-OakStreet → user verifies
   Inbox delta → merge.

C2+C3 PR carries no behaviour change for any profile (adapter exists
but no row uses it until C4 edits the TSV) — keeps the security
review focused on the adapter code itself, not on production data
shifts.

## 11. Plan проверки (verification plan)

1. **Unit tests green.** All cases in §6 pass against faked `fetchFn`.
2. **Manual smoke against CVS Oak Street.** After C4 lands, run
   `node engine/cli.js scan --profile lilia` and confirm Oak Street
   rows appear in `profiles/lilia/applications.tsv` with status
   `Inbox`, correct `companyName`, `title`, `locations`, `url`,
   `postedAt`. Verify no `no-adapter warn` for `cvs-oakstreet`.
3. **JD fetch smoke.** Run `node engine/cli.js prepare --profile lilia
   --phase pre --batch 5` selecting only Oak Street jobs. Verify
   `profiles/lilia/jd_cache/phenom_people_cvs-oakstreet_*.txt` files
   are written with non-empty bodies.
4. **L-tier security review.** Subagent `code-reviewer` against the
   C2+C3 diff (per dev-workflow Step 6). `/security-review` per L
   tier — focus on SSRF allow-list, URL building, CSRF / redirect
   handling. `/review` per L tier as final gate.
5. **Lilia geo-rule sanity check.** Verify Sacramento-area Oak Street
   roles flow through `filter_rules.json` locationAllow correctly
   (since BL-146 hardened per-row vs profile-level allow handling).
6. **Inbox delta.** Document the count before/after enabling
   `discovery:phenom_people` for Lilia in the BL-150 progress log.
   Expected shape: 10-50 new Inbox rows on first scan, depending on
   Oak Street brand's current open req count.

## 12. Open questions for approval

1. **Adapter targets unauth'd `/widgets` only — confirm OK?** Means
   we accept that CSRF-gated tenants (if any of our targets turn out
   to require it) are invisible until a follow-up RFC. Recommendation:
   yes, mirrors UltiPro V1 cost/benefit.
2. **`extra_json` schema — `{host, refNum, careerSiteId?, locale?}` —
   confirm field names?** Alternative: `siteUrl` (full URL) instead
   of bare `host`. Recommendation: bare `host` is safer (no scheme /
   path injection surface) and matches Taleo's `TALEO_HOST_ALLOW`
   pattern.
3. **SSRF allow-list `PHENOM_HOST_ALLOW = {jobs.cvshealth.com}` for
   V1 — OK?** Vendor `*.phenompeople.com` allowed without
   enumeration; customer CNAMEs require a code add. Recommendation:
   yes, this is the lowest-trust default.
4. **`MAX_PAGES = 50` (2500 jobs cap) — sane?** Largest known Phenom
   tenant (CVS core) may exceed; Oak Street brand alone is well
   under. Configurable via `ctx` if needed.
5. **JD fetch in V1 — confirm bundled with adapter?** BL-150 DoD lists
   "`engine/core/jd_cache.js`: JD fetcher" — yes, bundled per
   user-memory `feedback_notion_fields_must_fill.md` (new ATS adapter
   → JD fetcher in the same task, not follow-up).
6. **Drop `_migration_note` field from the Oak Street row?** That
   note documented the no-adapter gap; once the gap is closed the
   note is misleading. Recommendation: yes, drop.
7. **`profiles/lilia/profile.json#modules` opt-in — confirm?** New
   adapter is gated behind explicit profile opt-in (same as every
   other adapter). C4 adds `"discovery:phenom_people"` to the array.

## 13. Approval gate

L-tier → RFC + approve → code (C2 → C3 → C4 as separate commits) →
code-reviewer subagent on C2+C3 → `/security-review` on C2+C3 →
`/review` on C2+C3 → user explicit approve → C4 smoke against live
Oak Street → user verifies → merge. Per `DEVELOPMENT.md`, no code
is written until the user explicitly approves this RFC.

Recon recorded (§2, §2.6 question-by-question validation). Path
chosen: **JSON `/widgets` POST adapter, host allow-list at code
level, JD fetcher bundled, single committed TSV migration for Oak
Street only, candidate add-rows documented for user product
decision**. CSRF + structured location filter explicitly deferred to
follow-up RFCs only if a target tenant requires them.

## 14. Rollback

`git rm engine/modules/discovery/phenom_people.{js,test.js}` +
revert the `jd_cache.js` + `jd_cache.test.js` changes + revert the
`data/companies.tsv` Oak Street row to its pre-migration state +
remove `discovery:phenom_people` from `profiles/lilia/profile.json`.
Auto-registry forgets the source on next reload. Zero impact on
existing rows. Risk: nil — the Oak Street row reverts to the
pre-adapter "no-adapter warn" state it was already in.
