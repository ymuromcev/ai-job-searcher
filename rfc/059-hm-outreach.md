# RFC 059 — Hiring-manager & warm-contact outreach (job-centric, LinkedIn)

- Status: **Implemented** (phases 1–3 shipped 2026-06-03; phase 4 =
  content, tracked in BL-62). Open question resolved → Option 1.
- Date: 2026-06-03
- **Scope amended 2026-06-03:** the `company_people_search_url` is
  populated for **all fit tiers** (Strong/Medium/Weak) on commit, per
  operator decision — superseding the original "Medium+/Strong only"
  gate. The property_map-presence guard is unchanged: Notion still only
  receives the field when the profile maps `companyPeopleSearchUrl`. See
  §C and "Out of scope".
- Refs: BL-169 (authoritative model; supersedes/merges BL-166), BL-62
  (outbound discovery; note/DM templates live in its Notion project),
  RFC 014 (status split), RFC 022 (per-row Notion push in commit),
  RFC 058 (relation-company resolution in reconcile)
- Tier: M

## Summary

Add one **job-centric outreach motion** on top of the existing ATS
pipeline. For **every committed vacancy** (all fit tiers — scope amended
2026-06-03, see §C) the engine emits a LinkedIn **company people-search
URL** (`company_people_search_url`). The operator
opens it; LinkedIn itself surfaces "N of your connections work here" and
the operator decides **warm** (their own contact) vs **cold** (a hiring
manager / recruiter). Outreach state is tracked **on the vacancy card**
(jobs pipeline), not in a separate CRM. The durable human record lives in
the personal "Люди" base (`people_db`) with its «Компания» field filled,
linked by relation to the same `companies_db` the vacancies relate to, so
a vacancy rollups "people at this company" read-only.

No automation of LinkedIn send/scrape — the engine produces a prefab URL
and reads/writes mapped Notion properties; the operator does every human
action by hand.

## Motivation

Cold apply through ATS forms has produced **0 interviews** in the last
month (BL-62). The outbound channel is the bet. Benchmarks gathered in
BL-169:

- Cold email/DM to a hiring manager → **15–25% reply** vs standard online
  apply **2–5%** (~5–10× lift).
- Sourced candidates convert to hire **4–8×** vs inbound (LinkedIn's own
  funnel data).
- A signal-personalized connection note referencing a specific vacancy →
  ~**18%+ reply** vs ~3.4% generic.

The same motion already worked for the operator once (added a future boss
on LinkedIn with no explicit ask; they reached out when headcount
opened). This RFC makes that motion **systematic and vacancy-anchored**:
tied to a specific role with verified hiring intent, not bulk cold-adds.

BL-169 and BL-166 are unified here. BL-166's "warm shared-context"
outreach is simply the **"I have a contact here"** branch of this single
flow. The cold-HM branch is the **"no contact"** branch. Both run through
the same vacancy-card status; the weekly LinkedIn invite cap is shared
between them.

## Design

Six workstreams (A–F). A–C are engine code. D is an operator-executed
Notion schema change (design only here). E is engine code. F is content
that lives in the BL-62 Notion project, not in code.

### A. TSV schema extension (`engine/core/applications_tsv.js`)

Six new columns are appended to `applications.tsv`, bumping the schema to
**v6**. All write through `engine/core/applications_tsv.js` only — no
other code path touches the TSV (per the project contract).

| Column | Values | Origin |
|---|---|---|
| `company_people_search_url` | LinkedIn people-search URL (string) | `prepare --phase commit` (workstream B/C) |
| `outreach_type` | `warm` \| `cold` \| `""` | operator → Notion → `sync` pull |
| `contact_name` | free text | operator → Notion → `sync` pull |
| `contact_linkedin` | URL | operator → Notion → `sync` pull |
| `hm_outreach_status` | `to_search` \| `searching` \| `pending_connection` \| `connected` \| `dm_sent` \| `replied` \| `dead` | operator → Notion → `sync` pull |
| `hm_outreach_date` | ISO date | operator → Notion → `sync` pull |

