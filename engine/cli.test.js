const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Writable } = require("node:stream");

const { runCli, KNOWN_COMMANDS } = require("./cli.js");

function makeStreams() {
  const chunks = { stdout: [], stderr: [] };
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      chunks.stdout.push(chunk.toString());
      cb();
    },
  });
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      chunks.stderr.push(chunk.toString());
      cb();
    },
  });
  return {
    stdout,
    stderr,
    out: () => chunks.stdout.join(""),
    err: () => chunks.stderr.join(""),
  };
}

function spyCommand(impl) {
  const calls = [];
  const fn = async (ctx) => {
    calls.push(ctx);
    return impl ? impl(ctx) : 0;
  };
  fn.calls = calls;
  return fn;
}

test("runCli exits 0 and prints help on --help", async () => {
  const s = makeStreams();
  const code = await runCli({ argv: ["--help"], stdout: s.stdout, stderr: s.stderr });
  assert.equal(code, 0);
  assert.match(s.out(), /Commands:/);
  assert.equal(s.err(), "");
});

test("runCli rejects unknown command and shows help on stderr", async () => {
  const s = makeStreams();
  const code = await runCli({
    argv: ["bogus", "--profile", "jared"],
    stdout: s.stdout,
    stderr: s.stderr,
  });
  assert.equal(code, 1);
  assert.match(s.err(), /unknown command: bogus/);
  assert.match(s.err(), /Commands:/);
});

test("runCli rejects missing --profile", async () => {
  const s = makeStreams();
  const code = await runCli({ argv: ["scan"], stdout: s.stdout, stderr: s.stderr });
  assert.equal(code, 1);
  assert.match(s.err(), /--profile <id> is required/);
});

test("runCli rejects missing command", async () => {
  const s = makeStreams();
  const code = await runCli({
    argv: ["--profile", "jared"],
    stdout: s.stdout,
    stderr: s.stderr,
  });
  assert.equal(code, 1);
  assert.match(s.err(), /missing command/);
});

test("runCli rejects unknown flags via parseArgs strict mode", async () => {
  const s = makeStreams();
  const code = await runCli({
    argv: ["scan", "--profile", "jared", "--bogus"],
    stdout: s.stdout,
    stderr: s.stderr,
  });
  assert.equal(code, 1);
  assert.match(s.err(), /Unknown option/i);
});

test("runCli rejects extra positional args", async () => {
  const s = makeStreams();
  const code = await runCli({
    argv: ["scan", "extra", "--profile", "jared"],
    stdout: s.stdout,
    stderr: s.stderr,
  });
  assert.equal(code, 1);
  assert.match(s.err(), /unexpected extra positional/);
});

test("runCli dispatches to registered handler with normalized ctx", async () => {
  const s = makeStreams();
  const scan = spyCommand(() => 0);
  const code = await runCli({
    argv: ["scan", "--profile", "jared", "--dry-run", "--verbose"],
    env: { JARED_NOTION_TOKEN: "x", PAT_NOTION_TOKEN: "y" },
    stdout: s.stdout,
    stderr: s.stderr,
    commands: { scan },
  });
  assert.equal(code, 0);
  assert.equal(scan.calls.length, 1);
  const ctx = scan.calls[0];
  assert.equal(ctx.command, "scan");
  assert.equal(ctx.profileId, "jared");
  assert.equal(ctx.flags.dryRun, true);
  assert.equal(ctx.flags.apply, false);
  assert.equal(ctx.flags.verbose, true);
  // env must be passed through unchanged so secrets loader can scope by prefix.
  assert.equal(ctx.env.JARED_NOTION_TOKEN, "x");
  assert.equal(ctx.env.PAT_NOTION_TOKEN, "y");
});

test("runCli parses --reprocess-since into ctx.flags.reprocessSince (RFC 056)", async () => {
  const s = makeStreams();
  const check = spyCommand(() => 0);
  const code = await runCli({
    argv: ["check", "--profile", "jared", "--auto", "--reprocess-since", "2026-04-01T00:00:00Z"],
    env: { JARED_NOTION_TOKEN: "x" },
    stdout: s.stdout,
    stderr: s.stderr,
    commands: { check },
  });
  assert.equal(code, 0);
  assert.equal(check.calls.length, 1);
  assert.equal(check.calls[0].flags.reprocessSince, "2026-04-01T00:00:00Z");
  // Default empty when absent.
  assert.equal(check.calls[0].flags.since, "");
});

