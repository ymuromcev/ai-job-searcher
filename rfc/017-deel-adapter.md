---
id: RFC-017
title: Deel job-board adapter
status: draft
tier: M
created: 2026-05-05
tags: [discovery, ats, deel]
---

# RFC 017 — Deel job-board adapter

- **Status:** Proposed
- **Author:** ymuromcev / Claude
- **Date:** 2026-05-05
- **Tier:** M (new adapter, profile-config schema unchanged, no migration of historical data)
- **Depends on:** RFC 016 (JD-cache integration — non-blocking; can land in either order)
- **Supersedes:** none

## 1. Problem

`data/companies.tsv` has Klarna at line 78 wired to Lever (`Klarna\tlever\tklarna\t\tjared`). Klarna migrated their public board to Deel (`https://jobs.deel.com/job-boards/klarna`) and the Lever endpoint `https://api.lever.co/v0/postings/klarna?mode=json` now returns 0 postings. Klarna is silently absent from `scan` output for `--profile jared`.

Deel hosts boards for many clients (Deel itself is an HRIS / employer-of-record platform). Today we lose Klarna; tomorrow this will hit other companies in the pool as employers churn off Lever / Greenhouse onto Deel. The fix is a Deel adapter, not a one-off Klarna patch.

## 2. Recon (TODO — WebFetch was denied this session)

The recon needed to make this an executable RFC could not be performed in this session — `WebFetch` was denied. The user (or a follow-up Claude session with permission) needs to run the four probes below before the design can be confirmed. Section 4 below is written against the **most likely** outcome (Next.js with `__NEXT_DATA__`); the **fallback** in Section 8 covers the other plausible outcome (JS-only render). The RFC stays Proposed until recon results are pasted in.

Probes to run:

1. `GET https://jobs.deel.com/job-boards/klarna` — inspect raw HTML.
   - Are job titles + locations visible directly in the response body? (→ scrapeable HTML)
   - Is there a `<script id="__NEXT_DATA__" type="application/json">…</script>` block? Capture its top-level keys (`props.pageProps.jobs` is the conventional Next.js shape).
   - What `set-cookie` headers and any `cf-ray` (Cloudflare) headers are present?
2. `GET https://jobs.deel.com/robots.txt` — capture verbatim. Confirm whether `/job-boards/` and `/api/` are disallowed, and grab any sitemap URL.
3. JSON-API probes (likely 200 or 404 — log both):
   - `https://jobs.deel.com/api/job-boards/klarna`
   - `https://jobs.deel.com/api/job-boards/klarna/jobs`
   - `https://jobs.deel.com/api/v1/job-boards/klarna/jobs`
   - Also inspect Network tab in a real browser session — Next.js apps often hit `/_next/data/<buildId>/job-boards/[slug].json` for client-side navigation, which is the cleanest API to consume if available.
4. ToS / footer link on `jobs.deel.com` — copy the relevant clause about automated access. Hosted recruitment-marketing boards are conventionally fair game (industry norm for GH/Lever/Ashby), but Deel is an HR platform and may have stricter language.

**Recon results placeholder — paste here before approve:**

> _(empty — needs probes 1–4)_

## 3. Goals / non-goals

**Goals**
- Generic adapter that consumes any `https://jobs.deel.com/job-boards/<slug>` board, not Klarna-specific.
- Drop into existing scan pipeline with a one-line edit to `data/companies.tsv` (`ats_source: lever` → `deel`).
- Match the canonical `Job` schema (see `engine/modules/discovery/_types.js` — `assertJob`) so dedupe, fit, and Notion sync work unchanged.
- Single failure-mode per target (HTML structure changes) with a clear validate-time signal.

**Non-goals**
- Not migrating other companies off Lever in this RFC. They stay where they are; we only flip Klarna and document the recipe.
- Not building a generic Next.js scraper. The adapter is Deel-specific and tolerates only Deel's `__NEXT_DATA__` shape.
- No login flow, no Deel HRIS API, no per-company auth — public boards only.

## 4. Proposed adapter (HTML / `__NEXT_DATA__` path)

File: `engine/modules/discovery/deel.js`. Mirrors the contract used by `greenhouse.js` and `lever.js`:

```js
const { fetchJson, runTargets, makeCtx } = require("./_ats.js");
const { assertJob } = require("./_types.js");
const { sanitizeText, parseIsoDate, dedupeLocations } = require("./_normalize.js");
const { defaultFetch } = require("./_http.js");

const SOURCE = "deel";
const BOARD_BASE = "https://jobs.deel.com/job-boards";

async function fetchBoardJobs(fetchFn, slug, signal) {
  const url = `${BOARD_BASE}/${encodeURIComponent(slug)}`;
  const res = await fetchFn(url, {
    signal,
    headers: { "user-agent": "Mozilla/5.0 (compatible; ai-job-searcher/1.0)" },
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  const html = await res.text();
  return extractJobs(html, slug);
}

function extractJobs(html, slug) {
  const m = html.match(
    /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!m) throw new Error(`__NEXT_DATA__ not found for ${slug} (HTML structure changed?)`);
  const data = JSON.parse(m[1]);
  // Path TBD by recon — placeholder; common Next.js conventions:
  //   data.props.pageProps.jobs
  //   data.props.pageProps.board.jobs
  //   data.props.pageProps.initialState.jobs
  const jobs =
    (data.props && data.props.pageProps && data.props.pageProps.jobs) ||
    (data.props && data.props.pageProps && data.props.pageProps.board && data.props.pageProps.board.jobs) ||
    [];
  if (!Array.isArray(jobs)) throw new Error(`unexpected __NEXT_DATA__ shape for ${slug}`);
  return jobs;
}

function mapJob(target, raw) {
  // Field names below are placeholders — confirm with recon (probe 1).
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId: String(raw.id ?? raw.slug ?? raw.uuid),
    title: sanitizeText(raw.title || raw.name),
    url: String(raw.url || raw.applyUrl ||
      `${BOARD_BASE}/${target.slug}/jobs/${raw.id || raw.slug}`),
    locations: dedupeLocations(
      Array.isArray(raw.locations) ? raw.locations.map((l) => l.name || l) : [raw.location]
    ),
    team: sanitizeText(raw.department || raw.team) || null,
    postedAt: parseIsoDate(raw.publishedAt || raw.createdAt || raw.updatedAt),
    rawExtra: { deelRaw: raw },
  };
  assertJob(job);
  return job;
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  return runTargets(targets, c, async (target) => {
    if (!target || !target.slug) return [];
    const raws = await fetchBoardJobs(c.fetchFn, target.slug, c.signal);
    return raws.map((r) => mapJob(target, r)).filter(Boolean);
  });
}

module.exports = { source: SOURCE, discover };
```

Auto-registry pattern in `engine/modules/discovery/index.js` (or wherever scan walks adapters) picks the file up by filename — same as every other adapter.

## 5. Companies.tsv migration

Single-row edit. Old line 78:

```
Klarna	lever	klarna		jared
```

New:

```
Klarna	deel	klarna		jared
```

No backfill needed — `applications.tsv` rows for Klarna positions stay valid; only the discovery `source` field on future scan output changes from `lever` to `deel`. Existing dedup keys (`(companyName, title, locations)`) are source-agnostic.

Document the recipe in `BACKLOG.md` / `incidents.md` so when the next company churns from Lever/GH onto Deel we know: confirm `jobs.deel.com/job-boards/<slug>` resolves → flip the row.

## 6. JD-cache integration (RFC 016)

When RFC 016 lands (JD-cache for non-Greenhouse/Lever sources), the Deel adapter slots in cleanly: each job's `url` points at a Deel-hosted JD page (Next.js page, server-rendered description in the same `__NEXT_DATA__` blob — confirm with recon). Cache key: `deel:<slug>:<jobId>`. Fetch logic: same `__NEXT_DATA__` extraction, different field path (`pageProps.job.description` or similar). If RFC 016 lands first, this RFC adds `cacheJD()` call inside `mapJob`. If this lands first, RFC 016 adds the Deel branch to its source dispatch table. No coupling required for the initial scan-only ship.

## 7. Failure modes