**Design.** Follow the existing versioned-header pattern in
`applications_tsv.js`: add `HEADER_V6` (the v5 columns + the six above),
alias `HEADER = HEADER_V6`, add `rowToAppV6`, extend `rowFor` to emit the
new cells, and add a `load()` branch (`isV6`). `save()` always writes v6.

**Migration (auto-upgrade-on-save).** The same mechanism v1→v5 already
use: `rowToAppV5` (and earlier) gains defaults for the new fields —
`company_people_search_url: ""`, `outreach_type: ""`, `contact_name: ""`,
`contact_linkedin: ""`, `hm_outreach_status: "to_search"`,
`hm_outreach_date: ""`. A v5 file is read with these defaults, and the
next `save()` rewrites it as v6. No standalone migration script; the
first `prepare`/`sync --apply` after deploy upgrades the file in place.
The in-memory `app` shape gains the six fields; `appendNew` seeds them on
fresh `scan` rows (`hm_outreach_status: "to_search"`, the rest empty).

**Default rationale.** `hm_outreach_status` defaults to `to_search` (not
empty) so existing rows land in a valid lifecycle state and the Notion
"to-do queue" view picks them up consistently. The other five default
empty.

**Files touched:** `engine/core/applications_tsv.js`,
`engine/core/applications_tsv.test.js`.

### B. `company_people_search_url` helper (`engine/core/linkedin_search_url.js`)

New **pure** helper. No existing `linkedin` helper in `engine/core/`
(confirmed — only `url_check.js` exists), so this does not duplicate
anything.

**Signature (proposed):**

```js
// engine/core/linkedin_search_url.js
// Pure. Builds a LinkedIn people-search URL for a company, optionally
// narrowed by role keywords and location. Zero network, zero automation.
function buildCompanyPeopleSearchUrl({ company, roleTitle, location }) {
  // → "https://www.linkedin.com/search/results/people/?keywords=...&origin=..."
}
module.exports = { buildCompanyPeopleSearchUrl };
```

**Behaviour.**

- Base: `https://www.linkedin.com/search/results/people/`.
- `keywords` = `company` plus optional role keywords (e.g. `"<Company>
  recruiter"` / hiring-manager title fragments derived from `roleTitle`)
  — URL-encoded.
- Geo: bias to US via the keyword string (a `geoUrn` requires LinkedIn's
  internal region ids, which the engine must not hardcode/scrape; a
  US keyword bias is the ToS-safe approximation).
- Defensive: missing `company` → throw; missing `roleTitle`/`location` →
  company-only URL.
- Returns a plain string; performs **no fetch** and embeds **no
  automation** — it only assembles a URL a human clicks.

**ToS note (load-bearing).** The helper produces a prefab URL only. There
is no scraping, no connection-send, no session handling. Tests assert the
output is a well-formed search URL and that the module imports nothing
network-related.

**Files touched:** `engine/core/linkedin_search_url.js` (new),
`engine/core/linkedin_search_url.test.js` (new — faked inputs, no
network: company-only, company+role, company+role+location, missing-
company throw, encoding of spaces/`&`/unicode).

### C. `prepare --phase commit` integration (`engine/commands/prepare.js`)

> **Scope amended 2026-06-03 (operator decision):** the search URL is
> populated for **all fit tiers** (Strong / Medium / Weak), superseding
> the original Medium+/Strong gate. Rationale: the people-search URL is a
> cheap, harmless link — a human clicks it, nothing is sent or scraped.
> The operator decides per-row whether to actually act on it; excluding
> Weak rows throws away that cheap optionality for no benefit. The only
> gate on whether Notion sees the field is **property_map presence** (see
> below), not fit tier.

Populate `company_people_search_url` for **all committed rows
(Strong/Medium/Weak) — no fit-tier gate** during the commit phase, write
it to the TSV row, and push it into the Notion page via the property map.

