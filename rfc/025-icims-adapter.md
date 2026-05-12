---
id: RFC-025
title: iCIMS multi-tenant job-board adapter
status: draft
tier: M
created: 2026-05-11
tags: [discovery, ats, icims, lilia, healthcare]
---

# RFC 025 — iCIMS multi-tenant job-board adapter

- **Status:** Proposed
- **Author:** ymuromcev / Claude
- **Date:** 2026-05-11
- **Tier:** M (new adapter, profile-config schema unchanged, no migration
  of historical data)
- **Depends on:** none. Independent of RFC 016 (JD-cache) and RFC 017
  (Deel) — same adapter contract, plugs into existing `engine/core/scan.js`
  orchestrator.
- **Supersedes:** none
- **Driving backlog:** BL-30 (P0), BL-8 (research, archived 2026-05-05)

## 1. Problem

Lilia's whitelist of regional healthcare employers — CommonSpirit
(Dignity Health / Mercy San Juan / Dignity Health Medical Foundation),
Adventist Health, Sonrava Health, Demant family (HearingLife / Birdsong
/ CQ Partners), NVISION Eye Centers, Dialysis Clinic Inc., Shriners
Children's — is **not covered by the current adapter set**
(`greenhouse`, `lever`, `ashby`, `smartrecruiters`, `workday`,
`calcareers`, `usajobs`, `indeed`, `remoteok`). All seven are hosted on
**iCIMS**. The current Workday adapter covers only Sutter / Fresenius /
SCAN — three tenants out of ~12 actually relevant for Sacramento metro.

BL-8 (industry research, archived) flagged iCIMS as the
**highest-ROI single adapter** for healthcare: one adapter unlocks 9–12
companies on Lilia's whitelist. Today these companies are silently
absent from `scan` output for `--profile lilia`. The 2026-05-11 sweep
made this concrete: after BL-29 / BL-32 / BL-34 expanded indeed
keywords (12→19), geo cities (13→18), and fromage window (14→21), the
next scan returned **0 fresh jobs** — the discovery side is now
dedupe-saturated on the current source set. New sources are the only
remaining lever.

Kaiser Permanente is on Taleo, not iCIMS. BL-8 marked Taleo as "ROI vs
complexity questionable, defer". Out of scope for this RFC.

## 2. Recon (TODO — to be filled before approval)

iCIMS hosts each tenant on `careers-{slug}.icims.com` (most common),
sometimes `{slug}.icims.com` or a custom domain CNAME'd in front. The
public job-board page is HTML; there is a known internal JSON endpoint
`careers-{slug}.icims.com/jobs/search?ss=1&hashed=-…` that returns
JSON, but the hash parameter has historically been required and is
session-derived. Both paths need probing per-tenant before the design
locks.

**Probes to run** (one per tenant, capture verbatim into the
"Recon results placeholder" block below):

1. **Tenant URL resolution.** For each tenant slug below, confirm which
   of the following 200s and which redirect / 404:
   - `https://careers-{slug}.icims.com/jobs/search`
   - `https://{slug}.icims.com/jobs/search`
   - `https://careers.{custom-domain}/jobs/search` (Adventist may be on
     `careers.adventisthealth.org`, CommonSpirit on
     `careers.commonspirit.org`, etc.)

   Slugs to probe (best initial guesses, may need correction):
   - `commonspirit` (covers Dignity / Mercy San Juan / DHMF — one tenant)
   - `adventisthealth`
   - `sonravahealth` (or `sonrava`)
   - `demant` (covers HearingLife / Birdsong / CQ Partners — one tenant)
   - `nvisioneyecenters` (or `nvision`)
   - `dialysisclinic` (DCI)
   - `shrinershospitals` (or `shriners`)

2. **Page structure.** For each working tenant, `GET` the search URL
   with a realistic User-Agent and inspect raw HTML:
   - Are job titles + locations + URLs visible directly in the response
     body? (→ scrapeable HTML — preferred fallback)
   - Is there a `<script>` block with embedded JSON (`window.__data =
     {...}` or `__INITIAL_STATE__`)? Capture its top-level keys.
   - Are there pagination markers (`?in_iframe=1&pr=N`, `page=N`)?

