---
id: RFC-038
title: TSV schema v5 — persist locations[] as JSON-encoded array
status: proposed
author: Claude (via Jared)
tier: M
created: 2026-05-18
refs:
  - BL-93
  - BL-24
  - BL-81
  - RFC-014
---

# RFC 038 — TSV schema v5: persist `locations[]`

> Naming note: today's "current" header in `applications_tsv.js` is
> already labeled v4 (BL-9 fit columns, 2026-05-05). This RFC proposes
> the next bump as **v5** to avoid collision. BL-93's title says "v4
> locations" — that's a planning shorthand, not the on-disk version.
> See §11 open questions.

## 1. Problem

`engine/modules/discovery/*` adapters return `NormalizedJob.locations`
as an **array** (e.g. `["San Francisco, CA", "Remote (US)", "New York,
NY"]`). The TSV ledger flattens that into a **single string** column
(`location`) by taking `locations[0]` at `appendNew` time
(`applications_tsv.js:445-446`).

Concrete loss:

- Discovery sees `["Remote (UK)", "United States"]`. BL-24's
  "US-anywhere wins" rule fires in `scan` → row kept.
- TSV stores `location = "Remote (UK)"` (first element).
- `prepare`'s geo recheck wraps that into `[app.location]`
  (`prepare.js:225`) and runs `enforceGeo`. The "United States" element
  is gone → row gets archived by geo.
- `validate --apply` reads `app.location` only — same blind spot.

After BL-24 / BL-81 the runtime predicates (`hasUsMarker`, `enforceGeo`)
already accept arrays correctly. The persistence layer is the only
remaining flat-string surface.

## 2. Decision

Schema v5: replace the single `location` (string) column with
`locations` (JSON-encoded string array) in the same TSV slot. Width
unchanged (still 20 columns). All in-memory work continues on
`app.locations: string[]`. The flat `app.location` accessor is gone.

```
old (v4):   ... \t url \t "San Francisco, CA"            \t status \t ...
new (v5):   ... \t url \t ["San Francisco, CA","Remote (US)"] \t status \t ...
```

Header changes column 7 from `location` to `locations`. Reader detects
header and decodes; writer always emits v5.

## 3. Encoding — JSON array vs pipe-separated

| Option | Pros | Cons |
|---|---|---|
| **A. JSON array** `["a","b"]` | Standard escape (quotes, commas, pipes, unicode). `JSON.parse`/`stringify` already used elsewhere (e.g. `results.json`). Round-trips losslessly. | Slightly heavier on the eye when grep'ing the TSV by hand. |
| B. Pipe-separated `a\|b` | Compact, human-readable. | Pipes appear in real ATS strings (rare but happens — e.g. `"Remote \| US"`). Commas / quotes also appear. Custom escape needed. |

**Recommendation: A (JSON array).** The TSV is machine-read; the human
read-path is via Notion. Avoiding a custom escape is worth the visual
cost. `escapeField` still strips `\t\r\n` on write; JSON has no need
for any of those.

Edge cases:

- Empty array → cell contains `[]` (not `""`).
- Reader treats `""` (legacy empty `location`) as `[]`.
- Reader treats a non-JSON string in a v5 row as a single-element
  array (defensive — should not happen from `save()`, but covers hand
  edits).

## 4. Backward compat / migration

Versioning continues the existing auto-upgrade pattern in
`applications_tsv.js`:

| Version | Header col 7 | Reader behaviour |
|---|---|---|
| v5 (new) | `locations` | `JSON.parse(cell || "[]")`; fallback to `[cell]` on parse error. |
| v4 (current) | `location` | Read cell as string; wrap as `[cell]` if non-empty, else `[]`. |
| v3 / v2 / v1 | (existing) | Existing upgrade paths, with the same `location → [location]` wrap. |

All readers produce the same in-memory shape: `app.locations: string[]`.
`app.location` is removed from the in-memory object. Callers updated
in the same PR (§7).

Writer always emits v5. First `save()` after the upgrade rewrites the
file end-to-end (existing behaviour — `save` is a full rewrite).

**Migration timing — same PR.** This is a one-shot personal-tool repo;
no third-party consumers of `applications.tsv`. The first `save()`
after merge migrates the file. We also ship a standalone
`scripts/migrate_tsv_v4_to_v5.js` that:

1. Loads each profile's `applications.tsv` (auto-upgrades v4 → v5
   shape in memory).
2. Writes back with v5 header.
3. Drops a backup at `applications.tsv.pre-v5-<date>` (matches the
   pattern in `docs/reference/tsv-schema.md`).