test("runCli passes through handler exit code and traps thrown errors", async () => {
  const s = makeStreams();
  const exitCode = await runCli({
    argv: ["scan", "--profile", "jared"],
    stdout: s.stdout,
    stderr: s.stderr,
    commands: { scan: spyCommand(() => 7) },
  });
  assert.equal(exitCode, 7);

  const s2 = makeStreams();
  const thrownCode = await runCli({
    argv: ["scan", "--profile", "jared"],
    stdout: s2.stdout,
    stderr: s2.stderr,
    commands: {
      scan: async () => {
        throw new Error("boom");
      },
    },
  });
  assert.equal(thrownCode, 1);
  assert.match(s2.err(), /error: boom/);
});

test("runCli prints stack only when --verbose is set", async () => {
  const noisy = async () => {
    throw new Error("noisy");
  };

  const s1 = makeStreams();
  await runCli({
    argv: ["scan", "--profile", "jared"],
    stdout: s1.stdout,
    stderr: s1.stderr,
    commands: { scan: noisy },
  });
  assert.doesNotMatch(s1.err(), /at .+\.js/);

  const s2 = makeStreams();
  await runCli({
    argv: ["scan", "--profile", "jared", "--verbose"],
    stdout: s2.stdout,
    stderr: s2.stderr,
    commands: { scan: noisy },
  });
  assert.match(s2.err(), /at .+\.js/);
});

test("runCli reports missing handler with a clear error", async () => {
  const s = makeStreams();
  const code = await runCli({
    argv: ["scan", "--profile", "jared"],
    stdout: s.stdout,
    stderr: s.stderr,
    commands: {},
  });
  assert.equal(code, 1);
  assert.match(s.err(), /no handler registered/);
});

test("KNOWN_COMMANDS lists exactly the supported commands", () => {
  assert.deepEqual([...KNOWN_COMMANDS].sort(), [
    "answer",
    "check",
    "indeed-prep",
    "prepare",
    "reclassify",
    "retro-tailor",
    "scan",
    "sync",
    "validate",
  ]);
});

test("scan auto-triggers sync --apply BEFORE main work (pre-hook)", async () => {
  // BL-151 / RFC 054: auto-sync runs before scan so downstream filters
  // / cap counters / fit-eval see fresh Notion state.
  const s = makeStreams();
  const syncCalls = [];
  const callOrder = [];
  const code = await runCli({
    argv: ["scan", "--profile", "jared"],
    stdout: s.stdout,
    stderr: s.stderr,
    commands: {
      scan: spyCommand(() => {
        callOrder.push("scan");
        return 0;
      }),
      sync: async (ctx) => {
        callOrder.push("sync");
        syncCalls.push(ctx);
        return 0;
      },
    },
  });
  assert.equal(code, 0);
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].flags.apply, true);
  assert.deepEqual(callOrder, ["sync", "scan"]);
  assert.match(s.out(), /\[sync\] pulling Notion → TSV \(jared\)/);
});

test("scan --no-sync skips the auto-sync hook", async () => {
  const s = makeStreams();
  const syncCalls = [];
  const code = await runCli({
    argv: ["scan", "--profile", "jared", "--no-sync"],
    stdout: s.stdout,
    stderr: s.stderr,
    commands: {
      scan: spyCommand(() => 0),
      sync: async (ctx) => {
        syncCalls.push(ctx);
        return 0;
      },
    },
  });
  assert.equal(code, 0);
  assert.equal(syncCalls.length, 0);
});

test("scan --dry-run skips the auto-sync hook", async () => {
  const s = makeStreams();
  const syncCalls = [];
  const code = await runCli({
    argv: ["scan", "--profile", "jared", "--dry-run"],
    stdout: s.stdout,
    stderr: s.stderr,
    commands: {
      scan: spyCommand(() => 0),
      sync: async (ctx) => {
        syncCalls.push(ctx);
        return 0;
      },
    },
  });
  assert.equal(code, 0);
  assert.equal(syncCalls.length, 0);
});

test("scan hook: sync failure is non-fatal — scan still exits 0", async () => {
  const s = makeStreams();
  const code = await runCli({
    argv: ["scan", "--profile", "jared"],
    stdout: s.stdout,
    stderr: s.stderr,
    commands: {
      scan: spyCommand(() => 0),
      sync: async () => {
        throw new Error("no token");
      },
    },
  });
  assert.equal(code, 0);
  assert.match(s.err(), /auto-sync failed/);
});

