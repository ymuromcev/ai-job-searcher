# BL-40 Phase A recon — Demant careers (HearingLife / Birdsong / CQ Partners)

**Date:** 2026-05-27
**Profile:** Lilia
**BL:** [BL-40](../../private/backlog/BL-40.md) (in main checkout)
**Scope:** Phase A only — identify the real listing URL + underlying
ATS, recommend proceed / browser-ingest / drop. No adapter code, no
TSV edits, no PR.

## TL;DR

`careers.us.demant.com` is an **iCIMS Career Sites (Jibe)** whitelabel
sitting on top of plain iCIMS (`client_code=demant`, `tenantId=6145`,
`ats_code: "icims"`). The visible URL on the public frontend is
`/jobs`, not `/jobs/search` — that's why BL-40's primary probe 404'd.
The Jibe frontend exposes a clean JSON API
(`/api/jobs?limit=N`) that returns iCIMS-native fields directly,
including `apply_url`, `req_id`, geo, brand/`tags1` and the canonical
`jobs.demant.com/jobs/{slug}` URL.

**Recommendation: drop (archive).** ATS *is* iCIMS underneath, so
technically BL-40 collapses to a TSV-row task — but the existing
`engine/modules/discovery/icims.js` adapter hits
`careers-{slug}.icims.com/jobs/search?ss=1&pr=N&in_iframe=1`, and that
URL on `careers-demant.icims.com` is closed off (146-byte page that
JS-redirects back to the Jibe whitelabel). So out-of-the-box "add
Demant to the iCIMS TSV with slug=demant" will return 0 jobs.

Adding a third `htmlMode` to `icims.js` (call it `jibe-json`) to call
the Jibe `/api/jobs` endpoint would unblock Demant — but the listing
mix (75 US roles, ~45% audiology / hearing-screening, the rest retail
admin / customer service / sales) has zero overlap with Lilia's RN
target profile. **3 Sacramento-metro roles** (Roseville, Vacaville,
Valley Springs) and all three are non-RN retail. ROI is negative
once you weight maintenance of a new htmlMode against expected
applications.

---

## 1. Real listing URL

- **Homepage:** `https://careers.us.demant.com/careers-home` (200, the
  same URL BL-40 had).
- **Real listing:** `https://careers.us.demant.com/jobs` (200, 26 KB
  HTML shell, JS-rendered).
- **BL-40's `/jobs/search` probe:** 404 — that path doesn't exist on
  the Jibe whitelabel; "search" is just a query-string on `/jobs`
  (e.g. `/jobs?tags1=HearingLife`).
- **`/sitemap.xml`:** points to `https://jobs.demant.com/sitemap1.xml`
  (the canonical iCIMS-side domain). That sitemap host wouldn't
  resolve from my sandbox, so I can't quote a job-count from it, but
  the Jibe API gives the same answer (see §4).

## 2. Underlying ATS

**iCIMS Career Sites (Jibe whitelabel) on top of plain iCIMS.**

HTML / network signatures from `careers.us.demant.com`:

| Signal                                                            | Source                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Response header `rms-node: true`                                  | Classic Jibe / iCIMS Career Sites marker                                                    |
| Cookie `jasession=...`                                            | Jibe session cookie                                                                         |
| Script bundles from `app.jibecdn.com/prod/...`                    | iCIMS Jibe CDN                                                                              |
| CMS assets from `cms.jibecdn.com/prod/demant/assets/`             | Demant tenant in Jibe CMS                                                                   |
| Apply flow domain `demant.jibeapply.com` (+ qa / staging variants) | iCIMS Jibe Apply                                                                            |
| `privacy@icims.com` in default translations                       | Jibe was acquired by iCIMS in 2019; their translation bundles still reference jibe.com / iCIMS |
| API JSON fields: `client_code: "demant"`, `ats_code: "icims"`, `hiring_flow_name: "iCIMS ATS Hiring Flow"`, `meta_data.icims.primary_posted_site_object.tenantId: "6145"`, `meta_data.icims.primary_posted_site_object.site: "careers-demant"` | `/api/jobs` payload                                                                          |
| `apply_url`: `https://careers-demant.icims.com/jobs/{req_id}/login` | Apply still goes back to native iCIMS                                                       |
| `canonical_url`: `https://jobs.demant.com/jobs/{slug}?lang=en-us`  | Canonical SEO URL on iCIMS-managed host                                                     |
| `demant.icims.com` returns headers `icims-ats-customer: 6145`, `icims-organization: org_S9du5PqNbZRXmR9j`, `icims-tenant: 2d5f2711-9aeb-41da-b755-1294949bc403` | Confirms iCIMS tenant                                                                       |

