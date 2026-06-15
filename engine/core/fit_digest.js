// Pure renderer for the fit digest (RFC 060, BL-192).
//
// Turns parsed storybank stories (see engine/core/storybank.js) into the compact
// markdown that drives fit scoring — `profiles/<id>/fit_profile.md`. The digest is
// what the fit evaluator compares a vacancy against, REPLACING the old
// hand-curated domain rubric (user_resume_key_points.md). A vacancy is:
//   Strong  — a JD requirement matches one of these achievements with its metric;
//   Medium  — partial / adjacent overlap;
//   Weak    — no real overlap.
//
// All achievements count regardless of `seed`/`confirmed`: that flag is the
// mock-review status of the interview narrative, not whether the achievement is
// real. Anti-inflation is the overlap rule + regression test, not strength gating.
//
// Pure: stories array in, string out (+ a content hash for freshness). No fs.

const crypto = require("crypto");

// Stable digest hash over the parsed stories — changes iff the achievement
// content changes, so a stale `fit_profile.md` can be detected and regenerated
// pre-prepare. Formatting noise in coaching_state.md does not move the hash
// because we hash the parsed objects, not the raw markdown.
function digestHash(stories) {
  const canonical = JSON.stringify(
    (stories || []).map((s) => ({
      id: s.id,
      title: s.title,
      primarySkill: s.primarySkill,
      secondarySkill: s.secondarySkill,
      commercialProfile: s.commercialProfile,
      strength: s.strength,
      deployFor: s.deployFor || [],
      result: s.result || "",
    }))
  );
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

function meaningful(value) {
  const v = (value || "").trim();
  if (!v) return false;
  return v.toUpperCase() !== "TBD";
}

function renderStory(s) {
  const lines = [`## ${s.id} — ${s.title}`];
  const skills = [s.primarySkill, s.secondarySkill].filter(Boolean).join(" · ");
  if (skills) lines.push(`- Skills: ${skills}`);
  if (meaningful(s.commercialProfile)) lines.push(`- Domain: ${s.commercialProfile}`);
  if (s.result) lines.push(`- Outcome: ${s.result}`);
  if (s.deployFor && s.deployFor.length) {
    lines.push(`- Matches: ${s.deployFor.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Render the fit digest markdown for a set of parsed storybank stories.
 *
 * @param {Array<object>} stories - output of parseStorybank()
 * @param {object} [opts]
 * @param {string} [opts.profileId] - for the generated header
 * @param {string} [opts.source]    - source path note for the header
 * @returns {string} fit_profile.md contents (deterministic — no timestamps)
 */
function buildFitDigest(stories, opts = {}) {
  if (!Array.isArray(stories)) {
    throw new Error("buildFitDigest: stories must be an array");
  }
  const profileId = opts.profileId || "profile";
  const source = opts.source || "interview-coach-state/coaching_state.md (## Storybank)";
  const hash = digestHash(stories);

  const header = [
    "<!-- GENERATED — do not edit by hand. Regenerate with:",
    `       node scripts/build_fit_profile.js --profile ${profileId} -->`,
    `<!-- source: ${source} -->`,
    `<!-- fit-digest-hash: ${hash} -->`,
    `<!-- stories: ${stories.length} -->`,
    "",
    `# Fit profile — real achievements (${profileId})`,
    "",
    "Score a vacancy by overlap with these REAL achievements. **Strong** = a JD",
    "requirement matches one of these achievements with its metric/outcome;",
    "**Medium** = partial or adjacent overlap; **Weak** = no real overlap. A",
    "vacancy that is not this profile at all is caught earlier by hard filters",
    "(certs / years / skills / title / geo / company-cap), not scored here.",
    "",
    "All achievements below count equally — `seed` and `confirmed` alike.",
    "",
  ].join("\n");

  const body = stories.map(renderStory).join("\n\n");
  return `${header}\n${body}\n`;
}

module.exports = { buildFitDigest, digestHash };
