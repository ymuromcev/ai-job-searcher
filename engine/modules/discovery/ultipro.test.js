const { test } = require("node:test");
const assert = require("node:assert/strict");

const ultipro = require("./ultipro.js");
const { assertJob } = require("./_types.js");

const TENANT = "WES1023";
const BOARD = "6b442184-52a5-4635-8db5-5aa4bed2a563";
const HOST = "recruiting";
const LIST_URL = `https://${HOST}.ultipro.com/${TENANT}/JobBoard/${BOARD}/JobBoardView/LoadSearchResults`;

function makeJob(i, overrides = {}) {
  return {
    Id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    Title: `RN ${i}`,
    RequisitionNumber: `REQ-${i}`,
    PostingDate: "2026-05-20T00:00:00Z",
    JobCategoryName: "Nursing",
    EmploymentTypeName: "Full Time",
    BriefDescription: `Brief ${i}`,
    Locations: [
      {
        LocalizedName: "Sacramento, CA, USA",
        Address: { City: "Sacramento", State: "CA", CountryCode: "USA" },
      },
    ],
    ...overrides,
  };
}

// Fakes the global fetch contract used by adapters: returns
// { ok, status, json(), text() }. `script` is an array of canned responses;
// each call shifts the next entry. Also records every request for assertions.
function makeFetch(script) {
  const calls = [];
  const fn = async function (url, opts = {}) {
    calls.push({ url, opts });
    const entry = script.shift();
    if (!entry) throw new Error(`unscripted fetch: ${url}`);
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      async json() {
        return entry.body;
      },
      async text() {
        return JSON.stringify(entry.body);
      },
    };
  };
  fn.calls = calls;
  return fn;
}

const TARGET = {
  name: "Sonrava Health",
  slug: TENANT,
  rawExtra: { host: HOST, boardId: BOARD },
};

test("ultipro.discover happy path — paginates via Skip/Top until totalCount", async () => {
  const page0 = {
    opportunities: Array.from({ length: 50 }, (_, i) => makeJob(i + 1)),
    totalCount: 73,
  };
  const page1 = {
    opportunities: Array.from({ length: 23 }, (_, i) => makeJob(i + 51)),
    totalCount: 73,
  };
  const fetchFn = makeFetch([
    { status: 200, body: page0 },
    { status: 200, body: page1 },
  ]);

  const jobs = await ultipro.discover([TARGET], { fetchFn });

  assert.equal(jobs.length, 73);
  for (const j of jobs) assertJob(j);
  assert.equal(fetchFn.calls.length, 2, "exactly two pages requested");

  for (const c of fetchFn.calls) {
    assert.equal(c.url, LIST_URL);
    assert.equal(c.opts.method, "POST");
    assert.equal(c.opts.headers["X-Requested-With"], "XMLHttpRequest");
    assert.match(c.opts.headers["Content-Type"], /application\/json/);
  }
  assert.equal(JSON.parse(fetchFn.calls[0].opts.body).opportunitySearch.Skip, 0);
  assert.equal(JSON.parse(fetchFn.calls[1].opts.body).opportunitySearch.Skip, 50);

  assert.equal(jobs[0].source, "ultipro");
  assert.equal(jobs[0].slug, TENANT);
  assert.equal(jobs[0].title, "RN 1");
  assert.equal(jobs[0].team, "Nursing");
  assert.equal(jobs[0].locations[0], "Sacramento, CA, USA");
  assert.equal(jobs[0].postedAt, "2026-05-20");
  assert.equal(jobs[0].rawExtra.requisition, "REQ-1");
  assert.equal(jobs[0].rawExtra.boardId, BOARD);
  assert.match(
    jobs[0].url,
    /OpportunityDetail\?opportunityId=00000000-0000-0000-0000-000000000001$/
  );
});

test("ultipro.discover single-page (totalCount=0) stops after one request", async () => {
  const fetchFn = makeFetch([{ status: 200, body: { opportunities: [], totalCount: 0 } }]);
  const jobs = await ultipro.discover([TARGET], { fetchFn });
  assert.deepEqual(jobs, []);
  assert.equal(fetchFn.calls.length, 1);
});

