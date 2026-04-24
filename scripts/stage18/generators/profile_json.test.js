const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildProfileJson, buildCompanyTiers, buildIdentity } = require("./profile_json.js");

const MINIMAL_INTAKE = {
  identity: {
    profile_id: "profile_b",
    full_name: "Pat Example",
    email: "pat@example.com",
    phone: "+1 555 0199",
    location_city: "Sacramento",
    location_state: "CA",
    location_country: "US",
    linkedin: "linkedin.com/in/pat",
  },
  notion: {
    parent_page_url: "https://www.notion.so/Pat-00000000000000000000000000000000",
  },
  modules: ["discovery:greenhouse", "discovery:lever"],
};

test("buildIdentity formats name uppercase + location city+state", () => {
  const id = buildIdentity(MINIMAL_INTAKE);
  assert.equal(id.name, "PAT EXAMPLE");
  assert.equal(id.location, "Sacramento, CA");
  assert.equal(id.email, "pat@example.com");
});

test("buildIdentity emits country only for non-US", () => {
  const ua = buildIdentity({
    identity: { full_name: "X", location_country: "UA", location_city: "Kyiv" },
  });
  assert.equal(ua.country, "UA");
  const us = buildIdentity({
    identity: { full_name: "X", location_country: "us" },
  });
  assert.equal(us.country, undefined);
});

test("buildIdentity passes through optional pronouns / personal_site", () => {
  const id = buildIdentity({
    identity: {
      full_name: "X",
      pronouns: "she/her",
      personal_site: "https://x.io",
    },
  });
  assert.equal(id.pronouns, "she/her");
  assert.equal(id.personal_site, "https://x.io");
});

test("buildCompanyTiers collapses tier lists to flat {name: letter}", () => {
  const tiers = buildCompanyTiers({
    tier_s: ["Stripe", "Ramp"],
    tier_a: ["Mercury"],
    tier_b: [],
    tier_c: ["Tala", "Stripe"], // Stripe is already S — should NOT downgrade
  });
  assert.deepEqual(tiers, {
    Stripe: "S",
    Ramp: "S",
    Mercury: "A",
    Tala: "C",
  });
});

test("buildProfileJson: minimal intake produces valid shape", () => {
  const profile = buildProfileJson(MINIMAL_INTAKE);
  assert.equal(profile.id, "profile_b");
  assert.equal(profile.identity.name, "PAT EXAMPLE");
  assert.deepEqual(profile.modules, ["discovery:greenhouse", "discovery:lever"]);
  assert.equal(profile.filter_rules_file, "filter_rules.json");
  assert.equal(profile.notion.workspace_page_id, "00000000-0000-0000-0000-000000000000");
  assert.ok(profile.notion.property_map.title);
  assert.ok(profile.notion.property_map.url);
  assert.equal(profile.notion.jobs_pipeline_db_id, undefined); // set later
});

test("buildProfileJson: fallback modules when intake has none", () => {
  const profile = buildProfileJson({
    ...MINIMAL_INTAKE,
    modules: [],
  });
  assert.ok(profile.modules.length >= 3);
  assert.ok(profile.modules.includes("discovery:greenhouse"));
});

test("buildProfileJson: company_tiers populated when intake provides", () => {
  const profile = buildProfileJson({
    ...MINIMAL_INTAKE,
    companies: { tier_s: ["Stripe"], tier_a: ["Ramp"] },
  });
  assert.equal(profile.company_tiers.Stripe, "S");
  assert.equal(profile.company_tiers.Ramp, "A");
});

test("buildProfileJson: preferences hints included when provided", () => {
  const profile = buildProfileJson({
    ...MINIMAL_INTAKE,
    preferences: {
      salary_min_total_comp: 180000,
      salary_ideal_total_comp: 220000,
      salary_currency: "USD",
      work_format: "remote",
      locations_ok: ["Remote (US)"],
    },
    career: {
      target_roles: ["PM"],
      years_experience: 8,
      level: "Senior IC",
      seniority: "senior",
    },
  });
  assert.equal(profile.preferences.salary_min_total_comp, 180000);
  assert.deepEqual(profile.preferences.target_roles, ["PM"]);
  assert.equal(profile.preferences.years_experience, 8);
});

test("buildProfileJson: rejects missing profile_id", () => {
  assert.throws(() => buildProfileJson({ identity: {} }));
  assert.throws(() => buildProfileJson({}));
  assert.throws(() => buildProfileJson(null));
});

test("buildProfileJson: CalCareers modules gate schema fields into property_map", () => {
  const pWithout = buildProfileJson(MINIMAL_INTAKE);
  assert.equal(pWithout.notion.property_map.classification, undefined);

  const pWith = buildProfileJson({
    ...MINIMAL_INTAKE,
    modules: [...MINIMAL_INTAKE.modules, "discovery:calcareers"],
  });
  assert.ok(pWith.notion.property_map.classification);
});
