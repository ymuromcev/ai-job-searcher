// storybank_audit.js — structure checks for stories in coaching_state.md.
//
// Pure functions over file text (BL-249, BL-250). Two jobs:
//
//   1. Every story from S040 on carries a STAR card — Ситуация / Задача /
//      Действие / Результат — above its say-aloud table. A story with no
//      observable result is not a STAR story; it is marked
//      `**Тип:** подход, не STAR` and may only be used as an "if asked"
//      answer, never in the «Истории» block of a konspekt.
//   2. The «Последние роли» block (`^say-roles`) holds three roles, three
//      RU/EN rows each: whom you reported to, why you left, the 1–10 score.
//
// Stories S001–S039 predate the card and are grandfathered: they are not
// required to have one, but a card, when present, must be complete.
//
// Usage:  node storybank_audit.js <coaching_state.md>
// Exit 0 = clean, 1 = findings, 2 = usage error.

const CARD_REQUIRED_FROM = 40;
const CARD_FIELDS = ["Ситуация", "Задача", "Действие", "Результат"];
const APPROACH_MARKER = /^\s*(?:[-*]\s*)?\*\*Тип:\*\*\s*подход,\s*не\s*STAR/im;
const ROLES_ANCHOR = "^say-roles";
const ROLES_REQUIRED = 3;
const ROLE_ROWS_REQUIRED = 3;

function finding(code, message, id = "") {
  return { code, message, id };
}

