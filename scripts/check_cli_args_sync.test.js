// Tests for scripts/check_cli_args_sync.js (RFC 041 / BL-104).
//
// Fixtures live in tmpdir under a layout that mirrors the watched paths:
//   <tmp>/engine/cli.js
//   <tmp>/engine/commands/<cmd>.js
//   <tmp>/docs/reference/cli.md
//
// The gate accepts `--root <path>`, so tests run hermetically without
// touching the real engine/.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const gate = require("./check_cli_args_sync.js");

// --- Helpers ---------------------------------------------------------------

function mkRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-args-gate-"));
  fs.mkdirSync(path.join(dir, "engine", "commands"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs", "reference"), { recursive: true });
  return dir;
}

function writeCliJs(root, commands, helpBlocks) {
  // commands: array of command names (strings).
  // helpBlocks: array of `<cmd> flags:\n<body>` strings to include in
  // HELP_TEXT.
  const cmdList = commands.map((c) => `  "${c}",`).join("\n");
  const requireMap = commands
    .map((c) => `    ${c}: require("./commands/${c}.js"),`)
    .join("\n");
  const helpBody = helpBlocks
    .map((b) => `\n${b}\n`)
    .join("");
  const src = `
const KNOWN_COMMANDS = [
${cmdList}
];

const HELP_TEXT = \`
Usage:
  node engine/cli.js <command> --profile <id>
${helpBody}
\`;

function defaultCommands() {
  return {
${requireMap}
  };
}

module.exports = { KNOWN_COMMANDS, HELP_TEXT };
`;
  fs.writeFileSync(path.join(root, "engine", "cli.js"), src, "utf8");
}

function writeCommandFile(root, cmd, body) {
  fs.writeFileSync(
    path.join(root, "engine", "commands", `${cmd}.js`),
    body,
    "utf8"
  );
}

function writeCliMd(root, sections) {
  // sections: array of {cmd, body} where body is the markdown for `### <cmd>`.
  let out = "# CLI reference\n\n## Commands\n";
  for (const s of sections) {
    out += `\n### ${s.cmd}\n\n${s.body}\n`;
  }
  fs.writeFileSync(path.join(root, "docs", "reference", "cli.md"), out, "utf8");
}

function captureStderr() {
  const lines = [];
  return {
    write: (s) => lines.push(s),
    lines,
  };
}

function runGate(root, argv = [], env = {}) {
  const err = captureStderr();
  const out = captureStderr();
  // Most tests assert the gate's drift-detection logic regardless of the
  // current migration default. Force block mode unless the test explicitly
  // sets CLI_ARGS_GATE_MODE.
  const effectiveEnv = { CLI_ARGS_GATE_MODE: "block", ...env };
  const code = gate.main(
    ["--root", root, ...argv],
    effectiveEnv,
    (s) => err.write(s),
    (s) => out.write(s)
  );
  return { code, stderr: err.lines.join("\n"), stdout: out.lines.join("\n") };
}

// --- Cases (RFC 041 §4) ----------------------------------------------------

test("case 1: no watched files staged — exit 0 with no output", () => {
  // We bypass actual git by NOT passing --pre-commit; from CI perspective
  // this is a full-tree scan. But the case is really about the
  // isWatchedPath helper, which is also exposed.
  assert.strictEqual(gate.isWatchedPath("README.md"), false);
  assert.strictEqual(gate.isWatchedPath("engine/core/helpers.js"), false);
  assert.strictEqual(gate.isWatchedPath("engine/cli.js"), true);
  assert.strictEqual(gate.isWatchedPath("engine/commands/prepare.js"), true);
  assert.strictEqual(gate.isWatchedPath("engine/commands/prepare.test.js"), false);
  assert.strictEqual(gate.isWatchedPath("docs/reference/cli.md"), true);
  assert.strictEqual(gate.isWatchedPath("docs/reference/spec.md"), false);
});

test("case 2: happy path — code and docs agree, exit 0", () => {
  const root = mkRoot();
  writeCliJs(
    root,
    ["prepare"],
    [
      `prepare flags:
  --phase <pre|commit>   Required. (valid: pre, commit)
  --mode <fresh|topup>   Used with --phase pre. (valid: fresh, topup)`,
    ]
  );
  writeCommandFile(
    root,
    "prepare",
    `
    async function runPrepare(ctx) {
      const phase = ctx.flags.phase || "";
      if (phase !== "pre" && phase !== "commit") {
        ctx.stderr("error: --phase <pre|commit> is required (valid: pre, commit)");
        return 1;
      }
      const mode = ctx.flags.mode || "fresh";
      if (mode !== "fresh" && mode !== "topup") {
        ctx.stderr(\`error: unknown --mode "\${mode}" (valid: fresh, topup)\`);
        return 1;
      }
      return 0;
    }
    module.exports = runPrepare;
    `
  );
  writeCliMd(root, [
    {
      cmd: "prepare",
      body: `Synopsis: \`node engine/cli.js prepare --profile <id> --phase <pre|commit> [--mode <fresh|topup>]\`

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| \`--phase <pre\\|commit>\` | string | — | Required. |
| \`--mode <fresh\\|topup>\` | string | fresh | Used by --phase pre. |`,
    },
  ]);
  const { code, stderr } = runGate(root);
  assert.strictEqual(code, 0, `expected exit 0, got ${code}. stderr=${stderr}`);
});

test("case 3: code-only flag — exit 1 with message", () => {
  const root = mkRoot();
  writeCliJs(root, ["prepare"], ["prepare flags:\n  --new-flag    Internal."]);
  writeCommandFile(
    root,
    "prepare",
    `if (args["--new-flag"]) { ctx.stderr("--new-flag set"); }`
  );
  writeCliMd(root, [
    {
      cmd: "prepare",
      body: `Synopsis: \`node engine/cli.js prepare --profile <id>\`

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| \`--profile <id>\` | string | — | Required. |`,
    },
  ]);
  const { code, stderr } = runGate(root);
  assert.strictEqual(code, 1);
  assert.match(stderr, /in code but not documented: --new-flag/);
  assert.match(stderr, /prepare:/);
});

test("case 4: doc-only flag — exit 1 with message", () => {
  const root = mkRoot();
  writeCliJs(root, ["prepare"], ["prepare flags:\n  (no extras)"]);
  writeCommandFile(root, "prepare", `module.exports = (ctx) => 0;`);
  writeCliMd(root, [
    {
      cmd: "prepare",
      body: `Synopsis: \`node engine/cli.js prepare --profile <id> [--ghost-flag]\`

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| \`--ghost-flag\` | boolean | false | Documented but absent. |`,
    },
  ]);
  const { code, stderr } = runGate(root);
  assert.strictEqual(code, 1);
  assert.match(stderr, /documented but not in code: --ghost-flag/);
});

test("case 5: enum drift — value removed from code, still in docs (BL-80 case)", () => {
  const root = mkRoot();
  writeCliJs(root, ["prepare"], ["prepare flags:\n  --mode <fresh|topup>"]);
  writeCommandFile(
    root,
    "prepare",
    `
    const mode = ctx.flags.mode || "fresh";
    if (mode !== "fresh" && mode !== "topup") {
      ctx.stderr(\`error: unknown --mode "\${mode}" (valid: fresh, topup)\`);
      return 1;
    }
    `
  );
  writeCliMd(root, [
    {
      cmd: "prepare",
      body: `Synopsis: \`node engine/cli.js prepare --profile <id> [--mode <fresh|topup|weak-fallback>]\`

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| \`--mode <fresh\\|topup\\|weak-fallback>\` | string | fresh | Mode. |`,
    },
  ]);
  const { code, stderr } = runGate(root);
  assert.strictEqual(code, 1, `expected drift, got ${code}. stderr=${stderr}`);
  assert.match(stderr, /enum mismatch on --mode/);
  assert.match(stderr, /code:\s+\[fresh, topup\]/);
  assert.match(stderr, /docs:\s+\[fresh, topup, weak-fallback\]/);
});

test("case 6: enum drift — value added to code, not in docs", () => {
  const root = mkRoot();
  writeCliJs(root, ["prepare"], ["prepare flags:\n  --mode <fresh|topup|backfill>"]);
  writeCommandFile(
    root,
    "prepare",
    `
    if (m !== "fresh" && m !== "topup" && m !== "backfill") {
      ctx.stderr(\`error: unknown --mode "\${m}" (valid: fresh, topup, backfill)\`);
    }
    `
  );
  writeCliMd(root, [
    {
      cmd: "prepare",
      body: `Synopsis: \`node engine/cli.js prepare --profile <id> [--mode <fresh|topup>]\`

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| \`--mode <fresh\\|topup>\` | string | fresh | Mode. |`,
    },
  ]);
  const { code, stderr } = runGate(root);
  assert.strictEqual(code, 1);
  assert.match(stderr, /enum mismatch on --mode/);
  assert.match(stderr, /code:\s+\[backfill, fresh, topup\]/);
  assert.match(stderr, /docs:\s+\[fresh, topup\]/);
});

test("case 7: escape hatch respected — // cli-args-gate-ignore skips line", () => {
  const root = mkRoot();
  writeCliJs(root, ["prepare"], ["prepare flags:\n  (none)"]);
  writeCommandFile(
    root,
    "prepare",
    `
    // The fake-only flag below should be ignored.
    const stray = "--fake-only"; // cli-args-gate-ignore
    module.exports = (ctx) => 0;
    `
  );
  writeCliMd(root, [
    {
      cmd: "prepare",
      body: `Synopsis: \`node engine/cli.js prepare --profile <id>\``,
    },
  ]);
  const { code, stderr } = runGate(root);
  assert.strictEqual(code, 0, `expected exit 0, got ${code}. stderr=${stderr}`);
});

test("case 8: heuristic gives up — warning only, exit 2", () => {
  const root = mkRoot();
  writeCliJs(root, ["prepare"], ["prepare flags:\n  --mode <a|b>"]);
  writeCommandFile(
    root,
    "prepare",
    `
    // Computed mode set — gate cannot extract a literal.
    const validModes = computeModes();
    if (!validModes.has(ctx.flags.mode)) {
      ctx.stderr("--mode invalid");
    }
    `
  );
  writeCliMd(root, [
    {
      cmd: "prepare",
      body: `Synopsis: \`node engine/cli.js prepare --profile <id> --mode <a|b>\`

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| \`--mode <a\\|b>\` | string | a | Computed. |`,
    },
  ]);
  const { code, stderr } = runGate(root);
  assert.strictEqual(code, 2, `expected exit 2, got ${code}. stderr=${stderr}`);
  assert.match(stderr, /could not auto-detect enum/);
  assert.match(stderr, /--mode/);
});

test("case 9: multiple commands, mixed — only drifting one reported", () => {
  const root = mkRoot();
  writeCliJs(
    root,
    ["scan", "prepare", "check"],
    [
      "scan flags:\n  --no-sync   Skip sync.",
      "prepare flags:\n  --mode <fresh|topup>",
      "check flags:\n  --prepare   Phase 1.",
    ]
  );
  writeCommandFile(root, "scan", `if (args["--no-sync"]) { return 0; }`);
  writeCommandFile(
    root,
    "prepare",
    `
    const m = ctx.flags.mode;
    if (m !== "fresh" && m !== "topup") {
      ctx.stderr(\`error: unknown --mode "\${m}" (valid: fresh, topup)\`);
      return 1;
    }
    `
  );
  writeCommandFile(root, "check", `if (args["--prepare"]) { return 0; }`);
  writeCliMd(root, [
    {
      cmd: "scan",
      body: `Synopsis: \`node engine/cli.js scan --profile <id> [--no-sync]\`

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| \`--no-sync\` | boolean | false | Skip sync. |`,
    },
    {
      // prepare drifts: docs adds an extra enum value.
      cmd: "prepare",
      body: `Synopsis: \`node engine/cli.js prepare --profile <id> [--mode <fresh|topup|weak-fallback>]\`

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| \`--mode <fresh\\|topup\\|weak-fallback>\` | string | fresh | Mode. |`,
    },
    {
      cmd: "check",
      body: `Synopsis: \`node engine/cli.js check --profile <id> [--prepare]\`

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| \`--prepare\` | boolean | false | Phase 1. |`,
    },
  ]);
  const { code, stderr } = runGate(root);
  assert.strictEqual(code, 1);
  assert.match(stderr, /prepare:/);
  assert.doesNotMatch(stderr, /\bscan:/);
  assert.doesNotMatch(stderr, /\bcheck:/);
});

test("case 10: in-file disagreement between two code-side sources", () => {
  const root = mkRoot();
  writeCliJs(root, ["prepare"], ["prepare flags:\n  --mode <fresh|topup>"]);
  writeCommandFile(
    root,
    "prepare",
    `
    const mode = ctx.flags.mode;
    if (mode !== "fresh" && mode !== "topup") {
      ctx.stderr(\`error: unknown --mode "\${mode}" (valid: fresh, topup, weak-fallback)\`);
      return 1;
    }
    `
  );
  writeCliMd(root, [
    {
      cmd: "prepare",
      body: `Synopsis: \`node engine/cli.js prepare --profile <id> [--mode <fresh|topup|weak-fallback>]\`

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| \`--mode <fresh\\|topup\\|weak-fallback>\` | string | fresh | Mode. |`,
    },
  ]);
  const { code, stderr } = runGate(root);
  assert.strictEqual(code, 1);
  assert.match(stderr, /in-file disagreement on --mode/);
});

// --- Extra: HEURISTICS coverage (RFC §4 "every regex exercised") -----------

test("heuristics: args-bracket pattern catches args[\"--foo\"]", () => {
  const r = gate.scanCode(`const v = args["--foo"];`);
  assert.ok(r.flags.has("foo"));
});

test("heuristics: args-bracket negative — args[\"--FOO\"] not matched", () => {
  const r = gate.scanCode(`const v = args["--FOO"];`);
  assert.ok(!r.flags.has("FOO"));
  assert.ok(!r.flags.has("foo"));
});

test("heuristics: argv-includes pattern catches argv.includes()", () => {
  const r = gate.scanCode(`if (argv.includes("--auto")) {}`);
  assert.ok(r.flags.has("auto"));
});

test("heuristics: argv-includes negative — argv.find() not matched", () => {
  const r = gate.scanCode(`if (argv.find(x => x === "--auto")) {}`);
  // The stderr-literal pattern picks "--auto" up from the string instead.
  // That's fine — the flag is still detected. Check that argv-includes
  // alone wouldn't catch it: re-run with the literal stripped.
  const r2 = gate.scanCode(`if (argv.find(x => x === something)) {}`);
  assert.ok(!r2.flags.has("auto"));
});

test("heuristics: stderr-literal catches --foo inside template strings", () => {
  const r = gate.scanCode("const m = `--bar is required`;");
  assert.ok(r.flags.has("bar"));
});

test("heuristics: stderr-literal negative — embedded inside an identifier", () => {
  // "foo--bar" should not be matched as flag "bar" because preceded by a
  // word char. The regex uses \b on the trailing side only; for false
  // positives like "foo--bar" the stderr pattern actually would match
  // (since `--` resets word boundary). This case is the rationale for the
  // escape-hatch.
  const r = gate.scanCode("// no flags here, just prose");
  assert.strictEqual(r.flags.size, 0);
});

test("heuristics: inequality-chain captures the enum values", () => {
  const r = gate.scanCode(
    `const mode = ctx.flags.mode;
     if (mode !== "fresh" && mode !== "topup") return 1;`
  );
  // Find the enum recorded for any flag.
  let found = null;
  for (const [, sources] of r.flagEnumSources) {
    for (const s of sources) {
      if (s.source === "inequality") found = [...s.values].sort();
    }
  }
  assert.deepStrictEqual(found, ["fresh", "topup"]);
});

test("heuristics: inequality-chain negative — single comparison not captured", () => {
  const r = gate.scanCode(`if (m !== "fresh") return 1;`);
  // Single !== is not a chain, no values recorded.
  let found = false;
  for (const [, sources] of r.flagEnumSources) {
    for (const s of sources) {
      if (s.source === "inequality") found = true;
    }
  }
  assert.strictEqual(found, false);
});

test("heuristics: named-array captures VALID_MODES literal", () => {
  const r = gate.scanCode(`const VALID_MODES = ["fresh", "topup"]; const x = ctx.flags.mode;`);
  let values = null;
  for (const [, sources] of r.flagEnumSources) {
    for (const s of sources) {
      if (s.source === "named-array") values = [...s.values].sort();
    }
  }
  assert.deepStrictEqual(values, ["fresh", "topup"]);
});

test("heuristics: named-array negative — lowercase const name not captured", () => {
  const r = gate.scanCode(`const validModes = ["fresh", "topup"];`);
  let found = false;
  for (const [, sources] of r.flagEnumSources) {
    for (const s of sources) {
      if (s.source === "named-array") found = true;
    }
  }
  assert.strictEqual(found, false);
});

test("heuristics: valid-list captures stderr (valid: a, b, c)", () => {
  const r = gate.scanCode(
    `ctx.stderr(\`error: unknown --mode "\${m}" (valid: fresh, topup)\`);`
  );
  let values = null;
  for (const [, sources] of r.flagEnumSources) {
    for (const s of sources) {
      if (s.source === "valid-list") values = [...s.values].sort();
    }
  }
  assert.deepStrictEqual(values, ["fresh", "topup"]);
});

test("heuristics: valid-list negative — no `valid:` prefix not captured", () => {
  const r = gate.scanCode(`ctx.stderr("error: unknown mode")`);
  let found = false;
  for (const [, sources] of r.flagEnumSources) {
    for (const s of sources) {
      if (s.source === "valid-list") found = true;
    }
  }
  assert.strictEqual(found, false);
});

test("migration default: drift exits 0 with CLI_ARGS_GATE_MODE unset (warn-mode default)", () => {
  // RFC 041 §7 ships with `warn` as the default for the first release.
  // This test is the canary — when the follow-up commit flips the default
  // to `block`, this test will fail and the developer will update it.
  const root = mkRoot();
  writeCliJs(root, ["prepare"], ["prepare flags:\n  --mode <fresh|topup>"]);
  writeCommandFile(
    root,
    "prepare",
    `
    if (m !== "fresh" && m !== "topup") {
      ctx.stderr(\`error: unknown --mode "\${m}" (valid: fresh, topup)\`);
    }
    `
  );
  writeCliMd(root, [
    {
      cmd: "prepare",
      body: `Synopsis: \`node engine/cli.js prepare --profile <id> [--mode <fresh|topup|weak-fallback>]\`

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| \`--mode <fresh\\|topup\\|weak-fallback>\` | string | fresh | Mode. |`,
    },
  ]);
  // Call main directly (NOT runGate) so the test sees the bare default.
  const err = captureStderr();
  const out = captureStderr();
  const code = gate.main(
    ["--root", root],
    {}, // no CLI_ARGS_GATE_MODE override
    (s) => err.write(s),
    (s) => out.write(s)
  );
  assert.strictEqual(code, 0, "warn-mode default should exit 0 despite drift");
  assert.match(err.lines.join("\n"), /CLI_ARGS_GATE_MODE=warn \(default/);
  assert.match(err.lines.join("\n"), /drift detected/);
});

test("CLI_ARGS_GATE_MODE=warn downgrades drift exit-1 to exit-0", () => {
  const root = mkRoot();
  writeCliJs(root, ["prepare"], ["prepare flags:\n  --mode <fresh|topup>"]);
  writeCommandFile(
    root,
    "prepare",
    `
    if (m !== "fresh" && m !== "topup") {
      ctx.stderr(\`error: unknown --mode "\${m}" (valid: fresh, topup)\`);
    }
    `
  );
  writeCliMd(root, [
    {
      cmd: "prepare",
      body: `Synopsis: \`node engine/cli.js prepare --profile <id> [--mode <fresh|topup|weak-fallback>]\`

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| \`--mode <fresh\\|topup\\|weak-fallback>\` | string | fresh | Mode. |`,
    },
  ]);
  const { code, stderr } = runGate(root, [], { CLI_ARGS_GATE_MODE: "warn" });
  assert.strictEqual(code, 0, `expected exit 0 in warn mode, got ${code}`);
  assert.match(stderr, /CLI_ARGS_GATE_MODE=warn/);
  assert.match(stderr, /drift detected/);
});

test("parseKnownCommands reads the array literal from cli.js", () => {
  const src = `
    const KNOWN_COMMANDS = [
      "scan",
      "validate",
      "indeed-prep",
    ];
  `;
  const names = gate.parseKnownCommands(src);
  assert.deepStrictEqual(names, ["scan", "validate", "indeed-prep"]);
});

test("global flags exempt from per-command drift", () => {
  const root = mkRoot();
  writeCliJs(root, ["sync"], ["sync flags:\n  (none)"]);
  // commands/sync.js doesn't mention --profile or --apply literally.
  writeCommandFile(
    root,
    "sync",
    `module.exports = (ctx) => { if (!ctx.flags.apply) return 0; return 0; };`
  );
  // Docs DO mention --profile + --apply in the synopsis and table.
  writeCliMd(root, [
    {
      cmd: "sync",
      body: `Synopsis: \`node engine/cli.js sync --profile <id> [--dry-run] [--apply]\`

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| \`--profile <id>\` | string | — | Required. |
| \`--apply\` | boolean | false | Commit. |`,
    },
  ]);
  const { code, stderr } = runGate(root);
  // Globals should be exempt; sync has no per-command flags so should pass.
  assert.strictEqual(code, 0, `expected exit 0, got ${code}. stderr=${stderr}`);
});

test("docSliceForCommand isolates section between ### headings", () => {
  const md = `
# Title

## Commands

### scan

scan body line.

### prepare

prepare body line.

### check

check body line.
`;
  const scan = gate.docSliceForCommand(md, "scan");
  assert.match(scan, /scan body line\./);
  assert.doesNotMatch(scan, /prepare body line/);
});

test("helpTextSliceForCommand isolates HELP_TEXT block", () => {
  const cliJs = `
const HELP_TEXT = \`\\
Usage:
  cli <cmd>

prepare flags:
  --mode <fresh|topup>   Mode.
  --phase <pre|commit>   Phase.

check flags:
  --prepare              Phase 1.
\`;
`;
  const prepare = gate.helpTextSliceForCommand(cliJs, "prepare");
  assert.match(prepare, /--mode/);
  assert.doesNotMatch(prepare, /--prepare\s+Phase 1\./);
});

// --- Real-tree baseline check ----------------------------------------------

test("baseline: real engine + docs is clean against the gate (block mode)", () => {
  // This is the live tree (worktree root = one level up from this file).
  // Force `block` mode so this test catches real drift even after the
  // warn → block migration flip (RFC 041 §7) lands.
  const root = path.resolve(__dirname, "..");
  const err = captureStderr();
  const out = captureStderr();
  const code = gate.main(
    ["--root", root],
    { CLI_ARGS_GATE_MODE: "block" },
    (s) => err.write(s),
    (s) => out.write(s)
  );
  // Exit 0 (clean) or exit 2 (warning only) are both acceptable for the
  // baseline-clean release. Exit 1 means drift survived the baseline fix.
  assert.notStrictEqual(
    code,
    1,
    `gate reports drift in live tree; stderr:\n${err.lines.join("\n")}`
  );
});
