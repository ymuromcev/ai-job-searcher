// debrief_audit.js — detectors for the interview debrief loop (RFC 066).
//
// Pure functions over coaching-state text. No filesystem access below the CLI
// section, so every detector is testable from a string fixture. Sibling of
// round_audit.js (RFC 065): same shape, different side of the interview.
//
// The unit of analysis is the `## Outcome:` block written by `debrief` /
// `analyze` into profiles/<id>/interview-coach-state/coaching_state.md, plus
// the `## Cross-Dimension Root Causes` table those commands maintain.
//
// The four checks are the three holes LawnStarter exposed, plus registry
// hygiene so the reminder can carry a recurring mistake forward:
//   1. an outcome resolved without a LIVE/PAPER channel      → outcome-without-channel
//   2. a resolved outcome the prediction was never reconciled against
//                                                            → outcome-unreconciled
//   3. a loss under adverse conditions not quarantined from the skill baseline
//                                                            → condition-not-quarantined
//   4. a root-cause row with no carry-forward status         → root-cause-missing-status
//
// Usage:
//   node debrief_audit.js <coaching_state.md>
//   node debrief_audit.js <profiles-dir>       (audits every profile's state)
//
// Exit 0 = clean, 1 = findings, 2 = usage error.

const OUTCOME_HEADING = "## Outcome";
const ROOT_CAUSE_HEADING = "## Cross-Dimension Root Causes";

// A result that has not resolved yet. Everything else is a resolved gate.
const PENDING = "pending";

// Resolved-and-negative: a loss whose conditions must be reckoned with.
const NEGATIVE_RESULTS = ["rejected", "ghosted", "declined", "no-hire", "no hire"];

// Channel tokens. A resolved outcome must be attributed to at least one: what
// the interviewer heard live, or what reached the next gate on paper.
const CHANNEL_TOKENS = ["live", "paper"];

// Cells that mean "nothing here", shared with round_audit's vocabulary.
const EMPTY_CELLS = ["", "—", "-", "–", "н/д", "n/a", "tbd"];

// Conditions that read as a normal run — no quarantine owed.
const NORMAL_CONDITIONS = ["normal", "штатные", "обычные", "нормальные", "none"];

// The statuses a root-cause row may carry so the reminder hook can act on it.
const ROOT_CAUSE_STATUSES = ["active", "improving", "watching", "closed", "resolved"];

function norm(value) {
  return String(value == null ? "" : value)
    .trim()
    .toLowerCase();
}

function isEmptyCell(cell) {
  return EMPTY_CELLS.includes(norm(cell));
}

function finding(code, message) {
  return { code, message };
}

/**
 * Split into `## Outcome:` blocks. Each block is parsed from its `- Key: value`
 * bullet lines into a flat object keyed by the lowercased field name with
 * hyphens folded to underscores (`Root-cause` → `root_cause`). `title` holds
 * the heading text after `## Outcome:`.
 */
function parseOutcomeBlocks(text) {
  const lines = String(text || "").split("\n");
  const blocks = [];
  let current = null;
  for (const raw of lines) {
    // Anchored so `## Outcome` / `## Outcome: Title` match but `## Outcome Log`
    // (a real, unrelated section) does not.
    const head = /^##\s+Outcome(?::\s*(.*))?\s*$/.exec(raw.trim());
    if (head) {
      current = { title: (head[1] || "").trim(), fields: {} };
      blocks.push(current);
      continue;
    }
    if (/^##\s/.test(raw.trim())) {
      current = null; // a different H2 closes the block
      continue;
    }
    if (!current) continue;
    const bullet = /^\s*[-*]\s*([A-Za-zА-Яа-я][A-Za-zА-Яа-я0-9 _-]*?):\s*(.*)$/.exec(raw);
    if (!bullet) continue;
    const key = norm(bullet[1]).replace(/\s+/g, "_").replace(/-/g, "_");
    current.fields[key] = bullet[2].trim();
  }
  return blocks;
}