3. **JSON-API probe.** For one tenant (CommonSpirit recommended — most
   jobs, easiest to verify counts):
   - `GET https://careers-commonspirit.icims.com/jobs/search?ss=1`
     (no hash) — does it return JSON, HTML, or 4xx?
   - Inspect Network tab in a real browser session: capture the actual
     XHR / fetch that populates the list — it's the cleanest API to
     consume if available.
   - If JSON is reachable: schema check. Common iCIMS shape:
     `{ items: [{ jobId, title, location, postedDate, url, ... }], total }`.

4. **ToS / robots.txt.** `GET https://careers-{slug}.icims.com/robots.txt`
   and the footer ToS link on one tenant. Industry norm: public ATS
   job boards are scrapeable (same as Greenhouse / Lever / Ashby /
   Workday). iCIMS is a hosted platform, so per-tenant ToS may not
   reference iCIMS at all — confirm verbatim.

5. **Geo presence sanity check.** For the top 2–3 tenants, eyeball
   first page of results: are there ≥ 1 Sacramento metro postings
   today? If `commonspirit` returns 0 Sacramento jobs we have a
   selection-bug or wrong slug — investigate before merging.

**Recon results (2026-05-11):**

**Probe 1 — Tenant URL resolution.** Of the 7 candidate tenants from
BL-30, only **3 are actually on iCIMS**. The other 4 are on different
ATSes entirely; they need separate adapters (separate BLs) and are out
of scope here.

| Company | ATS (actual) | URL | iCIMS? |
|---------|--------------|-----|--------|
| CommonSpirit Health (Dignity / Mercy SJ / DHMF) | iCIMS w/ TalentBrew frontend | `commonspirit.careers/search-jobs` (frontend) → `careers-commonspirit.icims.com` (backend) | ✅ but special |
| Adventist Health (Roseville CA) | **Oracle Recruiting Cloud** | `careers.adventisthealth.org` → `ecvz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience` | ❌ |
| Sonrava Health (Western Dental parent) | **UltiPro (UKG)** | `rn31.ultipro.com/WES1023/JobBoard/SearchJobs.aspx` | ❌ |
| Demant (HearingLife / Birdsong / CQ) | Custom platform | `careers.us.demant.com/jobs` (no /search) | ❌ |
| NVISION Eye Centers | iCIMS | `careers-nvisioncenters.icims.com` (slug correction: `nvisioncenters`, not `nvisioneyecenters`) | ✅ |
| Dialysis Clinic Inc | `dciinc.jobs` (separate vendor TBD) | `dciinc.jobs` | ❌ |
| Shriners Children's | iCIMS | `careers-shriners.icims.com` (slug correction: `shriners`, not `shrinershospitals`) | ✅ |

**Probe 2 — Page structure.** Both NVISION and Shriners render
job-list HTML server-side when called with `?ss=1&pr=N&in_iframe=1`:

- NVISION: `careers-nvisioncenters.icims.com/jobs/search?ss=1&pr=0&in_iframe=1`
  - Returns 40 jobs (Page 1 of 2 = ~60 total), real anchor tags with
    titles + location + jobId (`2026-NNNN` format).
- Shriners: `careers-shriners.icims.com/jobs/search?ss=1&pr=0&in_iframe=1`
  - Returns ~30 jobs/page (Page 1 of 6 = ~150–180 total), same shape.
- CommonSpirit `careers-commonspirit.icims.com/jobs/search` returns
  empty/portal-shell content — they use a custom TalentBrew frontend
  layered over iCIMS at `commonspirit.careers/search-jobs` (server-
  side rendered, 5,070 results / 461 pages, different HTML structure).

Pagination on direct-iCIMS variant: `?pr=N` (N=0 first page,
increments by 1). On CommonSpirit TalentBrew: standard `?page=N`.

**Probe 3 — JSON-API.** No JSON endpoint exposed on direct iCIMS
tenants without a session-derived hash. CommonSpirit TalentBrew is
server-rendered HTML (no client-side fetch). Conclusion: **HTML-only,
no JSON fast path.** RFC §4 will drop the JSON-first branch.

