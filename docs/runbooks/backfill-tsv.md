# Backfill applications.tsv

Backfill `profiles/<id>/applications.tsv` from prior data sources. Use
this when onboarding a candidate with application history, when
recovering from corruption, or when migrating from a prototype Notion
workspace into the engine.

The current canonical format is schema v2 (fifteen columns, including
`salary_min`, `salary_max`, and `cl_path`). The loader auto-upgrades
v1 rows on read, but every backfill writes v2.

## 1. When to backfill

- **Onboarding with history.** A candidate maintained a manual sheet
  or a prototype Notion DB before joining the engine; their old rows
  should appear in the new TSV without re-applying.
- **Recovery.** The TSV got corrupted, partial-write, or the
  maintainer needs to roll back to a known good snapshot.
- **Prototype migration.** A prototype Notion workspace is being
  retired and its rows need to land in the engine's new Jobs DB.

## 2. Pre-flight backup

Always snapshot the current TSV before any backfill. The convention is
a date-stamped sibling file:

```bash
cp profiles/<id>/applications.tsv \
   profiles/<id>/applications.tsv.pre-backfill-$(date +%Y-%m-%d)
```

This makes rollback a single `mv` away. The Stage 16 migration uses
the same convention (`applications.tsv.pre-stage16`,
`applications.tsv.pre-migrate-2026-04-27`).

## 3. From a prototype Notion workspace

Two scripts. First, snapshot the prototype Jobs DB to JSON:

```bash
node scripts/stage18/fetch_prototype_notion_jobs.js \
  --source-db <prototype-db-id> \
  --out profiles/<id>/.stage16/prototype_jobs.json
```

Then transform the snapshot into v2 rows and merge into the profile's
TSV:

```bash
# Dry run.
node scripts/stage18/migrate_tsv_from_prototype.js \
  --profile <id> \
  --in profiles/<id>/.stage16/prototype_jobs.json

# Apply.
node scripts/stage18/migrate_tsv_from_prototype.js \
  --profile <id> \
  --in profiles/<id>/.stage16/prototype_jobs.json \
  --apply
```

The migration script writes `applications.tsv.pre-stage16` next to
the new TSV and a `push_manifest.json` under
`profiles/<id>/.stage16/`. The manifest tracks which rows are
migration-only (no Notion page yet) so `sync` can be gated against
re-creating pages already in the prototype.

## 4. From a CSV or external sheet

There is no generic CSV adapter. Write a one-shot script that uses
`scripts/stage18/_common.js` for shared helpers (profile-id parsing,
Notion page-id extraction, state IO) and `engine/core/applications_tsv`
to append rows. Always emit schema v2; the loader will not silently
upgrade an external feed.

A typical one-shot looks like:

```js
const { appendNew } = require("../../engine/core/applications_tsv.js");
const rows = parseCsv("/path/to/old-export.csv");
for (const r of rows) {
  appendNew(profileId, {
    company: r.company,
    title: r.title,
    url: r.url,
    status: "Applied",
    /* salary_min, salary_max, cl_path, etc. */
  });
}
```

Save the script under `scripts/` with a date-stamped filename and a
short header comment so future maintainers know it was a one-shot.

## 5. Dedup safety

`engine/core/dedup.js` enforces uniqueness by canonical URL plus
`(company, title)` fallback. The migration scripts call into the same
module. If the source data has multiple postings for the same role,
the dedup pass collapses them to one row; spot-check the resulting
counts against the source to confirm.

## 6. Push manifest gating

After a backfill, `sync` would normally try to create a Notion page
for every TSV row without a `notion_page_id`. The migration writes
`profiles/<id>/.stage16/push_manifest.json` with the explicit allow-set
so historical rows that were never in the prototype Notion stay out of
the new DB. `sync.js`'s `planPush` reads this manifest automatically
when present.

If you want to push everything, delete the manifest after backfill.
If you want to push only a subset, edit the manifest's `allowKeys`
array.

## 7. Verify

Three checks:

1. **Counts.** Compare the source row count against the v2 row count;
   subtract dedup losses and empty rows to reach a clean reconcile.
2. **Spot-check.** Pull five random rows and confirm the company,
   title, URL, and status round-trip correctly.
3. **Validate.** Run the engine's pre-flight:

```bash
node engine/cli.js validate --profile <id>
```

Fix any TSV-hygiene errors before the next `scan`.

## See also

- [TSV schema reference](../reference/tsv-schema.md)
- [RFC 014 — status split: New vs To Apply](../../rfc/014-status-split-new-vs-toapply.md)
