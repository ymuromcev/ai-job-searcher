const { test } = require("node:test");
const assert = require("node:assert/strict");

const { jobKey, normalizeCompanyName, normalizeTitle, fuzzyKey, dedupeJobs, dedupeAgainst } = require("./dedup.js");

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

test("normalizeTitle lowercases, strips punctuation, collapses whitespace", () => {
  assert.equal(normalizeTitle("Senior PM, AI/ML"), "senior pm ai ml");
  assert.equal(normalizeTitle("  Product   Manager  "), "product manager");
  assert.equal(normalizeTitle("Lead PM (Growth)"), "lead pm growth");
});

test("fuzzyKey returns null when company or title is missing", () => {
  assert.equal(fuzzyKey({ companyName: "", title: "PM" }), null);
  assert.equal(fuzzyKey({ companyName: "Acme", title: "" }), null);
  assert.equal(fuzzyKey({}), null);
});

test("fuzzyKey accepts both companyName (adapter) and company (legacy) fields", () => {
  assert.equal(fuzzyKey({ companyName: "Acme, Inc.", title: "PM" }), "acme::pm");
  assert.equal(fuzzyKey({ company: "Acme, Inc.", title: "PM" }), "acme::pm");
});

test("dedupeJobs collapses cross-platform duplicates by (company, title)", () => {
  const jobs = [
    { source: "greenhouse", jobId: "gh-1", companyName: "Stripe", title: "Senior PM" },
    { source: "lever", jobId: "lv-9", companyName: "Stripe, Inc.", title: "Senior PM" },
    { source: "ashby", jobId: "ab-2", companyName: "Stripe", title: "Staff PM" },
  ];
  const out = dedupeJobs(jobs);
  assert.equal(out.length, 2);
  assert.equal(out[0].source, "greenhouse");
  assert.equal(out[1].source, "ashby");
});

test("dedupeAgainst skips fuzzy duplicates of existing jobs", () => {
  const existing = [
    { source: "greenhouse", jobId: "gh-1", companyName: "Stripe", title: "Senior PM" },
  ];
  const incoming = [
    { source: "lever", jobId: "lv-9", companyName: "Stripe, Inc.", title: "Senior PM" },
    { source: "lever", jobId: "lv-10", companyName: "Stripe", title: "Staff PM" },
  ];
  const fresh = dedupeAgainst(existing, incoming);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].jobId, "lv-10");
});

test("dedupeJobs keeps rows without title-or-company (no fuzzy collision)", () => {
  const jobs = [
    { source: "remoteok", jobId: "1" },
    { source: "remoteok", jobId: "2" },
  ];
  assert.equal(dedupeJobs(jobs).length, 2);
});
