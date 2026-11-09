// CLI entry point.
//
// Usage:
//   node engine/cli.js <command> --profile <id> [--dry-run] [--apply] [--verbose]
//
// Commands are registered in COMMANDS below. Each command is a small function
// that receives a normalized invocation context and returns an exit code (or
// throws — caught by main()).
//
// The CLI is exported as `runCli({argv, env, stdout, stderr, commands?})` so
// tests can inject everything (no global state). When run directly, it wires
// process.argv / process.env / process.stdout / process.stderr.

const { parseArgs } = require("util");

const KNOWN_COMMANDS = [
  "scan",
  "add",
  "validate",
  "sync",
  "prepare",
  "check",
  "indeed-prep",
  "answer",
  "reclassify",
  "retro-tailor",
  "backfill-outreach-url",
  "companies-upsert",
  "board",
  "report",
  "apply",
  "night",
  "submit-ready",
  "companies",
  "requeue",
];

// Commands that take one sub-command positional (`companies add`).
const SUBCOMMANDS = { companies: ["add"] };

// Commands that never write applications.tsv / Notion (RFC 068 §8 / §10). The
// lazy auto-Dead / auto-No-Response sweeps write the TSV and Notion, so they
// are skipped for these — opening the registry must never change data, and
// `night` (only its own lock / log / fan-out files) is polled many times a
// night, where a sweep on every call would only add Notion traffic.
// `companies` writes only data/companies.tsv and runs many times in a night
// (RFC 069 §6 top-up).
const READ_ONLY_COMMANDS = new Set(["board", "report", "night", "companies"]);
// The lazy sweeps are skipped for these too. `submit-ready` does write the TSV
// (through apply's submit code) but launchd starts it every 15 minutes, day
// and night — a sweep on every start would only add Notion traffic.
const NO_SWEEP_COMMANDS = new Set([...READ_ONLY_COMMANDS, "submit-ready"]);

const PARSE_OPTIONS = {
  options: {
    profile: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    phase: { type: "string" },
    "results-file": { type: "string" },
    batch: { type: "string" },
    mode: { type: "string" },
    need: { type: "string" },
    prepare: { type: "boolean", default: false },
    since: { type: "string" },
    "reprocess-since": { type: "string" },
    "no-sync": { type: "boolean", default: false },
    "no-callout": { type: "boolean", default: false },
    auto: { type: "boolean", default: false },
    company: { type: "string" },
    role: { type: "string" },
    question: { type: "string" },
    dedup: { type: "boolean", default: false },
    notion: { type: "boolean", default: false },
    limit: { type: "string" },
    // `add` (RFC 063). `company` is shared with `answer` above.
    title: { type: "string" },
    status: { type: "string" },
    salary: { type: "string" },
    locations: { type: "string" },
    url: { type: "string" },
    tier: { type: "string" },
    fit: { type: "string" },
    notes: { type: "string" },
    "applied-date": { type: "string" },
    "resume-ver": { type: "string" },
    force: { type: "boolean", default: false },
    // `board` / `report` (RFC 068 §8 / §10).
    "no-open": { type: "boolean", default: false },
    port: { type: "string" },
    weekly: { type: "boolean", default: false },
    out: { type: "string" },
    // `apply` (RFC 068).
    "answers-file": { type: "string" },
    key: { type: "string" },
    concurrency: { type: "string" },
    deadline: { type: "string" },
    // `night` (RFC 068 §9, BL-225).
    target: { type: "string" },
    "stop-at": { type: "string" },
    "max-hours": { type: "string" },
    "stop-reason": { type: "string" },
    minutes: { type: "string" },
    // `companies add` (RFC 069 §6).
    ats: { type: "string" },
    slug: { type: "string" },
    name: { type: "string" },
    "from-file": { type: "string" },
  },
  allowPositionals: true,
  strict: true,
};

