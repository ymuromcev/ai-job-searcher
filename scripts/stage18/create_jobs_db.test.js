const { test } = require("node:test");
const assert = require("node:assert/strict");

const { injectCompaniesDbId, jobsDbTitle } = require("./create_jobs_db.js");
const { resolvePropertyMap, toNotionSchema } = require("./property_map.js");

test("injectCompaniesDbId replaces placeholder with actual db id", () => {
  const schema = toNotionSchema(resolvePropertyMap({}));
  const before = schema.Company.relation.database_id;
  assert.equal(before, "__COMPANIES_DB__");
  const after = injectCompaniesDbId(schema, "abc-123");
  assert.equal(after.Company.relation.database_id, "abc-123");
  assert.equal(after.Company.relation.type, "single_property");
  assert.deepEqual(after.Company.relation.single_property, {});
});

test("injectCompaniesDbId leaves non-relation fields alone", () => {
  const schema = toNotionSchema(resolvePropertyMap({}));
  const after = injectCompaniesDbId(schema, "abc-123");
  assert.equal(after.URL.type, "url");
  assert.equal(after.Status.type, "status");
  assert.equal(after.Title.type, "title");
});

test("jobsDbTitle composes from full_name or falls back to profile_id", () => {
  assert.equal(
    jobsDbTitle({ identity: { full_name: "Pat Example", profile_id: "profile_b" } }),
    "Pat Example — Jobs Pipeline"
  );
  assert.equal(
    jobsDbTitle({ identity: { profile_id: "profile_b" } }),
    "profile_b — Jobs Pipeline"
  );
});
