---
id: RFC-052
title: Jared keyword aggregator — expand cross-company PM discovery
status: draft
tier: L
created: 2026-05-28
tags: [discovery, aggregator, jared, adzuna, linkedin, indeed, tos]
refs: [BL-144, BL-87, BL-143, RFC-030, RFC-033]
---

# RFC 052 — Jared keyword aggregator (cross-company PM/FDE/SE pull)

- **Status:** Proposed — RFC-only, no code in this PR
- **Author:** ymuromcev / Claude
- **Date:** 2026-05-28
- **Tier:** L (ToS / legal surface + potential paid API + new secrets +
  multi-file impact across discovery / profile schema / docs)
- **Depends on:** none
- **Supersedes:** none

## 1. Problem

Jared's pipeline currently produces **78 Inbox rows / 14 d** despite
266 companies in `data/companies.tsv`. Drop ratio is steady at ~98.8%
post-filter, so Inbox volume is bounded from below by the *raw pool*,
and the raw pool is bounded by *which companies we know about*.

The dominant channel for live PM, Forward-Deployed Engineer (FDE), and
Solutions Engineer (SE) postings — **LinkedIn keyword search** and
**Indeed keyword search** — is **not** plugged in. Every other Jared
adapter (`greenhouse`, `lever`, `ashby`, `smartrecruiters`, `workday`,
`calcareers`, `workable`) is **company-targeted**: it iterates over
slugs in `companies.tsv`. The two cross-company aggregators we do run
are `the_muse` (small, ~80 raw / scan, cap hardcoded) and `adzuna`
(real cross-company but currently 5 keywords / 1 location / 50
results-per-keyword, capped at 250 raw before dedupe).

A PM at a company **not** in `companies.tsv` posted on LinkedIn or
Indeed today is invisible to Jared's pipeline.

### Recon: what's already in the repo

- `engine/modules/discovery/indeed.js` **exists** but is **not** a live
  scraper. It's a **browser-ingest adapter**: Claude opens indeed.com
  in a Claude-in-Chrome session, manually extracts viewjob cards into
  a JSON file, the adapter reads that file. It works but requires a
  manual interactive Claude session per scan — not suitable for cron.
- No `linkedin_keyword.js` exists. No file referencing LinkedIn job
  scraping exists in `engine/`. LinkedIn URLs appear only in
  email-filter / URL-check / resume-template code paths.
- `adzuna.js` is the canonical keyword-aggregator pattern: `feedMode:
  true`, secrets via `JARED_ADZUNA_APP_ID` / `JARED_ADZUNA_API_KEY`,
  config via `profile.json → discovery.keyword_search`. BL-87 wired
  keyword derivation from `filter_rules.role_targets` as a fallback.
- `the_muse.js` is `feedMode: true` but is a category-pull
  (`?category=Product`) capped at 4 pages × 20 = 80 raw — useful but
  bounded.

So the gap is real: no fully-automated, *cross-company*, *keyword-
indexed* source beyond Adzuna's current 250-result/scan ceiling.

## 2. Goals

1. Raise the **raw cross-company pool** for Jared from ~250 (Adzuna at
   current config) to **800-1500 raw / scan**, where the marginal jobs
   are PM / Senior PM / FDE / AI Solutions Engineer / Solutions
   Engineer roles at US companies *not* present in `companies.tsv`.
2. Keep existing filters and the 98.8% drop ratio intact — uplift
   comes through *more raw* feeding the same gate, *not* by loosening
   the gate.
3. **Zero ToS violations.** No direct scraping of LinkedIn or Indeed
   from server code. No anti-bot evasion. If the only path to a source
   is ToS-violating scraping, we drop the source.
4. Reuse the existing keyword-search config schema (`profile.json →
   discovery.keyword_search`) and the `feedMode: true` adapter pattern.
   No new architectural primitives.
5. Bounded cost. Free-tier sources first; paid only if the free path
   demonstrably can't move Inbox/14d past ~150.

### Non-goals

- Beat LinkedIn at its own game. We are not building a LinkedIn
  scraper. If 100% LinkedIn coverage is the requirement, the right
  answer is "use LinkedIn manually" — not "build a scraper".
- Personalize PM-vs-FDE ranking. Fit scoring already does that
  downstream; this RFC is purely about raw-pool width.
- Add a generic "any keyword from anywhere" adapter. Sources must be
  scoped, legal, and explainable.

## 3. Options analysis

