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
  const code = await runCli({ argv: ["bogus", "--profile", "jared"], stdout: s.stdout, stderr: s.stderr });
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
  assert.deepEqual([...KNOWN_COMMANDS].sort(), ["answer", "check", "indeed-prep", "prepare", "scan", "sync", "validate"]);
});

test("runCli passes prepare-specific flags to handler", async () => {
  const s = makeStreams();
  const prepare = spyCommand(() => 0);
  const code = await runCli({
    argv: [
      "prepare", "--profile", "jared",
      "--phase", "pre", "--batch", "10",
    ],
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
    argv: [
      "prepare", "--profile", "jared",
      "--phase", "commit", "--results-file", "/tmp/r.json",
    ],
    stdout: s.stdout,
    stderr: s.stderr,
    commands: { prepare },
  });
  const ctx = prepare.calls[0];
  assert.equal(ctx.flags.phase, "commit");
  assert.equal(ctx.flags.resultsFile, "/tmp/r.json");
});
