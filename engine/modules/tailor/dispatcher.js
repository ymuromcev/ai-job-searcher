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
 *   "escalated"  — SKILL flagged the row for human triage because of an
 *                  unverified fact (`uncertain_about_fact`). Engine reverts
 *                  to Inbox and accumulates a record for the batch report.
 *                  Since BL-236 a coverage-gap escalation (no_growth /
 *                  iteration_cap below the target) is NOT escalated: it
 *                  ships, see classifyRow.
 *   "archetype"  — Default path. Weak/Medium rows, Strong rows that
 *                  came in before the tailor-loop existed, and (BL-236)
 *                  coverage-gap escalations with no draft or 0% coverage.
 *                  Engine uses the legacy archetype-pick flow (resumeVer).
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
  // BL-236 (owner, 2026-11-15): when the rounds of tailoring did not reach
  // the target coverage, the row is submitted all the same ("if we did not
  // get to the threshold after all the rounds, submit anyway"). A
  // coverage-gap escalation (no growth / iteration cap — the resume only
  // lacks JD phrases the candidate has no basis for) ships:
  //   - as "tailored" with the best draft the loop produced, at ANY coverage
  //     above zero;
  //   - as "archetype" (the base resume by `resumeVer`) when there is no
  //     draft, or the coverage is zero (no JD text to tailor against).
  // The threshold is not read here: `tailor_ship_min_coverage` of
  // apply_defaults.json is ignored since BL-236.
  // `uncertain_about_fact` never ships: a fact needs the owner.
  if (row.tailorEscalated === true) {
    if (!SHIPPABLE_ESCALATIONS.has(row.tailorEscalationReason)) return "escalated";
    const coverage = Number(row.tailorCoverage);
    const hasDraft = row.tailoredResume && typeof row.tailoredResume === "object";
    return hasDraft && Number.isFinite(coverage) && coverage > 0 ? "tailored" : "archetype";
  }

  if (row.tailoredResume && typeof row.tailoredResume === "object") {
    return "tailored";
  }
  return "archetype";
}

// The escalations that ship below the coverage target (BL-236).
const SHIPPABLE_ESCALATIONS = new Set([
  "no_growth_below_threshold",
  "iteration_cap_below_threshold",
]);

// The coverage the tailor loop aims for (SKILL Step 6.5). Rows that end below
// it still ship; the note on the row says so.
const TAILOR_TARGET_COVERAGE = 75;

/**
 * The note a row carries when it was submitted below the coverage target
 * (BL-236), or "" when it does not apply. `classification` is the verdict of
 * classifyRow for the row.
 */
function belowThresholdNote(row, classification) {
  if (!row || row.tailorEscalated !== true) return "";
  if (!SHIPPABLE_ESCALATIONS.has(row.tailorEscalationReason)) return "";
  if (classification !== "tailored" && classification !== "archetype") return "";
  const coverage = Number(row.tailorCoverage);
  const pct = Number.isFinite(coverage) ? Math.round(coverage) : 0;
  const base = classification === "archetype" ? " (базовое резюме, подгонки нет)" : "";
  return `coverage ${pct}% < ${TAILOR_TARGET_COVERAGE}, подано ниже порога${base}`;
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
  const detail =
    r.tailorEscalationDetail && typeof r.tailorEscalationDetail === "object"
      ? r.tailorEscalationDetail
      : {};
  const iterations = Array.isArray(detail.iterations) ? detail.iterations : [];
  const uncertainFacts = Array.isArray(detail.uncertain_facts) ? detail.uncertain_facts : [];
  // missing_high_priority is sourced from the last iteration's `missing`
  // list if the SKILL didn't pass it separately — it's the most useful
  // signal for "what would push coverage higher".
  const lastIter = iterations[iterations.length - 1] || {};
  const missingHighPriority = Array.isArray(detail.missing_high_priority)
    ? detail.missing_high_priority
    : Array.isArray(lastIter.missing)
      ? lastIter.missing
      : [];

  const finalCoveragePct =
    typeof r.tailorCoverage === "number" ? r.tailorCoverage : Number(r.tailorCoverage || 0);

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
 *   resumes/tailored/<companySlug>_<roleSlug>_<YYYYMMDD>.docx
 *
 * BL-F: the filename includes the role slug so multiple Strong rows at
 * the same company on the same day don't overwrite each other. Underscore
 * separators + compact YYYYMMDD mirror the `clKey` convention used by
 * cover-letter files (e.g. `Perplexity_pm-builder_20260525`).
 *
 * @param {string} profileId   — unused in the path itself but kept in the
 *   signature so callers can swap to an absolute-path variant later
 *   without touching call sites.
 * @param {string} companySlug — company slug (caller computes via slugifyCompany)
 * @param {string} roleSlug    — role slug (caller computes via slugifyRole)
 * @param {string} dateStamp   — YYYYMMDD string, no separators
 * @returns {string} relative POSIX path
 */
function tailoredResumePath(profileId, companySlug, roleSlug, dateStamp) {
  // path.posix.join keeps the separator stable across macOS / Linux /
  // (hypothetical) Windows callers; tsv consumers split on "/".
  return path.posix.join("resumes", "tailored", `${companySlug}_${roleSlug}_${dateStamp}.docx`);
}

/**
 * Compute the on-disk path for a tailored resume PDF (relative to the
 * profile root). Mirrors `tailoredResumePath` but with a `.pdf` extension.
 * BL-126 Block A: PDF is emitted alongside DOCX in the commit phase and
 * becomes the canonical `resume_ver` (TSV / Notion) — recruiters expect
 * PDF; DOCX stays as a side artifact for archive / re-edit.
 *
 *   resumes/tailored/<companySlug>_<roleSlug>_<YYYYMMDD>.pdf
 *
 * @param {string} profileId   — unused in the path itself (parity with DOCX helper)
 * @param {string} companySlug — company slug (caller computes via slugifyCompany)
 * @param {string} roleSlug    — role slug (caller computes via slugifyRole)
 * @param {string} dateStamp   — YYYYMMDD string, no separators
 * @returns {string} relative POSIX path
 */
function tailoredResumePathPdf(profileId, companySlug, roleSlug, dateStamp) {
  return path.posix.join("resumes", "tailored", `${companySlug}_${roleSlug}_${dateStamp}.pdf`);
}

module.exports = {
  classifyRow,
  belowThresholdNote,
  TAILOR_TARGET_COVERAGE,
  buildEscalationRecord,
  tailoredResumePath,
  tailoredResumePathPdf,
};
