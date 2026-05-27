# BL-33 Step-0 recon — UC Davis Health ATS

- **Date:** 2026-05-27
- **Profile:** lilia
- **BL:** [BL-33](../../private/backlog/BL-33.md) (also [BL-8](../../private/backlog/BL-8.md))
- **Recommendation:** **DROP** new adapter. Add UC Davis Health to
  `companies.tsv` with `source_via=indeed` and revisit only if Indeed
  yield turns out to be poor.

## TL;DR

UC Davis (whole system, including UC Davis Health) still posts jobs
through the UC-system shared **Oracle PeopleSoft HRMS Fluid** portal
at `careerspub.universityofcalifornia.edu` (Oracle copyright 1988-2024
still in the source). The listing page is cookie-gated, async, and
the actual results render via internal PeopleSoft Fluid XHR posts
behind a session token — there is no public JSON endpoint.

However Indeed has ~125 UC Davis Health listings for the Sacramento
area and LinkedIn lists ~267, so the coverage problem is partially
solvable by the existing `indeed.js` adapter (and a future LinkedIn
one). A dedicated PageUp / PeopleSoft adapter is not justified.

BL-8's 2026-05-05 verdict — *"NOT WORTH ROI — single university
system, custom UC stack"* — still holds, with one terminology fix:
the stack is **on-prem Oracle PeopleSoft HRMS**, not PageUp and not
UCPath. UCPath is the UC system's payroll / HR record system; jobs
live in a separate PeopleSoft Talent Acquisition (TAM) module under
`careerspub.universityofcalifornia.edu/psp/ucdavis/`.

## URLs probed

| URL | Status | Notes |
|---|---|---|
| `https://hr.ucdavis.edu/careers/apply` | 403 (Cloudflare bot block) | Same 403 BL-8 saw in 2026-05-05. UA spoofing didn't help; needs full browser fingerprint. |
| `https://hr.ucdavis.edu/careers` | 403 (Cloudflare) | Same protection. |
| `https://careers.ucdavis.edu` | 403 (Apache) | No-content reject. |
| `https://health.ucdavis.edu/careers` | 404 | URL doesn't exist on the health site. |
| `https://health.ucdavis.edu/jobs` | 404 | Same. |
| `https://health.ucdavis.edu/about/work-with-us` | 404 | Same. |
| `https://employment.ucdavis.edu/` | TLS/connect timeout (>20s) | Host responds but never completes. Likely intranet. |
| `https://careerspub.universityofcalifornia.edu/psc/ucdavis/EMPLOYEE/HRMS/c/HRS_HRAM_FL.HRS_CG_SEARCH_FL.GBL` | 200 → redirect to `?cmd=login&errorPg=ckreq` | Without cookies: Oracle PeopleSoft "cookies required" error page (3.2KB). |
| Same URL **with `-c cookies.txt`** + `&Page=HRS_APP_SCHJOB_FL&Action=U&SiteId=11` | 200 (571KB HTML) | PeopleSoft Fluid shell. `<title>Careers</title>`. **No `JobOpeningId=` in HTML — listings load via async POST**. |

## ATS identification

**Vendor: Oracle PeopleSoft HRMS (on-prem, Fluid UI)** — confirmed
from page signatures:

- `<img src="/ucdavis/images/OracleLogo_Black.svg">` and
  `<span class="ps_logo-PS"> PeopleSoft</span>` on the error page.
- HTML comment block `Copyright (C) 1988, 2024, Oracle and/or its
  affiliates`.
- Component path `HRS_HRAM_FL.HRS_CG_SEARCH_FL.GBL` — PeopleSoft
  HCM 9.2 Fluid naming convention (HRS_ = HR core, _FL = Fluid).
- Cookie names like `PS_TOKEN`, `PS_TOKENEXPIRE`, `ExpirePage` (set
  by the portal on first hit).

This is **not PageUp** (would be `*.pageuppeople.com` or `*.peopleadmin.com`),
**not Workday** (`*.myworkdayjobs.com`), **not Oracle Cloud Fusion**
(`*.oraclecloud.com/hcmUI/CandidateExperience` — covered by
existing `engine/modules/discovery/oracle_cloud.js`), **not Taleo**
(`*.taleo.net`), **not iCIMS** (`*.icims.com`).

UC Davis has **not migrated** to a modern shared ATS since BL-8. The
existing `oracle_cloud.js` adapter does **not** work for PeopleSoft
HRMS — different API, different auth, different URL grammar.

## Listing accessibility

