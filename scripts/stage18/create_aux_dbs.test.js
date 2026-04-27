const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  QA_PROPERTIES,
  PLATFORMS_PROPERTIES,
  ADAPTER_PRESETS,
  modulesToPlatformRows,
  buildPlatformPageProperties,
  qaTitle,
  platformsTitle,
} = require("./create_aux_dbs.js");

// ---------------------------------------------------------------------------
// Schema shape
// ---------------------------------------------------------------------------

test("QA_PROPERTIES: required props present with correct types", () => {
  assert.equal(QA_PROPERTIES.Question.type, "title");
  assert.equal(QA_PROPERTIES.Answer.type, "rich_text");
  assert.equal(QA_PROPERTIES.Category.type, "select");
  assert.equal(QA_PROPERTIES.Company.type, "rich_text");
  assert.equal(QA_PROPERTIES.Role.type, "rich_text");
  assert.equal(QA_PROPERTIES.Notes.type, "rich_text");

  const cats = QA_PROPERTIES.Category.select.options.map((o) => o.name);
  assert.ok(cats.includes("Behavioral"));
  assert.ok(cats.includes("Technical"));
  assert.ok(cats.includes("Salary"));
});

test("PLATFORMS_PROPERTIES: required props present, generic 'Roles Found' (not 'PM Roles Found')", () => {
  assert.equal(PLATFORMS_PROPERTIES.Platform.type, "title");
  assert.equal(PLATFORMS_PROPERTIES.Type.type, "select");
  assert.equal(PLATFORMS_PROPERTIES.Status.type, "select");
  assert.equal(PLATFORMS_PROPERTIES["API URL Template"].type, "rich_text");
  assert.equal(PLATFORMS_PROPERTIES["Roles Found"].type, "number");
  assert.equal(PLATFORMS_PROPERTIES["Last Scan"].type, "date");

  // PM Roles Found is the legacy Jared-specific name; we use generic "Roles Found"
  assert.ok(!("PM Roles Found" in PLATFORMS_PROPERTIES));

  const types = PLATFORMS_PROPERTIES.Type.select.options.map((o) => o.name);
  for (const t of ["ATS", "Job Board", "Aggregator", "Government"]) {
    assert.ok(types.includes(t), `Type missing option ${t}`);
  }
});

// ---------------------------------------------------------------------------
// modulesToPlatformRows
// ---------------------------------------------------------------------------

test("modulesToPlatformRows: maps known discovery: adapters", () => {
  const rows = modulesToPlatformRows([
    "discovery:greenhouse",
    "discovery:lever",
    "discovery:ashby",
    "discovery:remoteok",
  ]);
  assert.equal(rows.length, 4);
  const names = rows.map((r) => r.Platform);
  assert.deepEqual(names, ["Greenhouse", "Lever", "Ashby", "RemoteOK"]);
  assert.equal(rows[0].Type, "ATS");
  assert.equal(rows[3].Type, "Aggregator");
  for (const r of rows) {
    assert.equal(r.Status, "Active");
    assert.ok(r["API URL Template"]);
    assert.ok(r.Notes.includes("Discovery adapter"));
  }
});

test("modulesToPlatformRows: skips unknown adapters and non-discovery modules", () => {
  const rows = modulesToPlatformRows([
    "discovery:greenhouse",
    "discovery:never_existed",
    "tracking:gmail",
    "not-a-module",
    "",
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Platform, "Greenhouse");
});

test("modulesToPlatformRows: defensive on non-array", () => {
  assert.deepEqual(modulesToPlatformRows(undefined), []);
  assert.deepEqual(modulesToPlatformRows(null), []);
  assert.deepEqual(modulesToPlatformRows({}), []);
  assert.deepEqual(modulesToPlatformRows("greenhouse"), []);
});

test("modulesToPlatformRows: every preset has required fields", () => {
  for (const [key, preset] of Object.entries(ADAPTER_PRESETS)) {
    assert.ok(preset.name, `${key} missing name`);
    assert.ok(preset.type, `${key} missing type`);
    assert.ok(preset.apiTemplate, `${key} missing apiTemplate`);
    assert.ok(
      ["ATS", "Job Board", "Aggregator", "Government"].includes(preset.type),
      `${key} has invalid type ${preset.type}`
    );
  }
});

// ---------------------------------------------------------------------------
// buildPlatformPageProperties
// ---------------------------------------------------------------------------

test("buildPlatformPageProperties: produces Notion-shaped page properties", () => {
  const row = {
    Platform: "Greenhouse",
    Type: "ATS",
    Status: "Active",
    "API URL Template": "https://api.example.com/{slug}",
    Notes: "An ATS",
  };
  const props = buildPlatformPageProperties(row);
  assert.equal(props.Platform.title[0].text.content, "Greenhouse");
  assert.equal(props.Type.select.name, "ATS");
  assert.equal(props.Status.select.name, "Active");
  assert.equal(props["API URL Template"].rich_text[0].text.content, "https://api.example.com/{slug}");
  assert.equal(props.Notes.rich_text[0].text.content, "An ATS");
});

test("buildPlatformPageProperties: handles missing optional fields", () => {
  const props = buildPlatformPageProperties({
    Platform: "Foo",
    Type: "ATS",
    Status: "Active",
  });
  assert.equal(props["API URL Template"].rich_text[0].text.content, "");
  assert.equal(props.Notes.rich_text[0].text.content, "");
});

// ---------------------------------------------------------------------------
// Title builders
// ---------------------------------------------------------------------------

test("qaTitle / platformsTitle: prefer full_name; fall back to profile_id", () => {
  const intake1 = { identity: { profile_id: "alex", full_name: "Alex Example" } };
  assert.equal(qaTitle(intake1), "Alex Example — Application Q&A");
  assert.equal(platformsTitle(intake1), "Alex Example — Job Platforms");

  const intake2 = { identity: { profile_id: "anonymous" } };
  assert.equal(qaTitle(intake2), "anonymous — Application Q&A");
  assert.equal(platformsTitle(intake2), "anonymous — Job Platforms");
});