// The first whitespace-delimited token of Result, so a free-text tail like
// "pending — waiting on VP" or "rejected (after panel)" still classifies right.
function resultToken(block) {
  return norm(block.fields.result).split(/\s+/)[0] || "";
}

function isResolved(block) {
  const token = resultToken(block);
  return token !== "" && token !== PENDING;
}

function isNegative(block) {
  const full = norm(block.fields.result);
  const token = resultToken(block);
  return NEGATIVE_RESULTS.some((n) => n === token || full.startsWith(n));
}

function hasChannel(block) {
  const channel = norm(block.fields.channel);
  return CHANNEL_TOKENS.some((t) => channel.includes(t));
}

function conditionsAreAdverse(block) {
  const cond = norm(block.fields.conditions);
  if (isEmptyCell(cond)) return false;
  // Compare the first alphabetic word, so "normal." / "normal conditions" /
  // "штатные, но шум"'s leading token still reads as the normal set.
  const firstWord =
    cond
      .replace(/[^a-zа-я\s]/gi, " ")
      .trim()
      .split(/\s+/)[0] || "";
  return !NORMAL_CONDITIONS.includes(firstWord);
}

/**
 * Parse the Cross-Dimension Root Causes table into row objects. The real
 * registry (SKILL.md, calibration-engine.md) is an H3 under Calibration State,
 * titled `Cross-Dimension Root Causes (active)`, with columns:
 *   | Root Cause | Affected Dimensions | First Detected | Status | Treatment |
 * There is no id column; Status is the 4th cell.
 */
function parseRootCauses(text) {
  const lines = String(text || "").split("\n");
  const start = lines.findIndex(
    (l) => /^#{1,6}\s/.test(l.trim()) && /cross-dimension root causes/i.test(l)
  );
  if (start === -1) return [];
  const rows = [];
  let seenHeader = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (/^#{1,6}\s/.test(line)) break; // the next heading of any level ends the table
    if (!line.startsWith("|")) continue;
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue; // separator
    if (!seenHeader) {
      seenHeader = true;
      continue; // header row
    }
    rows.push({
      pattern: cells[0] || "",
      dims: cells[1] || "",
      firstDetected: cells[2] || "",
      status: cells[3] || "",
      treatment: cells[4] || "",
      cells,
    });
  }
  return rows;
}

// --- detectors -------------------------------------------------------------

/** 1. A resolved outcome with no LIVE/PAPER channel. */
function detectOutcomeWithoutChannel(stateText) {
  return parseOutcomeBlocks(stateText)
    .filter((b) => isResolved(b) && !hasChannel(b))
    .map((b) =>
      finding(
        "outcome-without-channel",
        `«${b.title}» — Result: ${b.fields.result || "?"}, но канал не проставлен. Где потеряли: на живом звонке (LIVE) или на бумаге до следующего гейта (PAPER)? Без канала фидбэк целит вслепую.`
      )
    );
}

/** 2. A resolved outcome the prediction was never reconciled against. */
function detectUnreconciledOutcome(stateText) {
  return parseOutcomeBlocks(stateText)
    .filter((b) => isResolved(b) && isEmptyCell(b.fields.reconciliation))
    .map((b) =>
      finding(
        "outcome-unreconciled",
        `«${b.title}» — исход разрешён (${b.fields.result}), но Reconciliation пуст. Сверь предсказание «${b.fields.predicted || "—"}» с фактом; промах = записанный калибровочный урок, не «ой, ошибся».`
      )
    );
}

/**
 * 3. A loss under adverse conditions that was not quarantined.
 *
 * A rejection while sleep-deprived / cold is condition-driven, not proof of a
 * skill regression. If it is not explicitly `Baseline: quarantined`, it silently
 * drags the skill trend down and the coach "fixes" something that isn't broken.
 */
