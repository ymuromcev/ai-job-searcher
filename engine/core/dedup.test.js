const { test } = require("node:test");
const assert = require("node:assert/strict");

const { jobKey, normalizeCompanyName, dedupeJobs, dedupeAgainst } = require("./dedup.js");

test("jobKey combines source and jobId", () => {
  assert.equal(jobKey({ source: "greenhouse", jobId: "123" }), "greenhouse:123");
  assert.equal(jobKey({ source: "Greenhouse", jobId: "123" }), "greenhouse:123");
});

test("normalizeCompanyName strips suffixes and punctuation", () => {
  assert.equal(normalizeCompanyName("ACME, Inc."), "acme");
  assert.equal(normalizeCompanyName("  ACME  LLC  "), "acme");
  assert.equal(normalizeCompanyName("Stripe"), "stripe");
  assert.equal(normalizeCompanyName("Data Labs"), "data labs");
});

test("dedupeJobs removes duplicates by (source, jobId) preserving first", () => {
  const jobs = [
    { source: "greenhouse", jobId: "1", company: "A" },
    { source: "greenhouse", jobId: "2", company: "B" },
    { source: "greenhouse", jobId: "1", company: "A-duplicate" },
    { source: "lever", jobId: "1", company: "C" },
  ];
  const out = dedupeJobs(jobs);
  assert.equal(out.length, 3);
  assert.equal(out[0].company, "A"); // first occurrence kept
});

test("dedupeJobs skips malformed entries", () => {
  const jobs = [{ source: "", jobId: "" }, { source: "gh", jobId: "1" }];
  assert.equal(dedupeJobs(jobs).length, 1);
});

test("dedupeAgainst returns only jobs not present in existing set", () => {
  const existing = [
    { source: "greenhouse", jobId: "1" },
    { source: "greenhouse", jobId: "2" },
  ];
  const incoming = [
    { source: "greenhouse", jobId: "2" },
    { source: "greenhouse", jobId: "3" },
    { source: "lever", jobId: "1" },
  ];
  const fresh = dedupeAgainst(existing, incoming);
  assert.equal(fresh.length, 2);
  assert.equal(fresh[0].jobId, "3");
  assert.equal(fresh[1].jobId, "1");
});

test("dedupeJobs throws on non-array input", () => {
  assert.throws(() => dedupeJobs("nope"), /must be an array/);
});
