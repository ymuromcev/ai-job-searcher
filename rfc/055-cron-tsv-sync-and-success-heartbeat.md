# RFC 055 — Cron TSV freshness + success heartbeat

- Status: **proposed**
- Date: 2026-05-29
- Refs: BL-154, BL-155, RFC 054 (auto-sync + archive), RFC 021 (gmail cron IMAP), RFC 005 (cron autonomous check + failure notify), RFC 014 (status split)
- Tier: M

## Problem

Operator-reported (2026-05-29): "rejections show up in Gmail but Notion
gets only one comment per day, and Notion only ever logs the cron when a
run *fails*."

Two distinct root causes, both in the fly.io `check --auto` cron path.

### P1 — the cron tracks a stale, divergent copy of the application set

`check --auto` builds its Gmail search from `buildActiveJobsMap(apps)`
([check.js:181](../engine/commands/check.js)), where `apps` is read from
the fly volume's `profiles/<id>/applications.tsv`. Only companies with an
active row (`status ∈ {To Apply, Applied, Interview, Offer}` **and** a
`notion_page_id`) get searched. A rejection email from a company that
isn't in that map is never even fetched → no Notion comment.

That TSV on the fly volume is effectively frozen:

- New applications are created by `prepare` **on the Mac** (the commit
  phase needs the LLM skill; it never runs on fly). They land in the Mac
  TSV + Notion, never on the fly volume.
- The fly box only ever runs `check`, which writes back status updates
  for emails it *already matched* plus recruiter/linkedin Inbox rows.
- RFC 054's auto-sync pre-hook is wired to `scan` and `prepare` only
  ([cli.js:288](../engine/cli.js)). `check` has no pre-hook, so the fly
  TSV never reconciles against Notion.
- Even if `check` *did* run auto-sync, `reconcilePull`
  ([sync.js:71](../engine/commands/sync.js)) iterates over **existing**
  TSV rows and only updates `status` / `notion_page_id`. It never adds a
  Notion page that has no local row. So a freshly-seeded or stale fly TSV
  cannot learn about applications it doesn't already list.

Net effect: the fly TSV's active set ≈ whatever was active when the
volume was last seeded (~2026-05-12 deploy), decaying as `check` marks a
few Rejected. Local active-with-notion counts on 2026-05-29: **jared 383,
lilia 85** — the fly box tracks a small fraction of these. This is the
same silent-staleness failure class as the Indeed ingest-file incident
(incidents.md, 2026-05-23).

### P2 — Notion only hears about the cron on failure

`runAuto` → `notifyFailure` posts an @-mention comment to
`notion.cron_ops_page_id` **only when the run throws**
([check.js:144](../engine/commands/check.js)). A successful run writes its
summary to stdout (→ fly logs, short-lived) and `email_check_log.md` on
the volume — nothing in Notion. The operator has no Notion-visible signal
that the cron ran at all on a normal day, so a silently-broken cron looks
identical to a quiet inbox.

## Approach

Two independent changes, landing as two PRs under this RFC.

### Change A (P1) — additive reconcile + `check` pre-hook

1. **Make `reconcilePull` additive.** After the existing update pass over
   local rows, append a new TSV row for every Notion page that matched no
   local row, carrying `notion_page_id`, `status`, company, title, and
   the composite/`key` identity used for matching. Source defaults to a
   sentinel (`"notion"`) when the page has no `source` field. New rows
   get `createdAt`/`updatedAt = now`. This makes a `sync --apply` (and
   therefore auto-sync) reconstruct the full active set from Notion, not
   just refresh known rows.

2. **Add `check` to `PIPELINE_PRE_HOOKS`** ([cli.js:288](../engine/cli.js))
   with the same `--no-sync` opt-out and non-fatal error semantics as
   `scan`/`prepare`. Now every cron tick: pull Notion → TSV (additive) →
   build `activeJobsMap` over the *full* active set → search Gmail.

