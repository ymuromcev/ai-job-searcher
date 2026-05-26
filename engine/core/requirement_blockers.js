// Requirement-blocker module (RFC 046 / BL-B).
//
// Pure functions. Given a structured JD (from `jd_extract.extractJDStructure`)
// and a profile's compiled `requirement_blockers.patterns[]`, return a list of
// reason labels that match.
//
// This is the operator-owned regex escape hatch that complements the
// structured `hard_blockers` module (RFC 039 / BL-89). Where `hard_blockers`
// encodes three typed shapes (skill + co-occurrence, years cap, cert deny),
// `requirement_blockers` lets the operator write a regex with a kebab-case
// label and drop a matching row pre-SKILL. Each label surfaces as a TSV
// `skip_reason=requirement_blocker:<reason>` value.
//
// Architectural rule (mirrors hard_blockers): a row that returns a non-empty
// array from `applyRequirementBlockers` NEVER reaches the SKILL, NEVER gets
// a `fit_score`, and NEVER lands in Notion. The engine archives it pre-SKILL
// via the RFC 035 archive path.
//
// See RFC 046 §3 for the schema and §4 for the wiring contract.

// Kebab-case label validator (RFC 046 §3.1 / §10.4). 1-40 chars after the
// leading lowercase letter. No underscores; underscores are reserved for
// engine-internal reason families (`geo_metro_miss`, `cert_required`).
const REASON_LABEL_RE = /^[a-z][a-z0-9-]{1,40}$/;

const ALLOWED_MATCH_IN = new Set([
  "requirements",
  "responsibilities",
  "full_text_excerpt",
]);

const DEFAULT_MATCH_IN = ["requirements", "full_text_excerpt"];
const DEFAULT_FLAGS = "i";

/**
 * @typedef {Object} RequirementBlockerPattern
 * @property {string} pattern              Regex source.
 * @property {string} [flags]              Regex flags, default "i".
 * @property {string} reason               Kebab-case label.
 * @property {string[]} [match_in]         Default ["requirements", "full_text_excerpt"].
 */

/**
 * @typedef {Object} CompiledPattern
 * @property {RegExp} pattern              Compiled regex.
 * @property {string} reason               Kebab-case label.
 * @property {string[]} match_in           Validated subset of ALLOWED_MATCH_IN.
 */

/**
 * @typedef {Object} CompileError
 * @property {string} pattern              Original source (may be undefined / empty).
 * @property {string} reason               Original reason (may be undefined / empty).
 * @property {string} error                Human-readable diagnostic.
 */

/**
 * Compile raw patterns from `filter_rules.requirement_blockers.patterns[]`.
 * Malformed entries are dropped with a stderr warning AND surfaced in
 * `errors[]` so the caller can record a stats counter
 * (`prepare_context.stats.requirement_blocker_pattern_errors`, RFC 046 §10.6).
 * The function never throws — operator-edited config should not crash the
 * pipeline.
 *
 * @param {RequirementBlockerPattern[]} rawPatterns
 * @returns {{compiled: CompiledPattern[], errors: CompileError[]}}
 */
