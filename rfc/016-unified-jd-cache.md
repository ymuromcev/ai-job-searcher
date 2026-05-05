# RFC 016: Unified JD Cache Across All ATS Adapters

- **Status**: Proposed
- **Date**: 2026-05-05
- **Tier**: M (architecture, multi-module surface)
- **Author**: ai-job-searcher engine
- **Supersedes**: extends behavior introduced alongside Stage 12 prereqs (`engine/core/jd_cache.js`)

## 1. Problem statement

`engine/commands/prepare.js` needs the full job description (JD) text for two deterministic outputs: fit-score and cover-letter generation. Today the JD comes from two unrelated paths:

1. **Greenhouse + Lever** — fetched via `engine/core/jd_cache.js` (`fetchJd(job, cacheDir)`), persisted to `profiles/<id>/jd_cache/<key>.txt`. Re-runs hit the cache and return identical text.
2. **All other adapters** (`workday`, `smartrecruiters`, `ashby`, `remoteok`, `indeed`, `calcareers`, `usajobs`) — JD is fetched ad-hoc by Claude via `WebFetch` at `prepare` time. No caching, no canonicalisation, and the fetched text is whatever the rendered page returned at that moment.

Two consequences:

- **Non-determinism**: re-running `prepare` for the same `(source, jobId)` pair re-pulls the live page. If the posting was edited (or A/B-tested, or paginated) the resulting fit score and cover-letter differ between runs. There is no way to reproduce a Stage-13-style live smoke after the page mutates.
- **Performance + brittleness**: every `prepare` round-trips a heavyweight `WebFetch`, including for stable APIs (Workday, SmartRecruiters, Ashby) that already expose the same data the discovery adapter is hitting. RemoteOK is even worse — the description is *already in memory* during `discover()` and gets thrown away.

## 2. Current state

- `engine/core/jd_cache.js` exports `cacheKey(job)`, `fetchJd(job, cacheDir, deps)`, `fetchAll(jobs, cacheDir, deps, opts)`, `stripHtml(html)`.
- `JdResult = { key, status: 'cached'|'fetched'|'not_found'|'unsupported'|'error', text?, error? }`.
- The dispatcher only branches on `source === 'greenhouse'` or `source === 'lever'`; everything else returns `status: 'unsupported'`.
- Cache files: `profiles/<id>/jd_cache/<source>_<slug>_<jobId>.txt` — flat directory, plain text, no metadata sidecar.
- I/O is dependency-injected (`fetchFn`, `exists`, `readFile`, `writeFile`, `mkdirp`) so the module is fully unit-testable.
- HTML stripping is shared (`stripHtml`).
- 6 adapters bypass the cache entirely.

## 3. Proposed change

Make `jd_cache.js` the single source of JD text for **all** adapters. Each ATS gets a private fetcher; the public surface stays a thin dispatcher.

### 3.1 Cache key + value

- **Key (unchanged)**: `cacheKey(job)` → `${source}_${slug}_${jobId}`. Backward-compatible with existing entries.
- **Value (extended)**: keep `<key>.txt` as the canonical body. Add an `_index.json` at `profiles/<id>/jd_cache/_index.json` mapping `key → meta`:
  ```json
  {
    "greenhouse_affirm_4523123": {
      "source": "greenhouse",
      "source_method": "api",
      "url": "https://boards.greenhouse.io/affirm/jobs/4523123",
      "url_hash": "sha1:8f1c…",
      "fetched_at": "2026-05-05T18:42:00Z",
      "content_length": 4812,
      "schema": 1
    }
  }
  ```
  - `source_method` ∈ `api | feed | webfetch_scrape` for diagnostics + future TTL policy (e.g. shorten TTL for `webfetch_scrape`).
  - Single `_index.json` (not per-key sidecars) — fewer inodes, atomic-rewrite friendly, cheap to load on `prepare` start.
  - Missing index entry for an existing `.txt` → treat as `source_method: "api"`, `schema: 0` (covers Stage 12 cache files in soak).

### 3.2 Per-adapter strategy