test("scan pre-hook still runs sync when scan itself fails afterward", async () => {
  // BL-151 / RFC 054: with a pre-hook, sync has already run by the time
  // scan fails — that's fine, we want the TSV up to date regardless.
  // The scan exit code is preserved.
  const s = makeStreams();
  const syncCalls = [];
  const code = await runCli({
    argv: ["scan", "--profile", "jared"],
    stdout: s.stdout,
    stderr: s.stderr,
    commands: {
      scan: spyCommand(() => 1),
      sync: async (ctx) => {
        syncCalls.push(ctx);
        return 0;
      },
    },
  });
  assert.equal(code, 1);
  assert.equal(syncCalls.length, 1);
});

test("prepare pre-hook also auto-triggers sync", async () => {
  // BL-151 / RFC 054: prepare gets the same auto-sync hook so it never
  // reasons over stale Notion state.
  const s = makeStreams();
  const syncCalls = [];
  const code = await runCli({
    argv: ["prepare", "--profile", "jared", "--phase", "pre"],
    stdout: s.stdout,
    stderr: s.stderr,
    commands: {
      prepare: spyCommand(() => 0),
      sync: async (ctx) => {
        syncCalls.push(ctx);
        return 0;
      },
    },
  });
  assert.equal(code, 0);
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].flags.apply, true);
});

test("prepare --no-sync skips the auto-sync hook", async () => {
  const s = makeStreams();
  const syncCalls = [];
  const code = await runCli({
    argv: ["prepare", "--profile", "jared", "--phase", "pre", "--no-sync"],
    stdout: s.stdout,
    stderr: s.stderr,
    commands: {
      prepare: spyCommand(() => 0),
      sync: async (ctx) => {
        syncCalls.push(ctx);
        return 0;
      },
    },
  });
  assert.equal(code, 0);
  assert.equal(syncCalls.length, 0);
});

test("check pre-hook auto-triggers sync (RFC 055)", async () => {
  // RFC 055: the fly.io cron runs `check --auto --apply` daily. Auto-sync
  // first so the (now additive) pull lands the full active set before
  // check reads the TSV.
  const s = makeStreams();
  const syncCalls = [];
  const callOrder = [];
  const code = await runCli({
    argv: ["check", "--profile", "jared", "--auto", "--apply"],
    stdout: s.stdout,
    stderr: s.stderr,
    commands: {
      check: spyCommand(() => {
        callOrder.push("check");
        return 0;
      }),
      sync: async (ctx) => {
        callOrder.push("sync");
        syncCalls.push(ctx);
        return 0;
      },
    },
  });
  assert.equal(code, 0);
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].flags.apply, true);
  assert.deepEqual(callOrder, ["sync", "check"]);
});

test("check --no-sync skips the auto-sync hook (RFC 055)", async () => {
  const s = makeStreams();
  const syncCalls = [];
  const code = await runCli({
    argv: ["check", "--profile", "jared", "--no-sync"],
    stdout: s.stdout,
    stderr: s.stderr,
    commands: {
      check: spyCommand(() => 0),
      sync: async (ctx) => {
        syncCalls.push(ctx);
        return 0;
      },
    },
  });
  assert.equal(code, 0);
  assert.equal(syncCalls.length, 0);
});

test("check hook: sync failure is non-fatal — check still exits 0 (RFC 055)", async () => {
  const s = makeStreams();
  const code = await runCli({
    argv: ["check", "--profile", "jared"],
    stdout: s.stdout,
    stderr: s.stderr,
    commands: {
      check: spyCommand(() => 0),
      sync: async () => {
        throw new Error("no token");
      },
    },
  });
  assert.equal(code, 0);
  assert.match(s.err(), /auto-sync failed/);
});

test("runCli passes prepare-specific flags to handler", async () => {
  const s = makeStreams();
  const prepare = spyCommand(() => 0);
  const code = await runCli({
    argv: ["prepare", "--profile", "jared", "--phase", "pre", "--batch", "10"],
    stdout: s.stdout,
    stderr: s.stderr,
    commands: { prepare },
  });
  assert.equal(code, 0);
  const ctx = prepare.calls[0];
  assert.equal(ctx.flags.phase, "pre");
  assert.equal(ctx.flags.batch, 10);
  assert.equal(ctx.flags.resultsFile, "");
});

test("runCli passes --results-file flag for prepare commit", async () => {
  const s = makeStreams();
  const prepare = spyCommand(() => 0);
  await runCli({
    argv: ["prepare", "--profile", "jared", "--phase", "commit", "--results-file", "/tmp/r.json"],
    stdout: s.stdout,
    stderr: s.stderr,
    commands: { prepare },
  });
  const ctx = prepare.calls[0];
  assert.equal(ctx.flags.phase, "commit");
  assert.equal(ctx.flags.resultsFile, "/tmp/r.json");
});
