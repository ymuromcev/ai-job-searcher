---
id: RFC-032
title: Workable ATS adapter
status: draft
tier: M
created: 2026-05-18
tags: [discovery, ats, workable]
refs: [BL-63]
---

# RFC 032 — Workable ATS adapter

- **Status:** Proposed
- **Author:** ymuromcev / Claude
- **Date:** 2026-05-18
- **Tier:** M (new adapter, profile-config schema unchanged, no migration of historical data)
- **Depends on:** none
- **Supersedes:** none

## 1. Problem

Workable hosts the careers boards of part of the AI tier-2 / B2B-SaaS
segment that is currently invisible to `scan`. Most visible case from
the 2026-05-15 FDE/SE seed pass: **Hugging Face**
(`apply.workable.com/huggingface`). The seed had to swap HF for Sierra
to keep discovery moving. The fix is a generic Workable adapter, not a
HF-only patch.

`jared.modules` today: `greenhouse / lever / ashby / smartrecruiters /
workday / calcareers / the_muse / adzuna`. Workable is the next-most
common gap in the public-board zoo (alongside Deel, which has its own
RFC 017).

## 2. Recon (2026-05-18, performed in this session)

Probes against live endpoints — all results below are real, not
hypothetical.

1. **List endpoint discovery.** `GET https://apply.workable.com/api/v3/accounts/huggingface/jobs`
   (the URL named in BL-63) returns **404**. The correct widget endpoint —
   surfaced via a 302 from `https://www.workable.com/api/accounts/huggingface` —
   is:

       GET https://apply.workable.com/api/v1/widget/accounts/{slug}

2. **Happy-path probe.** `GET .../widget/accounts/huggingface` → **200**,
   body shape:

   ```
   { name, description, jobs: [ {…}, … ] }
   ```

   `jobs.length = 7` for Hugging Face on 2026-05-18.

3. **Per-job field shape (verbatim from one HF posting):**

   ```json
   {
     "title": "Cloud ML DevRel Engineer - EMEA remote",
     "shortcode": "922D2C6549",
     "code": "",
     "employment_type": "Full-time",
     "telecommuting": true,
     "department": "Revenue-Share",
     "url": "https://apply.workable.com/j/922D2C6549",
     "shortlink": "https://apply.workable.com/j/922D2C6549",
     "application_url": "https://apply.workable.com/j/922D2C6549/apply",
     "published_on": "2026-02-12",
     "created_at": "2026-02-12",
     "country": "France",
     "city": "Paris",
     "state": "Île-de-France",
     "education": "",
     "experience": "Mid-Senior level",
     "function": "Engineering",
     "industry": "Computer Software",
     "locations": [
       { "country": "France", "countryCode": "FR", "city": "Paris",
         "region": "Île-de-France", "hidden": false }
     ]
   }
   ```

4. **Multi-tenant sanity.** `GET .../widget/accounts/typeform` → **200**,
   `jobs.length = 0` (Typeform currently has no public Workable
   openings, but the endpoint resolves cleanly).

5. **Bad-tenant behaviour.** `GET .../widget/accounts/notexisting12345` → **404**.
   Clean signal, no HTML-error-page noise.

6. **Per-job endpoint.** `GET .../widget/accounts/huggingface/jobs/{shortcode}` → **404**.
   No public JSON-per-job route. The job HTML at
   `https://apply.workable.com/j/{shortcode}` exists but is JS-rendered
   (no inline JD JSON in the initial HTML). Implication: full-JD
   fetching is **out of scope** for this RFC; track as a follow-up BL.

7. **Auth.** No `Authorization` / cookie / referer required. Realistic
   `user-agent` recommended (same convention as other adapters).

8. **Rate limit.** No `Retry-After` or `429` observed across 4 probes.
   Default `_ats.js` concurrency cap (4, hard-max 8) is fine.

9. **ToS.** `/widget/` is the documented endpoint Workable's hosted
   careers iframe uses to render boards on customers' marketing sites.
   Public, embed-intended, industry-norm scrapeable (same posture as
   Greenhouse/Lever/Ashby boards). No login wall on any tenant probed.

## 3. Goals / non-goals

**Goals**

- Generic adapter consuming any `apply.workable.com/{slug}` board.
- Drop into existing scan pipeline with a one-line edit to
  `data/companies.tsv` (`Hugging Face\tworkable\thuggingface\t\tjared`),
  same shape as greenhouse/ashby rows.
