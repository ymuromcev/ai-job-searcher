---
id: RFC-037
title: Expand engine/core/validator.js — filter_rules / role_targets / geo + cross-refs
status: proposed
author: Claude (via Jared)
tier: M
created: 2026-05-18
refs:
  - BL-99
  - RFC-013
  - RFC-030
  - RFC-033
---

# RFC 037 — Expand validator: schema / referential / semantic checks

## 1. Problem

`engine/core/validator.js` is 53 lines: `validateJob` (required TSV
row fields) and `validateProfile` (required `id` / `identity` /
`modules`). Everything operational we *call* "validate" actually
lives in `engine/commands/validate.js`: TSV hygiene, company-cap,
URL liveness, retro sweep, Notion Status schema.

What the validator does **not** catch — drift observed in audit
2026-05-18 (§6 Part B) and prior incidents:

1. **Bad regex in `title_blocklist` / `title_requirelist`.** A typo
   (`product (manager|owner` — unbalanced paren) throws mid-prepare.
2. **Empty `role_targets.tracks[]`** — RFC 033 added a loader
   warning, no hard validate error, no per-track shape check.
3. **Duplicate track `id`** — `fit_treatments` keyed by id collapse.
4. **Bad `geo` block** — `mode: "metro"` with empty `cities` *or*
   `states` produces "no row ever passes". `us-wide` with
   `blocklist: ["United States"]` same.
5. **`companies_blacklist` referencing a company not in
   `data/companies.tsv`** — operator typo, deny-list is a no-op.
6. **`modules: ["discovery:foo"]`** where the adapter file doesn't
   exist. CLI throws at scan, not validate.
7. **`notion.jobs_pipeline_db_id` not a UUID** — caught on first
   Notion call as an opaque 400.
8. **`resume.versions_file` missing** — surfaces mid-prepare.
9. **`location_blocklist` entry like `^Bengaluru$`** — `filter.js`
   does substring match; never hits. Silent.
10. **`_example/` drifting** — no test guards that the template
    passes its own validator (RFC 033 §2.4 already hit this).

The thread: scope is too narrow, drift surfaces mid-pipeline.

## 2. Decision

Expand validator with three check categories. Keep the
`{ valid, errors }` shape, tag each issue with `category`, route
everything through one entry point so callers don't grow new APIs.

- `schema` — per-field shape (types, enums, regex compiles). Pure.
- `referential` — cross-file refs (modules resolve, files exist,
  companies in TSV). Touches fs.
- `semantic` — logical consistency (non-empty tracks, geo coherence,
  no duplicate ids). Pure.

Each issue:
```js
{ severity: "error" | "warn", category: "schema"|"referential"|"semantic",
  field: "filter_rules.role_targets.tracks[2].patterns",
  message: "patterns[] is empty" }
```

Exit policy: any `error` → exit 1. `warn` does not gate.

## 3. New checks

### 3.1 `schema`

| Field | Check | Sev |
|---|---|---|
| `role_targets.tracks[]` | non-empty `id`, `name`, `patterns[]` | error |
| `role_targets.tracks[].patterns[].pattern` | compiles via `new RegExp(p, "i")` | error |
| `role_targets.tracks[].fit_treatment` | `primary`/`bridge` or absent | error |
| `title_blocklist[]` | entry has `pattern`; regex compiles | error |
| `title_requirelist[]` | entry has `pattern`; regex compiles | error |
| `location_blocklist[]` | each entry is a string | error |
| `location_blocklist[]` | no regex anchors (`^`, `$`, `\b`) | warn |
| `company_cap.max_active` | integer ≥ 0 | error |
| `profile.geo.mode` | one of unrestricted/metro/us-wide/remote-only | error |
| `profile.notion.jobs_pipeline_db_id` | UUID format | error |
| `profile.notion.property_map.*.field` | non-empty string | error |

### 3.2 `semantic`

| Rule | Sev |
|---|---|
| `role_targets.tracks.length > 0` (RFC 033) | error |
| No duplicate `tracks[].id` | error |
| `geo.mode=metro` → both `cities` and `states` non-empty | error |
| `geo.mode=us-wide` → `blocklist` contains no US marker | error |
| `geo.mode=remote-only` → `remote_ok !== false` | warn |
| `fit_treatments` keys → each matches some `tracks[].id` | warn |

