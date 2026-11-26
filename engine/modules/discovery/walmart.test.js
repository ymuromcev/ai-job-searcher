const { test } = require("node:test");
const assert = require("node:assert/strict");

const walmart = require("./walmart.js");
const { assertJob } = require("./_types.js");

const { mapJob, queriesFor, QUERY_ID, API_URL } = walmart._internal;
const TARGET = { name: "Walmart", slug: "walmart" };

function rawJob(i, overrides = {}) {
  return {
    job_id: `R-26${String(i).padStart(5, "0")}`,
    title: `Senior Product Manager ${i}`,
    jobPostingTitle: `(USA) Senior Product Manager ${i}`,
    city: "SUNNYVALE",
    state: "CA",
    country: "US",
    additionalLocationCities: [],
    minPay: 117000,
    maxPay: 234000,
    payFrequency: "Annual",
    brand: "Walmart",
    categories: ["Product Management"],
    jobPostingStartDate: Date.UTC(2026, 10, 20),
    ...overrides,
  };
}

function page(jobs, total) {
  return {
    data: {
      jobSearchAssistant: {
        tool_messages: [{ artifact: { totalResults: total, page_size: 10, jobs } }],
      },
    },
  };
}

function makeFetch(script) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    const entry = script.shift();
    if (!entry) throw new Error(`unscripted fetch: ${url}`);
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      async json() {
        return entry.body;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

test("mapJob builds a valid normalized job", () => {
  const job = mapJob(TARGET, rawJob(1, { additionalLocationCities: ["SAN FRANCISCO, CA"] }));
  assertJob(job);
  assert.equal(job.source, "walmart");
  assert.equal(job.jobId, "R-2600001");
  assert.equal(job.title, "(USA) Senior Product Manager 1");
  assert.equal(job.url, "https://careers.walmart.com/us/en/jobs/R-2600001");
  assert.deepEqual(job.locations, ["Sunnyvale, CA", "San Francisco, CA"]);
  assert.equal(job.postedAt, "2026-11-20");
  assert.equal(job.team, "Product Management");
  assert.equal(job.rawExtra.minPay, 117000);
  assert.equal(job.rawExtra.maxPay, 234000);
});

test("mapJob drops rows with a bad id or no title", () => {
  assert.equal(mapJob(TARGET, rawJob(1, { job_id: "../evil" })), null);
  assert.equal(mapJob(TARGET, rawJob(1, { title: "", jobPostingTitle: "" })), null);
  assert.equal(mapJob(TARGET, null), null);
});

test("queriesFor: searchTexts wins, then searchText, then default", () => {
  assert.deepEqual(queriesFor({ searchTexts: ["A", " ", "B"], searchText: "C" }), ["A", "B"]);
  assert.deepEqual(queriesFor({ searchText: "C" }), ["C"]);
  assert.equal(queriesFor({})[0], "Senior Product Manager");
});

test("discover pages until total is reached and dedups across queries", async () => {
  const p0 = Array.from({ length: 10 }, (_, i) => rawJob(i));
  const p1 = [rawJob(10), rawJob(11)];
  const fetchFn = makeFetch([
    { status: 200, body: page(p0, 12) },
    { status: 200, body: page(p1, 12) },
    { status: 200, body: page([rawJob(0), rawJob(50)], 2) },
  ]);
  const jobs = await walmart.discover(
    [{ ...TARGET, maxPages: 5, searchTexts: ["Product Manager", "Senior Product Manager"] }],
    { fetchFn }
  );
  assert.equal(fetchFn.calls.length, 3);
  assert.equal(jobs.length, 13);
  const first = fetchFn.calls[0];
  assert.equal(first.url, API_URL);
  assert.equal(first.opts.method, "POST");
  assert.equal(first.body.queryId, QUERY_ID);
  const ctx = first.body.variables.chatRequest.context.job_search_context;
  assert.equal(ctx.refined_query, "Product Manager");
  assert.equal(ctx.job_page, 0);
  assert.equal(fetchFn.calls[1].body.variables.chatRequest.context.job_search_context.job_page, 1);
});

test("discover stops on an empty page and survives a shape change", async () => {
  const fetchFn = makeFetch([{ status: 200, body: { data: null } }]);
  const jobs = await walmart.discover([{ ...TARGET, searchTexts: ["A"], maxPages: 5 }], {
    fetchFn,
  });
  assert.deepEqual(jobs, []);
  assert.equal(fetchFn.calls.length, 1);
});

test("discover contains an HTTP error to a warning", async () => {
  const warnings = [];
  const fetchFn = makeFetch([{ status: 422, body: {} }]);
  const jobs = await walmart.discover([{ ...TARGET, searchTexts: ["A"] }], {
    fetchFn,
    logger: { warn: (m) => warnings.push(m) },
  });
  assert.deepEqual(jobs, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /walmart/);
});

test("discover reads only the first page per query by default", async () => {
  const fetchFn = makeFetch([
    { status: 200, body: page([rawJob(1)], 500) },
    { status: 200, body: page([rawJob(2)], 500) },
  ]);
  const jobs = await walmart.discover([{ ...TARGET, searchTexts: ["A", "B"] }], { fetchFn });
  assert.equal(fetchFn.calls.length, 2);
  assert.equal(jobs.length, 2);
});

test("mapJob drops non-US rows and tolerates bad dates", () => {
  assert.equal(mapJob(TARGET, rawJob(1, { city: "CHENNAI", state: "TN", country: "IN" })), null);
  assert.equal(mapJob(TARGET, rawJob(1, { jobPostingStartDate: 1e20 })).postedAt, null);
  assert.equal(mapJob(TARGET, rawJob(1, { jobPostingStartDate: 1795046400 })).postedAt, null);
  assert.notEqual(mapJob(TARGET, rawJob(1, { country: "" })), null);
});
