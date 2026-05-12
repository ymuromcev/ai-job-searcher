# RFC 024 — `prepare`: Inbox-health signal + skill-side `scan` prompt

**Status**: accepted
**Related**: [BL-28](../private/backlog/BL-28.md), [RFC 022](022-prepare-commit-atomic-notion.md), [RFC 014](014-status-split-new-vs-toapply.md)
**Created**: 2026-05-12
**Accepted**: 2026-05-12 — user approved as written

## Problem

`prepare --phase pre --batch <target>` is a best-effort batch builder: it
pulls the whole Inbox once, drops rows via filters (company_cap,
title_requirelist/blocklist, already_evaluated_*, geo_*), URL-checks
the survivors, and emits up to `target` "alive" candidates. When the
post-filter survivor pool is smaller than `target`, the batch comes out
short — by design (see `prepare.test.js:637` `(G-12): pool exhausted`).

Live smoke 2026-05-11 (jared, target=30): batch came out as 26.
Initial hypothesis (BL-28): "prepare didn't iterate Inbox-pull 3×".
Investigation (BL-28, 2026-05-11) disproved that — Inbox is read
exhaustively (`applications_tsv.js:377-405`, `prepare.js:523-537`); a
single pull is the entire queue. The shortfall came from
`passed.length === 28 < target === 30`, with 2 dead URLs on top. There
was nothing to top up from: `deferredQueue.length === 0`, and
`--mode topup` reads only the deferred queue.

The current `runPre` already prints a `skip reasons — ...` breakdown
(`prepare.js:670`), but:

1. The breakdown is buried in stdout, not surfaced into
   `prepare_context.json` in a structured way the SKILL can read.
2. There's no forward-looking signal — the operator only sees "you got
   26 this run", not "your next run will start short too unless you
   `scan` first".
3. SKILL `/job-pipeline` has no step to act on Inbox-health and either
   advise or run `scan`.

Result: the user closes a session at 26/30, the next session repeats
the same shortfall, throughput stays at ~20–26 per day.

## Root cause

Two missing pieces, not a single one:

- **Engine doesn't expose forward-looking Inbox health.** It exposes
  `stats.skipReasons` and `stats.deferred` in `context.stats`
  (`prepare.js:651-663`), but doesn't synthesize a "would the next
  prepare hit target?" signal.
- **SKILL doesn't read or act on Inbox health.** The `/job-pipeline`
  flow ends at sync. Nothing prompts the operator to refresh Inbox
  when it's running low.

This is a **visibility** problem, not a throughput-iteration bug. The
filter drops are the operator's own product policy
(`profiles/<id>/filter_rules.json`), and the engine has already done
the work of surfacing them — just not in the right place.

## Decision

Add a forward-looking Inbox-health field to `prepare_context.json`
written by `runPre`, and a final step in `skills/job-pipeline/SKILL.md`
that reads it. If the next `prepare` is expected to start short, the
SKILL asks the operator whether to run `scan` now; otherwise it stays
silent.

No engine-side auto-`scan`. No filter-rule changes. No new CLI mode.

## Spec

### `inbox_health` field in `prepare_context.json`

Added to the existing `prepare_context.json` shape that `runPre`
writes (`prepare.js:692`). Sits next to `stats`, not inside it (so it
can grow into a first-class concern later).

```js
inbox_health: {
  status: "healthy" | "low",
  // "low" when remaining_viable < target; "healthy" otherwise.
  remaining_viable: <integer>,
  // Count of rows that passed filters and the already-evaluated check
  // but were not URL-checked / not selected for this batch. =
  // deferredQueue.length after fillUpAliveBatch returns. These are
  // the rows that next prepare's runPre could draw on without any
  // new scan.
  target: <integer>,
  // batchSize used for this run. Echoed for context.
  short_by: <integer>,
  // max(0, target - remaining_viable). 0 when healthy.
  in_batch: <integer>,
  // aliveResults.length actually written into this batch.
  drops_this_run: {
    // Aggregated from stats.skipReasons + the dead-URL count from
    // fillUpAliveBatch. Sums of integers. Zero-keys may be omitted
    // for readability; SKILL must treat missing keys as 0.
    company_cap: <integer>,
    title_requirelist: <integer>,
    title_blocklist: <integer>,
    company_blocklist: <integer>,
    already_evaluated_weak: <integer>,
    already_evaluated_duplicate: <integer>,
    geo_country: <integer>,
    geo_us_state: <integer>,
    geo_remote_only: <integer>,
    url_dead: <integer>
  },
  recommendation: "run_scan" | null
  // "run_scan" iff status === "low". Single field so SKILL has one
  // place to branch; future recommendations (e.g. "loosen
  // filter_rules") add new enum values.
}
```

**Definition of "viable for next prepare":** rows that, today, would
survive `applyPrepareFilter` and would not be skipped by
`filterAlreadyEvaluated`. These are exactly the `deferredQueue` rows
written at `prepare.js:623`:

```js
deferredQueue: passed.slice(consumed).map((a) => a.key)
```

Rows we deliberately exclude from "viable":

- `filteredOut` rows — they'll be filtered again next run.
- `already_evaluated_weak` rows — only reachable via
  `--mode weak-fallback`, not standard `runPre`.
- `url_dead` rows — flipped to `URL Dead` status by `runCommit`
  (or marked in TSV regardless of phase outcome).
- Rows already consumed into this batch — they transition out of
  `Inbox` during `runCommit`.

### CLI stdout

After the existing `skip reasons — ...` line, `runPre` prints one
extra line:

```
inbox health: <status> (<remaining_viable> viable for next run, target <N>)
```

Examples:

```
inbox health: low (12 viable for next run, target 30)
```

