# RFC 034 — JD fetcher for CalCareers

- **Status:** Proposed (2026-05-18)
- **Author:** @jared
- **Created:** 2026-05-18
- **Refs:** BL-106 (CalCareers keyword targets, done), BL-105
  (CalCareers adapter, archived), RFC 030 (Workday + iCIMS JD
  fetchers — pattern template), RFC 025 (iCIMS adapter — HTML
  scraping precedent), `engine/core/jd_cache.js`,
  `engine/modules/discovery/calcareers.js`

## 1. Problem

`engine/modules/discovery/calcareers.js` is wired up and produces job
rows, but `engine/core/jd_cache.js#fetchJd` returns
`{status: "unsupported"}` for `source === "calcareers"`. Downstream
effects on `prepare --phase pre` for jared:

- `jdText` is never written.
- `extractFromJd` produces no Schedule / Requirements.
- The LLM in the `job-pipeline` skill judges fit using only the
  listing-tile fields (working title, department, location, salary
  range, final filing date) — JD body is invisible.
- Notion card lands with empty JD Summary, empty Schedule.

Live evidence (2026-05-18 smoke): 3 calcareers rows in jared's Inbox
(`Senior Solutions Engineer`, `Enterprise Solutions Architect`,
`Bilingual Business Operations Service Center Representative`). Their
working titles are too generic to tell whether the underlying
**Classification** matches jared's active eligibility (IT Manager II
/ IT Specialist II). Without the JD body we cannot read the
`Classification:` line that lives on the posting page.

This is also a memory-rule debt: «новый ATS adapter → JD fetcher в
той же задаче». The adapter pre-dates that rule, so this RFC closes
the gap.

## 2. Goal

Add a JD fetcher for `calcareers` so that `prepare --phase pre`
populates `jdText` from the public posting HTML, and surfaces the
`CLASS:` line so the LLM can directly match the posting's
classification against eligibility.

## 3. Non-goals

- Eligibility-list automation (renewal, exam scheduling, list-code
  matching) — out of scope, separate flow.
