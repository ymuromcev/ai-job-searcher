---
title: "Incident log"
status: live
last_updated: 2026-05-05
---

# Incidents

> Names anonymized to personas (PM-Pete, Healthcare-Hannah). See
> `docs/architecture/adrs/005-profile-id-convention.md` and the internal
> personas-real map for the mapping.

Blameless post-mortem log for production incidents in this engine.
Format: cause → what changed → prevention. Severity tagged for skim.

---

## 2026-05-04 — `scan` never applied filter rules (P0 pipeline bug)

**Severity**: P0 (silent — every scan since engine launch ingested
unfiltered jobs into per-profile pipeline).
**Surface**: `engine/core/scan.js` orchestrator + `engine/commands/scan.js`.
**Detected by**: Ad-hoc head-to-head test attempt against prototype.
A single `scan --apply` produced 4 fresh rows for PM-Pete, none of
which should have passed: Data Scientist, DevOps Software Engineer,
Sr. Director TPM. All have non-PM titles that the configured
`title_requirelist` and `title_blocklist` would reject.

### Cause

`engine/core/filter.js` (`filterJobs` / `matchBlocklists`) was ported
from prototype with full unit tests. But the scan orchestrator never
calls it. Pipeline was:

  adapters.discover() → dedupeJobs(within-batch) →
  dedupeAgainst(against-pool) → fresh → appendNewApplications

Filter step is missing entirely. `matchBlocklists` is only invoked
post-hoc by `validate` retro-sweep, which runs on demand and only
covers blocklists (not requirelist or company_cap).

Cumulative effect: `applications.tsv` accumulated ~thousands of
non-PM, non-PO, non-Lead-Product roles since Stage 5 launch. They
sit at `status=To Apply` until a manual `validate --apply` or until
the user archives them in Notion. Recent counts:
- PM-Pete: 24 active "To Apply" rows from accidental Capital One workday batch.
- Healthcare-Hannah: unknown — needs survey.

Field-name mismatch compounds the bug: `filterJobs` expects
`{company, role, location}` but adapters emit
`{companyName, title, locations[]}`. Even if scan called
`filterJobs`, every job would currently appear blank-titled and
slip through `title_requirelist` (because empty title satisfies no
requirement check after the `if (roleLower)` guard).

### What changed (planned)

Add a filter stage in `engine/commands/scan.js` between the
`deps.scan(...)` result and `deps.appendNewApplications(...)`:

1. Read `applications.tsv`, count active per-company by
   `rules.company_cap.active_statuses`.
2. Map adapter shape → filter shape: `{company: companyName,
   role: title, location: locations?.[0] ?? ""}`.
3. Call `filterJobs(fresh, profile.filter_rules, currentCounts)`.
4. Passed jobs → existing `appendNew` path with `status="To Apply"`.
5. Rejected jobs → `appendNew` path but with `status="Archived"`.
   Reason serialized to `profiles/<id>/filter_rejections.log` (jsonl)
   for audit trail. TSV schema unchanged (no v4 migration).

Pool in `data/jobs.tsv` stays unfiltered — it is shared across
profiles and a job rejected by one profile's filter may be valid for
another profile.

### Prevention

- Regression test: `scan` with a fixture profile whose `filter_rules`
  contains a `title_requirelist=["product"]` entry must reject any
  fresh job whose title doesn't match. Asserts `freshApps.length` for
  passed jobs only and confirms `filter_rejections.log` line count.
- Field-shape contract test: adapter output → filter input mapper
  test, asserting `companyName/title/locations[0]` correctly map to
  `{company, role, location}` and back to TSV append shape.
- Backlog item: align `filter.js` field names with adapter output
  shape (one-time refactor) so future call sites cannot trip the
  same mismatch silently.

### Side note: 4 production rows already added during detection

Detection itself was a write-incident: ad-hoc dump script passed
`flags["dry-run"]: true` instead of `flags.dryRun: true`. Scan ran
in apply mode. 4 Capital One Workday rows appended to PM-Pete's TSV.
Reverted by stripping last 4 lines (backup at
`profiles/<id>/applications.tsv.pre-rollback-incident`). Notion
untouched; rows had no `notion_page_id`.

Lesson: dry-run flag shape is camelCase (`flags.dryRun`) — not
kebab. Any future ad-hoc scripts touching scan must use the CLI
binary (`engine/cli.js scan ... --dry-run`) rather than calling
`makeScanCommand` directly with hand-built `flags`.

---

## 2026-04-30 — Classifier mis-fired on ATS confirmation boilerplate (5 false REJECTIONs)

**Severity**: HIGH (5 Notion pages got wrong status; user-visible).
**Surface**: `engine/core/classifier.js` REJECTION patterns.
**Detected by**: User noticed @mention notifications about "rejections"
that were actually application acknowledgments (Headway, Hopper, Figma×2,
WHOOP).