**Design.** The commit-phase per-row loop (`engine/commands/prepare.js`,
where each promoted row gets `app.status = "To Apply"`) computes the URL
for **every** committed row and writes it onto the in-memory `app` (and
thus the TSV column `company_people_search_url` from workstream A):

```js
app.company_people_search_url = deps.buildCompanyPeopleSearchUrl({
  company: app.companyName,
  roleTitle: app.title,
  location: (app.locations && app.locations[0]) || undefined,
});
```

`buildJobFieldsForNotion(...)` (the pure field assembler, ~L1629) then
surfaces that value into the Notion payload as
`fields.companyPeopleSearchUrl` — for every tier, with no
`if (fitScore === ...)` gate. The helper is wired through `deps` (like
`formatSalaryDisplay`) so it stays injectable for tests.
`hm_outreach_status` is left at its phase-1 `to_search` default on commit.

**Property-map dependency.** The push only emits the property when the
profile's `property_map` defines `companyPeopleSearchUrl` (workstream D).
Profiles without it (e.g. `_example` until updated) silently skip the
field — consistent with how `buildProperties` already drops unmapped
fields.

**Files touched:** `engine/commands/prepare.js`,
`engine/commands/prepare.test.js` (assert Strong, Medium, AND Weak each
get a URL in both the TSV row and the Notion field payload; helper
injected as a fake; the Notion property is omitted when `property_map`
lacks `companyPeopleSearchUrl`).

### D. Notion schema change (operator-executed; design only here)

This is a **personal Notion mutation done by the operator via MCP after
approval**, NOT by engine code. Engine code only reads/writes the mapped
properties.

