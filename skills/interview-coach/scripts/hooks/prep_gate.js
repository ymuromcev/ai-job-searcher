// prep_gate.js — UserPromptSubmit hook for interview-coach.
//
// Detects that the conversation is about preparing for an exam-style interview
// round and injects the entry protocol as context, so the coach does not drift
// into free-form conversation. This is the failure that cost three days in the
// 2026-07-29 postmortem: fifty minutes guessing the format, the employer's scope
// document read on day two, `prep` never actually invoked.
//
// Honest limitation: UserPromptSubmit injects context, it does not block. The
// enforcement lives in the artifact (a round file with a filled curriculum table)
// and in `round_audit.js`. This hook only makes sure the protocol is in front of
// the model at the moment the topic comes up.
//
// Input : JSON on stdin — { prompt, cwd }
// Output: stdout = context added to the turn; exit 0 always.

const ROUND_MARKERS = [
  "интервью",
  "собес",
  "секци",
  "созвон с",
  "раунд",
  "interview",
  "screening",
  "round",
];

const EXAM_MARKERS = [
  "статистик",
  "матстат",
  "мат. стат",
  "a/b",
  "ab-тест",
  "аб-тест",
  "p-value",
  "p-значен",
  "выборк",
  "доверительн",
  "интервал",
  "гипотез",
  "критери",
  "sql",
  "метрик",
  "расчёт",
  "расчет",
  "формул",
  "unit-эконом",
  "юнит-эконом",
  "vintage",
  "roll rate",
  "кредитн риск",
];

// Non-triggers, for the record: resume edits, cover letters, offers, comp talk.
// They are NOT filtered explicitly — requiring a round marker AND an exam marker
// already excludes them, and an explicit suppression list would wrongly silence
// a real prompt that mentions both ("recruiter asked about comp, and there's a
// statistics section"). The AND is the trigger table.

function normalize(prompt) {
  return String(prompt || "").toLowerCase();
}

function hasAny(text, markers) {
  return markers.some((m) => text.includes(m));
}

/**
 * Should the exam-prep protocol be injected?
 * Requires a round marker AND an exam marker.
 */
function shouldRemind(prompt) {
  const text = normalize(prompt);
  if (!text) return false;
  return hasAny(text, ROUND_MARKERS) && hasAny(text, EXAM_MARKERS);
}

/** The injected context. `openRounds` is a list of { file, openDebts } summaries. */
function buildReminder(openRounds = []) {
  const lines = [
    "[prep-gate] Похоже на подготовку к расчётному раунду. Протокол входа (RFC 065):",
    "",
    "1. Не отвечай свободным текстом и не начинай объяснять. Сначала — файл раунда.",
    "2. Прочитай документ работодателя, если он есть. Он старше и твоего вывода, и ожиданий кандидата.",
    "3. Заведи `profiles/<id>/interview-coach-state/rounds/<дата>_<company>_exam.md` из шаблона `templates/round-exam.md`.",
    "4. Строки программы — дословно из документа. К каждой приколоти раздел учебника или пометь «мой синтез».",
    "5. Покажи кандидату заполненную таблицу ДО первого объяснения.",
    "6. Дальше по `references/commands/prep-exam.md`: цель-ответ → объяснение на прогонном датасете → вопрос числом → вердикт вслух → перевод статуса.",
    "",
    "Запрещено: «ты это знаешь», «контент закрыт», «100% пройдено», «забудь, зря приплёл». Готовность объявляет кандидат, не ты.",
  ];
  if (openRounds.length > 0) {
    lines.push("", "Открытые раунды:");
    for (const r of openRounds) {
      const debts = r.openDebts ? ` — открытых долгов: ${r.openDebts}` : "";
      lines.push(`  - ${r.file}${debts}`);
    }
  }
  return lines.join("\n");
}

module.exports = { ROUND_MARKERS, EXAM_MARKERS, shouldRemind, buildReminder, scanOpenRounds };

// --- IO --------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

/** Find `kind: exam` round files still in `status: prep` under `cwd`/profiles. */
function scanOpenRounds(cwd) {
  const out = [];
  try {
    const profilesDir = path.join(cwd, "profiles");
    if (!fs.existsSync(profilesDir)) return out;
    for (const profile of fs.readdirSync(profilesDir)) {
      const roundsDir = path.join(profilesDir, profile, "interview-coach-state", "rounds");
      if (!fs.existsSync(roundsDir)) continue;
      for (const file of fs.readdirSync(roundsDir)) {
        if (!/_exam\.md$/.test(file)) continue;
        const text = fs.readFileSync(path.join(roundsDir, file), "utf8");
        if (!/^status:\s*prep\b/m.test(text)) continue;
        const openDebts = (text.match(/^\|\s*D\d+\s*\|[^\n]*\|\s*(—|-|)\s*\|\s*$/gm) || []).length;
        out.push({
          file: path.join("profiles", profile, "interview-coach-state", "rounds", file),
          openDebts,
        });
      }
    }
  } catch {
    return out;
  }
  return out;
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
      const cwd = payload.cwd || process.cwd();
      const openRounds = scanOpenRounds(cwd);
      if (!shouldRemind(payload.prompt) && openRounds.length === 0) process.exit(0);
      if (!shouldRemind(payload.prompt) && openRounds.length > 0) {
        // An open exam round is itself a trigger, but keep that case quiet
        // unless the prompt at least mentions a round.
        if (!hasAny(normalize(payload.prompt), ROUND_MARKERS)) process.exit(0);
      }
      process.stdout.write(`${buildReminder(openRounds)}\n`);
      process.exit(0);
    } catch {
      process.exit(0);
    }
  });
}
