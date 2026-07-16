---
id: RFC-063
title: Manual job entry — `add` command as a second caller of pushJobPage
status: accepted
tier: M
created: 2026-07-16
tags: [engine, cli, notion, manual-entry, tsv]
---

# RFC 063 — Manual job entry: `add` as a second caller of `pushJobPage`

- **Status:** Accepted (approved 2026-07-16, implemented)
- **Tier:** M (new command + CLI registration + tests + docs; no schema change)
- **Refs:** BL-208, RFC 014 (Inbox is TSV-only), RFC 022 (atomic per-row Notion push)
- **Date:** 2026-07-16

## 1. What changes for the user

Vacancies that arrive outside the ATS scan — referrals, Lenny's Newsletter,
recruiter emails, applying straight on a company site — currently need a
one-off script each time. Three such entries in two months (Virto Commerce,
the Lenny's batch, LawnStarter). After this change there is one command:

```
node engine/cli.js add --profile jared \
  --company "LawnStarter" \
  --title "Senior Product Manager, Pricing & Monetization" \
  --status Interview \
  --salary 140000-185000 \
  --locations "Remote,United States" \
  --url https://...
```

- **Dry-run by default** (same convention as `sync` / `companies-upsert`).
  Prints the TSV row to be written, the company resolution
  (`found` / `will create`), and the Notion fields. `--apply` writes.
- **TSV backup** before write: `applications.tsv.pre-add-<slug>-<date>`.
- **Key generated**: `manual:<company-slug>_<title-slug>_<YYYY-MM-DD>`.
- **Duplicates refused** before any write, with the existing row printed.
- **Notion page link** printed on success.

## 2. The invariant question, and why this is not a second writer

`CLAUDE.md` and RFC 014 / 022 state that new Notion job pages are created
**exclusively by `prepare --phase commit`**, and that a push path must not be
re-added without an RFC. BL-208 framed three options; the user picked
**option 3 — one shared helper, two entry points**.

The finding that makes this cheap: **the shared helper already exists.**
`engine/core/notion_job_page.js` → `pushJobPage()` already owns the whole
page-creation path — lazy `data_source_id` resolution, dedup-by-`key` against
the Jobs DB, Company relation resolution, `createJobPage`. It is dependency-
injected and does no filesystem or env access. `prepare` is simply its first
caller (`engine/commands/prepare.js:829`).

So `add` does **not** introduce a new writer. It becomes the **second caller
of the same helper**. The invariant is restated, and gets stronger:

> **Old:** only `prepare --phase commit` creates Notion job pages.
> **New:** all Notion job-page creation goes through
> `notion_job_page.pushJobPage`. `prepare --phase commit` and `add` are its
> only callers. Nothing else calls `createJobPage` directly.

This is a tighter invariant than the old one: it is enforceable by grep
(`createJobPage` must appear only in `notion_sync.js` and `notion_job_page.js`),
whereas "only prepare" was enforceable only by convention. `sync` stays
pull-only — untouched.

**Known exception:** `scripts/push_prepare_results_to_notion.js` calls
`createJobPage` directly, bypassing `pushJobPage` and therefore its
dedup-by-key guard. It is a one-off from the Lenny's batch, on no automated
path. It stays (§10.4), so the invariant is enforced within `engine/`.

## 3. Why manual rows skip `Inbox`

RFC 014: fresh `scan` rows are `Inbox`, meaning "discovered, not yet
evaluated — URL liveness, fitScore, resume archetype, CL all still absent",
and `Inbox` rows by definition have `notion_page_id == ""` and never reach
Notion. The `Inbox → To Apply` transition and page creation happen atomically
inside `prepare --phase commit`.

A manual row is categorically not that. The operator is entering it precisely
*because* they already know what it is — typically "I already applied" or "I
have an interview". Its status is asserted by the human, not derived by
`prepare`. Running it through `prepare` (filter, URL-check, JD-fetch,
salary-calc, fit-eval, resume + CL generation) would be expensive machinery
producing artifacts nobody wants for a row that is already past that stage.

So: `add` writes the operator-supplied status directly and creates the page in
the same run. `--status` accepts the Notion status set
(`To Apply / Applied / Interview / Offer / Rejected / Closed / No Response /
Archived`) and is validated against it — never `Inbox`, which is TSV-only by
RFC 014 and would fail Notion validation anyway.

**Default:** `--status` is **required**, no default. The three real cases so
far were `Interview`, `Applied`, `Applied` — there is no safe default, and
guessing wrong writes a wrong card into the pipeline.

## 4. Failure ordering — Notion first, then TSV

RFC 022 chose, for the batch case: a per-row Notion failure leaves the row
`Inbox` silently, the batch continues, the next run retries. That is right for
a 20-row unattended batch.

`add` is the opposite situation — one row, interactive, operator watching. It
inverts the choice:

1. Resolve company → create page via `pushJobPage`.
2. Only on success: back up TSV, append row with `notion_page_id`, save.
3. On any Notion error: **write nothing**, exit non-zero, print the error.

Rationale: a TSV row with an empty `notion_page_id` and status `Interview` is
not a valid state in this design — it is neither an `Inbox` row (which is
legitimately Notion-less) nor a synced row. `sync` would later see it as a
discrepancy. Better to write nothing and let the operator re-run.

`pushJobPage`'s dedup-by-key guard makes the re-run safe: if the page was in
fact created before the crash, the retry finds it by key and returns
`{dedup: true}` instead of creating a second one.

## 5. Duplicate detection

Two layers, both before any write:

- **Exact key** — `manual:<company-slug>_<title-slug>_<date>` already in TSV
  → refuse, print the existing row.
- **Same company + similar title** — any non-archived row with the same
  normalized company name and a title match → refuse, print the candidates,
  require `--force` to proceed. Catches the real case: same job entered twice
  on different days, so the date-suffixed keys differ.

Title normalization is a title-specific matcher local to `manual_job.js`, not
`sweep_dedup.normalizeName` — see §10.3.

`pushJobPage`'s own dedup-by-key against the Jobs DB stays as the last line of
defence for the crash-window case.

## 6. Shape

- `engine/commands/add.js` — the command: arg parsing, dry-run rendering, TSV
  backup, orchestration. Side effects live here.
- `engine/core/manual_job.js` — pure helpers, no I/O:
  - `slugify(name)` / `makeManualKey({company, title, date})`
  - `parseSalaryRange("140000-185000")` → `{min, max}`
  - `validateStatus(s)` against the Notion status set
  - `buildManualRow(input)` → the flat TSV row object (v7, 27 columns)
  - `buildJobFields(row)` → the flat payload `pushJobPage` consumes
  - `findDuplicates(apps, row)` → the candidate list for §5
- `engine/cli.js` — register `add` in `KNOWN_COMMANDS`.

Reused as-is, no changes: `applications_tsv` (`load` / `save`),
`company_resolver.makeCompanyResolver`, `notion_job_page.pushJobPage`,
`notion_sync.makeClient` / `resolveDataSourceId`, `profile_loader`
(`loadProfile` / `loadSecrets` — the token is read at runtime, never inline).

Salary display: use `notion_job_page.formatSalaryDisplay`, which yields
`$140-185K ($165K mid)`. (The LawnStarter one-off hand-wrote
`"$140-185K base (posted)"` — inconsistent; the helper wins.)

## 7. Tests

Node's built-in runner, no network:

- `manual_job.test.js` — slug/key generation, salary parsing (valid, single-
  bound, garbage), status validation (rejects `Inbox` and unknown values),
  row shape matches TSV v7 header, duplicate detection (exact key; same
  company + similar title; no false positive on a genuinely different title).
- `add.test.js` — arg parse; dry-run writes nothing and calls no client;
  happy path with a fake client + fake resolver creates the row and persists
  `notion_page_id`; **Notion throws → TSV byte-identical**; `pushJobPage`
  returns `{dedup: true}` → row written with the existing page id, no second
  page.

## 8. Definition of Done

- [x] `add` creates row + page in one run; dry-run default; `--apply` writes.
- [x] Re-run with the same arguments → refused, no duplicate.
- [x] Notion failure → TSV unchanged, non-zero exit.
- [x] Within `engine/`, `createJobPage` is called only from `notion_sync.js` /
      `notion_job_page.js`. (`scripts/push_prepare_results_to_notion.js` is a
      known legacy exception — see §10.4.)
- [x] `npm test` green; new tests hit no network.
- [x] `docs/reference/cli.md` + `CLAUDE.md` + `docs/architecture/` updated; `CLAUDE.md`
      invariant text updated to the §2 wording.
- [x] BL-208 closed with `closed:` date.

## 9. NOT in scope

- Fit-eval for manual rows. `--fit` is passed by hand or left empty.
- Resume / CL generation.
- Batch import (CSV, Lenny's-style lists). One row first.
- Retro-filling `applied_date` / `resume_ver` on existing manual rows.
- Any change to `sync` (stays pull-only) or to `prepare`'s behaviour.

## 9a. Implementation note — the bug the unit tests could not see

`engine/cli.js` builds `ctx.flags` as an **explicit whitelist**, not a
pass-through of `parseArgs` values. Registering a flag in `PARSE_OPTIONS` is
therefore only half the wiring; it must also be threaded into the `ctx.flags`
literal. The first implementation missed this, so every new flag parsed
correctly and arrived at the command as `undefined` — `add --title X` failed
with `--title is required`.

`add.test.js` could not catch it: command tests construct `ctx` by hand, which
mocks away the exact layer that was broken. The first live run caught it
immediately. Regression coverage now lives in `cli.test.js` (`add: every
registered flag reaches the command through ctx.flags`), asserting through the
real `runCli` with a spy command. Any future command adding flags is covered by
the same shape.

## 10. Resolved

1. **`--tier S|A|B|C`** — accepted, optional. When passed, `add` writes it into
   `profile.json` → `company_tiers` (the salary matrix reads tiers from there,
   so an untiered company silently loses its comp read). When absent, the
   company page is still created and the tier stays unset — `add` never guesses
   a tier.
2. **`--applied-date YYYY-MM-DD`** — accepted, optional. Manual rows are usually
   "already applied" and the TSV column exists; capturing it is free. Left empty
   when not passed. (The LawnStarter row's empty `applied_date` can be filled
   later by hand — out of scope, per §9.)
3. **Title normalization for §5** — a small title-specific matcher inside
   `manual_job.js`: lowercase, strip punctuation, collapse whitespace, drop
   seniority prefixes (`senior`, `sr`, `staff`, `lead`, `principal`) for the
   comparison only. Not reusing `sweep_dedup.normalizeName` — it is built for
   company names (legal suffixes, Cyrillic) and stretching it onto job titles
   would couple two unrelated dedup domains.
4. **`scripts/push_prepare_results_to_notion.js`** — **kept as-is.** Deleting a
   script is the operator's call, not a technical one, and there is no standing
   approval for it. Consequence: the §8 invariant grep is scoped to `engine/`
   rather than the whole repo. The script stays a known legacy one-off that
   bypasses `pushJobPage`'s dedup; it is not on any automated path. If it should
   go, that is a separate one-line ask.
