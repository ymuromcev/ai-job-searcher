// debrief_reminder.js — UserPromptSubmit hook for interview-coach (RFC 066).
//
// Before the next interview, surfaces the open loops from the last ones so a
// recurring mistake gets carried forward instead of re-made: active
// Cross-Dimension Root Causes, and any outcome still `pending` a reconciliation.
// This is the "напоминаю перед следующим, чтобы не повторил" half of the loop.
//
// Honest limitation: UserPromptSubmit injects context, it does not block. It
// only puts the open loops in front of the model when the next interview comes
// up. The enforcement lives in the artifact (the `## Outcome` block) and in
// `debrief_audit.js`. The hook stays silent unless the prompt is about an
// upcoming interview AND there is at least one open loop to carry — no round
// data, no reminder.
//
// Input : JSON on stdin — { prompt, cwd }
// Output: stdout = context added to the turn; exit 0 always.

const ROUND_MARKERS = [
  "интервью",
  "собес",
  "секци",
  "созвон с",
  "раунд",
  "скрининг",
  "interview",
  "screening",
  "round",
];

// Scheduling / preparation intent — the moment a reminder is useful.
const NEXT_MARKERS = [
  "следующ",
  "готов",
  "подготов",
  "назначил",
  "назначен",
  "запланир",
  "в пятниц",
  "во вторник",
  "в среду",
  "в четверг",
  "в понедельник",
  "завтра",
  "prep",
  "schedule",
  "upcoming",
  "next",
];

const ROOT_CAUSE_HEADING = "## Cross-Dimension Root Causes";
const OPEN_STATUSES = ["active", "improving", "watching"];

function normalize(prompt) {
  return String(prompt || "").toLowerCase();
}

function hasAny(text, markers) {
  return markers.some((m) => text.includes(m));
}

/**
 * Should the debrief loop be surfaced? Requires a round marker AND a
 * next/prep marker. The caller additionally suppresses it when no open loop
 * exists, so an interview mention with nothing to carry stays quiet.
 */
function shouldRemind(prompt) {
  const text = normalize(prompt);
  if (!text) return false;
  return hasAny(text, ROUND_MARKERS) && hasAny(text, NEXT_MARKERS);
}

/** The injected context. `loops` is { rootCauses: [...], pending: [...] }. */
function buildReminder(loops = { rootCauses: [], pending: [] }) {
  const rootCauses = loops.rootCauses || [];
  const pending = loops.pending || [];
  const lines = [
    "[debrief-loop] Перед следующим интервью — открытые петли с прошлых разборов (RFC 066).",
    "Это то, что уже ловили. Задача — не повторить, а не собрать заново.",
  ];
  if (rootCauses.length > 0) {
    lines.push("", "Активные корневые причины:");
    for (const rc of rootCauses) {
      const treat = rc.treatment ? ` → ${rc.treatment}` : "";
      lines.push(`  - ${rc.pattern} [${rc.status}]${treat}`);
    }
  }
  if (pending.length > 0) {
    lines.push("", "Исходы без сверки (закрой, когда придёт результат гейта):");
    for (const p of pending) lines.push(`  - ${p.title} — Predicted: ${p.predicted || "—"}`);
  }
  if (rootCauses.length === 0 && pending.length === 0) {
    lines.push("", "Открытых петель нет — с прошлого раза всё сведено.");
  }
  return lines.join("\n");
}

module.exports = {
  ROUND_MARKERS,
  NEXT_MARKERS,
  ROOT_CAUSE_HEADING,
  OPEN_STATUSES,
  shouldRemind,
  buildReminder,
  extractOpenLoops,
  scanOpenLoops,
};

// --- IO --------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

/** Parse open loops out of one coaching_state.md's text. Pure. */
function extractOpenLoops(stateText) {
  const rootCauses = [];
  const lines = String(stateText || "").split("\n");
  // The registry is an H3 `Cross-Dimension Root Causes (active)` with columns
  // | Root Cause | Affected Dimensions | First Detected | Status | Treatment |.
  // No id column; Status is the 4th cell. Match the heading at any level.
  const start = lines.findIndex(
    (l) => /^#{1,6}\s/.test(l.trim()) && /cross-dimension root causes/i.test(l)
  );
  if (start !== -1) {
    let seenHeader = false;
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (/^#{1,6}\s/.test(line)) break;
      if (!line.startsWith("|")) continue;
      const cells = line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue;
      if (!seenHeader) {
        seenHeader = true;
        continue;
      }
      const status = (cells[3] || "").toLowerCase();
      if (OPEN_STATUSES.includes(status)) {
        rootCauses.push({
          pattern: cells[0] || "",
          status,
          treatment: cells[4] || "",
        });
      }
    }
  }

  const pending = [];
  let current = null;
  const flush = () => {
    if (current && (current.result.split(/\s+/)[0] || "") === "pending")
      pending.push({ title: current.title, predicted: current.predicted });
  };
  for (const raw of lines) {
    // Anchored: matches `## Outcome` / `## Outcome: Title`, not `## Outcome Log`.
    const head = /^##\s+Outcome(?::\s*(.*))?\s*$/.exec(raw.trim());
    if (head) {
      flush();
      current = { title: (head[1] || "").trim(), result: "", predicted: "" };
      continue;
    }
    if (/^##\s/.test(raw.trim())) {
      flush();
      current = null;
      continue;
    }
    if (!current) continue;
    const r = /^\s*[-*]\s*Result:\s*(.*)$/i.exec(raw);
    if (r) current.result = r[1].trim().toLowerCase();
    const p = /^\s*[-*]\s*Predicted:\s*(.*)$/i.exec(raw);
    if (p) current.predicted = p[1].trim();
  }
  flush();

  return { rootCauses, pending };
}

/** Aggregate open loops across every profile under `cwd`/profiles. Fails open. */
function scanOpenLoops(cwd) {
  const merged = { rootCauses: [], pending: [] };
  try {
    const profilesDir = path.join(cwd, "profiles");
    if (!fs.existsSync(profilesDir)) return merged;
    for (const profile of fs.readdirSync(profilesDir)) {
      const state = path.join(profilesDir, profile, "interview-coach-state", "coaching_state.md");
      if (!fs.existsSync(state)) continue;
      const loops = extractOpenLoops(fs.readFileSync(state, "utf8"));
      merged.rootCauses.push(...loops.rootCauses);
      merged.pending.push(...loops.pending);
    }
  } catch {
    return merged;
  }
  return merged;
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
      if (!shouldRemind(payload.prompt)) process.exit(0);
      const loops = scanOpenLoops(payload.cwd || process.cwd());
      if (loops.rootCauses.length === 0 && loops.pending.length === 0) process.exit(0);
      process.stdout.write(`${buildReminder(loops)}\n`);
      process.exit(0);
    } catch {
      process.exit(0);
    }
  });
}
