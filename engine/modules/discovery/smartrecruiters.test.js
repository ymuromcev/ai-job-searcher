const { test } = require("node:test");
const assert = require("node:assert/strict");

const sr = require("./smartrecruiters.js");
const { assertJob } = require("./_types.js");

function makeFetch(responses) {
  return async function (url) {
    const entry = responses[url];
    if (!entry) throw new Error(`unmocked url: ${url}`);
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      async json() {
        return entry.body;
      },
    };
  };
}

const FIXTURE = {
  content: [
    {
      id: "abc123",
      name: "Director of Product, Platform / Identity",
      location: { city: "San Francisco", region: "CA", country: "US", remote: false },
      department: { label: "Product" },
      releasedDate: "2026-04-01T00:00:00Z",
    },
    {
      id: "def456",
      name: "PM, Growth",
      location: { remote: true },
      department: null,
      releasedDate: null,
    },
    {
      id: "ghi789",
      name: "Ops Lead",
      location: { country: "Germany" },
      department: { label: "Ops" },
      releasedDate: "2026-03-15",
      applyUrl: "https://custom.example.com/apply/ghi789",
    },
  ],
};

test("smartrecruiters.discover maps fixture to normalized jobs", async () => {
  const fetchFn = makeFetch({
    "https://api.smartrecruiters.com/v1/companies/Bosch/postings": { status: 200, body: FIXTURE },
  });
  const jobs = await sr.discover([{ name: "Bosch", slug: "Bosch" }], { fetchFn });
  assert.equal(jobs.length, 3);
  for (const j of jobs) assertJob(j);

  const [j1, j2, j3] = jobs;
  assert.equal(j1.source, "smartrecruiters");
  assert.equal(j1.jobId, "abc123");
  assert.deepEqual(j1.locations, ["San Francisco, CA"]);
  assert.equal(j1.team, "Product");
  assert.equal(j1.postedAt, "2026-04-01");
  assert.equal(j1.url, "https://jobs.smartrecruiters.com/Bosch/abc123-director-of-product-platform-identity");

  assert.deepEqual(j2.locations, ["Remote"]);
  assert.equal(j2.team, null);
  assert.equal(j2.postedAt, null);

  assert.deepEqual(j3.locations, ["Germany"]);
  assert.equal(j3.url, "https://custom.example.com/apply/ghi789");
});

test("smartrecruiters.discover returns [] on missing content", async () => {
  const fetchFn = makeFetch({
    "https://api.smartrecruiters.com/v1/companies/NoData/postings": { status: 200, body: {} },
  });
  const jobs = await sr.discover([{ name: "NoData", slug: "NoData" }], { fetchFn });
  assert.deepEqual(jobs, []);
});

test("smartrecruiters url encodes malicious ids", async () => {
  const fetchFn = makeFetch({
    "https://api.smartrecruiters.com/v1/companies/acme/postings": {
      status: 200,
      body: {
        content: [
          {
            id: "../evil",
            name: "PM",
            location: { city: "SF" },
            department: null,
            releasedDate: null,
          },
        ],
      },
    },
  });
  const [job] = await sr.discover([{ name: "Acme", slug: "acme" }], { fetchFn });
  assert.equal(job.url, "https://jobs.smartrecruiters.com/acme/..%2Fevil-pm");
});

test("smartrecruiters rejects empty title via assertJob", async () => {
  const fetchFn = makeFetch({
    "https://api.smartrecruiters.com/v1/companies/empty/postings": {
      status: 200,
      body: {
        content: [{ id: "x1", name: "", location: { city: "SF" }, department: null, releasedDate: null }],
      },
    },
  });
  const logs = [];
  const jobs = await sr.discover(
    [{ name: "Empty", slug: "empty" }],
    { fetchFn, logger: { warn: (m) => logs.push(m) } }
  );
  assert.deepEqual(jobs, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /title must be a non-empty string/);
});
