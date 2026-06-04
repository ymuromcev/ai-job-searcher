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
- **`Outreach`** (`status`, 4 options: `To do` / `In flight` / `Replied` /
  `Dead`) — the operator-owned outreach state. Built as a Notion **status**
  property, not the 7-state `select` the design sketched. The 4-state set
  was chosen on the principle "each status = a distinct next action / whose
  court": `To do` (queue, my move) → `In flight` (any active outreach) →
  `Replied` (success exit) / `Dead` (closed exit). The TSV default
  `hm_outreach_status` is **`To do`** (Notion's first option), so a fresh
  `scan` row never diverges from the value Notion auto-assigns and `sync`
  shows no spurious diff. (Status options are not editable via the Notion
  API — the operator renames them in the UI; the engine reads whatever
  string Notion returns, so no code change is needed to re-label them.)
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

## Amendment — BL-186 backfill (2026-06-03)

**Problem.** Phase 2 (§C) populates `company_people_search_url` only on
`prepare --phase commit`, i.e. only for vacancies committed *after* the
feature shipped. Every vacancy that reached `To Apply` / `Applied`
*before* phase 2 has an empty `company_people_search_url` in TSV and an
empty `LinkedIn Search` field in Notion. Those are exactly the rows the
operator wants to run outreach on, and there are hundreds of them.

**Solution.** A one-shot CLI command `backfill-outreach-url` (BL-186,
tier M):

- Selects rows whose `status ∈ {"To Apply", "Applied"}` **and**
  `company_people_search_url` is empty **and** `companyName` is non-empty.
  Empty-company rows are reported as *skipped* (no company to search on),
  not processed. Rows already carrying a URL are *already set* and left
  untouched — so a second run is a strict no-op (idempotent).
- Default **dry-run**: prints `would enrich N, skip M (no company),
  already set K` and writes nothing.
- With `--apply`: computes the URL via the existing pure helper
  `buildCompanyPeopleSearchUrl({company, roleTitle, location})` (reused,
  not reimplemented — same code path that phase 2 uses on commit), writes
  it to the TSV through `applications_tsv.js` (the single TSV writer), and
  pushes it to the Notion `LinkedIn Search` field.

**Notion write — same class as the commit-phase write, NOT a new push
path.** The Notion update is a *targeted single-field* `pages.update`
(`updateJobPage` with `{ companyPeopleSearchUrl }` only), structurally
identical to `check`'s `updatePageStatus`. `company_people_search_url`
is **engine-authored, one-way** data: the engine is the sole writer of
this field, it is never read back from Notion (`sync`'s `reconcilePull`
pulls `hm_outreach_status` only, never the URL — see workstream E). The
backfill therefore writes exactly the same field, in the same direction,
that phase 2 already writes on commit. It is the missing first write for
old rows, not a second source of truth.

**Pull-only invariant is preserved.** "Pull-only" (since 2026-05-04,
commit `4f85ed2`) means `sync` never *creates or mutates operator-owned
Notion state from local TSV*. This backfill does neither: it creates no
pages (those are still created exclusively by `prepare --phase commit`),
and it touches no operator-owned field (status, `Outreach` status,
contact fields). It writes only the engine-owned `LinkedIn Search` URL —
the same engine-authored class as the commit-phase write and the
`check` status write, both of which already coexist with the pull-only
`sync`. No push phase, no `push_manifest.json`, no Inbox callout writer
is reintroduced.

**Guards.** Missing `NOTION_TOKEN` or a `property_map` without the
`companyPeopleSearchUrl` key → the URL is still written to TSV (the
canonical ledger) and the Notion push is skipped with a warning. A
per-row Notion error is counted and surfaced (non-zero exit) but never
blocks the TSV write or the remaining rows. `updatedAt` is **not** bumped
— this is a backfill of a derived field, not a state change, so old rows
do not all appear freshly touched.

**Out of scope (unchanged from BL-186).** Outreach status logic, the
auto-Dead timer, per-person contact fields, and any status other than
`To Apply` / `Applied`.

## Amendment — BL-169 auto-Dead (2026-06-03)

**Problem.** The outreach worklist is the set of vacancies whose
`Outreach` status is `In flight` (an active connection request / DM). A
thread that never gets a reply stays `In flight` forever and clutters
the weekly worklist. The operator wants a stale `In flight` thread
(>= 7 days, no reply) to fall out of the live list automatically.

**Образ (operator-approved).** The operator keeps flipping
`Outreach → In flight` in Notion exactly as before — no extra step. The
engine then:

1. **Stamps a date anchor on transition.** When `sync`'s `reconcilePull`
   pulls an `Outreach` value of `In flight` and the row's
   `hm_outreach_date` is empty, it stamps "today". When the status moves
   back out of `In flight` to `To do`, it **clears** the anchor (so a
   re-entry re-stamps a fresh timer). Terminal `Replied` / `Dead` leave
   the date as-is. The anchor lives in the existing v6 TSV column
   `hm_outreach_date` — **no new Notion field is required**.
2. **Lazily sweeps on every CLI invocation.** At the start of every
   command (`scan` / `prepare` / `check` / `sync` / `validate` — wired
   once in the shared `engine/cli.js` entry, so it fires regardless of
   which command runs), the engine scans the TSV for rows that are
   `In flight` with a non-empty anchor older than the 7-day threshold,
   flips them to `Dead`, writes the TSV, and pushes `Dead` to Notion.

**7-day threshold.** Fixed at 7 calendar days (one week), matching the
operator's mental model ("if a week passed with no reply, it's dead").
Configurable via a helper parameter (`thresholdDays`, default 7) but not
exposed as a CLI flag — there is no use case for per-run tuning.

**No cron / no scheduler.** Lazy evaluation on CLI invocation only
(cron / Notion-native automation were explicitly rejected — the latter
needs a paid Notion plan, the former adds infra). The funnel self-cleans
exactly when the operator next works with the engine; staleness between
sessions is fine because `Dead` is only meaningful when he next looks.
The sweep is a pure scan first, so it is a cheap no-op when nothing is
stale and safe to run on every command.

**Notion `Dead` write — same class as `check`'s status write, NOT a new
push path.** The sweep writes the `Outreach` status via the _targeted
single-field_ `pages.update` helper `updatePageStatus` — the identical
pattern `check` uses to write `Status`. The `Outreach` status is
engine-writable in exactly this one direction (the engine already pulls
it back in `reconcilePull`, where Notion wins and an empty Notion value
never clobbers local). Writing `Dead` here and letting the next pull read
it back keeps Notion the source of truth with no conflict. "Pull-only"
(since 2026-05-04, `4f85ed2`) means `sync` never _creates_ pages or
_mutates operator-owned state from a local manifest_; this sweep does
neither — it creates no pages and writes only via the same
engine-authored targeted-status path that already coexists with the
pull-only `sync` (`check`'s `updatePageStatus`). No push phase, no
`push_manifest.json`, no Inbox callout writer is reintroduced.

**Testability / determinism.** The two decisions are pure helpers in
`engine/core/auto_dead.js`, both taking the current date as an injected
`YYYY-MM-DD` string — no `Date.now()` in pure code:

- `selectStaleInFlight(apps, todayStr, thresholdDays = 7)` — returns the
  rows where `status === "In flight"` AND `hm_outreach_date` is a
  well-formed non-empty date AND `(today − anchor) >= thresholdDays`.
- `decideOutreachDate(newStatus, currentDate, todayStr)` — returns
  `{ action: "stamp" | "clear" | "keep", date }` for the transition
  stamp.

The CLI glue (`engine/core/auto_dead_sweep.js` → `todayLocalISO()`)
computes "today" once and injects it; `reconcilePull` derives its
"today" from the date portion of the injected `now` ISO timestamp. Both
helpers are unit-tested with fixed dates (boundary at exactly 7 days, 6
days = fresh, 8 days = stale, empty / malformed anchor = skip, `Replied`
= never, already `Dead` = skip, transition stamp sets the date,
transition to `To do` clears it, terminal status keeps it).

**Edge rules / resilience.**

- Empty (or malformed) `hm_outreach_date` → the row is **not**
  auto-killed (no anchor = no timer).
- `Replied` is never touched; `Dead` is never re-processed (idempotent).
- No `NOTION_TOKEN` (or a `property_map` without a usable `status`
  mapping) → the row is still marked `Dead` in the TSV (the canonical
  ledger) with a single stderr warning; the Notion push is skipped.
- Every Notion call is wrapped in try/catch; a per-row error is counted
  and surfaced on stderr but never blocks the TSV write or the remaining
  rows. The whole sweep is wrapped so it can never throw out of the CLI
  entry — `scan` / `validate` must still run fully offline.

**Stamp-precision note.** The anchor is stamped at sync time (the first
`sync` after the operator flips `In flight`), not at the exact moment of
the flip, and uses the UTC date portion of the sync timestamp. A ±1-day
drift is acceptable for a 7-day timer (operator-confirmed).

**Follow-up (optional, not built).** Surfacing the anchor as an
"In flight since X" date in Notion would require adding an `hmOutreachDate`
(date) key to the operator's `property_map` and a Notion date field. The
anchor is TSV-internal today and the timer does not need it in Notion, so
this is deferred. If added later it is a one-key property_map change plus
extending the same `reconcilePull` stamp block to also write the date
field.

**Out of scope (this amendment).** Cron / scheduler, the 4-state status
set (unchanged), per-person contact fields, any backfill, and exposing
the threshold as a CLI flag.

## Amendment — BL-187 auto-No-Response (2026-06-03)

**Problem.** The auto-Dead amendment above self-cleans the *outreach*
status (`Outreach: In flight → Dead`). The same problem exists one level
up, on the vacancy's **main** status: a job the operator applied to and
then heard nothing back on sits in `Applied` indefinitely and clutters
the live worklist. The operator wants an `Applied` vacancy with no
movement for two weeks to drop to `No Response` automatically — the exact
mirror of auto-Dead, but for the main status and a 14-day window.

**Образ (operator-approved).** The operator applies and works exactly as
before — no extra step. The engine then:

1. **Stamps a date anchor on transition.** When `sync`'s `reconcilePull`
   pulls a main status of `Applied` and the row's `applied_date` is
   empty, it stamps "today". An existing anchor is **never** overwritten
   (re-stamping would silently reset the 14-day timer). Unlike auto-Dead
   there is **no clear branch**: moving forward out of `Applied`
   (`Interview` / `Offer` / `Rejected` / `No Response`) leaves the anchor
   as-is — the sweep only ever inspects `Applied` rows, so a stale anchor
   on a moved-on row is harmless, and keeping it avoids losing the stamp.
2. **Lazily sweeps on every CLI invocation.** At the start of every
   command (wired once in `engine/cli.js`, immediately after the
   auto-Dead sweep — independent, deterministic order), the engine scans
   the TSV for rows that are `Applied` with a non-empty anchor older than
   the 14-day threshold, flips them to `No Response`, writes the TSV, and
   pushes `No Response` to Notion.

**New TSV anchor column — `applied_date` (schema v7).** The anchor lives
in a **new** TSV column `applied_date` (`YYYY-MM-DD`), appended as schema
v7 using the same auto-upgrade-on-save mechanism v6 used for the outreach
columns: every older `rowToApp*` path seeds `applied_date: ""`, `save()`
always writes the v7 header, and a pre-v7 file silently upgrades on the
next write. The anchor is **TSV-internal**: it is **not** a Notion field
and **not** in `property_map` (it differs from auto-Dead, which reused the
already-existing `hm_outreach_date` column — there was no main-status
anchor column to reuse, so one is added here). The 14-day timer does not
need the anchor in Notion.

**14-day threshold.** Fixed at 14 calendar days (two weeks), matching the
operator's mental model ("applied, two weeks of silence → no response").
Configurable via a helper parameter (`thresholdDays`, default 14) but not
exposed as a CLI flag — there is no use case for per-run tuning. Constant
`DEFAULT_THRESHOLD_DAYS = 14` in `engine/core/auto_no_response.js`.

**Source status = `Applied` only.** `No Response` semantically means
"applied and heard nothing". `To Apply` (not yet applied) and every other
status are a different meaning and are never swept. `Interview` / `Offer`
/ `Rejected` / `To Apply` / `Inbox` / `Archived` are never touched.

**No cron / no scheduler.** Same lazy-on-CLI design as auto-Dead (cron /
Notion-native automation explicitly rejected). Pure scan first → cheap
no-op when nothing is stale, safe to run on every command.

**Notion `No Response` write — same class as auto-Dead / `check`, NOT a
new push path.** The sweep writes a single targeted `updatePageStatus`
(`status` property only), engine-authored status data of the same class
as `check`'s status write and auto-Dead's `Dead` write. It does **not**
reintroduce the removed Stage-16 push path; `sync` stays pull-only.

**Implementation = sibling modules (DRY only the date math).** Two new
pure-helper / sweep siblings mirror auto-Dead 1:1:

- `engine/core/auto_no_response.js` — `selectStaleApplied(apps, todayStr,
  thresholdDays = 14)` and `decideAppliedDate(newStatus, currentDate,
  todayStr)`. Both pure, date-injected. The date math (`daysBetween` /
  `epochDay`) is **reused** from `auto_dead.js`, not duplicated.
- `engine/core/auto_no_response_sweep.js` — `runAutoNoResponseSweep`,
  the same DI deps / TSV-only-without-token / per-row try/catch /
  never-throws-out contract as `auto_dead_sweep.js`.

**Terminal-handling side effect (desired).** The `Applied → No Response`
flip feeds the existing terminal-status handling
(`archive_used_artifacts`) downstream — an expected, desired effect, not
fought.

**Edge rules / resilience.** Identical to auto-Dead: empty / malformed
`applied_date` → no timer (skipped); `No Response` is never re-selected
(idempotent); only `Applied` is touched; no `NOTION_TOKEN` → mark
`No Response` in the TSV with a single stderr warn, skip the push; every
Notion call wrapped per-row; the whole sweep wrapped so it can never
throw out of the CLI entry (`scan` / `validate` must still run offline).

**Stamp-precision note.** As with auto-Dead, the anchor is stamped at the
first `sync` that observes `Applied` (using the UTC date portion of the
sync timestamp), not at the exact submission moment. A ±1-day drift is
acceptable for a 14-day timer.

**Out of scope (this amendment).** Cron / scheduler, auto-transitions
from any status other than `Applied`, a per-profile / CLI-flag threshold,
any new Notion field, and any change to the auto-Dead or backfill logic
(only the pure date helpers are reused).