- Modifying `engine/modules/discovery/calcareers.js` (adapter stays
  as-is; we don't add Classification to `rawExtra` in this RFC).
- LLM-based JD extraction (engine remains regex / DOM-based, same
  pattern as iCIMS/Taleo).
- Back-filling JD cache for the 1235 calcareers rows already in
  jobs.tsv. Cache fills lazily as rows hit `prepare`.

## 4. Design

### 4.1 Endpoint

CalCareers posting page is reachable at the URL the adapter already
writes into `job.url`:

```
https://www.calcareers.ca.gov/CalHrPublic/Jobs/JobPosting.aspx?JobControlId={N}
```

No public JSON API. Page returns ~430 KB of HTML (ASP.NET WebForms)
under a 301 → 200 redirect from the `www.` host. Standard `User-Agent`
required (Azure App Gateway gates empty-UA requests).

### 4.2 DOM structure (recon, JobControlId=504301)

- Main JD body: `<div id="pnlJobDescription">…</div>` (~2.9 KB after
  HTML strip).
- 16 sibling `<div class="postingContent">` blocks below it carry
  supplementary sections: Telework Information, Special
  Requirements, Working Conditions, Statement of Qualifications,
  Department Information, etc.
- Header strip carries labels: `Working Title:`, `Classification:`,
  `Department:`, `Location:`, `Salary:`, `Telework:`,
  `Publish Date:`, `Final Filing Date:`, `Job Code #:`.

Concrete sample (after strip):

```
Working Title: Senior Solutions Engineer
Classification: INFORMATION TECHNOLOGY SPECIALIST III $9,507.00 - $12,740.00
Department: CA High Speed Rail Authority
Location: Sacramento County
...
```

The `Classification:` value is the **Class Title** Jared cares about
for eligibility match (e.g. `INFORMATION TECHNOLOGY MANAGER II`,
`INFORMATION TECHNOLOGY SPECIALIST II`). It is the most
load-bearing addition this RFC introduces.

### 4.3 Fetch flow

1. `fetchJd` receives `job` with `source="calcareers"`, populated
   `url`, `slug`, `jobId`.
2. Reject empty / non-string `url`. (Same defensive guard as
   iCIMS branch.)
3. `d.fetchFn(job.url, { timeoutMs: 15000, retries: 1, headers: { "User-Agent": HTML_UA } })`.
4. On non-200 → `{status: "not_found"}`.
5. Read body as text, cap at `MAX_HTML_BYTES = 5 MB`.
6. Empty body → `{status: "not_found"}`.
7. Run `formatCalCareers(html, job)`.
8. If formatter returns `null` (no JD body found) → `{status: "not_found"}`.
9. Otherwise → write to cache, return `{status: "fetched", text}`.

### 4.4 `formatCalCareers(html, job)`

Returns `null` when no `pnlJobDescription` body can be extracted, so
`fetchJd` surfaces a `not_found` rather than caching a header-only
1-liner (same hardening as `formatWorkday` / `formatTaleo`).

Output shape (mirrors existing fetchers):

```
TITLE: {workingTitle or job.title}
CLASS: {classification value, uppercased exactly as on page, salary-stripped}
LOCATION: {location, from header or job.locations[0]}
SCHEDULE: {telework verbatim or empty}
SALARY: {salary range, verbatim}
FINAL FILING: {date, MM/DD/YYYY}

{stripHtml(pnlJobDescription)}

{stripHtml(any "Duties" / "Minimum Requirements" / "Special Requirements" /
"Statement of Qualifications" postingContent blocks, joined with blank lines)}
```

Header labels are extracted with a single `labeledFields`-style
pass: regex anchors on each label, captures up to the next known
label or 400 chars, strips HTML, trims whitespace.

The CLASS line stops at the first run of `$`/digits so the salary
suffix in `Classification: INFORMATION TECHNOLOGY SPECIALIST III $9,507.00 - $12,740.00`
doesn't leak into the CLASS marker.

### 4.5 Code touch points

1. `engine/core/jd_cache.js`:
   - Add `"calcareers"` to `SUPPORTED` set.
   - Add `formatCalCareers(html, job)`.
   - Add `calcareers` branch in `fetchJd` source switch (mirrors
     icims branch — HTML fetch, UA, 5MB cap, defensive guards).
   - Export `formatCalCareers` for tests.
2. `engine/core/jd_cache.test.js`:
   - Add fixture under `engine/core/fixtures/jd_cache/calcareers_504301.html`
     (trimmed sample, ≤ 50 KB).
   - Mocked `fetchFn` returns the fixture; assert resulting `text`
     contains `TITLE:`, `CLASS: INFORMATION TECHNOLOGY SPECIALIST III`,
     `Duties` body section, and that the cache file is written.
   - Negative cases: empty body → `not_found`; missing
     `pnlJobDescription` → `not_found`; HTTP 404 → `not_found`;
     fetch throw → `error`.
3. `engine/core/jd_extract.test.js`:
   - Regression smoke: feed CalCareers output through
     `extractFromJd` and assert no crash. Schedule extraction is
     best-effort (telework / hybrid wording is non-standard on
     CalCareers); don't gate on it.

### 4.6 Backwards compatibility

- Existing cached files untouched. New cache key:
  `calcareers_{slug}_{jobId}.txt` (e.g. `calcareers_itm2_504301.txt`).
- `cacheKey` scheme unchanged.
- `fetchJd` return shape unchanged.
- `extractFromJd` may now see new `CLASS:` lines — if its regex
  matches "CLASS" against something else, we discover that in the
  regression test. Otherwise it is ignored harmlessly.

## 5. Tests

| Layer | Case | File |
|---|---|---|
| unit | `formatCalCareers` extracts CLASS / TITLE / body from fixture | `engine/core/jd_cache.test.js` |
| unit | `formatCalCareers` returns null when `pnlJobDescription` missing | same |
| unit | `formatCalCareers` strips salary suffix from CLASS line | same |
| unit | `fetchJd("calcareers")` writes cache on first call, reads on second | same |
| unit | `fetchJd("calcareers")` returns `not_found` on 404 / empty body | same |
| unit | `fetchJd("calcareers")` returns `error` on fetch throw | same |
| regression | `extractFromJd` runs on CalCareers output without crash | `engine/core/jd_extract.test.js` |
| integration | jared `prepare --phase pre --batch 5` fills `jdText` for ≥1 calcareers row | manual smoke |

## 6. Rollout

1. Approve RFC.
2. Create BL-107 (Tier M).
3. Implement `formatCalCareers` + `fetchJd` branch + tests.
4. `npm test` green.
5. Multi-agent code review (subagent code-reviewer on diff).
6. Manual smoke: trigger `prepare --phase pre` on a small batch
   that includes calcareers rows; verify `jdText` is non-empty
   and Class Title is visible.
7. Commit (no push needed — `engine/core/jd_cache.js` and tests are
   tracked, but commit and push happen together per CLAUDE.md).
8. Close BL-107.

## 7. Risks

- **CalCareers HTML fragility** — ASP.NET / DevExpress markup can
  change without notice. Mitigation: fixture-based tests catch
  regressions in CI; `formatCalCareers` returns `null` on shape
  changes rather than caching garbage; existing adapter already
  carries a `warn` on missing ResultCount marker, so the failure
  mode is loud-on-scan, silent-on-JD-fetch (acceptable — fetcher
  failures only suppress a single Notion card, scan failures
  suppress the whole source).
- **Azure App Gateway rate-limit** — Notion-scale batches (~20
  prepare calls) shouldn't trip the gate, but adapter already uses
  `concurrency: 1` and 800 ms `stepDelayMs`. JD fetcher will share
  the default `concurrency: 8` of `fetchAll`. If we see 429s, drop
  CalCareers JD fetches to `concurrency: 2` via a per-source override
  (deferred — out of scope unless smoke shows a problem).
- **Classification value drift** — some postings use legacy class
  titles (e.g. `STAFF INFORMATION SYSTEMS ANALYST` for pre-2017
  series). The CLASS line passes through whatever the page renders;
  matching against jared's eligibility is downstream LLM work, not
  this RFC's concern.
- **Bilingual / specialty postings** — Statement of Qualifications
  in Spanish would land in the JD body unchanged. Same handling
  as English; not a fetcher concern.

## 8. Open questions

- None blocking. Smoke will tell us whether `extractSchedule` picks
  up telework wording reliably; if not, RFC 030's "labeled
  SCHEDULE line" approach is already in place and gives us a clean
  fallback.

## 9. Out of scope (explicit, for future BLs)

- Adding `Classification` to `job.rawExtra` in
  `engine/modules/discovery/calcareers.js` so jobs.tsv carries it
  alongside working title. Would require an adapter recon pass
  (the listing page hides Classification — it only appears on the
  individual posting). Worth doing if the LLM-side eligibility
  match proves noisy.
- Sniffing the listing page for `eligibility-only` flag (some
  postings are open only to specific list eligibles; engine doesn't
  read that today).
- Eligibility renewal flow (separate BL — calendar reminder, exam
  retake checklist).
