# RFC 015: Fit-prerank at scan time

| Field | Value |
| --- | --- |
| RFC | 015 |
| Title | Fit-prerank at scan time |
| Status | Proposed |
| Date | 2026-05-05 |
| Author | ymuromcev / Claude |
| Tier | M-L (RFC-gated, approve required before code) |
| Related | RFC 001 (multi-profile architecture), RFC 002 (check command), G-14 (JD cache extension) |

## 1. Problem statement

After `scan`, `applications.tsv` accumulates leads in FIFO order (`createdAt ASC`). Jared currently has 367 vacancies queued. When `prepare --phase pre --batch 20` runs, it picks the 20 oldest by `createdAt`, regardless of fit. Top-tier roles (Stripe Senior PM, Affirm fraud-PM) sit buried under stale, low-fit leads, while batches burn LLM cost on jobs the user would never apply to. Fit-scoring already exists at `prepare` step 7 (see [skills/job-pipeline/SKILL.md](../skills/job-pipeline/SKILL.md)), but it runs per-batch after the FIFO pick — too late to influence which jobs get prepared.

We want to compute fit **once at scan time** for every job that passes the cheap filters (blocklist + geo + title-requirelist), cache the score in the TSV, and reorder the pre-phase pick by `fit_cached DESC` so the highest-signal leads surface first.

## 2. Proposed change

Additive: one new TSV column, one new pure module, one new state file, one sort-key change in `prepare`, one optional heuristic fallback. No restructuring of existing modules.

### 2.1 TSV schema bump v2 → v3

Add column `fit_cached` (integer `0`–`100`, or empty string if not yet scored). New schema, 16 cols:

```
key, source, jobId, companyName, title, url, location, status,
notion_page_id, resume_ver, cl_key, salary_min, salary_max, cl_path,
fit_cached, createdAt, updatedAt
```

Auto-upgrade on read in `engine/core/applications_tsv.js` `load()`, mirroring the v1 → v2 path landed in Stage 13:

```js
// applications_tsv.js (sketch)
function upgradeRow(row, headerVersion) {
  if (headerVersion === 2) {
    return { ...row, fit_cached: '' };
  }
  return row;
}
```

`save()` always writes v3. All 1126 (Jared) + 99 (Lilia) existing rows pick up an empty `fit_cached` column on first write — no data loss, no manual migration.

### 2.2 New module `engine/core/fit_prerank.js`

Pure function, no I/O beyond the LLM call:

```js
// engine/core/fit_prerank.js
async function scoreJob({ jobMeta, jdText, profile, resumeKeyPoints, client }) {
  // returns { score, model, prompt_tokens, completion_tokens, latency_ms }
}
```

- `score`: integer 0–100. Empty/null on LLM error.
- `model`: e.g. `claude-haiku-3-5` (whatever was used).
- Telemetry fields used for cost monitoring + cache logs.
- `client` is an injected Anthropic SDK client (kept injectable for tests + budget caps).

### 2.3 LLM call — prompt structure

Prompt designed for Anthropic prompt-caching: stable system + key-points block (cached across all jobs in a scan), JD varies.

```
[system, cached]
You are a job-fit scorer for {profile.full_name}, {profile.headline}.
Return ONLY a single integer 0-100. No prose, no JSON, no explanation.
Scoring rubric:
  90-100 = perfect match (role, level, domain, comp band)
  70-89  = strong match, 1-2 mismatches
  50-69  = plausible stretch
  30-49  = weak / off-domain
  0-29   = clear no

[user, cached: profile + key points]
Candidate snapshot:
- Target roles: {profile.target_roles}
- Seniority: {profile.seniority}
- Comp floor: {profile.salary.floor}
- Locations OK: {profile.locations}

Resume key points:
{resumeKeyPoints}

[user, NOT cached: JD]
Job:
- Company: {jobMeta.companyName}  (Tier {jobMeta.tier ?? 'unknown'})
- Title: {jobMeta.title}
- Location: {jobMeta.location}
- Salary: {jobMeta.salary_min}-{jobMeta.salary_max}

JD:
{jdText}

Score (0-100):
```