function detectConditionNotQuarantined(stateText) {
  return parseOutcomeBlocks(stateText)
    .filter(
      (b) => isNegative(b) && conditionsAreAdverse(b) && norm(b.fields.baseline) !== "quarantined"
    )
    .map((b) =>
      finding(
        "condition-not-quarantined",
        `«${b.title}» — потеря при адверс-условиях («${b.fields.conditions}»), но Baseline не «quarantined». Реши явно: провал из-за условий (карантин, не тянет baseline вниз) или реально скилл.`
      )
    );
}

/** 4. A root-cause row with no carry-forward status the reminder can read. */
function detectRootCauseMissingStatus(stateText) {
  return parseRootCauses(stateText)
    .filter((row) => row.pattern !== "" && !ROOT_CAUSE_STATUSES.includes(norm(row.status)))
    .map((row) =>
      finding(
        "root-cause-missing-status",
        `корневая причина «${row.pattern}» — статус «${row.status || "пусто"}» не распознан (нужен active/improving/watching/closed/resolved). Без статуса напоминалка не вынесет её перед следующим интервью.`
      )
    );
}

/** Run every detector over the coaching-state text. */
function auditDebrief({ stateText }) {
  return [
    ...detectOutcomeWithoutChannel(stateText),
    ...detectUnreconciledOutcome(stateText),
    ...detectConditionNotQuarantined(stateText),
    ...detectRootCauseMissingStatus(stateText),
  ];
}

/** Human-readable report, matching round_audit's tone. */
function formatReport(findings, label = "состояние") {
  if (findings.length === 0) return `[debrief-audit] ${label}: чисто, находок нет.`;
  const lines = [`[debrief-audit] ${label}: ${findings.length} находок.`, ""];
  for (const f of findings) lines.push(`- (${f.code}) ${f.message}`);
  lines.push(
    "",
    "Луп закрыт, когда исход сверен, канал проставлен, условия разведены со скиллом, а урок вынесен в корневые причины."
  );
  return lines.join("\n");
}

module.exports = {
  OUTCOME_HEADING,
  ROOT_CAUSE_HEADING,
  PENDING,
  NEGATIVE_RESULTS,
  CHANNEL_TOKENS,
  parseOutcomeBlocks,
  parseRootCauses,
  isResolved,
  isNegative,
  hasChannel,
  conditionsAreAdverse,
  detectOutcomeWithoutChannel,
  detectUnreconciledOutcome,
  detectConditionNotQuarantined,
  detectRootCauseMissingStatus,
  auditDebrief,
  formatReport,
};

// --- CLI -------------------------------------------------------------------

if (require.main === module) {
  const fs = require("fs");
  const path = require("path");

  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write("usage: node debrief_audit.js <coaching_state.md|profiles-dir>\n");
    process.exit(2);
  }

  const target = path.resolve(args[0]);
  if (!fs.existsSync(target)) {
    process.stderr.write(`not found: ${target}\n`);
    process.exit(2);
  }

  const stateFiles = [];
  if (fs.statSync(target).isDirectory()) {
    for (const profile of fs.readdirSync(target)) {
      const state = path.join(target, profile, "interview-coach-state", "coaching_state.md");
      if (fs.existsSync(state)) stateFiles.push(state);
    }
  } else {
    stateFiles.push(target);
  }

  if (stateFiles.length === 0) {
    process.stdout.write(`[debrief-audit] в ${target} нет coaching_state.md.\n`);
    process.exit(0);
  }

  let total = 0;
  for (const file of stateFiles) {
    const stateText = fs.readFileSync(file, "utf8");
    const findings = auditDebrief({ stateText });
    total += findings.length;
    process.stdout.write(
      `${formatReport(findings, path.basename(path.dirname(path.dirname(file))) || file)}\n\n`
    );
  }
  process.exit(total === 0 ? 0 : 1);
}
