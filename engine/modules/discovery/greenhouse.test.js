const { test } = require("node:test");
const assert = require("node:assert/strict");

const gh = require("./greenhouse.js");
const { assertJob } = require("./_types.js");

function makeFetch(responses) {
  return async function (url) {
    const entry = responses[url];
    if (!entry) throw new Error(`unmocked url: ${url}`);
    if (entry.throws) throw entry.throws;
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
      id: 4421234,
      title: "Senior Product Manager, Risk ",
      absolute_url: "https://boards.greenhouse.io/affirm/jobs/4421234",
      location: { name: "San Francisco, CA" },
      departments: [{ name: "Product" }],
      updated_at: "2026-04-15T10:20:30Z",
    },
    {
      id: 4421235,
      title: "Product Designer",
      absolute_url: "https://boards.greenhouse.io/affirm/jobs/4421235",
      location: { name: "Remote" },
      departments: [],
      updated_at: null,
    },
  ],
};

test("greenhouse.discover maps fixture to normalized jobs", async () => {
  const fetchFn = makeFetch({
    "https://boards-api.greenhouse.io/v1/boards/affirm/jobs": { status: 200, body: FIXTURE },
  });
  const jobs = await gh.discover([{ name: "Affirm", slug: "affirm" }], { fetchFn });
  assert.equal(jobs.length, 2);
  for (const j of jobs) assertJob(j);

  const [j1] = jobs;
  assert.equal(j1.source, "greenhouse");
  assert.equal(j1.slug, "affirm");
  assert.equal(j1.companyName, "Affirm");
  assert.equal(j1.jobId, "4421234");
  assert.equal(j1.title, "Senior Product Manager, Risk");
  assert.deepEqual(j1.locations, ["San Francisco, CA"]);
  assert.equal(j1.team, "Product");
  assert.equal(j1.postedAt, "2026-04-15");
});

test("greenhouse.discover tolerates empty response", async () => {
  const fetchFn = makeFetch({
    "https://boards-api.greenhouse.io/v1/boards/empty/jobs": { status: 200, body: { jobs: [] } },
  });
  const jobs = await gh.discover([{ name: "Empty", slug: "empty" }], { fetchFn });
  assert.deepEqual(jobs, []);
});

test("greenhouse.discover isolates per-target failures", async () => {
  const fetchFn = makeFetch({
    "https://boards-api.greenhouse.io/v1/boards/good/jobs": { status: 200, body: FIXTURE },
    "https://boards-api.greenhouse.io/v1/boards/bad/jobs": { status: 404, body: {} },
  });
  const logs = [];
  const jobs = await gh.discover(
    [{ name: "Good", slug: "good" }, { name: "Bad", slug: "bad" }],
    { fetchFn, logger: { warn: (m) => logs.push(m) } }
  );
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((j) => j.slug === "good"));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /bad:.*HTTP 404/);
});

test("greenhouse.discover skips targets without slug", async () => {
  const fetchFn = makeFetch({});
  const jobs = await gh.discover([{ name: "Nope" }, null], { fetchFn });
  assert.deepEqual(jobs, []);
});
