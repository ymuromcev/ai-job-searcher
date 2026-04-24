const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildFilterRules } = require("./filter_rules.js");

test("buildFilterRules: empty intake → baseline only", () => {
  const rules = buildFilterRules({});
  assert.deepEqual(rules.company_blocklist, []);
  assert.deepEqual(rules.location_blocklist, []);
  // Baseline title patterns always present
  const patterns = rules.title_blocklist.map((t) => t.pattern);
  assert.ok(patterns.includes("intern"));
  assert.ok(patterns.includes("internship"));
});

test("buildFilterRules: user-provided blocklists lowercased + merged with baseline", () => {
  const rules = buildFilterRules({
    career: { title_blocklist: ["Director", "VP", "Staff Engineer"] },
    preferences: { location_blocklist: ["New York", "Seattle"] },
    companies: { company_blocklist: ["Palantir", "Deloitte"] },
  });
  assert.deepEqual(rules.company_blocklist, ["Palantir", "Deloitte"]);
  assert.deepEqual(rules.location_blocklist, ["New York", "Seattle"]);
  const patterns = rules.title_blocklist.map((t) => t.pattern);
  assert.ok(patterns.includes("director"));
  assert.ok(patterns.includes("vp"));
  assert.ok(patterns.includes("staff engineer"));
  assert.ok(patterns.includes("intern")); // baseline retained
});

test("buildFilterRules: dedupes overlap between user + baseline", () => {
  const rules = buildFilterRules({
    career: { title_blocklist: ["Intern", "intern"] },
  });
  const patterns = rules.title_blocklist.map((t) => t.pattern);
  assert.equal(patterns.filter((p) => p === "intern").length, 1);
});

test("buildFilterRules: tolerates missing sub-objects", () => {
  assert.doesNotThrow(() => buildFilterRules({ career: null }));
  assert.doesNotThrow(() => buildFilterRules({ preferences: null }));
  assert.doesNotThrow(() => buildFilterRules({ companies: null }));
});

test("buildFilterRules: each title entry has {pattern, reason}", () => {
  const rules = buildFilterRules({ career: { title_blocklist: ["VP"] } });
  for (const t of rules.title_blocklist) {
    assert.equal(typeof t.pattern, "string");
    assert.equal(typeof t.reason, "string");
  }
});
