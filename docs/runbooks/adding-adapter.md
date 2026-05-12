# Add a new ATS discovery adapter

Add a new adapter so `engine/cli.js scan` can discover postings from an
ATS that the engine does not yet cover. Adapters live under
`engine/modules/discovery/` and register themselves automatically.

## 1. When to add an adapter

Add a new adapter when at least three target companies on a deployed
profile post jobs through the same uncovered ATS. Below that bar, the
incremental coverage rarely justifies the maintenance surface; one-off
companies are better handled through manual research or the Indeed
prepare flow.

For `Healthcare-Hannah`, the regional clinic pool motivates work on
Workday tenants and Indeed fallback. For `PM-Pete`, Greenhouse, Lever,
and Ashby cover the bulk of tier-S and tier-A targets.

## 2. Adapter contract

Every adapter is a CommonJS module under
`engine/modules/discovery/<name>.js` that exports two members:

```js
module.exports = {
  source: "myats",          // unique lowercase id, no spaces
  async discover(targets, ctx) {
    return [/* normalized job records */];
  },
};
```

Files starting with `_` (`_ats.js`, `_http.js`, `_normalize.js`,
`_types.js`) are shared helpers, not adapters. `*.test.js` are tests,
not adapters. The auto-registry in `engine/modules/discovery/index.js`
loads everything else.

`targets` is an array of `{ slug, name, ... }` objects from the
profile's company tier list. `ctx` carries `fetchFn`, `signal`, and
other shared state. Returns an array of normalized jobs validated by
`assertJob` from `_types.js`.

## 3. Scaffold from an existing adapter

`engine/modules/discovery/lever.js` is the smallest reference (about
forty-five lines). Copy it and edit:

```bash
cp engine/modules/discovery/lever.js engine/modules/discovery/myats.js
cp engine/modules/discovery/lever.test.js engine/modules/discovery/myats.test.js
```

Update `SOURCE`, `BASE`, the response-shape parsing in `mapJob`, and
the URL builder inside `discover`. The auto-registry asserts unique
`source` strings; pick something the codebase does not already use.

## 4. Use the shared HTTP and JD helpers

Never hand-roll HTTP. The shared infrastructure handles SSRF guards,
HEAD-then-GET probing, retries, and JD caching:

- `engine/core/url_check.js` — URL liveness, board-root detection,
  SSRF defense.
- `engine/core/jd_cache.js` — fetch a Greenhouse/Lever/Workday/iCIMS/Taleo
  job description, store under `data/jd_cache/`, reuse on the next
  run.
- `engine/modules/discovery/_ats.js` — `fetchJson`, `runTargets`,
  `makeCtx` wrappers used by every adapter.

If your ATS exposes a JSON listing endpoint, use `fetchJson`. If it
needs HTML scraping, route through `url_check` first to confirm the
board exists, then parse with a focused selector — do not pull the
whole page through the adapter.

## 5. Map records to canonical fields

`assertJob` in `_types.js` rejects anything missing the canonical
fields. Normalize inside the adapter; downstream stages assume clean
input.

| Field         | Notes                                                  |
| ------------- | ------------------------------------------------------ |
| `source`      | Hard-coded to your `SOURCE` constant.                  |
| `slug`        | Per-target company slug from `targets[i].slug`.        |
| `companyName` | From `targets[i].name`, not the ATS payload.           |
| `jobId`       | Stable per-posting id from the ATS.                    |
| `title`       | Run through `sanitizeText`.                            |
| `url`         | Public posting URL.                                    |
| `locations`   | Run through `dedupeLocations`.                         |
| `team`        | Optional, sanitized.                                   |
| `postedAt`    | Run through `parseIsoDate`.                            |
| `rawExtra`    | Any ATS-specific extras you want preserved on disk.    |

Blocklists, cap-by-company, and dedup run downstream — do not
reimplement them inside the adapter.

## 6. Per-profile config

Adapters read configuration from `profile.discovery.<source>` in
`profiles/<id>/profile.json`. Add the minimum needed (rate limit,
optional credential keys) and document defaults in the adapter
header. Secrets resolve via `profile_loader.loadSecrets` from the
namespaced root `.env` (`<PROFILE_ID_UPPER>_<ADAPTER>_API_KEY`).

## 7. Tests

Add a unit test under `engine/modules/discovery/<name>.test.js` that
mocks the network. Existing tests use `node --test`'s built-in
runner; pattern after `lever.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { discover } = require("./myats.js");

test("myats: maps a posting to a normalized job", async () => {
  const fakeFetch = async () => ({ json: async () => SAMPLE_PAYLOAD });
  const jobs = await discover([{ slug: "acme", name: "Acme" }], {
    fetchFn: fakeFetch,
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].source, "myats");
});
```

Cover at minimum: happy path, empty list, malformed payload, network
error.

## 8. Wire into scan

There is nothing to wire. The auto-registry in
`engine/modules/discovery/index.js` reads every non-underscore,
non-test `.js` file at startup. As long as the file is in
`engine/modules/discovery/`, exports `source` plus `discover`, and
passes the shape assertion, `scan` picks it up.

## 9. Add a row in the Notion Job Platforms DB

Stage 16 provisions a Job Platforms DB per profile. Add a row for the
new adapter so the profile's hub reflects coverage. Use the workspace
page id stored in `profile.json.notion.workspace_page_id`; the row
schema lives in `scripts/stage18/seed_job_platforms.js` (Jared-titled,
parametrize as needed).

## See also

- [Architecture overview](../architecture/overview.md)
- [CLI reference](../reference/cli.md)
- [RFC 010 — Workday activation](../../rfc/010-lilia-workday-activation.md)
- [RFC 011 — keyword-search adapter](../../rfc/011-keyword-search-adapter.md)
