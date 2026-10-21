# Prepare row worker — brief for one parallel subagent

Used by `/job-pipeline prepare` when rows are fanned out to subagents (always at night, see [`../night-apply.md`](../night-apply.md); optional by day). The orchestrator runs `node engine/cli.js night --profile <id> --phase prepare-fanout`, which writes one small input file per batch row, then launches one subagent per row with this brief and that row's payload path. Many workers run at once; each handles exactly **one** row and never sees the others.

The orchestrator never reads your full output. It reads one summary line from your reply and later collects your result file with `night --phase prepare-collect`. A result file that does not match the schema below is dropped and the row waits for the next round, so get the file right.

## Inputs

Your prompt gives you one path: the **payload** — `profiles/<id>/.prepare-state/rows/payloads/<row>.json`. Read it. It holds:

- `row_key` — echo it back.
- `result_path` — where you write your result (absolute path).
- `tailor_dir` — where a Strong row's tailoring iterations go (Step B).
- `memory_path` — `memory.md` for this round: `## fitProfile` (the candidate's real achievements — what fit is scored against), `## writingStyle`, legacy `## resumeKeyPoints`, `## feedback — …` files. These are `profile_context.memory.*` of the evaluator contract.
- `jd_text_path` — the JD body as a markdown file, or `null` when the engine could not fetch it (then score from `jd_structure`, title and company; say so in the rationale).
- `jd_structure` — `requirements[]`, `responsibilities[]`, `salary_text`, `location_text`, `full_text_excerpt`.
- `profile_context` — company, title, url, `geo_decision` (always `allowed`), `salary`, `salaryConfig`, `clBase` (cover-letter base paragraphs P2–P4, pre-picked by the engine), `roleTargets`, `resumeVersions` (the only legal `resumeVer` keys), `companyTier`, `unknownTier`.
- `tailoring` — `master_profile_path`, `storybank_path`, `target_role_title` for Step 6.5.

Read `memory.md` and the JD file in full. Do not read `prepare_context.json` (it is large and holds every other row).

## Step A — fit, archetype and cover letter

Follow [`.claude/agents/pipeline-fit-evaluator.md`](../../../.claude/agents/pipeline-fit-evaluator.md) exactly, as if you were that agent: its scoring rules, its cover-letter reuse rules (P2 / P4 verbatim from `clBase`, P1 always new, P3 only when the role focus differs), its Humanizer + language-calque pass, its city / state / workFormat extraction. The rubric it points to lives in [`SKILL.md`](../SKILL.md) → `## Global Guard Rails` (Fit Score, Role-track never downgrades, Never volunteer a gap) and `## Humanizer Rules` — read those sections. Score against `## fitProfile`, never against general knowledge of "a PM like this".

`resumeVer` must be a key of `profile_context.resumeVersions.versions`, copied literally.

Weak rows get no cover letter (RFC 034 §5) — omit `clKey` / `clParagraphs` / `clBaseKey`.

## Step B — Strong only: the tailoring loop (SKILL Step 6.5)

For a `Strong` row run the full loop from [`SKILL.md`](../SKILL.md) → Step 6.5. One iteration = one pass of the [`.claude/agents/resume-tailor-mirror.md`](../../../.claude/agents/resume-tailor-mirror.md) contract with that iteration's inputs (`prev_resume_data`, `missing_from_prev`, `iteration_n`).

- If you can launch subagents, run each iteration as a fresh `resume-tailor-mirror` subagent. Otherwise do the iteration yourself, following that file exactly, one pass at a time.
- Write each iteration's output to `<tailor_dir>/iter-<n>.json` (`tailor_dir` is in the payload), so a long loop can be audited.
- Exit rules, checked in order after every iteration: coverage ≥ 85 → `threshold_met`; from iteration 2, growth < 1 point → `no_growth`; iteration 6 → `iteration_cap_reached`. **No other exit** (BL-132): not "good enough", not "this is expensive".
- Then the escalation decision from Step 6.5 and the five fields: `tailoredResume`, `tailorCoverage`, `tailorEscalated`, `tailorEscalationReason`, `tailorEscalationDetail`.

A Strong row still carries `clKey`, `clParagraphs`, `clBaseKey` and `resumeVer` from Step A.

## Step C — unknown company tier

If `profile_context.unknownTier` is `true`, assign `companyTier` (`S` / `A` / `B` / `C`) with the criteria in [`SKILL.md`](../SKILL.md) → Step 5.7. One WebFetch of the company site is fine when you are unsure.

## Step D — write the result file

Write `result_path` with the Write tool: one JSON object, no markdown fence, exactly the `results[]` entry of SKILL Step 10 plus the optional tier:

```json
{
  "row_key": "<echo>",
  "fitScore": "Strong | Medium | Weak",
  "fitRationale": "1–3 sentences, concrete overlap",
  "flags": [],
  "clKey": "<Company>_<role-slug>_<YYYYMMDD>",
  "clParagraphs": ["P1", "P2", "P3", "P4"],
  "clBaseKey": "<clBase.key or null>",
  "resumeVer": "<key from resumeVersions.versions>",
  "salaryMin": 0,
  "salaryMax": 0,
  "city": "",
  "state": "",
  "workFormat": "Remote | Hybrid | Onsite",
  "tailoredResume": {},
  "tailorCoverage": 0,
  "tailorEscalated": false,
  "tailorEscalationReason": null,
  "tailorEscalationDetail": { "iterations": 0, "uncertain_facts": [], "coverage_table": [] },
  "companyTier": "B"
}
```

- `clKey` / `clParagraphs` / `clBaseKey` / `resumeVer` / salary / city / state / workFormat: Strong and Medium only.
- `tailor*` fields: Strong only.
- `companyTier`: only when `unknownTier` was true.
- Never a `decision`, `skipReason`, `clPath` or `notionPageId` field.

## Step E — reply

Reply with **one line of JSON and nothing else**:

```
{"row_key":"<key>","fitScore":"Medium","tailorCoverage":null,"tailorEscalated":false,"written":true}
```

If you could not finish (missing master profile, unreadable payload), still write a result when you can (a `Weak` with `flags: ["evaluation-failed"]` and the reason in `fitRationale`, as the evaluator contract says) and say so in the line: `"written":true,"note":"evaluation-failed: <reason>"`.

## Never

- Never edit `applications.tsv`, `prepare_context.json`, another row's files, or anything in Notion. Never run `node engine/cli.js …`.
- Never invent an achievement, number, employer, title or tool. A gap is honest; a fabricated mirror is not.
- Never call the candidate a founder or co-founder; never claim he hand-codes (see the Fit Score guard rails).