### Cause

The bare regex `/not selected/i` was added to the REJECTION pattern set
to catch genuine rejection wording like "we have not selected your
application". It also matched the conditional boilerplate that
Greenhouse / Ashby / Lever / Figma application-receipt emails all
include verbatim:

> "If you are not selected for this position, keep an eye on our jobs page."

This is a CONDITIONAL clause inside a confirmation email, not a real
rejection. The classifier ran first-match-wins with REJECTION tested
before ACKNOWLEDGMENT, so 5 fresh confirmation emails — for jobs the
user had JUST applied to — were classified as REJECTION and pushed
the corresponding Notion pages from "To Apply" → "Rejected".

### Trigger

The `--auto` cron tick on fly.io ran after the new candidate pool was
seeded with applications to companies whose ATS uses this exact
boilerplate. None of the prior MCP-driven Mac runs had hit this many
greenhouse/ashby/figma/lever confirmations in a single batch, so the
regression was latent.

### What changed

1. **`engine/core/classifier.js`** — removed bare `/not selected/i`.
   Kept the more specific `/your application was not selected/i` for
   genuine wording.
2. **`engine/core/classifier.js`** — added two ACKNOWLEDGMENT patterns
   to ensure the 5 fixture emails are caught positively:
   - `/thanks for applying/i` (Hopper subject line)
   - `/thank you for your (application|interest)/i` (Figma + WHOOP
     subjects, Hopper body)
3. **`engine/core/classifier.test.js`** — 5 regression fixtures (real
   production emails from this incident) + 1 no-regression test that
   keeps the specific REJECTION pattern firing.