| Adapter         | Method           | Source                                                                   | Notes                                                                                                                                |
| --------------- | ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| greenhouse      | `api`            | `GET boards-api.greenhouse.io/v1/boards/{slug}/jobs/{id}` → `data.content` (HTML) | Existing path. Keep `formatGreenhouse` formatter.                                                                                    |
| lever           | `api`            | `GET api.lever.co/v0/postings/{slug}/{id}` → `descriptionPlain` + `lists[]`        | Existing path. Keep `formatLever` formatter.                                                                                         |
| ashby           | `api` w/ fallback | `POST /api/non-user-graphql?op=ApiJobBoardWithTeams` (board-level, extract by id) | If GraphQL fails or returns no description for the id → fall back to `webfetch_scrape` of `jobUrl` (already on `job.url`). Feature-flag the GraphQL path (`ASHBY_GRAPHQL=on`) — undocumented endpoint, breakage risk. |
| workday         | `api`            | `POST {tenant}.{dc}.myworkdayjobs.com/wday/cxs/{slug}/{site}/jobInfo` body `{}` (or job-detail variant — verify by URL probe) → `jobPostingInfo.jobDescription` | Tenant config (`dc`, `site`) lives on `companies.tsv` `extra_json`; jd_cache reads it from `job.rawExtra` already plumbed by `engine/modules/discovery/workday.js`. See §3.3. |
| smartrecruiters | `api`            | `GET api.smartrecruiters.com/v1/companies/{slug}/postings/{id}` → `jobAd.sections.jobDescription.text` (+ `qualifications.text`, `additionalInformation.text`) | All sections concatenated through `stripHtml` for consistency.                                                                       |
| remoteok        | `feed`           | Description already on the feed item (`description` HTML)                | Discover adapter passes raw HTML through `job.rawExtra.descriptionHtml`. JD cache strips and stores. No network call.                |
| indeed          | `webfetch_scrape` (ingest pass-through) | Browser-ingest staging file already carries `descriptionHtml` (Stage 6 skill writes it); jd_cache strips + caches | If the ingest entry lacks a description, mark `not_found` (caller decides skip-or-prompt).                                            |
| calcareers      | `webfetch_scrape` | `WebFetch(job.url)` → cheerio `<div id="cphMainContent_pnlJobDescription">` (or equivalent) → `stripHtml` | Brittle by design. Cache TTL shortened (§3.4).                                                                                       |
| usajobs         | `api`            | USAJOBS Search REST already returns `UserArea.Details.JobSummary` + duties — pass through during discovery into `rawExtra.descriptionHtml`, JD cache stores it | No second fetch needed. Same shape as remoteok.                                                                                      |

For the three feed/ingest cases (remoteok, indeed, usajobs) the change is two-sided: the discovery adapter starts populating `rawExtra.descriptionHtml`, and `jd_cache.fetchJd` reads it from `job.rawExtra` instead of fetching.

### 3.3 Module shape

Public API stays minimal, internal fetchers move to a sibling directory once we have more than two:

```
engine/core/jd_cache.js                  (dispatcher, public exports)
engine/core/jd_fetchers/
  greenhouse.js
  lever.js
  ashby.js
  workday.js
  smartrecruiters.js
  remoteok.js     (pass-through from rawExtra)
  indeed.js       (pass-through from rawExtra)
  calcareers.js   (webfetch + cheerio)
  usajobs.js      (pass-through from rawExtra)
```

Public surface:

```js
// engine/core/jd_cache.js
module.exports = {
  cacheKey,           // (job) -> string                  unchanged
  fetchJd,            // (job, cacheDir, deps?) -> JdResult
  fetchAll,           // (jobs, cacheDir, deps?, opts?) -> JdResult[]
  getCachedJd,        // (job, cacheDir, deps?) -> {text, meta} | null
  clearCache,         // ({cacheDir, source?, olderThanDays?}) -> {removed: number}
  stripHtml,          // unchanged
};

// JdResult (extended)
// { key, status: 'cached'|'fetched'|'not_found'|'unsupported'|'error',
//   text?, meta?, error? }
```

