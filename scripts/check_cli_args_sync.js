#!/usr/bin/env node
/**
 * RFC 041 / BL-104 — CLI arg-enum / behaviour drift gate.
 *
 * Compares, per command, the set of flags + literal-enum values the code
 * actually references against the set of flags + enums documented in
 * `docs/reference/cli.md`. Catches the failure mode BL-80 leaked through
 * (removed enum value left in docs + stderr) that the existing BL-97 /
 * BL-98 gates do not.
 *
 * Scope:
 *   - Flag-presence drift per command (code-only flag, doc-only flag).
 *   - Literal-enum drift per flag (`--mode <fresh|topup>` etc.).
 *   - In-file disagreement between two code-side sources for the same enum.
 *
 * Out of scope (see RFC 041 §2):
 *   - Behaviour-level drift (a flag silently changes semantics).
 *   - JSDoc-driven generation of cli.md.
 *   - Cross-doc drift in spec.md / tsv-schema.md.
 *
 * Exit codes (RFC 041 §3.5):
 *   0 — pass, or no watched files staged.
 *   1 — drift detected. Block commit. Honors CLI_ARGS_GATE_MODE=warn to
 *       downgrade to exit 0 (with a noisy stderr banner) during the
 *       warn-only migration window.
 *   2 — heuristic warning only (could not auto-detect enum for some flag).
 *       Hook and CI treat exit 2 as success.
 *
 * Pre-commit scoping (RFC 041 §3.4): only runs when at least one staged file
 * is in the watched set (engine/cli.js, engine/commands/*.js excluding tests,
 * docs/reference/cli.md). Otherwise exits 0 immediately.
 *
 * Escape hatch: a line containing `// cli-args-gate-ignore` is skipped by
 * every code-side regex. Use it on intentionally dynamic constructions. The
 * gate prints the count of escape-hatched lines per command at the end so
 * the hatch does not silently grow.
 *
 * Test rig: pass `--root <path>` to point the gate at a fixture tree (see
 * scripts/check_cli_args_sync.test.js).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// --- Constants -------------------------------------------------------------

// Global flags — documented under every command's pipe-table but referenced
// from `engine/cli.js` itself (parsed by `parseArgs`, not by each command).
// These are exempt from "documented but not referenced" detection per command.
const GLOBAL_FLAGS = new Set([
  "profile",
  "dry-run",
  "apply",
  "verbose",
  "help",
]);

// Watched paths for pre-commit scoping. Globs are expanded against the
// staged-file list, not the working tree.
const WATCHED_GLOBS = [
  /^engine\/cli\.js$/,
  /^engine\/commands\/[^/]+\.js$/,
  /^docs\/reference\/cli\.md$/,
];

// A staged file matches the watched set when it satisfies a glob AND is not
// a test file.
function isWatchedPath(p) {
  if (/\.test\.js$/.test(p)) return false;
  return WATCHED_GLOBS.some((re) => re.test(p));
}

// HEURISTICS — code-side regex set. Each entry is `{name, re, note}`. The
// gate iterates them in order, first hit wins per line. A line containing
// `// cli-args-gate-ignore` is skipped entirely.
//
// All flag patterns capture the flag *name* (no leading `--`) in group 1.
const HEURISTICS = {
  flags: [
    {
      // `args["--mode"]` — object-style lookup against the parseArgs values.
      name: "args-bracket",
      re: /args\["--([a-z][a-z0-9-]*)"\]/g,
      note: "object-style flag access (args[\"--foo\"]).",
    },
    {
      // `argv.includes("--auto")` — positional flag check.
      name: "argv-includes",
      re: /argv\.includes\("--([a-z][a-z0-9-]*)"\)/g,
      note: "argv.includes(\"--foo\") positional flag presence.",
    },
    {
      // `--foo` appearing inside a string / template literal (stderr / help
      // text / error message). Matches both `"--foo"`-style and template
      // literal occurrences. Restricted to lowercase + dash flag-names to
      // avoid catching markdown headings.
      name: "stderr-literal",
      re: /--([a-z][a-z0-9-]+)\b/g,
      note: "literal --flag string in stderr / help text.",
    },
  ],
  enums: [
    {
      // Inequality chain: `if (m !== "a" && m !== "b")`. Detected by
      // counting two-or-more `name !== "value"` clauses joined by `&&` on
      // the same line; values walked out via extractInequalityValues().
      name: "inequality-chain",
      re: /(?:\b[a-zA-Z_$][\w$]*\s*!==\s*"[^"]+"(?:\s*&&\s*)?){2,}/g,
      note: "if (m !== \"a\" && m !== \"b\") enum guard.",
    },
    {
      // Named array literal: `const VALID_MODES = ["a", "b"]`.
      name: "named-array",
      re: /\b(?:const|let|var)\s+(VALID_[A-Z_]+|[A-Z][A-Z_]*_MODES|[A-Z][A-Z_]*_PHASES)\s*=\s*\[([^\]]+)\]/g,
      note: "named array literal (VALID_*, *_MODES, *_PHASES).",
    },
    {
      // Stderr message "valid: a, b, c". Captures the comma-separated tail.
      name: "valid-list",
      re: /\bvalid:\s+([a-z][a-z0-9_, -]+?)(?=[)"`\n.])/g,
      note: "stderr \"(valid: a, b, c)\" hint.",
    },
  ],
};

// Doc-side patterns.
//
// Synopsis line shapes accepted:
//   `Synopsis: \`node engine/cli.js <cmd> --profile <id> --phase <pre|commit> [--mode <fresh|topup>] [--dry-run]\``
//
// Flag token: `--<name>` or `[--<name> ...]`. Enum token: `<a|b|c>`
// immediately after a flag (with optional whitespace).
const DOC_PATTERNS = {
  flagInSynopsis: /(?:\[)?--([a-z][a-z0-9-]+)\b/g,
  enumAfterFlag: /--([a-z][a-z0-9-]+)\s+<([a-z][a-z0-9|_-]+?)>/g,
  // Pipe-table cell shaped like `` `--mode <fresh\|topup>` ``. The
  // pipe character in the enum is escaped as `\|` inside table cells.
  pipeCellFlag: /^\|\s*`--([a-z][a-z0-9-]+)(?:\s+<([^>]+)>)?`/,
};

// --- Filesystem helpers ----------------------------------------------------

function readFile(root, rel) {
  const full = path.join(root, rel);
  try {
    return fs.readFileSync(full, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function getStagedFiles(root) {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "--diff-filter=ACM"],
      { cwd: root, encoding: "utf8" }
    );
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    // Not a git repo, or git not available. Caller decides.
    return null;
  }
}

// --- Code-side parse -------------------------------------------------------

// Filter out lines matching the escape hatch.
function lineHasEscapeHatch(line) {
  return /\/\/\s*cli-args-gate-ignore\b/.test(line);
}

// Strip `//` line comments and `/* */` block comments before flag/enum
// regexes run. Comments are where prose mentions of other commands' flags
// live (e.g. `// see also: --no-sync` inside prepare.js); enforcing on them
// produces false-positive doc-only / code-only findings across commands.
//
// We deliberately keep block-comment internals as blanks (rather than
// dropping them) so line numbers used by nearestFlag stay aligned with
// the source.
function stripComments(source) {
  if (!source) return source;
  // Replace /* ... */ blocks (including multi-line) with same-length
  // whitespace, keeping newlines.
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " ")
  );
  // Strip `//` to end-of-line. BUT: only when `//` isn't inside a string.
  // Cheap proxy that's good enough for this codebase: walk char-by-char.
  out = out
    .split("\n")
    .map((line) => stripLineComment(line))
    .join("\n");
  return out;
}

