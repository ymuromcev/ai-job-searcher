const { test } = require("node:test");
const assert = require("node:assert/strict");

const usajobs = require("./usajobs.js");
const { assertJob } = require("./_types.js");

function makeFetch(responses, recorded = []) {
  return async function (url, opts = {}) {
    recorded.push({ url, headers: opts.headers || {} });
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

function makeDescriptor(i, overrides = {}) {
  return {
    PositionID: `FED-${i}`,
    PositionTitle: `Product Manager ${i}`,
    PositionURI: `https://www.usajobs.gov/job/${i}`,
    PositionLocation: [{ LocationName: "Sacramento, California" }],
    OrganizationName: "Department of Technology",
    DepartmentName: "CDT",
    JobCategory: [{ Code: "2210" }],
    PublicationStartDate: "2026-04-10T00:00:00Z",
    ApplicationCloseDate: "2026-05-10T00:00:00Z",
    ...overrides,
  };
}

test("usajobs.discover returns [] when secrets missing", async () => {
  const logs = [];
  const jobs = await usajobs.discover(
    [{ name: "2210 CA", slug: "2210-ca", query: { JobCategoryCode: "2210" } }],
    { fetchFn: async () => ({ ok: false, status: 500 }), logger: { warn: (m) => logs.push(m) } }
  );
  assert.deepEqual(jobs, []);
  assert.match(logs[0], /missing USAJOBS_API_KEY/);
});

test("usajobs.discover maps descriptors and paginates to end", async () => {
  const page1Items = Array.from({ length: 50 }, (_, i) => ({
    MatchedObjectDescriptor: makeDescriptor(i + 1),
  }));
  const page2Items = Array.from({ length: 3 }, (_, i) => ({
    MatchedObjectDescriptor: makeDescriptor(i + 51),
  }));
  const recorded = [];
  const fetchFn = makeFetch(
    {
      [`https://data.usajobs.gov/api/Search?JobCategoryCode=2210&ResultsPerPage=50&Page=1`]: {
        status: 200,
        body: { SearchResult: { SearchResultItems: page1Items } },
      },
      [`https://data.usajobs.gov/api/Search?JobCategoryCode=2210&ResultsPerPage=50&Page=2`]: {
        status: 200,
        body: { SearchResult: { SearchResultItems: page2Items } },
      },
    },
    recorded
  );
  const jobs = await usajobs.discover(
    [{ name: "2210 CA", slug: "2210-ca", query: { JobCategoryCode: "2210" } }],
    { fetchFn, secrets: { USAJOBS_API_KEY: "test-key", USAJOBS_EMAIL: "x@example.com" } }
  );
  assert.equal(jobs.length, 53);
  for (const j of jobs) assertJob(j);
  assert.equal(jobs[0].source, "usajobs");
  assert.equal(jobs[0].jobId, "FED-1");
  assert.equal(jobs[0].companyName, "Department of Technology");
  assert.equal(jobs[0].team, "CDT");
  assert.equal(jobs[0].postedAt, "2026-04-10");
  assert.equal(jobs[0].rawExtra.closingDate, "2026-05-10");
  assert.deepEqual(jobs[0].locations, ["Sacramento, California"]);

  assert.equal(recorded[0].headers["Authorization-Key"], "test-key");
  assert.equal(recorded[0].headers["User-Agent"], "x@example.com");
  assert.equal(recorded.length, 2);
});

test("usajobs.discover dedupes descriptors by PositionID across pages", async () => {
  const items = [
    { MatchedObjectDescriptor: makeDescriptor(1) },
    { MatchedObjectDescriptor: makeDescriptor(1) }, // duplicate
    { MatchedObjectDescriptor: makeDescriptor(2) },
  ];
  const fetchFn = makeFetch({
    [`https://data.usajobs.gov/api/Search?JobCategoryCode=2210&ResultsPerPage=50&Page=1`]: {
      status: 200,
      body: { SearchResult: { SearchResultItems: items } },
    },
  });
  const jobs = await usajobs.discover(
    [{ name: "x", slug: "x", query: { JobCategoryCode: "2210" } }],
    { fetchFn, secrets: { USAJOBS_API_KEY: "k", USAJOBS_EMAIL: "e" } }
  );
  assert.equal(jobs.length, 2);
});
