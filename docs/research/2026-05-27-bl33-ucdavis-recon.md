# BL-33 — UC Davis Health Step-0 recon

**Date:** 2026-05-27
**Owner:** Claude (dispatch worktree `worktree-agent-ae72e10aed604b702`)
**Question:** Is BL-8's "NOT WORTH ROI — custom UCPath stack" verdict still
correct for UC Davis Health one year later, given UC Davis Health is the
largest Tier-S employer in Lilia's Sacramento radius?

## TL;DR

**Recommendation: PROCEED, but reframed.**

The BL-8 verdict was based on a wrong mental model. UC Davis Health does
**not** sit on a custom UCPath stack. It sits on the **UC-system-wide
Oracle PeopleSoft HRMS** instance, which also exposes a second, friendlier
front-end — `jobs.universityofcalifornia.edu` — that aggregates listings
from every UC campus (UC Davis, UC Davis Health, UCSF, UCLA, UC Berkeley,
UC Riverside, etc.) behind a single paginated HTML interface.

That changes the ROI math: this is **not** a single-tenant L-tier adapter
for one hospital. It's a multi-campus adapter covering the entire UC
system (~10 campuses, several Tier-S healthcare systems including UCSF
and UCLA Health). Single piece of engineering, broad coverage.

It also fits the engine's existing pattern: `engine/modules/discovery/calcareers.js`
already handles ASP.NET WebForms VIEWSTATE-postback scraping for CalCareers
(California state jobs). PeopleSoft HRMS uses a comparable session-token
+ pagination dance over HTML — same family of problem.

## What changed since BL-8 (2026-05-05)

- **ATS provider identified.** Not custom. Oracle PeopleSoft HRMS, hosted
  at `careerspub.universityofcalifornia.edu` under campus-keyed PSC sites
  (`/psc/ucdmed/` for UC Davis Health, SiteId=5).
- **Unified UC career site discovered.** `jobs.universityofcalifornia.edu/site/advancedsearch`
  exposes the same posting data through a far easier HTML interface,
  filterable by campus code (DVMC = UC Davis Medical Center / Health,
  DVCAMP = UC Davis main campus, SFCMP = UCSF, etc.).
- **Indeed has partial coverage.** Indeed sees 102-129 UC Davis Health
  Sacramento listings; Glassdoor sees 520. So Indeed syndicates ~20-25%
  of UC Davis Health postings — the assumption in BL-33 context that
  "Indeed does not syndicate" is overstated, but the gap (~400 missing
  listings) is large enough to justify direct coverage.

## URLs probed

WebFetch and `curl` were both unavailable in this worktree's sandbox, so
recon was done via WebSearch result snippets plus URL-pattern inference
from indexed search results. Findings are based on result titles and
content-snippets returned by WebSearch — no live response bodies were
fetched.

| URL | Status (inferred) | Role |
|---|---|---|
| `https://hr.ucdavis.edu/careers/apply` | Live, public | Landing page; redirects users to the PeopleSoft search component. |
| `https://careers.ucdavis.edu` | Live, public | Marketing/wrapper landing for campus careers. |
| `https://health.ucdavis.edu/careers` | Redirects to `/join-the-team/` | Marketing wrapper for UC Davis Health careers; links out to the PeopleSoft / unified UC search. |
| `https://employment.ucdavis.edu` | Live, alias for the careers landing. |
| `https://ucdavishealth.careers.universityofcalifornia.edu/` | Live, public | Campus-scoped landing → PeopleSoft component. |
| `https://careerspub.universityofcalifornia.edu/psc/ucdmed/EMPLOYEE/HRMS/c/HRS_HRAM_FL.HRS_CG_SEARCH_FL` | Live, public | **Native PeopleSoft job-search component** for UC Davis Health (SiteId=5). |
| `https://jobs.universityofcalifornia.edu/site/advancedsearch?Campus[campus_id]=DVMC` | Live, public | **Unified UC-system jobs board**, paginated HTML, filterable by campus. This is the recommended scrape target. |

## ATS stack — confirmed

**Oracle PeopleSoft HRMS** (PeopleTools-era PSC URLs: `HRS_HRAM.HRS_APP_SCHJOB.GBL`
and `HRS_HRAM_FL.HRS_CG_SEARCH_FL`).

