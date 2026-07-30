// prep_freeze_guard.js — PreToolUse hook for interview-coach round files.
//
// Two jobs, both of which the coach demonstrably cannot be trusted to do from
// memory (see RFC 065 and the 2026-07-29 prep postmortem):
//
//   1. Freeze. Four hours before the interview, writes to the round's files are
//      blocked. New material that close to the call is not preparation.
//   2. Cheat-sheet schema. A `Формула:` line without `Вытекает из:` is blocked —
//      a formula the candidate cannot re-derive collapses under a follow-up.
//
// Input : JSON on stdin — { tool_name, tool_input: { file_path, content?,
//         new_string? }, cwd }
// Output: exit 0 = allow (silent); exit 2 + stderr = block, message shown to
//         the model.
//
// Fail-open by design: no round file, no `datetime`, an unparseable payload or
// any internal error allows the write. The guard must never wedge unrelated work.

const FREEZE_HOURS = 4;
const WATCHED_DIR = /interview-coach-state[/\\]/;
const ROUND_FILE = /_(exam|manager|screening)\.md$/;
const SIDE_FILE_SUFFIX = /_(ШПАРГАЛКА|INCIDENTS|CHEATSHEET)\.md$/i;

/** Text that this tool call is adding to the file. */
function addedText(toolInput) {
  if (!toolInput) return "";
  if (typeof toolInput.content === "string") return toolInput.content;
  if (typeof toolInput.new_string === "string") return toolInput.new_string;
  if (Array.isArray(toolInput.edits)) {
    return toolInput.edits
      .map((e) => (e && typeof e.new_string === "string" ? e.new_string : ""))
      .join("\n");
  }
  return "";
}

/** Lines that declare a formula but not where it comes from. */
function schemaViolations(text) {
  return String(text || "")
    .split("\n")
    .filter((line) => /^\s*[-*]\s*Формула:/.test(line) && !line.includes("Вытекает из:"))
    .map((line) => line.trim());
}

/** `datetime:` out of a round file's frontmatter, in epoch ms, or NaN. */
function callTimeMs(roundText) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(String(roundText || ""));
  if (!fm) return NaN;
  const line = /^datetime:\s*(.*)$/m.exec(fm[1]);
  if (!line) return NaN;
  const value = line[1]
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^["'](.*)["']$/, "$1");
  return Date.parse(value);
}

/**
 * Pure decision. `roundText` is the governing round file's content ("" when
 * none was found). Returns { allow, reason }.
 */
function decide({ toolName, filePath, toolInput, roundText = "", nowMs = Date.now() }) {
  if (!["Write", "Edit", "MultiEdit"].includes(String(toolName))) {
    return { allow: true };
  }
  if (!filePath || !WATCHED_DIR.test(String(filePath))) {
    return { allow: true };
  }

  const violations = schemaViolations(addedText(toolInput));
  if (violations.length > 0) {
    return {
      allow: false,
      reason: [
        "[prep-freeze-guard] Заблокирована запись: нарушена схема записи шпаргалки.",
        "",
        "Строка «Формула:» без «Вытекает из:»:",
        ...violations.map((v) => `  ${v}`),
        "",
        "Формула, которую кандидат не может вывести заново, рассыпается на первом follow-up.",
        "Допиши «Вытекает из: …» и повтори запись.",
      ].join("\n"),
    };
  }

  const call = callTimeMs(roundText);
  if (Number.isNaN(call)) {
    return { allow: true };
  }
  const freezeStart = call - FREEZE_HOURS * 3600 * 1000;
  if (nowMs < freezeStart) {
    return { allow: true };
  }

  const hoursLeft = Math.max(0, (call - nowMs) / 3600000);
  return {
    allow: false,
    reason: [
      `[prep-freeze-guard] Заблокирована запись: стоп-линия T−${FREEZE_HOURS}h.`,
      "",
      `До звонка ${hoursLeft.toFixed(1)} ч. Новый материал так близко к звонку не учится — он только повышает нагрузку.`,
      "",
      "Что делать вместо записи:",
      "  - если это правда важно — завести строку долга в файле раунда и сказать об этом прямо;",
      "  - остаток времени — читать вслух то, что уже написано.",
      "",
      "Если стоп-линию нужно снять осознанно — правь `datetime` в файле раунда вручную, это решение кандидата, не коуча.",
    ].join("\n"),
  };
}

module.exports = { FREEZE_HOURS, addedText, schemaViolations, callTimeMs, decide, findRoundFile };

// --- IO --------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

/**
 * Locate the round file that governs `filePath`:
 *   1. the target itself, when it is a round file;
 *   2. `<base>_<kind>.md` next to a side file (cheat sheet, incidents);
 *   3. otherwise the round file in the same directory with the nearest
 *      upcoming `datetime`.
 * Returns an absolute path or null.
 */
function findRoundFile(
  filePath,
  readDir = fs.readdirSync,
  readFile = fs.readFileSync,
  exists = fs.existsSync
) {
  try {
    const abs = path.resolve(filePath);
    if (ROUND_FILE.test(abs)) return exists(abs) ? abs : null;

    const dir = path.dirname(abs);
    const base = path.basename(abs).replace(SIDE_FILE_SUFFIX, "").replace(/\.md$/, "");
    if (!exists(dir)) return null;

    const candidates = readDir(dir).filter((f) => ROUND_FILE.test(f));
    if (candidates.length === 0) return null;

    const sibling = candidates.find((f) => f.startsWith(base));
    if (sibling) return path.join(dir, sibling);

    let best = null;
    let bestCall = Infinity;
    for (const f of candidates) {
      const full = path.join(dir, f);
      const call = callTimeMs(readFile(full, "utf8"));
      if (!Number.isNaN(call) && call < bestCall) {
        bestCall = call;
        best = full;
      }
    }
    return best;
  } catch {
    return null;
  }
}

if (require.main === module) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    raw += chunk;
  });
  process.stdin.on("end", () => {
    try {
      if (!raw.trim()) process.exit(0);
      const payload = JSON.parse(raw);
      const filePath = payload.tool_input && payload.tool_input.file_path;
      const roundPath = filePath ? findRoundFile(filePath) : null;
      const roundText =
        roundPath && fs.existsSync(roundPath) ? fs.readFileSync(roundPath, "utf8") : "";
      const verdict = decide({
        toolName: payload.tool_name,
        filePath,
        toolInput: payload.tool_input,
        roundText,
      });
      if (verdict.allow) process.exit(0);
      process.stderr.write(`${verdict.reason}\n`);
      process.exit(2);
    } catch {
      // Any failure allows the write.
      process.exit(0);
    }
  });
}
