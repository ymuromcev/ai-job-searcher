const { test } = require("node:test");
const assert = require("node:assert/strict");

const { validateJob, validateProfile } = require("./validator.js");

test("validateJob passes on complete job", () => {
  const r = validateJob({
    source: "greenhouse",
    jobId: "1",
    company: "A",
    role: "PM",
    jobUrl: "https://x",
  });
  assert.equal(r.valid, true);
  assert.equal(r.errors.length, 0);
});

test("validateJob fails on missing required fields", () => {
  const r = validateJob({ source: "gh", company: "A" });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("jobId")));
  assert.ok(r.errors.some((e) => e.includes("role")));
  assert.ok(r.errors.some((e) => e.includes("jobUrl")));
});

test("validateJob rejects non-object input", () => {
  assert.equal(validateJob(null).valid, false);
  assert.equal(validateJob("string").valid, false);
});

test("validateProfile passes on minimal valid profile", () => {
  const r = validateProfile({
    id: "jared",
    identity: { name: "J", email: "j@x" },
    modules: ["generators:resume_pdf"],
  });
  assert.equal(r.valid, true);
});

test("validateProfile fails when identity.email missing", () => {
  const r = validateProfile({
    id: "jared",
    identity: { name: "J" },
    modules: [],
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("identity.email")));
});

test("validateProfile rejects non-array modules", () => {
  const r = validateProfile({
    id: "jared",
    identity: { name: "J", email: "j@x" },
    modules: "not-array",
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /modules must be an array/.test(e)));
});

test("validateProfile rejects id that fails ID_REGEX", () => {
  const r = validateProfile({
    id: "BadID",
    identity: { name: "J", email: "j@x" },
    modules: [],
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("profile.id does not match")));
});
