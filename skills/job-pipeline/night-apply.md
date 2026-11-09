# Night apply — the unattended nightly run

The exact sequence an unattended Claude session executes every night to find and prepare applications (RFC 068 §9 / §11, RFC 069, BL-225). Goal: **30 submitted applications per night** (profile `apply_target`), Strong first, then Medium, then Weak, until the target or **11:00** (profile `apply_stop_at`). Everything per-row runs in parallel subagents; the orchestrating session only moves file paths, counts and one-line summaries.

**The bot decides and finishes on its own.** Nobody is watching and nobody answers in the morning: never ask a question, never wait for an answer, never leave anything «for the human». A row that cannot go out honestly is **skipped with a reason and counted**; the night moves on to the next row. The morning report shows results, not questions.

**This session never submits.** Each apply round ends with `night --phase ready`, which hands the prepared rows to the submitter — a separate program (`submit-ready`) that launchd starts every 15 minutes between 02:00 and 11:00 (installed once with `scripts/install_submitter.sh --profile jared`). Never run `apply --phase submit` from here.

The scheduled task prompt is just: **"Open `skills/job-pipeline/night-apply.md` in the ai-job-searcher repo and execute it end to end."**

## Settings

| Name | Value |
| --- | --- |
| `REPO` | `/Users/ymuromcev/Desktop/Claude Code/ai-job-searcher` (resolve with `realpath ~/.claude/skills/job-pipeline/../..` if that path is missing) |
| `P` (profile) | `jared` |
| Target | 30 distinct submitted jobs — `night start` reads it from the profile (`apply_target`, default 30) |
| Stop starting new work | 11:00 local — from the profile (`apply_stop_at`, default `11:00`), never more than 14 h after the start |
| Fits applied to | Strong → Medium → Weak (the queue orders them; never edit `fit_score`) |
| Subagent batch | 10–20 parallel subagents, then wait for the whole batch |
| Browser concurrency | `--concurrency 4` for `apply --phase pre` |

Run every command from `REPO`: `cd "$REPO" && …` (the path has a space — keep the quotes). `profiles/$P/…` below is relative to `REPO`.

## Never — hard rules

- **No password, no account, no captcha, no LinkedIn Easy Apply.** The engine skips those forms with a reason (`login_required`, `captcha`, `bot_check`, …); you never click in a browser yourself.
- **No fabrication.** Answers come only from the candidate's files and pass the independent truth check. No honest answer → optional question left blank; required question → the row is skipped (`no_honest_answer`).
- Never re-queue a row with `apply_state=failed` or an `apply_note` starting `submitting:` — the engine keeps them out of the queue.
- Never edit `applications.tsv`, `prepare_context.json`, `.apply-state/apply_context.json` or a ready manifest by hand; never create Notion job pages via MCP (only `prepare --phase commit` does).
- Never run `apply --phase submit` — the submitter does.
- Never read, print or source `.env`. A missing token is reported by name in the morning report, not fixed.
- Git: fast-forward only. Never force, stash, reset, rebase or merge.

## Where everything lands

