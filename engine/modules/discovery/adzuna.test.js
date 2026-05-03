// Unit tests for the Adzuna discovery adapter.
// All network I/O is mocked via a fake fetchFn.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { discover, source, feedMode } = require("./adzuna.js");

function makeRes(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const LISTING = {
  id: 1234567890,
  title: "Senior Product Manager",
  company: { display_name: "Stripe" },
  location: { display_name: "San Francisco, CA" },
  redirect_url: "https://www.adzuna.com/land/ad/1234567890",
  created: "2026-04-20T10:00:00Z",
  description: "We are looking for a Senior PM...",
  contract_type: "permanent",
};

const LISTING_2 = {
  id: 9876543210,
  title: "Product Manager",
  company: { display_name: "Affirm" },
  location: { display_name: "Remote" },
  redirect_url: "https://www.adzuna.com/land/ad/9876543210",
  created: "2026-04-21T08:00:00Z",
  description: "PM role at Affirm...",
};

const SECRETS = { ADZUNA_APP_ID: "test_id", ADZUNA_API_KEY: "test_key" };

test("adzuna: exports correct source and feedMode", () => {
  assert.equal(source, "adzuna");
  assert.equal(feedMode, true);
});

test("adzuna: returns empty array when secrets missing", async () => {
  const warnings = [];
  const jobs = await discover([], {
    secrets: {},
    logger: { warn: (m) => warnings.push(m) },
  });
  assert.deepEqual(jobs, []);
  assert.ok(warnings.some((w) => w.includes("missing ADZUNA_APP_ID")));
});

test("adzuna: fetches and normalises jobs for each keyword", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return url.includes("what=Product+Manager")
      ? makeRes({ results: [LISTING] })
      : makeRes({ results: [LISTING_2] });
  };

  const jobs = await discover([], {
    fetchFn,
    secrets: SECRETS,
    discovery: {
      keyword_search: {
        keywords: ["Product Manager", "Senior Product Manager"],
        location: "United States",
        results_per_keyword: 50,
        max_age_days: 30,
      },
    },
    logger: { warn: () => {} },
  });

  assert.equal(calls.length, 2);
  assert.equal(jobs.length, 2);

  const stripe = jobs.find((j) => j.companyName === "Stripe");
  assert.ok(stripe);
  assert.equal(stripe.source, "adzuna");
  assert.equal(stripe.jobId, "1234567890");
  assert.equal(stripe.title, "Senior Product Manager");
  assert.equal(stripe.url, "https://www.adzuna.com/land/ad/1234567890");
  assert.equal(stripe.postedAt, "2026-04-20");
  assert.ok(stripe.locations.includes("San Francisco, CA"));
});

test("adzuna: dedupes same jobId across multiple keywords", async () => {
  const fetchFn = async () => makeRes({ results: [LISTING] });

  const jobs = await discover([], {
    fetchFn,
    secrets: SECRETS,
    discovery: { keyword_search: { keywords: ["Product Manager", "Senior PM"] } },
    logger: { warn: () => {} },
  });

  // Both keywords return LISTING (id=1234567890) → only one job
  assert.equal(jobs.length, 1);
});

test("adzuna: uses default keywords and params when no discovery config", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return makeRes({ results: [] });
  };

  await discover([], {
    fetchFn,
    secrets: SECRETS,
    logger: { warn: () => {} },
  });

  // Default is 2 keywords
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("what=Product+Manager"));
  assert.ok(calls[1].includes("what=Senior+Product+Manager"));
  assert.ok(calls[0].includes("where=United+States"));
  assert.ok(calls[0].includes("max_days=30"));
  assert.ok(calls[0].includes("results_per_page=50"));
});

test("adzuna: handles HTTP error gracefully and continues other keywords", async () => {
  const warnings = [];
  let call = 0;
  const fetchFn = async () => {
    call += 1;
    if (call === 1) return makeRes({}, 500);
    return makeRes({ results: [LISTING_2] });
  };

  const jobs = await discover([], {
    fetchFn,
    secrets: SECRETS,
    logger: { warn: (m) => warnings.push(m) },
  });

  assert.ok(warnings.some((w) => w.includes("HTTP 500")));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].companyName, "Affirm");
});

test("adzuna: skips listings missing id", async () => {
  const fetchFn = async () =>
    makeRes({ results: [LISTING, { title: "Bad job no id" }] });

  const jobs = await discover([], {
    fetchFn,
    secrets: SECRETS,
    logger: { warn: () => {} },
  });

  assert.equal(jobs.length, 1);
});