- Match canonical `Job` schema in `engine/modules/discovery/_types.js`
  so dedup, fit, and Notion sync work unchanged.
- Honour `telecommuting:true` as a "Remote" location — mirrors the
  Ashby pattern.

**Non-goals**

- **No full-JD fetching in this RFC.** Per-job JSON route 404s; JS-rendered
  HTML is out of scope here. Filed as follow-up.
- No expansion of `data/companies.tsv` beyond what BL-63 already calls
  out (HF + handful of AI tier-2 names — separate task, gated on user
  approve of which companies to add).
- No private Workable API (auth'd routes), no SSO flows, no per-customer
  branded board variants beyond what `apply.workable.com/{slug}` serves.

## 4. Proposed adapter

File: `engine/modules/discovery/workable.js`. Same shape as `ashby.js`
and `greenhouse.js`:

```js
// Workable public widget API.
//   https://apply.workable.com/api/v1/widget/accounts/{slug}
// Response shape: { name, description, jobs: [{ shortcode, title, url,
//                     published_on, telecommuting, department,
//                     country, city, state, locations: [...] }] }

const { fetchJson, runTargets, makeCtx } = require("./_ats.js");
const { assertJob } = require("./_types.js");
const { sanitizeText, parseIsoDate, dedupeLocations } = require("./_normalize.js");

const SOURCE = "workable";
const BASE = "https://apply.workable.com/api/v1/widget/accounts";

function formatLocation(loc) {
  if (!loc || typeof loc !== "object") return "";
  const city = sanitizeText(loc.city);
  const region = sanitizeText(loc.region);
  const country = sanitizeText(loc.country);
  return [city, region, country].filter(Boolean).join(", ");
}

function mapJob(target, raw) {
  // shortcode is the natural primary key on Workable. Drop malformed records
  // here rather than letting assertJob throw — a single broken record would
  // otherwise sink the whole tenant's batch via runTargets' per-target catch.
  const jobId = String(raw.shortcode || raw.id || "");
  if (!jobId) return null;
  const url = String(raw.url || raw.shortlink || `https://apply.workable.com/j/${jobId}`);
  const fromLocations = Array.isArray(raw.locations)
    ? raw.locations.filter((l) => l && !l.hidden).map(formatLocation)
    : [];
  const fromLegacy = [raw.city, raw.state, raw.country]
    .map((v) => sanitizeText(v))
    .filter(Boolean)
    .join(", ");
  const locations = dedupeLocations([
    ...(raw.telecommuting ? ["Remote"] : []),
    ...fromLocations,
    fromLegacy,
  ]);
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId,
    title: sanitizeText(raw.title),
    url,
    locations,
    team: sanitizeText(raw.department) || null,
    postedAt: parseIsoDate(raw.published_on || raw.created_at),
    rawExtra: {
      telecommuting: Boolean(raw.telecommuting),
      employment_type: raw.employment_type || null,
      experience: raw.experience || null,
      function: raw.function || null,
      industry: raw.industry || null,
    },
  };
  assertJob(job);
  return job;
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  return runTargets(targets, c, async (target) => {
    if (!target || !target.slug) return [];
    const url = `${BASE}/${encodeURIComponent(target.slug)}`;
    const body = await fetchJson(c.fetchFn, url, { signal: c.signal });
    const raws = Array.isArray(body && body.jobs) ? body.jobs : [];
    return raws.map((r) => mapJob(target, r)).filter(Boolean);
  });
}