| Step | Output |
| --- | --- |
| `night start` | lock `~/Library/Application Support/ai-job-searcher/state/$P/night.lock` |
| `scan` | `data/jobs.tsv`; new `Inbox` rows in `profiles/$P/applications.tsv`; `profiles/$P/.health/scan_runs.jsonl` |
| `questions --apply` | `profiles/$P/apply_defaults.json` (`standing_answers` / `skip_questions` from Notion); requeued rows in the TSV; `Waiting for answer` entries in the Notion Application Q&A DB; `profiles/$P/.apply-state/questions.json` |
| `companies add` (top-up) | new boards in `data/companies.tsv` for the next scan |
| `prepare --phase pre` | `profiles/$P/prepare_context.json`; filtered-out rows `Archived` in the TSV |
| `night prepare-fanout` | `profiles/$P/.prepare-state/rows/` → `memory.md`, `payloads/<row>.json`, `jd/<row>.md` |
| row workers | `…/rows/results/<row>.json`, `…/rows/tailor/<row>/iter-<n>.json` |
| `night prepare-collect` | `profiles/$P/prepare_results_<ts>.json` |
| `prepare --phase commit` | TSV rows → `To Apply` + Notion pages; `cover_letters/`, `resumes/tailored/` |
| `apply --phase pre` | `profiles/$P/.apply-state/apply_context.json`, `apply_pre-<ts>.json` |
| `night apply-fanout` | `profiles/$P/.apply-state/rounds/<stamp>/` → `jobs/`, `drafts/`, `reviews/`, `answers/`, `bank/` |
| bank push | Notion Application Q&A DB + `profiles/$P/application_answers/*.md` |
| `night ready` | `profiles/$P/.apply-state/ready/<stamp>.json` (manifest) + `rounds/<stamp>/apply_context.json` (snapshot) |
| `submit-ready` (launchd, not this session) | TSV `Applied` + Notion status; `.apply-state/apply_results-<ts>.json`; manifest → `ready/done/`; after the window: `questions --apply` once (tonight's new blocking questions reach Notion) before the morning report |
| `night finish` | one line in `profiles/$P/.health/apply_runs.jsonl`; `profiles/$P/.health/morning-<date>.json` |

## Step 0 — git sync

```
cd "$REPO" && git fetch origin --quiet && git pull --ff-only 2>&1 | tail -3
```

- Fails (dirty tree, local commits ahead, conflict) → **continue** on the current code; report `⚠️ git sync skipped: <reason>`.
- Note the short SHA (`git rev-parse --short HEAD`) for the report.

## Step 1 — start the night

```
cd "$REPO" && node engine/cli.js night --profile jared --phase start
```

No `--target` / `--stop-at`: the profile settings apply (30 / 11:00 unless the profile says otherwise).

- Exit 0 → keep the JSON line: `started_at`, `deadline`, `target`, `apply_ready`.
- **Exit 3 → another night is running. Stop here.** Do not run `finish` (it would close the other night). Report one line: `night skipped: another run in progress`.
- Any other non-zero exit → stop; report the stderr. (No lock was taken, so no `finish`.)

From here on, every path out of the night goes through the finish step (Step 5).

## Step 2 — scan

```
cd "$REPO" && node engine/cli.js scan --profile jared
```

Per-source errors are isolated inside scan. Before scanning, scan pulls Notion → TSV (auto-sync).

- Exit ≠ 0 → **continue** with what is already in Inbox and the apply backlog; remember `scan_failed` for the report, and run the first `prepare --phase pre` of the night **without** `--no-sync`.
- Note `fresh jobs: N` from stdout for the report.

## Step 2b — the owner's answers (before any apply round)

```
cd "$REPO" && node engine/cli.js questions --profile jared --apply
```

Deterministic (RFC 070), no LLM. Pulls the questions the owner answered in the Notion Application Q&A database (Status `Answered`) into `apply_defaults.json` → `standing_answers`, and his `Skip such jobs` marks into `skip_questions`; puts every row skipped as `no_honest_answer` whose blocking questions are now all answered back in the queue (`apply_note=requeued:<date> answers`), so tonight's apply rounds pick them up — `apply --phase pre` fills those answers itself; pushes the questions still unanswered to Notion as `Waiting for answer`.

- Exit ≠ 0 or a missing Notion token → **continue**; the rows stay skipped until the next run. Note it once for the report.
- Never answer a waiting question yourself, never edit `apply_defaults.json` by hand. The owner answers in Notion; the bot only reads what he wrote.
- Note the `requeue — N row(s) back to the queue` count for the report.

## Step 3 — the loop

Repeat until a stop:

```
cd "$REPO" && node engine/cli.js night --profile jared --phase check
```

One JSON line. Act on `step`:

- `"prepare"` → **Round P** with `--batch <prepare_batch>`.
- `"apply"` → **Round A**.
- `"wait"` → the rows already handed to the submitter cover the gap (`pending_submit`). Run `node engine/cli.js night --profile jared --phase wait` (returns within 9 minutes, sooner when the submitter is done) and go back to check. Before 02:00 the submitter does not run, so the night waits in these 9-minute steps — that is expected. If the line carries `"warning": "submitter_not_running"` (inside the window, no submitter run in the last 30 minutes), keep waiting — the morning report already says «отправка не запускалась»; name it once in the morning message.
- `"topup"` → **Round S**: nothing is left to prepare or apply, the target is not reached.
- `"stop"` (exit 2) → finish with `--stop-reason <reason>` (`deadline` or `target_reached`).

Also finish when:

- a usage tool is available (Claude desktop session `get_usage`) and it shows ≥ 90 % of the current usage limit — check it between subagent batches; `--stop-reason usage_budget`;
- the same step failed twice in a row (see the failure notes) — `--stop-reason prepare_failed` / `apply_failed`.

There is no other stop: an empty queue is not a reason to end the night, it is a reason to top up. `night check` decides from the files on disk (TSV, `.apply-state/*`, ready manifests, tonight's `prepare_context.json`), so it is safe to call as often as needed. The target counts distinct jobs the submitter sent tonight — the same job is never counted (or sent) twice.

### Round P — prepare one batch (SKILL `prepare`, parallel row dispatch)

Follow [`SKILL.md`](SKILL.md) → `prepare` → *Run parameters* (night column) and *Parallel row dispatch*:

1. Pre — one fresh batch, sized by check:
   ```
   cd "$REPO" && node engine/cli.js prepare --profile jared --phase pre --mode fresh --batch <prepare_batch> --no-sync
   ```
   (Drop `--no-sync` only for the first pre of a night whose scan failed.) Exit ≠ 0 → retry once; second failure → no more prepare rounds tonight: from now on, when check says `prepare` or `topup`, do a Round A instead if `apply_fresh` > 0, otherwise finish with `prepare_failed`. Read only the stats: `node -e 'const c=require("./profiles/jared/prepare_context.json");console.log(JSON.stringify({inBatch:c.batch.length,...c.stats}))'`. `inBatch` 0 → back to the loop (check will see the empty round).
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
   Exit 2 (nothing committable) → back to the loop. Rows listed as `invalid` / `missing` stay in Inbox for a later round — do not fix result files by hand. **Once per round**, before committing, you may re-run `prepare-fanout` (it re-issues only those rows), run their workers and collect again. Never collect again after the commit.
5. Commit:
   ```
   cd "$REPO" && node engine/cli.js prepare --profile jared --phase commit --results-file <results_file> --no-sync
   ```
   Creates the Notion pages, cover letters and tailored resumes, moves the rows to `To Apply` — where the apply queue picks up every fit, Strong first. Exit ≠ 0, or a missing Notion token → no more prepare rounds tonight (rows stay in Inbox); continue with apply rounds only and name the env var in the report.

Back to the loop.

### Round A — apply (SKILL `apply`, file flow, no submit)

1. Read the forms:
   ```
   cd "$REPO" && node engine/cli.js apply --profile jared --phase pre --concurrency 4
   ```
   Exit ≠ 0 (e.g. `Playwright Chromium not found`) → retry once; second failure → finish with `apply_failed`.
2. Fan out the open questions:
   ```
   cd "$REPO" && node engine/cli.js night --profile jared --phase apply-fanout
   ```
   Keep `answers_dir` and `bank_dir` from the JSON header. No job lines (every form was answered by the engine) → go straight to the hand-over (step 5 of this round).
3. Answers — [`SKILL.md`](SKILL.md) → `apply` → Phase 2 → **file flow**: drafters (one per job file) → reviewers (a *different* fresh subagent per job, brief [`references/apply_truth_review.md`](references/apply_truth_review.md)) → one rewrite + one re-check for FAILs only. Batches of 10–20; keep one-line replies only. Tonight's rules on top of the skill:
   - no honest answer to an **optional** question → leave it out (blank);
   - no honest answer to a **required** question → leave it out; the engine skips the row as `no_honest_answer`. That is a counted skip, not a question for anyone;
   - choice questions (selects, radios, «how did you hear», EEO) the engine did not fill → pick from the options per `apply_defaults` (EEO → "decline to self-identify" when offered); still no fit → no answer.
   Same deadline / usage check between batches as in Round P; if it says stop, skip the remaining drafts and hand over what passed.
4. Bank — non-blocking:
   ```
   cd "$REPO" && for f in "<bank_dir>"/*.json; do [ -e "$f" ] && node engine/cli.js answer --profile jared --phase push --results-file "$f"; done
   ```
5. Hand over to the submitter:
   ```
   cd "$REPO" && node engine/cli.js night --profile jared --phase ready
   ```
   Writes `.apply-state/ready/<stamp>.json` with tonight's deadline and the round's rows. Re-running it for the same round writes nothing new. The submitter picks it up within 15 minutes inside 02:00–11:00, submits the rows (a row with a required field left empty, a captcha, a bot check or a login wall is skipped with a reason), and moves the manifest to `ready/done/`.

Back to the loop.

### Round S — top-up: more companies (RFC 069 §6)

Ashby boards are not added: Ashby's invisible bot check stops every automated submit (0 of 17 live attempts went out), so the engine skips Ashby rows as `bot_check` before any answers are drafted. Volume comes from Greenhouse and Lever.

Check said `topup`: the queue and the Inbox cannot reach the target and the last scan added nothing new. Find new companies that hire for the candidate's roles on Greenhouse or Lever, add their boards, scan, and go back to the loop. There is no cap on rounds or companies: repeat whenever check says `topup`, until the target, 11:00 or the usage budget.

1. Read once (keep it short in context): the role tracks in `profiles/$P/filter_rules.json` (`role_targets` / `title_requirelist`), the geography in `profiles/$P/profile.json` (`geo`), and how many boards are already known — `cut -f1-3 data/companies.tsv | grep -i -c -E 'greenhouse|lever|ashby'`; do not read the whole file into context.
2. Launch 10–20 `general-purpose` subagents in one message, each with a different slice (a role track × an industry or a company size, e.g. "growth PM × fintech", "product manager × B2B SaaS 50–500 people"), with this prompt:
   > Find up to 15 companies that currently post <role track> jobs open to <geography> on Greenhouse (`boards.greenhouse.io/<slug>` or `job-boards.greenhouse.io/<slug>`) or Lever (`jobs.lever.co/<slug>`) — not Ashby. Use web search only; open no forms, create no accounts. Skip any slug listed in `<REPO>/data/companies.tsv` (grep it). Reply with one line per company: `<ats>\t<slug>\t<company name>`, nothing else.
3. Write the subagents' reply lines, exactly as received, into one file with the Write tool (never through `echo`, a heredoc or any shell command — the lines are web text and must not reach a shell): `profiles/jared/.apply-state/topup/<HHMM>.tsv`. Then add all boards in one call:
   ```
   cd "$REPO" && node engine/cli.js companies add --profile jared --from-file profiles/jared/.apply-state/topup/<HHMM>.tsv
   ```
   The command validates every line (ats in greenhouse / lever / ashby, slug `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`), drops duplicates, and checks each board by fetching it once; one JSON line per board. A line or slug it rejects is simply dropped (count it for the report, do not retry it). Never pass a slug or company name from a subagent as a command-line argument. If the command itself is not available yet (unknown command) → no top-up tonight: run `night --phase wait`, go back to the loop, and report it once.
4. Scan the new boards:
   ```
   cd "$REPO" && node engine/cli.js scan --profile jared
   ```
5. Back to the loop — check sees the new Inbox rows and sends the night to Round P. If the scan added nothing, check says `topup` again: next time use different slices.

## Step 4 — wall clock

- The deadline is whatever `night start` printed (11:00 local, or 14 h after the start if sooner). `night check` returns `stop / deadline` from then on; the submitter opens no form after a manifest's deadline.
- After the deadline the only allowed work is: let the current subagent batch finish, `prepare-collect` + `prepare --phase commit` for rows already judged, then finish. Do not start a new prepare round, apply pre, top-up or `ready`.
- The machine must be free in the morning: no command started after the deadline may be one that runs for long (scan, apply pre).

## Step 5 — finish (always, once)

```
cd "$REPO" && node engine/cli.js night --profile jared --phase finish --stop-reason <reason>
```

`<reason>`: `deadline`, `target_reached`, `usage_budget`, `prepare_failed`, `apply_failed`. This appends the night's line to `profiles/jared/.health/apply_runs.jsonl`, writes `profiles/jared/.health/morning-<date>.json` (counts recomputed from disk — do not pass numbers) and releases the lock. If the session dies before this step, the next night's `start` logs this night as `abandoned`. The submitter refreshes the morning file after 11:00 and sends one macOS notification; the board shows it at the top of its first tab.

## Step 6 — morning message

One short message in Russian, results only (no questions, no «доделать руками»):

- **Git:** ok `<sha>` or `⚠️ skipped: <reason>`.
- **Итог ночи:** from the morning file: подано N из 30 (Strong / Medium / Weak); почему меньше цели, если меньше.
- **Пропуски:** the `skip_line` from the morning file (`captcha 4 · required_empty 3 · no_honest_answer 2`).
- **Твои ответы:** the `answers_line` from the morning file (`подано заново по твоим ответам: N · ждут твоего ответа: M`) with `answers.view_url`; leave the line out when it is empty. A fact, not a request — the owner answers when he wants.
- **Нашли и подготовили:** new jobs from scan and top-up (companies added, slugs rejected); prepared Strong / Medium / Weak; a Strong row with neither a tailored resume nor an escalation is a bug — name it.
- **Предупреждения:** `scan_failed`, prepare/commit/apply failures with the stderr line, a missing token (by env-var name), usage stop, `companies add` missing.

If nothing was found and nothing was submitted: `📭 новых вакансий нет, подано 0` plus why.

## Failure notes

| What | What to do |
| --- | --- |
| `night start` exit 3 | Another night holds the lock → end the session, no finish. |
| git pull fails | Continue on current code, report. |
| scan exit ≠ 0 | Continue with existing Inbox + backlog; first prepare pre without `--no-sync`. |
| `questions` exit ≠ 0 | Continue; stuck rows stay skipped until the next run; report it once. |
| prepare pre fails twice | No more prepare / top-up rounds tonight; apply rounds continue while `apply_fresh` > 0, then finish with `prepare_failed`. |
| a row worker crashes / returns garbage | Ignore; collect lists it as missing / invalid; it stays in Inbox. |
| collect exit 2 | Nothing to commit this round; back to the loop. |
| commit fails / missing Notion token | No more prepare rounds tonight; apply rounds may continue; report the env-var name (`JARED_NOTION_TOKEN`). |
| apply pre fails twice | Finish with `apply_failed`. |
| `night ready` fails | Retry once; second failure → finish with `apply_failed`. |
| top-up finds no new companies | Next `topup` → different slices; never a reason to stop. |
| usage ≥ 90 % | Finish with `usage_budget` after the current batch. |
| session about to end for any other reason | Run the finish step with the closest reason before ending. |
