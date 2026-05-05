---
id: RFC-018
title: Documentation system overhaul
status: draft
tier: L
created: 2026-05-05
tags: [docs, refactor]
---

# RFC 018 — Documentation system overhaul

**Status**: Draft 2026-05-05
**Author**: ymuromcev / Claude
**Tier**: L (structural reorganization touching every doc + workflow rules + .gitignore)
**Closes**: BL-6 (documentation pass), G-* doc-related items, GAPS_REVIEW PII risk
**Touches**: every file under `docs/`, `BACKLOG.md`, `incidents.md`, `DEVELOPMENT.md`, `README.md`, `CLAUDE.md`, `.gitignore`, `~/.claude/skills/dev-workflow/SKILL.md`, new `private/` tree, new `.obsidian/` baseline, new `scripts/check_docs_links.js`, pre-commit hook PII patterns.

---

## 1. Problem

Current state:

1. **`docs/GAPS_REVIEW.md` duplicates `BACKLOG.md`** — it's a one-time audit artifact whose actionable items already migrated to backlog. Both maintained in parallel = stale info.
2. **PII leak risk** — `GAPS_REVIEW.md` and several `*_head_to_head.md` files contain real candidate names and live in the public repo. Pre-commit guard checks code, not `docs/`.
3. **No information architecture** — `docs/` is a flat bucket of 8 files. No taxonomy. New reader has no entry point. Existing material straddles genres (`SPEC.md` is 1725 lines mixing reference, spec, decision rationale).
4. **`BACKLOG.md` mixes 4 genres** — TODO items, research dumps (BL #8), session handoffs, cross-cutting concerns. Doesn't scale, hard to read in Obsidian.
5. **No cross-refs** — RFCs don't know about ADRs (none exist yet), `CHANGELOG.md` doesn't exist, BACKLOG references stale GAPS items, `incidents.md` is gitignored despite being valuable for learning.
6. **Doc maintenance is implicit** — no rule "if you change X you must update Y". Reference docs drift from code.
7. **Obsidian unfriendly** — `.obsidian/` is gitignored, no vault config, wikilinks not enforced (good — relative MD links work both Obsidian + GitHub but no policy stating that).

---

## 2. Goals & non-goals

**Goals:**

- One unified system: every doc has a clear genre, location, and audience.
- PII-safe public repo: real names blocked at pre-commit; private notes in gitignored `private/`.
- Obsidian-native experience for the maintainer (vault baseline committed; Dataview-driven backlog).
- GitHub-render parity: same files render correctly on GitHub (relative links, MD tables).
- Doc-maintenance enforced at the workflow level (trigger table + DOD checklist + CI link audit).
- BACKLOG as a queryable database, not a wall of text.

**Non-goals:**

- Public roadmap / commitments. The repo stays "personal toolkit, public source." `ROADMAP.md` is **not** created.
- Rewriting existing RFC content (001–017). Frontmatter is added; RU sentences are translated to EN (mechanical pass, no semantic edits).
- Auto-generated reference (no docfx/typedoc). Reference docs are hand-written and reviewed.
- Bilingual maintenance. Public docs are EN-only; private docs are RU; no mirrored translations.

---

## 3. Target structure

```
/  (public repo)
├── README.md                          ← landing, links to docs hub
├── CHANGELOG.md                       ← Keep a Changelog format, semver
├── CLAUDE.md                          ← AI agent rules (existing, slim)
├── DEVELOPMENT.md                     ← canonical dev principles + doc rules + tier summary
├── ARCHITECTURE.md                    ← C4 L1 + L2 (~80 lines), points to docs/architecture/*
├── CONTRIBUTING.md                    ← (existing, link to docs hub added)
├── incidents.md                       ← anonymized postmortems (moves from gitignored)
├── .obsidian/                         ← committed baseline (see §6)
├── docs/
│   ├── README.md                      ← hub / MOC: links to every section
│   ├── product/                       ← WHY (Diátaxis: explanation)
│   │   ├── vision.md
│   │   └── personas.md                ← anonymized: PM-Pete, Healthcare-Hannah
│   ├── architecture/                  ← WHAT (Diátaxis: explanation + reference)
│   │   ├── overview.md                ← C4 L3 detail, data flow narrative
│   │   ├── data-flow.md               ← TSV ↔ Notion ↔ Gmail diagrams
│   │   ├── multi-profile.md           ← isolation model, secret namespacing
│   │   └── adrs/
│   │       ├── README.md              ← ADR index table
│   │       ├── 001-multi-profile.md
│   │       ├── 002-notion-as-ui.md
│   │       ├── 003-mcp-vs-oauth.md
│   │       └── 004-fly-vs-launchd.md
│   ├── runbooks/                      ← HOW (Diátaxis: how-to)
│   │   ├── new-profile.md             ← Stage 18 wizard end-to-end
│   │   ├── adding-adapter.md          ← new ATS adapter recipe
│   │   ├── notion-setup.md            ← (moved from docs/notion-setup.md)
│   │   ├── gmail-cron.md              ← (moved from docs/gmail_cron.md)
│   │   ├── backfill-tsv.md            ← post-migration backfill recipe
│   │   └── adding-pipeline-step.md    ← extracted from DEVELOPMENT.md
│   ├── reference/                     ← REFERENCE (Diátaxis)
│   │   ├── cli.md                     ← every CLI command + flag
│   │   ├── tsv-schema.md              ← v1/v2/v3 history + current
│   │   ├── notion-schema.md           ← Jobs + Companies + aux DB properties
│   │   └── spec.md                    ← (slimmed from docs/SPEC.md, behavioral contracts only)
│   └── audits/                        ← one-time reports, history-preserving
│       ├── 2026-05-gap-review.md      ← anonymized GAPS_REVIEW
│       ├── 2026-05-04-scan-head-to-head.md
│       ├── 2026-05-04-prepare-pm.md   ← anonymized prepare_head_to_head
│       └── 2026-05-04-prepare-hc.md   ← anonymized lilia_prepare_head_to_head
├── rfc/
│   ├── README.md                      ← RFC index with status table
│   └── NNN-*.md                       ← (existing 001–018 + future)
└── (rest of repo unchanged)

(gitignored, local maintainer only)
private/
├── BACKLOG.md                         ← Dataview MOC: live table over backlog/
├── backlog/                           ← one file per item, frontmatter-driven
│   ├── BL-6.md
│   ├── BL-7.md
│   ├── BL-8.1.md
│   ├── G-29.md
│   └── …
├── handoffs/                          ← session handoffs
│   └── 2026-05-05-bl6-doc-overhaul.md
├── personas-real.md                   ← real-name ↔ persona mapping (Claude reads this)
└── audit-internal/                    ← non-anonymized GAPS originals if needed
```

**Diátaxis mapping**: product = explanation, architecture = explanation + reference (mixed by C4 nature), runbooks = how-to, reference = reference, audits = explanation (historical), ADRs = decisions (sui generis, Diátaxis-adjacent).

---

## 4. Migration plan

File-by-file action table. `→` = move + edit, `≫` = split, `🗑` = delete after content extracted, `+` = create new.

| Source | Action | Target | PII check |
|---|---|---|---|
| `docs/GAPS_REVIEW.md` | → anonymize | `docs/audits/2026-05-gap-review.md` | replace names → personas; remaining items → `private/backlog/` |
| `docs/SPEC.md` (1725 lines) | ≫ split | `docs/reference/spec.md` (behavioral contracts) + extract architectural sections to `docs/architecture/overview.md` | scan for names |
| `docs/ai-assistant-notes.md` | ≫ split + 🗑 | architectural narrative → `docs/architecture/overview.md`; AI-specific guidance merged into `CLAUDE.md`; original file deleted | — |
| `docs/gmail_cron.md` | → | `docs/runbooks/gmail-cron.md` | scan |
| `docs/notion-setup.md` | → | `docs/runbooks/notion-setup.md` | scan |
| `docs/scan_test_plan.md` | → | `docs/audits/2026-05-04-scan-head-to-head.md` | scan |
| `docs/prepare_head_to_head.md` | → anonymize | `docs/audits/2026-05-04-prepare-pm.md` | replace real name → `PM-Pete` |
| `docs/lilia_prepare_head_to_head.md` | → anonymize | `docs/audits/2026-05-04-prepare-hc.md` | replace real name → `Healthcare-Hannah` |
| `DEVELOPMENT.md` (36 lines) | ⤴ expand in place | `DEVELOPMENT.md` (~150 lines): existing content + doc-maintenance triggers + tier summary + link to skill | — |
| `BACKLOG.md` (gitignored, ~1k lines) | ≫ split per-item | `private/backlog/<id>.md` × N + `private/BACKLOG.md` (Dataview MOC) | stays gitignored |
| `incidents.md` (gitignored) | → anonymize, **un-gitignore** | `incidents.md` at repo root | replace names → personas; original kept in `private/audit-internal/incidents-real.md` if needed |
| `README.md` (241 lines) | ⤴ slim + add docs map | `README.md` (~180 lines): "Documentation" section linking to `docs/README.md` and key entry points | — |
| `CLAUDE.md` (root + project) | ⤴ patch | add reference to `DEVELOPMENT.md` doc-maintenance section, no content overlap | — |
| — | + create | `CHANGELOG.md` v0.21.0 first entry covering RFC 014/015/016/017/018 + Stage history compressed | — |
| — | + create | `ARCHITECTURE.md` (root, ~80 lines C4 L1+L2) | — |
| — | + create | `docs/README.md` (hub MOC) | — |
| — | + create | `docs/product/{vision,personas}.md` | personas anonymized |
| — | + create | `docs/architecture/{overview,data-flow,multi-profile}.md` + `adrs/{README,001..004}.md` | — |
| — | + create | `docs/runbooks/{new-profile,adding-adapter,backfill-tsv,adding-pipeline-step}.md` | — |
| — | + create | `docs/reference/{cli,tsv-schema,notion-schema}.md` | — |
| — | + create | `rfc/README.md` (RFC index) | — |
| — | + create | `.obsidian/{app,core-plugins,community-plugins}.json` baseline | — |
| — | + create | `scripts/check_docs_links.js` (npm script) | — |
| — | + create | `private/personas-real.md` (Claude-readable name map) | gitignored |

---

## 5. BACKLOG format (Variant B — file-per-item + Dataview)

### 5.1 Frontmatter schema

Every `private/backlog/<id>.md`:

```yaml
---
id: BL-6
title: Documentation system overhaul
status: in-progress    # idea | planned | in-progress | blocked | done | cancelled
tier: L                # XS | M | L
priority: P0           # P0 | P1 | P2 | P3
refs:                  # optional cross-refs
  - RFC-018
created: 2026-05-05
decided: 2026-05-05    # date status moved to planned/in-progress; optional
closed:                # date moved to done/cancelled; optional
tags: [docs, refactor]
---

## Context
Why this exists, link back to triggering RFC / ADR / incident.

## Sub-tasks
- [ ] Phase 1
- [ ] Phase 2

## Notes
Free-form working notes; running log.
```

### 5.2 BACKLOG.md hub (Dataview)

```markdown
# Backlog

## Active

\`\`\`dataview
TABLE status, tier, priority, refs
FROM "private/backlog"
WHERE status != "done" AND status != "cancelled"
SORT priority ASC, created ASC
\`\`\`

## Blocked

\`\`\`dataview
TABLE refs, file.mtime AS "Last touched"
FROM "private/backlog"
WHERE status = "blocked"
\`\`\`

## Recently closed (last 30 days)

\`\`\`dataview
TABLE closed, refs
FROM "private/backlog"
WHERE (status = "done" OR status = "cancelled") AND closed >= date(today) - dur(30 days)
SORT closed DESC
\`\`\`
```

(Triple-backtick escape used in this RFC; in real file it's vanilla Dataview blocks.)

### 5.3 ID conventions

- `BL-N` — backlog items (continues current numbering).
- `G-N` — gaps from initial audit (GAPS_REVIEW); preserved IDs.
- `INC-YYYYMMDD-slug` — incident-spawned items.
- ADR / RFC referenced by their own IDs.

### 5.4 Migration

`scripts/migrate_backlog_to_files.js` (one-shot, dry-run default): parses current `BACKLOG.md` headings, extracts ID + title + status + body, writes per-file with inferred frontmatter. Manual cleanup pass after.

---

## 6. Obsidian configuration

### 6.1 .gitignore changes

Remove:
```
.obsidian/
**/.obsidian/
```

Add specific volatile state:
```
.obsidian/workspace*.json
.obsidian/graph.json
.obsidian/cache
.obsidian/plugins/*/data.json
```

### 6.2 Committed baseline

`.obsidian/app.json`:
```json
{
  "useMarkdownLinks": true,
  "newLinkFormat": "relative",
  "alwaysUpdateLinks": true,
  "showLineNumber": true,
  "promptDelete": true
}
```

`.obsidian/core-plugins.json`: enable backlinks, outgoing-links, file-recovery, command-palette, page-preview, search, switcher, templates.

`.obsidian/community-plugins.json`: `["dataview"]` (required for backlog hub).

User installs Dataview manually on first open (Obsidian prompts). Plugin's own data files stay gitignored.

### 6.3 Link policy

- All cross-references use **relative MD paths**: `[ADR-002](../architecture/adrs/002-notion-as-ui.md)`.
- Wikilinks `[[]]` are forbidden (break GitHub render).
- Obsidian `useMarkdownLinks=true` enforces this.
- `scripts/check_docs_links.js` fails CI on broken relative links.

---

## 7. Doc-maintenance triggers

Mandatory updates per change type. Verified in DOD before PR considered done.

| Code change | Doc to update |
|---|---|
| New CLI command / flag | `docs/reference/cli.md` |
| New TSV column / schema bump | `docs/reference/tsv-schema.md` + `CHANGELOG.md` |
| New Notion property | `docs/reference/notion-schema.md` |
| New ATS adapter | `docs/reference/cli.md` (if flags) + optional `docs/runbooks/adding-adapter.md` if pattern changes |
| Architectural decision | new ADR in `docs/architecture/adrs/` + linkback from `ARCHITECTURE.md` |
| RFC accepted/superseded | update RFC frontmatter `status:` + `superseded-by:` |
| BACKLOG item closed | update `private/backlog/<id>.md` frontmatter `status: done`, `closed: <date>` |
| Production incident | add entry to `incidents.md` (anonymized) |
| Version bump | append entry to `CHANGELOG.md` with refs to RFC/ADR/PRs |
| New runbook-worthy operation | new file in `docs/runbooks/` |

---

## 8. Process rules (added to `~/.claude/skills/dev-workflow/SKILL.md` Step 9)

1. **Tier M/L DOD includes "doc maintenance verified"** — agent walks the trigger table (§7), confirms each applicable row is satisfied, lists the affected files in the completion report.
2. **PII guard extended** — pre-commit hook adds `docs/`, `incidents.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `README.md`, `rfc/` to its scan paths. Real candidate / maintainer names (the literal strings live only in `.git-hooks/pii-patterns.txt`, gitignored from the repo's content but checked by the hook) trigger a block. Persona aliases (`PM-Pete`, `Healthcare-Hannah`) are allow-listed.
3. **Cross-link audit** — `npm run docs:check` runs `markdown-link-check`-style validator on all `*.md` (excluding `node_modules`, `private/`). Pre-commit: warn. CI: fail. Script lives at `scripts/check_docs_links.js`.
4. **RFC frontmatter required** — all RFCs gain `status` (draft|accepted|implemented|superseded|rejected), `created`, `decided` (when applicable). Existing RFC frontmatter back-filled in phase 3.
5. **ADR vs RFC distinction**:
   - **RFC** — design proposal, ~150–300 lines, gates implementation, written before code.
   - **ADR** — decision crystallized from RFC after implementation, ~50–100 lines, Nygard format (Context / Decision / Consequences). Usually one ADR per accepted RFC, but small decisions can skip RFC and go straight to ADR.

---

## 9. Phasing

Five phases, gated. Each phase ends with a smoke check and approve before next.

### Phase 1 — Foundation (low risk, no content moves)
- Create empty target dirs (`docs/{product,architecture,runbooks,reference,audits}`, `docs/architecture/adrs`, `private/{backlog,handoffs}`).
- Add `docs/README.md`, `rfc/README.md` skeletons (link tables, no content).
- Add `.obsidian/` baseline + `.gitignore` patch.
- Add RFC frontmatter back-fill to 001–017 (status: implemented for 001/002/004/008/012/013/014; status: draft for 015/016/017; rejected/superseded as applicable).
- Add `scripts/check_docs_links.js`.
- **Smoke**: `npm run docs:check` green. Obsidian opens repo as vault and shows correct structure.

### Phase 2 — Write (parallelizable via agents)
- 4 ADRs (4 agents, ~50 lines each): multi-profile / Notion-as-UI / MCP-vs-OAuth / fly-vs-launchd.
- `docs/product/vision.md` + `personas.md` (1 agent).
- `docs/architecture/{overview,data-flow,multi-profile}.md` (1 agent, source: `SPEC.md` + `ai-assistant-notes.md` + RFCs).
- `ARCHITECTURE.md` root (1 agent, ~80 lines C4).
- `docs/runbooks/{new-profile,adding-adapter,backfill-tsv,adding-pipeline-step}.md` (1 agent, source: existing scripts + RFCs).
- `docs/reference/{cli,tsv-schema,notion-schema}.md` (1 agent, source: code + Stage history).
- **Smoke**: every new doc renders in Obsidian without broken links; PII guard passes on all new files.

### Phase 3 — Migrations + translation (anonymization-heavy)
- Anonymize + move `GAPS_REVIEW`, `prepare_head_to_head`, `lilia_prepare_head_to_head`, `scan_test_plan` → `docs/audits/`.
- Move `gmail_cron`, `notion-setup` → `docs/runbooks/`.
- Slim `SPEC.md` → `docs/reference/spec.md`; merge architectural parts into `architecture/overview.md`.
- Anonymize + un-gitignore `incidents.md`.
- Run `scripts/migrate_backlog_to_files.js` → `private/backlog/`.
- Update `DEVELOPMENT.md`, `README.md`, `CLAUDE.md` per migration table.
- Drop `docs/GAPS_REVIEW.md`, `docs/SPEC.md`, `docs/*head_to_head*.md` etc. originals (after target verified).
- **Translation pass** per §16: `scripts/scan_cyrillic.js` finds RU prose, agents translate in parallel.
- **Smoke**: link audit green; PII guard green; `scan_cyrillic.js` green; sample backlog item visible in Dataview hub.

### Phase 4 — CHANGELOG + Release
- Write `CHANGELOG.md` v0.21.0 covering RFC 014/015/016/017/018 + Stage 8/9/10/19 in compressed form, refs to ADR/RFC.
- GitHub Release `v0.21.0` referencing CHANGELOG + key new docs.
- **Smoke**: release published; CHANGELOG links resolve on github.com.

### Phase 5 — Workflow rules
- Patch `~/.claude/skills/dev-workflow/SKILL.md` Step 9 with trigger table + 5 process rules.
- Patch `.git-hooks/pre-commit` PII scan to cover `docs/` + new patterns file.
- Add `npm run docs:check` to `.github/workflows/*.yml` CI.
- **Smoke**: deliberate breaking PR (real name in `docs/`) gets blocked locally + in CI.

---

## 10. Resolved questions (from draft review 2026-05-05)

1. **`incidents.md`: public, anonymized.** Moved to repo root, names → personas. Original kept in `private/audit-internal/` if needed.
2. **`docs/ai-assistant-notes.md` fate: split + delete.** Architectural narrative → `docs/architecture/overview.md`; AI-specific guidance merged into `CLAUDE.md`; original file removed.
3. **RFC compression: keep verbatim.** Existing RFCs 001–017 preserved as-is (history). RU sentences translated to EN during phase 3 (mechanical pass, no semantic edits). ADR pointers added retroactively where applicable.
4. **Persona names: `PM-Pete` / `Healthcare-Hannah`.** Confirmed.
5. **`audit_*.md` gitignore: kept.** Transient working notes never reach public; CONTRIBUTING.md gains a one-line note explaining the convention.

---

## 11. Rollback plan

Each phase's changes commit on a separate branch (`docs-phase-N`). If phase fails review:

- Phase 1: revert single commit, no content lost (only structure).
- Phase 2: discard branch, drafts unsaved or moved to `private/draft-docs/`.
- Phase 3: most destructive. Mitigation: source files kept on disk until phase 5 green-lights deletion. Migration scripts produce `*.pre-migrate` backups (per Stage 16 pattern).
- Phase 4: revert CHANGELOG + draft release (don't publish until smoke passes).
- Phase 5: revert hook + CI changes; existing PRs unaffected.

---

## 12. Estimate & dependencies

- Total: ~4–5 working sessions.
- Phase 1: 1–2h (mostly file creation + frontmatter back-fill).
- Phase 2: 4–6h, parallelizable (3 agents in flight at once).
- Phase 3: 5–7h (anonymization + script + manual cleanup + EN translation pass per §16).
- Phase 4: 1–2h (CHANGELOG mostly mechanical from git log + Stage history).
- Phase 5: 1h (skill + hook + CI patches).

Dependencies: none. Doesn't touch engine code. Pre-commit hook patch must land before phase 3 anonymization PR (so PII guard catches mistakes during migration).

---

## 13. Acceptance criteria

- [ ] All target dirs exist; `docs/README.md` MOC reachable from `README.md`.
- [ ] No real names anywhere in tracked files (verified by `.git-hooks/pre-commit` PII pattern scan + manual grep against `.git-hooks/pii-patterns.txt`).
- [ ] `npm run docs:check` green; CI integration active.
- [ ] `BACKLOG.md` in Obsidian shows live Dataview tables; clicking an item opens its `.md` file.
- [ ] All 18 RFCs have valid frontmatter; `rfc/README.md` index correctly reflects status of each.
- [ ] 4 ADRs published; `ARCHITECTURE.md` references them.
- [ ] `CHANGELOG.md` v0.21.0 published as GitHub Release.
- [ ] `~/.claude/skills/dev-workflow/SKILL.md` Step 9 contains trigger table; pre-commit hook PII scan covers `docs/`.
- [ ] Pre-commit + CI block a deliberate PII test-PR.
- [ ] `scripts/scan_cyrillic.js` returns zero matches across public surfaces.

---

## 14. Out of scope (explicit non-changes)

- No content rewrites of existing RFCs 001–017 (frontmatter + EN translation only; semantics unchanged).
- No engine code changes.
- No public roadmap.
- No bilingual mirroring of docs (each doc is single-language per §15).
- No auto-generated reference (typedoc/docfx).
- No GitHub Discussions / Wiki migration.

---

## 15. Language policy

| Surface | Language | Notes |
|---|---|---|
| Public repo (everything outside `private/`) | **EN** | Includes README, CHANGELOG, ARCHITECTURE, DEVELOPMENT, CLAUDE.md, all `docs/`, all `rfc/`, all `incidents.md` |
| `private/BACKLOG.md`, `private/backlog/*.md` | **RU** | User-preferred; not crawled |
| `private/handoffs/*` | **RU or EN** | Author's choice |
| `private/audit-internal/*` | **Any** | Pre-anonymization originals can stay in any language |
| Code, identifiers, code comments | **EN** | Existing CLAUDE.md rule, unchanged |
| Chat between user and Claude | **RU** | Existing CLAUDE.md rule, unchanged |
| Notion hub content (per profile) | **Per profile** | Healthcare-Hannah hub = RU; PM-Pete hub = EN; this is candidate-facing UX |

**Rules:**

1. Public docs are EN-only. RU sentences in `docs/`, `rfc/`, `ARCHITECTURE.md`, `CHANGELOG.md`, `incidents.md`, `README.md`, `DEVELOPMENT.md`, `CLAUDE.md` are linted as warnings (Cyrillic-char regex in `scripts/check_docs_links.js`'s sister check, or a separate `scripts/check_docs_lang.js`).
2. Existing RU content in RFCs 001–017 gets a **mechanical translation pass** during phase 3 — same meaning, EN words. No semantic edits, no restructuring. Tracked per-file (`scripts/translate_rfcs.js` produces a checklist).
3. No bilingual mirroring (no `doc.en.md` / `doc.ru.md` siblings, no `## English / ## Русский` sections inside one file). One source per doc.
4. When the user reads an EN doc and needs clarification, the bridge is the chat (RU↔EN on demand) — not duplicate translated artifacts.
5. New RFCs / ADRs / runbooks / reference / product docs are **drafted in EN from day one**.

**Practical phase-2 workflow** (writing new docs): Claude briefs in RU, drafts in EN, user reviews in EN, discussion in RU, final commit EN.

---

## 16. Translation pass — phase 3 sub-plan

Scope: 17 existing RFCs (001–017) + this RFC's predecessors + any RU content found in `docs/*.md`.

Approach:
- `scripts/scan_cyrillic.js` — list every file under `docs/`, `rfc/`, root `*.md` that contains Cyrillic chars, with line numbers.
- For each match: translate in place, preserve formatting, code blocks untouched.
- Parallelizable via agents (1 agent per 3-4 RFCs, brief = "translate Cyrillic prose to EN, no semantic changes, preserve all code/identifiers/links/quoted strings").
- Verification: re-run `scan_cyrillic.js`, output should be empty (or only inside intentional `<!-- ru: ... -->` HTML comments, which are forbidden by §15 rule 3 anyway).

Estimate: 2–3 hours, parallelized.

---

*Approve gates: this RFC → phase 1 → phase 2 → phase 3 → phase 4 → phase 5. Each phase produces a smoke report; no auto-progression.*