const HELP_TEXT = `\
ai-job-searcher CLI — multi-profile job search pipeline

Usage:
  node engine/cli.js <command> --profile <id> [flags]

Commands:
  scan       Discover new jobs across configured ATS adapters, append them
             to the shared pool + per-profile applications. Auto-syncs with
             Notion BEFORE running (BL-151 / RFC 054). Pass --no-sync to skip.
  add        Enter one job by hand — for vacancies that arrive outside the
             ATS scan (referrals, newsletters, recruiter email, direct site
             applications). Creates the Notion page and the TSV row in one
             run. Default: dry-run. See RFC 063.
  validate   Pre-flight: URL liveness, company cap, TSV hygiene.
  sync       Reconcile per-profile applications with Notion + archive used
             tailored CV/CL artifacts for rows past To Apply (BL-151).
             Default: dry-run.
  prepare    Two-phase fresh-row triage (status="To Apply" + no notion_page_id).
             Auto-syncs with Notion BEFORE running (BL-151). Pass --no-sync to skip.
             See --phase.
  check      Two-phase Gmail response polling. See --prepare / --apply.
  indeed-prep Print Indeed scan playbook for Claude browser MCP (URLs + JS snippet
             + filter context). Phase 1 of the Indeed ingest flow.
  answer     Two-phase application Q&A flow. See --phase. Searches the Notion
             Application Q&A DB for reuse before generation, pushes approved
             answers back. Per RFC 009.
  reclassify Re-run the email classifier across historical OTHER entries in
             processed_messages.json (last 30 days). Dry-run by default;
             --apply mutates the JSON, --apply --notion adds per-row
             interactive Notion page updates. See RFC 028 / BL-44.
  retro-tailor Re-tailor Strong rows currently in "To Apply" that landed in
             Notion BEFORE the RFC-044 tailoring loop existed. Default phase
             is recon (scans TSV, writes retro_tailor_context.json). With
             --apply --results-file <path>, generates tailored DOCX/PDF and
             updates the existing Notion page's Resume Version. Cover letter
             is NOT regenerated. See RFC 047 / BL-133.
  backfill-outreach-url
             One-shot backfill of the LinkedIn people-search URL for existing
             "To Apply" / "Applied" rows that predate the RFC-059 outreach
             feature (empty company_people_search_url). Dry-run by default
             (prints "would enrich N, skip M (no company), already set K");
             --apply computes the URL, writes it to TSV, and pushes it to the
             Notion "LinkedIn Search" field via a targeted page update.
             Idempotent — a second run is a no-op. See RFC 059 / BL-186.
  companies-upsert
             Push relokant-sweep sweet-zone targets (ru_friendly_targets.tsv)
             into the per-profile Notion Companies DB, two-way deduped (by
             domain + name against existing Notion pages, data/companies.tsv,
             and the relokant ledgers). Existing pages are back-filled on empty
             fields only; Tier is never written. Dry-run by default (prints
             "N to create, M to fill, K skip"); --apply commits. See RFC 062 /
             BL-202.
  board      Open the read-only registry page: applications, rows to finish
             by hand, the weekly numbers, job sources and application sites.
             Local server on 127.0.0.1 with a token in the URL; a second
             launch reuses the running one; closes after 30 min idle.
             See RFC 068.
  report     Write a report page. With --weekly: weekly application stats
             as weekly-<YYYY-MM-DD>.html. See RFC 068.
  apply      Bot fills and submits Greenhouse / Lever / Ashby application
             forms for To Apply rows (Strong/Medium, never applied, within
             the company cap). Three phases: --phase pre reads the forms and
             writes .apply-state/apply_context.json; the job-pipeline skill
             answers the open questions; --phase submit fills, submits and
             marks Applied. --dry-run stops before the Submit click.
             --phase open --key <key> opens one manual job in a visible
             browser, filled, for the human to press Submit (the board's
             «Открыть заполненной» button). See RFC 068.
  night      Rails for the unattended nightly run (skills/job-pipeline/
             night-apply.md): lock + deadline (start), what to do next
             (check), per-row / per-job fan-out files for parallel
             subagents (prepare-fanout, prepare-collect, apply-fanout), and
             one line per night in .health/apply_runs.jsonl (finish).
             Ends each apply round with a ready manifest (ready) for the
             submitter; never submits itself. Never writes applications.tsv
             or Notion. See RFC 068 §9 / §11, RFC 069.
  submit-ready
             The submitter outside Claude (RFC 069): submits the rows of the
             night's ready manifests inside the profile's apply_window
             (default 02:00-11:00), never past a manifest deadline; after the
             window sends one morning notification. Started by launchd every
             15 min — scripts/install_submitter.sh --profile <id>.
  companies  companies add --ats greenhouse|lever|ashby --slug <slug>
             [--name <company>]: add a company board to data/companies.tsv
             for this profile. The board is fetched once to validate it;
             duplicates are reported, not added. Prints one JSON line
             {"result":"added"|"exists"|"invalid",…}. See RFC 069 §6.
  requeue    --since <YYYY-MM-DD>: bot submissions since the date with no
             confirmation mail in the apply mailbox and the job still open
             go back to the apply queue (status To Apply, apply_state
             queued; Notion status too). Rows the old bot left to a human
             (apply_state manual / failed, still To Apply) go back too,
             unless a mail or the ATS page shows they went out.
             Dry-run by default; --apply writes. See RFC 069 §8.

Flags:
  --profile <id>       Profile id (required for all commands). Lowercase, alphanum + - _.
  --dry-run            Print planned changes without writing.
  --apply              Required for sync (commits Notion mutations) and validate
                       (commits retro-sweep archives). For check, --apply switches
                       phase 1 → phase 3. No-op for scan (scan always writes TSV;
                       use --dry-run to preview).
  --verbose            Verbose logging.
  -h, --help           Show this help.

validate flags:
  --dedup                Detect rows in applications.tsv that resolve to the same
                         canonical key after stripping ATS prefixes (legacy
                         "lever:abc" ↔ "lever:lever:abc" collisions). Default:
                         report dry-run. With --apply: rewrite TSV (after
                         backing up to applications.tsv.pre-dedup-<timestamp>).

prepare flags:
  --phase <pre|commit>   Required for prepare. "pre" runs filter/URL/JD/salary and
                         writes prepare_context.json. "commit" applies SKILL results.
  --results-file <path>  Required for --phase commit. Path to SKILL results JSON.
  --batch <n>            Max jobs per prepare run (default: 30). Used with --phase pre.
  --mode <fresh|topup>
                         Used with --phase pre. "fresh" (default) runs the full pipeline
                         and rewrites prepare_context.json. "topup" reads the existing
                         context, pulls more entries from deferredQueue, URL-checks /
                         JD-fetches them, and appends to batch[]. (RFC 034 removed
                         "weak-fallback" — Weak rows now go to Notion directly via
                         the standard fresh/topup loop and are triaged by the operator.)
  --need <K>             Used with --mode topup. Number of new alive
                         entries to add. Default: batchSize - current batch length.

check flags:
  --prepare              Phase 1: build Gmail batches, write check_context.json.
  --apply                Phase 3: commit TSV + Notion updates. Default: dry-run.
  --auto                 Single-process autonomous flow (IMAP Gmail fetch +
                         classify + apply). Use for cron / fly.io. Requires
                         {ID}_GMAIL_USER and {ID}_GMAIL_APP_PASSWORD env vars.
                         Generate an app-password at
                         myaccount.google.com/apppasswords (requires 2FA).
  --since <ISO>          Override cursor (clamped to 30 days max).
  --reprocess-since <ISO>
                         One-time recovery (RFC 056): set cursor to <ISO> AND
                         bypass the processed_messages.json dedup for that
                         window, re-matching fetched mail against the current
                         active set. Idempotent for status changes (already-
                         terminal jobs are absent from the active set);
                         comment_only actions are dropped to avoid duplicate
                         comments. Use with --auto; dry-run unless --apply.

reclassify flags:
  --apply                Mutate processed_messages.json. Default: dry-run.
  --notion               With --apply: per-row interactive prompt to update
                         the matching Notion page status + add a bot
                         comment. Terminal-status rows default to N (operator
                         must explicitly type 'y').
  --since <ISO>          Only consider OTHER entries with date >= ISO. Clamped
                         to 30-day window (older entries are pruned anyway).
  --limit <N>            Cap entries per run (smoke / dry-run friendly).
  --verbose              Print per-id fetch progress + log "unchanged" rows.

retro-tailor flags:
  --apply                Required for the commit phase. Without --apply (or
                         with --dry-run), runs recon only.
  --results-file <path>  Required with --apply. SKILL-produced results.json
                         with per-row tailoredResume / tailorEscalated fields.
  --batch <N>            Cap candidate count per recon (default 30).
  --since <YYYY-MM-DD>   Skip candidates older than this date (recon only).
  --dry-run              Recon-only mode without writing the context file.

apply flags:
  --phase <pre|submit>   Required.
  --limit <N>            pre: cap the queue at N jobs (newest first).
  --answers-file <path>  Required for --phase submit. JSON written by the skill:
                         {"answers":[{"key","label","answer","bank_page_id"}]},
                         or a directory of such files (one per job — the
                         night run's answers/ folder; may be empty).
  --concurrency <N>      Parallel browser contexts (default 4; at most one
                         open form per ATS tenant).
  --deadline <ISO>       submit: start no new form after this time; the rest
                         stay queued for the next run (outcome "deadline").
  --dry-run              pre: no TSV writes. submit: everything except the
                         Submit click; keeps a screenshot of the filled form.

night flags:
  --phase <start|check|prepare-fanout|prepare-collect|apply-fanout|ready|wait|finish>
                         Required. check exits 2 when the night must stop;
                         start exits 3 when another night holds the lock.
  --target <N>           start: applications to aim for tonight (default:
                         profile apply_target, else 30).
  --stop-at <HH:MM>      start: local time to stop starting new work
                         (default: profile apply_stop_at, else 11:00).
  --max-hours <N>        start: hard cap on the run length (default 14).
  --minutes <N>          wait: longest wait for the submitter (default 9).
  --stop-reason <text>   finish: why the night ended (deadline, target_reached,
                         usage_budget, scan_failed, prepare_failed, apply_failed).

submit-ready flags:
  --concurrency <N>      Parallel browser contexts (default 4).

companies flags:
  add                    Required subcommand (companies add …).
  --ats <greenhouse|lever|ashby>
                         Required. The board's ATS.
  --slug <slug>          Required. Board slug (boards.greenhouse.io/<slug>,
                         jobs.lever.co/<slug>, jobs.ashbyhq.com/<slug>).
  --name <company>       Company name (default: from the slug).
  --from-file <tsv>      Instead of --ats/--slug: one board per line,
                         "ats<TAB>slug<TAB>name"; every line validated.

requeue flags:
  --since <YYYY-MM-DD>   Required. Bot submissions applied on/after this date.
  --apply                Write TSV + Notion. Default: dry-run (prints the list).

answer flags:
  --phase <search|push>  Required. "search" looks up existing Q&A by company+role+question
                         and prints a JSON match report. "push" reads --results-file and
                         creates/updates a page in the Notion Application Q&A DB.
  --company <name>       Required for --phase search. Company name as it appears in Notion.
  --role <title>         Required for --phase search. Role title.
  --question <text>      Required for --phase search. Question text (one line).
  --results-file <path>  Required for --phase push. JSON: {company, role, question,
                         answer, category?, notes?, existingPageId?}.

board flags:
  --no-open              Print the URL without opening the browser.
  --port <n>             Listen on this port (default: any free port).

report flags:
  --weekly               Required. Weekly stats for the 7 days ending today.
  --out <dir>            Output directory. Default: $AI_JOB_SEARCHER_DATA_DIR/reports,
                         else data/reports in the repo.

Environment:
  Per-profile secrets are namespaced by profile id (uppercased). For example,
  with --profile jared the CLI reads JARED_NOTION_TOKEN, JARED_USAJOBS_API_KEY,
  etc. Secrets for other profiles are never loaded into memory.
`;

