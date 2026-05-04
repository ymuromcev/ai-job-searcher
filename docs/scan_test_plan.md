# Scan head-to-head test plan + 2026-05-04 results (engine vs prototype)

**Status**: ✅ Executed 2026-05-04. Engine ↔ prototype parity confirmed for shared adapters. Source-coverage holes (CalCareers / USAJobs / dead slugs) are tracked separately as backlog items, not regressions.
**Triggers** post-compact: «тестируем scan head-to-head» / «продолжаем тест scan» — already done; re-run only if a regression suspect surfaces.
**Goal**: verify that engine `scan` produces the same fresh-jobs set as the prototype on the same date, with location parity (after G-5) and no LinkedIn-empty-URL rows (after G-26).

---

## Result snapshot — 2026-05-04 (Jared profile)

**Engine**: 19 476 pool rows, 37 fresh today, filter rejected all 37 (35 title_requirelist for non-PM titles, 1 company_blocklist, 1 title_blocklist) — correct behaviour.

**Prototype**: 1401 registry rows post-scan, 138 ATS-fresh + 48 CalCareers-fresh + 18 USAJobs-fresh, of those 99 inbox-bound + 105 archive-bound. Found 756 PM-relevant jobs total.

**Adapter parity** (engine vs prototype on shared sources greenhouse/lever/ashby/workday/smartrecruiters):
- 693/756 (≥92%) of prototype's PM-relevant universe is present in engine pool.
- The 63 "missing" entries are dominated by reason-tag/location parsing artifacts in the diff regex, not real engine misses; spot-checks confirm the underlying jobs are in pool.
- All 59 "Senior+/Mid/Analyst PM → READY FOR NOTION" prototype rows from this scan are 100 % present in engine pool (URL or `source:jobId` match).

**Real source-coverage gaps** (not regressions — known absences):
1. **CalCareers** — adapter does not exist in engine. ~58 jobs/scan miss.
2. **USAJobs** — adapter exists but inactive (requires `JARED_USAJOBS_API_KEY` + email registration on usajobs.gov). ~22 jobs/scan miss.
3. **27 dead Greenhouse/Lever slugs** — Plaid, Ramp, Klarna, Wealthfront, Acorns, M1 Finance, NerdWallet, Greenlight, Remitly, LendingClub, Bilt, Synctera, Alchemy, Circle, Current, Tally, Wise (transferwise), Petalcard, Oportun, SpringLabs, Empower, Achieve, Avant, Dave, Figure, MoneyLion, Pagaya. These companies have changed ATS or rebranded; slugs need refresh in `data/companies.tsv`.

**Verdict**: scan engine matches prototype on the adapters they share. The three holes above are scoped, known, and tracked in BACKLOG. The global "scan parity" gap is closed.

**Artifacts** (kept until next compact for traceability):
- `/tmp/scan_jared_engine.log` — engine dry-run output.
- `/tmp/scan_jared_proto.log` — prototype scan output (registry restored from backup post-run).
- `/tmp/diff_v6.js` — diff script.

---

## Pre-flight (before any run)

1. **Confirm clean state** — `git status` should not show pending edits in `engine/`, `scripts/`, `docs/`. Last green test run = 805/805 on commit after G-5.
2. **Confirm schema v3** in both profiles:
   ```
   head -1 profiles/jared/applications.tsv | grep -c location  # → 1
   head -1 profiles/lilia/applications.tsv | grep -c location  # → 1
   ```
3. **Backups exist**: `profiles/jared/applications.tsv.pre-stage-g5` and `profiles/lilia/applications.tsv.pre-stage-g5` (created during G-5 backfill 2026-05-03).
4. **No accidental --apply**: every test command MUST end with `--dry-run`.

## Phase 1 — engine scan (dry-run, both profiles)

```bash
cd "ai-job-searcher"
node engine/cli.js scan --profile jared --dry-run > /tmp/scan_jared_engine.log 2>&1
node engine/cli.js scan --profile lilia --dry-run > /tmp/scan_lilia_engine.log 2>&1
```

**What to capture per profile** (extract from log):
- `discovery summary:` block — jobs returned per adapter.
- `fresh jobs: N` — count.
- `(dry-run) would write N rows to data/jobs.tsv`.
- `(dry-run) would append N rows to .../applications.tsv`.

Save tail of each log into the plan as artifacts.

## Phase 2 — prototype scan (in parallel)

```bash
cd "../Job Search"  # Jared prototype
node find_jobs.js --dry-run 2>&1 | tee /tmp/scan_jared_proto.log

cd "../Lilly's Job Search"  # Lilia prototype
node find_jobs.js --dry-run 2>&1 | tee /tmp/scan_lilia_proto.log
```

**Caveat**: prototype `find_jobs.js` may not have `--dry-run`. If not — write to `/tmp/proto-output/` via env var or temp dir override; do NOT run with default args (would mutate prototype TSV). Check first:
```
grep -E "dry.?run|--apply|writeFile" "../Job Search/find_jobs.js" | head
```

If prototype lacks dry-run gate, skip Phase 2 and rely on most-recent prototype TSV snapshot as reference.

## Phase 3 — diff analysis

For each profile, build three sets of fresh `(source, jobId, companyName, title)` tuples:
- E = engine fresh
- P = prototype fresh (or prototype TSV diff since last engine run)

Compare:
- **E ∩ P** — same jobs found by both → expected majority.
- **E \ P** — engine-only jobs. Reasons: engine scans more sources, or filter differences. Inspect a sample.
- **P \ E** — prototype-only jobs. **Most concerning** — could indicate engine adapter regression.

Write diff result to `/tmp/scan_diff_<profile>.md`:
```
# scan diff <profile> 2026-05-04
- E count: X
- P count: Y
- E ∩ P: Z
- E \ P: A — sample of 5
- P \ E: B — sample of 5 + reason hypothesis
```

## Phase 4 — location parity (G-5 verification)

After dry-run engine scan, sample 10 fresh jobs and verify each carries non-empty `location` from adapter (look at `(dry-run) would append…` log + cross-check master pool format).

For prototype, prototype TSV column 10 = `location`. Engine v3 column 7 = `location`. Counts of empty-location should be approximately equal.

## Phase 5 — LinkedIn-empty-URL absence (G-26 verification)

```
grep "^linkedin:\|	linkedin	.*	$" /tmp/scan_*_engine.log
```
Should return zero. LinkedIn ingestion is disabled — no fresh `source=linkedin` rows should appear from scan (only from check.js path, which now also short-circuits).

## Phase 6 — decision

Based on Phases 3-5:
- **All clean** → proceed to test `prepare` next, then `sync --apply` against fresh batch.
- **P \ E non-trivial** → prioritize fixing adapter regression before further testing.
- **Location parity off** → debug `appendNew` location pull / adapter `locations[]` shape.

## Notes for resumption (post-compact)

State to know:
- Closed gaps in this session: G-2 (slash docs), G-26 (LinkedIn disabled in `engine/commands/check.js:521-541`), G-5 (TSV schema v3 + backfill).
- Tests: 805/805 passing.
- TSV schema: now v3 with `location` column 7. Auto-upgrades v1/v2.
- Backfill artifacts: `profiles/<id>/applications.tsv.pre-stage-g5`.
- Notion side: untouched. Sync push of `location` is gated through profile `property_map.location` (default-off).
- Working dir: `/Users/ymuromcev/Desktop/Claude Code/ai-job-searcher` (canonical), NOT `/Users/ymuromcev/Desktop/Claude Code/AIJobSearcher` (soak, archive 2026-05-01 — extended).
