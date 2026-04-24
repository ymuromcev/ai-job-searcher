const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolvePropertyMap,
  toNotionSchema,
  CORE_FIELDS,
} = require("./property_map.js");

test("resolvePropertyMap: core always present", () => {
  const pm = resolvePropertyMap({});
  for (const k of Object.keys(CORE_FIELDS)) {
    assert.ok(pm[k], `missing core field ${k}`);
  }
});

test("resolvePropertyMap: prepare+check are on by default (core commands)", () => {
  const pm = resolvePropertyMap({ modules: [] });
  // prepare-gated
  assert.ok(pm.salaryMin);
  assert.ok(pm.workFormat);
  assert.ok(pm.fitScore);
  // check-gated
  assert.ok(pm.lastFollowup);
  assert.ok(pm.nextFollowup);
});

test("resolvePropertyMap: calcareers fields gated on adapter presence", () => {
  const without = resolvePropertyMap({ modules: ["discovery:greenhouse"] });
  assert.equal(without.classification, undefined);
  assert.equal(without.soqRequired, undefined);

  const withIt = resolvePropertyMap({ modules: ["discovery:calcareers"] });
  assert.ok(withIt.classification);
  assert.ok(withIt.soqRequired);
  assert.ok(withIt.finalFilingDate);
});

test("resolvePropertyMap: watcher gated on explicit flag", () => {
  const off = resolvePropertyMap({});
  assert.equal(off.watcher, undefined);

  const on = resolvePropertyMap({ flags: { watcher_enabled: true } });
  assert.equal(on.watcher.field, "Watcher");
  assert.equal(on.watcher.type, "people");
});

test("resolvePropertyMap: second-profile-like minimal profile excludes CalCareers fields", () => {
  const pm = resolvePropertyMap({
    modules: [
      "discovery:greenhouse",
      "discovery:lever",
      "discovery:ashby",
    ],
    flags: { watcher_enabled: false },
  });
  // Core + prepare + check, no CalCareers/watcher
  assert.ok(pm.title && pm.url && pm.status);
  assert.ok(pm.salaryMin);
  assert.ok(pm.lastFollowup);
  assert.equal(pm.classification, undefined);
  assert.equal(pm.watcher, undefined);
});

// ---------- toNotionSchema ----------

test("toNotionSchema: emits Notion-native bodies for every type", () => {
  const pm = resolvePropertyMap({
    modules: ["discovery:calcareers"],
    flags: { watcher_enabled: true },
  });
  const schema = toNotionSchema(pm);
  assert.equal(schema.Title.type, "title");
  assert.equal(schema.URL.type, "url");
  assert.equal(schema.Notes.type, "rich_text");
  assert.equal(schema.Status.type, "status");
  assert.equal(schema["SOQ Required"].type, "checkbox");
  assert.equal(schema["Final Filing Date"].type, "date");
  assert.equal(schema.Watcher.type, "people");
  assert.equal(schema.Company.type, "relation");
});

test("toNotionSchema: Source select has sensible default options", () => {
  const pm = resolvePropertyMap({});
  const schema = toNotionSchema(pm);
  const names = schema.Source.select.options.map((o) => o.name);
  assert.ok(names.includes("greenhouse"));
  assert.ok(names.includes("lever"));
  assert.ok(names.includes("manual"));
});

test("toNotionSchema: Work Format + Fit Score seeded", () => {
  const pm = resolvePropertyMap({});
  const schema = toNotionSchema(pm);
  const wf = schema["Work Format"].select.options.map((o) => o.name);
  assert.deepEqual(wf.sort(), ["Any", "Hybrid", "Onsite", "Remote"]);
  const fit = schema["Fit Score"].select.options.map((o) => o.name);
  assert.deepEqual(fit.sort(), ["Medium", "Strong", "Weak"]);
});

test("toNotionSchema: Company relation emits placeholder db id", () => {
  const pm = resolvePropertyMap({});
  const schema = toNotionSchema(pm);
  assert.equal(schema.Company.type, "relation");
  assert.equal(schema.Company.relation.database_id, "__COMPANIES_DB__");
});

test("toNotionSchema: throws on unknown field type (defense)", () => {
  const bogus = { junk: { field: "Junk", type: "nonexistent" } };
  assert.throws(() => toNotionSchema(bogus));
});