### 3.3 `referential`

| Field | Check | Sev |
|---|---|---|
| `profile.modules[]` | `discovery:foo` → `engine/modules/discovery/foo.js` exists | error |
| `profile.resume.versions_file` | file exists | error |
| `profile.cover_letter.{template,config}_file` | file exists | error |
| `discovery.companies_blacklist[]` | name exists in `data/companies.tsv` | **warn** |

`companies_blacklist` is `warn` because `data/companies.tsv` is
gitignored — error would break first-run validate on fresh clone.

## 4. Output

Same human stderr (`field: message`), tagged for grep:

```
[schema/error] filter_rules.role_targets.tracks[1].patterns[0].pattern:
  invalid regex: Unterminated group
[semantic/error] filter_rules.geo: mode=metro but cities[] is empty
[referential/warn] discovery.companies_blacklist[3]:
  "Acmme Corp" not found in data/companies.tsv (typo?)
```

Final line: `validation: N errors, M warnings`. Exit 1 iff
`errors > 0`.

## 5. Integration

`engine/commands/validate.js` already calls
`profileLoader.loadProfile`. Extend it to call new
`validateProfileDeep(profile, { dataDir, profileRoot, modulesDir })`
right after load and merge issues into the existing report.

BL-99 mentions `--strict`. Recommendation: **don't add it**. Validate's
job has always been "tell me what's broken"; this just makes the
surface honest. Adding a flag invites the laxer mode to become
default. If we ever need a soft mode, add `--allow-warn` then, not
now.

## 6. File layout

Modular, one file per category:

```
engine/core/validator.js                    # orchestrator + public API
engine/core/validator/checks/schema.js      # pure
engine/core/validator/checks/semantic.js    # pure
engine/core/validator/checks/referential.js # touches fs
engine/core/validator/checks/*.test.js
```

Each check file under ~150 lines; `referential` (only one with I/O)
mocked in isolation. Public `validateJob` / `validateProfile`
exports stay on `validator.js`.

## 7. Tests

- **Unit**: one `.test.js` per check file. Each §3 rule gets a
  happy-path + failing case.
- **Golden**: `validator.test.js` loads `profiles/_example/` (copied
  to tmpdir, `.example` suffixes resolved) and asserts
  `errors.length === 0`. If `_example` drifts, this breaks — that's
  the bug, not the test.
- **Regression**: existing `validate.test.js` cases stay green.

## 8. Migration

Single PR. Existing profiles **will** surface new issues — the point.

1. Land RFC + impl behind no flag.
2. Run `validate --profile <id>` for `jared`, `lilia`.
3. Operator fixes surfaced issues in-profile (Claude doesn't touch
   `profiles/<id>/` per CLAUDE.md).
4. Once real profiles pass, ship.

Expected: 2-5 warns per profile (mostly regex-looking
`location_blocklist`, possibly one `companies_blacklist` typo).

## 9. Out of scope

- JSON-schema driven validation (Ajv). Hand-rolled is fine at this
  scale.
- Auto-fix. Nothing here is safely auto-fixable.
- TSV row schema beyond `validateJob` (covered by parser).
- Notion content validation beyond the DB id format
  (`notion_status_schema` covers schema drift).

## 10. Open questions for approve

1. **`companies_blacklist` severity** — recommend **warn** (gitignored
   TSV, error breaks fresh-clone validate).
2. **Regex-looking `location_blocklist`** — recommend **warn** (real
   footgun, finite noise).
3. **`_example` golden test** — resolve suffixes in-place or copy to
   tmpdir? Recommend **tmpdir copy** (mirrors Stage 18 wizard, keeps
   production loader path untouched).
4. **`notion.jobs_pipeline_db_id` UUID check** — recommend **error**
   (non-UUID always fails at first Notion call).

## 11. Approval checklist

- [ ] User approves three-category split (§2).
- [ ] User approves modular file layout (§6).
- [ ] User approves drop of `--strict` flag (§5).
- [ ] User picks severity defaults for §10.
- [ ] BL-99 stays as impl ticket; flip `planned → in_progress` on
      approval.
