const { test } = require("node:test");
const assert = require("node:assert/strict");

const ashby = require("./ashby.js");
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
  jobs: [
    {
      id: "job-uuid-1",
      title: "Principal PM, Platform",
      jobUrl: "https://jobs.ashbyhq.com/ramp/job-uuid-1",
      location: "New York",
      department: "Product",
      team: "Platform",
      publishedAt: "2026-04-10T00:00:00Z",
      isRemote: true,
      compensationTierSummary: "$220k–$280k",
      secondaryLocations: [{ location: "San Francisco" }, { location: "New York" }],
    },
    {
      id: "job-uuid-2",
      title: "Designer",
      jobUrl: "https://jobs.ashbyhq.com/ramp/job-uuid-2",
      location: "",
      department: null,
      team: null,
      publishedAt: null,
      isRemote: false,
    },
  ],
};

test("ashby.discover maps fixture to normalized jobs", async () => {
  const fetchFn = makeFetch({
    "https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true": {
      status: 200,
      body: FIXTURE,
    },
  });
  const jobs = await ashby.discover([{ name: "Ramp", slug: "ramp" }], { fetchFn });
  assert.equal(jobs.length, 2);
  for (const j of jobs) assertJob(j);

  const [j1, j2] = jobs;
  assert.equal(j1.source, "ashby");
  assert.equal(j1.jobId, "job-uuid-1");
  assert.deepEqual(j1.locations, ["New York", "Remote", "San Francisco"]);
  assert.equal(j1.team, "Product");
  assert.equal(j1.postedAt, "2026-04-10");
  assert.equal(j1.rawExtra.compensation, "$220k–$280k");

  assert.equal(j2.team, null);
  assert.deepEqual(j2.locations, []);
  assert.equal(j2.postedAt, null);
});

test("ashby.discover encodes slug with special chars", async () => {
  const fetchFn = makeFetch({
    "https://api.ashbyhq.com/posting-api/job-board/kraken.com?includeCompensation=true": {
      status: 200,
      body: { jobs: [] },
    },
  });
  const jobs = await ashby.discover([{ name: "Kraken", slug: "kraken.com" }], { fetchFn });
  assert.deepEqual(jobs, []);
});