```
inbox health: healthy (47 viable for next run, target 30)
```

No banner, no recommendation in stdout — the SKILL handles the
"should we scan" UX. Standalone CLI users (no SKILL) see the same
single line and can decide for themselves; the structured field in
`prepare_context.json` is for automation.

### `/job-pipeline` SKILL: final step

Today the SKILL ends at sync. New trailing step **after the post-sync
summary** (so the user has already seen "26 to Notion as To Apply"):

1. Read `inbox_health` from `prepare_context.json` (same file the
   SKILL already reads in Step 4 / 5).
2. If `inbox_health.status === "healthy"` → no action, end session.
3. If `inbox_health.status === "low"`:
   - Print a Russian-language summary (this SKILL is operator-facing
     and the operator works in Russian by convention; the SKILL copy
     stays in whatever language the file already uses):

     ```
     Inbox низкий: после этого батча подходящих кандидатов осталось
     <remaining_viable> при target=<target>. Следующий prepare стартует
     с недобором (<short_by>).

     Drops this run: <comma-separated non-zero drops_this_run keys with
     counts>.

     Запустить `scan` сейчас, чтобы натащить новых вакансий? (y/n)
     ```

   - On `y` → run `node engine/cli.js scan --profile <id>`, show
     stdout tail to the operator. Done.
   - On `n` / anything else → end session, no action.

The SKILL does NOT auto-rerun `prepare` after a scan. That stays the
operator's next-session decision.

### Threshold

Single fixed threshold: `remaining_viable < target`. Not configurable.

Rationale: target IS the threshold the operator has already chosen
(via `--batch`); a coefficient (e.g. 1.5×) would be a second
configurable that nobody would tune. If a profile wants a different
cushion, the operator changes `--batch`.

## Non-goals

- **Auto-scan.** Network-heavy, has its own caching/rate-limit nuance;
  the operator is the right gate.
- **Auto-loosen filter_rules.** Filter rules are profile-owned policy;
  RFC won't touch them.
- **Re-pulling Inbox during `runPre`.** Inbox is already exhaustive;
  there's nothing extra to pull.
- **Weak-fallback as a top-up source.** It's a post-Claude-evaluation
  mechanism and wasting a Claude eval on rows already known to be
  Weak is a regression, not a feature.
- **Changing `--mode topup` semantics.** That CLI is still useful for
  the deferred-queue case (when `passed > target` and you want to
  consume the leftovers in a second session); RFC leaves it alone.

## Backward compatibility

- `prepare_context.json` gains a new top-level field. Existing readers
  (the SKILL itself, `runCommit`, `prepare.test.js`) ignore unknown
  fields, so adding `inbox_health` is non-breaking.
- `runPre` stdout gains one line. No grep contract in tests; safe.
- Existing `(G-12): pool exhausted` test stays green — it asserts on
  batch size, not on context shape. We add new tests for
  `inbox_health` next to it.

## Test plan

`engine/commands/prepare.test.js`:

1. **`inbox_health: status="healthy" when deferredQueue >= target`**
   — set up a fixture where `passed.length > batchSize` and assert
   `context.inbox_health.status === "healthy"`,
   `remaining_viable === deferredQueue.length`, `short_by === 0`,
   `recommendation === null`.

2. **`inbox_health: status="low" when deferredQueue < target`** — the
   BL-28 scenario. `passed.length === batchSize - 2`, 2 dead URLs.
   Assert `status === "low"`, `remaining_viable === 0`,
   `short_by === target - 0`, `recommendation === "run_scan"`.

3. **`inbox_health.drops_this_run aggregates skipReasons + dead`** —
   fixture with one of each drop reason. Assert
   `drops_this_run.company_cap === 1`,
   `drops_this_run.url_dead === 1`, etc.

4. **`inbox_health.in_batch matches aliveResults length`** — sanity
   cross-check.

5. **`inbox_health: target=0 edge case`** — defensive: if a future CLI
   call uses `--batch 0`, `status === "healthy"` (vacuously, no
   shortfall possible). Don't crash on division etc.

6. **Stdout includes the `inbox health:` line.** Capture stdout of
   `runPre` in test mode, assert the line is present.

`skills/job-pipeline/SKILL.md` lives in skill territory — no
automated tests against the SKILL prose. Smoke-tested by the live
run on jared at the end (Plan step 6).

## Risks

- **SKILL drift**: if `inbox_health` shape changes later and SKILL
  copy doesn't follow, the prompt will reference stale fields. Mitigation:
  the SKILL step quotes specific field names (`inbox_health.status`,
  `inbox_health.recommendation`); a future RFC that renames them adds
  a SKILL diff to its checklist.
- **False positives (low but operator doesn't want scan)**: if filter
  rules are deliberately strict and the operator is fine with 20/day,
  the SKILL will nag every run. Mitigation: the prompt is a single
  y/n line at the end of a session — `n` ends immediately, no cost.
- **Definition of "viable" oversimplified**: deferredQueue counts
  rows that passed filters but weren't URL-checked. Some of those
  will turn out to have dead URLs on the next run and would have
  shrunk further. We accept the optimistic count — operator sees
  "<= N viable", reality may be lower. Recommendation flag is
  conservative direction (recommends scan when uncertain).

## Plan

1. Accept this RFC (await user `ok`).
2. Add `inbox_health` build + write inside `runPre` (`prepare.js`).
3. Add stdout line.
4. Add unit tests (six cases above).
5. Add SKILL step to `skills/job-pipeline/SKILL.md`.
6. Smoke on jared (target=30) — verify the chat asks about scan
   when (and only when) `remaining_viable < target`.
7. Commit + push.

## Open questions

None as of draft.