1. **`people_db`.«Компания» → relation onto `companies_db`.** Today
   «Компания» is a `multi_select`/text (single option) and is mostly
   empty. Convert it to a **relation** targeting the same companies base
   the vacancies relate to (`profile.json → notion.companies_db_id`).
   Without this the rollup in step 3 cannot be built. (This is the
   schema-bridge BL-169's authoritative model calls out as mandatory.)
2. **Outreach-status properties on the vacancy/jobs DB.** Add the Notion
   properties backing the six TSV columns: a people-search URL (`url`), an
   `outreach_type` select (`warm`/`cold`), `contact_name` (rich_text),
   `contact_linkedin` (url), `hm_outreach_status` (select with the seven
   lifecycle options), `hm_outreach_date` (date).
3. **Rollup "people at this company" on the vacancy/jobs DB.** The vacancy
   already relates to `companies_db` (RFC 058). Add a rollup that, via that
   relation, surfaces the related `people_db` rows for the company —
   read-only. This is what makes "do I know someone here?" visible on the
   vacancy card without a per-person job-CRM.
4. **Extend `notion.property_map` in `profile.json`.** Add the new keys
   (names are profile-local; the example uses generic English field
   names):

   ```jsonc
   // profiles/_example/profile.example.json → notion.property_map (additions)
   "companyPeopleSearchUrl": { "field": "People Search URL",  "type": "url" },
   "outreachType":           { "field": "Outreach Type",      "type": "select" },
   "contactName":            { "field": "Contact Name",       "type": "rich_text" },
   "contactLinkedin":        { "field": "Contact LinkedIn",   "type": "url" },
   "hmOutreachStatus":       { "field": "Outreach Status",    "type": "select" },
   "hmOutreachDate":         { "field": "Outreach Date",      "type": "date" }
   ```

   The existing generic, type-driven `toPropertyValue` / `fromPropertyValue`
   in `engine/core/notion_sync.js` already handle `url` / `select` /
   `rich_text` / `date`, so no new conversion code is needed.

5. **Notion "to-do queue" view (operator).** A view filtered to
   `Fit Score ∈ {Medium, Strong}` AND `hm_outreach_status ∈ {to_search,
   searching}` AND `Status ≠ Archived` — the weekly outreach worklist.
   View definition is operator-side, not engine code.

The `_example` template is updated to document the new property_map keys
(synthetic field names only). Jared's real ids/field names stay in his
gitignored `profile.json`.

**Files touched (committed):** `profiles/_example/profile.example.json`
(property_map additions), `README.md` + `docs/architecture/` (new
workflow step). Operator-side: the Notion schema edits above.

### E. `sync` round-trip (`engine/commands/sync.js`)

The new outreach fields must reconcile **Notion → TSV**, preserving the
**pull-only** model. Do **not** re-introduce a push path — `prepare`'s
commit phase remains the only writer of new Notion pages (RFC 014 /
2026-05-04 removal). This constraint is explicit and load-bearing.

**Design.** `reconcilePull(apps, notionPages, propertyMap, now,
companyNameById)` (`engine/commands/sync.js`, L97) currently pulls
`notion_page_id`, `status`, and a backfilled `companyName`. Extend the
**update path** so that, for each matched row, the five operator-owned
outreach fields (`outreach_type`, `contact_name`, `contact_linkedin`,
`hm_outreach_status`, `hm_outreach_date`) are pulled from Notion when they
differ from the local row (Notion wins, mirroring the `status` rule). The
**add path** seeds them from the page too. `company_people_search_url`
is engine-authored in `prepare`; on pull, treat it like `companyName` —
backfill only when the local cell is empty (never clobber an
engine-written URL with an empty Notion value).

This requires `parseNotionPage` (`engine/core/notion_sync.js`) to read the
new mapped properties into the `page` object (it already iterates the
property map generically via `fromPropertyValue`, so reading is automatic
once the map has the keys; confirm the parser surfaces them under stable
`page.*` names).

`reconcilePull` stays **pure** (no I/O — tests depend on it), exactly as
RFC 058 preserved.

**Files touched:** `engine/commands/sync.js`,
`engine/core/notion_sync.js` (parse the new props if not already generic),
`engine/commands/sync.test.js` (update-path and add-path pull the five
operator fields; engine-written `company_people_search_url` not
overwritten by empty Notion; purity intact).

### F. Templates (content — BL-62 Notion project, NOT in code)

Three connection-note templates (≤300 chars — LinkedIn's free-tier note
cap) plus one DM template (~350 chars). These are **content that lives in
the BL-62 Notion project** ("Hiring manager outreach" section), not in the
repo, so they can be tuned against live reply data without a code change.
The RFC fixes only intent/skeleton:

- **Note — High signal:** references a recent (≤30d) public post by the
  target about the team / hiring / the role.
- **Note — Med signal:** references a concrete JD fragment that fits
  (e.g. "pre-revenue AI startup hiring its first Forward-Deployed PM").
- **Note — Low signal:** company + role + one matching line from the
  master profile.
- **DM (after accept):** short intro + reference to the specific vacancy +
  soft ask ("worth a 15-min call?").

Note/DM **content** is out of scope for the engine; the engine only emits
the search URL and tracks status.

## Data model changes

**TSV (`applications.tsv`, v5 → v6):** six appended columns —
`company_people_search_url`, `outreach_type`, `contact_name`,
`contact_linkedin`, `hm_outreach_status`, `hm_outreach_date`.

**Notion property_map (new keys):**

| property_map key | Notion field (example) | type | writer |
|---|---|---|---|
| `companyPeopleSearchUrl` | People Search URL | `url` | engine (`prepare` commit) |
| `outreachType` | Outreach Type | `select` | operator |
| `contactName` | Contact Name | `rich_text` | operator |
| `contactLinkedin` | Contact LinkedIn | `url` | operator |
| `hmOutreachStatus` | Outreach Status | `select` | operator |
| `hmOutreachDate` | Outreach Date | `date` | operator |

Plus (operator-side, no property_map entry needed): `people_db`.«Компания»
relation → `companies_db`, and a rollup "people at this company" on the
vacancy DB.

## Migration

- **TSV:** auto-upgrade-on-save (v5 read with defaults → next `save()`
  writes v6). No script. `hm_outreach_status` backfills to `to_search`,
  the rest empty.
- **Notion:** operator runs the schema edits in workstream D via MCP after
  approval. Order: convert «Компания» to relation → add vacancy-DB
  properties → add rollup → extend `property_map` in `profile.json` → add
  the to-do view. Until `property_map` carries the new keys, `prepare`
  silently omits the URL field and `sync` ignores the outreach fields, so
  the engine is forward/backward compatible during the rollout window.

## Test plan

- **A (TSV):** v5-file read yields the six defaults; round-trip
  save→load preserves them; v6 header parses; v1→v5 upgrade paths still
  green; `appendNew` seeds `to_search`.
- **B (helper):** company-only, company+role, company+role+location,
  missing-company throws, encoding of spaces/`&`/unicode; no network
  import.
- **C (prepare commit):** Strong, Medium, AND Weak rows each get a
  populated URL in both the TSV row and the Notion field payload (no
  fit-tier gate); helper injected as a fake; property omitted when
  `property_map` lacks the key.
- **E (sync):** update-path pulls the five operator fields when Notion
  differs (Notion wins); add-path seeds them; engine-written
  `company_people_search_url` is not overwritten by an empty Notion value;
  `reconcilePull` stays pure; no push path introduced.
- All network mocked. No real LinkedIn/Notion calls in unit tests.
- **Smoke:** local `prepare --phase commit` on a mixed-tier batch
  (Strong/Medium/Weak) populates the URL + Notion field on every row;
  `sync --apply` round-trips a manually set `hm_outreach_status` from
  Notion back into the TSV.

## Risks

- **LinkedIn account restriction.** Bulk invites can trip anti-automation
  limits. Mitigation: cap **50 connection adds/week for the first 2
  weeks**, grow toward ~100/week only if accept rate > 40% (signal that
  targeting is sane). This is an operational discipline, not engine logic.
- **ToS.** Any automation of search-scrape or invite-send risks the
  account. Mitigation: the engine produces a **prefab URL only**; every
  send/scrape is a manual human action. Tests assert the helper has no
  network dependency.
- **Empty-URL silently dropping a row** (the RFC 058 failure mode): the
  pull rule "backfill `company_people_search_url` only when empty" must
  never let an empty Notion value clobber an engine-written URL.
- **Personal-data leak.** `people_db` content is PII. Nothing about it
  enters the repo; only the relation/rollup wiring and generic
  property_map keys are committed. The engine reads/writes mapped Notion
  properties only.

## Open questions

**[RESOLVED 2026-06-03 — operator chose Option 1: single status on the
vacancy for v1.]** Build the single `hm_outreach_status` on the vacancy;
do NOT build the per-person junction now. Evolution path to Option 2 is
noted below for the future.

**Multiple known contacts at one company — single status on the vacancy,
or a per-person junction?**

- *Option 1 — single `hm_outreach_status` on the vacancy (recommended for
  v1).* Simplest; matches the "track on the vacancy card" decision; the
  rollup already lists everyone at the company, and the operator works one
  contact at a time per vacancy. Cost: it cannot express "DMed person A,
  pending person B" simultaneously — the status reflects the vacancy's
  outreach as a whole.
- *Option 2 — per-person junction (one status row per person×vacancy).*
  Higher fidelity; supports parallel threads to multiple contacts. Cost: a
  junction DB + sync of a 1-to-many relationship — effectively the
  per-person job-CRM BL-169/BL-166 explicitly ruled out of scope for now.

**Recommendation:** ship **Option 1** for v1. Evolve to Option 2 later
only if real usage shows multiple simultaneous threads per vacancy are
common — at which point `hm_outreach_status` moves from a vacancy property
to rows in a junction DB, and `sync` reconciles that DB instead of the
single field. Defer; do not build the junction now.

Secondary (non-blocking, from BL-169): hiring-manager vs recruiter reply
rates; whether to surface mutual-connection count in the note; how to
treat 3rd-party agency recruiters. These are operational tuning, not
schema — leave to the BL-62 experiment.

## Out of scope

- Auto-scraping / auto-sending LinkedIn invites or DMs (ToS).
- AI guessing a specific hiring manager's name — the engine gives the
  search URL; the operator finds the human.
- A full sales CRM / per-person junction DB (see Open questions — deferred).
- Re-enabling a Notion push path. `prepare` commit stays the only creator
  of Notion pages.
- Note: the search URL itself is populated for **all fit tiers**
  (Strong/Medium/Weak — scope amended 2026-06-03). What stays
  operator-prioritized is the **actual outreach effort** (which rows are
  worth a connection note / DM this week), not whether the URL exists. The
  engine emits the link everywhere; the operator chooses where to spend
  invites (see the to-do-queue view in workstream D and the weekly cap in
  Risks).

## As-built (2026-06-03)

Phases 1–3 shipped. The Notion-side schema (workstream D) was deliberately
built **leaner** than the design above — the operator chose a minimal
surface consistent with the "no per-person CRM" decision (BL-166/169):

**Notion vacancy DB — what was actually created:**

- **`LinkedIn Search`** (`url`) — the engine-written people-search URL.
- **`Outreach`** (`status`, 3 options: `Not started` / `In progress` /
  `Done`) — the operator-owned outreach state. Built as a Notion **status**
  property, not the 7-state `select` the design sketched; the 3-state
  lifecycle is enough for v1.
- **`People`** (`rollup` over the existing `Company` relation,
  `show_unique`) — "who I know at this company", read-only.
- `Company` was already a relation to `companies_db` (RFC 058), so the
  `people_db`.«Компания» relation bridge was already in place.

**Deferred (not created):** `outreach_type`, `contact_name`,
`contact_linkedin`, `hm_outreach_date`. Per-contact detail lives in the
LinkedIn UI + the `People` rollup, not in Notion columns. The TSV still
carries these as v6 columns (empty placeholders) so the schema is stable
if they are added later.

**property_map (Jared's profile) — 2 keys added, not 6:**

| key | Notion field | type | writer |
|---|---|---|---|
| `companyPeopleSearchUrl` | `LinkedIn Search` | `url` | engine (`prepare` commit) |
| `hmOutreachStatus` | `Outreach` | `status` | operator → `sync` pull |

**`sync` round-trip (workstream E, as-built):** `reconcilePull` pulls the
single operator-owned field `hm_outreach_status` from Notion's `Outreach`
status (Notion wins; an empty/unset Notion value never clobbers the local
placeholder). `company_people_search_url` is engine-authored at `prepare`
commit and is **not** pulled back. The add-path seeds all six v6 outreach
columns, taking Notion's `Outreach` value when present. Pull-only model
preserved; no push path added.

**Not done (intentionally, content not code):** the Notion "to-do queue"
view (workstream D.5) and the note/DM templates (workstream F) — both live
in the BL-62 Notion project and are authored by hand, tracked there.

## Rollout (phased)

1. **Schema + helper (A, B).** TSV v6 + auto-migration + the pure
   `linkedin_search_url` helper, both fully tested. No behaviour change yet
   (no field is populated until C).
2. **prepare integration (C).** All committed rows (Strong/Medium/Weak —
   no fit-tier gate) get `company_people_search_url` in TSV and (once
   property_map has the key) in Notion.
3. **Notion schema + property_map + sync (D, E).** Operator runs the
   personal-Notion edits; `property_map` gains the six keys; `sync`
   round-trips the operator-owned outreach fields. After this the vacancy
   card shows the URL, the rollup, and the editable status.
4. **Templates (F).** Author the three notes + DM in the BL-62 Notion
   project and run the first weekly worklist against the to-do view.