UCPath (the system referenced in BL-8) is a related but separate component —
it's the **internal HCM/payroll** layer, not the external careers ATS.
BL-8's "custom UCPath stack" framing conflated the two.

Signatures observed in result URLs:

- `careerspub.universityofcalifornia.edu/psp/...` and `/psc/...` — classic
  PeopleSoft Portal and Component runtimes.
- `HRS_HRAM` / `HRS_APP_SCHJOB` — PeopleSoft HRMS recruiting module.
- Campus is keyed by `SiteId` (1–8) on PSC URLs and by a `Campus[campus_id]`
  query param on the friendly board.

**Not seen anywhere:** `pageuppeople.com`, `myworkdayjobs.com`, `icims.com`,
`taleo.net`, `csod.com`, `brassring.com`. So no migration off PeopleSoft —
this is **not** a TSV-row-only task; a real adapter is needed if we want
the listings.

## Listing accessibility

Two access paths, both public, no auth wall:

1. **Native PeopleSoft component**
   `careerspub.universityofcalifornia.edu/psc/ucdmed/...HRS_APP_SCHJOB`
   - HTML server-rendered, but heavy PeopleTools chrome.
   - Pagination via JS postbacks (similar to ASP.NET VIEWSTATE — same
     family as the `calcareers.js` adapter already in the engine).
   - Session token / `ICStateNum` cookie required for navigation.
   - Painful but not impossible.

2. **Unified UC jobs board** (recommended target)
   `jobs.universityofcalifornia.edu/site/advancedsearch?page=N&Campus[campus_id]=DVMC`
   - Plain GET-based pagination — observed result links include
     `?page=4&keywords=nurse&Campus[campus_id]=DVMC` and
     `?page=7&Campus[campus_id]=DVMC&sortby=location` in WebSearch
     indexing, which is consistent with stateless query-string paging.
   - Filterable by keyword, campus, category, location.
   - Server-rendered HTML — no SPA, no auth, no postbacks.
   - **This is the scrape target.** Skip the PeopleSoft component path.

## Inventory sizing (Sacramento area)

Cross-referenced from indexed aggregators (no live fetch; numbers from
WebSearch result snippets as of May 2026):

| Source | UC Davis Health Sacramento listings |
|---|---|
| Indeed (`q=uc-davis-health l=sacramento,ca`) | ~102 |
| Indeed (`q=uc-davis-medical-center`) | ~129 |
| Glassdoor (`UC-Davis-Health Sacramento`) | ~520 |
| ZipRecruiter | several hundred |

Glassdoor's 520 is the closest proxy for the actual UC Davis Health
posting count, since Glassdoor scrapes the source ATS directly. The
Indeed 102-129 reflects the slice UC Davis chooses to syndicate.

**Net new inventory for Lilia from a direct adapter: ~300–400 listings
above Indeed coverage**, in her target geography, at a Tier-S employer.
Includes patient services, scheduler, RN ancillary, admin, finance,
food service — the full Lilia target-role profile. Sample roles confirmed
in search results: "Senior Patient Services Representative", "Patient
Services Representative" (Midtown GI/Hepatology), "Certified Occupational
Therapy Assistant".

## Has UC migrated off PeopleSoft? No.

No migration signal in any indexed source. UCPath HCM is a separate,
internal system. The external careers stack is still PeopleSoft, the
unified board is still PeopleSoft-backed. This BL does **not** collapse
to a TSV-only task.

## ROI rationale

The BL-8 "single-tenant L-tier" framing is the reason to revisit:

- **Single-tenant?** No. One adapter covers all UC campuses including
  three Tier-S healthcare systems (UC Davis Health for Lilia, UCSF and
  UCLA Health for any future Bay-Area or LA-radius profile). The "UC
  system" is genuinely multi-tenant inside one ATS instance.
- **L-tier?** Probably M, not L. The unified board path
  (`jobs.universityofcalifornia.edu`) appears to be stateless paginated
  HTML — no cookies, no postbacks, no JS rendering required. That puts
  it closer in complexity to `workable.js` (77 lines) or `lever.js`
  (47 lines) than to the L-tier `taleo.js` (387 lines) or `workday.js`
  (211 lines). Final tier depends on whether the friendly board exposes
  enough fields (description, salary, posting date, requisition id) or
  if a second GET to the detail page is needed per row. Either way,
  M-tier is realistic.