So: the candidate-facing frontend is Jibe, the recruiter-facing ATS is
iCIMS, and they belong to the same vendor (iCIMS acquired Jibe in
2019). This is the **same vendor pair** we'd see on any modern iCIMS
tenant that opted into Career Sites.

**This does NOT collapse to the existing `icims.js` adapter in
practice.** That adapter scrapes the legacy iCIMS portal
(`careers-{slug}.icims.com/jobs/search?ss=1&pr=N&in_iframe=1`). On
`careers-demant.icims.com` that URL returns a 146-byte page whose
only meaningful content is a JS redirect back to
`https://careers.us.demant.com/jobs`. So a TSV row with
`slug=demant` and the default `icims-default` htmlMode would return 0
jobs.

## 3. JSON API endpoint + response shape

**Endpoint:**

```
GET https://careers.us.demant.com/api/jobs?limit=N
Headers (recommended): Accept: application/json,
                       Referer: https://careers.us.demant.com/jobs
                       Cookie: jasession=... (from a prior GET on /jobs)
```

Single-call pagination: `?limit=100` returned all 75 listings in one
shot. `offset=...` and `page=...` do not appear to be honored
(probably handled client-side). For a tenant this small, batching is
fine; for larger tenants a different param would need probing.

**Top-level shape:**

```json
{
  "jobs": [ { "data": { ... } } ],
  "totalCount": 75,
  "count": 75,
  "languageCounts": { "en-us": { "displayName": "English", "count": 75 } },
  "filter": {
    "facetList": { "tags1": [ { "term": "HearingLife", "count": 41 }, ... ] },
    "brands": { "all": [ { "brand": "Demant", "numJobs": 75 } ] },
    "categories": { "all": [ { "category": "Healthcare Practitioners and Technicians", "numJobs": 34 }, ... ] },
    "locations": { "all": [ { "city": "Roseville", "state": "California", "country": "United States", "count": 1 }, ... ] }
  }
}
```

**`jobs[].data` keys (relevant subset):**

| Field                       | Example                                                                          |
| --------------------------- | -------------------------------------------------------------------------------- |
| `slug`                      | `"25811"`                                                                        |
| `req_id`                    | `"25811"`                                                                        |
| `title`                     | `"Part Time Clinical Operations Supervisor"`                                     |
| `description`               | Full HTML, ~5–10 KB per role                                                     |
| `qualifications`            | HTML, "Education and Experience" block                                           |
| `responsibilities`          | HTML, duties block                                                               |
| `city` / `state` / `country` / `country_code` / `full_location` | `"Detroit Area" / "Michigan" / "United States" / "US" / "Detroit Area, Michigan"` |
| `latitude` / `longitude`    | Numeric                                                                          |
| `categories`                | `[{ "name": "Professionals" }]` (single value per job)                           |
| `tags1`                     | Brand-within-Demant: `["HearingLife"]`, `["Hearing Screening Associates"]`, `["CQ Partners"]`, `["Oticon"]`, etc. |
| `brand`                     | Always `"Demant"`                                                                |
| `salary_value` / `salary_min_value` / `salary_max_value` | Numeric; in this snapshot all three were 0 for every role                       |
| `posted_date` / `create_date` / `update_date` | ISO-8601                                                                         |
| `apply_url`                 | `"https://careers-demant.icims.com/jobs/{req_id}/login"`                         |
| `meta_data.canonical_url`   | `"https://jobs.demant.com/jobs/{slug}?lang=en-us"`                               |
| `ats_code`                  | `"icims"`                                                                        |
| `applyable` / `searchable` / `internal` | Booleans                                                                         |