User runs it once per profile after the PR lands. Without it, the file
migrates on next `prepare`/`sync` automatically anyway — the script is
the explicit, auditable path.

## 5. Schema-version handling — confirmed in place

`applications_tsv.js:374-401` already does header-matched auto-upgrade
across v1 / v2 / v3 / v4. We extend the same `matchHeader` chain to v5
and prepend `HEADER_V5` (= new `HEADER`). The existing v4 constant is
renamed `HEADER_V4` and demoted to read-only.

No header-comment row is needed — the column-name diff carries the
version signal.

## 6. Adapter side

Every adapter under `engine/modules/discovery/` already returns
`NormalizedJob.locations: string[]`. `appendNew` in `applications_tsv.js`
currently does:

```js
const location =
  Array.isArray(job.locations) && job.locations.length > 0
    ? String(job.locations[0]) : "";
```

That becomes:

```js
const locations = Array.isArray(job.locations)
  ? job.locations.map(String).filter(Boolean) : [];
```

No adapter change needed. Adapters that historically returned a flat
string (none currently in the tree; verify in impl) get wrapped at the
edge.

## 7. Callers to update

Confirmed sites that read the flat `app.location`:

- `engine/commands/prepare.js:215-225` — wraps `[app.location]` into
  `locsForGeo` for `enforceGeo`. After v5: pass `app.locations` directly.
- `engine/commands/validate.js:506` — passes `app.location` into
  `{ location: ... }` for filter recheck. After v5: pass the array (or
  the joined string, depending on the filter call signature — confirm
  during impl).
- `engine/core/applications_tsv.js:162` — writer row. Becomes
  `JSON.stringify(app.locations || [])`.

No other reads of `app.location` exist in the engine
(`grep -rn 'app\.location\b' engine/` returns only the three above
plus `applications_tsv.js`'s own writer).

## 8. Filter side

`hasUsMarker(stringOrArray)` already accepts both shapes (BL-81). No
change to the predicate. Callers updated to pass `app.locations`
(array) where they previously passed `app.location` (string).

`enforceGeo` already normalizes either shape (`geo_enforcer.js:343`).
No change there either.

## 9. Notion side

Notion DB has a single `Location` text property — we keep it that way.
Push code (currently `engine/core/notion_push.js` / its callers) joins
the array with `", "` for display: `app.locations.join(", ")`.

Open: should the row ever have a separate `display_location` override?
Recommendation: **no, not now.** Join keeps things simple. If a profile
later wants a curated single string for Notion, we add the field then.

## 10. Tests

Required in the impl PR:

- **Read v4 → in-memory v5 shape**: file with `location` column,
  reader returns `apps[].locations === [cellValue]` (or `[]` if empty).
- **Read v5 → in-memory**: JSON-encoded cell parses correctly,
  including multi-element, empty, and unicode cases.
- **Write v5**: `save()` then `load()` round-trips a multi-element
  array unchanged.
- **Migration script**: golden test on a fixture v4 TSV; assert
  output matches expected v5; assert backup file is created.
- **`appendNew` with multi-loc job**: TSV row carries full array.
- **`prepare` geo recheck**: row with `["Remote (UK)", "United States"]`
  passes geo `us-wide` (regression test for the BL-93 failure mode).

Docs: `docs/reference/tsv-schema.md` updated in the same PR (the
"Schema v4 (current)" section moves to v5, v4 demoted to read-only
row in the version table).

## 11. Open questions for approve

1. **On-disk version label.** This RFC proposes **v5** because the
   current code already calls itself v4 (fit columns, 2026-05-05).
   BL-93's title uses "v4 locations". Recommendation: bump to v5 and
   amend BL-93's title.
2. **Encoding.** JSON array (recommended) vs pipe-separated. §3.
3. **Migration timing.** Same PR (recommended) vs follow-up. §4.
4. **Notion `Location` field.** Keep as joined string (recommended)
   vs add per-row `display_location` override. §9.
5. **Backup file naming convention.** `applications.tsv.pre-v5-<date>`
   (matches existing `.pre-stage16`, `.pre-migrate-*`) — confirm.

## 12. Approval checklist

- [ ] User approves on-disk label (v5 vs reusing v4).
- [ ] User picks encoding (JSON recommended).
- [ ] User confirms same-PR migration.
- [ ] User confirms Notion join behaviour (no `display_location` field).
- [ ] BL-93 amended with the chosen on-disk version label.