**Probe 4 — robots.txt + ToS.** All three iCIMS tenants ship the
**same iCIMS-default robots.txt**:
- `User-agent: *`
- Disallowed: `/jobs/*referral`, `/jobs/*login`, `/jobs/*candidate`,
  `/jobs/reminder`, `/connect/*` (auth + PII paths only)
- Sitemap: `https://careers-{slug}.icims.com/sitemap.xml`
- `/jobs/search` is **explicitly allowed**. Green light to scrape.

CommonSpirit's `commonspirit.careers` robots.txt not separately
probed; same crawl convention assumed (`/search-jobs` is the indexed
landing page they want SEO traffic on).

**Probe 5 — Geo presence (Sacramento metro).**
- **CommonSpirit** (via `commonspirit.careers`): 11+ Sacramento
  listings visible on first page filtered (HIM Specialist, Pharmacist,
  LVN, Patient Access, IS Support, Sports Med Physician, Nurse
  Supervisor, Nurse Manager Surgical, Practice Sup/Mgr). Highest ROI
  by far.
- **NVISION**: 2 Sacramento listings (Surgical Coordinator, Optometrist
  split with Roseville). Small but non-zero.
- **Shriners**: California listings visible (Pasadena), but **no
  Sacramento** in first page. Shriners may not serve Sacramento metro
  meaningfully — adapter will return 0 after geo filter; document but
  keep tenant in case future positions open.

**Implications for the design:**

1. **Scope reduction.** Drop Adventist (Oracle), Sonrava (UltiPro),
   Demant (custom), DCI (custom) from this RFC. File 4 separate BLs
   for them (BL-30 closeout should list these explicitly).
2. **HTML-only adapter.** Remove JSON-first branch from §4 stub.
3. **Two URL patterns.** §5 TSV rows must accommodate both:
   - Direct subdomain (NVISION, Shriners): default
     `careers-{slug}.icims.com/jobs/search?ss=1&pr=N&in_iframe=1`.
   - TalentBrew custom frontend (CommonSpirit): override via
     `meta.urlBase: "https://commonspirit.careers/search-jobs"` AND
     a different HTML extractor (`commonspirit` HTML shape != iCIMS
     standard).
4. **Two HTML extractors.** Refactor `extractJobsFromHtml(html)` →
   `extractJobsFromHtml(html, mode)` where mode ∈ {`icims-default`,
   `talentbrew`}. Default mode used unless `target.meta.htmlMode` is
   set.
5. **Request-level geo filter unreliable.** NVISION ate the
   `searchLocation=Sacramento%2C+CA` parameter and returned all
   states — so post-filter at adapter level (mirror Workday) is the
   only path. No per-request location filter.

## 3. Goals / non-goals

**Goals**

