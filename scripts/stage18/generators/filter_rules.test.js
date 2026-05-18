const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildFilterRules, buildRoleTargets } = require("./filter_rules.js");

// RFC 033: every test needs at least one valid role-track or buildFilterRules
// throws. This helper keeps the rest of the tests focused on what they
// actually exercise.
function withTracks(intake = {}) {
  return {
    role_targets: [{ id: "pm", name: "PM", patterns: ["product manager"] }],
    ...intake,
  };
}

test("buildFilterRules: empty intake (with tracks) → baseline only", () => {
  const rules = buildFilterRules(withTracks());
  assert.deepEqual(rules.company_blocklist, []);
  assert.deepEqual(rules.location_blocklist, []);
  // Baseline title patterns always present
  const patterns = rules.title_blocklist.map((t) => t.pattern);
  assert.ok(patterns.includes("intern"));
  assert.ok(patterns.includes("internship"));
});

test("buildFilterRules: user-provided blocklists lowercased + merged with baseline", () => {
  const rules = buildFilterRules(
    withTracks({
      career: { title_blocklist: ["Director", "VP", "Staff Engineer"] },
      preferences: { location_blocklist: ["New York", "Seattle"] },
      companies: { company_blocklist: ["Palantir", "Deloitte"] },
    })
  );
  assert.deepEqual(rules.company_blocklist, ["Palantir", "Deloitte"]);
  assert.deepEqual(rules.location_blocklist, ["New York", "Seattle"]);
  const patterns = rules.title_blocklist.map((t) => t.pattern);
  assert.ok(patterns.includes("director"));
  assert.ok(patterns.includes("vp"));
  assert.ok(patterns.includes("staff engineer"));
  assert.ok(patterns.includes("intern")); // baseline retained
});

test("buildFilterRules: dedupes overlap between user + baseline", () => {
  const rules = buildFilterRules(
    withTracks({ career: { title_blocklist: ["Intern", "intern"] } })
  );
  const patterns = rules.title_blocklist.map((t) => t.pattern);
  assert.equal(patterns.filter((p) => p === "intern").length, 1);
});

test("buildFilterRules: tolerates missing sub-objects", () => {
  assert.doesNotThrow(() => buildFilterRules(withTracks({ career: null })));
  assert.doesNotThrow(() => buildFilterRules(withTracks({ preferences: null })));
  assert.doesNotThrow(() => buildFilterRules(withTracks({ companies: null })));
});

test("buildFilterRules: each title entry has {pattern, reason}", () => {
  const rules = buildFilterRules(withTracks({ career: { title_blocklist: ["VP"] } }));
  for (const t of rules.title_blocklist) {
    assert.equal(typeof t.pattern, "string");
    assert.equal(typeof t.reason, "string");
  }
});

// --- RFC 033: role_targets generation --------------------------------------

test("buildFilterRules: throws when intake has no role_targets", () => {
  assert.throws(() => buildFilterRules({}), /role_targets is empty/);
});

test("buildFilterRules: throws when intake role_targets is empty array", () => {
  assert.throws(() => buildFilterRules({ role_targets: [] }), /role_targets is empty/);
});

test("buildFilterRules: throws when every track has empty patterns", () => {
  assert.throws(
    () => buildFilterRules({ role_targets: [{ id: "pm", patterns: [] }] }),
    /role_targets is empty/
  );
});

test("buildFilterRules: emits role_targets block with canonical shape", () => {
  const rules = buildFilterRules({
    role_targets: [
      { id: "pm", name: "Product Manager", patterns: ["Product Manager", "PM"] },
    ],
  });
  assert.equal(rules.role_targets.tracks.length, 1);
  const pm = rules.role_targets.tracks[0];
  assert.equal(pm.id, "pm");
  assert.equal(pm.name, "Product Manager");
  assert.equal(pm.fit_treatment, "primary");
  assert.deepEqual(pm.patterns, [
    { pattern: "product manager", reason: "role track: pm" },
    { pattern: "pm", reason: "role track: pm" },
  ]);
});

test("buildRoleTargets: bridge tracks preserve fit_treatment + bridge_note", () => {
  const out = buildRoleTargets({
    role_targets: [
      {
        id: "fde",
        name: "Forward-Deployed Engineer",
        fit_treatment: "bridge",
        bridge_note: "Treat as primary in AI-native shops.",
        patterns: ["forward deployed"],
      },
    ],
  });
  assert.equal(out.tracks[0].fit_treatment, "bridge");
  assert.equal(out.tracks[0].bridge_note, "Treat as primary in AI-native shops.");
});

test("buildRoleTargets: invalid fit_treatment falls back to primary", () => {
  const out = buildRoleTargets({
    role_targets: [{ id: "pm", patterns: ["product manager"], fit_treatment: "bogus" }],
  });
  assert.equal(out.tracks[0].fit_treatment, "primary");
});

test("buildRoleTargets: name defaults to id when not provided", () => {
  const out = buildRoleTargets({
    role_targets: [{ id: "pm", patterns: ["product manager"] }],
  });
  assert.equal(out.tracks[0].name, "pm");
});
