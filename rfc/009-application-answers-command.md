# RFC 009 — `/job-pipeline answer` command + Notion Q&A integration

**Status**: Draft 2026-04-30 (pending user approval)
**Tier**: L (new command, Notion shared-state writes, SKILL.md changes, retro-data ingest)
**Author**: Claude + Jared
**Depends on**: [RFC 008](./008-companies-as-notion-source-of-truth.md), Stage 16 follow-up Q&A migration

## Problem

The user discovered a bug: `/job-pipeline answer` generates responses to application questions (Why X? / Influences? / Motivation?), but **never saves them to the Notion Q&A database**, even though that database exists, contains 31 entries, and is referenced in `profile.json`.

Current state:
- In [profile.json](../profiles/jared/profile.json): `notion.application_qa_db_id = ca4fa9e8-b3a6-4ccb-bcc2-3a13ff6b06ae`.
- Schema: `Question (title) | Answer (rich_text) | Category (select) | Role (rich_text) | Company (rich_text) | Notes (rich_text)`. Categories: Behavioral, Technical, Culture Fit, Logistics, Salary, Other, Experience, Motivation.
- The DB contains 31 entries (24 Experience + 5 Motivation + 2 Technical) — a historical archive of standard answers.
- There is no `answer` command in `engine/commands/`. In `skills/job-pipeline/SKILL.md`, the word "answer" appears only in Humanizer/Guard Rails subheadings ("prepare / answer modes"), but the actual flow is absent: neither in the command list nor in the step-by-step guide.
- When `/job-pipeline answer …` is called, the skill is interpreted manually: load memory, generate answer, save locally. No reuse of existing answers from the DB, no push back.

Result: answers are written from scratch every time (style drift + wasted tokens), the accumulated archive goes unused, and new work does not accumulate.

## Agreed decisions (after discussion with user on 2026-04-30)

| # | Decision |
|---|---------|
| 1 | **Reuse-first**: before generating, search the Notion Q&A DB by key `company\|\|role\|\|question[:120]` (lowercased). Match → show existing answer + offer reuse / regenerate / edit. |
| 2 | **Auto-push to Notion after approval**: on signals "пойдет" / "good" / "submitted" / "залил" — write to Q&A DB. Additionally — local `.md` backup in `application_answers/`. No explicit flags like `--apply` (for symmetry with the CL flow). |
| 3 | **Auto-categorize with confirmation**: heuristic on the question text determines Category from 8 options. Show the selected category alongside the draft before pushing. |
| 4 | **Retro-add today's Linear + Figma answers** (3 Q&A entries) to the DB in a one-time run after implementation. |
| 5 | Command works per-profile (like all others). DB is taken from `profile.notion.application_qa_db_id`. |
| 6 | Dedup: same key `company\|\|role\|\|question[:120]`. On key match in DB — do NOT create a duplicate; if the answer was rewritten — UPDATE the existing page. |

## Architecture

### New command

```
node engine/cli.js answer --profile <id> [subcommand] [options]
```

Since the primary use case is interactive (Claude generates → user approves → Claude pushes), the command is a **CLI + skill flow hybrid**, like `prepare` and `check`. Three-phase:

#### Phase 1 — search (CLI)

```
node engine/cli.js answer --profile <id> --phase search \
  --company "<Company>" --role "<Role>" --question "<question text>"
```

Runs the dedup key, queries Notion via `application_qa_db_id` with filter `Question contains <head>` AND `Company == <Company>` AND `Role == <Role>`. Returns JSON:

```json
{
  "key": "figma||product manager, ai platform||why do you want to join figma?",
  "matches": [
    {
      "pageId": "...",
      "question": "...",
      "answer": "...",
      "category": "Motivation",
      "exact": true|false
    }
  ],
  "schema": { "categories": ["Behavioral", ...] },
  "category_suggestion": "Motivation"
}
```

If `matches[0].exact` — Claude shows the existing answer and asks reuse/regen.
If matches are partial / empty — Claude generates a new one, drawing on Humanizer Rules + memory (as currently).

#### Phase 2 — SKILL (Claude generates and/or presents)

Logic:
1. If CLI returned `exact match` → show existing answer + say `[reuse] / [regenerate] / [edit]`.
2. Otherwise → run generation (Humanizer Rules + memory as currently) → show draft + suggested category.
3. If there are partial matches (same company+role, different question wording) — show them as reference.

#### Phase 3 — push (CLI)

Called after user approval.

```
node engine/cli.js answer --profile <id> --phase push \
  --results-file profiles/<id>/.answers/draft_<timestamp>.json
```

Where the draft file (Claude writes before calling):

```json
{
  "company": "Figma",
  "role": "Product Manager, AI Platform",
  "question": "Why do you want to join Figma?",
  "answer": "AI Platform is the leverage layer at Figma...",
  "category": "Motivation",
  "notes": "210-char short version. Field: Additional Information.",
  "key": "figma||product manager, ai platform||why do you want to join figma?",
  "existingPageId": null
}
```

CLI:
- If `existingPageId` — UPDATE that page (Answer + Category + Notes).
- Otherwise — CREATE a new page in `application_qa_db_id`.
- Writes local backup to `profiles/<id>/application_answers/<Company>_<role-slug>_<YYYYMMDD>.md` (as already done manually).
- Returns `{ pageId, action: "created"|"updated", url }`.

### Categorization (heuristic)

Pure function in `engine/core/qa_categorize.js` with tests:

```js
function categorize(question) {
  const q = (question || "").toLowerCase();
  if (/why (do you|are you) (want|interested|excited|join)/.test(q)) return "Motivation";
  if (/(motivat|look forward|excit)/.test(q)) return "Motivation";
  if (/(influence|mentor|admire|inspire)/.test(q)) return "Behavioral";
  if (/(tell me about a time|describe a situation|conflict|disagree)/.test(q)) return "Behavioral";
  if (/(salary|compensation|expectations)/.test(q)) return "Salary";
  if (/(visa|sponsor|relocat|start date|notice)/.test(q)) return "Logistics";
  if (/(culture|values|team)/.test(q)) return "Culture Fit";
  if (/(experience with|worked on|tools|stack|technical)/.test(q)) return "Experience";
  return "Other";
}
```

Covered by tests with fixtures for Figma "Why join", Linear "Influences", Linear "Motivation", "Salary expectations", "Visa status", etc.

### SKILL.md changes

In `## Commands` (line 8) add:

```
- **`/job-pipeline answer`** — Generate or reuse application answers (Why join? / Influences? / Motivation? etc.). Three-phase: search Notion Q&A DB by dedup key → reuse if exact match else generate via Humanizer Rules → push answer back to Notion + local .md backup. Per-profile DB at `profile.notion.application_qa_db_id`.
```

Add a new `### answer` section after `### check`, with step-by-step like other commands (Phase 1 / Phase 2 SKILL / Phase 3). Inside — exact steps for reuse → generate → categorize → push.

In `## Anti-patterns` add:

```
- **Do not** generate a new answer without first running `--phase search` and inspecting matches. Reuse before regenerate.
- **Do not** push to Q&A DB without user approval (signals: "пойдет" / "good" / "submitted" / "залил"). Same shared-state rule as CL push.
```

### Files affected

| Path | Change |
|------|--------|
| `engine/commands/answer.js` | NEW. Three-phase command. |
| `engine/commands/answer.test.js` | NEW. Unit tests for phase routing. |
| `engine/core/qa_categorize.js` | NEW. Pure categorization. |
| `engine/core/qa_categorize.test.js` | NEW. ~15 fixture tests. |
| `engine/core/qa_dedup.js` | NEW. Same `dedupKey` as Stage 16 migrate script (extract for reuse). |
| `engine/core/qa_dedup.test.js` | NEW. ~5 tests (lowercase, trim, truncate, missing fields). |
| `engine/core/qa_notion.js` | NEW. Q&A-specific Notion helpers (search by key, create, update). Wraps existing `notion_sync.js`. |
| `engine/core/qa_notion.test.js` | NEW. Mocked Notion client. |
| `engine/cli.js` | MODIFY. Register `answer` command. |
| `skills/job-pipeline/SKILL.md` | MODIFY. Add command to TOC + new section + anti-patterns. |
| `profiles/jared/application_answers/*.md` | EXISTS (created manually 2026-04-30). Will become canonical local backup directory. |
| `scripts/oneoff/retro_seed_qa.js` | NEW. One-off ingest of 3 retroactive answers (2 Linear + 1 Figma) into Q&A DB. |

### Tests

Per DEVELOPMENT.md L-tier rules:
- Unit: `qa_categorize`, `qa_dedup`, `qa_notion` (mocked client) — ~25 tests total.
- Integration: end-to-end answer flow with mocked Notion HTTP, covering: exact-match reuse, no-match generate, update existing, push new.
- Smoke: real call against `application_qa_db_id` creates + deletes a temporary page (cleanup on teardown).
- Multi-agent review: code-reviewer subagent on diff + `/security-review` (Notion writes = shared state).

### Security (S1)

- Q&A DB writes = shared state. Pushes ONLY on explicit user approval signal.
- Dedup by key is mandatory — otherwise risk of duplicates with cumulative effect.
- `JARED_NOTION_TOKEN` is already used for other commands — reusing the existing env var, no new secrets introduced.
- No logs with full answer bodies in `email_check_log.md` or other shared logs (answers are candidate personal data).

### Out of scope for this RFC

- No answer versioning (if an answer is rewritten — the old version is lost in Notion). If needed — separate RFC.
- No bulk import of all answers from cover letters. Q&A only.
- No changes to categories: using the existing set of 8 options. If new ones are needed — additive (as the Stage 16 migrate script did).
- No question autocomplete (search-as-you-type). For now — targeted lookup before generation.

## Work plan

1. **Approve this RFC** by the user.
2. **Phase A — pure helpers + tests** (`qa_categorize`, `qa_dedup`). Local, no Notion.
3. **Phase B — Notion helpers + tests** (`qa_notion` with mocked client).
4. **Phase C — `answer.js` command**, three phases, registered in `cli.js`. Unit + integration tests.
5. **Phase D — SKILL.md** update + anti-patterns.
6. **Phase E — multi-agent review** (code-reviewer + `/security-review`).
7. **Phase F — retro seed** of three today's answers via one-off script.
8. **Phase G — smoke**: real end-to-end run on one new question.
9. **User approval to commit** (L-tier — no commit without explicit ok).

## Open questions

1. **Local backup `.md`** — keep the format I already used today, or do you want a different layout (one folder per company vs. flat)?
2. **Update vs. append**: when editing an existing answer — overwrite the `Answer` field or append a version to `Notes`? Default — overwrite + keep old version in local `.md` backup as `_v2`.
3. **Lilia profile**: create an empty Q&A DB for her now, or defer until she has her first application questions? Default — defer (to avoid creating empty databases).

---

After your approval — proceeding with Phase A. If you have structural changes — I'll incorporate them before writing any code.
