// RFC 068 §4 — apply_defaults.json contract, validator, loader wiring.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  APPLY_DEFAULTS_FILE,
  validateApplyDefaults,
  getSalaryFloor,
} = require("./apply_defaults.js");
const { loadProfile } = require("./profile_loader.js");
const { runSchemaChecks } = require("./validator/checks/schema.js");

const EXAMPLE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "profiles",
  "_example",
  "apply_defaults.example.json"
);

function valid() {
  return {
    work_authorization: {
      authorized_us: true,
      requires_sponsorship: false,
      status_text: "US Citizen",
    },
    relocation: { willing: false },
    eeo: { policy: "decline" },
    salary: { floor: 100000, default: 150000, currency: "USD" },
    how_did_you_hear_default: "Company careers page",
  };
}

function errorFields(issues) {
  return issues.filter((i) => i.severity === "error").map((i) => i.field);
}

test("validateApplyDefaults: valid contract → no issues", () => {
  assert.deepEqual(validateApplyDefaults(valid()), []);
});

test("validateApplyDefaults: the committed _example template is valid", () => {
  const raw = JSON.parse(fs.readFileSync(EXAMPLE_PATH, "utf8"));
  assert.deepEqual(validateApplyDefaults(raw), []);
});

test("validateApplyDefaults: non-object → single error", () => {
  for (const bad of [null, [], "x", 3]) {
    const issues = validateApplyDefaults(bad);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].field, "apply_defaults");
  }
});

test("validateApplyDefaults: missing sections are errors", () => {
  const fields = errorFields(validateApplyDefaults({}));
  for (const f of [
    "apply_defaults.work_authorization",
    "apply_defaults.relocation",
    "apply_defaults.eeo",
    "apply_defaults.salary",
    "apply_defaults.how_did_you_hear_default",
  ]) {
    assert.ok(fields.includes(f), `expected error on ${f}`);
  }
});

test("validateApplyDefaults: wrong field types are errors", () => {
  const raw = valid();
  raw.work_authorization.authorized_us = "yes";
  raw.work_authorization.requires_sponsorship = 0;
  raw.work_authorization.status_text = "";
  raw.relocation.willing = "no";
  raw.eeo.policy = "answer";
  raw.salary.currency = "usd";
  const fields = errorFields(validateApplyDefaults(raw));
  assert.deepEqual(fields.sort(), [
    "apply_defaults.eeo.policy",
    "apply_defaults.relocation.willing",
    "apply_defaults.salary.currency",
    "apply_defaults.work_authorization.authorized_us",
    "apply_defaults.work_authorization.requires_sponsorship",
    "apply_defaults.work_authorization.status_text",
  ]);
});

test("validateApplyDefaults: salary numbers must be >= 0 and default >= floor", () => {
  const raw = valid();
  raw.salary.floor = -1;
  raw.salary.default = "180000";
  assert.deepEqual(errorFields(validateApplyDefaults(raw)).sort(), [
    "apply_defaults.salary.default",
    "apply_defaults.salary.floor",
  ]);
  const raw2 = valid();
  raw2.salary.default = 90000;
  assert.deepEqual(errorFields(validateApplyDefaults(raw2)), ["apply_defaults.salary.default"]);
});

test("validateApplyDefaults: unknown top-level key is a warning, not an error", () => {
  const raw = { ...valid(), extra: 1 };
  const issues = validateApplyDefaults(raw);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "warn");
  assert.equal(issues[0].field, "apply_defaults.extra");
});

test("getSalaryFloor: returns the floor or null", () => {
  assert.equal(getSalaryFloor(valid()), 100000);
  assert.equal(getSalaryFloor(null), null);
  assert.equal(getSalaryFloor(undefined), null);
  assert.equal(getSalaryFloor({}), null);
  assert.equal(getSalaryFloor({ salary: { floor: "120000" } }), null);
  assert.equal(getSalaryFloor({ salary: { floor: 0 } }), 0);
});

// --- loader + schema wiring ----------------------------------------------

function tempProfile(extras = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aijs-applydef-"));
  const root = path.join(dir, "test");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "profile.json"), JSON.stringify({ id: "test" }));
  for (const [file, content] of Object.entries(extras)) {
    fs.writeFileSync(path.join(root, file), content);
  }
  return dir;
}

test("loadProfile: applyDefaults is null when apply_defaults.json is absent", () => {
  const dir = tempProfile();
  const profile = loadProfile("test", { profilesDir: dir, warn: () => {} });
  assert.equal(profile.applyDefaults, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadProfile: applyDefaults carries apply_defaults.json verbatim", () => {
  const dir = tempProfile({ [APPLY_DEFAULTS_FILE]: JSON.stringify(valid()) });
  const profile = loadProfile("test", { profilesDir: dir, warn: () => {} });
  assert.deepEqual(profile.applyDefaults, valid());
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadProfile: malformed apply_defaults.json throws", () => {
  const dir = tempProfile({ [APPLY_DEFAULTS_FILE]: "{ not json" });
  assert.throws(() => loadProfile("test", { profilesDir: dir, warn: () => {} }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("schema checks: applyDefaults absent → no apply_defaults issues", () => {
  const issues = runSchemaChecks({ applyDefaults: null });
  assert.equal(
    issues.some((i) => i.field.startsWith("apply_defaults")),
    false
  );
});

test("schema checks: invalid applyDefaults surfaces schema errors", () => {
  const raw = valid();
  raw.salary.floor = "lots";
  const issues = runSchemaChecks({ applyDefaults: raw });
  const err = issues.find((i) => i.field === "apply_defaults.salary.floor");
  assert.ok(err);
  assert.equal(err.severity, "error");
  assert.equal(err.category, "schema");
});

test("validateApplyDefaults: optional address / citizenship / legal_acknowledgements", () => {
  const ok = {
    ...valid(),
    address: { street: "1 Main St", city: "Springfield", state: "IL", zip: "62701" },
    citizenship: { countries: ["Freedonia"], us_permanent_resident: true },
    legal_acknowledgements: "accept",
  };
  assert.deepEqual(validateApplyDefaults(ok), []);
  const bad = {
    ...valid(),
    address: { zip: 62701 },
    citizenship: { countries: "Freedonia" },
    legal_acknowledgements: "always",
  };
  const fields = validateApplyDefaults(bad)
    .filter((i) => i.severity === "error")
    .map((i) => i.field);
  assert.deepEqual(fields.sort(), [
    "apply_defaults.address.zip",
    "apply_defaults.citizenship.countries",
    "apply_defaults.legal_acknowledgements",
  ]);
});