**Model choice.** Lock to `claude-haiku-3-5` by default. Per-profile override via `profile.json.fit_prerank.model`. Haiku at ~$0.25/M input, ~$1.25/M output, with prompt cache hit on the system + key-points block, lands at roughly **$0.001/job** for a typical 2-3K-token JD. Sonnet would be ~10× more — proposed only as opt-in for users who report consistent under-scoring.

### 2.4 Cache invalidation

Two triggers re-score a job:

1. **JD changed.** `engine/core/jd_cache.js` already keys by URL and stores body; we hash the cached JD body (sha256, first 16 chars) and persist alongside the score. If the hash differs at next scan, re-score. Rare in practice (postings are mostly immutable).
2. **Profile key-points changed.** `memory/resume_key_points.md` mtime is checked at scan start. If it differs from the last recorded mtime, **all** rows in the profile are flagged for re-scoring — clear `fit_cached` for every row, then re-fill in the post-filter batch.

State persisted at `profiles/<id>/.fit-state/last_scored.json`:

```json
{
  "key_points_path": "memory/resume_key_points.md",
  "key_points_mtime": "2026-05-04T18:22:11.000Z",
  "key_points_hash": "a1b2c3d4...",
  "scored_count": 1126,
  "last_run_at": "2026-05-05T09:00:00.000Z",
  "model": "claude-haiku-3-5",
  "total_cost_usd": 1.094
}
```

Directory `.fit-state/` added to `.gitignore` per project convention (matches `.gmail-state/`, `.stage16/`, `.stage18/`).

Add an absolute TTL: re-score after **30 days** regardless, since the job market and the user's preferences shift. Implementation: row carries `fit_scored_at` in the same `.fit-state` file (keyed by row `key`) — *not* in the TSV, to keep the schema bump minimal. Open question 8.4 below revisits whether to put TTL in TSV instead.

### 2.5 Hook into scan flow

In `engine/commands/scan.js` (or wherever post-filter write happens), insert one phase between filter and TSV write:

```
discovery adapters
  → dedup
  → filter (blocklist + geo + title-requirelist)
  → fit_prerank.scoreBatch(newOrChangedRows)   ← new
  → write TSV
```

`scoreBatch` runs jobs through `scoreJob` with a concurrency cap of **5 parallel** Anthropic calls (proven safe across rate-limit tiers; configurable via `profile.json.fit_prerank.concurrency`). On LLM error for a given job: leave `fit_cached` empty, log a warning, do not retry inside the same scan — next scan picks it up because it's still empty.

Only score:
- New rows discovered this scan (no existing TSV entry).
- Rows where `fit_cached === ''` (prior failure or new schema upgrade).
- All rows if `key_points_hash` changed since last run.
- Rows older than 30 days since `fit_scored_at`.

This keeps steady-state scan cost bounded by new-job count.

## 3. Sort change in `prepare --phase pre`

Today (`engine/commands/prepare.js`):

```js
rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
```

Becomes:

```js
rows.sort((a, b) => {
  const fa = a.fit_cached === '' ? -1 : Number(a.fit_cached);
  const fb = b.fit_cached === '' ? -1 : Number(b.fit_cached);
  if (fa !== fb) return fb - fa;            // fit DESC
  return a.createdAt.localeCompare(b.createdAt); // FIFO tiebreak
});
```

Effect: `NULLS LAST` semantics — unscored jobs sink, scored jobs surface in fit order, FIFO inside each fit bucket. Documented in [skills/job-pipeline/SKILL.md](../skills/job-pipeline/SKILL.md) prepare section.

## 4. Cost estimate

Per-profile, per-scan (haiku, prompt-cached):

