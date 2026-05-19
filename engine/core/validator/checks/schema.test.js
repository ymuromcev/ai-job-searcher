const { test } = require("node:test");
const assert = require("node:assert/strict");

const { runSchemaChecks, UUID_RE } = require("./schema.js");

function fr(overrides = {}) {
  return {
    company_blocklist: [],
    title_blocklist: [],
    title_requirelist: [],
    location_blocklist: [],
    role_targets: null,
    ...overrides,
  };
}

test("schema: passes a minimal profile (no rules)", () => {
  const issues = runSchemaChecks({ filterRules: fr() });
  assert.deepEqual(issues, []);
});

test("schema: role_targets track with bad regex → error", () => {
  const profile = {
    filterRules: fr({
      role_targets: {
        tracks: [
          {
            id: "pm",
            name: "PM",
            patterns: [{ pattern: "product (manager|owner" }], // unbalanced
            fit_treatment: "primary",
          },
        ],
        fit_treatments: {},
      },
    }),
  };
  const issues = runSchemaChecks(profile);
  const err = issues.find((i) => i.field.includes("patterns[0].pattern"));
  assert.ok(err, "expected regex error");
  assert.equal(err.severity, "error");
  assert.match(err.message, /invalid regex/);
});

test("schema: role_targets track with empty patterns → error", () => {
  const profile = {
    filterRules: fr({
      role_targets: {
        tracks: [{ id: "pm", name: "PM", patterns: [], fit_treatment: "primary" }],
        fit_treatments: {},
      },
    }),
  };
  const issues = runSchemaChecks(profile);
  const err = issues.find(
    (i) => i.field === "filter_rules.role_targets.tracks[0].patterns" && i.message.includes("empty")
  );
  assert.ok(err);
  assert.equal(err.severity, "error");
});

test("schema: role_targets track with bad fit_treatment → error", () => {
  const profile = {
    filterRules: fr({
      role_targets: {
        tracks: [
          { id: "pm", name: "PM", patterns: [{ pattern: "manager" }], fit_treatment: "weird" },
        ],
        fit_treatments: {},
      },
    }),
  };
  const issues = runSchemaChecks(profile);
  const err = issues.find((i) => i.field.endsWith(".fit_treatment"));
  assert.ok(err);
  assert.equal(err.severity, "error");
});

test("schema: title_blocklist with bad regex → error", () => {
  const profile = { filterRules: fr({ title_blocklist: [{ pattern: "(unclosed" }] }) };
  const issues = runSchemaChecks(profile);
  const err = issues.find((i) => i.field.startsWith("filter_rules.title_blocklist[0]"));
  assert.ok(err);
  assert.equal(err.severity, "error");
});

test("schema: title_blocklist entries that compile → pass", () => {
  const profile = {
    filterRules: fr({
      title_blocklist: [{ pattern: "intern" }, { pattern: "^staff\\s" }],
    }),
  };
  const issues = runSchemaChecks(profile);
  assert.deepEqual(issues, []);
});

test("schema: location_blocklist with regex anchors → warn", () => {
  const profile = {
    filterRules: fr({ location_blocklist: ["^Bengaluru$", "India", "\\bChina\\b"] }),
  };
  const issues = runSchemaChecks(profile);
  const warns = issues.filter((i) => i.severity === "warn");
  assert.equal(warns.length, 2); // ^Bengaluru$ and \bChina\b
  assert.ok(warns.every((w) => w.category === "schema"));
});

test("schema: location_blocklist plain strings → no issues", () => {
  const profile = { filterRules: fr({ location_blocklist: ["Bengaluru", "India"] }) };
  assert.deepEqual(runSchemaChecks(profile), []);
});

test("schema: company_cap.max_active negative → error", () => {
  const profile = { filterRules: fr({ company_cap: { max_active: -1 } }) };
  const issues = runSchemaChecks(profile);
  const err = issues.find((i) => i.field === "filter_rules.company_cap.max_active");
  assert.ok(err);
  assert.equal(err.severity, "error");
});

test("schema: company_cap.max_active integer ≥ 0 → no issue", () => {
  const profile = { filterRules: fr({ company_cap: { max_active: 3 } }) };
  assert.deepEqual(runSchemaChecks(profile), []);
});

test("schema: notion.jobs_pipeline_db_id non-UUID → error", () => {
  const profile = {
    filterRules: fr(),
    notion: { jobs_pipeline_db_id: "REPLACE_WITH_YOUR_NOTION_DATABASE_ID" },
  };
  const issues = runSchemaChecks(profile);
  const err = issues.find((i) => i.field === "profile.notion.jobs_pipeline_db_id");
  assert.ok(err);
  assert.equal(err.severity, "error");
});

test("schema: notion.jobs_pipeline_db_id valid UUID → no issue (dashed and un-dashed)", () => {
  for (const id of ["12345678-1234-1234-1234-1234567890ab", "1234567812341234123412345678AB12"]) {
    assert.ok(UUID_RE.test(id));
    const profile = { filterRules: fr(), notion: { jobs_pipeline_db_id: id } };
    assert.deepEqual(runSchemaChecks(profile), []);
  }
});

test("schema: notion.property_map entry missing `field` → error", () => {
  const profile = {
    filterRules: fr(),
    notion: {
      jobs_pipeline_db_id: "12345678-1234-1234-1234-1234567890ab",
      property_map: {
        title: { field: "Title", type: "title" },
        url: { type: "url" }, // missing field
      },
    },
  };
  const issues = runSchemaChecks(profile);
  const err = issues.find((i) => i.field === "profile.notion.property_map.url.field");
  assert.ok(err);
  assert.equal(err.severity, "error");
});

test("schema: geo.mode invalid value → error", () => {
  const profile = { filterRules: fr(), geo: { mode: "everywhere" } };
  const issues = runSchemaChecks(profile);
  const err = issues.find((i) => i.field === "profile.geo.mode");
  assert.ok(err);
  assert.equal(err.severity, "error");
});

test("schema: empty profile is tolerated (no issues)", () => {
  assert.deepEqual(runSchemaChecks(null), []);
  assert.deepEqual(runSchemaChecks(undefined), []);
  assert.deepEqual(runSchemaChecks({}), []);
});
