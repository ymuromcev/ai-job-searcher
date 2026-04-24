const { test } = require("node:test");
const assert = require("node:assert/strict");

const { assertJob, isValidJob } = require("./_types.js");

function validJob(overrides = {}) {
  return {
    source: "greenhouse",
    slug: "affirm",
    companyName: "Affirm",
    jobId: "4421234",
    title: "Product Manager, Risk",
    url: "https://boards.greenhouse.io/affirm/jobs/4421234",
    locations: ["San Francisco, CA", "Remote"],
    team: "Product",
    postedAt: "2026-04-15",
    rawExtra: {},
    ...overrides,
  };
}

test("assertJob passes on a fully-populated record", () => {
  assert.doesNotThrow(() => assertJob(validJob()));
});

test("assertJob accepts null optional fields", () => {
  assert.doesNotThrow(() => assertJob(validJob({ team: null, postedAt: null })));
});

test("assertJob rejects empty required strings", () => {
  for (const key of ["source", "slug", "companyName", "jobId", "title", "url"]) {
    assert.throws(() => assertJob(validJob({ [key]: "" })), new RegExp(`job\\.${key}`));
    assert.throws(() => assertJob(validJob({ [key]: undefined })), new RegExp(`job\\.${key}`));
  }
});

test("assertJob rejects non-array locations", () => {
  assert.throws(() => assertJob(validJob({ locations: "SF" })), /locations must be an array/);
});

test("assertJob rejects non-string location entry", () => {
  assert.throws(() => assertJob(validJob({ locations: [123] })), /locations items must be strings/);
});

test("assertJob rejects bad postedAt format", () => {
  assert.throws(() => assertJob(validJob({ postedAt: "2026/04/15" })), /postedAt/);
  assert.throws(() => assertJob(validJob({ postedAt: "yesterday" })), /postedAt/);
});

test("assertJob rejects non-object rawExtra", () => {
  assert.throws(() => assertJob(validJob({ rawExtra: "nope" })), /rawExtra/);
  assert.throws(() => assertJob(validJob({ rawExtra: [] })), /rawExtra/);
  assert.throws(() => assertJob(validJob({ rawExtra: null })), /rawExtra/);
});

test("isValidJob returns boolean", () => {
  assert.equal(isValidJob(validJob()), true);
  assert.equal(isValidJob({ source: "x" }), false);
});