| Profile | New jobs/scan | Cost/scan | Cost/month (daily scan) |
| --- | --- | --- | --- |
| Jared | ~80 | $0.08 | $2.40 |
| Lilia | ~20 | $0.02 | $0.60 |

Full re-score on key-points change:
- Jared (~1126 rows): **$1.10** one-shot.
- Lilia (~99 rows): **$0.10** one-shot.

Acceptable if the user updates `resume_key_points.md` less than ~1×/week. Hard budget cap configurable per profile (`profile.json.fit_prerank.monthly_cap_usd`, default $10) — when exceeded, `fit_prerank` falls back to the heuristic scorer (section 5) silently and logs a warning.

## 5. Alternative considered: heuristic prerank (no LLM)

A non-LLM scorer using existing profile data:

```
score = 0.5 * title_keyword_match(jobMeta.title, profile.target_roles)
      + 0.3 * tier_score(jobMeta.companyName, companies.tsv)
      + 0.2 * salary_band_match(jobMeta.salary_min, profile.salary)
```

Pros: zero LLM cost, deterministic, fast, runs offline. Cons: misses nuance — Jared's "fraud / risk / trust & safety PM" filter, Lilia's healthcare-specialty match, archetype-vs-JD voice fit. Heuristic would mark a generic "Senior PM" at Stripe as 90 even if the JD is for a marketing PM that Jared would skip.

**Proposal: ship heuristic first, LLM as primary later.** Heuristic lives in the same `engine/core/fit_prerank.js` module, exported as `scoreJobHeuristic({jobMeta, profile})`. It serves three roles:

