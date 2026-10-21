# Night apply — the unattended nightly run

The exact sequence an unattended Claude session executes every night to find, prepare and submit applications (RFC 068 §9 / §11, BL-225). Goal: **~100 submitted applications per night**, no daily cap — as many as fit before the morning. Everything per-row runs in parallel subagents; the orchestrating session only moves file paths, counts and one-line summaries.

The scheduled task prompt is just: **"Open `skills/job-pipeline/night-apply.md` in the ai-job-searcher repo and execute it end to end."** Nobody is watching: never ask a question, never wait for an answer. When something is unclear, take the conservative path (skip the row, stop the step) and say so in the morning report.

## Settings

| Name | Value |
| --- | --- |
| `REPO` | `/Users/ymuromcev/Desktop/Claude Code/ai-job-searcher` (resolve with `realpath ~/.claude/skills/job-pipeline/../..` if that path is missing) |
| `P` (profile) | `jared` |
| Target | 100 submitted applications |
| Stop starting new work | **06:30 local time** (`--stop-at 06:30`), and never more than 10 h after the start |
| Subagent batch | 10–20 parallel subagents, then wait for the whole batch |
| Browser concurrency | `--concurrency 4` (the engine also keeps one open form per ATS tenant) |

Run every command from `REPO`: `cd "$REPO" && …` (the path has a space — keep the quotes). `profiles/$P/…` below is relative to `REPO`.

## Never — hard rules

- **The bot never enters a password, never creates an account, never solves a captcha, never uses LinkedIn Easy Apply.** Those forms stop as `manual` with a reason inside the engine — leave them for the human. You never click in a browser yourself; only `apply --phase submit` fills and submits forms.
- **Only Strong and Medium are applied to.** Weak rows go to Notion as `To Apply` for the human to triage; the apply queue skips them by itself. Never edit `fit_score` to get a row into the queue.
- Never re-submit a row with `apply_state=failed` or an `apply_note` starting `submitting:` — a human checks those.
- Never edit `applications.tsv`, `prepare_context.json` or `.apply-state/apply_context.json` by hand; never create Notion job pages via MCP (only `prepare --phase commit` does).
- Never read, print or source `.env`. A missing token is reported by name, not fixed.
- Git: fast-forward only. Never force, stash, reset, rebase or merge.
- Answers come only from the candidate's files and pass the independent truth check; a question without an honest answer leaves the job for the human.

## Where everything lands

