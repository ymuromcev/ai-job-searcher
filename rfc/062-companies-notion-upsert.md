# RFC 062 — relokant-sweep → Notion Companies upsert

- **Status:** Accepted (approved 2026-06-25, implemented)
- **Tier:** M
- **Refs:** BL-202, BL-200, RFC 061 (relokant sweep), RFC 022 (Notion-write
  invariant)
- **Date:** 2026-06-25

## What changes for the user

Today relokant-sweep finds new sweet-zone companies and writes them only to
`ru_friendly_targets.tsv`; getting them into the Notion Companies DB is
manual (just done by hand for Lokalise / Ntropy). After this change the sweep
**also pushes the new companies into the Notion Companies DB by itself**, and
never creates a duplicate of a company that's already there.

One new command, same `--dry-run` default / `--apply` convention as `sync`:

```
node engine/cli.js companies-upsert --profile jared           # prints the plan
node engine/cli.js companies-upsert --profile jared --apply   # writes to Notion
```

`--dry-run` prints e.g. `3 to create, 1 to fill, 9 already there (skip)`.
The relokant-sweep skill calls `--apply` as its last step; nothing else in
the pipeline changes.

## Approach — reuse the existing company path, don't build a parallel one

The Companies DB is already populated by the job pipeline through
`engine/core/company_resolver.js` (lookup-or-create by name). We extend that
same path rather than inventing a second writer:

- **Lookup / create / data-source resolution**: same as `company_resolver`
  (`dataSources.query` by title, `pages.create` with
  `parent: { database_id }`, data_source via
  `notion_sync.resolveDataSourceId`).
- **Extra over the resolver**: relokant targets carry more than a name, so we
  (a) write the extra fields below, (b) dedup by **domain as well as name**,
  (c) on an existing page, **fill only empty fields** (never overwrite).

### Dedup key

- Primary = normalized domain (lowercase, strip `https?://`, `www.`, path,
  trailing slash).
- Fallback (no website) = `normalizeName` — the Cyrillic-safe one already in
  `scripts/relokant/sweep_dedup.js`.
- A candidate matches an existing company if **either** key is already known.

Known-set = existing Notion pages (`Name` + `Website`) ∪ `data/companies.tsv`
∪ the relokant ledgers. So a company the pipeline already created from a
vacancy is recognized and not duplicated ("two-way" dedup).

### Fields written on create (fill-gaps on existing)

| Notion field | Source (from the TSV row) |
|---|---|
| `Name` (title) | `name` — the dedup key, create-only |
| `Website` (url) | `https://` + `website` |
| `Careers URL` (url) | `open_roles_url` |
| `Why Interested` (text) | `CIS-edge: <ru_signal>. <market>.` |
| `Notes` (text) | `Relokant sweet-zone (US-HQ). Contact: <contact>. US-viability: <us_viability>. ATS: <ats>. <notes>` |
| `Outbound Status` (select) | `Not started` |

`Tier` is **never** written (it's the user's pipeline judgement; relokant
data carries no tier — same stance as `company_resolver`, which only sets
Tier from an explicit profile map).

On an existing page: create missing pages in full; for a page that exists,
patch only the **empty** mapped fields, never overwrite a non-empty value,
never delete.

## Code shape (implementation detail — not approval-gated)

- A small tested helper builds the per-row field payload and the
  create-vs-fill-vs-skip decision from in-memory data (no I/O) — same
  pure-helper convention as the rest of `core/`.
- The side-effectful command reads the three sources, builds the Notion
  client via `loadSecrets("jared")`, and runs `pages.create` / `pages.update`.
- `normalizeName` (+ new `normalizeDomain`) move to a shared
  `engine/core/company_keys.js`; `sweep_dedup.js` re-exports from there so its
  CLI/tests don't change.

## Non-goals

- No outreach send (drafts stay manual, RFC 061).
- No scan-engine / discovery-adapter changes.
- No Notion → tsv push; `sync` stays pull-only.
- No `Tier` writes.

## Edge cases

- Already in Notion, all mapped fields filled → skip, no write.
- Already in Notion, some empty → patch only the empty ones.
- Same company twice in one batch → collapse via in-batch seen-set.
- No website → name-key dedup only.
- Missing `JARED_NOTION_TOKEN` → `--apply` warns and no-ops; `--dry-run`
  still prints the plan.
- `data/companies.tsv` absent → treated as empty (no throw).

## Notion-write invariant (RFC 022)

All page writes stay in **engine** code. The relokant-sweep skill does not
call Notion directly — after appending to the TSV it invokes
`companies-upsert --apply`. Daily routine adds the same step.

## Testing

- Helper unit tests: create vs fill vs skip; domain-vs-name key hit; in-batch
  dedup; empty-field detection; Tier never written.
- Key-normalization tests (domain + name) incl. Cyrillic / legal suffixes.
- Command test with a faked Notion client (records create/update; no network).
- Smoke: `--dry-run` prints a plan and writes nothing.

## Rollout

1. Land `company_keys.js` + the helper + command + tests.
2. Wire the `--apply` step into `skills/relokant-sweep/SKILL.md` and the daily
   routine.
3. First automated run is a no-op dedup over the current ledger (Lokalise /
   Ntropy already in Notion) — proves the path doesn't duplicate.
4. Update README + `docs/architecture` inventory (DoD).
