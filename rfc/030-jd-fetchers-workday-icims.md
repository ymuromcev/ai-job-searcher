# RFC 030 — JD fetchers for Workday + iCIMS

- **Status:** Accepted (2026-05-12)
- **Author:** @jared
- **Created:** 2026-05-12
- **Refs:** BL-46, RFC-025 (iCIMS adapter), `engine/core/jd_cache.js`,
  `engine/core/jd_extract.js`

## 1. Problem

`engine/core/jd_cache.js#fetchJd` only handles `greenhouse` and `lever`.
For every other source it returns `{status: "unsupported"}` → no
`jdText` → engine cannot extract Schedule / Requirements → Notion
`Schedule` field stays null on commit.

Live evidence (Lilia, 2026-05-12): 2 of 3 just-pushed pages had empty
Schedule because their source (workday, icims) has no JD fetcher; the
3rd (greenhouse) had Schedule="Days" extracted correctly.

## 2. Goal

Add JD fetchers for `workday` and `icims` so that `prepare --phase pre`
populates `jdText` for these sources, allowing `extractFromJd` to
surface Schedule + Requirements automatically.

## 3. Non-goals

- Oracle Cloud, Jobsyn, SmartRecruiters, Ashby — separate BLs if
  Schedule coverage matters there.
- Changing the `cacheKey` scheme or `fetchAll` orchestration.
- LLM-based JD extraction (engine remains regex-based).

## 4. Design

### 4.1 Workday

**Endpoint discovery:** Workday tenants expose JD JSON at
`https://{tenant}.wd1.myworkdayjobs.com/wday/cxs/{tenant}/{site}/job/{job_path}`
(GET, no auth, returns `jobPostingInfo`). Job path is what the
`workday` adapter already stores as `jobId` (e.g.
`/job/Sacramento/Ethics---Compliance-Auditor-II_R-127489`).

**Slug encoding:** the adapter writes `slug` as `{tenant}/{site}`
(e.g. `sutterhealth/SH`). `fetchJd` will reconstruct the URL from
`(slug, jobId)`.

**Fetch flow:**
1. Build URL from slug + jobId.
2. `d.fetchFn(url, {timeoutMs: 15000, retries: 1})`.
3. On non-200 → `{status: "not_found"}`.
4. Parse JSON; expect `data.jobPostingInfo.description` (HTML) and
   `data.jobPostingInfo.location`, `.timeType`, `.title`.
5. Build text body via `formatWorkday(data, job)` mimicking
   `formatGreenhouse`:
   ```
   TITLE: {title}
   LOCATION: {location}
   SCHEDULE: {timeType}   (Workday surfaces "Full time" / "Part time" etc.)

   {stripHtml(description)}
   ```
6. Write to cache.

Note: surfacing `timeType` line up-front lets `extractSchedule` regex
match the explicit Workday vocabulary first, before falling back to
generic body scan.

### 4.2 iCIMS

**No public JSON API** (per RFC 025 §2 — session-hash gated). Use HTML
scraping like the adapter does.

**Fetch flow:**
1. Build URL: same `url` field as the listing (`careers-{slug}.icims.com/jobs/{jobId}/{slug-title}/job?in_iframe=1`).
2. `d.fetchFn(url, {timeoutMs: 15000, retries: 1, headers: { "User-Agent": "Mozilla/5.0 ..." }})`.
3. HTML body capped at `MAX_HTML_BYTES = 5 MB` (mirror BL-30 hardening).
4. Extract description container:
   - `<div class="iCIMS_JobContent">` for `icims-default` mode.
   - For `talentbrew` (CommonSpirit) — `<div class="ats-description">`
     (TBD, lock during recon).
5. Strip HTML via existing `stripHtml`.
6. Optional: prepend `TITLE:` / `LOCATION:` / `SCHEDULE:` if those
   labels appear in the page header (mirror BL-30 fixture pattern).
7. Write to cache.

### 4.3 Code touch points

1. `engine/core/jd_cache.js`:
   - Add `formatWorkday(data, job)` + `formatIcims(html, job)`.
   - Extend `fetchJd` source switch: `workday`, `icims`.
2. `engine/core/jd_cache.test.js`:
   - Add fixture (1 workday + 1 icims) under
     `engine/core/fixtures/jd_cache/`.
   - Mocked `fetchFn` returns the fixture body / JSON.
   - Assert resulting `text` contains expected SCHEDULE / TITLE markers
     and that the cache file is written.
3. `engine/core/jd_extract.test.js`:
   - Regression: ensure `extractSchedule` parses the new "SCHEDULE: …"
     line from `formatWorkday` output. (May already work — verify.)

### 4.4 Backwards compatibility

- Existing cached files (`greenhouse_*` / `lever_*`) untouched.
- New cache keys (`workday_*` / `icims_*`) coexist without collision.
- `cacheKey` scheme unchanged.
- `fetchJd` return shape unchanged.

## 5. Tests

| Layer | Case | Source |
|---|---|---|
| unit | `formatWorkday` parses fixture into TITLE/SCHEDULE/body block | `engine/core/jd_cache.test.js` |
| unit | `formatIcims` strips HTML correctly + retains header labels | same |
| unit | `fetchJd("workday")` writes cache on first call, reads on second | same |
| unit | `fetchJd("icims")` same | same |
| regression | `extractSchedule` parses Workday's "Full time" wording | `engine/core/jd_extract.test.js` |
| integration | Lilia `prepare --phase pre` fills Schedule for workday + icims rows in next batch | manual smoke |

## 6. Rollout

1. Approve RFC.
2. Implement Phase A (Workday) → tests green → multi-agent code review.
3. Implement Phase B (iCIMS) → tests green → review.
4. Smoke: `prepare --phase pre --mode fresh --batch 30 --profile lilia`
   on a freshly scanned Inbox. Verify Schedule fills on workday + icims
   entries.
5. Commit, push, close BL-46.

## 7. Risks

- **iCIMS HTML fragility** — if iCIMS changes their DOM, extractor
  silently degrades to `{status: "not_found"}`. Mitigation: existing
  RFC 025 selector lock + fixture-based tests catch regressions in CI.
- **Workday auth challenges** — some tenants gate JD JSON behind a
  session. If smoke reveals a 403 on a major tenant, fall back to HTML
  scraping for that subset (deferred).
- **`extractSchedule` ambiguity** — Workday's `timeType` field uses
  "Full time" (space), while the engine regex may expect "Full-time"
  (hyphen). RFC §4.1 mitigates by surfacing it as a labeled SCHEDULE
  line so a more permissive regex pass picks it up.

## 8. Open questions

- Should iCIMS use the existing `careers-{slug}.icims.com` URL or a
  separate `*.icims.com/jobs/{id}` JSON endpoint? Recon during impl.
- Workday tenant `slug` encoding — adapter currently stores
  `{tenant}/{site}` but RFC 030 needs to confirm.