Dispatcher signature (new):

```js
async function fetchJd(job, cacheDir, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const key = cacheKey(job);
  const cachePath = path.join(cacheDir, key);

  const cached = await readFromCache(cachePath, key, cacheDir, d);
  if (cached && !isStale(cached.meta, job.source)) {
    return { key, status: "cached", text: cached.text, meta: cached.meta };
  }

  const fetcher = FETCHERS[job.source];
  if (!fetcher) return { key, status: "unsupported" };

  let result;
  try {
    result = await fetcher(job, d);  // {text, source_method} | {text:null, error}
  } catch (err) {
    return { key, status: "error", error: err.message };
  }
  if (!result || !result.text) {
    return { key, status: "not_found", error: result && result.error };
  }

  const meta = {
    source: job.source,
    source_method: result.source_method,
    url: job.url || null,
    url_hash: sha1(job.url || ""),
    fetched_at: new Date().toISOString(),
    content_length: result.text.length,
    schema: 1,
  };
  await writeToCache(cachePath, cacheDir, key, result.text, meta, d);
  return { key, status: "fetched", text: result.text, meta };
}
```

One platform fetcher (Workday) — note tenant metadata read from `job.rawExtra`:

```js
// engine/core/jd_fetchers/workday.js
const { stripHtml } = require("../jd_cache_strip.js");

async function fetchWorkday(job, deps) {
  const tenant = job.slug;
  const dc = (job.rawExtra && job.rawExtra.dc) || "wd1";
  const site = (job.rawExtra && job.rawExtra.site) || "jobs";
  // externalPath, e.g. "/job/Sacramento/Patient-Access-Rep_R-12345"
  const externalPath = job.jobId.startsWith("/") ? job.jobId : `/${job.jobId}`;
  const url =
    `https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${tenant}/${site}` +
    `/job${externalPath}`;
  const res = await deps.fetchFn(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    timeoutMs: 15000,
    retries: 1,
  });
  if (!res.ok) return { text: null, error: `HTTP ${res.status}` };
  const data = await res.json();
  const html =
    (data.jobPostingInfo && data.jobPostingInfo.jobDescription) ||
    data.jobDescription ||
    "";
  if (!html) return { text: null, error: "no description in payload" };
  const title = (data.jobPostingInfo && data.jobPostingInfo.title) || job.title;
  const location = (data.jobPostingInfo && data.jobPostingInfo.location) || "";
  const text = [
    `TITLE: ${title}`,
    location ? `LOCATION: ${location}` : null,
    "",
    stripHtml(html),
  ].filter((x) => x !== null).join("\n").trim();
  return { text, source_method: "api" };
}

module.exports = fetchWorkday;
```

### 3.4 Cache invalidation

- **Default TTL**: 14 days from `fetched_at`. Past TTL → re-fetch on next request, otherwise serve cache.
- **Per-method override**: `webfetch_scrape` entries (calcareers) — TTL 5 days, since the page is the only ground truth and it can change silently.
- **No proactive revalidation**: TTL is checked on read only. We never wake up to refresh.
- **Manual purge**: new CLI command
  ```
  node engine/cli.js jd-cache-clear --profile <id> [--source <name>] [--older-than-days N]
  ```
  Implemented via `clearCache({cacheDir, source, olderThanDays})`. Removes matching `.txt` files + index entries, prints count.

### 3.5 Error handling

Each platform fetcher catches its own exceptions and returns `{text: null, error}`. The dispatcher promotes errors to `status: 'error'` (network / parse) or `status: 'not_found'` (clean miss — no description in payload). No exception bubbles to the caller. `prepare.js` already handles all four statuses; behaviour is unchanged.

### 3.6 Backward compat

- Existing `<key>.txt` files keep working — when `_index.json` has no entry for them, treat as `{source_method: "api", schema: 0}`. They will be re-validated against TTL on next access (effectively a one-time refresh, not a wipe).
- `JdResult` shape adds `meta` but never removes a field; older callers that ignore `meta` keep working.
- No changes to `cacheKey()`. No path migration. Pure additive change.

