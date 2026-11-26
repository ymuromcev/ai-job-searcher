# RFC 073 — Walmart careers discovery adapter (BL-252)

## Problem
Walmart retired its public Workday tenant (`walmart.wd5.myworkdayjobs.com/WalmartExternal`
returns HTTP 422 to every jobs query), so the `workday` adapter cannot see Walmart, Sam's Club
or VIZIO postings. Today Walmart roles reach the pipeline only by chance via Adzuna.

## Options
- A: Sitemap (`/sitemap.xml`, ~15.6k job URLs, no titles) + per-page fetch of new ids. Allowed by
  robots.txt, but the first run is ~15k page fetches and every scan hundreds more (store roles).
- B: The careers site's own search call (`POST /api/graphql`, persisted query), keyword query,
  paged (10/page, cap 20 pages per query). 1–20 requests per scan, structured fields
  (title, city/state, pay range, posting date). `/api` is disallowed in robots.txt.
- C: Adzuna company filter — partial coverage, already the status quo.

## Chosen
B, behind a per-profile opt-in (`discovery:walmart` + one `companies.tsv` row with
`searchTexts`). Keyword adapter, like `workday` multi-query mode. JD body via the server-rendered
job page in `core/jd_cache.js` (host-locked to careers.walmart.com, id `R-` + 5–9 digits). Added to
`NO_SUBMIT_SOURCES` (apply needs a Walmart account). Robots.txt risk is surfaced to the owner.

## Identity & PII
N/A — public job postings only; no user data sent (query text is a role keyword).

## Risks
- Persisted query id can rotate → adapter returns 0 rows and logs a warning; scan continues.
- Response shape change → same containment (per-target error capture in `runTargets`).

## Verification
Unit tests with faked fetch (paging, dedup, mapping, stop at total, bad ids dropped); JD
formatter test on a fixture page; one live dry adapter run listing current Senior PM rows.
