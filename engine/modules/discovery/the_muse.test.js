// Unit tests for The Muse discovery adapter.
// All network I/O is mocked via a fake fetchFn.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { discover, source, feedMode } = require("./the_muse.js");

function makeRes(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const PM_ITEM = {
  id: 111,
  name: "Senior Product Manager",
  company: { name: "Plaid" },
  locations: [{ name: "San Francisco, CA" }],
  refs: { landing_page: "https://www.themuse.com/jobs/plaid/senior-pm" },
  publication_date: "2026-04-22T09:00:00Z",
  levels: [{ name: "Senior Level" }],
};

const SPM_ITEM = {
  id: 222,
  name: "Product Manager, Payments",
  company: { name: "Marqeta" },
  locations: [{ name: "Oakland, CA" }, { name: "Remote" }],
  refs: { landing_page: "https://www.themuse.com/jobs/marqeta/pm" },
  publication_date: "2026-04-21T12:00:00Z",
  levels: [{ name: "Mid Level" }],
};

const DESIGNER_ITEM = {
  id: 333,
  name: "Senior Product Designer",
  company: { name: "Airbnb" },
  locations: [{ name: "Remote" }],
  refs: { landing_page: "https://www.themuse.com/jobs/airbnb/designer" },
  publication_date: "2026-04-20T00:00:00Z",
  levels: [{ name: "Senior Level" }],
};

const ANALYST_ITEM = {
  id: 444,
  name: "Product Analyst",
  company: { name: "SoFi" },
  locations: [],
  refs: { landing_page: "https://www.themuse.com/jobs/sofi/analyst" },
  publication_date: "2026-04-19T00:00:00Z",
  levels: [],
};

test("the_muse: exports correct source and feedMode", () => {
  assert.equal(source, "the_muse");
  assert.equal(feedMode, true);
});

test("the_muse: filters out designer and analyst, keeps PM/SPM", async () => {
  const fetchFn = async () =>
    makeRes({
      results: [PM_ITEM, SPM_ITEM, DESIGNER_ITEM, ANALYST_ITEM],
      page_count: 1,
    });

  const jobs = await discover([], { fetchFn, logger: { warn: () => {} } });

  assert.equal(jobs.length, 2);
  const companies = jobs.map((j) => j.companyName);
  assert.ok(companies.includes("Plaid"));
  assert.ok(companies.includes("Marqeta"));
  assert.ok(!companies.includes("Airbnb"));
  assert.ok(!companies.includes("SoFi"));
});

test("the_muse: normalises job fields correctly", async () => {
  const fetchFn = async () =>
    makeRes({ results: [PM_ITEM], page_count: 1 });

  const [job] = await discover([], { fetchFn, logger: { warn: () => {} } });

  assert.equal(job.source, "the_muse");
  assert.equal(job.jobId, "111");
  assert.equal(job.companyName, "Plaid");
  assert.equal(job.title, "Senior Product Manager");
  assert.equal(job.url, "https://www.themuse.com/jobs/plaid/senior-pm");
  assert.equal(job.postedAt, "2026-04-22");
  assert.deepEqual(job.locations, ["San Francisco, CA"]);
  assert.equal(job.slug, "plaid");
});

test("the_muse: paginates until page_count reached", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    const pageParam = new URL(url).searchParams.get("page") || "0";
    const page = Number(pageParam);
    return makeRes({
      results: [{ ...PM_ITEM, id: 1000 + page }],
      page_count: 3,
    });
  };

  const jobs = await discover([], { fetchFn, logger: { warn: () => {} } });

  assert.equal(calls.length, 3);
  assert.equal(jobs.length, 3);
});

test("the_muse: stops early when results array is empty", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get("page") || "0");
    if (page === 0) return makeRes({ results: [PM_ITEM], page_count: 5 });
    return makeRes({ results: [], page_count: 5 });
  };

  const jobs = await discover([], { fetchFn, logger: { warn: () => {} } });

  assert.equal(calls.length, 2); // page 0 → results; page 1 → empty → stop
  assert.equal(jobs.length, 1);
});

test("the_muse: handles HTTP error gracefully, returns accumulated jobs", async () => {
  const warnings = [];
  let call = 0;
  const fetchFn = async () => {
    call += 1;
    if (call === 1) return makeRes({ results: [PM_ITEM], page_count: 2 });
    return makeRes({}, 503);
  };

  const jobs = await discover([], { fetchFn, logger: { warn: (m) => warnings.push(m) } });

  assert.ok(warnings.some((w) => w.includes("HTTP 503")));
  assert.equal(jobs.length, 1);
});

test("the_muse: PM_RE matches product lead and product owner", async () => {
  const leadItem = { ...PM_ITEM, id: 501, name: "Product Lead, Growth" };
  const ownerItem = { ...PM_ITEM, id: 502, name: "Product Owner" };
  const fetchFn = async () =>
    makeRes({ results: [leadItem, ownerItem], page_count: 1 });

  const jobs = await discover([], { fetchFn, logger: { warn: () => {} } });
  assert.equal(jobs.length, 2);
});