- **Fragility?** Lower than BL-8 assumed. The unified UC board is
  institutional infrastructure — UC system-wide, governance-heavy,
  unlikely to change shape often. PeopleSoft URL patterns have been
  stable for 15+ years. Far less fragile than scraping a marketing
  careers wrapper.
- **Engineering budget?** M-tier (RFC + adapter + JD fetcher + tests +
  one TSV row in `data/companies.tsv`) is roughly 1–2 focused
  development sessions. The opportunity cost is one similarly-sized
  adapter (e.g., another non-standard ATS from BL-30). Given UC system
  is multi-tenant and Tier-S-dense, this wins on coverage-per-engineering-
  hour vs single-tenant alternatives.

## Recommendation

**Proceed — but reframed:**

1. **Re-title the BL.** "UC Davis Health adapter (PageUp / UCPath)" →
   "UC system unified careers adapter (PeopleSoft via
   jobs.universityofcalifornia.edu)". The work isn't UC-Davis-specific.
2. **Re-tier from L to M.** The unified-board path is plain HTML
   pagination. Drop the L-tier security-review + multi-agent overhead
   unless adapter implementation surfaces auth/cookie surprises.
3. **Target the friendly board, not the PeopleSoft component.**
   `jobs.universityofcalifornia.edu/site/advancedsearch?Campus[campus_id]=DVMC`
   first. Fall back to the PSC component only if the friendly board
   omits fields the engine needs.
4. **Companies-TSV entries.** Add UC Davis Health for Lilia immediately
   (campus code `DVMC`). The same adapter can later add UCSF, UCLA
   Health, etc. for other profiles via additional rows — no code
   changes per company.
5. **No browser-MCP fallback needed.** This is plain HTML; the
   indeed-prep manual-check pattern is not the right tool here.

## What is in scope for Etap 1 (if approved)

- `rfc/049-pageup-ucdavis-adapter.md` (skeleton drafted alongside this
  recon — see same commit).
- `engine/modules/discovery/ucsystem.js` (working name; final name
  decided in RFC) — fetch + parse, normalize to engine `Job` shape.
- JD fetcher entry — detail page per requisition, salary band parse.
- `data/companies.tsv` entry: UC Davis Health, campus code DVMC.
- Smoke test with checked-in fixture HTML.
- Lilia profile opt-in: `modules: ["discovery:ucsystem"]`.

## What is explicitly out of scope

- Other UC campuses' rollout (UCSF for any future Bay-Area profile,
  UCLA Health for any future LA-radius profile) — same adapter, future
  TSV rows, different BL.
- UCPath internal HCM integration — separate system, never needed for
  external job sourcing.
- iCIMS / Taleo adapters — covered by BL-30.

## Open questions for the user before Etap 1 starts

1. Confirm tier downgrade L → M based on this recon.
2. Confirm reframing of the BL from "UC Davis Health" to "UC system /
   jobs.universityofcalifornia.edu".
3. Confirm adapter name `ucsystem` (alternatives: `ucjobs`, `uc_peoplesoft`).

---

### Method note

This recon was done without live HTTP probes — both WebFetch and `curl`
were sandbox-blocked in this worktree. Conclusions are inferred from
WebSearch result titles, URL fragments, and snippets, plus pattern
matching against the engine's existing adapters (`calcareers.js`,
`workday.js`, `taleo.js`, `oracle_cloud.js`). Before adapter
implementation begins, the next step is a manual `curl` from the user's
machine to confirm:

- `GET jobs.universityofcalifornia.edu/site/advancedsearch?Campus[campus_id]=DVMC`
  returns 200 with HTML containing requisition rows (no auth wall).
- `?page=2` increments pagination as a query string (no hidden form
  state required).
- A single requisition detail page is reachable via a stable URL
  pattern.

If any of those three checks fail, fall back to the PeopleSoft
component path (`careerspub.universityofcalifornia.edu/psc/ucdmed/...`)
and re-evaluate tier.