4. **Manual rollback** — 5 Notion pages reverted to "To Apply" with an
   explanatory comment ("auto-classifier mis-fired on a confirmation
   email…") before the fix landed.
5. **`scripts/dump_emails.js`** — read-only diagnostic kept for future
   incidents: pulls raw email text from Gmail by message-id and shows
   ALL pattern matches across REJECTION / INTERVIEW / INFO / ACK so
   regex collisions are visible at a glance.
6. **`scripts/{replay_emails.js, parse_check_log.js, diff_replay.js}`**
   — replay harness so we can run the new code over a saved
   `raw_emails.json` snapshot and diff against the parsed Mac MCP log.
   Verified parity on the 2026-04-30 09:36 baseline: 53/53 matched,
   15/15 actions reproduce 1:1; only delta is 6 emails moved
   OTHER → ACK (the classifier-fix bonus, no behavior change).

### Prevention

- **Regex review**: any new pattern added to the classifier must come
  with a "false positive" test — at minimum one ATS confirmation
  fixture proving the pattern doesn't fire on it. The 4 regex sets
  are tightly bounded; adding broad words is high risk.
- **Replay harness**: every classifier change runs through
  `scripts/replay_emails.js` against the most recent saved
  `raw_emails.json` before merge. If matched/actions counts differ
  unexpectedly, investigate before deploy.
- **Backups for fast rollback**: `applications.tsv.pre-check-*` and
  `processed_messages.pre-recheck-*` snapshots are kept per run, so
  rollback is one `cp` away rather than reconstructing state.

### Related

- Fix commit: `27076a5 fix(classifier): drop bare /not selected/ …`
- Replay harness commit: `621979d test(check): replay harness …`
- Phase 2 deploy commit: `6ef2850 feat(check): autonomous --auto …`

---

## 2026-05-02 — Healthcare-Hannah auto-check first run produced 11 false-positive Notion mutations

**Severity**: HIGH (11 Notion pages got wrong status; user-visible).
**Surface**: classifier greedy patterns + matcher score-tie ambiguity +
  no sender-allowlist for Indeed digests / banks.
**Detected by**: User noticed @mention notifications on pipeline rows
  for emails that were not pipeline updates (Indeed "+ N more new jobs"
  digests, a Wells Fargo claim reply, JD body text mentioning
  "interview"/"availability"/"questionnaire"/"assessment", and a
  fuzzy-match collision between "Sacramento Natural Dentistry" and
  "Sacramento Spa Dentistry").

### Cause

Three independent root causes compounded:

1. **No sender-allowlist for non-pipeline noise.** Indeed match-alert
   digests (`donotreply@match.indeed.com`) embed raw JD body text. They
   reached `classify()` because the only existing short-circuit was for
   `jobalerts-noreply@linkedin.com`. Banks (Wells Fargo "We received
   your claim inquiry") had the same problem — their transactional
   language overlaps with ACKNOWLEDGMENT patterns.
2. **Classifier patterns too greedy.** `\binterview\b`,
   `\bavailability\b`, `\bquestionnaire\b`, `\bassessment\b` matched
   anywhere in the haystack. JD prose like "competitive interview
   process", "weekend availability required", "skills assessment
   included", "intake questionnaire" all tripped them as if they were
   invitations / requests directed at the candidate.
3. **Matcher had no tie-break.** When two pipeline companies
   tokenized to the same set ("Sacramento Natural Dentistry" and
   "Sacramento Spa Dentistry" both → `["sacramento","dentistry"]`
   under the >3-char filter), `findCompany` returned whichever was
   iterated first — a 50/50 false attribution for any email mentioning
   a Sacramento dental clinic.

### Trigger

Healthcare-Hannah's cron tick at 8:01am PT on first activation. Her pipeline
contains 73 healthcare/dental clinics (vs PM-Pete's PM/fintech roles);
many have generic 2-token names that collide on tokenization, and
her Gmail inbox contains regular Indeed digests + ongoing Wells
Fargo correspondence — none of which existed in PM-Pete's training
distribution that the classifier was tuned on.

### What changed

1. **`engine/core/email_filters.js`** — added `JOB_ALERT_SENDERS`
   (Indeed/ZipRecruiter/Glassdoor/Monster + subject patterns like
   `+ N more new jobs`) and `NON_PIPELINE_SENDERS` (banks, utilities,
   insurance) with `isJobAlert()` / `isNonPipelineSender()` helpers.
2. **`engine/commands/check.js`** — `processEmailsLoop` now skips
   job-alert digests and non-pipeline senders BEFORE `classify()`,
   logged with `type: JOB_ALERT` / `NON_PIPELINE` and
   `action: "skipped: ..."` for visibility.
3. **`engine/core/classifier.js`** — replaced 4 bare patterns with
   context-anchored versions:
   - `\binterview\b` → `schedule (an? )?(interview|...)`,
     `interview with us`, `your interview (is|with|on)`,
     `interview (request|invitation|invite)`, etc.
   - `\bavailability\b` → `share your availability`,
     `your availability (for|to) (an? )?(interview|call|chat|...)`.
   - `\bassessment\b` / `\bquestionnaire\b` → require explicit
     candidate-action verbs (`(complete|take|finish) (the|your|an?)
     (assessment|questionnaire|...)`) or possession + state-of-being
     (`(your|the) ... (is|link|attached|below|here)`).
   - Kept brand-specific bare matches: `\bcalendly\b`,
     `\bcoding challenge\b`, `\btake.?home\b` — these only ever
     appear in candidate-facing contexts.
4. **`engine/core/email_matcher.js`** — added `pickBestWithTieBreak`:
   when two entries score equally, require the winner to have at least
   one DISCRIMINATING token (unique to its synonym set vs the other
   tied entries) actually present in the haystack. Uses a more lenient
   `tieBreakTokens` (no length>3 filter) so short distinctive words
   like "spa" / "ENT" / "MSO" can discriminate. If no entry passes,
   return `null` — better to skip than mis-attribute.
5. **Tests** — 17 new fixtures across `email_filters.test.js`,
   `classifier.test.js`, `email_matcher.test.js`, `check.test.js`
   covering all three causes (Indeed alerts, Wells Fargo, JD-body
   keywords, Sacramento dentistry collision) + positive controls
   ensuring real interview/info-request emails still match.
6. **Phase 1 manual rollback** (completed before fix landed): 8
   Notion statuses reverted, explanatory comments added,
   `processed_messages.json` deleted, TSV restored from
   `applications.tsv.pre-check-...` backup. Healthcare-Hannah cron disabled in
   `cron/check.cron` as a safety pause until fix deployed.

### Prevention

- **Sender-allowlist as default defense.** Any new noise sender
  category (alerts, banks, utilities, insurance) gets added to
  `JOB_ALERT_SENDERS` / `NON_PIPELINE_SENDERS` rather than trying to
  patch the classifier downstream.
- **Pattern context-anchoring rule.** Any classifier pattern of the
  form `\bword\b` requires either (a) an action verb (schedule, take,
  complete) or (b) possessive context (your X, our X is) to qualify.
  Bare keyword matches are forbidden unless the word is brand-
  specific (Calendly, Greenhouse) or a domain-of-art compound
  (`coding challenge`, `take-home`).
- **Tie-break must always default to skip.** When the matcher cannot
  uniquely attribute an email to a single pipeline entry, returning
  `null` and surfacing as "unmatched" is always safer than a 50/50
  guess that mutates Notion.
- **Per-profile training distribution mismatch.** PM-Pete's
  PM/fintech distribution and Healthcare-Hannah's healthcare/dental distribution
  triggered different latent bugs. Future profiles should run
  `--auto` in dry-run for at least one full cron window before
  enabling `--apply`, and the first --apply should be reviewed
  manually.

### Related

- Phase 1 rollback commit: `15bd80e chore(cron): disable Healthcare-Hannah
  auto-check pending classifier fix` (safety pause)
- This fix commit: see `git log` for `fix(check): sender-allowlist +
  pattern tightening + matcher tie-break (Healthcare-Hannah incident)`

---

## 2026-05-02 — Cron silently failed at TSV save (EACCES) → duplicate Notion comments

**Severity**: MEDIUM (Notion mutated correctly but state wasn't persisted).
**Surface**: Dockerfile + fly persistent volume ownership.
**Detected by**: User noticed @mention notifications in cron_ops Notion
  page about `EACCES: permission denied` on PM-Pete's TSV.

### Cause

Dockerfile sets `USER app` (uid 1000) but `/data` is a fly persistent
volume. `chown -R app:app /data` at build time only affects the image
layer — at runtime the fly volume mount overlays its own contents with
their own ownership, which was `root:root` (created earlier by manual
ssh sessions).

`check --auto --apply` flow:
1. Notion ops succeed (HTTP, no fs needed) — status updates, comments
2. `saveApplications` writes via tmp-file + atomic rename → EACCES
3. `saveProcessed` never runs → cursor doesn't advance
4. Next cron tick re-processes the same emails → idempotent on
   status (already Rejected) but **adds duplicate comments**

Hit PM-Pete 2026-05-01 and 2026-05-02. Healthcare-Hannah would have hit it
2026-05-03 (her cron was just re-enabled).

### What changed

1. `cron/entrypoint.sh` — runs as root, `chown -R app:app /data`,
   then `exec su-exec app:app "$@"` to drop to the unprivileged user.
2. `Dockerfile` — added `su-exec` to apk, removed `USER app`,
   added `ENTRYPOINT ["/app/cron/entrypoint.sh"]`.
3. Manual one-shot `chown -R app:app /data` on the running machine
   before the next 8am tick.

### Prevention

- Any container with a persistent-volume mount + non-root USER needs
  an entrypoint that normalizes ownership at start. Don't rely on
  build-time chown for paths that get masked by mounts.
- Failure-notification system worked exactly as designed (RFC 005 §4.6
  caught both ticks and pinged via @mention) — that's how this surfaced.

### Cleanup TODO

Check PM-Pete's Notion for duplicate comments on rows updated 2026-05-01
and 2026-05-02; collapse if user wants.

---

## 2026-05-04 — Pool/TSV reconciliation gap (P1, one-shot fix)

**Severity**: P1 (silent data loss; surfaced after the P0 scan-filter fix
above when expected To Apply count looked too low).
**Surface**: `engine/core/scan.js` `appendNewApplications` step + shared
master pool `data/jobs.tsv`.

### Cause

`scan` orchestrator dedups discovered jobs against the master pool, then
appends only the `fresh` set (new-to-pool) to `profiles/<id>/applications.tsv`.
That made sense in isolation, but the pool aggregates across all profiles
and accumulated ~19k jobs since launch — many predating Stage 19 cutover
and prior to the P0 filter fix above.

Result: jobs that landed in pool via Healthcare-Hannah's scan (or earlier PM-Pete scans
before profile-companies expanded) were never run through PM-Pete's filter
rules and never written to his TSV. They sat in pool only.

Concrete example: SoFi greenhouse — 21 PM jobs in pool, 18 added on
2026-04-24 (Stage 19 cutover day) by an earlier scan. PM-Pete's TSV had
none of them after Stage 16 migration finished.

### What changed

One-shot reconciliation script: `scripts/backfill_apps_from_pool.js`.
Reads pool, intersects with profile companies (from `data/companies.tsv`
profile column), drops jobs already in TSV, runs the rest through the
same `filterJobs()` that scan now uses post-P0-fix, appends passed as
`To Apply` and rejected as `Archived`. Idempotent, dry-run by default.

Applied for PM-Pete on 2026-05-04: +17581 rows (133 To Apply, 17448 Archived).
Backup at `applications.tsv.pre-pool-backfill-2026-05-04`.

Also retired the Stage 16 `push_manifest.json` gate. Manifest was a scope-
list for one-shot prototype-import push, but the entire `sync` push phase
should never run on the modern flow (jobs reach Notion via `prepare`, not
`sync`). Manifest restored 2026-05-04 to keep `sync --apply` safe until
push-phase removal lands as a separate change.

### Prevention

Long-term: remove push phase from `sync` entirely (architectural fix —
sync should be Notion → TSV only). Tracked separately.

Short-term: backfill script exists for any future profile that exhibits
pool-vs-TSV gap. Run with `--profile <id> --apply`.

Healthcare-Hannah: not affected by this gap because her companies are tracked in
`profile.json.discovery.companies_whitelist`, not `data/companies.tsv`.
Backfill script reads `data/companies.tsv` profile column — would report
0 candidates for her. Separate iteration needed if a similar gap surfaces.
