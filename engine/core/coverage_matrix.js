// Coverage matrix renderer (BL-D).
//
// Pure helper that takes the tailored rows from a prepare commit batch and
// returns a markdown report cross-tabulating JD phrases × row_keys. Each
// cell shows the JD-coverage status (exact / partial / missing / "—" when
// the phrase didn't appear in that row's JD at all). A "Gaps" section
// underneath lists phrases that never matched in any row — these surface
// gaps in master_profile relative to the batch's JDs.
//
// Input: `tailoredResults` — array of objects
//   {
//     row_key: string,               // applications.tsv key (e.g. "greenhouse:1234")
//     coverage_table: Array<{
//       jd_phrase: string,
//       status: "exact_match" | "partial" | "missing",
//       category?: string,
//       priority?: string,
//       where?: string | null,
//     }>,
//   }
//
// Output: a markdown string. Empty input → empty string (caller decides
// whether to write the file).

const STATUS_GLYPH = {
  exact_match: "✓ exact",
  partial: "partial",
  missing: "missing",
};

function statusCell(status) {
  if (!status) return "—";
  return STATUS_GLYPH[status] || status;
}

function escapeCell(s) {
  // Pipes break markdown tables; the rest is fine inside a single-line cell.
  return String(s).replace(/\|/g, "\\|");
}

/**
 * Build a phrase × row_key coverage matrix as a markdown string.
 *
 * @param {Array<{row_key: string, coverage_table: Array<object>}>} tailoredResults
 * @param {object} [opts]
 * @param {string} [opts.batchTs] - optional batch timestamp string for the heading.
 * @returns {string} markdown, empty string when input has no usable coverage data.
 */
function buildMatrix(tailoredResults, opts = {}) {
  const rows = Array.isArray(tailoredResults) ? tailoredResults : [];

  // Keep rows that actually carry a non-empty coverage_table; ignore the rest
  // (escalations without detail, malformed shapes, etc).
  const usable = rows.filter(
    (r) =>
      r &&
      typeof r.row_key === "string" &&
      Array.isArray(r.coverage_table) &&
      r.coverage_table.length > 0
  );
  if (usable.length === 0) return "";

  // Preserve row_key order as given (caller decides ordering — engine emits
  // tailorPlan insertion order, which mirrors results[] order).
  const rowKeys = usable.map((r) => r.row_key);

  // phrase -> { rowKey -> status }. Use Map to preserve first-seen phrase
  // order across rows, which keeps the report stable across runs given the
  // same input.
  const phraseMap = new Map();
  for (const r of usable) {
    for (const entry of r.coverage_table) {
      if (!entry || typeof entry.jd_phrase !== "string") continue;
      const phrase = entry.jd_phrase;
      if (!phraseMap.has(phrase)) phraseMap.set(phrase, {});
      phraseMap.get(phrase)[r.row_key] = entry.status;
    }
  }

  const lines = [];
  const heading = opts.batchTs ? `# Coverage Matrix — batch ${opts.batchTs}` : `# Coverage Matrix`;
  lines.push(heading);
  lines.push("");

  // Header row.
  lines.push(`| JD phrase | ${rowKeys.map(escapeCell).join(" | ")} |`);
  lines.push(`|${"---|".repeat(rowKeys.length + 1)}`);

  // Body. A cell is "—" when the phrase never appeared in that row's JD
  // (different JDs share phrase coverage but rarely have the exact same
  // phrase set). Phrases the row DID see show the matcher's verdict.
  for (const [phrase, byRow] of phraseMap) {
    const cells = rowKeys.map((rk) => {
      if (!(rk in byRow)) return "—";
      return statusCell(byRow[rk]);
    });
    lines.push(`| "${escapeCell(phrase)}" | ${cells.join(" | ")} |`);
  }

  // Gaps section: phrases where no row matched (every cell is either
  // "missing" or "—"). The list also shows where the phrase came from so
  // the operator can decide whether to add a candidate fact to master.
  const gaps = [];
  for (const [phrase, byRow] of phraseMap) {
    const matchedSomewhere = Object.values(byRow).some(
      (s) => s === "exact_match" || s === "partial"
    );
    if (matchedSomewhere) continue;
    const sources = rowKeys.filter((rk) => byRow[rk] === "missing");
    gaps.push({ phrase, sources });
  }

  if (gaps.length > 0) {
    lines.push("");
    lines.push("## Gaps (phrases never matched in any row)");
    lines.push("");
    for (const g of gaps) {
      const suffix = g.sources.length > 0 ? ` — ${g.sources.join(", ")} JD only` : "";
      lines.push(`- "${g.phrase}"${suffix}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

module.exports = { buildMatrix };
