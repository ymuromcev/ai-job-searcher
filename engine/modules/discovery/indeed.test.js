const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const indeed = require("./indeed.js");
const { assertJob } = require("./_types.js");

function mkTmp(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "indeed-ingest-"));
  const file = path.join(dir, "ingest.json");
  fs.writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

test("indeed.discover normalizes entries from a browser-produced JSON", async () => {
  const ingestFile = mkTmp([
    {
      jk: "abc123",
      title: " Diagnostic Sonographer ",
      company: "Sutter Health",
      location: "Sacramento, CA",
      postedAt: "2026-04-15",
    },
    {
      jk: "def456",
      title: "Sonographer - Travel",
      company: "Kaiser",
      location: "Remote - CA",
      url: "https://www.indeed.com/viewjob?jk=def456&from=serp",
    },
  ]);

  const jobs = await indeed.discover(
    [{ name: "Indeed Sacramento", slug: "sac-sonographer", keyword: "sonographer", ingestFile }],
    {}
  );
  assert.equal(jobs.length, 2);
  for (const j of jobs) assertJob(j);

  const [j1, j2] = jobs;
  assert.equal(j1.source, "indeed");
  assert.equal(j1.jobId, "abc123");
  assert.equal(j1.title, "Diagnostic Sonographer");
  assert.equal(j1.companyName, "Sutter Health");
  assert.deepEqual(j1.locations, ["Sacramento, CA"]);
  assert.equal(j1.url, "https://www.indeed.com/viewjob?jk=abc123");
  assert.equal(j1.postedAt, "2026-04-15");
  assert.equal(j1.rawExtra.keyword, "sonographer");

  assert.equal(j2.url, "https://www.indeed.com/viewjob?jk=def456&from=serp");
  assert.deepEqual(j2.locations, ["Remote"]);
});

test("indeed.discover warns + skips entries missing jk", async () => {
  const ingestFile = mkTmp([
    { title: "no jk", company: "A", location: "SF" },
    { jk: "ok1", title: "Good", company: "B", location: "SF" },
  ]);
  const logs = [];
  const jobs = await indeed.discover(
    [{ name: "Idx", slug: "idx", ingestFile }],
    { logger: { warn: (m) => logs.push(m) } }
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobId, "ok1");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /missing required field: jk/);
});

test("indeed.discover warns when ingest file is missing", async () => {
  const logs = [];
  const jobs = await indeed.discover(
    [{ name: "MissingFile", slug: "mf", ingestFile: "/tmp/does-not-exist-aijs.json" }],
    { logger: { warn: (m) => logs.push(m) } }
  );
  assert.deepEqual(jobs, []);
  assert.match(logs[0], /ingest file not found/);
});

test("indeed.discover warns on malformed JSON", async () => {
  const ingestFile = mkTmp("{not valid json");
  const logs = [];
  const jobs = await indeed.discover(
    [{ name: "Bad", slug: "bad", ingestFile }],
    { logger: { warn: (m) => logs.push(m) } }
  );
  assert.deepEqual(jobs, []);
  assert.match(logs[0], /not valid JSON/);
});

test("indeed.discover skips targets without ingestFile", async () => {
  const jobs = await indeed.discover(
    [{ name: "Skip", slug: "skip" }, null],
    {}
  );
  assert.deepEqual(jobs, []);
});
