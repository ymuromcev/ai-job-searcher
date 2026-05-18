const { test } = require("node:test");
const assert = require("node:assert/strict");

const workable = require("./workable.js");
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

const HF_URL = "https://apply.workable.com/api/v1/widget/accounts/huggingface";

const HF_FIXTURE = {
  name: "Hugging Face",
  description: "ML platform",
  jobs: [
    {
      title: "Cloud ML DevRel Engineer - EMEA remote",
      shortcode: "922D2C6549",
      employment_type: "Full-time",
      telecommuting: true,
      department: "Revenue-Share",
      url: "https://apply.workable.com/j/922D2C6549",
      shortlink: "https://apply.workable.com/j/922D2C6549",
      published_on: "2026-02-12",
      created_at: "2026-02-12",
      country: "France",
      city: "Paris",
      state: "Île-de-France",
      experience: "Mid-Senior level",
      function: "Engineering",
      industry: "Computer Software",
      locations: [
        {
          country: "France",
          countryCode: "FR",
          city: "Paris",
          region: "Île-de-France",
          hidden: false,
        },
      ],
    },
    {
      title: "Sparse Role",
      shortcode: "MIN001",
      url: "https://apply.workable.com/j/MIN001",
      published_on: null,
      country: "",
      city: "",
      state: "",
      locations: [],
    },
  ],
};

test("workable.discover maps fixture to normalized jobs", async () => {
  const fetchFn = makeFetch({ [HF_URL]: { status: 200, body: HF_FIXTURE } });
  const jobs = await workable.discover([{ name: "Hugging Face", slug: "huggingface" }], {
    fetchFn,
  });
  assert.equal(jobs.length, 2);
  for (const j of jobs) assertJob(j);

  const [j1, j2] = jobs;
  assert.equal(j1.source, "workable");
  assert.equal(j1.jobId, "922D2C6549");
  assert.equal(j1.title, "Cloud ML DevRel Engineer - EMEA remote");
  assert.equal(j1.url, "https://apply.workable.com/j/922D2C6549");
  assert.equal(j1.team, "Revenue-Share");
  assert.equal(j1.postedAt, "2026-02-12");
  assert.equal(j1.locations[0], "Remote");
  assert.ok(j1.locations.includes("Paris, Île-de-France, France"));
  assert.equal(j1.rawExtra.telecommuting, true);
  assert.equal(j1.rawExtra.experience, "Mid-Senior level");
  assert.equal(j1.rawExtra.function, "Engineering");

  assert.equal(j2.jobId, "MIN001");
  assert.deepEqual(j2.locations, []);
  assert.equal(j2.team, null);
  assert.equal(j2.postedAt, null);
  assert.equal(j2.rawExtra.telecommuting, false);
});

test("workable.discover hides locations flagged hidden:true and falls back to legacy city/state/country", async () => {
  const fetchFn = makeFetch({
    [HF_URL]: {
      status: 200,
      body: {
        jobs: [
          {
            title: "Hidden-loc Role",
            shortcode: "HID01",
            url: "https://apply.workable.com/j/HID01",
            published_on: "2026-05-01",
            telecommuting: false,
            country: "USA",
            city: "San Francisco",
            state: "CA",
            locations: [{ country: "USA", city: "Internal-Office", region: "CA", hidden: true }],
          },
        ],
      },
    },
  });
  const [j] = await workable.discover([{ name: "Hugging Face", slug: "huggingface" }], { fetchFn });
  assertJob(j);
  assert.ok(!j.locations.some((l) => l.includes("Internal-Office")));
  assert.ok(j.locations.some((l) => l.includes("San Francisco") && l.includes("USA")));
});

test("workable.discover handles fully-remote job with empty locations[] + no legacy fields", async () => {
  const fetchFn = makeFetch({
    [HF_URL]: {
      status: 200,
      body: {
        jobs: [
          {
            title: "Remote-only Role",
            shortcode: "REM01",
            url: "https://apply.workable.com/j/REM01",
            published_on: "2026-05-10",
            telecommuting: true,
            country: "",
            city: "",
            state: "",
            locations: [],
          },
        ],
      },
    },
  });
  const [j] = await workable.discover([{ name: "Hugging Face", slug: "huggingface" }], { fetchFn });
  assertJob(j);
  assert.deepEqual(j.locations, ["Remote"]);
});

test("workable.discover dedupes overlap between structured locations[] and legacy city/state/country", async () => {
  const fetchFn = makeFetch({ [HF_URL]: { status: 200, body: HF_FIXTURE } });
  const [j1] = await workable.discover([{ name: "Hugging Face", slug: "huggingface" }], {
    fetchFn,
  });
  // HF fixture: telecommuting:true (→ "Remote"), one structured location and a
  // matching legacy city/state/country triple — they MUST collapse into one
  // entry, so total length is 2 not 3.
  assert.equal(j1.locations.length, 2);
  assert.equal(j1.locations[0], "Remote");
});

test("workable.discover drops records with missing shortcode without aborting batch", async () => {
  const fetchFn = makeFetch({
    [HF_URL]: {
      status: 200,
      body: {
        jobs: [
          { title: "Broken — no id", url: "https://apply.workable.com/j/X" },
          {
            title: "Good",
            shortcode: "OK01",
            url: "https://apply.workable.com/j/OK01",
            published_on: "2026-05-15",
          },
        ],
      },
    },
  });
  const jobs = await workable.discover([{ name: "Hugging Face", slug: "huggingface" }], {
    fetchFn,
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobId, "OK01");
});

test("workable.discover synthesizes url from shortcode when url + shortlink missing", async () => {
  const fetchFn = makeFetch({
    [HF_URL]: {
      status: 200,
      body: {
        jobs: [
          {
            title: "No-url Role",
            shortcode: "FALLBK1",
            published_on: "2026-05-10",
            locations: [],
          },
        ],
      },
    },
  });
  const [j] = await workable.discover([{ name: "Hugging Face", slug: "huggingface" }], { fetchFn });
  assertJob(j);
  assert.equal(j.url, "https://apply.workable.com/j/FALLBK1");
});

test("workable.discover encodes slug and handles empty jobs array", async () => {
  const fetchFn = makeFetch({
    "https://apply.workable.com/api/v1/widget/accounts/foo.bar": {
      status: 200,
      body: { jobs: [] },
    },
  });
  const jobs = await workable.discover([{ name: "Foo", slug: "foo.bar" }], { fetchFn });
  assert.deepEqual(jobs, []);
});

test("workable.discover contains 404 per-target without aborting batch", async () => {
  const fetchFn = makeFetch({
    "https://apply.workable.com/api/v1/widget/accounts/missing": { status: 404, body: {} },
    [HF_URL]: { status: 200, body: { jobs: HF_FIXTURE.jobs.slice(0, 1) } },
  });
  const jobs = await workable.discover(
    [
      { name: "Missing", slug: "missing" },
      { name: "Hugging Face", slug: "huggingface" },
    ],
    { fetchFn }
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].slug, "huggingface");
});
