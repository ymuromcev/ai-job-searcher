const { test } = require("node:test");
const assert = require("node:assert/strict");

const oracle = require("./oracle_cloud.js");
const { assertJob } = require("./_types.js");

const API_PATH = "/hcmRestApi/resources/latest/recruitingCEJobRequisitions";
const ADVENTIST_SITE = "https://ecvz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/";
const ADVENTIST_API = "https://ecvz.fa.us2.oraclecloud.com" + API_PATH;

function wrap(reqs, total) {
  return {
    items: [
      {
        TotalJobsCount: total == null ? reqs.length : total,
        requisitionList: reqs,
      },
    ],
  };
}

function makeReq(i, overrides = {}) {
  return {
    Id: String(60000 + i),
    Title: `Registered Nurse ${i}`,
    PrimaryLocation: "Roseville, CA, United States",
    PostedDate: "2026-05-10",
    Department: "Nursing",
    JobFamily: "Clinical",
    WorkplaceTypeCode: "ONSITE",
    ...overrides,
  };
}

function makeFetch(responses, recorded = []) {
  return async function (url, opts = {}) {
    recorded.push({ url, method: (opts && opts.method) || "GET" });
    // Strip query for lookup but keep recorded url intact.
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

function parseOffset(url) {
  const m = url.match(/[?&]offset=(\d+)/);
  return m ? Number(m[1]) : 0;
}

function parseLimit(url) {
  const m = url.match(/[?&]limit=(\d+)/);
  return m ? Number(m[1]) : 0;
}

test("oracle_cloud.discover paginates and maps jobs", async () => {
  // Three full pages of 25 (Oracle's hard cap), then a short fourth page
  // of 10 → total 85.
  const page1Reqs = Array.from({ length: 25 }, (_, i) => makeReq(i));
  const page2Reqs = Array.from({ length: 25 }, (_, i) => makeReq(i + 25));
  const page3Reqs = Array.from({ length: 25 }, (_, i) => makeReq(i + 50));
  const page4Reqs = Array.from({ length: 10 }, (_, i) => makeReq(i + 75));
  const recorded = [];
  const fetchFn = makeFetch(
    {
      [ADVENTIST_API]: (url) => {
        const offset = parseOffset(url);
        if (offset === 0) return { status: 200, body: wrap(page1Reqs, 85) };
        if (offset === 25) return { status: 200, body: wrap(page2Reqs, 85) };
        if (offset === 50) return { status: 200, body: wrap(page3Reqs, 85) };
        if (offset === 75) return { status: 200, body: wrap(page4Reqs, 85) };
        throw new Error(`unexpected offset ${offset}`);
      },
    },
    recorded
  );
  const jobs = await oracle.discover(
    [{ name: "Adventist Health", slug: "adventisthealth", siteUrl: ADVENTIST_SITE }],
    { fetchFn }
  );
  assert.equal(jobs.length, 85);
  for (const j of jobs) assertJob(j);
  const [j0] = jobs;
  assert.equal(j0.source, "oracle_cloud");
  assert.equal(j0.companyName, "Adventist Health");
  assert.equal(j0.slug, "adventisthealth");
  assert.equal(j0.jobId, "60000");
  assert.equal(j0.url, `${ADVENTIST_SITE}job/60000`);
  assert.deepEqual(j0.locations, ["Roseville, CA, United States"]);
  assert.equal(j0.postedAt, "2026-05-10");
  assert.equal(j0.team, "Nursing");
  assert.equal(j0.rawExtra.jobFamily, "Clinical");
  assert.equal(j0.rawExtra.workplaceType, "ONSITE");
  assert.equal(recorded.length, 4);
  for (const r of recorded) {
    assert.equal(r.method, "GET");
    assert.ok(r.url.includes("finder=findReqs%3BsiteNumber%3DCX"));
    assert.ok(r.url.includes("expand=requisitionList"));
    assert.ok(r.url.includes("onlyData=true"));
    assert.equal(parseLimit(r.url), 25);
  }
});

test("oracle_cloud.discover stops on a short page (no TotalJobsCount hint needed)", async () => {
  // Short page = fewer rows than PAGE_LIMIT (25). One page of 10 must NOT
  // trigger a second fetch.
  const reqs = Array.from({ length: 10 }, (_, i) => makeReq(i));
  const recorded = [];
  const fetchFn = makeFetch(
    {
      [ADVENTIST_API]: () => ({ status: 200, body: wrap(reqs, 10) }),
    },
    recorded
  );
  const jobs = await oracle.discover(
    [{ name: "Adventist Health", slug: "adventisthealth", siteUrl: ADVENTIST_SITE }],
    { fetchFn }
  );
  assert.equal(jobs.length, 10);
  assert.equal(recorded.length, 1, "should not request page 2 after a short page");
});

test("oracle_cloud.discover honors TotalJobsCount on full last page", async () => {
  // 25 reqs on page 1, TotalJobsCount=25 → should stop without page 2,
  // even though page 1 is full-sized.
  const reqs = Array.from({ length: 25 }, (_, i) => makeReq(i));
  const recorded = [];
  const fetchFn = makeFetch(
    {
      [ADVENTIST_API]: () => ({ status: 200, body: wrap(reqs, 25) }),
    },
    recorded
  );
  const jobs = await oracle.discover(
    [{ name: "Adventist Health", slug: "adventisthealth", siteUrl: ADVENTIST_SITE }],
    { fetchFn }
  );
  assert.equal(jobs.length, 25);
  assert.equal(recorded.length, 1, "should not request page 2 once TotalJobsCount is reached");
});

test("oracle_cloud.discover drops postings outside locationAllow", async () => {
  const reqs = [
    makeReq(0, { PrimaryLocation: "Roseville, CA, United States" }),
    makeReq(1, { PrimaryLocation: "Sacramento, CA, United States" }),
    makeReq(2, { PrimaryLocation: "Tillamook, OR, United States" }),
    makeReq(3, { PrimaryLocation: "Folsom, CA, United States" }),
    makeReq(4, { PrimaryLocation: "Glendale, CA, United States" }),
  ];
  const fetchFn = makeFetch({
    [ADVENTIST_API]: { status: 200, body: wrap(reqs, 5) },
  });
  const logs = [];
  const jobs = await oracle.discover(
    [
      {
        name: "Adventist Health",
        slug: "adventisthealth",
        siteUrl: ADVENTIST_SITE,
        locationAllow: ["Roseville", "Sacramento", "Folsom"],
      },
    ],
    { fetchFn, logger: { warn: (m) => logs.push(m) } }
  );
  assert.equal(jobs.length, 3);
  const cities = jobs.map((j) => j.locations[0]).sort();
  assert.deepEqual(cities, [
    "Folsom, CA, United States",
    "Roseville, CA, United States",
    "Sacramento, CA, United States",
  ]);
  assert.ok(logs.some((m) => m.includes("dropped 2 postings outside locationAllow")));
});

test("oracle_cloud.discover locationAllow is case-insensitive and trims patterns", async () => {
  const reqs = [
    makeReq(0, { PrimaryLocation: "ROSEVILLE, CA, UNITED STATES" }),
    makeReq(1, { PrimaryLocation: "Houston, TX, United States" }),
  ];
  const fetchFn = makeFetch({
    [ADVENTIST_API]: { status: 200, body: wrap(reqs, 2) },
  });
  const jobs = await oracle.discover(
    [
      {
        name: "Adventist Health",
        slug: "adventisthealth",
        siteUrl: ADVENTIST_SITE,
        locationAllow: ["  roseville  ", "", null],
      },
    ],
    { fetchFn }
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobId, "60000");
});

test("oracle_cloud.discover returns [] when target has no siteUrl", async () => {
  const recorded = [];
  const fetchFn = makeFetch({}, recorded);
  const jobs = await oracle.discover(
    [{ name: "Bad", slug: "bad" }], // no siteUrl
    { fetchFn }
  );
  assert.equal(jobs.length, 0);
  assert.equal(recorded.length, 0, "fetchFn must not be called when siteUrl is missing");
});

test("oracle_cloud.discover handles invalid siteUrl gracefully", async () => {
  const recorded = [];
  const fetchFn = makeFetch({}, recorded);
  const logs = [];
  const jobs = await oracle.discover([{ name: "Bad URL", slug: "badurl", siteUrl: "not-a-url" }], {
    fetchFn,
    logger: { warn: (m) => logs.push(m) },
  });
  assert.equal(jobs.length, 0);
  assert.equal(recorded.length, 0);
  assert.ok(logs.some((m) => m.includes("invalid siteUrl")));
});

test("oracle_cloud.discover rejects non-https siteUrl (SSRF guard)", async () => {
  const recorded = [];
  const fetchFn = makeFetch({}, recorded);
  const logs = [];
  const jobs = await oracle.discover(
    [
      {
        name: "Plaintext",
        slug: "plaintext",
        siteUrl: "http://ecvz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/",
      },
    ],
    { fetchFn, logger: { warn: (m) => logs.push(m) } }
  );
  assert.equal(jobs.length, 0);
  assert.equal(recorded.length, 0, "fetchFn must not be called for non-https siteUrl");
  assert.ok(logs.some((m) => m.includes("invalid siteUrl") && m.includes("https")));
});

test("oracle_cloud.discover rejects siteUrl outside oraclecloud.com (SSRF guard)", async () => {
  // Covers AWS metadata, localhost, arbitrary intranet — every host that
  // isn't *.oraclecloud.com must be refused before fetchFn runs.
  const recorded = [];
  const fetchFn = makeFetch({}, recorded);
  const logs = [];
  const cases = [
    "https://169.254.169.254/latest/meta-data/",
    "https://localhost:8080/hcmUI/CandidateExperience/en/sites/CX/",
    "https://attacker.example.com/hcmUI/CandidateExperience/en/sites/CX/",
    // Suffix-only spoofing: "oraclecloud.com.attacker.com" must not match.
    "https://oraclecloud.com.attacker.com/hcmUI/CandidateExperience/en/sites/CX/",
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const jobs = await oracle.discover([{ name: `Bad ${i}`, slug: `bad${i}`, siteUrl: cases[i] }], {
      fetchFn,
      logger: { warn: (m) => logs.push(m) },
    });
    assert.equal(jobs.length, 0, `case ${i}: ${cases[i]} should yield 0 jobs`);
  }
  assert.equal(recorded.length, 0, "no fetch may happen for any disallowed host");
  assert.equal(logs.length, cases.length, "each rejected case must produce one warn line");
  for (const m of logs) {
    assert.ok(m.includes("invalid siteUrl"));
  }
  // Sanity: the spoofing case must explicitly mention the allowlist, not the protocol.
  assert.ok(
    logs.some((m) => m.includes("oraclecloud.com.attacker.com") && m.includes("allowlist"))
  );
});

test("oracle_cloud.discover drops target when mid-pagination page fails", async () => {
  // Page 1 returns 200 with a full batch (25 items, hinting at more).
  // Page 2 returns 500. The whole target must be dropped (no partial pool
  // pollution) and the failure logged via the runTargets per-target catch.
  const page1Reqs = Array.from({ length: 25 }, (_, i) => makeReq(i));
  const recorded = [];
  const fetchFn = makeFetch(
    {
      [ADVENTIST_API]: (url) => {
        const offset = parseOffset(url);
        if (offset === 0) return { status: 200, body: wrap(page1Reqs, 100) };
        if (offset === 25) return { status: 500, body: { error: "boom" } };
        throw new Error(`unexpected offset ${offset}`);
      },
    },
    recorded
  );
  const logs = [];
  const jobs = await oracle.discover(
    [{ name: "Adventist Health", slug: "adventisthealth", siteUrl: ADVENTIST_SITE }],
    { fetchFn, logger: { warn: (m) => logs.push(m) } }
  );
  assert.equal(jobs.length, 0, "partial-page failures must NOT leak page-1 jobs into the pool");
  assert.equal(recorded.length, 2, "page 2 was attempted before failure surfaced");
  assert.ok(
    logs.some((m) => m.includes("adventisthealth") && m.includes("500")),
    `expected per-target warn mentioning HTTP 500, got: ${JSON.stringify(logs)}`
  );
});

test("oracle_cloud.discover tolerates empty requisitionList", async () => {
  const fetchFn = makeFetch({
    [ADVENTIST_API]: { status: 200, body: wrap([], 0) },
  });
  const jobs = await oracle.discover(
    [{ name: "Adventist Health", slug: "adventisthealth", siteUrl: ADVENTIST_SITE }],
    { fetchFn }
  );
  assert.equal(jobs.length, 0);
});

test("oracle_cloud.discover tolerates malformed wrapper (no items)", async () => {
  const fetchFn = makeFetch({
    [ADVENTIST_API]: { status: 200, body: { items: [] } },
  });
  const jobs = await oracle.discover(
    [{ name: "Adventist Health", slug: "adventisthealth", siteUrl: ADVENTIST_SITE }],
    { fetchFn }
  );
  assert.equal(jobs.length, 0);
});

test("oracle_cloud.discover drops requisitions without Id and warns", async () => {
  const reqs = [
    makeReq(0),
    { Title: "No Id", PrimaryLocation: "Roseville, CA, United States" },
    { Id: "", Title: "Empty Id", PrimaryLocation: "Roseville, CA, United States" },
  ];
  const fetchFn = makeFetch({
    [ADVENTIST_API]: { status: 200, body: wrap(reqs, 3) },
  });
  const logs = [];
  const jobs = await oracle.discover(
    [{ name: "Adventist Health", slug: "adventisthealth", siteUrl: ADVENTIST_SITE }],
    { fetchFn, logger: { warn: (m) => logs.push(m) } }
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobId, "60000");
  assert.ok(logs.some((m) => m.includes("dropped 2 postings without Id")));
});

test("oracle_cloud.discover isolates per-tenant failures", async () => {
  const goodReqs = [makeReq(0, { PrimaryLocation: "Roseville, CA, United States" })];
  const OTHER_API = "https://other.fa.us2.oraclecloud.com" + API_PATH;
  const fetchFn = makeFetch({
    [ADVENTIST_API]: { status: 500, body: {} },
    [OTHER_API]: { status: 200, body: wrap(goodReqs, 1) },
  });
  const logs = [];
  const jobs = await oracle.discover(
    [
      { name: "Adventist Health", slug: "adventisthealth", siteUrl: ADVENTIST_SITE },
      {
        name: "Other Tenant",
        slug: "other",
        siteUrl: "https://other.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/",
      },
    ],
    { fetchFn, logger: { warn: (m) => logs.push(m) } }
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].slug, "other");
  assert.ok(logs.some((m) => m.includes("adventisthealth")));
});

test("oracle_cloud.discover uses custom siteNumber when provided", async () => {
  const recorded = [];
  const fetchFn = makeFetch(
    {
      [ADVENTIST_API]: { status: 200, body: wrap([makeReq(0)], 1) },
    },
    recorded
  );
  await oracle.discover(
    [
      {
        name: "Custom Site",
        slug: "custom",
        siteUrl: ADVENTIST_SITE,
        siteNumber: "EX",
      },
    ],
    { fetchFn }
  );
  assert.equal(recorded.length, 1);
  assert.ok(
    recorded[0].url.includes("finder=findReqs%3BsiteNumber%3DEX"),
    `expected finder with siteNumber=EX, got url=${recorded[0].url}`
  );
});

test("oracle_cloud.discover defaults siteNumber to CX when omitted", async () => {
  const recorded = [];
  const fetchFn = makeFetch(
    {
      [ADVENTIST_API]: { status: 200, body: wrap([makeReq(0)], 1) },
    },
    recorded
  );
  await oracle.discover([{ name: "Default Site", slug: "def", siteUrl: ADVENTIST_SITE }], {
    fetchFn,
  });
  assert.equal(recorded.length, 1);
  assert.ok(recorded[0].url.includes("finder=findReqs%3BsiteNumber%3DCX"));
});
