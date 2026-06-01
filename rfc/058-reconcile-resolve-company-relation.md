# RFC 058 — Reconcile must resolve the Company relation to a name

- Status: **accepted** (shipped 2026-06-01, fly v29; 16 missed rejections recovered)
- Date: 2026-06-01
- Refs: BL-168, RFC 055 (cron TSV freshness — the incomplete fix), BL-154
  (additive reconcile), RFC 014 (status split)
- Tier: M

## Problem

Operator-reported (2026-06-01): a real dLocal rejection
("Senior Product Manager - Pix Squad", `no-reply@hire.lever.co`, arrived
06:50 PT) was never reflected in Notion, and the cron has been silently
dropping responses for ~2 days.

Confirmed live on the fly box (`ai-job-searcher-cron`, release v28 —
post-BL-154, so the reconcile code IS deployed):

- The Pix Squad row exists on `/data/.../applications.tsv` with
  `status=Applied`, `notion_page_id` set — **but `companyName` is empty**.
- `buildActiveJobsMap` ([check.js](../engine/commands/check.js)) drops any
  row with no `companyName` (`const co = app.companyName; if (!co) continue;`).
  So the row is excluded from the active set → the dLocal email is fetched
  by the ATS-sender batch (Lever) but matches no active company → no action.
- This is not one row: **215 active rows on the fly volume have an empty
  `companyName`** (vs 117 populated). Every one is invisible to the email
  matcher.

### Root cause

BL-154 made `reconcilePull` ([sync.js:63](../engine/commands/sync.js))
additive: it appends a full v5 row for each Notion page with no local
match. The add-row sets `companyName: page.companyName || ""`.

But jared's (and lilia's) Notion stores company as a **relation**
(`property_map.companyRelation = { field: "Company", type: "relation" }`),
not a text field. `parseNotionPage`
([notion_sync.js:140](../engine/core/notion_sync.js)) therefore produces
`page.companyRelation = [companyPageId]` and **no `page.companyName`**. So
every reconcile-added row gets `companyName: ""`.

On the Mac the same rows are fine because they were created by `scan`
(which carries `companyName` from the ATS posting); the reconcile only
hits the *update* path there and never overwrites the existing name. On
fly the rows never existed locally, so they hit the *add* path and land
empty. Net: BL-154 added the rows the cron was missing, but added them
inert — the very problem it set out to fix remains for every
relation-company profile.

## Goal / what changes for the operator

- The fly cron's daily reconcile populates `companyName` on
  reconcile-added rows (and backfills the 215 already-empty ones), so
  every active Notion application becomes matchable again.
- After fix + redeploy, a one-off `check --auto --apply --reprocess-since
  <date>` recovers the rejections/invites missed during the broken window
  (including dLocal Pix Squad → Rejected).
- No behaviour change for text-company profiles (`_example`) or for the
  Mac, where `companyName` is already present.

## Design

### 1. Reverse company resolver (id → name)

`company_resolver.js` already does name → page-id. Add a thin reverse
helper (same file or `notion_sync.js`) that, given a set of Companies-DB
page-ids, fetches each page once and reads its title (`Name`) into a
`{ pageId → name }` map. In-run cache; bounded concurrency; a missing /
untitled page resolves to `null` (left empty, counted in a warn).

### 2. `reconcilePull` stays pure; sync command resolves first

`reconcilePull` must remain pure (no I/O — tests depend on it). Add an
optional `companyNameById` map argument:

- **Add path:** `companyName = companyNameById[firstRelationId] ||
  page.companyName || ""`.
- **Update path (backfill):** if the existing local row's `companyName`
  is empty **and** a resolved name exists, set it and mark `changed`
  (so the 215 stale rows self-heal on the next reconcile — no separate
  migration script).

The `sync` command (which owns the Notion client) collects the relation
ids it needs — from would-be adds **and** from existing rows whose
`companyName` is empty — resolves them via the reverse resolver, and
passes the map into `reconcilePull`. Resolution is skipped entirely when
the profile's `property_map` has no `companyRelation` (text-company
profiles take the existing `page.companyName` path unchanged).

### 3. Cost

One `pages.retrieve` per unique company id, only for ids actually needed.
The backfill reconcile resolves ~200 ids once; subsequent daily reconciles
add few rows → a handful of lookups. Acceptable for a once-daily cron.

## Definition of Done

- Reverse resolver: unit-tested with a faked client (cache hit, missing
  page → null, untitled page → null).
- `reconcilePull`: add-path and empty-update-path populate `companyName`
  from the map; non-empty existing names never overwritten; pure (no I/O);
  idempotent on rerun; text-company path (no `companyRelation`) unchanged.
- `sync` command: resolves only needed ids; `--no-sync` parity unaffected;
  Notion/resolver errors are non-fatal (logged, reconcile proceeds with
  whatever resolved).
- Smoke: local `sync --apply` against jared backfills empty companyName on
  reconcile-added rows; `check --auto --no-sync` then matches a Lever
  rejection to its row.
- Network mocked in all unit tests.
- After merge + redeploy: empty-company active count on fly drops to ~0;
  a `--reprocess-since` run sets dLocal Pix Squad → Rejected.
- `incidents.md` entry (blameless): BL-154 add-path missed relation
  resolution; 215 inert rows; how caught (live fly inspection).

## Out of scope (separate follow-up BL)

Monitoring robustness so a future silent miss is visible: reflect
reconcile failure in the heartbeat, and log "ATS email fetched but
unmatched". Tracked separately — not bundled into this fix.
