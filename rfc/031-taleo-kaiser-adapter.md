# RFC 031 — Taleo / Kaiser Permanente adapter + JD fetcher

- **Status:** Accepted (2026-05-12)
- **Author:** @jared
- **Created:** 2026-05-12
- **Refs:** BL-7 (#7.x — Kaiser/Taleo activation), BL-8 (#8.3 — Taleo deferred),
  RFC 025 (iCIMS adapter, talentbrew mode), RFC 030 (Workday + iCIMS JD
  fetchers), `engine/modules/discovery/icims.js`, `engine/core/jd_cache.js`,
  `profiles/lilia/profile.json`.

## 1. Problem

Lilia's whitelist contains **Kaiser Permanente** as the only Tier S
employer in Sacramento metro that is currently not in `data/companies.tsv`.
Kaiser posts admin / patient-access / scheduler / front-desk / authorization
roles regularly (56 open Sacramento positions at recon time), all behind
its Taleo-backed careers site `www.kaiserpermanentejobs.org`. None of the
existing adapters (greenhouse / lever / ashby / smartrecruiters / workday /
icims / oracle_cloud / jobsyn / indeed / remoteok) reach this hostname,
so Kaiser is effectively missing from Lilia's discovery surface.

Layered constraint per memory `feedback_notion_fields_must_fill.md`: a new
adapter must ship with its JD fetcher so that `Schedule` / `Requirements`
Notion fields are populated end-to-end. Adapter alone (without
`jd_cache.fetchJd("taleo", …)`) would replay the bug fixed in RFC 030.

## 2. Goal

Add a `discovery:taleo` adapter that pulls Kaiser Sacramento jobs into the
shared pool and per-profile Inbox, **plus** a `taleo` branch in
`engine/core/jd_cache.js#fetchJd` so `prepare --phase pre` populates
`jdText` for taleo entries and `extractSchedule` / `extractRequirements`
surface real values on commit.

## 3. Non-goals

- Other Taleo tenants beyond Kaiser. The adapter is generic by design
  (it reads tenant config from `data/companies.tsv` row meta), but only
  one row is added in this RFC. New Kaiser-class targets later cost
  one TSV row and zero code.
- Re-implementing Taleo's authenticated `kp.taleo.net/careersection/...`
  API. We use only the public TalentBrew-rendered listing + JD pages
  (`www.kaiserpermanentejobs.org/...`).
- Posted-date backfill / historical scraping. Forward only.
- LLM extraction of Schedule. Regex-based, same as RFC 030.

## 4. Design

### 4.1 Recon summary (locked 2026-05-12)

Kaiser uses **Taleo via TalentBrew** (Radancy/TalentBrew CMS on top of
Oracle Taleo, similar to how CommonSpirit layers TalentBrew over iCIMS).
Public surface is `www.kaiserpermanentejobs.org`, statically rendered.

**Listing page**:

```
GET https://www.kaiserpermanentejobs.org/search-jobs/{location-encoded}?p={pageIdx1based}
```

- `<section id="search-results-list">` wraps the result list.
- Each posting is an `<li><a href="/job/{city}/{title-slug}/641/{jobId}">
  <h3>{title}</h3><p>{location}, {workSetting}, {schedule}, {shift}</p></a></li>`.
- `641` = Kaiser's TalentBrew company id (constant per tenant).
- `{jobId}` is the trailing numeric segment of the URL (TalentBrew feed
  id, stable per posting, ~11 digits).
- Pagination via `?p=N` (1-based). Sacramento search returns ~11 pages
  at 14 results/page = ~150 entries (steady-state ~50–80 after location
  prune, since "Sacramento, CA" in Kaiser's search matches metro-wide).

**JD page** (`/job/{...}/641/{jobId}`):

- `<div class="ats-description">` wraps the body — **same TalentBrew
  container regex we already have for CommonSpirit iCIMS in
  `formatIcims` (`TALENTBREW_DESC_RE`)**.
- `<script type="application/ld+json">` carries full schema.org
  `JobPosting`: `identifier` (Taleo internal id), `datePosted` (e.g.
  `"2026-5-8"`), `description` (HTML), `qualifications` (HTML, separate
  from description), `employmentType`. Notable: `employmentType` is
  often the useless `"Standard"`; **the real Schedule lives in the
  listing tile's `<p>` text** (Full-time / Part-time / Per Diem / etc.).
- Meta `<meta name="search-job-apply-url" content="https://kp.taleo.net/
  careersection/external/jobapply.ftl?job={taleoJobId}&src=JB-10088">`
  confirms Taleo backend.

### 4.2 Discovery adapter (`engine/modules/discovery/taleo.js`)

**Adapter contract**:

```js
module.exports = { source: "taleo", discover };
```

Per-target TSV row meta:

```json
{
  "siteUrl": "https://www.kaiserpermanentejobs.org",
  "companyId": "641",
  "searchLocations": ["Sacramento, CA"],
  "locationAllow": ["Sacramento","Roseville","Rocklin", …]
}
```

- `siteUrl` — host root, used for SSRF allow-list + relative href join.
- `companyId` — TalentBrew tenant id (Kaiser=641). Required for path
  validation (we reject hrefs whose path does not contain `/{companyId}/`).
- `searchLocations` — array of location strings to iterate as separate
  search queries. For Kaiser/Sacramento metro this is `["Sacramento, CA"]`;
  Kaiser's own search expands to all NorCal results, which `locationAllow`
  then prunes to the 18 allowed cities.
- `locationAllow` — same convention as workday/icims (post-fetch geo
  filter, case-insensitive substring).

**Flow** (mirrors icims `htmlMode:"talentbrew"`):

1. Validate `siteUrl` is `https:` and hostname matches
   `TALEO_HOST_ALLOW` (initially: exact `www.kaiserpermanentejobs.org`;
   extensible per-tenant by adding to a small allow-list constant —
   we deliberately *do not* accept arbitrary `*.taleo.net` to keep
   SSRF surface tight).
2. For each `searchLocations[i]`:
   - For `pageIdx` in `0..MAX_PAGES-1`:
     - Build `${siteUrl}/search-jobs/${encodeURIComponent(loc)}?p=${pageIdx+1}`.
     - `fetchFn(url, { timeoutMs: 15000, retries: 1, headers: { UA } })`.
     - Cap HTML at `MAX_HTML_BYTES = 5 MB`.
     - Parse `<li>...<a href="/job/.../{companyId}/{jobId}">...</a></li>`
       under `<section id="search-results-list">`.
     - If page yields 0 `<li>` matches OR the same jobIds as the previous
       page → break (pagination exhausted).
3. For each parsed entry:
   - Reject hrefs whose host (after URL join) differs from `siteUrl`.
   - Extract `title` (`<h3>`), `location` + `setting` + `schedule` +
     `shift` (split `<p>` text by `,`, trim).
   - `jobId` = trailing numeric segment of href (validated against
     `/^\d{6,16}$/`).
   - Apply `locationMatchesAllow(location, locationAllow)` (same helper
     as iCIMS).
   - `rawExtra = { scheduleHint: schedule, workSetting, shift }` — the
     listing-tile schedule is the canonical source for the Schedule
     field; the JD fetcher will surface it as a labeled `SCHEDULE:` line.
4. Normalize via `assertJob`. Skip rows that fail validation.

### 4.3 JD fetcher (`engine/core/jd_cache.js`)

Add a `taleo` branch in `fetchJd`'s source switch + `formatTaleo()`:

```js
function formatTaleo(html, job) {
  const parts = [];
  // Pull JSON-LD first if present (most accurate metadata).
  const ld = extractJsonLdJob(html);                 // best-effort, returns {} on miss
  const title = ld.title || job.title || "";
  const location = ld.jobLocation || (job.locations && job.locations[0]) || "";
  // Schedule priority: adapter's listing-tile hint > JSON-LD employmentType
  const scheduleHint = (job.rawExtra && job.rawExtra.scheduleHint) || ld.employmentType || "";

  parts.push(`TITLE: ${title}`);
  if (location) parts.push(`LOCATION: ${location}`);
  if (scheduleHint && scheduleHint.toLowerCase() !== "standard") {
    parts.push(`SCHEDULE: ${scheduleHint}`);
  }
  if (ld.identifier) parts.push(`REQ ID: ${ld.identifier}`);
  parts.push("");

  // Body: prefer JSON-LD description+qualifications joined; fall back
  // to ats-description regex (the same TALENTBREW_DESC_RE we use for
  // iCIMS talentbrew tenants — code reuse, not duplication).
  let body = "";
  if (ld.description || ld.qualifications) {
    body = stripHtml(`${ld.description || ""}\n${ld.qualifications || ""}`);
  } else {
    const m = TALENTBREW_DESC_RE.exec(html) || TALENTBREW_DESC_FALLBACK_RE.exec(html);
    body = m ? stripHtml(m[1]) : "";
  }
  if (!body) return null;             // header-only → unsupported, do not poison cache

  parts.push(body);
  return parts.join("\n").trim();
}
```

`extractJsonLdJob(html)` is a small helper: find the first
`<script type="application/ld+json">` block whose JSON has
`@type === "JobPosting"`, return its top-level fields. On parse error
or missing tag, return `{}` and fall through to regex.

SSRF guard for `fetchJd("taleo", job)`:
- `job.url` host must be in `TALEO_HOST_ALLOW`.
- URL must be `https:`.
- No re-derivation of path — we use the exact URL the adapter wrote.

### 4.4 Code touch points

1. `engine/modules/discovery/taleo.js` (new, ~200 LOC).
2. `engine/modules/discovery/taleo.test.js` (new, fixture-based, mocked
   fetchFn). Cases: happy (Kaiser Sacramento fixture); empty results
   page; malformed `<li>` (no href); pagination exhaustion via
   duplicate jobIds; SSRF rejection on bogus `siteUrl`; locationAllow
   prune; 429 retry; companyId mismatch on href.
3. `engine/modules/discovery/fixtures/taleo/kaiser-sacramento-p1.html`
   (recon-captured snippet, ~5 listings, real markup).
4. `engine/core/jd_cache.js`: shared `TALEO_HOST_ALLOW`,
   `extractJsonLdJob`, `formatTaleo`; `fetchJd` switch extended; export
   list updated to include `formatTaleo` for test access.
5. `engine/core/jd_cache.test.js`: fixture-based JD tests — happy path
   (JSON-LD), fallback to TALENTBREW_DESC_RE, schedule-hint pass-through
   from `job.rawExtra.scheduleHint`, header-only → null,
   employmentType:"Standard" filtered out, SSRF host rejection.
6. `engine/core/jd_extract.test.js`: regression — Taleo-shaped
   `SCHEDULE: Full-time` / `Per Diem` / `Part-time 32 Hours` lines
   parse via existing `extractSchedule` regex. (The "32 Hours" suffix
   on Kaiser's listing tile may need a regex tweak in `jd_extract.js`
   if `\bfull[\s-]?time\b` doesn't already cover; verify in test.)
7. `data/companies.tsv`: 1 new row, source=`taleo`, slug=`kaiser-641`,
   name=`Kaiser Permanente`, profileFilter=`lilia`, meta as above.
8. `profiles/lilia/profile.json`: add `"discovery:taleo"` to `modules`.
9. `docs/architecture/overview.md`: list `taleo` alongside other
   discovery adapters; update `jd_cache` line to mention Taleo.
10. `docs/runbooks/adding-adapter.md`: list `taleo` in the JD-cache
    supported-sources line.
11. `CHANGELOG.md`: Unreleased / Added entry.
12. `private/backlog/BL-49.md` (new): track this RFC's delivery; closed
    on merge.
13. `private/backlog/BL-7-scan-source-coverage-gaps.md` &
    `BL-8-lilia-data-gap-...md`: cross-link to BL-49, mark Taleo
    follow-up resolved.

### 4.5 Backwards compatibility

- New `source = "taleo"` does not collide with existing keys.
- Adapter auto-registry picks up `taleo.js` automatically (no wiring
  in `index.js`).
- `jd_cache` `SUPPORTED` set grows from `{greenhouse, lever, workday,
  icims}` → `{…, taleo}`; non-supported sources still return
  `{status:"unsupported"}`.
- No TSV schema changes (new row uses existing column layout).
- Existing iCIMS code path is untouched; the `TALENTBREW_DESC_RE`
  helper is re-exported / shared, not duplicated.

## 5. Tests

| Layer | Case | File |
|---|---|---|
| unit | `taleo.discover` parses Kaiser fixture, returns 5 jobs | `engine/modules/discovery/taleo.test.js` |
| unit | empty `<section>` → 0 jobs, no error | same |
| unit | pagination exhausted (duplicate jobIds) → stops, no infinite loop | same |
| unit | SSRF: bogus `siteUrl=http://internal/...` → no fetch, target reported skipped | same |
| unit | locationAllow prunes "Modesto, CA" out, keeps "Sacramento, CA" | same |
| unit | companyId mismatch (href `/job/.../999/123`) → entry rejected | same |
| unit | 429 retry-after exhaustion → target marked failed, scan continues | same |
| unit | `formatTaleo` happy-path with JSON-LD → TITLE / SCHEDULE / body | `engine/core/jd_cache.test.js` |
| unit | `formatTaleo` fallback to TALENTBREW_DESC_RE when no JSON-LD | same |
| unit | `formatTaleo` uses `job.rawExtra.scheduleHint` over `employmentType:"Standard"` | same |
| unit | `formatTaleo` header-only → null (no cache poison) | same |
| unit | `fetchJd("taleo")` writes cache on first call, reads on second | same |
| unit | `fetchJd("taleo")` SSRF host outside allow-list → not_found | same |
| regression | `extractSchedule` parses `SCHEDULE: Per Diem` (Kaiser vocab) | `engine/core/jd_extract.test.js` |
| regression | `extractSchedule` parses `SCHEDULE: Part-time 32 Hours` | same |
| integration | Lilia `scan --profile lilia` finds Kaiser Sacramento jobs (manual smoke) | manual |
| integration | `prepare --phase pre` populates `jdText` + Schedule for taleo entries (manual smoke) | manual |

## 6. Rollout

1. RFC approval (user).
2. Implement discovery adapter + tests → green.
3. Implement JD fetcher + tests → green.
4. Add `data/companies.tsv` row + enable in `profiles/lilia/profile.json`.
5. Multi-agent code review per M-tier (general-purpose for correctness
   + targeted security pass for SSRF / HTML parsing).
6. Address review feedback.
7. Doc updates (overview, adding-adapter, CHANGELOG).
8. Commit + push.
9. Smoke: `node engine/cli.js scan --profile lilia --verbose` →
   confirm `taleo: N new (kaiser-641)` in summary.
10. Smoke: `node engine/cli.js prepare --profile lilia --phase pre
    --mode fresh --batch 30` → confirm `jdText` + Schedule populated
    for kaiser rows in `prepare_context.json`.
11. Close BL-49, cross-link BL-7 / BL-8.

## 7. Risks

- **TalentBrew HTML drift** — Kaiser's `<li>` layout could change.
  Mitigation: fixture-based unit test pinned to current markup; 0-jobs
  outcome on drift is logged not silent (existing source-isolation in
  `runTargets`); future RFC 017 §7 stale-source detection will flag it.
- **JSON-LD missing on some postings** — fall back to
  `TALENTBREW_DESC_RE`. Test covers both paths.
- **`employmentType: "Standard"`** — useless for Schedule extraction
  by itself. Mitigation: adapter passes the real schedule (Full-time
  / Part-time / Per Diem / etc.) from the listing tile as
  `rawExtra.scheduleHint`; JD fetcher surfaces that, not
  `employmentType`. Test pins this priority.
- **"Sacramento, CA" search returns regional spread** — Kaiser's
  built-in search expands to NorCal. Mitigation: `locationAllow` post-
  prunes to the 18 explicit cities (same convention as other Lilia
  adapters). The trade-off is more HTML fetched than strictly
  necessary; acceptable for ~150 entries / 11 pages.
- **Auth wall on individual JD pages** — none observed in recon (curl
  with UA succeeded, 63 KB HTML, full content). If Kaiser later gates
  JD HTML behind a session, `fetchJd` returns `not_found` and Schedule
  falls back to the listing-tile hint that is still available via
  `assertJob`'s `rawExtra` — partial degradation, not silent null.
- **Pagination loop on duplicate-content pages** — `MAX_PAGES = 30`
  hard cap + duplicate-jobIds short-circuit. Both must fire for an
  infinite loop, which is the defense-in-depth pattern used elsewhere.

## 8. Open questions

None — all open recon answered during RFC drafting (URL shape,
endpoint, JSON-LD presence, schedule source, company id constant).
