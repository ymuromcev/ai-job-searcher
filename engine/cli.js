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

const KNOWN_COMMANDS = ["scan", "validate", "sync", "prepare", "check"];

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
    prepare: { type: "boolean", default: false },
    since: { type: "string" },
  },
  allowPositionals: true,
  strict: true,
};

const HELP_TEXT = `\
ai-job-searcher CLI — multi-profile job search pipeline

Usage:
  node engine/cli.js <command> --profile <id> [flags]

Commands:
  scan       Discover new jobs across configured ATS adapters and append them
             to the shared pool + per-profile applications.
  validate   Pre-flight: URL liveness, company cap, TSV hygiene.
  sync       Reconcile per-profile applications with Notion. Default: dry-run.
  prepare    Two-phase Inbox processing. See --phase.
  check      Two-phase Gmail response polling. See --prepare / --apply.

Flags:
  --profile <id>       Profile id (required for all commands). Lowercase, alphanum + - _.
  --dry-run            Print planned changes without writing.
  --apply              Required for sync to actually mutate Notion. Default behaviour
                       is dry-run; pass --apply to commit changes.
  --verbose            Verbose logging.
  -h, --help           Show this help.

prepare flags:
  --phase <pre|commit>   Required for prepare. "pre" runs filter/URL/JD/salary and
                         writes prepare_context.json. "commit" applies SKILL results.
  --results-file <path>  Required for --phase commit. Path to SKILL results JSON.
  --batch <n>            Max jobs per prepare run (default: 30). Used with --phase pre.

check flags:
  --prepare              Phase 1: build Gmail batches, write check_context.json.
  --apply                Phase 3: commit TSV + Notion updates. Default: dry-run.
  --since <ISO>          Override cursor (clamped to 30 days max).

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
    validate: require("./commands/validate.js"),
    sync: require("./commands/sync.js"),
    prepare: require("./commands/prepare.js"),
    check: require("./commands/check.js"),
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
    profileId: profile,
    flags: {
      dryRun: Boolean(parsed.values["dry-run"]),
      apply: Boolean(parsed.values.apply),
      verbose: Boolean(parsed.values.verbose),
      phase: parsed.values.phase || "",
      resultsFile: parsed.values["results-file"] || "",
      batch: parsed.values.batch ? parseInt(parsed.values.batch, 10) : 30,
      prepare: Boolean(parsed.values.prepare),
      since: parsed.values.since || "",
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

  try {
    const code = await handler(ctx);
    return Number.isInteger(code) ? code : 0;
  } catch (e) {
    writeErr(`error: ${e.message}`);
    if (ctx.flags.verbose && e.stack) writeErr(e.stack);
    return 1;
  }
}

module.exports = { runCli, KNOWN_COMMANDS, HELP_TEXT };

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