module.exports = { source: SOURCE, discover };
```

`mapJob` returns `null` for records missing `shortcode`; the `.filter(Boolean)`
in `discover` drops them. This is defence-in-depth — the recon API always
populated `shortcode`, but a single malformed record on a 200-job tenant would
otherwise throw inside `assertJob` and `runTargets` would lose the entire
tenant's batch under per-target containment.

Auto-registry in `engine/modules/discovery/index.js` picks the file up
by filename — no registration code needed (verified pattern,
`buildRegistry` walks every non-`_`, non-`.test.js` `.js` sibling).

## 5. Testing

`engine/modules/discovery/workable.test.js` mirrors `ashby.test.js`:

- **Happy path.** Faked `fetchFn` returns a 2-job fixture (one full
  HF-style record, one minimal sparse record with empty
  `locations[]` and no `telecommuting`). Asserts: `assertJob` passes
  for both, `source === "workable"`, `jobId === shortcode`,
  `locations` ordering preferred (Remote first when `telecommuting`),
  `postedAt` normalized to `YYYY-MM-DD`, `team === department`,
  `rawExtra.telecommuting === true/false`.
- **Hidden location filter.** Record with `locations[{hidden:true}]`
  → that entry dropped from `locations`. Legacy `city/state/country`
  fallback still appended.
- **Slug encoding.** Target `slug = "foo.bar"` → URL contains
  `foo.bar` (no double-encode). Empty `jobs[]` → returns `[]`.
- **404 containment.** Faked `fetchFn` returns `{ok:false, status:404}`
  → `runTargets` swallows the error (one warn), returns `[]`. Same
  guarantee as other adapters.

No network in unit tests. Integration sanity is manual: `node engine/cli.js
scan --profile jared` after the row is added to `companies.tsv`.

## 6. Companies.tsv (out of scope for the RFC; recipe only)

Adding Hugging Face is a separate one-liner the user does manually
after merge:

```
Hugging Face	workable	huggingface		jared
```

Same shape as every other ATS row. No backfill needed. This RFC
itself does not edit `data/companies.tsv` — that's a product decision
on which Workable tenants to onboard.

## 7. Failure modes

1. **Workable changes widget API shape.** `body.jobs` becomes
   non-array or required fields go missing. Adapter throws per-target;
   `runTargets` logs warn, batch continues. **Detection signal:** the
   already-spec'd "company with `historical_count > 5` returns 0 for 3
   consecutive scans" check (RFC 017 §7.1) covers this when it lands;
   until then, manual inspection.
2. **Bad slug in `companies.tsv`.** 404 from API → per-target containment
   (same as bad Greenhouse slug today). No batch impact.
3. **Rate limiting.** Not observed in recon. If it surfaces, default
   `_ats.js` concurrency-4 is the first line; can drop to 2 per-source
   via `ctx.concurrency` if needed.
4. **`shortcode` collision with other sources.** Dedup key is
   `(source, jobId)` per `_types.js` and `applications_tsv.js` — so
   no collision risk; `workable:922D2C6549` is namespaced by source.
5. **`telecommuting:true` but a hidden physical location.** Adapter
   filters `hidden:true` entries explicitly, but adds "Remote" if the
   flag is true. Matches Ashby's `isRemote` handling.

## 8. JD-cache integration

Out of scope for this RFC. The per-job JSON endpoint is 404; the
HTML page at `apply.workable.com/j/{shortcode}` is JS-rendered with no
inline JD. JD-cache support would require either:

- a real browser session (Indeed-pattern manual ingest), or
- discovering a different JSON route (Workable also serves a server-rendered
  variant on some boards — not confirmed for HF).

Recommend: file a follow-up BL ("Workable JD fetch") once we see
whether `function/industry/experience` from the list endpoint is enough
signal for fit-prerank without the body text. Often it is —
Greenhouse `departments[0]` + title is already the working signal for
most prerank decisions.

## 9. Open questions

1. **`experience: "Mid-Senior level"` → fit signal?** Workable's
   `experience` field is structured-ish (`Internship / Entry / Mid-Senior /
   Director / Executive`). Could feed into the prerank gate without
   needing JD fetch. Out of scope here, but a candidate for a follow-up.
2. **`function: "Engineering"` taxonomy.** Worth checking how
   consistently AI tier-2 companies tag this (vs free-text in
   `department`). If consistent, it's a cleaner "is this a SWE/PM/data
   role" gate than parsing titles.
3. **Companies to onboard in the first pass.** HF is locked. Beyond
   that, the BL-63 ref says "second-tier AI startups" without naming —
   product decision for the user, not the engine.

## 10. Approval gate

Tier M → RFC + approve → code + tests + code-reviewer subagent →
smoke against live HF tenant → commit. Per `DEVELOPMENT.md`, no code
is written until the user explicitly approves.

Recon is done (Section 2). Path chosen: **list-endpoint adapter, no JD
fetch**. No browser fallback needed (real public API works).

## 11. Rollback

`git rm engine/modules/discovery/workable.{js,test.js}` + revert the
one-line `companies.tsv` row (which is added separately by the user,
not by this RFC). Auto-registry forgets the source on next reload.
Zero impact on existing rows. Risk: nil.