- Generic adapter for iCIMS-hosted boards (direct subdomain *and*
  custom-frontend variants like CommonSpirit's TalentBrew), driven by
  `data/companies.tsv` rows with `ats_source: icims`.
- Cover the 3 confirmed-iCIMS tenants from BL-30: **CommonSpirit
  (TalentBrew variant), NVISION (direct), Shriners (direct).**
  CommonSpirit alone justifies the work (11+ Sacramento listings,
  5,070 total positions, 461 pages).
- Drop into existing scan pipeline. No changes to
  `engine/core/scan.js`, `engine/modules/discovery/index.js`, or
  `engine/cli.js`. Single-line per-tenant TSV add.
- Match canonical `Job` schema (`engine/modules/discovery/_types.js`,
  `assertJob`) so dedupe, fit, geo-policy, Notion sync all work
  unchanged.
- Apply `profile.geo` policy at adapter-level (mirror `workday.js` —
  drop postings outside `locationAllow` before returning; log dropped
  count). Request-level location filter is unreliable on iCIMS (see
  recon probe 5), so post-filter is the only path.
- Single failure-mode per tenant (HTML structure changes) with a
  clear validate-time signal.

**Non-goals**

- Not migrating Adventist Health (recon found Oracle Recruiting
  Cloud, not iCIMS). Separate BL, see §14.
- Not migrating Sonrava Health (recon found UltiPro/UKG). Separate
  BL, see §14.
- Not migrating Demant (recon found custom platform on
  `careers.us.demant.com`, not iCIMS). Separate BL.
- Not migrating Dialysis Clinic Inc (recon found `dciinc.jobs`,
  unknown vendor). Separate BL.
- Not migrating Kaiser (Taleo) — Phase B, separate BL.
- Not migrating UC Davis (PageUp) — BL-8 / BL-33 marked NOT WORTH.
- No login flow, no iCIMS API key, no per-tenant auth — public boards
  only.
- No JD-cache integration in this RFC. Land independently when RFC
  016 ships.
- No Jared-side tenants in this RFC. Lilia only.

## 4. Proposed adapter — HTML-only, two extractor modes

File: `engine/modules/discovery/icims.js`. Contract mirrors
`greenhouse.js` / `workday.js`. JSON-first branch removed (recon §2
probe 3: no public JSON endpoint without session hash).

```js
const { runTargets, makeCtx } = require("./_ats.js");
const { assertJob } = require("./_types.js");
const { sanitizeText, parseIsoDate, dedupeLocations } = require("./_normalize.js");

const SOURCE = "icims";
const UA = "Mozilla/5.0 (compatible; ai-job-searcher/1.0)";
const PAGE_LIMIT = 30; // CommonSpirit: 461 pages, but geo-filter
                       // cuts to <30 useful pages in practice.

function tenantUrl(slug) {
  return `https://careers-${slug}.icims.com`;
}

async function fetchBoardJobs(fetchFn, target, signal) {
  const mode = (target.meta && target.meta.htmlMode) || "icims-default";
  const base =
    (target.meta && target.meta.urlBase) ||
    `${tenantUrl(target.slug)}/jobs/search`;

  return fetchHtmlPages(fetchFn, base, mode, signal);
}

async function fetchHtmlPages(fetchFn, base, mode, signal) {
  const all = [];
  for (let p = 0; p < PAGE_LIMIT; p++) {
    const url = buildPageUrl(base, mode, p);
    const res = await fetchFn(url, { signal, headers: { "user-agent": UA } });
    if (!res.ok) {
      if (res.status === 404 && p > 0) break;
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.status = res.status;
      throw err;
    }
    const html = await res.text();
    const pageJobs = extractJobsFromHtml(html, mode);
    if (pageJobs.length === 0) break;
    all.push(...pageJobs);
  }
  return all;
}

function buildPageUrl(base, mode, p) {
  if (mode === "talentbrew") {
    // CommonSpirit-style. Pagination via ?p=N. N=1 first page.
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}p=${p + 1}`;
  }
  // icims-default. ?ss=1 starts search, ?pr=N pagination (N=0 first),
  // &in_iframe=1 gets the static-HTML iframe variant.
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}ss=1&pr=${p}&in_iframe=1`;
}

function extractJobsFromHtml(html, mode) {
  // Regex-based, no JSDOM (same approach as calcareers.js).
  // Two mode shapes:
  //  - icims-default: <a class="iCIMS_Anchor" href="/jobs/NNNN/job-title/job">
  //    or class on parent <div class="iCIMS_JobListingRow"> with
  //    embedded location span + jobId in href.
  //  - talentbrew: <li class="job-result"> ... <a href="/job/{jobId}/{slug}">
  //    + <span class="job-location"> for location.
  // Concrete selectors finalized during impl by inspecting captured
  // fixture HTML (engine/modules/discovery/fixtures/icims/*.html).
  // ...
  return [];
}

function mapJob(target, raw) {
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId: String(raw.jobId),
    title: sanitizeText(raw.title),
    url: String(raw.url),
    locations: dedupeLocations(raw.locations || []),
    team: sanitizeText(raw.department) || null,
    postedAt: parseIsoDate(raw.postedAt),
    rawExtra: { icimsRaw: raw },
  };
  assertJob(job);
  return job;
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  return runTargets(targets, c, async (target) => {
    if (!target || !target.slug) return [];
    const raws = await fetchBoardJobs(c.fetchFn, target, c.signal);
    const jobs = raws.map((r) => mapJob(target, r)).filter(Boolean);
    return applyGeoFilter(jobs, c.profile?.geo);
  });
}