### 3.7 Migration plan

1. Land jd_cache changes + dispatcher behind feature flag `JD_CACHE_UNIFIED=on` (default off).
2. Discovery adapters that newly populate `rawExtra.descriptionHtml` (remoteok, indeed, usajobs) ship in the same PR — pure additive on the discover side.
3. `prepare.js` switches to `fetchJd` for all adapters when the flag is on. Old WebFetch path stays as the unflagged code path.
4. Smoke test against Jared (Greenhouse + Lever + Workday) and Lilia (Workday + Indeed + RemoteOK). One job per source, prepare twice, diff.
5. Flip flag default to `on`. Old WebFetch path stays as `JD_CACHE_UNIFIED=off` fallback for one cycle, then deletes in the next stage.

## 4. Testing

- **Unit (`node --test`, mocked fetch)** — one test file per fetcher under `engine/core/jd_fetchers/__tests__/`. Patterns already used by `_ats.js` tests: stub `fetchFn`, assert request URL/body shape and parsed output. Coverage targets:
  - Happy path: known payload → expected text body.
  - HTTP non-2xx → `{text: null, error}`.
  - Empty/missing description field → `{text: null, error: "no description in payload"}`.
  - Ashby specifically: GraphQL-fail → fallback path invoked; assert `source_method === "webfetch_scrape"` on success.
- **Dispatcher tests**: cache hit, cache stale (TTL), cache miss-then-fetch, unsupported source, index sidecar read/write, missing index entry treated as schema 0.
- **Integration (existing `tests/integration/`)**: scan a known job from each live source (skipped in CI without secrets), prepare twice, assert byte-identical JD text and `_index.json` entry present.
- **No live API in CI** — everything mocked. Live pass is a manual smoke step in the migration plan.

## 5. Open questions

1. **Workday tenant config plumbing.** `companies.tsv` already stores `dc`/`site` in `extra_json`, and the discovery adapter pushes them into `target` at scan time. Question: should `jd_cache.js` re-read `companies.tsv` for `dc`/`site`, or rely on the discover adapter to stuff them into `job.rawExtra`? **Proposal**: stuff into `rawExtra` at discover time. jd_cache stays I/O-pure (no TSV reads). Requires a 2-line change to `engine/modules/discovery/workday.js` to copy `dc`/`site` into `rawExtra`.
2. **Ashby GraphQL stability.** The `ApiJobBoardWithTeams` op is undocumented and used by Ashby's hosted-board frontend. Risk: schema change without notice. **Proposal**: feature-flag with WebFetch fallback and log a warning when the fallback fires; if warning rate exceeds 10% over 7 days, demote GraphQL to disabled-by-default and treat WebFetch as primary.
3. **CalCareers scraping legality.** Already used by the discovery adapter; caching the rendered description doesn't add new legal exposure but does extend what we store. **Proposal**: keep it, document in `BACKLOG.md` under "scraping risk" with the same disposition as the existing CalCareers adapter.
4. **Index sidecar concurrency.** Two parallel `prepare` runs against the same profile would race on `_index.json`. **Proposal**: optimistic write — read, mutate, write atomically (`writeFile(tmp)` + `rename`); last writer wins. Worst case is one missing meta entry, which is harmless (treated as schema 0 on next read).
5. **TTL units.** 14d / 5d are first guesses. **Proposal**: ship as constants in `jd_cache.js`, revisit after 30 days based on observed re-fetch rate.

## 6. Out of scope

- New job sources beyond the existing 8 adapters.
- Storing structured metadata (salary, location) in the cache — that lives on the job row and Notion DB, not in the JD cache.
- Re-using JD text for embeddings / vector store — separate concern, separate RFC.
- Pruning the cache automatically on profile delete — manual `clearCache` is sufficient for current scale.

## 7. Approval

Tier M → RFC required, code review on diff, smoke test before merge, no `/security-review` (no auth or PII surface change). Awaiting user approve before implementation.
