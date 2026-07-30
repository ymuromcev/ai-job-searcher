// round_audit.js — detectors for interview-coach round files.
//
// Pure functions over file text. No filesystem access below the CLI section,
// so every detector is testable from a string fixture.
//
// A "round file" is profiles/<id>/interview-coach-state/rounds/<date>_<company>_<kind>.md
// A "cheat sheet" is the sibling file <same-base>_ШПАРГАЛКА.md
//
// Usage:
//   node round_audit.js <round-file> [cheat-sheet-file]
//   node round_audit.js <rounds-dir>
//
// Exit 0 = clean, 1 = findings, 2 = usage error.

const FREEZE_HOURS = 4;

// Markers are structural (headings and table column names), never prose, so a
// template that merely *mentions* a forbidden section does not trip a detector.
const FORBIDDEN_MARKERS = {
  exam: ["Компания за 60 секунд", "Карта соответствия", "Твоё позиционирование"],
  screening: ["## Программа", "Источник (раздел)"],
  manager: ["## Программа", "Источник (раздел)"],
};

const DONE_STATUS = "отработан вслух";
const EMPTY_CELLS = ["", "—", "-", "–", "н/д", "tbd"];

function isEmptyCell(cell) {
  return EMPTY_CELLS.includes(
    String(cell || "")
      .trim()
      .toLowerCase()
  );
}

/** Parse the leading `---` frontmatter block. Returns {} when absent. */
function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text || "");
  if (!match) return {};
  const out = {};
  let listKey = null;
  for (const raw of match[1].split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      out[listKey].push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value.trim() === "") {
      listKey = key;
      out[key] = [];
    } else {
      listKey = null;
      out[key] = unquote(value);
    }
  }
  return out;
}

function unquote(value) {
  return String(value)
    .trim()
    .replace(/^["'](.*)["']$/, "$1")
    .trim();
}

/**
 * Parse the first markdown table that appears after `heading`.
 * Returns an array of cell arrays, separator and header rows dropped.
 */
function parseTableAfter(text, heading) {
  const lines = String(text || "").split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith(heading));
  if (start === -1) return [];
  const rows = [];
  let seenHeader = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith("#")) break;
    if (!line.startsWith("|")) {
      if (rows.length || seenHeader) continue;
      continue;
    }
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (!seenHeader) {
      seenHeader = true;
      continue;
    }
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue;
    rows.push(cells);
  }
  return rows;
}

/** Curriculum rows: [#, тема, источник, прогонный кейс, статус]. */
function parseCurriculum(roundText) {
  return parseTableAfter(roundText, "## Программа")
    .map((cells) => ({
      num: cells[0] || "",
      topic: cells[1] || "",
      source: cells[2] || "",
      dataset: cells[3] || "",
      status: (cells[4] || "").toLowerCase(),
    }))
    .filter((row) => row.topic !== "" || row.num !== "");
}

/** Debt rows: [id, дата, долг, почему, закрыт]. */
function parseDebts(roundText) {
  return parseTableAfter(roundText, "## Долги")
    .map((cells) => ({
      id: (cells[0] || "").trim(),
      date: cells[1] || "",
      debt: cells[2] || "",
      why: cells[3] || "",
      closed: cells[4] || "",
    }))
    .filter((row) => row.id !== "" || row.debt !== "");
}

