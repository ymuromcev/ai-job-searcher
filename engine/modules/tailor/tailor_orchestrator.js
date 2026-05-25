// Tailor orchestrator — the autonomous Strong-fit lexical-mirror loop.
//
// Pure orchestration over an injected subagent caller (`subagentCallFn`). Side
// effects (filesystem, network, Anthropic SDK) live in the caller. The loop
// itself is deterministic given the same subagent outputs, which keeps it
// unit-testable.
//
// Loop semantics (RFC 044 §"Loop semantics"):
//
//   prev_coverage = 0
//   for n in 1..iterationCap:
//     result = subagentCallFn({jdText, jdStructure, master..., prev_resume_data, missing_from_prev})
//     iterations.push({n, coverage_pct: result.coverage_pct, missing: result.missing})
//     if result.coverage_pct >= threshold: exit("threshold_met")
//     if (result.coverage_pct - prev_coverage) < noGrowthDelta: exit("no_growth")
//     prev_coverage = result.coverage_pct
//     prev_resume_data = result.resume_data
//   exit("iteration_cap_reached")
//
// Escalation (RFC 044 §"Subagent contracts"):
//   - escalate=true, reason="no_growth_below_threshold"
//       final_coverage_pct < threshold AND last delta < noGrowthDelta
//       (model stuck — needs master profile enrichment or accept gap)
//   - escalate=true, reason="iteration_cap_below_threshold"
//       final_coverage_pct < threshold AND last delta >= noGrowthDelta
//       (model still climbing — could raise cap or accept current draft)
//   - escalate=true, reason="uncertain_about_fact"
//       final_coverage_pct >= threshold AND uncertain_facts[] non-empty
//   - escalate=false otherwise (auto-ship)
//
// Exports:
//   runTailorLoop(args)                              → Promise<orchestratorResult>
//   decideExit(coverage, prevCoverage, n, opts)      → {done: bool, reason: string|null}  (pure)
//   decideEscalation(finalCoverage, uncertain, opts) → {escalate: bool, reason: string|null}  (pure)

const DEFAULT_ITERATION_CAP = 6;
const DEFAULT_THRESHOLD = 85;
const DEFAULT_NO_GROWTH_DELTA = 1;

/**
 * Decide whether the loop should exit after a given iteration.
 *
 * Order of checks:
 *   1. threshold_met: coverage ≥ threshold (highest precedence, even on iter 1).
 *   2. no_growth: delta < noGrowthDelta (only meaningful from iter 2 onward;
 *      iter 1 with coverage 0 vs prev 0 has delta 0 but we don't bail because
 *      otherwise we'd never iterate). We only flag no_growth on n ≥ 2.
 *   3. iteration_cap_reached: n >= iterationCap.
 *
 * @param {number} coverage — current iteration coverage_pct
 * @param {number} prevCoverage — coverage_pct from previous iteration (0 for iter 1)
 * @param {number} n — current iteration index (1-based)
 * @param {{iterationCap: number, threshold: number, noGrowthDelta: number}} opts
 * @returns {{done: boolean, reason: string|null}}
 */
function decideExit(coverage, prevCoverage, n, opts) {
  const { iterationCap, threshold, noGrowthDelta } = opts;
  if (coverage >= threshold) return { done: true, reason: "threshold_met" };
  if (n >= 2 && coverage - prevCoverage < noGrowthDelta) {
    return { done: true, reason: "no_growth" };
  }
  if (n >= iterationCap) return { done: true, reason: "iteration_cap_reached" };
  return { done: false, reason: null };
}

/**
 * Decide whether the completed loop should escalate to the user (vs auto-ship).
 *
 * @param {number} finalCoverage
 * @param {Array} uncertainFacts
 * @param {{threshold: number, noGrowthDelta: number, lastDelta: number}} opts
 * @returns {{escalate: boolean, reason: string|null}}
 */
function decideEscalation(finalCoverage, uncertainFacts, opts) {
  const { threshold, noGrowthDelta, lastDelta } = opts;
  const uncertain = Array.isArray(uncertainFacts) ? uncertainFacts : [];
  // Below threshold + no growth → escalate as stuck. User action: enrich
  // master profile OR accept gap and ship manually.
  if (finalCoverage < threshold && lastDelta < noGrowthDelta) {
    return { escalate: true, reason: "no_growth_below_threshold" };
  }
  // Below threshold but still growing (iteration cap reached mid-climb) —
  // distinct actionable signal. User action: raise iteration cap, or accept
  // current draft as good-enough.
  if (finalCoverage < threshold) {
    return { escalate: true, reason: "iteration_cap_below_threshold" };
  }
  // At/above threshold but agent flagged unverified facts.
  if (uncertain.length > 0) {
    return { escalate: true, reason: "uncertain_about_fact" };
  }
  return { escalate: false, reason: null };
}

