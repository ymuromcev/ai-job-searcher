// generators/profile_json.js — intake → profile.json
//
// Takes parsed intake (see parse_intake.js) and produces the JSON that lives
// at profiles/<id>/profile.json. Does NOT write to disk — returns the object.
// The orchestrator writes.

const { resolvePropertyMap } = require("../property_map.js");
const { extractNotionPageId } = require("../_common.js");

// Default modules for a new profile if intake doesn't specify.
const DEFAULT_MODULES = [
  "discovery:greenhouse",
  "discovery:lever",
  "discovery:ashby",
  "discovery:smartrecruiters",
  "discovery:workday",
];

function buildCompanyTiers(companies = {}) {
  const tiers = {};
  for (const [tierKey, letter] of [
    ["tier_s", "S"],
    ["tier_a", "A"],
    ["tier_b", "B"],
    ["tier_c", "C"],
  ]) {
    const list = companies[tierKey];
    if (!Array.isArray(list)) continue;
    for (const name of list) {
      // Later tiers don't override earlier — duplicates get the first tier.
      if (!tiers[name]) tiers[name] = letter;
    }
  }
  return tiers;
}

function buildIdentity(intake = {}) {
  const src = intake.identity || {};
  const out = {
    name: (src.full_name || "").trim().toUpperCase(),
    phone: src.phone || "",
    location: [src.location_city, src.location_state].filter(Boolean).join(", "),
    email: src.email || "",
    linkedin: src.linkedin || "",
  };
  if (src.personal_site) out.personal_site = src.personal_site;
  if (src.pronouns) out.pronouns = src.pronouns;
  if (src.location_country && src.location_country.toUpperCase() !== "US") {
    out.country = src.location_country.toUpperCase();
  }
  return out;
}

function buildProfileJson(intake) {
  if (!intake || !intake.identity || !intake.identity.profile_id) {
    throw new Error("buildProfileJson: intake.identity.profile_id is required");
  }
  const id = intake.identity.profile_id;
  const modules = intake.modules && intake.modules.length
    ? intake.modules.slice()
    : DEFAULT_MODULES.slice();

  const propertyMap = resolvePropertyMap(intake);
  const notionParentId = extractNotionPageId(
    (intake.notion && intake.notion.parent_page_url) || ""
  );

  const profile = {
    id,
    identity: buildIdentity(intake),
    modules,
    discovery: {
      companies_whitelist: null,
      companies_blacklist: [],
    },
    filter_rules_file: "filter_rules.json",
    resume: {
      versions_file: "resume_versions.json",
      output_dir: "resumes",
      master_format: "docx",
    },
    cover_letter: {
      config_file: "cover_letter_versions.json",
      template_file: "cover_letter_template.md",
      output_dir: "cover_letters",
    },
    company_tiers: buildCompanyTiers(intake.companies || {}),
    notion: {
      workspace_page_id: notionParentId,
      // jobs_pipeline_db_id + companies_db_id filled in after DB creation.
      property_map: propertyMap,
    },
  };

  // Pass-through hints that don't have a dedicated structure yet but are
  // useful for future commands / humans reading profile.json.
  const hints = {};
  if (intake.preferences) {
    if (intake.preferences.salary_min_total_comp !== undefined) {
      hints.salary_min_total_comp = intake.preferences.salary_min_total_comp;
    }
    if (intake.preferences.salary_ideal_total_comp !== undefined) {
      hints.salary_ideal_total_comp = intake.preferences.salary_ideal_total_comp;
    }
    if (intake.preferences.salary_currency) {
      hints.salary_currency = intake.preferences.salary_currency;
    }
    if (intake.preferences.work_format) {
      hints.work_format = intake.preferences.work_format;
    }
    if (intake.preferences.locations_ok) {
      hints.locations_ok = intake.preferences.locations_ok;
    }
  }
  if (intake.career) {
    if (intake.career.target_roles) hints.target_roles = intake.career.target_roles;
    if (intake.career.level) hints.level = intake.career.level;
    if (intake.career.seniority) hints.seniority = intake.career.seniority;
    if (intake.career.years_experience !== undefined) {
      hints.years_experience = intake.career.years_experience;
    }
  }
  if (Object.keys(hints).length) profile.preferences = hints;

  return profile;
}

module.exports = { buildProfileJson, buildCompanyTiers, buildIdentity, DEFAULT_MODULES };