module.exports = { source: SOURCE, discover };
```

`applyGeoFilter` reuses the same helper Workday adapter uses today —
drop postings outside `profile.geo.cities` ∪ `country` allowlist before
returning. Log dropped count for parity with workday output:
`[icims] {slug}: dropped N postings outside locationAllow`.

Auto-registry pattern in `engine/modules/discovery/index.js` picks the
file up by filename — same as every other adapter.

## 5. companies.tsv migration

Append three rows under Lilia's profile (5th column = profile id):

```
CommonSpirit Health	icims	commonspirit	{"urlBase":"https://commonspirit.careers/search-jobs","htmlMode":"talentbrew"}	lilia
NVISION Eye Centers	icims	nvisioncenters		lilia
Shriners Children's	icims	shriners		lilia
```

- `commonspirit` — needs both overrides (custom-frontend URL +
  talentbrew extractor mode). The TalentBrew layer adds 5,070
  positions / 461 pages across the CommonSpirit family (Dignity
  Health, Mercy San Juan, DHMF — single tenant rolled up).
- `nvisioncenters` — slug corrected from BL-30's
  `nvisioneyecenters`. Direct iCIMS subdomain, no overrides needed.
- `shriners` — slug corrected from BL-30's `shrinershospitals`.
  Direct iCIMS subdomain, no overrides needed.

No backfill — `applications.tsv` rows for these companies are
currently zero. Existing dedup keys (`source, jobId`) are
source-namespaced, so future scans dedupe correctly.

Adventist / Sonrava / Demant / DCI are **not** added here. They live
in follow-up BLs (§14) with their actual ATSes (Oracle / UltiPro /
custom / custom).

## 6. JD-cache integration (RFC 016 — deferred)

When RFC 016 lands (JD-cache for non-Greenhouse/Lever sources), iCIMS
slots in cleanly. Each job's `url` points at an iCIMS-hosted JD page
(`/jobs/{jobId}/job` typically). Cache key: `icims:{slug}:{jobId}`.
Fetch logic: same HTML scrape, different extractor for the
`description` field. If RFC 016 lands first, this RFC adds a
`cacheJD()` call inside `mapJob`. If this lands first, RFC 016 adds
the iCIMS branch to its source dispatch table. No coupling required
for the initial scan-only ship.

## 7. Failure modes

1. **iCIMS changes HTML structure** (most likely — vendor occasionally
   refreshes the public board layout). Adapter throws per-target;
   `runTargets` logs warn and continues; other adapters unaffected.
   **Detection:** any iCIMS tenant with `historical_count > 5` whose
   last 3 scans return 0 — emit a validate-time warning. (RFC 017 §7
   proposed the same check; implement once, share across adapters.)

2. **Cloudflare / bot-block (403, 429)** — iCIMS does occasionally
   bot-block. Mitigation: realistic UA in request headers, concurrency
   cap (`_ats.js` enforces 4 already). If 403s persist on initial
   probes → fall back to browser-ingest (Section 8).

3. **JSON endpoint requires a session hash** — recon probe 3 will
   reveal. If true, JSON path returns null, adapter cleanly falls
   back to HTML scrape. No user-facing impact, just slower scans.

4. **Pagination loop never terminates** — `PAGE_LIMIT = 20` hard cap
   above. If a tenant exceeds 20 pages of relevant results we'll see
   truncation in the next scan; bump the constant or add a stricter
   geo-prefilter at request level (if iCIMS supports `?location=` —
   recon will confirm).

5. **Custom domain CNAMEs break the slug → URL convention** — handled
   via per-row `meta.urlBase` override (§5).

6. **Per-job URL drift** — derived URL (`/jobs/{jobId}/job`) doesn't
   match a tenant's actual route. Mitigation: prefer `raw.url` if
   present in HTML / JSON. Recon must confirm.

## 8. Browser-ingest fallback (if HTTP path is unreachable)

If recon shows all iCIMS tenants behind aggressive bot-blocking and no
JSON API: fall back to the Indeed pattern.

- User opens `https://careers-{slug}.icims.com/jobs/search` in Claude
  MCP browser.
