const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const jobsTsv = require("./jobs_tsv.js");

function tmp() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aijs-jobs-")), "jobs.tsv");
}

function fixtureJob(overrides = {}) {
  return {
    source: "greenhouse",
    slug: "affirm",
    jobId: "1",
    companyName: "Affirm",
    title: "Senior PM",
    url: "https://x/1",
    locations: ["San Francisco, CA", "Remote"],
    team: "Product",
    postedAt: "2026-04-15",
    rawExtra: { departments: [{ name: "Product" }] },
    ...overrides,
  };
}

test("save + load round-trips a normalized job including locations and rawExtra", () => {
  const file = tmp();
  jobsTsv.save(file, [fixtureJob()], { now: "2026-04-20T00:00:00Z" });
  const { jobs } = jobsTsv.load(file);
  assert.equal(jobs.length, 1);
  const j = jobs[0];
  assert.equal(j.companyName, "Affirm");
  assert.deepEqual(j.locations, ["San Francisco, CA", "Remote"]);
  assert.deepEqual(j.rawExtra, { departments: [{ name: "Product" }] });
  assert.equal(j.discoveredAt, "2026-04-20T00:00:00Z");
});

test("load preserves discoveredAt rather than overwriting on re-save", () => {
  const file = tmp();
  jobsTsv.save(file, [fixtureJob({ discoveredAt: "2026-01-01T00:00:00Z" })], {
    now: "2026-04-20T00:00:00Z",
  });
  const { jobs } = jobsTsv.load(file);
  assert.equal(jobs[0].discoveredAt, "2026-01-01T00:00:00Z");
});

test("load returns empty for missing file", () => {
  const { jobs } = jobsTsv.load("/tmp/does-not-exist-aijs-jobs.tsv");
  assert.deepEqual(jobs, []);
});

test("load throws on header mismatch", () => {
  const file = tmp();
  fs.writeFileSync(file, "wrong\theader\nx\ty\n");
  assert.throws(() => jobsTsv.load(file), /jobs\.tsv header mismatch/);
});

test("escape strips tabs and newlines from job fields", () => {
  const file = tmp();
  jobsTsv.save(file, [fixtureJob({ title: "PM\twith\nnewlines", url: "https://x/y" })]);
  const { jobs } = jobsTsv.load(file);
  assert.equal(jobs[0].title, "PM with newlines");
});

test("save uses atomic rename (no .tmp leftover)", () => {
  const file = tmp();
  jobsTsv.save(file, [fixtureJob()]);
  const dir = path.dirname(file);
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
  assert.deepEqual(leftovers, []);
});
