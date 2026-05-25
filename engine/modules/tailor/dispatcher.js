// Pure dispatch helpers for the tailor-loop integration in
// `engine/commands/prepare.js` `runCommit` (BL-123 / RFC 044).
//
// The SKILL writes 5 new per-row fields on Strong-fit `results[]` entries:
//   - tailoredResume          : object | null  (resume_docx.js input schema)
//   - tailorCoverage          : number | null  (0-100)
//   - tailorEscalated         : boolean
//   - tailorEscalationReason  : "no_growth_below_threshold"
//                              | "iteration_cap_below_threshold"
//                              | "uncertain_about_fact"
//                              | null
//   - tailorEscalationDetail  : object | null
//                              { iterations, uncertain_facts, coverage_table }
//
// For Weak / Medium rows these fields are absent or null; runCommit keeps
// the existing archetype-pick path. The classification table below is the
// single source of truth for which branch a row takes.
//
// All exports in this module are pure functions over in-memory objects.
// No filesystem, no network, no `process.exit`. Side effects (DOCX
// generation, fs writes, escalation MD output) stay in runCommit.

const path = require("path");

/**
 * Classify a results.json row into one of the three dispatch buckets.
 *
 *   "tailored"   — Strong row with a SKILL-produced tailored resume and
 *                  no escalation. Engine generates DOCX from
 *                  row.tailoredResume and uses that path everywhere the
 *                  archetype DOCX would have gone.
 *   "escalated"  — SKILL flagged the row for human triage (no_growth,
 *                  iteration_cap, or uncertain_fact). Engine reverts to
 *                  Inbox and accumulates a record for the batch report.
 *   "archetype"  — Default path. Weak/Medium rows or Strong rows that
 *                  came in before the tailor-loop existed. Engine uses
 *                  the legacy archetype-pick flow (resumeVer key).
 *
 * Light shape validation only — caller logs a warn and falls back to
 * "archetype" when a Strong row carries malformed tailor fields. We do
 * the typeof checks here so the classifier stays the single decision
 * point; runCommit just acts on the verdict.
 *
 * @param {object} row — entry from results.json `results[]`
 * @returns {"tailored" | "escalated" | "archetype"}
 */
function classifyRow(row) {
  if (!row || typeof row !== "object") return "archetype";

  // Escalation wins even if a tailoredResume was also provided — the
  // SKILL contract is that escalated rows skip the auto-ship path.
  if (row.tailorEscalated === true) return "escalated";

  if (row.tailoredResume && typeof row.tailoredResume === "object") {
    return "tailored";
  }
  return "archetype";
}

/**
 * Build the escalation record consumed by
 * `engine/modules/tailor/escalation_report.js`. Pulls fields from both
 * the row itself (for context the SKILL didn't repeat in the detail
 * blob) and `tailorEscalationDetail` (where iterations / uncertain_facts
 * live). The shape mirrors the input record documented at the top of
 * `escalation_report.js`.
 *
 * Defensive: missing or malformed inner fields collapse to sensible
 * empty defaults so the markdown renderer never throws on a partial
 * record. The renderer already null-guards each field, but we normalize
 * here too so the on-disk artifact is consistent.
 *
 * @param {object} row — entry from results.json `results[]`
 * @returns {object} record matching renderEscalationReport input shape
 */
function buildEscalationRecord(row) {
  const r = row || {};
  const detail = (r.tailorEscalationDetail && typeof r.tailorEscalationDetail === "object")
    ? r.tailorEscalationDetail
    : {};
  const iterations = Array.isArray(detail.iterations) ? detail.iterations : [];
  const uncertainFacts = Array.isArray(detail.uncertain_facts)
    ? detail.uncertain_facts
    : [];
  // missing_high_priority is sourced from the last iteration's `missing`
  // list if the SKILL didn't pass it separately — it's the most useful
  // signal for "what would push coverage higher".
  const lastIter = iterations[iterations.length - 1] || {};
  const missingHighPriority = Array.isArray(detail.missing_high_priority)
    ? detail.missing_high_priority
    : (Array.isArray(lastIter.missing) ? lastIter.missing : []);

  const finalCoveragePct = typeof r.tailorCoverage === "number"
    ? r.tailorCoverage
    : Number(r.tailorCoverage || 0);

  // The SKILL emits `tailorEscalationReason` (the action-oriented label).
  // The MD report has both `escalation_reason` (why escalate) and
  // `exit_reason` (how the loop terminated). When the SKILL doesn't
  // disambiguate, mirror the escalation reason into the exit reason so
  // the report still renders something meaningful.
  const escalationReason = r.tailorEscalationReason || null;
  const exitReason = detail.exit_reason || escalationReason || "unknown";

  return {
    row_key: r.key || "",
    target_role: r.targetRole || r.target_role || "",
    company: r.company || "",
    jd_url: r.jdUrl || r.jd_url || "",
    final_coverage_pct: finalCoveragePct,
    exit_reason: exitReason,
    iterations,
    missing_high_priority: missingHighPriority,
    uncertain_facts: uncertainFacts,
    master_source_hash: r.masterSourceHash || detail.master_source_hash || "",
    escalation_reason: escalationReason,
  };
}

/**
 * Compute the on-disk path for a tailored resume DOCX (relative to the
 * profile root). Returned as a forward-slash POSIX path so it matches
 * the convention used by `applications.tsv` (e.g. `cl_path`).
 *
 *   resumes/tailored/<slug>-<YYYY-MM-DD>.docx
 *
 * @param {string} profileId — unused in the path itself but kept in the
 *   signature so callers can swap to an absolute-path variant later
 *   without touching call sites.
 * @param {string} slug      — company slug (caller computes via slugifyCompany)
 * @param {string} date      — YYYY-MM-DD string (caller computes from `now`)
 * @returns {string} relative POSIX path
 */
function tailoredResumePath(profileId, slug, date) {
  // path.posix.join keeps the separator stable across macOS / Linux /
  // (hypothetical) Windows callers; tsv consumers split on "/".
  return path.posix.join("resumes", "tailored", `${slug}-${date}.docx`);
}

module.exports = {
  classifyRow,
  buildEscalationRecord,
  tailoredResumePath,
};
