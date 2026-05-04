# Scan head-to-head test plan (engine vs prototype)

**Status**: drafted 2026-05-04, after closing scan-related gaps G-2/G-26/G-5.
**Triggers** post-compact: «тестируем scan head-to-head» / «продолжаем тест scan».
**Goal**: verify that engine `scan` produces the same fresh-jobs set as the prototype on the same date, with location parity (after G-5) and no LinkedIn-empty-URL rows (after G-26).

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