// Remove cross-command references like `validate --dedup` or
// `\`check --apply\`` from the source before flag-detection runs. The
// pattern is: another known command name immediately preceding a `--flag`
// token (optionally inside a backtick code span). Without this, prepare.js
// telling the user to "run `validate --dedup` for details" would flag
// `--dedup` as an unknown prepare flag.
function stripCrossCommandRefs(source, otherCommands) {
  if (!source || !otherCommands || otherCommands.length === 0) return source;
  const escaped = otherCommands
    .map((c) => c.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"))
    .join("|");
  // Match `<cmd> --flag[ <enum>]` with optional `phase X` / `--apply`-style
  // trailing tokens. Replace with spaces to keep line indexes intact.
  const re = new RegExp(
    `\\b(${escaped})(?:\\s+--[a-z][a-z0-9-]*(?:\\s+(?:<[^>]+>|[a-z][a-z0-9-]*))*)+`,
    "g"
  );
  return source.replace(re, (m) => m.replace(/[^\n]/g, " "));
}

function stripLineComment(line) {
  let inSingle = false;
  let inDouble = false;
  let inBack = false;
  let escape = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (!inDouble && !inBack && c === "'") inSingle = !inSingle;
    else if (!inSingle && !inBack && c === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && c === "`") inBack = !inBack;
    else if (!inSingle && !inDouble && !inBack && c === "/" && line[i + 1] === "/") {
      // Found a real comment. Return everything before it.
      return line.slice(0, i);
    }
  }
  return line;
}