/** `#### S044 — title` blocks. Text runs to the next `####` / `##` heading. */
function parseStories(text) {
  const lines = String(text || "").split("\n");
  const stories = [];
  let current = null;
  for (const line of lines) {
    const head = /^####\s+(S\d+[a-z]?)\b\s*[—–-]?\s*(.*)$/.exec(line);
    if (head) {
      current = { id: head[1], title: head[2].trim(), lines: [line] };
      stories.push(current);
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      current = null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  return stories.map((s) => ({ id: s.id, title: s.title, body: s.lines.join("\n") }));
}

function storyNum(id) {
  return Number(String(id).replace(/\D/g, ""));
}

/** Card fields of one story body: { Ситуация: "…", … } (missing keys absent). */
function parseCard(body) {
  const card = {};
  for (const raw of String(body || "").split("\n")) {
    const m = /^\s*(?:[-*]\s*)?\*\*(Ситуация|Задача|Действие|Результат):\*\*\s*(.*)$/.exec(raw);
    if (m) card[m[1]] = m[2].trim();
  }
  return card;
}

function isApproach(body) {
  return APPROACH_MARKER.test(String(body || ""));
}

/** A result that names nothing: empty, a ⚠️ gap, or an explicit «нет». */
function resultIsMissing(value) {
  const v = String(value || "").trim();
  if (v === "") return true;
  if (v.includes("⚠️")) return true;
  // A bare «нет» / dash / «не записан» is a gap; «Нет жалоб, NPS +12» is a result.
  if (/^(нет|не записан|не указан|—|-|–|tbd|н\/д)[\s.,;:!]*$/i.test(v)) return true;
  return /^(нет|не записан|не указан)(\s|[.,;:])/i.test(v) && !/\d/.test(v);
}

/** Findings for one story block. */
function auditStory(story) {
  const out = [];
  const num = storyNum(story.id);
  const card = parseCard(story.body);
  const hasAnyField = Object.keys(card).length > 0;
  const approach = isApproach(story.body);
  const anchor = story.body.search(/\^say-s\d+/);

  if (approach) {
    const marker = story.body.search(APPROACH_MARKER);
    if (anchor !== -1 && marker > anchor) {
      out.push(
        finding(
          "card-after-anchor",
          `${story.id}: пометка «подход, не STAR» стоит под таблицей реплик. Карточка и пометка идут над say-aloud таблицей.`,
          story.id
        )
      );
    }
    return out;
  }

  if (!hasAnyField) {
    if (num >= CARD_REQUIRED_FROM) {
      out.push(
        finding(
          "no-card",
          `${story.id}: нет карточки STAR (Ситуация / Задача / Действие / Результат) и нет пометки «Тип: подход, не STAR». История без карточки — описание «как устроено», не история.`,
          story.id
        )
      );
    }
    return out;
  }

  const missing = CARD_FIELDS.filter((f) => !card[f]);
  if (missing.length > 0) {
    out.push(
      finding(
        "card-incomplete",
        `${story.id}: в карточке не хватает полей: ${missing.join(", ")}.`,
        story.id
      )
    );
  } else if (resultIsMissing(card["Результат"])) {
    out.push(
      finding(
        "no-result",
        `${story.id}: у «Результата» нет цифры или наблюдаемого изменения. Либо кандидат называет результат, либо история помечается «Тип: подход, не STAR» и уходит только в «если спросит».`,
        story.id
      )
    );
  }

  const firstField = story.body.search(/\*\*(Ситуация|Задача|Действие|Результат):\*\*/);
  if (anchor !== -1 && firstField > anchor) {
    out.push(
      finding(
        "card-after-anchor",
        `${story.id}: карточка стоит под таблицей реплик, а должна быть над ней.`,
        story.id
      )
    );
  }
  return out;
}

/** IDs (lower-case) of stories marked «подход, не STAR». */
function approachStoryIds(text) {
  return parseStories(text)
    .filter((s) => isApproach(s.body))
    .map((s) => s.id.toLowerCase());
}

// --- «Последние роли» ------------------------------------------------------

/** Text of the roles block: from its heading to the `^say-roles` anchor. */
function extractRolesBlock(text) {
  const lines = String(text || "").split("\n");
  const anchorIdx = lines.findIndex((l) => l.trim().endsWith(ROLES_ANCHOR));
  if (anchorIdx === -1) return "";
  let start = anchorIdx;
  while (start > 0 && !/^#{2,4}\s/.test(lines[start])) start -= 1;
  return lines.slice(start, anchorIdx + 1).join("\n");
}

/**
 * Roles of a block: each `**Name**` line opens a role; its table rows (outside
 * `>` "если спросит" quotes) are the role's lines.
 */
function parseRoles(blockText) {
  const roles = [];
  let current = null;
  let seenHeader = false;
  for (const raw of String(blockText || "").split("\n")) {
    const line = raw.trim();
    const name = /^\*\*([^*]+)\*\*\s*$/.exec(line);
    if (name && !/^Если/i.test(name[1].trim())) {
      current = { name: name[1].trim(), rows: [] };
      roles.push(current);
      seenHeader = false;
      continue;
    }
    if (!current || line.startsWith(">") || !line.startsWith("|")) continue;
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (!seenHeader) {
      seenHeader = true;
      continue;
    }
    current.rows.push(cells);
  }
  return roles;
}

/** Findings for a roles block (text from heading to anchor, or an inline section). */
function auditRoles(blockText, label = "Последние роли") {
  const roles = parseRoles(blockText);
  const out = [];
  if (roles.length < ROLES_REQUIRED) {
    out.push(
      finding(
        "roles-count",
        `${label}: ролей ${roles.length}, нужно ${ROLES_REQUIRED}. Выпавшая роль — не молчаливый пропуск: нет факта — ⚠️ и вопрос кандидату.`
      )
    );
  }
  for (const role of roles) {
    const filled = role.rows.filter((r) => r.length >= 2 && r[0] !== "" && r[1] !== "");
    if (filled.length < ROLE_ROWS_REQUIRED) {
      out.push(
        finding(
          "roles-rows",
          `${label}: у роли «${role.name}» ${filled.length} заполненных строк из ${ROLE_ROWS_REQUIRED} (кому подчинялся, почему ушёл, оценка 1–10; RU и EN в каждой).`
        )
      );
      continue;
    }
    const joined = filled.map((r) => r.join(" ")).join(" ");
    if (!/\d+(?:\.\d+)?\s*(?:из|of|out of|\/)\s*10/i.test(joined)) {
      out.push(
        finding(
          "roles-score",
          `${label}: у роли «${role.name}» нет оценки «N из 10» / «N out of 10».`
        )
      );
    }
    if (/⚠️/.test(joined)) {
      out.push(
        finding(
          "roles-gap",
          `${label}: у роли «${role.name}» остался ⚠️ — факт не получен у кандидата.`
        )
      );
    }
  }
  return out;
}

/** Findings for the whole storybank text. */
function auditStorybank(text) {
  const findings = [];
  for (const story of parseStories(text)) findings.push(...auditStory(story));
  const block = extractRolesBlock(text);
  if (block) findings.push(...auditRoles(block, "storybank ^say-roles"));
  return findings;
}

/** Ids of stories whose block text differs between two versions of the file. */
function changedStoryIds(beforeText, afterText) {
  const before = new Map(parseStories(beforeText).map((s) => [s.id, s.body]));
  return parseStories(afterText)
    .filter((s) => before.get(s.id) !== s.body)
    .map((s) => s.id);
}

/** Audit only what a write changes (used by the write hook). */
function auditChange(beforeText, afterText) {
  const changed = new Set(changedStoryIds(beforeText, afterText));
  const before = new Map(parseStories(beforeText).map((s) => [s.id, s]));
  const findings = [];
  for (const story of parseStories(afterText)) {
    if (!changed.has(story.id)) continue;
    const found = auditStory(story);
    const prev = before.get(story.id);
    // A story that already had no card is not blocked for an unrelated edit
    // (a typo, a ⚠️ line, a paragraph appended after it); only the write that
    // adds a new story, or touches the card, is judged.
    const hadNoCard = prev && auditStory(prev).some((f) => f.code === "no-card");
    const cardTouched =
      prev &&
      (JSON.stringify(parseCard(prev.body)) !== JSON.stringify(parseCard(story.body)) ||
        isApproach(prev.body) !== isApproach(story.body));
    for (const f of found) {
      if (f.code === "no-card" && hadNoCard && !cardTouched) continue;
      findings.push(f);
    }
  }
  const beforeRoles = extractRolesBlock(beforeText);
  const afterRoles = extractRolesBlock(afterText);
  if (beforeRoles && !afterRoles) {
    findings.push(
      finding(
        "roles-removed",
        "^say-roles: блок «Последние роли» удалён. Он меняется только по слову кандидата, правкой, не удалением."
      )
    );
  } else if (afterRoles && afterRoles !== beforeRoles) {
    findings.push(...auditRoles(afterRoles, "^say-roles"));
  }
  return findings;
}

function formatReport(findings, label = "storybank") {
  if (findings.length === 0) return `[storybank-audit] ${label}: чисто, находок нет.`;
  const lines = [`[storybank-audit] ${label}: ${findings.length} находок.`, ""];
  for (const f of findings) lines.push(`- (${f.code}) ${f.message}`);
  return lines.join("\n");
}

module.exports = {
  CARD_REQUIRED_FROM,
  CARD_FIELDS,
  ROLES_ANCHOR,
  parseStories,
  parseCard,
  isApproach,
  resultIsMissing,
  auditStory,
  approachStoryIds,
  extractRolesBlock,
  parseRoles,
  auditRoles,
  auditStorybank,
  changedStoryIds,
  auditChange,
  formatReport,
};

if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write("usage: node storybank_audit.js <coaching_state.md>\n");
    process.exit(2);
  }
  const file = path.resolve(arg);
  if (!fs.existsSync(file)) {
    process.stderr.write(`not found: ${file}\n`);
    process.exit(2);
  }
  const findings = auditStorybank(fs.readFileSync(file, "utf8"));
  process.stdout.write(`${formatReport(findings, path.basename(file))}\n`);
  process.exit(findings.length === 0 ? 0 : 1);
}