/** Cheat-sheet sections split on `## ` headings. */
function parseCheatsheetSections(cheatsheetText) {
  const parts = String(cheatsheetText || "").split(/^## /m);
  return parts
    .slice(1)
    .map((chunk) => {
      const nl = chunk.indexOf("\n");
      const heading = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
      const body = nl === -1 ? "" : chunk.slice(nl + 1);
      const num = /^(\d+)\./.exec(heading);
      return { heading, body, topicNum: num ? num[1] : null };
    })
    .filter((s) => s.heading !== "");
}

function finding(code, message) {
  return { code, message };
}

// --- detectors -------------------------------------------------------------

/** 1. A taught-able topic with no pinned source. */
function detectMissingSource(roundText) {
  return parseCurriculum(roundText)
    .filter((row) => row.topic !== "" && isEmptyCell(row.source))
    .map((row) =>
      finding(
        "missing-source",
        `строка ${row.num || "?"} «${row.topic}» — пустая ячейка «Источник». Тема не подкреплена: приколоти раздел учебника или напиши «мой синтез».`
      )
    );
}

/** 2. Readiness claimed while rows are unfinished. */
function detectUnstartedWhenReady(roundText) {
  const fm = parseFrontmatter(roundText);
  if (String(fm.status || "").trim() !== "ready") return [];
  return parseCurriculum(roundText)
    .filter((row) => row.topic !== "" && row.status !== DONE_STATUS)
    .map((row) =>
      finding(
        "unstarted-when-ready",
        `status: ready, но строка ${row.num || "?"} «${row.topic}» в статусе «${row.status || "пусто"}». Готовность — дробь по таблице, не оценка на глаз.`
      )
    );
}

/** 3. Debts still open. */
function detectOpenDebts(roundText) {
  return parseDebts(roundText)
    .filter((row) => row.debt !== "" && isEmptyCell(row.closed))
    .map((row) =>
      finding(
        "open-debt",
        `долг ${row.id || "?"} «${row.debt}» не закрыт (дата + «проговорено вслух»).`
      )
    );
}

/** 4. A gap in debt ids means a row was deleted. */
function detectDebtIdGap(roundText) {
  const ids = parseDebts(roundText)
    .map((row) => /^D(\d+)$/i.exec(row.id))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  if (ids.length === 0) return [];
  const max = Math.max(...ids);
  const present = new Set(ids);
  const missing = [];
  for (let i = 1; i <= max; i += 1) if (!present.has(i)) missing.push(`D${i}`);
  if (missing.length === 0) return [];
  return [
    finding(
      "debt-id-gap",
      `пропуск в нумерации долгов: ${missing.join(", ")}. Строку долга удалять нельзя — ей проставляется «Закрыт».`
    ),
  ];
}

/** 5. A formula the candidate cannot re-derive. */
function detectFormulaWithoutDerivation(cheatsheetText) {
  const out = [];
  String(cheatsheetText || "")
    .split("\n")
    .forEach((line, idx) => {
      if (!/^\s*[-*]\s*Формула:/.test(line)) return;
      if (line.includes("Вытекает из:")) return;
      out.push(
        finding(
          "formula-without-derivation",
          `шпаргалка, строка ${idx + 1}: «Формула:» без «Вытекает из:».`
        )
      );
    });
  return out;
}

/** 6. A cheat-sheet entry with no ready spoken line. */
function detectSpokenLineMissing(cheatsheetText) {
  return parseCheatsheetSections(cheatsheetText)
    .filter((s) => /Определение:/.test(s.body) && !/Если спросят:/.test(s.body))
    .map((s) =>
      finding("spoken-line-missing", `шпаргалка «${s.heading}» — нет строки «🗣️ Если спросят:».`)
    );
}

/** 7. A curriculum topic with no cheat-sheet entry (tied by leading number). */
function detectTopicNotInCheatsheet(roundText, cheatsheetText) {
  const covered = new Set(
    parseCheatsheetSections(cheatsheetText)
      .map((s) => s.topicNum)
      .filter(Boolean)
  );
  return parseCurriculum(roundText)
    .filter((row) => row.topic !== "" && row.num !== "" && !covered.has(String(row.num).trim()))
    .map((row) =>
      finding(
        "topic-not-in-cheatsheet",
        `строка ${row.num} «${row.topic}» не покрыта ни одной записью шпаргалки (нужен раздел «## ${row.num}.N …»).`
      )
    );
}

/** 8. A section that this kind of round is not allowed to contain. */
function detectForbiddenSection(roundText) {
  const fm = parseFrontmatter(roundText);
  const kind = String(fm.kind || "").trim();
  const markers = FORBIDDEN_MARKERS[kind];
  if (!markers) return [];
  return markers
    .filter((marker) => roundText.includes(marker))
    .map((marker) =>
      finding("forbidden-section", `kind: ${kind} — секция «${marker}» запрещена в этом флоу.`)
    );
}

/** 9. The file was written inside the freeze window. */
function detectWriteAfterFreeze(roundText, mtimeMs) {
  const fm = parseFrontmatter(roundText);
  const when = Date.parse(fm.datetime || "");
  if (Number.isNaN(when) || !mtimeMs) return [];
  const freezeStart = when - FREEZE_HOURS * 3600 * 1000;
  if (mtimeMs <= freezeStart) return [];
  return [
    finding(
      "write-after-freeze",
      `файл изменён внутри стоп-линии T−${FREEZE_HOURS}h (звонок ${fm.datetime}). Новый материал так близко к звонку не учится.`
    ),
  ];
}

/** Run every detector. `cheatsheetText` and `mtimeMs` are optional. */
function auditRound({ roundText, cheatsheetText = "", mtimeMs = 0 }) {
  return [
    ...detectMissingSource(roundText),
    ...detectUnstartedWhenReady(roundText),
    ...detectOpenDebts(roundText),
    ...detectDebtIdGap(roundText),
    ...detectFormulaWithoutDerivation(cheatsheetText),
    ...detectSpokenLineMissing(cheatsheetText),
    ...detectTopicNotInCheatsheet(roundText, cheatsheetText),
    ...detectForbiddenSection(roundText),
    ...detectWriteAfterFreeze(roundText, mtimeMs),
  ];
}

/** Human-readable report. */
function formatReport(findings, label = "раунд") {
  if (findings.length === 0) return `[round-audit] ${label}: чисто, находок нет.`;
  const lines = [`[round-audit] ${label}: ${findings.length} находок.`, ""];
  for (const f of findings) lines.push(`- (${f.code}) ${f.message}`);
  lines.push(
    "",
    "Готовность объявляет кандидат. Пока список не пуст — слова «готов» и «100%» не произносим."
  );
  return lines.join("\n");
}

module.exports = {
  FREEZE_HOURS,
  parseFrontmatter,
  parseTableAfter,
  parseCurriculum,
  parseDebts,
  parseCheatsheetSections,
  detectMissingSource,
  detectUnstartedWhenReady,
  detectOpenDebts,
  detectDebtIdGap,
  detectFormulaWithoutDerivation,
  detectSpokenLineMissing,
  detectTopicNotInCheatsheet,
  detectForbiddenSection,
  detectWriteAfterFreeze,
  auditRound,
  formatReport,
};

// --- CLI -------------------------------------------------------------------

if (require.main === module) {
  const fs = require("fs");
  const path = require("path");

  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write("usage: node round_audit.js <round-file|rounds-dir> [cheat-sheet-file]\n");
    process.exit(2);
  }

  const target = path.resolve(args[0]);
  if (!fs.existsSync(target)) {
    process.stderr.write(`not found: ${target}\n`);
    process.exit(2);
  }

  const roundFiles = fs.statSync(target).isDirectory()
    ? fs
        .readdirSync(target)
        .filter((f) => /_(exam|manager|screening)\.md$/.test(f))
        .map((f) => path.join(target, f))
    : [target];

  if (roundFiles.length === 0) {
    process.stdout.write(`[round-audit] в ${target} нет файлов раунда.\n`);
    process.exit(0);
  }

  let total = 0;
  for (const file of roundFiles) {
    const roundText = fs.readFileSync(file, "utf8");
    const explicit = args[1] ? path.resolve(args[1]) : null;
    const sibling = file.replace(/\.md$/, "_ШПАРГАЛКА.md");
    const sheet = explicit || (fs.existsSync(sibling) ? sibling : null);
    const cheatsheetText = sheet && fs.existsSync(sheet) ? fs.readFileSync(sheet, "utf8") : "";
    const findings = auditRound({
      roundText,
      cheatsheetText,
      mtimeMs: fs.statSync(file).mtimeMs,
    });
    total += findings.length;
    process.stdout.write(`${formatReport(findings, path.basename(file))}\n\n`);
  }
  process.exit(total === 0 ? 0 : 1);
}