For each option: how it works, ToS/legal posture, cost, expected raw
uplift over Adzuna's current 250, new ENV vars, impl effort (XS / M /
L per `dev-workflow`).

### Option A — Expand existing Adzuna coverage

**How.** Stay on Adzuna; widen its query envelope via
`profile.json → discovery.keyword_search` only. No new adapter.

Concrete dials:

- **Keywords.** Today: 5 (PM / Senior PM / FDE / AI Solutions Engineer
  / Solutions Engineer). Add: "Principal Product Manager", "Group
  Product Manager", "AI Product Manager", "Staff Product Manager",
  "Product Lead", "AI Solutions Architect", "Forward Deployed Solutions",
  "Customer Engineer", "AI Engineer Customer Success". Target ~10-12
  keywords total.
- **Locations.** Today: 1 (`United States`). Adzuna's `where=United
  States` is reasonably permissive but US-region splits often yield
  *different* listings due to Adzuna's regional indexing. Split into:
  `United States`, `San Francisco`, `New York`, `Remote`. (We can A/B
  this — `Remote` may largely overlap with `United States` due to
  Adzuna deduplication, but `San Francisco` / `NYC` often surface
  region-tagged jobs the country-level query misses.)
- **max_age_days.** Keep at 30.
- **results_per_keyword.** Already at Adzuna's hard cap (50/page).
  Adzuna *does* support paginated results — see §3.A.1 below for the
  optional pagination extension.

**ToS / legal.** Clean. Adzuna is a paid aggregator with explicit
developer terms; we use their documented API.

**Cost.** Adzuna free tier = 250 calls/month. 12 keywords × 4
locations × 1 page = 48 calls/scan. Daily cron = 1440 calls/month —
**blows the free tier**. Options: (1) reduce to weekly cron (336
calls/month, still over); (2) reduce keywords × locations
(realistically 12 kw × 1 loc daily = 360/month — still over);
(3) move to paid tier (~$50-200/mo per Adzuna sales).

  → If A is chosen, we need to **either** drop scan cadence to 2x
  weekly **or** pay. This is a real decision, not a footnote.

**Expected raw uplift.** 250 → ~500-700 raw / scan (2-3x). Hard to
push past that on Adzuna alone — they index a finite slice of the
ATS-aggregated web and our existing 5 keywords already hit most PM
listings in their corpus.

**New ENV vars.** None.

**Impl effort.** **XS**. Profile-only change
(`profiles/jared/profile.json → discovery.keyword_search.{keywords,
locations}`). Adapter needs minor change to loop over `locations[]`
instead of single `location`, which is M-tier touch but small.

#### 3.A.1 Adzuna pagination extension (optional)

Adzuna's API supports `page` 1..N. Today we hit only page 1. Adding
page 2 (50 more results) per keyword × location doubles the call
budget but ~doubles uplift per keyword. Combined: A + pagination ≈
800-1000 raw / scan. Same cost story — almost certainly requires the
paid tier on a daily cron.

### Option B — Add a second legitimate cross-company aggregator

**How.** Add **Jooble** as a new `feedMode: true` adapter alongside
Adzuna. Jooble is a global job-search aggregator with a documented
public API (no scraping), indexes LinkedIn / Indeed / Glassdoor /
Monster / company pages.

Concrete:

- `engine/modules/discovery/jooble.js` — same shape as `adzuna.js`,
  reads `JARED_JOOBLE_API_KEY` from secrets, config from
  `profile.json → discovery.keyword_search.sources` add `"jooble"`,
  per-source `keywords / location / results_per_keyword`.
- Free tier: 500 requests/day per their docs (verify on signup;
  Jooble sales gates are friendlier than Indeed's were).

Alternatives in the same category we considered and rejected:

- **JSearch** (via RapidAPI) — indexes LinkedIn/Indeed/etc., API-shaped.
  Pricing is *per-request*: free tier ~150/mo, paid from $10/mo
  (basic) to $50/mo (pro). The legal posture is murkier (JSearch
  scrapes LinkedIn results pages and re-serves them — RapidAPI hosts
  the gateway, but the underlying data acquisition is contested). We
  flag it but don't recommend.
- **TheirStack / Coresignal / Bright Data** — enterprise scrapers,
  $$$$, contracts measured in months. Out of scope for a personal
  pipeline.
- **HireBuddy** — listed in BL-144 as a candidate; on inspection it
  appears to be a Chrome extension / consumer product, not a public
  API. Ruled out.

**ToS / legal.** Jooble: clean (own API, own crawler, separate ToS).
JSearch: yellow flag (their crawl source is LinkedIn search pages).

**Cost.** Jooble free tier likely sufficient for daily cron at our
volume. If not: paid tiers exist (need to confirm pricing on signup —
public site doesn't post numbers, which itself is a signal).

**Expected raw uplift.** Jooble corpus overlaps with Adzuna's but is
~2-3x wider for tech roles (anecdotal — would need a 1-scan A/B to
confirm). Estimate: +400-600 raw / scan *net of dedupe* with Adzuna.
Combined A+B ≈ 1000-1300 raw / scan.

**New ENV vars.** `JARED_JOOBLE_API_KEY`.

**Impl effort.** **M**. New adapter file + tests + `.env.example`
entry + docs update + profile-config wiring.

### Option C — LinkedIn RSS / Google-indexed search

**How.** Two sub-options under one umbrella:

- **C1 — LinkedIn job-feed RSS.** Historically LinkedIn served per-
  search RSS feeds (`https://www.linkedin.com/jobs/search/?keywords=
  ...&f_TPR=r86400` with `&format=rss` suffix). **As of 2026** these
  feeds are **dead** — LinkedIn deprecated all public RSS for jobs
  during the Microsoft consolidation. Confirmable by HEAD request; we
  did not test live in this RFC but multiple recent (2024-2025)
  reports flag the deprecation. **C1 is non-viable.**
- **C2 — Google-indexed LinkedIn results.** Query Google with `site:
  linkedin.com/jobs/view "Product Manager"` and parse SERP. ToS
  violations on *both* sides (Google forbids scripted SERP scraping
  without their Custom Search API; LinkedIn forbids automated access
  to jobs pages even through search-engine indices). Bypassing
  LinkedIn's login wall to read the linked pages is *also* a ToS
  violation. **Hard no.**
- **C3 (variant) — Google Custom Search Engine + LinkedIn-restricted
  CSE.** Use Google CSE API ($5 / 1000 queries) restricted to
  `linkedin.com/jobs`. Legal-ish on the *Google* side (their API,
  their terms). But the linked URLs land on LinkedIn's auth wall —
  Jared cannot apply through them, and Notion would fill with broken
  rows. **No usable end-to-end flow even when legal.**

**ToS / legal.** C1: dead. C2: red. C3: yellow on Google side, red on
LinkedIn-content-access side.

**Cost.** N/A — option is non-viable.

**Expected raw uplift.** N/A.

**Recommendation.** Reject entirely. Include only to document why it's
not recommended (BL-144 explicitly asked us to consider it).

### Option D — Don't expand. Accept 78/14d as the floor.

**How.** Do nothing. Keep current 5 keywords / 1 location / 1 page
Adzuna config. Continue to add companies to `companies.tsv`
opportunistically as Jared encounters them; the company-targeted
adapters do the work.

**ToS / legal.** Zero risk.

**Cost.** Zero.

**Expected raw uplift.** Zero. Inbox floor stays at 78 / 14d.

**Impl effort.** Zero.

**Why it might be the right answer.** 78 Inbox / 14d → ~5-6 / day.
Jared's actual *applied* rate is well below that (manual review +
cover-letter generation is the bottleneck, not raw supply). If the
binding constraint is downstream of Inbox, widening the funnel just
adds noise. This is a legitimate position and the RFC must take it
seriously.

## 4. Recommendation

**Phase 1 (this BL-144 follow-up, M-tier):** Option A — expand Adzuna
coverage. Specifically:

1. Bump `discovery.keyword_search.keywords` to ~10-12 (list above).
2. Extend `adzuna.js` to accept `locations: string[]` and loop over
   them; keep `location: string` as a single-location shorthand for
   backward compat (Lilia / future profiles unchanged).
3. Add **page 2 pagination** behind a config flag
   (`results_per_keyword > 50` triggers it; default unchanged).
4. **Drop scan cadence to 3x/week** (Mon/Wed/Fri) to stay inside free
   tier. Document the tradeoff: 3x/week × 48 calls = ~620 calls/month,
   still over Adzuna's 250 free → **need to confirm Adzuna's actual
   2026 free-tier ceiling before merging, or budget $50/mo for the
   first paid tier**. This is an Open Question for Jared (§5).

**Phase 2 (separate BL, only if Phase 1 doesn't move Inbox/14d past
150):** Option B — add Jooble. New adapter, ~1 day work, requires
manual API-key signup.

**Reject Phase 3 / C entirely.** No LinkedIn integration, automated
or semi-automated, until LinkedIn opens a paid Talent Insights /
Recruiter API tier we can buy access to. Manual LinkedIn browsing
remains Jared's job, not the pipeline's.

### Why A first, not B

- Smallest blast radius. No new adapter, no new secret, no new ToS
  surface, no new failure mode.
- Honest test of the "is Adzuna underutilized?" hypothesis. We
  currently run Adzuna at ~3% of its possible query envelope (5 of
  ~12 keywords × 1 of ~4 useful locations × 1 of 2+ pages). If A
  doesn't move the needle, B probably won't either — the bottleneck
  is the *corpus*, not our *query strategy*. That's a useful signal.
- Cheapest to reverse. Profile-config + ~30-line adapter patch. If
  uplift is disappointing or costs balloon, revert via profile edit.

### Why not D as the recommendation

Option D is defensible but the *cost of being wrong* is asymmetric.
If A moves Inbox/14d from 78 to 150-200 at $0-50/mo, Jared gains
real optionality. If A fails, we revert and accept the floor. D
preserves the floor unconditionally; A risks ~$50/mo to test
whether the floor can be lifted. That's an acceptable bet.

## 5. Open questions (need Jared's decision)

1. **Adzuna paid tier — yes or no?** If Adzuna's current 2026 free
   tier is still 250/mo, Phase 1 requires either $50/mo paid or
   2x/week cadence. Which does Jared prefer? (Confirm tier first
   via `https://developer.adzuna.com/admin/access_details` on his
   account.)