function extractInequalityValues(match) {
  return extractInequalityChain(match).values;
}

function extractInequalityChain(match) {
  // Re-walk the matched text to pull every "name !== value" pair. Only
  // return values when every clause references the same identifier — that's
  // what distinguishes a real enum guard from a coincidental sequence of
  // independent comparisons joined with `&&`.
  const text = match[0];
  const re = /\b([a-zA-Z_$][\w$]*)\s*!==\s*"([^"]+)"/g;
  const idents = [];
  const values = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    idents.push(m[1]);
    values.push(m[2]);
  }
  if (values.length < 2) return { values: [], identifier: null };
  const allSame = idents.every((id) => id === idents[0]);
  return {
    values: allSame ? values : [],
    identifier: allSame ? idents[0] : null,
  };
}

function extractNamedArrayValues(rawList) {
  // rawList is the body of the array literal, e.g. `"a", "b", "c"`.
  const values = [];
  const re = /"([^"]+)"|'([^']+)'/g;
  let m;
  while ((m = re.exec(rawList)) !== null) {
    values.push(m[1] || m[2]);
  }
  return values;
}

function extractValidListValues(rawList) {
  // rawList is the comma-separated tail of a `(valid: a, b, c)` hint.
  return rawList
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Pull the per-command slice out of cli.js HELP_TEXT. Returns:
//   - The `<cmd> flags:` block (per-command flag table), if present, and
//   - The `<cmd> ...` paragraph from the top-level Commands: list, if it
//     mentions a `--flag` literal (e.g. `Pass --no-sync to skip ...`).
// The two are concatenated with a blank line so scanCode treats them as
// one slice.
function helpTextSliceForCommand(cliJsContent, cmd) {
  if (!cliJsContent) return "";
  const helpStart = cliJsContent.indexOf("const HELP_TEXT = `");
  if (helpStart < 0) return "";
  const helpEnd = cliJsContent.indexOf("\n`;", helpStart);
  if (helpEnd < 0) return "";
  const help = cliJsContent.slice(helpStart, helpEnd);

  const parts = [];

  // `<cmd> flags:` heading and capture until the next heading.
  const flagsRe = new RegExp(
    `\\n${cmd} flags:\\n([\\s\\S]*?)(?=\\n[a-z][a-z0-9-]* flags:|$)`
  );
  const flagsMatch = help.match(flagsRe);
  if (flagsMatch) parts.push(flagsMatch[1]);

  // `<cmd>` paragraph from the Commands: list. A command line shape is:
  //   "^  <name> +<description>" (two-space indent + name + at least one
  //   space + description text). Continuation lines indent further (10+
  //   spaces). The next command line ends the paragraph.
  const cmdParaRe = new RegExp(
    `\\n  ${cmd}\\s+\\S([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*\\s+\\S|\\n\\n|$)`
  );
  const cmdParaMatch = help.match(cmdParaRe);
  if (cmdParaMatch) parts.push(cmdParaMatch[1]);

  return parts.join("\n\n");
}

// Scan one piece of source code for flags and enums.
// Returns { flags, flagEnumSources, hatchCount }.
//
// flagEnumSources is a Map<flag, Array<{source, values:Set<string>}>>: one
// entry per code-side enum source for that flag, so disagreement between
// e.g. an inequality chain and a `valid: …` stderr can be detected.
//
// `knownFlags` is an optional dictionary used to bias enum→flag association
// (e.g. `VALID_MODES` → flag `mode` even when the file never literally
// prints `--mode`).
function scanCode(source, knownFlags) {
  const flags = new Set();
  const flagEnumSources = new Map();
  let hatchCount = 0;

  if (!source) {
    return { flags, flagEnumSources, hatchCount };
  }

  const stripped = stripComments(source);
  const lines = stripped.split("\n");
  const rawLines = source.split("\n");

  // Pass 1: flags. Track the most recent flag-name seen per line.
  const lineFlags = new Array(lines.length).fill(null);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (lineHasEscapeHatch(rawLines[i] || line)) {
      hatchCount += 1;
      continue;
    }
    // Track the FIRST flag mentioned on the line — stderr messages usually
    // lead with the relevant flag (e.g. `error: unknown --mode "..."`), and
    // any later `--phase pre` reference is contextual, not the subject.
    let firstFlag = null;
    let firstFlagPos = Infinity;
    for (const h of HEURISTICS.flags) {
      h.re.lastIndex = 0;
      let m;
      while ((m = h.re.exec(line)) !== null) {
        const flag = m[1];
        flags.add(flag);
        if (m.index < firstFlagPos) {
          firstFlagPos = m.index;
          firstFlag = flag;
        }
      }
    }
    lineFlags[i] = firstFlag;
  }

  // Bidirectional proximity lookup with a window of ±3 lines. The
  // inequality-chain pattern often appears on the line BEFORE the stderr
  // template literal that mentions the flag; we need to look both ways.
  function nearestFlag(lineIdx) {
    const window = 3;
    for (let r = 0; r <= window; r++) {
      if (r === 0 && lineFlags[lineIdx]) return lineFlags[lineIdx];
      if (r > 0) {
        if (lineFlags[lineIdx + r]) return lineFlags[lineIdx + r];
        if (lineFlags[lineIdx - r]) return lineFlags[lineIdx - r];
      }
    }
    return null;
  }

  function record(flag, source, values) {
    if (!flag) return;
    if (!values || values.length === 0) return;
    if (!flagEnumSources.has(flag)) {
      flagEnumSources.set(flag, []);
    }
    flagEnumSources.get(flag).push({ source, values: new Set(values) });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (lineHasEscapeHatch(rawLines[i] || line)) continue;

    // inequality-chain. When no flag is in proximity, fall back to the
    // identifier name used in the chain — `if (mode !== "a" && mode !== "b")`
    // binds enum {a,b} to flag `mode` even when the file doesn't mention
    // `--mode` literally.
    {
      const re = HEURISTICS.enums[0].re;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const { values, identifier } = extractInequalityChain(m);
        let flag = nearestFlag(i);
        if (!flag && identifier) {
          const norm = identifier.replace(/_/g, "-").toLowerCase();
          const candidates = new Set([...flags, ...(knownFlags || [])]);
          if (candidates.has(norm)) flag = norm;
          // Last resort: if no PARSE_OPTIONS dictionary is available
          // (knownFlags empty AND no local flags detected), still bind by
          // identifier name. This is the standalone-scanCode case used in
          // direct unit tests; in production the dictionary is always
          // populated and the binding path above wins.
          else if (
            !flag &&
            flags.size === 0 &&
            (!knownFlags || knownFlags.size === 0) &&
            /^[a-z][a-z_-]*$/i.test(identifier)
          ) {
            flag = norm;
          }
        }
        record(flag, "inequality", values);
      }
    }
    // named-array — VALID_MODES, VALID_PHASES, etc.
    {
      const re = HEURISTICS.enums[1].re;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const values = extractNamedArrayValues(m[2]);
        const varName = m[1].toLowerCase();
        // First try named-binding; fall back to nearest flag in code.
        // If named-binding picks a flag that wasn't otherwise referenced
        // (the file uses VALID_MODES but never `--mode`), still trust the
        // binding — the variable name is itself a strong signal.
        const bestFlag =
          associateNameToFlag(varName, flags, knownFlags) || nearestFlag(i);
        if (bestFlag) record(bestFlag, "named-array", values);
      }
    }
    // valid-list — stderr `(valid: a, b, c)` hint.
    {
      const re = HEURISTICS.enums[2].re;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const values = extractValidListValues(m[1]);
        record(nearestFlag(i), "valid-list", values);
      }
    }
  }

  return { flags, flagEnumSources, hatchCount };
}