Order matters: the pre-hook runs before `runAuto` reads the TSV, so the
same process sees the freshly-reconciled rows.

Consequence (intended): `scan`/`prepare` also gain additive reconcile.
This is desirable — a fresh checkout or a new machine rebuilds its TSV
from Notion instead of starting blind. The archive sweep already tolerates
rows it doesn't recognise.

### Change B (P2) — success heartbeat to the ops page

Add `notifySuccess({ profile, profileId, summary, now, ... })`, a sibling
of `notifyFailure`. On a successful `--auto --apply` run (both the
zero-new-emails early return and the post-`applyMutations` path), post a
**plain comment (no @-mention)** to `cron_ops_page_id`:

```
🟢 [2026-05-29T08:00:12Z] check jared — emails: 12, matched: 4,
   → Rejected: 2, → Interview: 1, → Closed: 0, info: 1,
   inbox: 0, notion errors: 0
```

- No @-mention → no push notification (failures keep the @-mention +
  push). Avoids daily notification fatigue while leaving a durable trail.
- Posted even on a zero-email day (`emails: 0`) so a missing heartbeat
  means "cron didn't run", not "quiet inbox".
- Best-effort and swallowed, exactly like `notifyFailure`: a heartbeat
  post failure never changes the run's exit code.
- Scoped to `--auto` (the cron path). `--apply`/`--prepare` manual phases
  are unchanged.

## Why not alternatives

- **`check` builds `activeJobsMap` directly from Notion** (skip the TSV):
  decouples cron from TSV freshness entirely, but duplicates the
  Notion-read + property-map logic that already lives in `sync`, and
  changes `check`'s data source in a way that complicates the manual
  `--prepare`/`--apply` two-phase flow. Reusing the existing additive
  reconcile is smaller and keeps one Notion-read path.
- **Operationally copy the Mac TSV to the volume**: fragile, manual, and
  exactly the "operator must remember" pattern that caused the Indeed
  staleness incident.
- **Success @-mention**: rejected for notification fatigue.

## Test plan

Change A:

- `reconcilePull`: unit test — Notion page with no matching local row →
  produces an add (new row with `notion_page_id`, status, company,
  title); existing-row update path unchanged; idempotent on a second run
  (no duplicate add).
- `cli.js`: `check` pre-hook fires unless `--no-sync`; auto-sync throw is
  non-fatal (warn + proceed); `check --auto` after reconcile sees the new
  rows in `activeJobsMap` (integration test with faked sync handler +
  faked Gmail fetch).

Change B:

- `notifySuccess`: posts a no-mention comment when `cron_ops_page_id` is
  set; skips quietly when it's absent or `NOTION_TOKEN` missing; a thrown
  post is swallowed and the run still returns 0.
- `runAuto` success path (zero-email and post-apply) both call
  `notifySuccess` exactly once; failure path still calls `notifyFailure`
  and not `notifySuccess`.

All network mocked (no real Gmail/Notion). Smoke: `npm test` green.

## NOT in scope

- Changing the classifier, the Gmail batch construction, or the
  failure-comment format.
- A push-channel for success (Notion comment only).
- Syncing the two state stores (Mac ↔ fly) wholesale — Notion stays the
  source of truth; additive reconcile is the bridge.
- Re-adding a Notion *push* path from `sync` (RFC 054 removed it; pages
  are still created only by `prepare` commit).

## Rollout

1. Land Change A, redeploy fly (`scripts/deploy_fly.sh`), confirm next
   tick's `email_check_log.md` shows matched rejections for recent
   applications.
2. Land Change B, redeploy, confirm a 🟢 heartbeat comment lands on each
   profile's `cron_ops_page_id`.

Operator verification one-liner (from a shell whose 6pn tunnel works):

```
fly ssh console -a ai-job-searcher-cron --command \
  'tail -40 /data/profiles/jared/email_check_log.md'
```
