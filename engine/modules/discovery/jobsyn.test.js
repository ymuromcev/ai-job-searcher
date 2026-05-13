const { test } = require("node:test");
const assert = require("node:assert/strict");

const jobsyn = require("./jobsyn.js");
const { assertJob } = require("./_types.js");

const API_BASE = "https://prod-search-api.jobsyn.org/api/v1/solr/search";
const DCI_ORIGIN = "dciinc.jobs";

function wrap(jobs, pagination) {
  return { jobs, pagination, featured_jobs: [], filters: [], meta: {} };
}

function pagination({ page, has_more_pages, page_size = 100, total = 0 }) {
  return {
    page,
    page_size,
    offset: (page - 1) * page_size,
    has_more_pages: !!has_more_pages,
    total,
    total_pages: Math.max(1, Math.ceil(total / page_size)),
  };
}

let guidCounter = 0;
function nextGuid() {
  guidCounter += 1;
  return guidCounter.toString(16).toUpperCase().padStart(32, "0");
}

function makeJob(overrides = {}) {
  return {
    guid: nextGuid(),
    title_exact: "Registered Nurse",
    location_exact: "Sacramento, CA",
    city_exact: "Sacramento",
    state_short: "CA",
    date_new: "2026-05-05T19:45:29Z",
    date_added: "2026-05-11T13:50:06Z",
    reqid: "2026-23420",
    buid: 18343,
    category_exact: "Nursing",
    ...overrides,
  };
}

function parsePage(url) {
  const m = url.match(/[?&]page=(\d+)/);
  return m ? Number(m[1]) : 0;
}