// Bind a const name like `VALID_MODES` / `PHASE_LIST` to a flag by stripping
// known prefixes / suffixes and matching against the candidate flag set.
// When no candidates are supplied, fall back to the stripped variable-name
// stem as the inferred flag (e.g. `VALID_MODES` → `mode`). The stripped
// stem is only returned if it looks like a plausible flag name.
function associateNameToFlag(varName, localFlags, knownFlags) {
  const candidates = new Set([
    ...(localFlags || []),
    ...(knownFlags || []),
  ]);
  const tokens = varName
    .replace(/^valid_/, "")
    .replace(/_modes?$/, "")
    .replace(/_phases?$/, "")
    .replace(/_list$/, "")
    .replace(/_set$/, "")
    .replace(/s$/, "");
  for (const f of candidates) {
    const norm = f.replace(/-/g, "_");
    if (varName.includes(norm) || tokens === norm || tokens === f) return f;
  }
  // Last-resort guess: detect `_modes`, `_phases` style suffixes and map to
  // the singular flag name.
  const suffixGuesses = [
    /^(?:valid_)?(modes?)$/,
    /^(?:valid_)?(phases?)$/,
    /^valid_([a-z][a-z_]*)$/,
  ];
  for (const re of suffixGuesses) {
    const m = varName.match(re);
    if (m) {
      const stem = m[1].replace(/s$/, "");
      if (/^[a-z][a-z_]*$/.test(stem)) {
        return stem.replace(/_/g, "-");
      }
    }
  }
  return null;
}