- Skill step calls `read_page` or a small extractor JS pasted into
  `javascript_tool` to dump the rendered job list.
- JSON written to `profiles/<id>/.icims-state/raw_{slug}.json` with
  shape:
  ```json
  [{"jobId": "12345", "title": "…", "location": "…", "url": "…",
    "postedAt": "2026-05-01"}]
  ```
- Adapter target shape gains `ingestFile`:
  ```
  CommonSpirit Health	icims	commonspirit	{"ingestFile":"profiles/lilia/.icims-state/raw_commonspirit.json"}	lilia
  ```
- Adapter prefers `ingestFile` if present, else hits live URL. Mirrors
  `engine/modules/discovery/indeed.js` exactly.
- Document manual step in `skills/job-pipeline/SKILL.md` under
  "Discovery — iCIMS".
- **Cost:** every scan needs a manual browser session per tenant — 7×
  sessions for Lilia. Acceptable as fallback (Indeed precedent), bad
  as steady state. We use this only if HTTP-path probes fail.

## 9. Testing

- **Unit:** `engine/modules/discovery/icims.test.js` with fixture HTML
  files (`engine/modules/discovery/fixtures/icims/{slug}.html`) — real
  snapshots captured during recon, 2–3 tenants minimum. Cases:
  - Happy path: N jobs parsed, all pass `assertJob`.
  - Empty results: returns `[]` cleanly.
  - Malformed HTML (missing job-row class): throws clear error message.
  - Pagination: 2-page fixture → adapter walks both, returns combined.
  - 404 on page > 0: terminates pagination cleanly.
  - 403/429: throws status-tagged error → orchestrator isolates target.
  - Geo filter: postings outside `profile.geo.cities` dropped, count
    logged.
- **Snapshot test:** `mapJob` against a small `raws` fixture, asserts
  canonical `Job` shape — same pattern as `greenhouse.test.js`.
- **JSON-path test:** if recon confirms a usable JSON endpoint, add
  fixture `engine/modules/discovery/fixtures/icims/{slug}.json` and a
  test asserting JSON-first wins over HTML-fallback.
- **Integration:** optional, gated by `RUN_NETWORK_TESTS=1`. Hits real
  CommonSpirit endpoint, asserts ≥ 1 Sacramento job. Skipped in CI by
  default.
- **Fallback path:** unit test reading a fixture `raw_{slug}.json`,
  mirroring `indeed.test.js`.

## 10. Open questions

Recon resolved most of the previous questions. Remaining items are
implementation choices, not architectural unknowns:

1. **TalentBrew HTML selectors.** CommonSpirit `commonspirit.careers/
   search-jobs` HTML structure (job-row class, location span, job-URL
   pattern) — extracted from fixture HTML during impl. Selectors
   likely: `<li class="job-result">` or similar; concrete regex
   finalized once we capture the first fixture.
2. **iCIMS-default HTML selectors.** Same as above for NVISION /
   Shriners. WebFetch summarized them as visible during probe 2, but
   the exact CSS classes (`iCIMS_JobListingRow` / `iCIMS_Anchor` /
   etc.) need to be read off the raw HTML, not the WebFetch summary.
3. **CommonSpirit dedupe across child brands.** CommonSpirit umbrella
   covers Dignity Health, Mercy San Juan, Dignity Health Medical
   Foundation, plus many out-of-Sacramento systems (St. Vincent's,
   Catholic Health Initiatives, etc.). Same iCIMS `jobId` ↔ one
   posting, so `(source, jobId)` dedupe is safe. But the
   `companyName` we record should be "CommonSpirit Health" not the
   sub-brand the posting may show — keep one tenant row, one company
   name. If a user later wants per-brand grouping, that's a Notion
   view filter, not an engine concern.
