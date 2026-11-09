# RFC 069 — Autonomous nightly submit (no owner in the loop)

Status: draft · BL-225 · builds on RFC 068

## Problem

RFC 068 shipped the night apply flow, but in practice it submits almost nothing: 12 applications in 7 nights (October 2026). Three causes, from the night logs and screenshots:

1. **Submit is blocked.** The night runs as a Claude scheduled session in auto mode. Its safety classifier treats `apply --phase submit` as a real-world transaction and denies it; the only submission in two nights happened when the owner approved a prompt by hand.
2. **Forms fail silently.** Ashby radio-group questions are left empty while the submit button is still clicked (9 Ashby rows "submitted, no confirmation", none really sent); Ashby's invisible bot check rejects the headless browser.
3. **The queue is thin.** Only Strong/Medium are queued; aggregator (Adzuna) rows have no company form URL; filters pass 2–15 rows a night.

On top of that the runbook routes every doubt to a human («leave for the human», «Доделать руками»), so the morning brings questions instead of results.

The agreed outcome (BL-225, «ночные отклики без участия владельца», 09.11.2026): every night the bot applies until it reaches the profile's target (30) or 11:00, in priority order Strong → Medium → Weak, decides everything itself, and the morning report shows results, not questions.

## Options for the submit block

- **A. Permission rule** allowing `node engine/cli.js apply *` in the user's settings. Keeps submit inside Claude, but only the owner can add it, every new submit path needs a new rule, and the classifier may still intervene on variants. Rejected: depends on the owner.
- **B. Separate submitter outside Claude.** Claude prepares (scan, fit, tailoring, answers, truth review) and writes a *ready manifest*; a deterministic program started by launchd fills and submits ready forms. No model in the submit loop, so no classifier. All hard rules already live in the engine (`apply.js`, adapters).
- **C. Submit from inside the fill step without a separate click command.** Same classifier exposure as today. Rejected.

## Chosen: B

### 1. Ready manifests (night → submitter contract)

After Round A step 3 (answers drafted and truth-reviewed), the night writes `profiles/<id>/.apply-state/ready/<stamp>.json`:

```json
{ "stamp": "...", "answers_dir": "...", "deadline": "ISO", "rows": ["<key>", ...], "created_at": "ISO" }
```

Written by a new `night --phase ready` (atomic rename), never by hand. The night no longer runs `apply --phase submit` itself.

### 2. Submitter

- New command `node engine/cli.js submit-ready --profile <id>`: takes the night lock in shared mode, picks manifests in order, runs the existing submit code for their rows (`--concurrency 4 --deadline`), moves each manifest to `ready/done/` with its result file. Idempotent: the existing per-row guards (`applied_date`, `apply_state=submitted`, `submitting:` mark) already prevent double submits.
- Window: does nothing outside 02:00–11:00 local (profile setting `apply_window`, default `02:00-11:00`), and never past a manifest's `deadline`.
- launchd agent `com.<user>.ai-job-searcher.submit-<profile>`, `StartInterval` 900 s; launchd fires a missed interval on wake, which covers a sleeping Mac. Installed by `scripts/install_submitter.sh --profile <id>` (writes the plist under `~/Library/LaunchAgents`, `launchctl bootstrap`), removed by `--uninstall`. Logs to `~/Library/Logs/ai-job-searcher/submit-<profile>.log`.
- Runs Playwright **headed** for Ashby (visible Chromium window, still Playwright's own Chromium — never the system Chrome), headless elsewhere.

### 3. Queue: all fits, priority order

- `queue.js`: `FIT_OK` becomes Strong, Medium, Weak; order Strong → Medium → Weak, then newest first. Geography and the existing hard blockers stay hard filters.
- Profile `apply_target` (default 30) and `apply_stop_at` (default `11:00`) replace the runbook constants (`--target 100`, `--stop-at 06:30`).

### 4. The bot decides

- Open question with no answer in the bank: drafter writes one from the candidate's files, the independent truth reviewer checks it (unchanged — no fabrication). If no honest answer exists: optional question → left blank; required question → the row is skipped with reason `no_honest_answer` (counted, not escalated).
- Choice questions (selects, radios, «how did you hear», EEO): profile policy table `apply_defaults.choice_policy`; EEO → "decline to self-identify" when offered.
- Required field still empty after fill → do not click submit; row skipped `required_empty` (fixes the Ashby silent failure).
- Captcha, account/password, broken form → skipped with reason; the bot moves on to the next row. Nothing goes to a «do by hand» queue.
- Runbook rewrite: «Never ask a question» stays; every «leave for the human» path becomes «skip, count the reason».

### 5. Aggregator rows

`resolve_url` for Adzuna rows: search the company's Greenhouse / Lever / Ashby board (existing adapters' board endpoints) for the same title; match → canonical form URL; no match → skipped `no_company_form`.

### 6. Volume top-up

When `night check` sees the queue (all fits) below what is needed for the target and new scans add nothing, Round S: subagents search for companies hiring matching roles on Greenhouse / Lever / Ashby and append them through a new `companies add --profile <id> --ats <ats> --slug <slug>` (validated by fetching the board once); the new boards are scanned and prepared in the same night. No cap on companies: Round S repeats until the night has 30 unique submitted applications (distinct jobs, never the same job twice) or reaches 11:00. The only other stop is the usage budget (≥ 90 % of the Claude usage limit), so the owner keeps usage for the day.

### 7. Morning report

`night finish` writes the summary; the submitter's last run after 11:00 (or the first run that finds the window closed) sends one macOS notification and writes `.health/morning-<date>.json`, shown on the board's first tab: submitted N (Strong/Medium/Weak), list with confirmation-email status, one line of skip reasons, and why it stopped below target. No questions.

### 8. October rows

One-off `requeue --profile <id> --since 2026-10-20 [--apply]`: rows `apply_state=submitted` with no confirmation email in the apply mailbox and the job still open → back to `queued`.

### 9. README rule

README "Autonomy" section: the bot decides and finishes on its own; no proposal may depend on the owner's clicks or answers.

## Identity & PII

N/A for new data: no new personal fields. Manifests hold row keys and paths only; logs carry row keys, never names or answers. Everything stays under the gitignored `profiles/<id>/`.

## Risks

- **Submit runs outside Claude's safety check.** Deliberate (owner-approved image). Mitigation: the submitter is deterministic engine code with the hard rules in code and tests (no passwords, no account creation, no captchas, geography, no double submit); it only submits rows that passed the truth review.
- **Weak fits add noise to the funnel.** Owner decision; priority order keeps Strong first.
- **Ashby may still reject the headed browser.** Then rows skip with `bot_check`; visible in the report.
- **Company top-up may add irrelevant companies.** No cap by owner decision (09.11.2026); fit scoring still orders the jobs and geography still filters them.

## Verification

- Unit tests: queue order and Weak inclusion; manifest write/consume; window and deadline; `required_empty` guard; choice policy; requeue selection; `companies add` validation.
- Dry run of the submitter against the existing fixture forms.
- First real night after merge: report counts checked against confirmation emails.