// Extract the option keys from PARSE_OPTIONS in cli.js. Used as a flag
// dictionary for enum→flag association (e.g. binding `VALID_MODES` to
// `mode` even when the surrounding file doesn't print `--mode` literally).
function parseOptionKeys(cliJsContent) {
  if (!cliJsContent) return new Set();
  const m = cliJsContent.match(/const PARSE_OPTIONS = \{[\s\S]*?options:\s*\{([\s\S]*?)\},\s*allowPositionals/);
  if (!m) return new Set();
  const body = m[1];
  const keys = new Set();
  const re = /"?([a-z][a-z0-9-]*)"?\s*:\s*\{\s*type:/g;
  let mm;
  while ((mm = re.exec(body)) !== null) {
    keys.add(mm[1]);
  }
  return keys;
}

// Combine per-command scan: scan cli.js HELP_TEXT slice + commands/<cmd>.js
// and merge the flag/enum sets. Enum-source disagreement within the same
// command is reported as drift.
function scanCommand(root, cmd) {
  const cliJsContent = readFile(root, "engine/cli.js");
  const cmdFile = readFile(root, `engine/commands/${cmd}.js`);
  // Some commands live under a non-standard filename (e.g. indeed-prep ->
  // indeed_prepare.js). Look it up from the COMMANDS dispatch block.
  const altCmdFile = cmdFile || readFile(root, `engine/commands/${resolveAltCommandFile(cliJsContent, cmd)}`);

  const helpSlice = helpTextSliceForCommand(cliJsContent, cmd);
  const knownFlags = parseOptionKeys(cliJsContent);
  const allCommands = parseKnownCommands(cliJsContent);
  const otherCommands = allCommands.filter((c) => c !== cmd);

  // Strip cross-command references like ``validate --dedup`` from the
  // per-command code: those references genuinely point to *another*
  // command's flag and should not count as the current command's flag.
  const helpSliceFiltered = stripCrossCommandRefs(helpSlice, otherCommands);
  const altCmdFileFiltered = stripCrossCommandRefs(altCmdFile, otherCommands);

  const fromHelp = scanCode(helpSliceFiltered, knownFlags);
  const fromCmd = scanCode(altCmdFileFiltered, knownFlags);

  const flags = new Set([...fromHelp.flags, ...fromCmd.flags]);
  const flagEnumSources = new Map();
  for (const [flag, list] of fromHelp.flagEnumSources) {
    flagEnumSources.set(flag, [...list]);
  }
  for (const [flag, list] of fromCmd.flagEnumSources) {
    if (!flagEnumSources.has(flag)) flagEnumSources.set(flag, []);
    flagEnumSources.get(flag).push(...list);
  }
  const hatchCount = fromHelp.hatchCount + fromCmd.hatchCount;

  return { flags, flagEnumSources, hatchCount };
}

// Find the file for a command name that doesn't match the convention. The
// dispatch block in cli.js is structured as `command: require("./commands/X.js")`.
function resolveAltCommandFile(cliJsContent, cmd) {
  if (!cliJsContent) return `${cmd}.js`;
  const re = new RegExp(`"?${cmd}"?\\s*:\\s*require\\("\\.\\/commands\\/([^"]+)"\\)`);
  const m = cliJsContent.match(re);
  return m ? m[1] : `${cmd}.js`;
}

// --- Doc-side parse --------------------------------------------------------

// Slice cli.md by `### <cmd>` heading. Returns the body text up to the next
// `### ` heading or `## ` heading or EOF.
function docSliceForCommand(cliMdContent, cmd) {
  if (!cliMdContent) return "";
  const headingRe = new RegExp(`\\n### ${cmd}\\b[\\s\\S]*?(?=\\n###\\s|\\n##\\s|$)`);
  const m = cliMdContent.match(headingRe);
  return m ? m[0] : "";
}

function scanDoc(slice) {
  const flags = new Set();
  const flagEnums = new Map(); // flag -> Set<string>

  if (!slice) return { flags, flagEnums };

  function recordEnum(flag, rawValues) {
    if (!flag || !rawValues) return;
    // rawValues may contain escaped pipes (`fresh\|topup`) from pipe-table
    // cells. Unescape, then split on `|`.
    const cleaned = rawValues.replace(/\\\|/g, "|");
    const parts = cleaned
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    // Reject obvious non-enum placeholders like `id`, `n`, `iso`, `path`,
    // `text`, `title`, `name` (single-token angle-bracket parameter names).
    if (parts.length < 2) {
      // Could still be a single-value enum (rare), but more often it's a
      // type placeholder. Skip.
      return;
    }
    if (!flagEnums.has(flag)) {
      flagEnums.set(flag, new Set());
    }
    for (const v of parts) flagEnums.get(flag).add(v);
  }

  // Parse synopsis line: the first paragraph after the heading that starts
  // with "Synopsis:". Take the entire backtick-wrapped command line.
  const synopsisMatch = slice.match(/Synopsis:\s*`([^`]+)`/);
  if (synopsisMatch) {
    const synopsis = synopsisMatch[1];
    // Flag tokens.
    {
      const re = new RegExp(DOC_PATTERNS.flagInSynopsis.source, "g");
      let m;
      while ((m = re.exec(synopsis)) !== null) {
        flags.add(m[1]);
      }
    }
    // Enum tokens — `--flag <a|b>` directly inside synopsis (no escaping).
    {
      const re = new RegExp(DOC_PATTERNS.enumAfterFlag.source, "g");
      let m;
      while ((m = re.exec(synopsis)) !== null) {
        recordEnum(m[1], m[2]);
      }
    }
  }

  // Parse pipe tables: lines starting with `| `--flag` |`. Enums in table
  // cells use escaped pipes (`<fresh\|topup>`). We only look at the FIRST
  // column to avoid scooping random `--flag` mentions out of description
  // prose.
  for (const line of slice.split("\n")) {
    const m = line.match(DOC_PATTERNS.pipeCellFlag);
    if (!m) continue;
    flags.add(m[1]);
    if (m[2]) recordEnum(m[1], m[2]);
  }

  return { flags, flagEnums };
}

// --- Drift detection -------------------------------------------------------

// Returns a list of finding objects:
//   { cmd, kind, ... }
// where kind is one of: flag-in-code-not-doc, flag-in-doc-not-code,
// enum-mismatch, in-file-disagreement.
function findDrift({ cmd, code, doc }) {
  const findings = [];

  // Flag presence.
  for (const flag of code.flags) {
    if (GLOBAL_FLAGS.has(flag)) continue;
    if (!doc.flags.has(flag)) {
      findings.push({ cmd, kind: "flag-in-code-not-doc", flag });
    }
  }
  for (const flag of doc.flags) {
    if (GLOBAL_FLAGS.has(flag)) continue;
    if (!code.flags.has(flag)) {
      findings.push({ cmd, kind: "flag-in-doc-not-code", flag });
    }
  }

  // Enum drift. For every flag where the code has any literal enum set
  // recorded, compare against doc.
  for (const [flag, sources] of code.flagEnumSources) {
    // Reconcile across sources for this flag.
    const sets = sources.map((s) => s.values);
    if (sets.length === 0) continue;
    // Use the union as the canonical "code says" set, but flag disagreement
    // if two recorded sets differ.
    const union = new Set();
    for (const s of sets) for (const v of s) union.add(v);
    // Drop singletons that look like dynamic placeholders (no others).
    // Conservative: only emit enum drift when the doc lists a literal set
    // for this flag too AND the union has at least 2 values OR matches a
    // doc enum with !=. The disagreement check is independent.

    // In-file disagreement.
    if (sets.length > 1) {
      const canonical = setToSorted(sets[0]);
      for (let i = 1; i < sets.length; i++) {
        if (setToSorted(sets[i]) !== canonical) {
          findings.push({
            cmd,
            kind: "in-file-disagreement",
            flag,
            sources: sources.map((s) => ({
              source: s.source,
              values: setToSorted(s.values).split(","),
            })),
          });
          break;
        }
      }
    }

    // Compare union to doc.
    const docSet = doc.flagEnums.get(flag);
    if (!docSet) continue;
    if (setToSorted(union) !== setToSorted(docSet)) {
      findings.push({
        cmd,
        kind: "enum-mismatch",
        flag,
        code: [...union].sort(),
        docs: [...docSet].sort(),
      });
    }
  }

  // Flag has a doc enum but no code enum captured — emit as a warning
  // (heuristic gave up). Skip global flags entirely.
  return findings;
}

function setToSorted(s) {
  return [...s].sort().join(",");
}

// Per-command warnings: flags documented with an enum but the code-side
// scan didn't pick up any literal enum. Goes to exit-code-2.
function findWarnings({ cmd, code, doc }) {
  const warnings = [];
  for (const [flag, docSet] of doc.flagEnums) {
    if (GLOBAL_FLAGS.has(flag)) continue;
    if (!code.flags.has(flag)) continue; // covered by flag-only drift
    if (code.flagEnumSources.has(flag)) continue; // covered by enum-mismatch
    if (docSet.size < 2) continue;
    warnings.push({ cmd, kind: "enum-not-detected", flag });
  }
  return warnings;
}

// --- Reporting -------------------------------------------------------------

function reportDrift(findings, stderr) {
  const byCmd = new Map();
  for (const f of findings) {
    if (!byCmd.has(f.cmd)) byCmd.set(f.cmd, []);
    byCmd.get(f.cmd).push(f);
  }

  stderr("[cli-args-sync] drift detected:");
  stderr("");
  const cmds = [...byCmd.keys()].sort();
  for (const cmd of cmds) {
    stderr(`  ${cmd}:`);
    const codeOnly = byCmd.get(cmd).filter((f) => f.kind === "flag-in-code-not-doc");
    const docOnly = byCmd.get(cmd).filter((f) => f.kind === "flag-in-doc-not-code");
    if (codeOnly.length || docOnly.length) {
      stderr("    flag mismatch:");
      for (const f of codeOnly) {
        stderr(`      - in code but not documented: --${f.flag}`);
      }
      for (const f of docOnly) {
        stderr(`      - documented but not in code: --${f.flag}`);
      }
    }
    const enumDrift = byCmd.get(cmd).filter((f) => f.kind === "enum-mismatch");
    for (const f of enumDrift) {
      stderr(`    enum mismatch on --${f.flag}:`);
      stderr(`      code:  [${f.code.join(", ")}]`);
      stderr(`      docs:  [${f.docs.join(", ")}]`);
    }
    const disagreements = byCmd.get(cmd).filter((f) => f.kind === "in-file-disagreement");
    for (const f of disagreements) {
      stderr(`    in-file disagreement on --${f.flag}:`);
      for (const s of f.sources) {
        stderr(`      ${s.source}: [${s.values.join(", ")}]`);
      }
    }
    stderr("");
  }
  stderr("  fix: update docs/reference/cli.md or the command file so both agree.");
  stderr("       bypass (discouraged) with `git commit --no-verify`.");
}

function reportWarnings(warnings, hatchCounts, stderr) {
  if (warnings.length === 0 && Object.keys(hatchCounts).length === 0) return;
  stderr("[cli-args-sync] could not auto-detect enum for some flags:");
  stderr("");
  const byCmd = new Map();
  for (const w of warnings) {
    if (!byCmd.has(w.cmd)) byCmd.set(w.cmd, []);
    byCmd.get(w.cmd).push(w);
  }
  for (const [cmd, list] of byCmd) {
    for (const w of list) {
      stderr(`  ${cmd}: --${w.flag} — too dynamic to extract literal set (skipped).`);
    }
  }
  if (warnings.length > 0) {
    stderr("");
    stderr("  resolve by adding an explicit `// cli-args-gate-ignore` on the");
    stderr("  line, or by rewriting the validation to a literal `===` chain.");
  }
  const hatchEntries = Object.entries(hatchCounts).filter(([, n]) => n > 0);
  if (hatchEntries.length > 0) {
    stderr("");
    stderr("[cli-args-sync] // cli-args-gate-ignore escape-hatch usage:");
    for (const [cmd, n] of hatchEntries) {
      stderr(`  ${cmd}: ${n} line(s) hatched`);
    }
  }
}

