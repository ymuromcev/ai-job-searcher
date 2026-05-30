# RFC 056 — Reprocess historical rejection backlog

- Status: **proposed**
- Date: 2026-05-30
- Refs: BL-156, RFC 055 (cron TSV sync + heartbeat), RFC 021 (gmail IMAP), RFC 014 (status split)
- Tier: M

## Problem

RFC 055 fixed the cron going forward: `check --auto` now reconciles the
full active set from Notion before searching Gmail. Deployed and live on
2026-05-30 (success heartbeats confirm it).

But a 30-day verification backfill produced **0 status transitions** for
jared (heartbeat: emails 10 / matched 10 / Rejected 0) and 0 emails for
lilia. Root cause, code-grounded:

1. The Gmail search includes an **ATS-sender batch**
   ([check.js:296](../engine/commands/check.js), `buildBatches`) that
   fetches mail from Greenhouse / Lever / etc. **regardless** of whether
   the company is in `activeJobsMap`.
2. `applyMutations` writes **every** fetched email into
   `processed_messages.json` ([check.js:757](../engine/commands/check.js)),
   including those that matched no active job (`match=NONE`).
3. `runAutoBody` filters already-processed message ids out **before**
   matching ([check.js:980](../engine/commands/check.js)).

So while the fly active set was stale (weeks), ATS rejections for
untracked jobs were fetched, matched NONE, and recorded as processed. A
normal re-run skips them, and the now-expanded active set never gets to
match them. The historical rejection backlog is locked in
`processed_messages.json`.

## Goal

A one-time, idempotent recovery that re-matches the locked historical
emails against the reconciled (full) active set, flipping the jobs that
actually got a rejection to **Rejected** in Notion — without duplicate
comments and without touching jobs already at a terminal status.

## Approach

### New flag: `check --reprocess-since <ISO>`

Behaves like `--since <ISO>` (sets the cursor epoch) **plus** bypasses
the `processed_messages.json` dedup filter for the window:

```js
const newEmails = flags.reprocessSince
  ? rawEmails.filter((e) => e && e.messageId)            // bypass dedup
  : rawEmails.filter((e) => e && e.messageId && !processedSet.has(e.messageId));
```

Everything downstream is unchanged. Re-saving `processed_messages.json`
at the end stays idempotent (same ids re-recorded).

### Idempotency — already structurally guaranteed for status changes

No new guard needed for the rejection path:

- `buildActiveJobsMap` only includes statuses ∈ {To Apply, Applied,
  Interview, Offer}. A job already **Rejected**/**Closed** in Notion is
  reconciled into the fly TSV as such (RFC 055 additive pull) and is
  therefore **absent from `activeJobsMap`** → never matched → never
  re-acted.
- Even if a stale row slips through, `processPipeline` skips when
  `SKIP_STATUSES.has(job.status)` ([check.js:517](../engine/commands/check.js)).

So re-fetching an already-handled rejection is a no-op: its job isn't
active, so it produces no action.

### The one real duplicate risk: `comment_only`

`INFO_REQUEST` emails produce `kind: "comment_only"`
([check.js:579](../engine/commands/check.js)) with **no** status guard.
Bypassing dedup would re-post the "📋 info request" comment for any
info-request email already processed.

Mitigation (chosen): **during reprocess, drop `comment_only` actions** —
apply only `status+comment`. Recovery targets rejections (and
position-closed / interview transitions), which are the time-durable
signals. Historical info-requests are stale and not worth a duplicate.
One added line in `applyMutations`/action assembly, gated on
`flags.reprocessSince`.

### Forward precision (small additive schema bump, optional)

Record `match` on each processed entry going forward
([check.js:757](../engine/commands/check.js) add `match: r.match || "NONE"`).
This lets a *future* `--reprocess-since` re-include only never-matched
emails (precise), without the blanket `comment_only` drop. Pure-additive;
old entries simply lack the field. Include if cheap; not required for the
one-time recovery.

## Verification-first rollout (addresses the unconfirmed diagnosis)

The 0-transitions diagnosis is code-grounded but **not box-verified**
(SSH blocked by operator network). The dry-run IS the confirmation:

1. Land code, redeploy fly.
2. **Dry-run** `check --profile jared --reprocess-since 2026-04-29T00:00:00Z`
   (no `--apply`): re-fetches the window, bypasses dedup, reports how
   many status transitions *would* happen. No Notion writes.
   - If it reports `→ Rejected: N` with N ≫ 0 → hypothesis confirmed AND
     recovery scope is known before any mutation.
   - If N == 0 → hypothesis wrong (active set didn't expand on the box);
     stop and investigate the reconcile path instead.
3. If sane, run with `--apply` for jared + lilia.
4. Confirm heartbeats show non-zero `→ Rejected: N`; spot-check a few
   flipped jobs in Notion.

Execution mechanism (SSH blocked): one-off cron tick (add line, deploy,
fire, revert, clean redeploy) — same pattern used for the RFC 055
backfill — or an operator SSH from an un-proxied network.

## Test plan

- `runAutoBody`: with `flags.reprocessSince`, processed ids in the
  window are NOT filtered (re-included); without it, dedup unchanged.
- Idempotency: a processed REJECTION whose job is already Rejected
  (absent from active map) yields no action on reprocess.
- `comment_only` drop: an `INFO_REQUEST` re-fetched under reprocess
  produces no comment action; under a normal run it still does.
- A genuinely-recoverable case: stale processed entry + job present and
  Active in the (expanded) map + rejection email in window → reprocess
  emits exactly one `status+comment` → Rejected.
- Arg parse: `--reprocess-since <ISO>` sets cursor + flag; bad/missing
  value errors clearly; mutually-sane with `--apply`.
- All network mocked. `npm test` green incl. `prettier --check .`.

## NOT in scope

- Daily cron behaviour (fixed under RFC 055).
- Rejections older than the Gmail search window (`after:` epoch).
- Retroactive Interview/Offer beyond existing classifier logic.
- A standalone push path or any Notion write outside `applyMutations`.

## Why not alternatives

- **Manually prune `processed_messages.json` on the volume**: needs
  container file surgery (SSH blocked), is destructive, and loses the
  dedup safety for `comment_only`. The flag is reusable and testable.
- **Clear all of `processed_messages.json`**: re-posts every historical
  `comment_only` and re-walks everything; blunt and duplicate-prone.
- **Query Notion per email to dedup comments**: heavy, and unnecessary
  given the active-set filter already covers the status path.
