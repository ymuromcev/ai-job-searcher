// Markdown + stdout renderers for tailor-loop escalations (RFC 044
// §"Escalation surface").
//
// Pure string assembly. Side effects (writing the .md file, printing the
// stdout summary) live in the caller (`engine/commands/prepare.js`).
//
// Input record shape:
//   {
//     row_key: string,
//     target_role: string,
//     company: string,
//     jd_url: string,
//     final_coverage_pct: number,
//     exit_reason: "threshold_met" | "no_growth" | "iteration_cap_reached",
//     iterations: Array<{n, coverage_pct, missing}>,
//     missing_high_priority: string[],
//     uncertain_facts: Array<{fact, source_hint?, suggested_action?}>,
//     master_source_hash: string,
//     escalation_reason: "no_growth_below_threshold" | "uncertain_about_fact",
//   }
//
// Exports:
//   renderEscalationReport(records, opts)   → string  (full MD)
//   renderEscalationStdout(records)         → string  (stdout summary)
//   formatIterationsLine(iterations)        → string
//   formatMissingList(missing)              → string  (CSV summary)

/**
 * Format the per-iteration coverage progression.
 * Example: "62%, 81%, 88% (3 iters)"
 *
 * @param {Array<{n: number, coverage_pct: number}>} iterations
 * @returns {string}
 */
function formatIterationsLine(iterations) {
  const list = Array.isArray(iterations) ? iterations : [];
  if (list.length === 0) return "(no iterations)";
  const pcts = list.map((it) => `${it.coverage_pct}%`).join(", ");
  return `${pcts} (${list.length} iter${list.length === 1 ? "" : "s"})`;
}

/**
 * Format a list of missing phrases for the summary column. Truncates to first
 * 4 entries with "+N more" suffix to keep the table tidy.
 *
 * @param {string[]} missing
 * @returns {string}
 */
function formatMissingList(missing) {
  const list = Array.isArray(missing) ? missing.filter(Boolean) : [];
  if (list.length === 0) return "(none)";
  const head = list.slice(0, 4).join(", ");
  if (list.length <= 4) return head;
  return `${head}, +${list.length - 4} more`;
}

/**
 * Format the uncertain-facts summary cell. Each entry is rendered as a quoted
 * fact; we keep this short for the summary table and expand in the "Details"
 * section.
 *
 * @param {Array<{fact: string}>} uncertain
 * @returns {string}
 */
function formatUncertainSummary(uncertain) {
  const list = Array.isArray(uncertain) ? uncertain : [];
  if (list.length === 0) return "";
  const head = list
    .slice(0, 2)
    .map((u) => `"${String((u && u.fact) || "").trim()}"`)
    .filter((s) => s !== '""')
    .join("; ");
  if (list.length <= 2) return head;
  return `${head}; +${list.length - 2} more`;
}

/**
 * Render a single record's "Details" section.
 *
 * @param {object} rec
 * @returns {string}
 */
function renderRecordDetails(rec) {
  const lines = [];
  const headerName = `${rec.company || ""} ${rec.target_role || ""}`.trim() || "Job";
  lines.push(`### ${headerName} (row_key=${rec.row_key || "n/a"})`);
  lines.push(`- Iterations: ${formatIterationsLine(rec.iterations)}`);
  lines.push(`- Exit reason: \`${rec.exit_reason || "unknown"}\``);
  lines.push(`- Escalation reason: \`${rec.escalation_reason || "n/a"}\``);
  lines.push(`- Final coverage: ${Number(rec.final_coverage_pct || 0)}%`);

  const missingHi = Array.isArray(rec.missing_high_priority) ? rec.missing_high_priority : [];
  if (missingHi.length > 0) {
    lines.push("- Missing high-priority JD phrases:");
    for (const p of missingHi) lines.push(`  - "${p}"`);
  }

  const uncertain = Array.isArray(rec.uncertain_facts) ? rec.uncertain_facts : [];
  if (uncertain.length > 0) {
    lines.push("- Uncertain facts (would push coverage higher if confirmed):");
    for (const u of uncertain) {
      const fact = String((u && u.fact) || "").trim();
      const hint = (u && u.source_hint) || "";
      const action = (u && u.suggested_action) || "confirm or deny";
      lines.push(`  - "${fact}"${hint ? ` — ${hint}` : ""} (${action})`);
    }
  }

  if (rec.jd_url) lines.push(`- JD URL: ${rec.jd_url}`);
  if (rec.master_source_hash) {
    lines.push(`- Master profile version: source_hash=${rec.master_source_hash}`);
  }
  return lines.join("\n");
}

/**
 * Render the full markdown escalation report.
 *
 * @param {Array<object>} records
 * @param {{timestamp?: string|Date}} [opts]
 * @returns {string}
 */
function renderEscalationReport(records, opts = {}) {
  const list = Array.isArray(records) ? records : [];
  const ts = formatTimestamp(opts.timestamp);
  const lines = [];
  lines.push(`# Tailor escalations — ${ts}`);
  lines.push("");
  if (list.length === 0) {
    lines.push("_No escalations in this batch._");
    lines.push("");
    return lines.join("\n");
  }

  // Summary table.
  lines.push("| Job | Final coverage | Exit reason | Missing / Uncertain |");
  lines.push("|---|---|---|---|");
  for (const rec of list) {
    const jobLabel = `${rec.company || ""} ${rec.target_role || ""}`.trim() || "Job";
    const missing = formatMissingList(rec.missing_high_priority);
    const uncertain = formatUncertainSummary(rec.uncertain_facts);
    const summary =
      [missing !== "(none)" ? missing : "", uncertain].filter(Boolean).join(" | ") || "(none)";
    lines.push(
      `| ${jobLabel} | ${Number(rec.final_coverage_pct || 0)}% | ${rec.exit_reason || "?"} | ${summary} |`
    );
  }
  lines.push("");
  lines.push("## Details");
  lines.push("");
  for (const rec of list) {
    lines.push(renderRecordDetails(rec));
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Render the short stdout summary table. 3-4 columns, fixed-width-ish via
 * pipe-separated values (caller can pipe through `column -t -s '|'` if desired).
 *
 * @param {Array<object>} records
 * @returns {string}
 */
function renderEscalationStdout(records) {
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) return "";
  const lines = [];
  lines.push(`Tailor escalations: ${list.length}`);
  lines.push("Job | Coverage | Reason | Hint");
  for (const rec of list) {
    const jobLabel = `${rec.company || ""} ${rec.target_role || ""}`.trim() || "Job";
    const hint =
      formatUncertainSummary(rec.uncertain_facts) || formatMissingList(rec.missing_high_priority);
    lines.push(
      `${jobLabel} | ${Number(rec.final_coverage_pct || 0)}% | ${rec.escalation_reason || rec.exit_reason || "?"} | ${hint}`
    );
  }
  return lines.join("\n");
}

function formatTimestamp(t) {
  if (t instanceof Date) return t.toISOString().replace("T", " ").slice(0, 19);
  if (typeof t === "string" && t) return t;
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

module.exports = {
  renderEscalationReport,
  renderEscalationStdout,
  formatIterationsLine,
  formatMissingList,
  formatUncertainSummary,
  formatTimestamp,
};