Plenty of structured data to drive both fit-scoring and Notion-row
population without HTML parsing. Salary, however, is unfilled across
this tenant.

## 4. Sacramento-area listings (current snapshot)

From the `filter.locations.all` facet (no need to fetch each job):

| City             | State      | Count | Approx distance from Sacramento |
| ---------------- | ---------- | ----- | --- |
| Roseville        | California | 1     | 20 mi NE (Sacramento metro)     |
| Vacaville        | California | 1     | 35 mi W                         |
| Valley Springs   | California | 1     | 50 mi SE (Calaveras County)     |
| San Rafael       | California | 1     | 95 mi SW (Bay Area, not Sac)    |

**3 in Sacramento metro, 4 in CA total.** Total US listings across
all Demant brands: **75**.

Brand split (`tags1`) on the full 75-row set:

- HearingLife: 41
- Hearing Screening Associates: 11
- E3: 8
- Oticon: 7
- Demant Group Services: 5
- BluePrint Solutions: 1
- CQ Partners: 1
- Diagnostic Group LLC: 1

Category split:

- Healthcare Practitioners and Technicians: 34 (audiologists, hearing
  aid specialists, hearing screening techs)
- Administrative/Clerical: 12
- Customer Service/Support: 7
- Sales: 7
- Production/Operations: 5
- Professionals: 5
- HR/Payroll: 3
- IT: 1
- Field Leaders: 1

Zero engineering / data / product / nursing / RN categories. The 3
Sacramento-metro roles are all retail audiology / hearing-screening,
not nursing — confirms BL-40's own ROI warning.

## 5. Recommendation: **drop / archive BL-40**

ATS *is* iCIMS underneath, so in a hypothetical world where
`icims.js` already supported the Jibe `/api/jobs` endpoint this
would be "just add a TSV row." But:

1. The Jibe whitelabel locks out the native iCIMS portal that
   `icims.js` knows how to scrape (`careers-demant.icims.com/jobs/search`
   bounces to Jibe). So a TSV row with `slug=demant` would return 0
   jobs out of the box.
2. Unblocking Demant means **either** adding a third `htmlMode` to
   `icims.js` (call it `jibe-json`) that calls
   `careers.us.demant.com/api/jobs?limit=N` and maps the JSON to the
   standard job shape, **or** writing a new `jibe.js` adapter for the
   Jibe family of whitelabels. Both are Tier M (RFC + code +
   tests).
3. The expected ROI from doing that work, *for Lilia*, is:

   - 3 Sacramento-metro roles snapshot, **none RN**, all retail
     audiology / hearing-screening (Roseville, Vacaville, Valley
     Springs).
   - 0 roles in the categories that have ever scored Strong for
     Lilia.
   - Salary data is unfilled (every `salary_*` field is 0 on this
     tenant), so even the auto-filled Notion salary column would
     stay empty.

Net: building `jibe-json` mode is justified only when a *second*
Jibe tenant in scope produces actual fit. Demant alone doesn't.

**Suggested action on BL-40:**

- Status → `archived`, `closed: 2026-05-27`.
- Notes: ATS confirmed as iCIMS (Jibe whitelabel). Reusing existing
  `icims.js` would need a new `jibe-json` htmlMode (Tier M). 3
  Sacramento roles in current snapshot, all non-RN retail audiology.
  ROI does not justify the adapter work for Demant alone.
- If a second Jibe-on-iCIMS tenant shows up in a future
  `BL-30`-style sweep with stronger fit, **reopen** as a generic
  "add `jibe-json` mode to `icims.js`" task (Tier M, RFC needed)
  rather than a Demant-specific BL.

## 6. Honest ROI paragraph

