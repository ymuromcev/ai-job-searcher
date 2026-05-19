const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { runReferentialChecks } = require("./referential.js");

function fakeFs(present) {
  const set = new Set(present.map((p) => path.normalize(p)));
  return {
    existsSync: (p) => set.has(path.normalize(p)),
  };
}

test("referential: discovery module file missing → error", () => {
  const profile = {
    modules: ["discovery:fictional"],
    paths: { root: "/tmp/profiles/x" },
  };
  const deps = { existsSync: () => false };
  const issues = runReferentialChecks(
    profile,
    { modulesDir: "/engine/modules/discovery", dataDir: "/data" },
    deps
  );
  const err = issues.find((i) => i.field === "profile.modules[0]");
  assert.ok(err);
  assert.equal(err.severity, "error");
  assert.match(err.message, /fictional/);
});

test("referential: discovery module file present → no issue", () => {
  const profile = {
    modules: ["discovery:greenhouse"],
    paths: { root: "/tmp/profiles/x" },
  };
  const deps = fakeFs(["/engine/modules/discovery/greenhouse.js"]);
  const issues = runReferentialChecks(
    profile,
    { modulesDir: "/engine/modules/discovery", dataDir: "/data" },
    deps
  );
  assert.equal(
    issues.find((i) => i.field === "profile.modules[0]"),
    undefined
  );
});

test("referential: non-discovery modules ignored", () => {
  const profile = {
    modules: ["generators:resume_pdf"],
    paths: { root: "/tmp/profiles/x" },
  };
  const deps = { existsSync: () => false };
  const issues = runReferentialChecks(
    profile,
    { modulesDir: "/engine/modules/discovery", dataDir: "/data" },
    deps
  );
  assert.deepEqual(issues, []);
});

test("referential: resume versions_file missing → error", () => {
  const profile = {
    paths: { root: "/tmp/profiles/x" },
    resume: { versions_file: "resume.json" },
  };
  const deps = { existsSync: () => false };
  const issues = runReferentialChecks(profile, { dataDir: "/data" }, deps);
  const err = issues.find((i) => i.field === "profile.resume.versions_file");
  assert.ok(err);
  assert.equal(err.severity, "error");
});

test("referential: cover letter template + config missing → 2 errors", () => {
  const profile = {
    paths: { root: "/tmp/profiles/x" },
    cover_letter: { template_file: "cl.md", config_file: "cl.json" },
  };
  const deps = { existsSync: () => false };
  const issues = runReferentialChecks(profile, { dataDir: "/data" }, deps);
  const fields = issues.map((i) => i.field);
  assert.ok(fields.includes("profile.cover_letter.template_file"));
  assert.ok(fields.includes("profile.cover_letter.config_file"));
});

test("referential: profile files all present → no errors", () => {
  const root = "/tmp/profiles/x";
  const profile = {
    paths: { root },
    resume: { versions_file: "resume.json" },
    cover_letter: { template_file: "cl.md", config_file: "cl.json" },
  };
  const deps = fakeFs([
    path.join(root, "resume.json"),
    path.join(root, "cl.md"),
    path.join(root, "cl.json"),
  ]);
  const issues = runReferentialChecks(profile, { dataDir: "/data" }, deps);
  assert.deepEqual(issues, []);
});

test("referential: companies_blacklist entry not in companies.tsv → warn", () => {
  const profile = {
    paths: { root: "/tmp/profiles/x" },
    discovery: { companies_blacklist: ["Acmme Corp", "Stripe"] },
  };
  const companiesTsv = path.join("/data", "companies.tsv");
  const deps = {
    existsSync: (p) => p === path.normalize(companiesTsv),
    loadCompanies: () => ({ rows: [{ name: "Stripe", ats_source: "greenhouse" }] }),
  };
  const issues = runReferentialChecks(profile, { dataDir: "/data" }, deps);
  const warns = issues.filter((i) => i.severity === "warn");
  assert.equal(warns.length, 1);
  assert.match(warns[0].field, /companies_blacklist\[0\]/);
  assert.match(warns[0].message, /Acmme Corp/);
});

test("referential: companies_blacklist with missing companies.tsv → silently skipped", () => {
  const profile = {
    paths: { root: "/tmp/profiles/x" },
    discovery: { companies_blacklist: ["Acmme Corp"] },
  };
  const deps = { existsSync: () => false };
  const issues = runReferentialChecks(profile, { dataDir: "/data" }, deps);
  // RFC 037 §3.3: gitignored file absence is not an error on a fresh clone.
  assert.equal(
    issues.find((i) => i.field.startsWith("profile.discovery.companies_blacklist")),
    undefined
  );
});

test("referential: empty companies_blacklist → no issues", () => {
  const profile = {
    paths: { root: "/tmp/profiles/x" },
    discovery: { companies_blacklist: [] },
  };
  const deps = { existsSync: () => true, loadCompanies: () => ({ rows: [] }) };
  const issues = runReferentialChecks(profile, { dataDir: "/data" }, deps);
  assert.deepEqual(issues, []);
});

test("referential: empty / null profile → no issues", () => {
  assert.deepEqual(runReferentialChecks(null, {}, { existsSync: () => true }), []);
  assert.deepEqual(runReferentialChecks({}, {}, { existsSync: () => true }), []);
});