function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({ ...PARSE_OPTIONS, args: argv });
  } catch (err) {
    return { error: err.message };
  }
  const positionals = parsed.positionals || [];
  return { values: parsed.values, positionals };
}

function pickCommand(positionals) {
  const command = positionals[0];
  if (!command) return { error: "missing command" };
  if (!KNOWN_COMMANDS.includes(command)) {
    return { error: `unknown command: ${command} (known: ${KNOWN_COMMANDS.join(", ")})` };
  }
  const subs = SUBCOMMANDS[command];
  if (subs) {
    const sub = positionals[1];
    if (!sub || !subs.includes(sub)) {
      return { error: `${command} needs a subcommand: ${subs.join(", ")}` };
    }
    if (positionals.length > 2) {
      return { error: `unexpected extra positional args: ${positionals.slice(2).join(" ")}` };
    }
    return { command, subcommand: sub };
  }
  if (positionals.length > 1) {
    return { error: `unexpected extra positional args: ${positionals.slice(1).join(" ")}` };
  }
  return { command };
}

function defaultCommands() {
  // Lazy require: require.cache ensures each module loads at most once per
  // process. This keeps test startup fast when tests inject their own handlers.
  return {
    scan: require("./commands/scan.js"),
    add: require("./commands/add.js"),
    validate: require("./commands/validate.js"),
    sync: require("./commands/sync.js"),
    prepare: require("./commands/prepare.js"),
    check: require("./commands/check.js"),
    "indeed-prep": require("./commands/indeed_prepare.js"),
    answer: require("./commands/answer.js"),
    reclassify: require("./commands/reclassify.js"),
    "retro-tailor": require("./commands/retro_tailor.js"),
    "backfill-outreach-url": require("./commands/backfill_outreach_url.js"),
    "companies-upsert": require("./commands/companies_upsert.js"),
    board: require("./commands/board.js"),
    report: require("./commands/report.js"),
    apply: require("./commands/apply.js"),
    night: require("./commands/night.js"),
    "submit-ready": require("./commands/submit_ready.js"),
    companies: require("./commands/companies.js"),
    requeue: require("./commands/requeue.js"),
  };
}

