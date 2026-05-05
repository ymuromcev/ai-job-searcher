---
id: RFC-011
title: Keyword-Search Discovery Adapter
status: draft
tier: M
created: 2026-05-05
tags: [discovery, ats, keyword-search]
---

# RFC 011 — Keyword-Search Discovery Adapter

**Status**: Draft
**Tier**: M (new discovery module, 2+ files, integrates with existing scan pipeline)
**Author**: Claude + Jared Moore

## Problem

The current scan is **company-first**: for each target company in `data/companies.tsv`, we
call the company's ATS endpoint and collect ALL open positions. Then the prepare phase
filters for PM roles by title.

Results are poor:
- 1 556 positions scanned in the last run → 9 PM roles (0.6% signal rate)
- 7 of those 9 were LinkedIn with URLs that expired before prepare ran
- Net usable batch: **2 jobs**

The prototype worked differently: it searched job boards directly with PM keywords and
consistently produced 30+ PM-specific results per run. The company-first approach
will never match that because ATS boards are 90%+ engineering, and we have no control
over when LinkedIn URLs die.

## Goal

Add a `discovery:adzuna` adapter (keyword-search mode) that queries job board aggregator
APIs with PM-specific terms and delivers **30+ live PM/Senior PM listings per scan**
regardless of company. Fit scoring in the prepare phase handles quality.

## Decision

**Adzuna API** (primary) + optional **The Muse API** (secondary) as free, JSON-native,
no-browser-automation keyword-search sources.

Why Adzuna:
- Free tier: 250 searches/month, 50 results per page; enough for daily scan.
- Official JSON API with stable endpoints (not HTML scrape).
- Covers US job boards including Greenhouse, Lever, LinkedIn, Workday postings.
- Reliable dedup key: Adzuna assigns its own `id` per listing.
- Supports `location_type=everywhere` for national results, or specific metro areas.

Why not LinkedIn/Indeed direct: no public API, bot detection, ephemeral URLs.
Why not paid-only (ZipRecruiter, SerpAPI): free options cover the needed volume.

## Configuration

In `profiles/<id>/profile.json`, under `discovery`:

```json
{
  "discovery": {
    "keyword_search": {
      "enabled": true,
      "sources": ["adzuna"],
      "keywords": [
        "Product Manager",
        "Senior Product Manager"
      ],
      "location": "United States",
      "results_per_keyword": 50,
      "max_age_days": 30
    }
  }
}
```

Env vars per profile (same `.env` namespacing pattern):

```
JARED_ADZUNA_APP_ID=...
JARED_ADZUNA_API_KEY=...
```

Adzuna free account: https://developer.adzuna.com/ — takes 2 minutes, no credit card.

## Adapter: `engine/modules/discovery/adzuna.js`

Source id: `adzuna` (stored in `jobs.tsv` and `applications.tsv`).

**Fetch flow:**

```
for each keyword in discovery.keyword_search.keywords:
  GET https://api.adzuna.com/v1/api/jobs/us/search/1
      ?app_id=<ADZUNA_APP_ID>
      &app_key=<ADZUNA_API_KEY>
      &what=<keyword, URL-encoded>
      &where=<location, URL-encoded>
      &max_days=<max_age_days>
      &results_per_page=<results_per_keyword>
      &content-type=application/json
```

**Normalise each Adzuna listing → standard job object:**

```js
{
  source:      "adzuna",
  jobId:       String(listing.id),          // Adzuna-assigned numeric id
  companyName: listing.company.display_name,
  title:       listing.title,
  location:    listing.location.display_name,
  url:         listing.redirect_url,        // Adzuna redirect → real ATS URL
  postedAt:    listing.created,             // ISO string
}
```

**Dedup key:** `adzuna:<listing.id>` — same format as all other adapters.

The adapter produces an array of normalized job objects. The existing scan orchestrator
(`engine/core/scan.js`) picks it up automatically via the adapter auto-registry
(`engine/modules/discovery/index.js`), same as greenhouse/lever/ashby.

**Jd text**: Adzuna's `description` field contains the JD (may be truncated to 500–1000
chars). Store it in `jdText` if available so prepare phase can do geo + fit scoring
without an extra HTTP call.

## Impact on existing pipeline

| Step | Change |
|---|---|
| `scan` | New source `adzuna` appears in results. Dedup by `(source, jobId)` prevents re-adding same listing. |
| `prepare --phase pre` | Adzuna jobs flow through existing `applyPrepareFilter` (title_requirelist + title_blocklist + company_cap). Filter removes non-PM and over/under-level listings. |
| `prepare SKILL` | Same geo + fit + CL generation. Company relation resolved or created in Notion Companies DB. |
| `validate` | URL liveness on Adzuna redirect URLs. Adzuna redirects to actual ATS — if the original posting died, Adzuna's redirect returns 404/410. |
| `sync` | No change. |
| `applications.tsv` | New rows with `source=adzuna`. |

**Company blocklist**: applied as usual in `applyPrepareFilter`. Adzuna results are not
restricted to `companies.tsv` — that's the whole point. The blocklist still removes
explicitly unwanted companies (Toast, Gusto, etc.).

**Company cap**: applied as usual. If "Stripe" already has 3 active apps, extra Adzuna
Stripe listings are skipped until a slot opens.

## Volume estimate

- 2 keywords × 50 results = 100 raw results per scan.
- title_requirelist pass rate ≈ 80% (keywords already targeted at PM, so signal is high).
- title_blocklist removes over/under-level ≈ 15%.
- Dedup removes repeats from prior scans ≈ 20–30%.
- **Expected net new per scan: 30–60 PM/SPM listings.**

## Out of scope

- The Muse API: nice-to-have secondary source, add in a follow-up PR if Adzuna volume
  is insufficient.
- Caching JD text from the real ATS URL behind the Adzuna redirect: not needed for
  Phase 1 since Adzuna's `description` field is enough for fit scoring.
- LinkedIn/Indeed scraping: explicitly out of scope; fragile and violates ToS.

## Implementation checklist

- [ ] Get Adzuna API credentials, add to `.env` as `JARED_ADZUNA_APP_ID` / `JARED_ADZUNA_API_KEY`
- [ ] `engine/modules/discovery/adzuna.js` — fetch + normalise
- [ ] `engine/modules/discovery/adzuna.test.js` — unit tests with mock fetch
- [ ] `engine/modules/discovery/index.js` — register `adzuna` adapter
- [ ] `profiles/jared/profile.json` — add `discovery.keyword_search` block
- [ ] `profiles/_example/profile.example.json` — add same block as template
- [ ] Smoke test: `node engine/cli.js scan --profile jared --dry-run` → see Adzuna results
- [ ] Push to main, run full `npm test`
