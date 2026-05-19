# RFC 042 — Non-standard ATS coverage (OpenAI / Coinbase / tail)

- Status: **proposed**
- Date: 2026-05-19
- Refs: BL-114, BL-110, BL-112, BL-63 (Workable), RFC 026 (Oracle Cloud), RFC 027 (jobsyn), RFC 031 (Taleo), RFC 032 (Workable)

## Problem

BL-112 attempted to import 10 Tier-1 verified jobs from `private/research/jared_target_startups_2026-05-19.md`. Only 5 of 6 GH-formatted URLs landed in TSV. 14 Tier-1 sub-roles never reached the pipeline at all because the source URLs in the markdown did not match any existing adapter URL shape:

| Company | Roles | Markdown URL pattern | Real ATS (recon 2026-05-19) |
|---|---|---|---|
| OpenAI | 5 (T&S Ops Analyst, T&S Ops Ads, Global Safety Response, AI Emerging Risks, Critical Harm Ops) | `openai.com/careers/<slug>/` | **Ashby** (`api.ashbyhq.com/posting-api/job-board/openai`, 668 jobs, 26 in T&S/Safety). The `openai.com/careers/*` URLs are a marketing wrapper; canonical applications live on `jobs.ashbyhq.com/openai/<uuid>`. |
| Coinbase | 3 (Sr Mgr T&S Ops & Investigations, Specialist T&S, T&S Ops Program Manager) | `coinbase.com/careers/positions/<numeric-id>` | **No public ATS endpoint.** Greenhouse 404 (`coinbase`, `coinbase-inc`, `coinbasecareers`), Ashby 404, Lever 404, SmartRecruiters 0 jobs, Workable 404. Cloudflare-protected SPA. No detectable third-party board. |
| Hugging Face | 1 (T&S Ops, US Remote) | LinkedIn `linkedin.com/jobs/view/...` | Workable (`apply.workable.com/huggingface`, 7 jobs — T&S role is NOT currently in the public feed; was LinkedIn-only). |
| Perplexity | 1 (Eval Specialist) | `jobs.ashbyhq.com/perplexity` (company-level) | Ashby `perplexity` slug, 61 jobs. Adapter exists. |
| Character.AI | many (T&S associates) | `jobs.ashbyhq.com/character` (company-level) | Ashby `character` slug, 17 jobs. Adapter exists. |
| Ramp | unspecified | `jobs.ashbyhq.com/ramp` | Ashby `ramp` slug, already in `companies.tsv`. |
| Retool | 1 (BizOps Lead) | `builtinnyc.com/...` | Custom SPA careers, no detectable third-party board (Lever 404, Ashby 404, Greenhouse 404). |

### What was fixed as quick wins (BL-114 Phase 2)

- Added `discovery:workable` to `profiles/jared/profile.json` modules.
- Added `data/companies.tsv` rows: `Hugging Face / workable / huggingface`, `Character.AI / ashby / character`, `Vercel / greenhouse / vercel`, `Webflow / greenhouse / webflow`.
- OpenAI and Perplexity already had Ashby slugs in the pool; they were always discoverable by `scan`, the markdown URL shape was the only blocker for the manual BL-112 import.

### What remains broken

1. **Coinbase** — `companies.tsv` lists `Coinbase / greenhouse / coinbase`, but that board returns 404. `scan` silently yields zero rows for Coinbase. No public ATS endpoint exists; the 3 verified T&S Ops roles from BL-110 are unreachable by any current adapter.
2. **Retool** — no detectable public ATS endpoint. Same shape as Coinbase, but lower priority (only 1 verified role in BL-110, BizOps Lead).
3. **One-off manual jobs** — even when an adapter exists, importing a specific JD URL into TSV today requires either a) waiting for `scan` to find it organically, or b) hand-editing TSV via a throwaway script (as BL-112 did). This is fragile (BL-112 had to construct the GH numeric jobId manually) and doesn't scale across markdown sourcing passes.

## Approach options

### (A) Per-company custom adapter

Write `engine/modules/discovery/coinbase.js` and (optionally) `retool.js`. Each adapter reverse-engineers the company's frontend data layer:

- **Coinbase:** SPA with Cloudflare protection in front of the data API. Would need either headless-browser scraping, a Next.js `_buildId`/`_next/data` JSON probe, or careful header forging to defeat Cloudflare's bot check. Either path is **fragile** (rotation, captcha, terms-of-service grey zone) and **stateful** (cookie/JS challenge handshake) — fundamentally a different shape than any existing adapter.
- **Retool:** similar SPA-shape recon, single-digit-roles payoff.

**Pros:** Clean; jobs flow through the normal pipeline; future Coinbase roles auto-discovered.
**Cons:** High per-company effort; brittle (Cloudflare can break the adapter at any time); each tail company costs another adapter; doesn't help with one-off manual imports.
**Tier:** L per company.