async function runCli({ argv, env = process.env, stdout, stderr, commands } = {}) {
  const out = stdout || process.stdout;
  const err = stderr || process.stderr;
  const writeOut = (s) => out.write(s.endsWith("\n") ? s : `${s}\n`);
  const writeErr = (s) => err.write(s.endsWith("\n") ? s : `${s}\n`);

  const parsed = parse(argv);
  if (parsed.error) {
    writeErr(`error: ${parsed.error}`);
    writeErr("");
    writeErr(HELP_TEXT);
    return 1;
  }
  // `--help` (with or without a command) prints help and exits. Accepts both
  // `cli.js --help` and `cli.js scan --help` forms.
  if (parsed.values.help) {
    writeOut(HELP_TEXT);
    return 0;
  }

  const cmdResult = pickCommand(parsed.positionals);
  if (cmdResult.error) {
    writeErr(`error: ${cmdResult.error}`);
    writeErr("");
    writeErr(HELP_TEXT);
    return 1;
  }

  const profile = parsed.values.profile;
  if (!profile || typeof profile !== "string") {
    writeErr("error: --profile <id> is required");
    return 1;
  }

  const ctx = {
    command: cmdResult.command,
    subcommand: cmdResult.subcommand || "",
    profileId: profile,
    flags: {
      dryRun: Boolean(parsed.values["dry-run"]),
      apply: Boolean(parsed.values.apply),
      verbose: Boolean(parsed.values.verbose),
      phase: parsed.values.phase || "",
      resultsFile: parsed.values["results-file"] || "",
      batch: parsed.values.batch ? parseInt(parsed.values.batch, 10) : 30,
      mode: parsed.values.mode || "",
      need: parsed.values.need ? parseInt(parsed.values.need, 10) : null,
      prepare: Boolean(parsed.values.prepare),
      since: parsed.values.since || "",
      reprocessSince: parsed.values["reprocess-since"] || "",
      noSync: Boolean(parsed.values["no-sync"]),
      noCallout: Boolean(parsed.values["no-callout"]),
      auto: Boolean(parsed.values.auto),
      company: parsed.values.company || "",
      role: parsed.values.role || "",
      question: parsed.values.question || "",
      dedup: Boolean(parsed.values.dedup),
      notion: Boolean(parsed.values.notion),
      limit: parsed.values.limit ? parseInt(parsed.values.limit, 10) : null,
      // add (RFC 063) — `company` above is shared with answer.
      title: parsed.values.title || "",
      status: parsed.values.status || "",
      salary: parsed.values.salary || "",
      locations: parsed.values.locations || "",
      url: parsed.values.url || "",
      tier: parsed.values.tier || "",
      fit: parsed.values.fit || "",
      notes: parsed.values.notes || "",
      appliedDate: parsed.values["applied-date"] || "",
      resumeVer: parsed.values["resume-ver"] || "",
      force: Boolean(parsed.values.force),
      // board / report (RFC 068). `port` stays a string — board validates it.
      noOpen: Boolean(parsed.values["no-open"]),
      port: parsed.values.port || "",
      weekly: Boolean(parsed.values.weekly),
      out: parsed.values.out || "",
      // apply (RFC 068)
      answersFile: parsed.values["answers-file"] || "",
      key: parsed.values.key || "",
      concurrency: parsed.values.concurrency ? parseInt(parsed.values.concurrency, 10) : null,
      deadline: parsed.values.deadline || "",
      // night (RFC 068 §9, BL-225)
      target: parsed.values.target ? parseInt(parsed.values.target, 10) : null,
      stopAt: parsed.values["stop-at"] || "",
      maxHours: parsed.values["max-hours"] ? Number(parsed.values["max-hours"]) : null,
      stopReason: parsed.values["stop-reason"] || "",
      minutes: parsed.values.minutes ? Number(parsed.values.minutes) : null,
      // companies add (RFC 069 §6)
      ats: parsed.values.ats || "",
      slug: parsed.values.slug || "",
      name: parsed.values.name || "",
      fromFile: parsed.values["from-file"] || "",
    },
    env,
    stdout: writeOut,
    stderr: writeErr,
  };

  const handlers = commands || defaultCommands();
  const handler = handlers[ctx.command];
  if (typeof handler !== "function") {
    writeErr(`error: no handler registered for command "${ctx.command}"`);
    return 1;
  }

  // Code-first pipeline pre-hooks: deterministic steps that must run
  // BEFORE the main command. These never require AI — they live here so
  // the pipeline works without a Claude skill.
  //
  // scan / prepare → auto-sync (BL-151 / RFC 054): before every scan or
  // prepare, reconcile TSV with Notion (so downstream filters / cap
  // counters / fit-eval read fresh state) and archive used tailored
  // artifacts (CV + CL) for rows whose status moved past To Apply.
  // Skip with --no-sync. `scan --dry-run` also skips for parity with the
  // prior post-hook semantics (dry-run preview never mutates).
  const { runAutoSync } = require("./core/auto_sync.js");
  const PIPELINE_PRE_HOOKS = {
    scan: async (c, h) => {
      if (c.flags.noSync || c.flags.dryRun) return;
      try {
        await runAutoSync(c.profileId, c, h);
      } catch (e) {
        c.stderr(`warn: auto-sync failed: ${e.message}`);
      }
    },
    prepare: async (c, h) => {
      if (c.flags.noSync) return;
      try {
        await runAutoSync(c.profileId, c, h);
      } catch (e) {
        c.stderr(`warn: auto-sync failed: ${e.message}`);
      }
    },
    // RFC 055 (Change A): the fly.io cron runs `check --auto --apply` daily
    // and builds its Gmail search from the local TSV. Without a pull, that
    // TSV is stale (new apps are created on the operator's Mac + Notion,
    // never on the fly volume). Auto-sync before check so the now-additive
    // reconcilePull lands the full active set before check reads the TSV.
    check: async (c, h) => {
      if (c.flags.noSync) return;
      try {
        await runAutoSync(c.profileId, c, h);
      } catch (e) {
        c.stderr(`warn: auto-sync failed: ${e.message}`);
      }
    },
  };

  // Auto-Dead lazy sweep (BL-169 / RFC 059 amendment): runs at the START of
  // EVERY command (scan / prepare / check / sync / validate / …). Rows that
  // have been "In flight" for >= 7 days flip to "Dead" so the operator's
  // worklist only shows live threads. Pure scan first → cheap no-op when
  // nothing is stale. It never throws out of here (runAutoDeadSweep catches
  // and logs), and a Notion outage / missing token never breaks the command —
  // the sweep degrades to TSV-only. "today" is computed once and injected so
  // the pure helpers stay deterministic. No cron, no scheduler — lazy on CLI
  // invocation only.
  const { runAutoDeadSweep, todayLocalISO } = require("./core/auto_dead_sweep.js");
  // Auto-No-Response lazy sweep (BL-187 / RFC 059 amendment): same lazy
  // machinery as auto-Dead, but for the vacancy's main status. Rows that have
  // been "Applied" for >= 14 days (anchored by `applied_date`) flip to
  // "No Response". Independent of auto-Dead; runs second for determinism. Same
  // injected "today", same never-throws / TSV-only-without-token contract.
  const { runAutoNoResponseSweep } = require("./core/auto_no_response_sweep.js");

  try {
    if (!NO_SWEEP_COMMANDS.has(ctx.command)) {
      const todayStr = todayLocalISO();
      await runAutoDeadSweep(ctx.profileId, ctx, { todayStr });
      await runAutoNoResponseSweep(ctx.profileId, ctx, { todayStr });
    }
    const preHook = PIPELINE_PRE_HOOKS[ctx.command];
    if (preHook) await preHook(ctx, handlers);
    const code = await handler(ctx);
    const exitCode = Number.isInteger(code) ? code : 0;
    return exitCode;
  } catch (e) {
    writeErr(`error: ${e.message}`);
    if (ctx.flags.verbose && e.stack) writeErr(e.stack);
    return 1;
  }
}

module.exports = { runCli, KNOWN_COMMANDS, HELP_TEXT, READ_ONLY_COMMANDS };

if (require.main === module) {
  // Load `.env` only when invoked as a CLI — tests keep hermetic env via
  // explicit `env` injection into runCli().
  try {
    require("dotenv").config();
  } catch {
    // dotenv is optional — CLI still works with env vars exported by the shell.
  }
  runCli({ argv: process.argv.slice(2) }).then((code) => {
    process.exit(code);
  });
}