2. **3x/week vs daily scan?** Daily is what cron does today.
   Dropping to 3x/week is the cheapest knob to stay free, at the
   cost of "stale by 2 days" worst-case. Acceptable?
3. **Jooble Phase 2 budget.** If Phase 1 underperforms, is Jared
   willing to spend up to $20/mo on Jooble's paid tier (estimated)
   to add Phase 2?
4. **What's the *actual* binding constraint?** If applied/14d is
   well below 78, raw-pool expansion is solving the wrong problem.
   Worth a 5-minute check on the applications.tsv before greenlighting
   any of this.

## 6. Out of scope

- Adding LinkedIn scraping in any form (direct, RSS, SERP, third-party
  re-scraper). Hard no, period.
- Replacing the existing manual `indeed.js` browser-ingest path. It
  works for ad-hoc Indeed pulls; this RFC does not touch it.
- Per-profile aggregator config beyond what `discovery.keyword_search`
  already supports. Lilia's pipeline is out of scope (BL-143 covers
  her).
- Adding a paid scraping vendor (Bright Data / Coresignal / similar).
  Wrong tier of pipeline.
- Changing the filter / drop-ratio logic. Uplift comes from raw
  width, not from loosening the gate.

## 7. Migration / rollout plan

If approved as proposed:

1. **Phase 1, week 1:** Update `profiles/jared/profile.json →
   discovery.keyword_search` (keywords + locations[]). Adapter patch
   for `locations[]` support. Tests with mock fetchFn for multi-
   location loop. Document in CHANGELOG. Smoke run on jared.
2. **Phase 1, week 2:** Measure Inbox/14d delta. Track Adzuna call
   count vs free tier. Decide on paid tier or cadence change.
3. **Phase 2 (conditional):** Open new BL for Jooble adapter. RFC
   reference back to this one. No code until Jared signs off on the
   budget question.

## 8. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Adzuna free tier exhausts mid-month | High under daily cron | Scan silently returns 0 jobs | Add quota-aware logging; alert when ≥80% of monthly budget consumed |
| Adzuna corpus largely overlaps existing pull | Medium | Phase 1 uplift falls short | Phase 2 (Jooble) is the planned next step; not blocking |
| New keywords pull non-PM titles (eg "Engineering Manager" via "Product Manager" near-match) | Low-Medium | More noise downstream | Existing `title_requirelist` / `title_blocklist` in `filter_rules.json` already gates this |
| Multi-location dedupe gap | Low | Same job counted N times | Existing seenIds dedupe in adapter + `engine/core/key.js` dedupe downstream both catch this |
| Locations[] schema change breaks Lilia | Low | Lilia's scan errors | Keep `location: string` working as legacy shorthand; default `locations` to `[location]` when unset |