function makeFetch(responses, recorded = []) {
  return async function (url, opts = {}) {
    recorded.push({
      url,
      method: (opts && opts.method) || "GET",
      headers: opts && opts.headers ? { ...opts.headers } : {},
    });
    const pathOnly = url.split("?")[0];
    const entries = responses[pathOnly];
    if (!entries) throw new Error(`unmocked url: ${url}`);
    const entry = typeof entries === "function" ? entries(url) : entries;
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

test("jobsyn.discover paginates and maps jobs (has_more_pages driven)", async () => {
  guidCounter = 0;
  const page1Jobs = Array.from({ length: 100 }, () => makeJob());
  const page2Jobs = Array.from({ length: 50 }, () => makeJob());
  const recorded = [];
  const fetchFn = makeFetch(
    {
      [API_BASE]: (url) => {
        const page = parsePage(url);
        if (page === 1) {
          return {
            status: 200,
            body: wrap(page1Jobs, pagination({ page: 1, has_more_pages: true, total: 150 })),
          };
        }
        if (page === 2) {
          return {
            status: 200,
            body: wrap(page2Jobs, pagination({ page: 2, has_more_pages: false, total: 150 })),
          };
        }
        throw new Error(`unexpected page ${page}`);
      },
    },
    recorded
  );
  const jobs = await jobsyn.discover(
    [{ name: "Dialysis Clinic Inc", slug: "dciinc", origin: DCI_ORIGIN }],
    { fetchFn }
  );
  assert.equal(jobs.length, 150);
  for (const j of jobs) assertJob(j);
  const [j0] = jobs;
  assert.equal(j0.source, "jobsyn");
  assert.equal(j0.companyName, "Dialysis Clinic Inc");
  assert.equal(j0.slug, "dciinc");
  assert.equal(j0.title, "Registered Nurse");
  assert.match(j0.jobId, /^[0-9A-F]{32}$/);
  assert.equal(j0.url, `https://${DCI_ORIGIN}/job/${j0.jobId}`);
  assert.deepEqual(j0.locations, ["Sacramento, CA"]);
  assert.equal(j0.team, "Nursing");
  assert.equal(j0.postedAt, "2026-05-05");
  assert.equal(j0.rawExtra.reqid, "2026-23420");
  assert.equal(j0.rawExtra.buid, 18343);
  assert.equal(recorded.length, 2);
  for (const r of recorded) {
    assert.equal(r.method, "GET");
    assert.equal(r.headers["X-Origin"], DCI_ORIGIN);
    assert.equal(r.headers.Accept, "application/json");
  }
  assert.ok(recorded[0].url.includes("page=1"));
  assert.ok(recorded[0].url.includes("num_items=100"));
  assert.ok(recorded[1].url.includes("page=2"));
});

test("jobsyn.discover stops at page 1 when has_more_pages=false", async () => {
  guidCounter = 0;
  const jobs1 = Array.from({ length: 30 }, () => makeJob());
  const recorded = [];
  const fetchFn = makeFetch(
    {
      [API_BASE]: () => ({
        status: 200,
        body: wrap(jobs1, pagination({ page: 1, has_more_pages: false, total: 30 })),
      }),
    },
    recorded
  );
  const jobs = await jobsyn.discover([{ name: "DCI", slug: "dciinc", origin: DCI_ORIGIN }], {
    fetchFn,
  });
  assert.equal(jobs.length, 30);
  assert.equal(recorded.length, 1, "should not request page 2 when has_more_pages is false");
});

test("jobsyn.discover drops postings outside locationAllow", async () => {
  guidCounter = 0;
  const jobs = [
    makeJob({ location_exact: "Sacramento, CA" }),
    makeJob({ location_exact: "Roseville, CA" }),
    makeJob({ location_exact: "Nashville, TN" }),
    makeJob({ location_exact: "Folsom, CA" }),
    makeJob({ location_exact: "Albuquerque, NM" }),
  ];
  const fetchFn = makeFetch({
    [API_BASE]: {
      status: 200,
      body: wrap(jobs, pagination({ page: 1, has_more_pages: false, total: 5 })),
    },
  });
  const logs = [];
  const out = await jobsyn.discover(
    [
      {
        name: "DCI",
        slug: "dciinc",
        origin: DCI_ORIGIN,
        locationAllow: ["Sacramento", "Roseville", "Folsom"],
      },
    ],
    { fetchFn, logger: { warn: (m) => logs.push(m) } }
  );
  assert.equal(out.length, 3);
  const cities = out.map((j) => j.locations[0]).sort();
  assert.deepEqual(cities, ["Folsom, CA", "Roseville, CA", "Sacramento, CA"]);
  assert.ok(logs.some((m) => m.includes("dropped 2 postings outside locationAllow")));
});

test("jobsyn.discover locationAllow is case-insensitive and trims patterns", async () => {
  guidCounter = 0;
  const jobs = [
    makeJob({ location_exact: "SACRAMENTO, CA" }),
    makeJob({ location_exact: "Houston, TX" }),
  ];
  const fetchFn = makeFetch({
    [API_BASE]: {
      status: 200,
      body: wrap(jobs, pagination({ page: 1, has_more_pages: false, total: 2 })),
    },
  });
  const out = await jobsyn.discover(
    [
      {
        name: "DCI",
        slug: "dciinc",
        origin: DCI_ORIGIN,
        locationAllow: ["  sacramento  ", "", null],
      },
    ],
    { fetchFn }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].locations[0], "SACRAMENTO, CA");
});

test("jobsyn.discover returns [] when target has no origin", async () => {
  const recorded = [];
  const fetchFn = makeFetch({}, recorded);
  const logs = [];
  const jobs = await jobsyn.discover([{ name: "Bad", slug: "bad" }], {
    fetchFn,
    logger: { warn: (m) => logs.push(m) },
  });
  assert.equal(jobs.length, 0);
  assert.equal(recorded.length, 0, "fetchFn must not be called when origin is missing");
  assert.ok(logs.some((m) => m.includes("invalid origin")));
});

test("jobsyn.discover rejects malformed origins (header-injection guard)", async () => {
  const recorded = [];
  const fetchFn = makeFetch({}, recorded);
  const logs = [];
  const cases = [
    "dciinc.jobs\r\nX-Injection: 1", // CRLF header injection
    "dciinc.jobs\nX-Injection: 1", // LF only
    " dciinc.jobs", // leading space
    "dciinc.jobs ", // trailing space
    "dciinc.jobs/path", // path segment
    "https://dciinc.jobs", // scheme-prefixed
    "", // empty
    "a".repeat(300), // way too long
    "  ", // whitespace-only
    "\tdci.jobs", // tab
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const out = await jobsyn.discover([{ name: `Bad ${i}`, slug: `bad${i}`, origin: cases[i] }], {
      fetchFn,
      logger: { warn: (m) => logs.push(m) },
    });
    assert.equal(out.length, 0, `case ${i} (${JSON.stringify(cases[i])}) should yield 0 jobs`);
  }
  assert.equal(recorded.length, 0, "no fetch may happen for any malformed origin");
  assert.equal(logs.length, cases.length, "each rejected case must produce one warn line");
  for (const m of logs) assert.ok(m.includes("invalid origin"));
});

test("jobsyn.discover drops target when mid-pagination page fails", async () => {
  guidCounter = 0;
  const page1Jobs = Array.from({ length: 100 }, () => makeJob());
  const recorded = [];
  const fetchFn = makeFetch(
    {
      [API_BASE]: (url) => {
        const page = parsePage(url);
        if (page === 1) {
          return {
            status: 200,
            body: wrap(page1Jobs, pagination({ page: 1, has_more_pages: true, total: 500 })),
          };
        }
        if (page === 2) return { status: 500, body: { error: "boom" } };
        throw new Error(`unexpected page ${page}`);
      },
    },
    recorded
  );
  const logs = [];
  const jobs = await jobsyn.discover([{ name: "DCI", slug: "dciinc", origin: DCI_ORIGIN }], {
    fetchFn,
    logger: { warn: (m) => logs.push(m) },
  });
  assert.equal(jobs.length, 0, "partial-page failures must NOT leak page-1 jobs into the pool");
  assert.equal(recorded.length, 2);
  assert.ok(
    logs.some((m) => m.includes("dciinc") && m.includes("500")),
    `expected per-target warn mentioning HTTP 500, got: ${JSON.stringify(logs)}`
  );
});

test("jobsyn.discover tolerates empty jobs array", async () => {
  const fetchFn = makeFetch({
    [API_BASE]: {
      status: 200,
      body: wrap([], pagination({ page: 1, has_more_pages: false, total: 0 })),
    },
  });
  const jobs = await jobsyn.discover([{ name: "DCI", slug: "dciinc", origin: DCI_ORIGIN }], {
    fetchFn,
  });
  assert.equal(jobs.length, 0);
});

test("jobsyn.discover stops on missing pagination block (defensive)", async () => {
  guidCounter = 0;
  const someJobs = [makeJob()];
  const recorded = [];
  const fetchFn = makeFetch(
    {
      [API_BASE]: { status: 200, body: { jobs: someJobs } }, // no pagination at all
    },
    recorded
  );
  const jobs = await jobsyn.discover([{ name: "DCI", slug: "dciinc", origin: DCI_ORIGIN }], {
    fetchFn,
  });
  assert.equal(jobs.length, 1);
  assert.equal(recorded.length, 1, "should stop walking pages when pagination block is absent");
});

test("jobsyn.discover drops postings without guid and warns", async () => {
  guidCounter = 0;
  const jobs = [
    makeJob(),
    { title_exact: "No GUID", location_exact: "Sacramento, CA" },
    { guid: "", title_exact: "Empty GUID", location_exact: "Sacramento, CA" },
    { guid: "   ", title_exact: "Whitespace GUID", location_exact: "Sacramento, CA" },
  ];
  const fetchFn = makeFetch({
    [API_BASE]: {
      status: 200,
      body: wrap(jobs, pagination({ page: 1, has_more_pages: false, total: 4 })),
    },
  });
  const logs = [];
  const out = await jobsyn.discover([{ name: "DCI", slug: "dciinc", origin: DCI_ORIGIN }], {
    fetchFn,
    logger: { warn: (m) => logs.push(m) },
  });
  assert.equal(out.length, 1);
  assert.ok(logs.some((m) => m.includes("dropped 3 postings without guid")));
});

test("jobsyn.discover isolates per-tenant failures", async () => {
  guidCounter = 0;
  const goodJobs = [makeJob({ location_exact: "Sacramento, CA" })];
  const recorded = [];
  const fetchFn = async (url, opts = {}) => {
    recorded.push({ url, headers: { ...(opts.headers || {}) } });
    const origin = (opts.headers || {})["X-Origin"];
    if (origin === DCI_ORIGIN) {
      return {
        ok: false,
        status: 500,
        async json() {
          return {};
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return wrap(goodJobs, pagination({ page: 1, has_more_pages: false, total: 1 }));
      },
    };
  };
  const logs = [];
  const jobs = await jobsyn.discover(
    [
      { name: "DCI", slug: "dciinc", origin: DCI_ORIGIN },
      { name: "Other Tenant", slug: "other", origin: "other-employer.jobs" },
    ],
    { fetchFn, logger: { warn: (m) => logs.push(m) } }
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].slug, "other");
  assert.ok(logs.some((m) => m.includes("dciinc")));
});

test("jobsyn.discover falls back from location_exact to city+state", async () => {
  guidCounter = 0;
  const jobs = [
    makeJob({ location_exact: null, city_exact: "Folsom", state_short: "CA" }),
    makeJob({ location_exact: "", city_exact: "Roseville", state_short: "CA" }),
    makeJob({ location_exact: null, city_exact: "Boston", state_short: "MA" }),
  ];
  const fetchFn = makeFetch({
    [API_BASE]: {
      status: 200,
      body: wrap(jobs, pagination({ page: 1, has_more_pages: false, total: 3 })),
    },
  });
  const out = await jobsyn.discover(
    [
      {
        name: "DCI",
        slug: "dciinc",
        origin: DCI_ORIGIN,
        locationAllow: ["Folsom", "Roseville"],
      },
    ],
    { fetchFn }
  );
  assert.equal(out.length, 2);
  const cities = out.map((j) => j.locations[0]).sort();
  assert.deepEqual(cities, ["Folsom, CA", "Roseville, CA"]);
});

test("jobsyn.discover prefers date_new over date_added; falls back when date_new missing", async () => {
  guidCounter = 0;
  const jobs = [
    makeJob({ date_new: "2026-05-05T19:45:29Z", date_added: "2026-05-11T13:50:06Z" }),
    makeJob({ date_new: null, date_added: "2026-05-09T00:00:00Z" }),
    makeJob({ date_new: undefined, date_added: undefined }),
  ];
  const fetchFn = makeFetch({
    [API_BASE]: {
      status: 200,
      body: wrap(jobs, pagination({ page: 1, has_more_pages: false, total: 3 })),
    },
  });
  const out = await jobsyn.discover([{ name: "DCI", slug: "dciinc", origin: DCI_ORIGIN }], {
    fetchFn,
  });
  assert.equal(out.length, 3);
  assert.equal(out[0].postedAt, "2026-05-05");
  assert.equal(out[1].postedAt, "2026-05-09");
  assert.equal(out[2].postedAt, null);
});

test("jobsyn.discover apply URL composes from origin + guid", async () => {
  guidCounter = 0;
  const myGuid = "CC6AB92478BD4F7DA804C46A786BE429";
  const jobs = [makeJob({ guid: myGuid, location_exact: "Sacramento, CA" })];
  const fetchFn = makeFetch({
    [API_BASE]: {
      status: 200,
      body: wrap(jobs, pagination({ page: 1, has_more_pages: false, total: 1 })),
    },
  });
  const out = await jobsyn.discover([{ name: "DCI", slug: "dciinc", origin: DCI_ORIGIN }], {
    fetchFn,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].jobId, myGuid);
  assert.equal(out[0].url, `https://${DCI_ORIGIN}/job/${myGuid}`);
});

test("jobsyn.discover stops at MAX_JOBS_PER_TENANT cap on runaway has_more_pages", async () => {
  guidCounter = 0;
  let fetchCount = 0;
  const fetchFn = async (url, opts = {}) => {
    fetchCount += 1;
    const pageJobs = Array.from({ length: 100 }, () => makeJob());
    return {
      ok: true,
      status: 200,
      async json() {
        // Always claims more pages — adapter must stop on its own.
        return wrap(
          pageJobs,
          pagination({ page: parsePage(url), has_more_pages: true, total: 999999 })
        );
      },
    };
  };
  const jobs = await jobsyn.discover([{ name: "DCI", slug: "dciinc", origin: DCI_ORIGIN }], {
    fetchFn,
  });
  // Cap is 5000; with PAGE_SIZE=100 that's 50 fetches.
  assert.equal(jobs.length, 5000, `expected MAX_JOBS_PER_TENANT cap, got ${jobs.length}`);
  assert.equal(fetchCount, 50, `expected 50 fetches (cap/page_size), got ${fetchCount}`);
});

test("jobsyn.discover caps concurrency at 2 even when ctx asks for more", async () => {
  guidCounter = 0;
  let inFlight = 0;
  let peak = 0;
  const targets = Array.from({ length: 6 }, (_, i) => ({
    name: `Tenant ${i}`,
    slug: `t${i}`,
    origin: `tenant${i}.jobs`,
  }));
  const fetchFn = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    // Yield to event loop so concurrent requests overlap before resolving.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    inFlight -= 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return wrap([makeJob()], pagination({ page: 1, has_more_pages: false, total: 1 }));
      },
    };
  };
  await jobsyn.discover(targets, { fetchFn, concurrency: 8 });
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded cap of 2`);
});