1. **Deel changes HTML structure** — `__NEXT_DATA__` removed, renamed, or shape changes. Adapter throws per-target; `runTargets` logs warn and continues. **Detection:** Klarna count drops to 0. Add a check in `engine/commands/validate.js` step 5 (new): for any company with `historical_count > 5` whose last 3 scans all returned 0, emit a warning. Cheap, prototype-tested signal.
2. **Cloudflare / 403 on bare UA** — Deel may bot-block. Mitigation: realistic UA in the request (already in stub above), single-target concurrency = 4 max (already enforced by `_ats.js`). If 403s persist → switch to browser-ingest fallback (Section 8).
3. **Rate limit (HTTP 429)** — `runTargets` already error-contains. Add adapter-side retry with backoff if and only if recon shows it's needed. Default: rely on the existing concurrency cap.
4. **Per-job URL drift** — derived URL (`/job-boards/<slug>/jobs/<jobId>`) doesn't match Deel's actual route. Mitigation: prefer `raw.url` / `raw.applyUrl` if present in `__NEXT_DATA__`. Recon must confirm.

## 8. Browser-ingest fallback (if SSR data is unreachable)

If recon shows the page is JS-hydrated with no `__NEXT_DATA__` and no JSON API, fall back to the Indeed pattern:

- User opens `https://jobs.deel.com/job-boards/klarna` in Claude MCP browser.
- Skill step calls `read_page` (or a small extractor JS pasted into `javascript_tool`) to dump the rendered job list.
- JSON written to `profiles/<id>/.deel-state/raw_<slug>.json` with shape:
  ```json
  [{"jobId": "abc-123", "title": "…", "location": "…", "url": "…", "postedAt": "2026-05-01"}]
  ```
- Adapter target shape gains `ingestFile`:
  ```
  Klarna	deel	klarna	{"ingestFile":"profiles/jared/.deel-state/raw_klarna.json"}	jared
  ```
- Adapter prefers `ingestFile` if present, else hits the live URL. Mirrors `engine/modules/discovery/indeed.js` exactly.
- Document the manual step in `skills/job-pipeline/SKILL.md` under "Discovery — Deel".
- **Cost:** every scan needs a manual browser session. Acceptable as a fallback (Indeed precedent), not as the steady state.

## 9. Testing

- **Unit:** `test/discovery/deel.test.js` with a fixture HTML file (`test/fixtures/deel/klarna.html`) — a snapshot of the real Deel page captured during recon. Cases: happy path (N jobs parsed), malformed `__NEXT_DATA__` (throws), missing `__NEXT_DATA__` (throws), empty `jobs` array (returns `[]`).
- **Snapshot test:** `mapJob` against a small `raws` fixture, asserts the canonical `Job` shape. Same pattern as existing `greenhouse.test.js` if present.
- **Integration:** optional, gated by `RUN_NETWORK_TESTS=1` env var. Hits the real endpoint, asserts Klarna returns ≥ 1 job. Skipped in CI by default.
- **Fallback path:** unit test reading a fixture `raw_<slug>.json`, mirroring `indeed.test.js`.

## 10. Open questions

1. **Generic vs Klarna-only.** Working assumption: generic. If recon shows board-specific layouts (rare for Next.js apps), we revisit.
2. **`__NEXT_DATA__` field path.** Filled by recon. Three plausible shapes listed in the stub; pick one.
3. **Per-job URL.** Does `__NEXT_DATA__` carry full URLs, or does the adapter need to construct them? Recon to confirm.
4. **Cloudflare bot-blocking.** Will `node-fetch` with a realistic UA work, or do we need a real browser? Cheap probe: the recon `curl` itself answers this.
5. **ToS.** Public hosted recruitment boards are conventionally treated as scrapeable (industry norm for Greenhouse/Lever/Ashby). Deel's specific Terms may differ — needs a one-line read before merge.
6. **Schedule.** RFC 016 (JD cache) and this RFC are independent; either order is fine. If both land in the same week, prefer this one first (immediate value: Klarna comes back online for `jared`).

## 11. Approval gate

Tier M → RFC + approve → code + tests + code-reviewer subagent → smoke against real Klarna board → commit. Per `DEVELOPMENT.md`, no code is written until:
- recon section is filled in with real data, AND
- user explicitly approves the chosen path (HTML / JSON-API / browser-fallback).

## 12. Rollback

Revert the `companies.tsv` row (one-line `git revert` of that hunk) and remove `engine/modules/discovery/deel.js`. Klarna goes back to 0 results from Lever, but no other profile / company is affected. Zero-risk change.
