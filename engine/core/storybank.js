// Pure parser for the `## Storybank` section of a profile's coaching_state.md.
//
// The storybank is the single place the candidate edits real achievements during
// mock interviews. It has two parts inside the `## Storybank` heading:
//
//   1. A summary table (one row per story):
//        | ID | Title | Primary Skill | Secondary Skill | Commercial Profile
//        | Earned Secret | Strength | Use Count | Last Used |
//
//   2. `### Story Details` with one `#### S0NN — ...` block per story. Each block
//      holds a 2-column RU/EN STAR table (Situation/Task/Action/Result/Earned
//      Secret) plus a `- **Deploy for.**` line.
//
// This module turns that markdown into a flat array of story objects. It is the
// deterministic read-point that the fit-digest generator (RFC 060, BL-192) builds
// on. Pure: markdown string in, array out. No filesystem, no network.
//
// Column mapping is by HEADER NAME, not position, so adding/reordering columns in
// the table does not silently corrupt the parse.

const HEADER_ALIASES = [
  [/^id$/, "id"],
  [/^title$/, "title"],
  [/^primary/, "primarySkill"],
  [/^secondary/, "secondarySkill"],
  [/^commercial/, "commercialProfile"],
  [/^earned secret/, "earnedSecret"],
  [/^strength$/, "strength"],
  [/^use count/, "useCount"],
  [/^last used/, "lastUsed"],
];

function headerKey(cell) {
  const norm = cell.trim().toLowerCase();
  for (const [re, key] of HEADER_ALIASES) {
    if (re.test(norm)) return key;
  }
  return null;
}

// Split a markdown table row into trimmed cells, dropping the empty edges that
// result from the leading/trailing pipe.
function splitRow(line) {
  const parts = line.split("|");
  // A well-formed `| a | b |` splits to ['', ' a ', ' b ', ''].
  if (parts.length >= 2 && parts[0].trim() === "") parts.shift();
  if (parts.length >= 1 && parts[parts.length - 1].trim() === "") parts.pop();
  return parts.map((c) => c.trim());
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

// Extract the `## Storybank` section: everything from that heading up to the next
// top-level `## ` heading (the `### Story Details` / `#### S0NN` blocks live
// inside it and are kept).
function extractSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

// Parse the summary table into id-keyed records using a header-name column map.
function parseTable(sectionLines) {
  const rows = [];
  let colMap = null; // index -> key
  for (const line of sectionLines) {
    if (!line.trimStart().startsWith("|")) {
      // A non-table line ends the table once we have started reading it.
      if (colMap) break;
      continue;
    }
    const cells = splitRow(line);
    if (!colMap) {
      // First pipe-row that names an ID column is the header.
      const map = {};
      let sawId = false;
      cells.forEach((c, i) => {
        const key = headerKey(c);
        if (key) map[i] = key;
        if (key === "id") sawId = true;
      });
      if (sawId) colMap = map;
      continue;
    }
    if (isSeparatorRow(cells)) continue;
    const rec = {};
    cells.forEach((c, i) => {
      if (colMap[i]) rec[colMap[i]] = c;
    });
    if (rec.id && /^S\d+$/.test(rec.id)) rows.push(rec);
  }
  return rows;
}

// Strip markdown bold and a leading `**Label.**` prefix from a STAR cell.
function cleanStarCell(text, label) {
  let t = text.trim();
  const prefix = new RegExp(`^\\*\\*${label}\\.?\\*\\*\\s*`, "i");
  t = t.replace(prefix, "");
  t = t.replace(/\*\*/g, "").trim();
  return t;
}

// Parse the `#### S0NN — ...` detail blocks into { result, deployFor } enrichment
// keyed by story id. Best-effort: a story with no detail block is simply absent.
function parseDetailBlocks(section) {
  const out = {};
  // Split on each `#### S0NN` header, keeping the id.
  const parts = section.split(/^####\s+(S\d+)\b/m);
  // parts[0] is the preamble; then [id, body, id, body, ...].
  for (let i = 1; i < parts.length; i += 2) {
    const id = parts[i];
    const body = parts[i + 1] || "";
    const enrich = {};

    // Result: the English (right-hand) cell of the `**Result.**` table row.
    const resultLine = body.split(/\r?\n/).find((l) => /\|\s*\*\*Result/.test(l));
    if (resultLine) {
      const cells = splitRow(resultLine);
      const en = cells[cells.length - 1];
      if (en) enrich.result = cleanStarCell(en, "Result");
    }

    // Deploy for: `- **Deploy for.** a, b, c`
    const deployLine = body.split(/\r?\n/).find((l) => /\*\*Deploy for/i.test(l));
    if (deployLine) {
      const after = deployLine.replace(/^.*\*\*Deploy for\.?\*\*\s*/i, "");
      enrich.deployFor = after
        .replace(/\.$/, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    out[id] = enrich;
  }
  return out;
}

/**
 * Parse the `## Storybank` section of a coaching_state.md markdown string.
 *
 * @param {string} markdown - full coaching_state.md contents
 * @returns {Array<{
 *   id: string, title: string, primarySkill: string, secondarySkill: string,
 *   commercialProfile: string, earnedSecret: string, strength: string,
 *   deployFor: string[], result: (string|undefined)
 * }>} one entry per story, table order preserved.
 */
function parseStorybank(markdown) {
  if (typeof markdown !== "string") {
    throw new Error("parseStorybank: markdown must be a string");
  }
  const section = extractSection(markdown, "## Storybank");
  if (section == null) return [];

  const sectionLines = section.split(/\r?\n/);
  const tableRows = parseTable(sectionLines);
  const details = parseDetailBlocks(section);

  return tableRows.map((row) => {
    const enrich = details[row.id] || {};
    return {
      id: row.id,
      title: row.title || "",
      primarySkill: row.primarySkill || "",
      secondarySkill: row.secondarySkill || "",
      commercialProfile: row.commercialProfile || "",
      earnedSecret: row.earnedSecret || "",
      strength: (row.strength || "").toLowerCase(),
      deployFor: enrich.deployFor || [],
      result: enrich.result,
    };
  });
}

module.exports = { parseStorybank };