1. **Fallback** when the Anthropic API fails or the budget cap is hit.
2. **Cheap pre-filter** for L-scale backfills — score every row by heuristic first, skip LLM call for rows scoring < 20 (very-bad-fit don't need a precise number).
3. **A/B baseline** during smoke — does the LLM score correlate with heuristic? If the LLM is just re-deriving heuristic, switch off the LLM and save the budget.

`profile.json.fit_prerank.scorer: "llm" | "heuristic" | "hybrid"`, default `"hybrid"`.

## 6. Migration / rollout

1. **TSV v2 → v3 auto-upgrade** on next scan write — no manual step. Both Jared (1127 rows) and Lilia (99 rows) gain an empty `fit_cached` column.
2. **Per-profile feature flag** `profile.json.fit_prerank.enabled: true|false`, default `false`. Existing users unaffected until they opt in. Stage 18 wizard ([scripts/stage18/generators/profile_json.js](../scripts/stage18/generators/profile_json.js)) gains a default-off field for new profiles.
3. **One-shot backfill CLI**: `node engine/cli.js fit-prerank-backfill --profile <id>`. Scores every TSV row, writes back, updates `.fit-state/last_scored.json`. Can be re-run idempotently — only empty / TTL-expired / hash-mismatched rows are touched.
4. **Smoke on Jared first** (denser pool, more diverse JDs). Lilia second after a week of Jared data.
5. **Status update in [BACKLOG.md](../BACKLOG.md)** + a CLAUDE.md note once shipped.

Rollback: flip `enabled: false`, ignore the `fit_cached` column. Sort falls back to FIFO. No data destruction needed.

## 7. Open questions

1. **Score scale: 0–100 vs 0–10?** Proposal: **0–100**. Finer-grained sort, room for haiku to express small distinctions ("Stripe Senior PM at 92" vs "Stripe Group PM at 88"). 0–10 collapses too much signal.
2. **Model: haiku-3-5 vs sonnet-3-5?** Proposal: **haiku** locked, with `profile.json.fit_prerank.model` override. Revisit if smoke shows >15% disagreement with manual user judgment.
3. **Drift detection at prepare-time.** `prepare` step 7 already computes a fit-score with full JD + cover-letter context. Should it overwrite `fit_cached`? Proposal: **read cached, compute fresh, write back if delta > 10 points**, log the delta. Over time we get a free training signal for whether scan-time fit predicts prepare-time fit.
4. **TTL location.** Currently proposed in `.fit-state` keyed by row key. Cleaner alternative: add `fit_scored_at` column to TSV → schema v4 in the same RFC. Proposal: **keep in `.fit-state` for v3**, promote to TSV only if we discover state-file drift bugs. Avoids two schema bumps.
5. **What if the JD cache is empty?** G-14 will broaden JD coverage (Workday/SR/Ashby/RemoteOK/CalCareers), but adapters that don't fetch JD body still exist (e.g. some calcareers postings). Proposal: **score with title + companyName + location only** when JD missing. Heuristic mode handles this naturally; LLM mode degrades gracefully (haiku still produces a usable rough score from title + tier).
6. **Concurrency cap of 5.** Should this be tier-aware (Anthropic tier 1 vs tier 2)? Proposal: **5 default, configurable**, no auto-detection.

## 8. Testing

- **Unit** (`tests/fit_prerank.test.js`):
  - Mocked Anthropic client returning fixed scores → assert telemetry fields.
  - Heuristic scorer: target_roles match, tier lookup, salary-band edge cases.
  - Hash invalidation logic.
  - 30-day TTL invalidation.
  - LLM error path → empty `fit_cached`, warning logged, function does not throw.
- **Integration** (`tests/scan_fit_prerank.integration.test.js`):
  - Synthetic scan with 3 jobs → TSV gains `fit_cached` populated.
  - Re-run with key-points hash changed → all rows re-scored.
  - `prepare --phase pre --batch 5` returns top-5 by `fit_cached` DESC, FIFO inside ties.
  - TSV upgrade v2 → v3 round-trip on a 100-row fixture.
- **Manual smoke** on Jared profile after enabling:
  - Run `fit-prerank-backfill --profile jared`. Verify `.fit-state/last_scored.json` populated, total cost in expected range ($1.00–$1.50).
  - Inspect top-20 by `fit_cached`. Manually verify ≥15 are jobs the user would actually want prepared next.
  - Run `prepare --phase pre --batch 20`. Confirm Stripe / Affirm / similar S-tier roles appear in the picked batch.
  - Edit `memory/resume_key_points.md`, re-scan. Confirm full re-score triggers.

## 9. Tier and approval

**Tier M-L.** Touches scan flow, adds an LLM dependency to a previously deterministic step, introduces ongoing cost. RFC required (this doc). Code work paused until explicit user approve. Implementation order once approved:

1. Schema v3 + auto-upgrade in `applications_tsv.js` + tests.
2. `fit_prerank.js` heuristic scorer + tests.
3. `fit_prerank.js` LLM scorer + Anthropic client wiring + tests.
4. Scan integration + concurrency cap.
5. `prepare` sort change + tests.
6. `fit-prerank-backfill` CLI command.
7. Smoke on Jared, then Lilia.
8. Update [SKILL.md](../skills/job-pipeline/SKILL.md), [CLAUDE.md](../CLAUDE.md), close BACKLOG entry.

## 10. References

- [engine/core/applications_tsv.js](../engine/core/applications_tsv.js) — TSV schema, v1 → v2 upgrade pattern to mirror.
- [engine/core/jd_cache.js](../engine/core/jd_cache.js) — JD body source for prompt input.
- [engine/commands/prepare.js](../engine/commands/prepare.js) — sort change lives here.
- [engine/commands/scan.js](../engine/commands/scan.js) — hook insertion point.
- [skills/job-pipeline/SKILL.md](../skills/job-pipeline/SKILL.md) — current prepare-step-7 fit-scoring (post-RFC, will be updated to mention drift-detection write-back).
- [scripts/stage18/generators/profile_json.js](../scripts/stage18/generators/profile_json.js) — adds default-off `fit_prerank` block for new profiles.
- [rfc/001-multi-profile-architecture.md](001-multi-profile-architecture.md) — engine vs profile separation; `fit_prerank` lives in engine, configured per profile.