test("ultipro.discover hits MAX_PAGES safety cap on runaway tenant", async () => {
  const { PAGE_SIZE, MAX_PAGES } = ultipro._internal;
  // Always returns a full page + huge totalCount → would loop forever without cap
  const script = Array.from({ length: MAX_PAGES + 2 }, (_, i) => ({
    status: 200,
    body: {
      opportunities: Array.from({ length: PAGE_SIZE }, (_, k) => makeJob(i * PAGE_SIZE + k + 1)),
      totalCount: 999999,
    },
  }));
  const fetchFn = makeFetch(script);
  const warns = [];
  const jobs = await ultipro.discover([TARGET], {
    fetchFn,
    logger: { warn: (m) => warns.push(m) },
  });
  assert.equal(fetchFn.calls.length, MAX_PAGES, "stops at MAX_PAGES");
  assert.equal(jobs.length, MAX_PAGES * PAGE_SIZE);
  assert.ok(
    warns.some((m) => /MAX_PAGES/.test(m)),
    "logs a warn when ceiling is hit"
  );
});

test("ultipro.discover skips target with missing/invalid extra_json — no fetch", async () => {
  const fetchFn = makeFetch([]);
  const warns = [];
  const jobs = await ultipro.discover(
    [{ name: "X", slug: "BAD", rawExtra: { host: HOST /* no boardId */ } }],
    { fetchFn, logger: { warn: (m) => warns.push(m) } }
  );
  assert.deepEqual(jobs, []);
  assert.equal(fetchFn.calls.length, 0, "no fetch issued when boardId missing");
  assert.ok(warns.some((m) => /missing.+host\|boardId/.test(m)));
});

test("ultipro.discover containment: bad opportunity dropped, others survive", async () => {
  const page0 = {
    opportunities: [
      makeJob(1),
      { Id: "", Title: "missing id" }, // mapJob drops this
      makeJob(2),
    ],
    totalCount: 2,
  };
  const fetchFn = makeFetch([{ status: 200, body: page0 }]);
  const jobs = await ultipro.discover([TARGET], { fetchFn });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].jobId, "00000000-0000-0000-0000-000000000001");
});

test("ultipro.discover 404 contained per-target — batch continues", async () => {
  const fetchFn = makeFetch([
    { status: 404, body: {} },
    { status: 200, body: { opportunities: [makeJob(99)], totalCount: 1 } },
  ]);
  const warns = [];
  const T2 = { name: "B", slug: "TST2222", rawExtra: { host: HOST, boardId: BOARD } };
  const jobs = await ultipro.discover([TARGET, T2], {
    fetchFn,
    logger: { warn: (m) => warns.push(m) },
    concurrency: 1,
  });
  assert.equal(jobs.length, 1, "second target produced its job; first contained");
  assert.equal(jobs[0].jobId, "00000000-0000-0000-0000-000000000099");
  assert.ok(warns.some((m) => /HTTP 404/.test(m)));
});

test("ultipro mapJob: IsRemote location yields 'Remote' string", async () => {
  const page0 = {
    opportunities: [
      makeJob(1, {
        Locations: [
          { IsRemote: true },
          { Address: { City: "Sacramento", State: "CA", CountryCode: "USA" } },
        ],
      }),
    ],
    totalCount: 1,
  };
  const fetchFn = makeFetch([{ status: 200, body: page0 }]);
  const jobs = await ultipro.discover([TARGET], { fetchFn });
  assert.equal(jobs.length, 1);
  assert.ok(jobs[0].locations.includes("Remote"));
  assert.ok(jobs[0].locations.some((l) => /Sacramento/.test(l)));
});

test("ultipro.resolveBase rejects malformed host/boardId/tenant", () => {
  const { resolveBase } = ultipro._internal;
  assert.equal(resolveBase({ slug: TENANT, rawExtra: { boardId: BOARD } }).host, "recruiting");
  assert.equal(resolveBase({ slug: TENANT, rawExtra: { host: "bad.host", boardId: BOARD } }), null);
  assert.equal(
    resolveBase({ slug: "../etc/passwd", rawExtra: { host: HOST, boardId: BOARD } }),
    null
  );
  assert.equal(
    resolveBase({ slug: TENANT, rawExtra: { host: HOST, boardId: "not-a-uuid" } }),
    null
  );
  assert.equal(resolveBase({ slug: TENANT, rawExtra: {} }), null);
});