/**
 * Run the tailoring loop.
 *
 * @param {object} args
 * @param {string} args.jdText
 * @param {object} args.jdStructure
 * @param {string} args.masterProfilePath
 * @param {string} [args.storybankPath]
 * @param {string} args.profileId
 * @param {string} args.targetRoleTitle
 * @param {string} [args.rowKey]
 * @param {number} [args.iterationCap=6]
 * @param {number} [args.threshold=85]
 * @param {number} [args.noGrowthDelta=1]
 * @param {(input: object) => Promise<object>} args.subagentCallFn
 *
 * @returns {Promise<{
 *   row_key: string|null,
 *   iterations: Array<{n: number, coverage_pct: number, missing: Array}>,
 *   final_coverage_pct: number,
 *   exit_reason: string,
 *   escalate: boolean,
 *   escalation_reason: string|null,
 *   resume_data: object|null,
 *   coverage_table: Array,
 *   uncertain_facts: Array
 * }>}
 */
async function runTailorLoop({
  jdText,
  jdStructure,
  masterProfilePath,
  storybankPath = null,
  profileId,
  targetRoleTitle,
  rowKey = null,
  iterationCap = DEFAULT_ITERATION_CAP,
  threshold = DEFAULT_THRESHOLD,
  noGrowthDelta = DEFAULT_NO_GROWTH_DELTA,
  subagentCallFn,
} = {}) {
  if (typeof subagentCallFn !== "function") {
    throw new Error("runTailorLoop: subagentCallFn is required");
  }

  const opts = { iterationCap, threshold, noGrowthDelta };

  const iterations = [];
  let prevCoverage = 0;
  let prevResumeData = null;
  let lastResult = null;
  let exitReason = "iteration_cap_reached";
  let lastDelta = 0;

  for (let n = 1; n <= iterationCap; n += 1) {
    const input = {
      row_key: rowKey,
      jd_text: jdText,
      jd_structure: jdStructure,
      master_profile_path: masterProfilePath,
      storybank_path: storybankPath,
      profile_id: profileId,
      target_role_title: targetRoleTitle,
      iteration: n,
      prev_resume_data: prevResumeData,
      missing_from_prev:
        iterations.length > 0 ? iterations[iterations.length - 1].missing : [],
    };

    // eslint-disable-next-line no-await-in-loop -- sequential by design (each
    // iteration depends on previous result)
    const result = await subagentCallFn(input);
    lastResult = result || {};

    const coverage = Number(lastResult.coverage_pct);
    const safeCoverage = Number.isFinite(coverage) ? coverage : 0;
    const missing = Array.isArray(lastResult.missing) ? lastResult.missing : [];

    iterations.push({ n, coverage_pct: safeCoverage, missing });

    lastDelta = safeCoverage - prevCoverage;
    const { done, reason } = decideExit(safeCoverage, prevCoverage, n, opts);
    if (done) {
      exitReason = reason;
      prevResumeData = lastResult.resume_data || prevResumeData;
      prevCoverage = safeCoverage;
      break;
    }

    prevCoverage = safeCoverage;
    prevResumeData = lastResult.resume_data || prevResumeData;
  }

  const finalCoverage = iterations.length
    ? iterations[iterations.length - 1].coverage_pct
    : 0;
  const uncertainFacts = Array.isArray(lastResult && lastResult.uncertain_facts)
    ? lastResult.uncertain_facts
    : [];
  const coverageTable = Array.isArray(lastResult && lastResult.coverage_table)
    ? lastResult.coverage_table
    : [];

  const { escalate, reason: escalationReason } = decideEscalation(
    finalCoverage,
    uncertainFacts,
    { threshold, noGrowthDelta, lastDelta },
  );

  return {
    row_key: rowKey,
    iterations,
    final_coverage_pct: finalCoverage,
    exit_reason: exitReason,
    escalate,
    escalation_reason: escalationReason,
    resume_data: prevResumeData,
    coverage_table: coverageTable,
    uncertain_facts: uncertainFacts,
  };
}

module.exports = {
  runTailorLoop,
  decideExit,
  decideEscalation,
  DEFAULT_ITERATION_CAP,
  DEFAULT_THRESHOLD,
  DEFAULT_NO_GROWTH_DELTA,
};