- Without cookies → cookie-check error page only.
- With cookies → HTML shell only; **no listings in the static HTML**.
  The Fluid UI fires async POSTs back to
  `HRS_HRAM_FL.HRS_CG_SEARCH_FL.GBL` with `ICAction` form values that
  carry the session token to render rows. Scraping this requires:
  1. Bootstrap a PS session (set cookies, parse `ICStateNum`, `ICElementNum`).
  2. POST search criteria with the correct token-tracked `ICAction` payload.
  3. Parse the partial-HTML response (PeopleSoft returns DOM fragments,
     not JSON, in Fluid 9.2).
  4. Repeat per pagination + per job-detail page for description.
  5. Track session expiry and refresh — `PS_TOKEN` expires fast.

In short: **scraping is technically possible but every UC ATS upgrade
cycle (one a year) breaks `ICAction` payloads silently**. This is the
classic single-tenant on-prem PeopleSoft scraping problem, the exact
trap BL-8 flagged.

## Listing volume (via syndicators)

- **Indeed** (`/cmp/UC-Davis-Health/jobs` + Sacramento+25mi search):
  ~125 listings for UC Davis Health.
- **LinkedIn** ("UC Davis Health" + Sacramento, CA): ~267 listings.

Lilia's filter rules in `profiles/lilia` would narrow this — Tier-S
patient-facing / scheduling / admin titles only — but even at 20%
relevance that's 25-50 candidate rows per scan cycle, which is real
signal for a Sacramento-radius candidate.

## ROI rationale (why DROP)

1. **Engineering cost is L-tier.** A working PeopleSoft Fluid scraper
   needs ~3-4 days: session bootstrap, ICAction payload reverse-engineering,
   DOM-fragment parser, retry/refresh on `PS_TOKEN` expiry, pagination,
   detail-page fetch for descriptions, plus a per-UC-campus dispatcher
   (UC Davis's `SiteId=11` vs other campuses) if the adapter ever
   widens. BL-8 estimated similar; nothing has improved.

2. **Maintenance cost is recurring.** Every PS upgrade breaks
   ICAction/ICStateNum encoding. The community-known PeopleSoft
   scrapers on GitHub all carry "broken as of YYYY-MM" disclaimers.
   This is single-tenant scraping pain, not a reusable adapter — the
   reuse argument from BL-8 still holds: **the UC PeopleSoft cluster
   only services UC**, no other employer in Lilia's radius is on the
   same stack.

3. **Most listings are reachable elsewhere already.** ~125 on Indeed
   (covered by `engine/modules/discovery/indeed.js`), ~267 on
   LinkedIn (no adapter yet, but BL for one would be reusable across
   every profile, not single-tenant). The Sacramento gap is solvable
   via the syndicator path with much higher leverage.

4. **Cloudflare on `hr.ucdavis.edu`** signals UC is actively bot-blocking
   external clients — same defensive posture in 2026 as in 2026-05-05.
   Even the listings page (`careerspub...`) requires session cookies
   for non-trivial content. Each layer is a maintenance liability.

5. **Browser-ingest fallback is a clean middle-ground if Indeed yield
   turns out to be poor.** Lilia could run a weekly Chrome MCP pass
   on `careerspub.universityofcalifornia.edu/psc/ucdavis/...` with
   filters preset, and we ingest the resulting rows as a CSV — same
   pattern as `indeed-prep` for cases where automation is hostile.
   That's a 1-2h scripting task, not an L-tier adapter.

## Concrete next steps (if user accepts DROP)

1. Close BL-33 as `archived` with a pointer to this recon doc.
2. Add `UC Davis Health, Sacramento` to `data/companies.tsv` for
   Lilia with `extra_json={"source_via":"indeed","ats_note":"PeopleSoft
   HRMS — not directly scraped, syndicated via Indeed/LinkedIn"}`.
   (User decision, not done here — `data/companies.tsv` edits are
   out of scope for Step-0.)
3. Spin a new BL for a `linkedin.js` discovery adapter (the real
   leverage: every profile benefits, not just Lilia).
4. If Indeed yield is empirically weak after one Lilia scan cycle,
   open a follow-up BL for the manual Chrome-MCP weekly ingest, not
   for a full PeopleSoft adapter.

## What changed since BL-8 (2026-05-05)

Nothing material:

- Same Oracle PeopleSoft stack, same Cloudflare on `hr.ucdavis.edu`.
- Same 403 behaviour against curl with full UA.
- No migration to Workday / iCIMS / Taleo detected.
- BL-8 said "UCPath stack" — that was a terminology slip; the actual
  vendor is PeopleSoft HRMS (UCPath is the payroll/HR-of-record side
  of the same Oracle ecosystem). Practical conclusion identical.

## RFC

Not drafted. The recommendation is DROP, so no `rfc/049-pageup-ucdavis-adapter.md`
is needed. If the user overrides the recommendation, the RFC will
be drafted as a follow-up before any code is written.
