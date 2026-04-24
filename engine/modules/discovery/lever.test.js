const { test } = require("node:test");
const assert = require("node:assert/strict");

const lever = require("./lever.js");
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

const FIXTURE = [
  {
    id: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
    text: "Staff Product Manager",
    hostedUrl: "https://jobs.lever.co/stripe/a1b2c3d4",
    categories: {
      location: "New York",
      team: "Payments",
      department: "Product",
      allLocations: ["New York", "Remote - US", "new york"],
    },
    createdAt: 1744800000000,
  },
  {
    id: "b1b2c3d4-0000-0000-0000-000000000000",
    text: "Engineering Manager",
    hostedUrl: "https://jobs.lever.co/stripe/b1b2c3d4",
    categories: { location: "SF", team: "Infra" },
    createdAt: 1744800000000,
  },
];

test("lever.discover maps fixture to normalized jobs", async () => {
  const fetchFn = makeFetch({
    "https://api.lever.co/v0/postings/stripe?mode=json": { status: 200, body: FIXTURE },
  });
  const jobs = await lever.discover([{ name: "Stripe", slug: "stripe" }], { fetchFn });
  assert.equal(jobs.length, 2);
  for (const j of jobs) assertJob(j);

  const [j1] = jobs;
  assert.equal(j1.source, "lever");
  assert.equal(j1.jobId, "a1b2c3d4-e5f6-7890-abcd-ef0123456789");
  assert.equal(j1.title, "Staff Product Manager");
  assert.deepEqual(j1.locations, ["New York", "Remote"]);
  assert.equal(j1.team, "Payments");
  assert.match(j1.postedAt, /^\d{4}-\d{2}-\d{2}$/);
});

test("lever.discover returns [] when body is not an array", async () => {
  const fetchFn = makeFetch({
    "https://api.lever.co/v0/postings/broken?mode=json": { status: 200, body: { error: "x" } },
  });
  const jobs = await lever.discover([{ name: "Broken", slug: "broken" }], { fetchFn });
  assert.deepEqual(jobs, []);
});
