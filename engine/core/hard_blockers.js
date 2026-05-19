// Hard-blocker module (RFC 039 §3.2 / BL-89).
//
// Pure function. Given a structured JD (from `jd_extract.extractJDStructure`)
// and a profile (with optional `filter_rules.hard_blockers` block), return
// the list of reason codes that disqualify the row.
//
// Reason codes (initial set):
//
//   - `required_skill_excluded:<skill>` — JD requires a skill on the
//     profile's `hard_blockers.required_skills_excluded` list. The "required"
//     part is enforced by a ±3-line co-occurrence rule (RFC 039 §7.4):
//     the skill pattern must hit within 3 lines of an N-years-or-more
//     qualifier or a `required/must have/strong` marker.
//
//   - `years_required_max_exceeded:<n>` — JD requires more years of
//     experience than the profile's `hard_blockers.years_required_max` cap.
//     Currently matches `\b1[5-9]\s*years\b` or `\b2[0-9]\s*years\b`.
//
//   - `cert_required:<cert>` — JD requires a license/cert from the
//     profile's `hard_blockers.cert_blockers` substring deny list.
//
// Architectural rule: a row that returns a non-empty array from
// `findHardBlockers` NEVER reaches the SKILL, NEVER gets a `fit_score`,
// and NEVER lands in Notion. The engine archives it pre-SKILL via the
// RFC 035 archive path. This is the code-level enforcement of the
// `feedback_pipeline_fit_score_arch` memory rule.

/**
 * Look up hard-blocker codes for a single JD against a profile's filter rules.
 *
 * @param {object} args
 * @param {{requirements: string[], responsibilities?: string[]}} args.structuredJD
 *        Structured JD payload (output of `extractJDStructure`). Only
 *        `requirements` is consulted today; `responsibilities` is reserved.
 * @param {object} [args.profile]  Profile object with `filterRules.hard_blockers`.
 * @param {string} [args.title]    Job title (currently unused; reserved for
 *                                 future title-only hard blockers).
 * @returns {string[]} Reason codes in order of appearance. Empty when no
 *                    blocker fires.
 */
function findHardBlockers({ structuredJD, profile, title } = {}) {
  // Defensive: no blocker config → never fire.
  const filterRules = profile && profile.filterRules ? profile.filterRules : null;
  const config = filterRules && filterRules.hard_blockers ? filterRules.hard_blockers : null;
  if (!config) return [];

  const requirementsArr = Array.isArray(structuredJD && structuredJD.requirements)
    ? structuredJD.requirements
    : [];
  if (requirementsArr.length === 0 && !config.cert_blockers && !config.years_required_max) {
    return [];
  }

  const codes = [];
  const requirementsText = requirementsArr.join("\n");
  const requirementsLower = requirementsText.toLowerCase();
  const lines = requirementsText.split("\n");

  // 1) required_skills_excluded — each entry { skill, patterns, min_years }.
  if (Array.isArray(config.required_skills_excluded)) {
    for (const entry of config.required_skills_excluded) {
      if (!entry || !entry.skill || !Array.isArray(entry.patterns)) continue;
      const minYears = Number.isFinite(entry.min_years) ? entry.min_years : 1;

      let fired = false;
      for (const patStr of entry.patterns) {
        if (typeof patStr !== "string" || !patStr) continue;
        let pat;
        try {
          pat = new RegExp(patStr, "i");
        } catch (_) {
          continue; // malformed pattern: skip rather than crash.
        }
        // Find every matching line index.
        for (let i = 0; i < lines.length; i++) {
          if (!pat.test(lines[i])) continue;
          if (lineHasRequiredQualifier(lines, i, minYears)) {
            fired = true;
            break;
          }
        }
        if (fired) break;
      }
      if (fired) codes.push(`required_skill_excluded:${entry.skill}`);
    }
  }

  // 2) years_required_max — global cap on N-years requirements.
  if (Number.isFinite(config.years_required_max)) {
    const cap = config.years_required_max;
    // Match `\b\d{1,2}\+?\s*years\b` and pick the largest. Same scope as the
    // hard-blocker check — `requirementsText`, not full JD body.
    const yearsRe = /\b(\d{1,2})\+?\s*years?\b/gi;
    let largest = 0;
    let m;
    while ((m = yearsRe.exec(requirementsLower)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > largest) largest = n;
    }
    if (largest > cap) codes.push(`years_required_max_exceeded:${largest}`);
  }

  // 3) cert_blockers — substring deny list applied to joined requirements.
  if (Array.isArray(config.cert_blockers) && config.cert_blockers.length > 0) {
    for (const cert of config.cert_blockers) {
      if (typeof cert !== "string" || !cert) continue;
      // Word-boundary so "RN" doesn't fire on "WARN" / "LEARN".
      let re;
      try {
        re = new RegExp(`\\b${escapeRegex(cert)}\\b`, "i");
      } catch (_) {
        continue;
      }
      if (re.test(requirementsText)) {
        codes.push(`cert_required:${cert}`);
      }
    }
  }

  return codes;
}

// ±3-line co-occurrence check (RFC 039 §7.4).
// A skill-pattern hit on line `i` counts as "required" iff any line in
// `[i-3, i+3]` contains:
//   - a year qualifier `\b<n>+? years\b` with n ≥ minYears, OR
//   - a strong marker (`required`, `must have`, `must-have`, `strong`,
//     `expert`, `proficient`).
// Lines tagged as "nice to have" / "a plus" / "preferred" / "bonus" /
// "ideal" do NOT count as required and are explicitly excluded.
const NICE_RE = /\b(nice to have|a plus|preferred|bonus|ideal)\b/i;
const STRONG_RE = /\b(required|must[\s-]?have[s]?|strong|expert|proficient)\b/i;
const YEARS_RE = /\b(\d{1,2})\+?\s*years?\b/i;

function lineHasRequiredQualifier(lines, idx, minYears) {
  const lo = Math.max(0, idx - 3);
  const hi = Math.min(lines.length - 1, idx + 3);

  // First, if the matching line itself is "nice to have", skip — even if a
  // neighboring line is required.
  if (NICE_RE.test(lines[idx])) return false;

  for (let j = lo; j <= hi; j++) {
    const line = lines[j];
    if (!line) continue;
    const yMatch = YEARS_RE.exec(line);
    if (yMatch) {
      const n = Number(yMatch[1]);
      if (Number.isFinite(n) && n >= minYears) return true;
    }
    if (STRONG_RE.test(line)) return true;
  }
  return false;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  findHardBlockers,
};