// --- KNOWN_COMMANDS extraction ---------------------------------------------

function parseKnownCommands(cliJsContent) {
  if (!cliJsContent) return [];
  const m = cliJsContent.match(/const KNOWN_COMMANDS = \[([\s\S]*?)\];/);
  if (!m) return [];
  const body = m[1];
  const names = [];
  const re = /"([a-z][a-z0-9_-]*)"/g;
  let mm;
  while ((mm = re.exec(body)) !== null) {
    names.push(mm[1]);
  }
  return names;
}

// --- Main ------------------------------------------------------------------

function parseArgv(argv) {
  const out = { root: process.cwd(), preCommit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      out.root = argv[++i];
    } else if (a === "--pre-commit") {
      out.preCommit = true;
    } else if (a === "-h" || a === "--help") {
      out.help = true;
    }
  }
  return out;
}

function main(argv, env, stderrFn, stdoutFn) {
  const stderr = stderrFn || ((s) => process.stderr.write(s + "\n"));
  const stdout = stdoutFn || ((s) => process.stdout.write(s + "\n"));
  const opts = parseArgv(argv);
  if (opts.help) {
    stdout("usage: node scripts/check_cli_args_sync.js [--root <path>] [--pre-commit]");
    return 0;
  }

  const root = path.resolve(opts.root);

  // Pre-commit scoping: when invoked from the hook, only run if a watched
  // file is staged. From CI, scan the whole tree (no staged file list).
  if (opts.preCommit) {
    const staged = getStagedFiles(root);
    if (staged === null) {
      // git not available; treat as full-tree scan.
    } else {
      const watched = staged.filter(isWatchedPath);
      if (watched.length === 0) {
        return 0;
      }
    }
  }

  const cliJsContent = readFile(root, "engine/cli.js");
  const cliMdContent = readFile(root, "docs/reference/cli.md");
  if (!cliJsContent) {
    stderr(`[cli-args-sync] error: engine/cli.js not found under ${root}`);
    return 1;
  }
  if (!cliMdContent) {
    stderr(`[cli-args-sync] error: docs/reference/cli.md not found under ${root}`);
    return 1;
  }

  const commands = parseKnownCommands(cliJsContent);
  if (commands.length === 0) {
    stderr("[cli-args-sync] error: could not parse KNOWN_COMMANDS from engine/cli.js");
    return 1;
  }

  const allFindings = [];
  const allWarnings = [];
  const hatchCounts = {};

  for (const cmd of commands) {
    const code = scanCommand(root, cmd);
    const doc = scanDoc(docSliceForCommand(cliMdContent, cmd));
    const findings = findDrift({ cmd, code, doc });
    const warnings = findWarnings({ cmd, code, doc });
    allFindings.push(...findings);
    allWarnings.push(...warnings);
    if (code.hatchCount > 0) hatchCounts[cmd] = code.hatchCount;
  }

  if (allFindings.length > 0) {
    reportDrift(allFindings, stderr);
    // Default is `block` per RFC 041 §7 (flipped 2026-05-19, BL-104 close).
    // Override with `CLI_ARGS_GATE_MODE=warn` to downgrade drift exit-1 to
    // exit-0 (the prior warn-mode behaviour, kept as an escape valve).
    const mode = (env && env.CLI_ARGS_GATE_MODE) || "block";
    if (mode === "warn") {
      stderr("");
      stderr("[cli-args-sync] CLI_ARGS_GATE_MODE=warn override — exiting 0 despite");
      stderr("                drift. Default is `block`; clear this override once");
      stderr("                the drift is reconciled.");
      return 0;
    }
    return 1;
  }

  if (allWarnings.length > 0) {
    reportWarnings(allWarnings, hatchCounts, stderr);
    return 2;
  }

  // Escape-hatch counts are reported (so the hatch doesn't grow silently)
  // but don't downgrade the exit code — using the hatch is intentional.
  if (Object.keys(hatchCounts).length > 0) {
    reportWarnings([], hatchCounts, stderr);
  }

  return 0;
}

module.exports = {
  main,
  // Exposed for tests.
  scanCode,
  scanDoc,
  docSliceForCommand,
  helpTextSliceForCommand,
  findDrift,
  findWarnings,
  parseKnownCommands,
  parseOptionKeys,
  isWatchedPath,
  stripComments,
  HEURISTICS,
  DOC_PATTERNS,
  GLOBAL_FLAGS,
};

if (require.main === module) {
  const code = main(process.argv.slice(2), process.env);
  process.exit(code);
}
