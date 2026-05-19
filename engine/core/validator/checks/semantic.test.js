const { test } = require("node:test");
const assert = require("node:assert/strict");

const { runSemanticChecks } = require("./semantic.js");

function fr(roleTargets) {
  return {
    company_blocklist: [],
    title_blocklist: [],
    title_requirelist: [],
    location_blocklist: [],
    role_targets: roleTargets || null,
  };
}

function tracksOf(...ids) {
  return ids.map((id) => ({
    id,
    name: id.toUpperCase(),
    patterns: [{ pattern: id }],
    fit_treatment: "primary",
  }));
}

test("semantic: missing role_targets block → error", () => {
  const issues = runSemanticChecks({ filterRules: fr(null) });
  const err = issues.find((i) => i.field === "filter_rules.role_targets");
  assert.ok(err);
  assert.equal(err.severity, "error");
});

test("semantic: empty role_targets.tracks → error", () => {
  const issues = runSemanticChecks({
    filterRules: fr({ tracks: [], fit_treatments: {} }),
  });
  const err = issues.find((i) => i.field === "filter_rules.role_targets.tracks");
  assert.ok(err);
  assert.equal(err.severity, "error");
});

test("semantic: role_targets with tracks → no track-presence error", () => {
  const issues = runSemanticChecks({
    filterRules: fr({ tracks: tracksOf("pm"), fit_treatments: {} }),
  });
  const trackErr = issues.find(
    (i) => i.field === "filter_rules.role_targets.tracks" && i.severity === "error"
  );
  assert.equal(trackErr, undefined);
});

test("semantic: duplicate track ids → error", () => {
  const issues = runSemanticChecks({
    filterRules: fr({ tracks: tracksOf("pm", "pm", "growth"), fit_treatments: {} }),
  });
  const dup = issues.find((i) => i.message.includes("duplicate track id"));
  assert.ok(dup);
  assert.equal(dup.severity, "error");
});

test("semantic: fit_treatments key not matching any track id → warn", () => {
  const issues = runSemanticChecks({
    filterRules: fr({
      tracks: tracksOf("pm"),
      fit_treatments: { primary: "...", bridge: "...", orphan: "stuff" },
    }),
  });
  const orphan = issues.find((i) => i.field.endsWith(".orphan"));
  assert.ok(orphan);
  assert.equal(orphan.severity, "warn");
});

test("semantic: fit_treatments with base labels only → no warns", () => {
  const issues = runSemanticChecks({
    filterRules: fr({
      tracks: tracksOf("pm"),
      fit_treatments: { primary: "...", bridge: "..." },
    }),
  });
  assert.deepEqual(
    issues.filter((i) => i.field.startsWith("filter_rules.role_targets.fit_treatments")),
    []
  );
});

test("semantic: geo mode=metro with empty cities → error", () => {
  const issues = runSemanticChecks({
    filterRules: fr(tracksOf("pm").length ? { tracks: tracksOf("pm"), fit_treatments: {} } : null),
    geo: { mode: "metro", cities: [], states: ["CA"] },
  });
  const err = issues.find((i) => i.field === "profile.geo.cities");
  assert.ok(err);
  assert.equal(err.severity, "error");
});

test("semantic: geo mode=metro with empty states → error", () => {
  const issues = runSemanticChecks({
    filterRules: fr({ tracks: tracksOf("pm"), fit_treatments: {} }),
    geo: { mode: "metro", cities: ["SF"], states: [] },
  });
  const err = issues.find((i) => i.field === "profile.geo.states");
  assert.ok(err);
  assert.equal(err.severity, "error");
});

test("semantic: geo mode=metro with both → no geo-coherence error", () => {
  const issues = runSemanticChecks({
    filterRules: fr({ tracks: tracksOf("pm"), fit_treatments: {} }),
    geo: { mode: "metro", cities: ["SF"], states: ["CA"] },
  });
  assert.equal(
    issues.find((i) => i.field.startsWith("profile.geo") && i.severity === "error"),
    undefined
  );
});

test("semantic: us-wide with US in blocklist → error", () => {
  const issues = runSemanticChecks({
    filterRules: fr({ tracks: tracksOf("pm"), fit_treatments: {} }),
    geo: { mode: "us-wide", blocklist: ["United States"] },
  });
  const err = issues.find((i) => i.field === "profile.geo.blocklist");
  assert.ok(err);
  assert.equal(err.severity, "error");
});

test("semantic: remote-only with remote_ok=false → warn", () => {
  const issues = runSemanticChecks({
    filterRules: fr({ tracks: tracksOf("pm"), fit_treatments: {} }),
    geo: { mode: "remote-only", remote_ok: false },
  });
  const warn = issues.find((i) => i.field === "profile.geo.remote_ok");
  assert.ok(warn);
  assert.equal(warn.severity, "warn");
});

test("semantic: discovery typo `companies_blocklist` → warn", () => {
  const issues = runSemanticChecks({
    filterRules: fr({ tracks: tracksOf("pm"), fit_treatments: {} }),
    discovery: { companies_blocklist: ["Acme"] },
  });
  const w = issues.find((i) => i.field === "profile.discovery.companies_blocklist");
  assert.ok(w);
  assert.equal(w.severity, "warn");
  assert.match(w.message, /companies_blacklist/);
});

test("semantic: discovery with correct key → no typo warn", () => {
  const issues = runSemanticChecks({
    filterRules: fr({ tracks: tracksOf("pm"), fit_treatments: {} }),
    discovery: { companies_blacklist: ["Acme"] },
  });
  assert.equal(
    issues.find((i) => i.field.startsWith("profile.discovery.")),
    undefined
  );
});
