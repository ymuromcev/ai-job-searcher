const { test } = require("node:test");
const assert = require("node:assert/strict");

const workday = require("./workday.js");
const { assertJob } = require("./_types.js");

function makeFetch(responses, recorded = []) {
  return async function (url, opts = {}) {
    const body = opts.body ? JSON.parse(opts.body) : null;
    recorded.push({ url, method: opts.method || "GET", body });
    const entries = responses[url];
    if (!entries) throw new Error(`unmocked url: ${url}`);
    const entry = typeof entries === "function" ? entries(body) : entries;
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

test("workday.discover paginates and maps jobs", async () => {
  const page1 = {
    total: 25,
    jobPostings: Array.from({ length: 20 }, (_, i) => ({
      title: `Product Manager ${i + 1}`,
      locationsText: "McLean, VA",
      externalPath: `/job/McLean/PM-${i + 1}/JR-${1000 + i}`,
      postedOn: "Posted Today",
    })),
  };
  const page2 = {
    total: 25,
    jobPostings: Array.from({ length: 5 }, (_, i) => ({
      title: `Product Manager ${i + 21}`,
      locationsText: "Remote",
      externalPath: `/job/Remote/PM-${i + 21}/JR-${1020 + i}`,
      postedOn: "Posted Yesterday",
    })),
  };

  const recorded = [];
  const fetchFn = makeFetch(
    {
      "https://capitalone.wd1.myworkdayjobs.com/wday/cxs/capitalone/jobs/jobs": (body) => {
        if (body.offset === 0) return { status: 200, body: page1 };
        if (body.offset === 20) return { status: 200, body: page2 };
        return { status: 200, body: { total: 25, jobPostings: [] } };
      },
    },
    recorded
  );

  const jobs = await workday.discover(
    [{ name: "Capital One", slug: "capitalone", dc: "wd1", searchText: "product manager" }],
    { fetchFn }
  );
  assert.equal(jobs.length, 25);
  for (const j of jobs) assertJob(j);

  const [j1] = jobs;
  assert.equal(j1.source, "workday");
  assert.equal(j1.companyName, "Capital One");
  assert.ok(j1.url.startsWith("https://capitalone.wd1.myworkdayjobs.com/en-US/jobs/"));
  assert.match(j1.postedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].method, "POST");
  assert.equal(recorded[0].body.searchText, "product manager");
});

test("workday.discover stops early when page is short", async () => {
  const recorded = [];
  const fetchFn = makeFetch(
    {
      "https://x.wd5.myworkdayjobs.com/wday/cxs/x/External/jobs": (body) => {
        if (body.offset === 0) {
          return {
            status: 200,
            body: {
              total: 100,
              jobPostings: [
                {
                  title: "Engineer",
                  locationsText: "NYC",
                  externalPath: "/job/NYC/Eng/JR-1",
                  postedOn: "2026-04-15",
                },
              ],
            },
          };
        }
        throw new Error("should not request next page");
      },
    },
    recorded
  );
  const jobs = await workday.discover(
    [{ name: "X", slug: "x", dc: "wd5", site: "External" }],
    { fetchFn }
  );
  assert.equal(jobs.length, 1);
  assert.equal(recorded.length, 1);
});

test("workday.discover drops postings without externalPath and warns", async () => {
  const fetchFn = makeFetch({
    "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/jobs/jobs": {
      status: 200,
      body: {
        total: 3,
        jobPostings: [
          { title: "Good", locationsText: "SF", externalPath: "/job/SF/Good/JR-1", postedOn: "2026-04-01" },
          { title: "NoPath", locationsText: "NY", postedOn: "2026-04-02" },
          { title: "EmptyPath", locationsText: "LA", externalPath: "", postedOn: "2026-04-03" },
        ],
      },
    },
  });
  const logs = [];
  const jobs = await workday.discover(
    [{ name: "Acme", slug: "acme" }],
    { fetchFn, logger: { warn: (m) => logs.push(m) } }
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobId, "/job/SF/Good/JR-1");
  assert.ok(logs.some((m) => m.includes("dropped 2 postings without externalPath")));
});

test("workday.discover loops over searchTexts and dedupes by externalPath", async () => {
  // Three queries, partial overlap on JR-100, JR-200, JR-300.
  // Expect 5 unique jobs after dedup, exactly 3 POST calls (one per query).
  const recorded = [];
  const responsesByQuery = {
    "patient access": [
      { title: "Patient Access Rep", locationsText: "Sac", externalPath: "/job/JR-100", postedOn: "2026-04-01" },
      { title: "Patient Access Coord", locationsText: "Sac", externalPath: "/job/JR-101", postedOn: "2026-04-02" },
    ],
    scheduler: [
      { title: "Patient Access Rep", locationsText: "Sac", externalPath: "/job/JR-100", postedOn: "2026-04-01" }, // dup of query 1
      { title: "Scheduler", locationsText: "Sac", externalPath: "/job/JR-200", postedOn: "2026-04-03" },
    ],
    "front desk": [
      { title: "Scheduler", locationsText: "Sac", externalPath: "/job/JR-200", postedOn: "2026-04-03" }, // dup of query 2
      { title: "Front Desk", locationsText: "Sac", externalPath: "/job/JR-300", postedOn: "2026-04-04" },
      { title: "Receptionist", locationsText: "Sac", externalPath: "/job/JR-301", postedOn: "2026-04-05" },
    ],
  };
  const fetchFn = makeFetch(
    {
      "https://sutterhealth.wd1.myworkdayjobs.com/wday/cxs/sutterhealth/SH/jobs": (body) => {
        if (body.offset !== 0) return { status: 200, body: { total: 0, jobPostings: [] } };
        const list = responsesByQuery[body.searchText] || [];
        return { status: 200, body: { total: list.length, jobPostings: list } };
      },
    },
    recorded
  );
  const jobs = await workday.discover(
    [
      {
        name: "Sutter Health",
        slug: "sutterhealth",
        dc: "wd1",
        site: "SH",
        searchTexts: ["patient access", "scheduler", "front desk"],
      },
    ],
    { fetchFn }
  );
  assert.equal(recorded.length, 3, "one POST per searchText");
  assert.equal(jobs.length, 5, "JR-100/101/200/300/301 after dedup");
  const ids = jobs.map((j) => j.jobId).sort();
  assert.deepEqual(ids, ["/job/JR-100", "/job/JR-101", "/job/JR-200", "/job/JR-300", "/job/JR-301"]);
  for (const j of jobs) assertJob(j);
});

test("workday.discover drops empty/whitespace entries from searchTexts (footgun guard)", async () => {
  // A typo/trailing-comma in extra_json must not silently burn a tenant-wide
  // pull. With ["a", "", "  ", "b"] the adapter should make exactly 2 POSTs.
  const recorded = [];
  const fetchFn = makeFetch(
    {
      "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/jobs/jobs": () => ({
        status: 200,
        body: { total: 0, jobPostings: [] },
      }),
    },
    recorded
  );
  await workday.discover(
    [{ name: "Acme", slug: "acme", searchTexts: ["a", "", "  ", "b", null, undefined] }],
    { fetchFn }
  );
  assert.equal(recorded.length, 2);
  assert.deepEqual(recorded.map((r) => r.body.searchText).sort(), ["a", "b"]);
});

test("workday.discover prefers searchTexts over searchText when both present", async () => {
  // Asserts the documented precedence: searchTexts wins.
  const recorded = [];
  const fetchFn = makeFetch(
    {
      "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/jobs/jobs": () => ({
        status: 200,
        body: { total: 0, jobPostings: [] },
      }),
    },
    recorded
  );
  await workday.discover(
    [
      {
        name: "Acme",
        slug: "acme",
        searchText: "ignored",
        searchTexts: ["a", "b"],
      },
    ],
    { fetchFn }
  );
  // 2 POSTs (one per searchTexts entry), neither carrying "ignored".
  assert.equal(recorded.length, 2);
  assert.deepEqual(
    recorded.map((r) => r.body.searchText).sort(),
    ["a", "b"]
  );
});

test("workday.discover isolates per-tenant failures", async () => {
  const fetchFn = makeFetch({
    "https://bad.wd1.myworkdayjobs.com/wday/cxs/bad/jobs/jobs": { status: 500, body: {} },
    "https://good.wd1.myworkdayjobs.com/wday/cxs/good/jobs/jobs": {
      status: 200,
      body: {
        total: 1,
        jobPostings: [
          {
            title: "PM",
            locationsText: "SF",
            externalPath: "/job/SF/PM/JR-9",
            postedOn: "2026-04-01",
          },
        ],
      },
    },
  });
  const logs = [];
  const jobs = await workday.discover(
    [
      { name: "Bad", slug: "bad" },
      { name: "Good", slug: "good" },
    ],
    { fetchFn, logger: { warn: (m) => logs.push(m) } }
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].slug, "good");
  assert.ok(logs.some((m) => m.includes("bad:")));
});
