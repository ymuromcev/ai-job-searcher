// generators/filter_rules.js — intake → filter_rules.json
//
// Emits the canonical flat shape consumed by engine/core/filter.js:
//   { company_blocklist: [names], title_blocklist: [{pattern, reason}],
//     location_blocklist: [strings], role_targets: { tracks: [...] } }
// (profile_loader normalizes the nested prototype shape too, but new
// profiles should start in the canonical shape.)
//
// RFC 033: role_targets is required. The generator throws when the intake
// doesn't carry at least one track with a populated pattern list. This is
// belt-and-suspenders — validateIntake already catches the same case at
// step 0 — but it keeps a stray code path from emitting an unusable
// filter_rules.json.

// Title patterns we always want to filter regardless of user input.
// These are universal "not a PM/IC-track role" signals that every engine
// command already expects to be screened out. User's title_blocklist is
// additive on top.
const BASELINE_TITLE_PATTERNS = [
  { pattern: "intern", reason: "internship" },
  { pattern: "internship", reason: "internship" },
];

function buildRoleTargets(intake) {
  const rawTracks = Array.isArray(intake.role_targets) ? intake.role_targets : [];
  const tracks = rawTracks
    .filter((t) => t && t.id && Array.isArray(t.patterns) && t.patterns.length)
    .map((t) => {
      const trackId = String(t.id).trim();
      // De-dupe patterns within the track (case-insensitive). Symmetric to
      // how title_blocklist is deduped below.
      const seen = new Set();
      const patterns = [];
      for (const raw of t.patterns) {
        const p = String(raw).trim().toLowerCase();
        if (!p || seen.has(p)) continue;
        seen.add(p);
        patterns.push({ pattern: p, reason: `role track: ${trackId}` });
      }
      const out = {
        id: trackId,
        name: t.name ? String(t.name).trim() : trackId,
        fit_treatment: t.fit_treatment === "bridge" ? "bridge" : "primary",
        patterns,
      };
      if (t.bridge_note) out.bridge_note = String(t.bridge_note).trim();
      return out;
    })
    .filter((t) => t.patterns.length);
  if (!tracks.length) {
    throw new Error(
      "intake.role_targets is empty — every profile needs at least one " +
        "track with one or more title patterns (RFC 033)"
    );
  }
  return { fit_treatments: {}, tracks };
}

function buildFilterRules(intake = {}) {
  const career = intake.career || {};
  const prefs = intake.preferences || {};
  const companies = intake.companies || {};

  const companyBlocklist = Array.isArray(companies.company_blocklist)
    ? companies.company_blocklist.map((s) => String(s).trim()).filter(Boolean)
    : [];

  const userTitles = Array.isArray(career.title_blocklist) ? career.title_blocklist : [];
  const titleBlocklist = [
    ...BASELINE_TITLE_PATTERNS,
    ...userTitles
      .map((t) => ({
        pattern: String(t).trim().toLowerCase(),
        reason: "user title blocklist",
      }))
      .filter((p) => p.pattern.length),
  ];
  // De-dupe by pattern.
  const seen = new Set();
  const dedupedTitles = [];
  for (const t of titleBlocklist) {
    if (seen.has(t.pattern)) continue;
    seen.add(t.pattern);
    dedupedTitles.push(t);
  }

  const locationBlocklist = Array.isArray(prefs.location_blocklist)
    ? prefs.location_blocklist.map((s) => String(s).trim()).filter(Boolean)
    : [];

  return {
    company_blocklist: companyBlocklist,
    title_blocklist: dedupedTitles,
    location_blocklist: locationBlocklist,
    role_targets: buildRoleTargets(intake),
  };
}

module.exports = { buildFilterRules, buildRoleTargets, BASELINE_TITLE_PATTERNS };