function compilePatterns(rawPatterns) {
  const compiled = [];
  const errors = [];
  if (!Array.isArray(rawPatterns)) {
    return { compiled, errors };
  }

  for (const raw of rawPatterns) {
    if (!raw || typeof raw !== "object") {
      const err = {
        pattern: "",
        reason: "",
        error: "entry is not an object",
      };
      errors.push(err);
      warn(err);
      continue;
    }

    const source = typeof raw.pattern === "string" ? raw.pattern : "";
    const reason = typeof raw.reason === "string" ? raw.reason : "";
    const flags = typeof raw.flags === "string" ? raw.flags : DEFAULT_FLAGS;

    // Validate reason FIRST so we emit a clean diagnostic even if the regex
    // is also malformed.
    if (!REASON_LABEL_RE.test(reason)) {
      const err = {
        pattern: source,
        reason,
        error: `invalid reason label '${reason}' (must match /^[a-z][a-z0-9-]{1,40}$/)`,
      };
      errors.push(err);
      warn(err);
      continue;
    }

    if (!source) {
      const err = {
        pattern: source,
        reason,
        error: "pattern source is empty",
      };
      errors.push(err);
      warn(err);
      continue;
    }

    let re;
    try {
      re = new RegExp(source, flags);
    } catch (e) {
      const err = {
        pattern: source,
        reason,
        error: `invalid regex: ${e instanceof Error ? e.message : String(e)}`,
      };
      errors.push(err);
      warn(err);
      continue;
    }

    // Validate match_in. Unknown field names are dropped; if the array ends
    // up empty, the whole pattern is dropped.
    let matchIn;
    if (raw.match_in === undefined || raw.match_in === null) {
      matchIn = DEFAULT_MATCH_IN.slice();
    } else if (Array.isArray(raw.match_in)) {
      matchIn = [];
      for (const field of raw.match_in) {
        if (typeof field === "string" && ALLOWED_MATCH_IN.has(field)) {
          matchIn.push(field);
        }
      }
      if (matchIn.length === 0) {
        const err = {
          pattern: source,
          reason,
          error: "match_in had no valid entries (allowed: requirements / responsibilities / full_text_excerpt)",
        };
        errors.push(err);
        warn(err);
        continue;
      }
    } else {
      const err = {
        pattern: source,
        reason,
        error: "match_in must be an array of strings",
      };
      errors.push(err);
      warn(err);
      continue;
    }

    compiled.push({ pattern: re, reason, match_in: matchIn });
  }

  return { compiled, errors };
}

/**
 * Apply a compiled pattern set to a single structured JD. Returns the first
 * hit's `reason` (RFC 046 §4.3 first-match-wins) plus the matched pattern
 * source for diagnostics; if no pattern matches, `hit=false`.
 *
 * NB: per §10.5 precedence rule the engine calls `findHardBlockers` first
 * and only invokes this function for rows that survived. This module owns
 * the pure regex match logic; the integration glue (prepare.js) owns the
 * ordering between the two blocker families.
 *
 * @param {object} jdStructure        Output of `extractJDStructure`.
 * @param {string[]} [jdStructure.requirements]
 * @param {string[]} [jdStructure.responsibilities]
 * @param {string} [jdStructure.full_text_excerpt]
 * @param {CompiledPattern[]} compiledPatterns
 * @returns {{hit: boolean, reason: (string|null), matched_pattern: (string|null)}}
 */
function applyRequirementBlockers(jdStructure, compiledPatterns) {
  const empty = { hit: false, reason: null, matched_pattern: null };
  if (!jdStructure || !Array.isArray(compiledPatterns) || compiledPatterns.length === 0) {
    return empty;
  }

  // Pre-compute per-field text once per row.
  const requirementsArr = Array.isArray(jdStructure.requirements)
    ? jdStructure.requirements
    : [];
  const responsibilitiesArr = Array.isArray(jdStructure.responsibilities)
    ? jdStructure.responsibilities
    : [];
  const excerpt =
    typeof jdStructure.full_text_excerpt === "string"
      ? jdStructure.full_text_excerpt
      : "";

  const requirementsText = requirementsArr.join("\n");
  const responsibilitiesText = responsibilitiesArr.join("\n");

  // Defensive: no JD text at all → no match (mirrors hard_blockers §4.4).
  if (!requirementsText && !responsibilitiesText && !excerpt) {
    return empty;
  }

  for (const compiled of compiledPatterns) {
    for (const field of compiled.match_in) {
      let text;
      if (field === "requirements") text = requirementsText;
      else if (field === "responsibilities") text = responsibilitiesText;
      else if (field === "full_text_excerpt") text = excerpt;
      else continue; // defensive: validator should have stripped these.
      if (!text) continue;
      if (compiled.pattern.test(text)) {
        return {
          hit: true,
          reason: compiled.reason,
          matched_pattern: compiled.pattern.source,
        };
      }
    }
  }

  return empty;
}

function warn(err) {
  // eslint-disable-next-line no-console -- stderr warning is the contract.
  console.error(
    `[requirement_blockers] dropped pattern (reason='${err.reason || ""}'): ${err.error}`
  );
}

module.exports = {
  compilePatterns,
  applyRequirementBlockers,
  // Exported for tests; not part of the stable contract.
  REASON_LABEL_RE,
  ALLOWED_MATCH_IN,
  DEFAULT_MATCH_IN,
  DEFAULT_FLAGS,
};