This is the kind of recon where the "right" engineering answer
(iCIMS underneath, ~80 lines of code to add a third htmlMode) and the
"right" product answer (don't ship it) point opposite ways. Demant is
a hearing-aid retail group; the 75 US roles skew hard toward retail
audiologists, hearing-aid specialists, and clinic admin staff, with
no nursing roles in this snapshot and no salary data ever filled.
The 3 Sacramento-metro roles are exactly the audiology / retail roles
Lilia is *not* targeting. Even if the `jibe-json` mode were free to
build, the Notion intake from this tenant would be ~0 Strong-fit
rows per scan — pure noise. Better to archive BL-40 and only revisit
if a second Jibe-whitelabel tenant with closer fit (e.g. a Jibe site
on a hospital iCIMS tenant) appears in a future sweep, at which
point the work amortizes across multiple tenants.

## 7. Artifacts (kept in this worktree, gitignored via dotfile prefix)

- `.demant_home.html` — `/careers-home` HTML shell, ATS-signature
  source.
- `.demant_jobs.html` — `/jobs` HTML shell.
- `.demant_icims_native.html` — 146-byte JS-redirect proof that
  `careers-demant.icims.com/jobs/search?ss=1&pr=0&in_iframe=1` is
  locked off.
- `.demant_api_sample.json` — full `/api/jobs?limit=1` payload (one
  job + full facets / locations facet).
- `.demant_all.json` — `/api/jobs?limit=100` payload (all 75 jobs).
- `.demant_cookies.txt` — `jasession` cookie used as a sanity check
  for whether the API needs it. Not strictly required for GETs that
  followed the homepage in the same shell, but harmless.

None of these are committed (the leading `.` keeps them outside the
standard `.gitignore` patterns but also outside any normal
`git add` glob; they're recon scratch). They were deleted before
commit.

## 8. BL-40 Progress block (verbatim — append to `private/backlog/BL-40.md`)

The sandbox in this worktree session refused to write to the main
checkout's `private/backlog/BL-40.md` (writes outside the worktree
root are blocked at the OS level for Bash and at the hook level for
Edit/Write). Below is the exact Markdown to append to BL-40 — the
parent (PM) session can paste it in.

```markdown

## Progress

### 2026-05-27 — Phase A recon done

Recon doc: `docs/research/2026-05-27-bl40-demant-recon.md` (in branch `worktree-agent-a90b4997630f80882`).

**Findings:**

- Real listing URL — `https://careers.us.demant.com/jobs`. BL-40 `/jobs/search` probe был wrong path; "search" — это query-string на `/jobs`.
- **Whitelabel вендор: iCIMS Career Sites (Jibe).** Сигналы: header `rms-node: true`, cookie `jasession`, bundles `app.jibecdn.com`, CMS `cms.jibecdn.com/prod/demant/`, apply flow `demant.jibeapply.com`.
- **ATS underneath: plain iCIMS.** API: `client_code=demant`, `ats_code=icims`, `tenantId=6145`. Apply URL → `careers-demant.icims.com/jobs/{req_id}/login`. Native `demant.icims.com` отдаёт headers `icims-ats-customer: 6145`.
- **JSON API:** `GET https://careers.us.demant.com/api/jobs?limit=100` — все 75 US-листингов одним вызовом, с полным набором iCIMS-полей (req_id, title, description, city/state, lat/lng, categories, tags1, brand, apply_url, canonical_url). Salary unfilled.
- **Sacramento-metro:** 3 листинга (Roseville, Vacaville, Valley Springs) — все retail audiology / hearing-screening, RN — 0.
- **Mix:** 34 Healthcare Practitioners (audiologists), 12 Admin, 7 Sales, 7 Customer Service, 5 Production, 5 Professionals, 3 HR, 1 IT, 1 Field Leader. RN категории — 0.

**BL-40 НЕ collapses на existing `icims.js` adapter.** Native iCIMS portal `careers-demant.icims.com/jobs/search?ss=1&pr=0&in_iframe=1` залочен — 146 байт + JS-redirect на Jibe. Нужен новый `htmlMode: "jibe-json"` в `icims.js` (call `/api/jobs?limit=N`, map JSON в стандартный shape) — Tier M, RFC.

**Recommendation: drop / archive.** Технически ~80 строк на новый htmlMode, но product-ROI отрицательный: 3 Sac-metro роли, все non-RN retail, 0 ролей в Strong-fit категориях. Salary пустое. Реопен только при появлении ≥2-го Jibe-on-iCIMS tenant с RN-fit.

**Proposed close:** `status: archived`, `closed: 2026-05-27`. Финальное переведение в archived оставляю за пользователем (Phase A scope only).

Branch: `worktree-agent-a90b4997630f80882`.
```