4. **postedAt field.** Recon didn't dump full HTML, so it's unknown
   whether posting date is in the list-page HTML. If absent, leave
   `postedAt: null` (matches existing convention; not all adapters
   provide it). Mining individual JD pages for date is out of scope
   here; defer to RFC 016 (JD-cache).
5. **PAGE_LIMIT = 30 sufficient for CommonSpirit?** CommonSpirit has
   461 pages unfiltered. After Sacramento-area geo filter, most pages
   contain 0 matches and the early-exit (`pageJobs.length === 0`)
   kicks in fast. But if geo filter is applied **after** all pages
   are fetched, we hit the 30-page cap and miss most CommonSpirit
   postings. **Decision needed:** either (a) bump PAGE_LIMIT to 50+
   for CommonSpirit specifically (per-tenant override via `meta`), or
   (b) interleave geo-filter inside the page loop and continue until
   N consecutive zero-match pages. **Recommendation: (b)** —
   continue until 3 consecutive pages return 0 Sacramento jobs, OR
   page index hits 100. Implement in §4 stub revision during code.

## 11. Approval gate

Tier M → RFC + approve → code + tests + code-reviewer subagent →
smoke against real CommonSpirit (highest volume, easiest to verify) →
commit. Per `DEVELOPMENT.md`, no code is written until:

- Recon (§2) reviewed and accepted by user, AND
- User confirms scope reduction (3 tenants in this RFC, 4 separate
  BLs for non-iCIMS systems — §14), AND
- User approves the two-mode HTML adapter design (`icims-default` +
  `talentbrew`).

Multi-agent code review (code-reviewer subagent on the diff) is
mandatory for M-tier per DEVELOPMENT.md before commit.

## 12. Rollback

Revert the new `companies.tsv` rows (one-line `git revert` of that
hunk) and remove `engine/modules/discovery/icims.js`. Lilia loses
visibility into 3 iCIMS tenants (back to status quo before this RFC),
but no other profile / company is affected. Zero-risk change.

## 13. Success metric

After first successful scan post-merge:

- `node engine/cli.js scan --profile lilia` outputs an `icims: N
  returned` line with N > 0.
- Lilia's Inbox prirast (fresh rows) measured before/after; record
  in BL-30 closeout.
- **Expected magnitude**: 15–35 fresh Sacramento-metro postings on
  first scan. Breakdown by recon §2:
  - CommonSpirit: 10–25 (recon found 11+ Sacramento on first
    unfiltered page out of 5,070; full crawl across 461 pages
    finds more, post-dedupe stays in this band).
  - NVISION: 2–4 (recon found 2; tenant has ~60 jobs total).
  - Shriners: 0–2 (recon found 0 Sacramento; Pasadena was the only
    CA city visible on first page).
- If first scan returns < 5 fresh across all 3 tenants: investigate
  before declaring done — most likely a TalentBrew extractor bug
  (CommonSpirit alone should clear 5).

## 14. Follow-up BLs (out-of-scope tenants from BL-30)

Recon §2 found 4 BL-30 tenants on non-iCIMS systems. One BL per ATS
adapter group:

All four are **P0** per user decision 2026-05-11 ("все задачи на
расширение диапазона поиска для Лили — P0"):

- **BL-38** — Oracle Recruiting Cloud adapter (Adventist Health,
  HQ Roseville CA, Tier S for Lilia). P0 / L. Generic Oracle HCM
  Cloud adapter — same vendor covers Blue Shield CA and many
  enterprise healthcare, but DOD scoped to Adventist only.
- **BL-39** — UltiPro/UKG adapter (Sonrava Health, Western Dental
  family, ~600 offices). P0 / M. Could absorb DCI if BL-41 recon
  confirms shared vendor.
- **BL-40** — Demant careers (custom platform on
  `careers.us.demant.com`). P0 / M. Recon-first; likely
  browser-ingest fallback or drop.
- **BL-41** — Dialysis Clinic Inc on `dciinc.jobs` (vendor TBD —
  NLX layer with unknown ATS underneath). P0 / XS (recon only).
  Outcome determines whether DCI folds into BL-30/38/39 or gets a
  new adapter BL.