### (B) Generic manual-import CLI command

New command: `node engine/cli.js import-job --profile <id> --url <url> --company <name> --title <title> [--source <slug>] [--job-id <id>] [--team <team>] [--posted <ISO>]`.

Behaviour:

- Constructs a NormalizedJob in memory using user-supplied fields (or sensible derivations for `source` / `jobId` from the URL — e.g. last URL path segment, hashed if not numeric).
- Routes through the same `applications_tsv.appendNew` path that `scan` uses → row lands as `status="Inbox"` with empty `notion_page_id`, ready for `prepare --phase pre`.
- Source slug for unknown ATS = `"manual"` (new sentinel) so dedup keys are predictable (`manual:<hash>` from URL).
- Honours profile filter rules at write time (geo, blocklist) the same way `scan` does, but skips ATS-adapter requirements.

**Pros:** One implementation covers Coinbase + Retool + every future one-off (Tier-2 / Tier-3 company-level URLs in BL-110, LinkedIn-only roles like HF T&S Ops, future markdown sourcing passes). Same TSV shape, same downstream pipeline. No reverse-engineering. No Cloudflare battles.
**Cons:** Manual per JD (no auto-discovery of new roles on those companies). No JD-text fetch unless we add one separately (and JD-fetch via HTTP is brittle for SPAs anyway — `prepare --phase pre` would need a degraded mode or rely on user-pasted JD text).
**Tier:** M (~200 LOC: command + arg parser + unit tests + docs). Reuses existing `appendNew`, `core/applications_tsv.js`, profile loader.

### (C) Hybrid — minimal OpenAI/Coinbase adapter + generic fallback

OpenAI already covered by Ashby; no work needed there. So in practice this collapses to:

- Tiny Coinbase adapter that reads from one specific reverse-engineered endpoint (if one can be found without Cloudflare friction).
- Plus generic `import-job` for everything else.

**Pros:** Belt-and-suspenders.
**Cons:** Coinbase part inherits all the fragility of (A). Most value comes from the generic command anyway.

## Recommendation

**Adopt (B) — generic `import-job` CLI command. Defer (A) for Coinbase / Retool indefinitely.**

Reasoning:
1. OpenAI is the highest-volume blocker in BL-112, and quick wins have already resolved it via the existing Ashby adapter — no new adapter needed.
2. Coinbase has no public ATS endpoint, and Cloudflare-fronted scraping is outside the project's "polite public API" posture (every other adapter calls a documented public job-board endpoint). Building a brittle Coinbase adapter for 3 roles fails the cost/benefit test.
3. Markdown sourcing passes (BL-110 style) will keep producing one-off URLs for companies that will never have a public ATS. A generic import path captures every future tail case in one fix rather than N adapters.

## Estimated effort

- (B) tier M: ~200 LOC, 1 new command file + tests + small docs touch.
- DOD: cover the 14 Tier-1 misses from BL-112; future markdown URLs land via one CLI call; `prepare --phase pre` either tolerates `source="manual"` (no JD-fetch) or there's an explicit `--jd-file <path>` to provide pasted JD text.

## Test plan

1. Unit: build NormalizedJob from `{url, company, title}` → matches `_types.assertJob`.
2. Unit: dedup — second `import-job` with same URL is a no-op (existing TSV row preserved).
3. Unit: filter-rule respect — `import-job` with blocklisted company is rejected with non-zero exit and informative stderr.
4. Integration: `import-job` for one Coinbase URL → row appears in TSV with `status="Inbox"`, `source="manual"`, deterministic `jobId`.
5. Integration: subsequent `prepare --phase pre` on that row does not crash when ATS-specific JD-fetch is unavailable (degraded path tested).
6. Verify the existing 1639 tests stay green.

## Out of scope

- Reverse-engineering Coinbase or Retool careers SPAs.
- Auto-discovery of new roles on companies without public ATS endpoints.
- Headless-browser infrastructure.
- Importing whole pages of markdown URLs in one shot (one URL at a time keeps the contract small; batch wrapper is a later XS task on top).

## Open questions for approval

1. Source slug for manual rows — `"manual"` vs `"manual:<companyslug>"` vs derived (`"coinbase-custom"` etc). Affects how Notion `Source` select looks. Default proposal: `"manual"` (single sentinel, simplest filter UX).
2. `prepare --phase pre` behaviour on manual rows: skip JD-fetch step entirely, or require `--jd-file` upfront at `import-job` time? Default proposal: skip fetch, let the SKILL prompt user for JD text when it runs.
3. Should `import-job` also accept a TSV-like file for batch import (e.g. `--from-file urls.tsv`)? Default proposal: defer to follow-up BL once the single-URL path is in use.
