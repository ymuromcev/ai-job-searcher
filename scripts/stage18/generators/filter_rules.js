// generators/filter_rules.js — intake → filter_rules.json
//
// Emits the canonical flat shape consumed by engine/core/filter.js:
//   { company_blocklist: [names], title_blocklist: [{pattern, reason}], location_blocklist: [strings] }
// (profile_loader normalizes the nested prototype shape too, but new
// profiles should start in the canonical shape.)

// Title patterns we always want to filter regardless of user input.
// These are universal "not a PM/IC-track role" signals that every engine
// command already expects to be screened out. User's title_blocklist is
// additive on top.
const BASELINE_TITLE_PATTERNS = [
  { pattern: "intern", reason: "internship" },
  { pattern: "internship", reason: "internship" },
];

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
    ...userTitles.map((t) => ({
      pattern: String(t).trim().toLowerCase(),
      reason: "user title blocklist",
    })).filter((p) => p.pattern.length),
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
  };
}

module.exports = { buildFilterRules, BASELINE_TITLE_PATTERNS };
