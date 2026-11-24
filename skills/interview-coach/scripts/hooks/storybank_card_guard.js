// storybank_card_guard.js — PreToolUse hook for coaching_state.md (BL-249, BL-250).
//
// A story written into the storybank without a STAR card (Ситуация / Задача /
// Действие / Результат) or without the «подход, не STAR» mark is blocked, and
// so is a «Последние роли» block (`^say-roles`) with fewer than three roles.
// The generator cannot be trusted to remember this from a rule; the write is
// where it is enforced.
//
// The hook simulates the write on the file as it is on disk and audits only
// the stories (and the roles block) the write changes — editing S012 never
// trips on S044.
//
// Input : JSON on stdin — { tool_name, tool_input: { file_path, content? |
//         old_string/new_string | edits[] } }
// Output: exit 0 = allow; exit 2 + stderr = block.
//
// Fail-open: unreadable file, an Edit whose old_string is not found, a bad
// payload — all allow. The guard must never wedge unrelated work.

const TARGET = /interview-coach-state[/\\]coaching_state\.md$/;

/** The file text after the tool call, or null when it cannot be simulated. */
function simulate(toolName, toolInput, beforeText) {
  if (!toolInput) return null;
  if (toolName === "Write") {
    return typeof toolInput.content === "string" ? toolInput.content : null;
  }
  const edits =
    toolName === "MultiEdit" && Array.isArray(toolInput.edits)
      ? toolInput.edits
      : toolName === "Edit"
        ? [toolInput]
        : null;
  if (!edits) return null;
  let text = beforeText;
  for (const e of edits) {
    if (!e || typeof e.old_string !== "string" || typeof e.new_string !== "string") return null;
    if (!text.includes(e.old_string)) return null;
    text = e.replace_all
      ? text.split(e.old_string).join(e.new_string)
      : text.replace(e.old_string, () => e.new_string);
  }
  return text;
}

/** Pure decision. `beforeText` is the file on disk ("" when absent). */
function decide({ toolName, filePath, toolInput, beforeText = "" }) {
  const { auditChange } = require("../storybank_audit.js");
  if (!["Write", "Edit", "MultiEdit"].includes(String(toolName))) return { allow: true };
  if (!filePath || !TARGET.test(String(filePath))) return { allow: true };

  const after = simulate(String(toolName), toolInput, beforeText);
  if (after === null) return { allow: true };

  const findings = auditChange(beforeText, after);
  if (findings.length === 0) return { allow: true };

  return {
    allow: false,
    reason: [
      "[storybank-card-guard] Заблокирована запись в coaching_state.md: история без карточки STAR.",
      "",
      ...findings.map((f) => `- (${f.code}) ${f.message}`),
      "",
      "Что делать:",
      "  - над таблицей реплик история несёт карточку: **Ситуация:** / **Задача:** / **Действие:** / **Результат:** (цифра или наблюдаемое изменение);",
      "  - нет результата — строка `**Тип:** подход, не STAR — <почему>`: такая история идёт только в «если спросит», не в блок «Истории»;",
      "  - «Последние роли» (`^say-roles`) — три роли, три строки RU/EN каждая (кому подчинялся, почему ушёл, оценка N из 10);",
      "  - карточку и результат даёт кандидат, не Claude: нет факта — ⚠️ и вопрос ему, запись после его «да».",
    ].join("\n"),
  };
}

module.exports = { TARGET, simulate, decide };

if (require.main === module) {
  const fs = require("fs");
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
      let beforeText = "";
      if (filePath && TARGET.test(String(filePath)) && fs.existsSync(filePath)) {
        beforeText = fs.readFileSync(filePath, "utf8");
      }
      const verdict = decide({
        toolName: payload.tool_name,
        filePath,
        toolInput: payload.tool_input,
        beforeText,
      });
      if (verdict.allow) process.exit(0);
      process.stderr.write(`${verdict.reason}\n`);
      process.exit(2);
    } catch {
      process.exit(0);
    }
  });
}