| Step | Output |
| --- | --- |
| `night start` | lock `~/Library/Application Support/ai-job-searcher/state/$P/night.lock` |
| `scan` | `data/jobs.tsv`; new `Inbox` rows in `profiles/$P/applications.tsv`; `profiles/$P/.health/scan_runs.jsonl` |
| `prepare --phase pre` | `profiles/$P/prepare_context.json`; filtered-out rows `Archived` in the TSV |
| `night prepare-fanout` | `profiles/$P/.prepare-state/rows/` → `memory.md`, `payloads/<row>.json`, `jd/<row>.md` (one rolling folder; rows that left the batch are pruned) |
| row workers | `…/rows/results/<row>.json`, `…/rows/tailor/<row>/iter-<n>.json` |
| `night prepare-collect` | `profiles/$P/prepare_results_<ts>.json` |
| `prepare --phase commit` | TSV rows → `To Apply` + Notion pages; `cover_letters/`, `resumes/tailored/`; `.tailor-state/` escalations |
| `apply --phase pre` | `profiles/$P/.apply-state/apply_context.json`, `apply_pre-<ts>.json`; TSV `apply_state` queued / manual |
| `night apply-fanout` | `profiles/$P/.apply-state/rounds/<stamp>/` → `jobs/`, `drafts/`, `reviews/`, `answers/`, `bank/` |
| bank push | Notion Application Q&A DB + `profiles/$P/application_answers/*.md` |
| `apply --phase submit` | TSV `Applied` / `applied_by=bot` + Notion status; `.apply-state/shots/<row>.png`; `.apply-state/apply_results-<ts>.json` |
| `night finish` | one line in `profiles/$P/.health/apply_runs.jsonl` (shown in the weekly report and the board's «Неделя» tab) |

## Step 0 — git sync

```
cd "$REPO" && git fetch origin --quiet && git pull --ff-only 2>&1 | tail -3
```

- Fails (dirty tree, local commits ahead, conflict) → **continue** on the current code; report `⚠️ git sync skipped: <reason>`.
- Note the short SHA (`git rev-parse --short HEAD`) for the report.

## Step 1 — start the night

```
cd "$REPO" && node engine/cli.js night --profile jared --phase start --target 100 --stop-at 06:30
```

- Exit 0 → keep the JSON line: `started_at`, `deadline` (ISO — passed to submit later), `apply_ready`.
- **Exit 3 → another night is running. Stop here.** Do not run `finish` (it would close the other night). Report one line: `night skipped: another run in progress`.
- Any other non-zero exit → stop; report the stderr. (No lock was taken, so no `finish`.)

From here on, every path out of the night goes through Step 5 (`finish`).

## Step 2 — scan

```
cd "$REPO" && node engine/cli.js scan --profile jared
```

Per-source errors are isolated inside scan (one dead adapter does not fail the run). Before scanning, scan pulls Notion → TSV (auto-sync).

- Exit ≠ 0 → **continue** with what is already in Inbox and the apply backlog; remember `scan_failed` for the report, and run the first `prepare --phase pre` of the night **without** `--no-sync` (scan's sync did not happen).
- Note `fresh jobs: N` from stdout for the report.

## Step 3 — the loop

Repeat until a stop:

```
cd "$REPO" && node engine/cli.js night --profile jared --phase check
```

One JSON line. Act on `step`:

- `"prepare"` → **Round P** with `--batch <prepare_batch>`.
- `"apply"` → **Round A**.
- `"stop"` (exit 2) → Step 5 with `--stop-reason <reason>` (`deadline`, `target_reached`, `queue_empty`).

Also stop (→ Step 5) when:

- a usage tool is available (Claude desktop session `get_usage`) and it shows ≥ 90 % of the current usage limit — check it between subagent batches; `--stop-reason usage_budget`;
- the same `step` failed twice in a row (see the failure notes) — `--stop-reason prepare_failed` / `apply_failed`.

`night check` decides from the files on disk (TSV, `.apply-state/*`, tonight's `prepare_context.json`), so it is safe to call as often as needed. It sends the night to apply as soon as 10 fresh rows wait, so submissions start early; it never applies the same row twice in a night and never loops on rows an apply pre already skipped.

### Round P — prepare one batch (SKILL `prepare`, parallel row dispatch)

Follow [`SKILL.md`](SKILL.md) → `prepare` → *Run parameters* (night column) and *Parallel row dispatch*:

1. Pre — one fresh batch, sized by check:
   ```
   cd "$REPO" && node engine/cli.js prepare --profile jared --phase pre --mode fresh --batch <prepare_batch> --no-sync
   ```
   (Drop `--no-sync` only for the first pre of a night whose scan failed.) Exit ≠ 0 → retry once; second failure → no more prepare rounds tonight: from now on, when check says `prepare`, do a Round A instead if `apply_fresh` > 0, otherwise go to Step 5 with `prepare_failed`. Read only the stats: `node -e 'const c=require("./profiles/jared/prepare_context.json");console.log(JSON.stringify({inBatch:c.batch.length,...c.stats}))'`. `inBatch` 0 → back to the loop (check will see the empty round and stop preparing).
2. Fan out:
   ```
   cd "$REPO" && node engine/cli.js night --profile jared --phase prepare-fanout
   ```
   First line: JSON header. Every other line: `<payload path>\t<company> — <title>`.
3. Row workers — for each payload line, one `general-purpose` subagent with this prompt:
   > Read `skills/job-pipeline/references/night_row_worker.md` in the ai-job-searcher repo (`$REPO`) and follow it exactly for the row in `<payload path>`. Reply with the one JSON line it asks for.

   Launch 10–20 in one message, wait for all, then the next batch. Keep only each worker's one-line reply. Between batches run `night --phase check`: if it says `stop` with `deadline` (or the usage limit is near), launch no more workers and go straight to collect + commit with what is finished.
4. Collect:
   ```
   cd "$REPO" && node engine/cli.js night --profile jared --phase prepare-collect
   ```
   Exit 2 (nothing committable) → back to the loop. Rows listed as `invalid` / `missing` stay in Inbox for a later round — do not fix result files by hand. Collect deletes an invalid result, so **once per round**, before committing, you may re-run `prepare-fanout` (it re-issues only those rows), run their workers and collect again. Never collect again after the commit — the same rows would be committed twice.
5. Commit:
   ```
   cd "$REPO" && node engine/cli.js prepare --profile jared --phase commit --results-file <results_file> --no-sync
   ```
   This creates the Notion pages, the cover-letter PDFs and the tailored resumes, and moves the rows to `To Apply` — where the apply queue picks up Strong and Medium. Exit ≠ 0, or stdout saying a Notion token is missing → no more prepare rounds tonight (rows stay in Inbox); continue with apply rounds only and report it.

Back to the loop.

### Round A — apply (SKILL `apply`, file flow)

1. Read the forms:
   ```
   cd "$REPO" && node engine/cli.js apply --profile jared --phase pre --concurrency 4
   ```
   Exit ≠ 0 (e.g. `Playwright Chromium not found`) → Step 5 `apply_failed` (prepared rows stay `To Apply` for the next night).
2. Fan out the open questions:
   ```
   cd "$REPO" && node engine/cli.js night --profile jared --phase apply-fanout
   ```
   Keep `answers_dir` and `bank_dir` from the JSON header. No job lines (every form was fully answered by the engine) → go straight to Submit below.
3. Answers — [`SKILL.md`](SKILL.md) → `apply` → Phase 2 → **file flow**: drafters (one per job file) → reviewers (a *different* fresh subagent per job, brief [`references/apply_truth_review.md`](references/apply_truth_review.md)) → one rewrite + one re-check for FAILs only. Batches of 10–20; keep one-line replies only. Same deadline / usage check between batches as in Round P; if it says stop, skip the remaining drafts and submit what passed.
4. Bank — non-blocking:
   ```
   cd "$REPO" && for f in "<bank_dir>"/*.json; do [ -e "$f" ] && node engine/cli.js answer --profile jared --phase push --results-file "$f"; done
   ```
5. Submit:
   ```
   cd "$REPO" && node engine/cli.js apply --profile jared --phase submit --answers-file "<answers_dir>" --concurrency 4 --deadline <deadline from Step 1>
   ```
   No form is opened after the deadline; those rows stay queued for tomorrow. Exit ≠ 0 → retry once (a retry never double-applies: before every click the engine re-reads the row and skips it when it already has `applied_date`, `apply_state=submitted`, or a `submitting:` mark from a run that died mid-click); second failure → Step 5 `apply_failed`. Keep the summary line (`N submitted, M manual, K failed, S skipped`) for the report.

Back to the loop.

## Step 4 — wall clock

- The deadline is whatever `night start` printed (06:30 local, or 10 h after the start if sooner). `night check` returns `stop / deadline` from then on; `apply --phase submit --deadline` stops opening forms.
- After the deadline the only allowed work is: let the current subagent batch finish, `prepare-collect` + `prepare --phase commit` for rows already judged, then Step 5. Do not start a new prepare round, apply pre, or submit.
- The machine must be free in the morning: no command started after the deadline may be one that runs for long (scan, apply pre, submit).

## Step 5 — finish (always, once)

```
cd "$REPO" && node engine/cli.js night --profile jared --phase finish --stop-reason <reason>
```

`<reason>`: `deadline`, `target_reached`, `queue_empty`, `usage_budget`, `prepare_failed`, `apply_failed`. This appends the night's line to `profiles/jared/.health/apply_runs.jsonl` (counts recomputed from the TSV and `.apply-state` — do not pass numbers) and releases the lock. If the session dies before this step, the next night's `start` logs this night as `abandoned`.

## Step 6 — morning report

One short message in Russian:

- **Git:** ok `<sha>` or `⚠️ skipped: <reason>`.
- **Итог ночи:** the `night finished (...)` line from Step 5: подано / руками / ошибки / перенесено на завтра; почему остановилась.
- **Нашли и подготовили:** new jobs from scan (and failed adapters, one line each); prepared Strong / Medium / Weak; how many Strong got a tailored resume and how many escalated (with reasons). A Strong row with no tailored resume and no escalation is a bug — name it.
- **Доделать руками:** top 3 reasons from tonight's `apply_results-*.json` `manual` / `failed` rows (e.g. `captcha: 4, unsupported_ats:…: 3`). The full list is on the board, tab «Доделать руками»; its «Открыть заполненной» button opens each form already filled for the owner to submit.
- **Предупреждения:** `scan_failed`, prepare/commit/apply failures with the stderr line, invalid row results from collect, a missing token (by env-var name), usage stop.

If nothing was found and nothing was ready: `📭 новых вакансий нет, подавать нечего`.

## Failure notes

| What | What to do |
| --- | --- |
| `night start` exit 3 | Another night holds the lock → end the session, no finish. |
| git pull fails | Continue on current code, report. |
| scan exit ≠ 0 | Continue with existing Inbox + backlog; first prepare pre without `--no-sync`. |
| prepare pre fails twice | No more prepare rounds tonight; apply rounds continue while `apply_fresh` > 0, then finish with `prepare_failed`. |
| a row worker crashes / returns garbage | Ignore; collect lists it as missing / invalid; it stays in Inbox. |
| collect exit 2 | Nothing to commit this round; back to the loop. |
| commit fails / missing Notion token | No more prepare rounds tonight; apply rounds may continue; report the env-var name (`JARED_NOTION_TOKEN`). |
| apply pre fails | Finish with `apply_failed`. |
| submit fails twice | Finish with `apply_failed`. |
| usage ≥ 90 % | Finish with `usage_budget` after the current batch. |
| session about to end for any other reason | Run Step 5 with the closest reason before ending. |
