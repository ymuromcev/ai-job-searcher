const { test } = require("node:test");
const assert = require("node:assert/strict");

const { scan } = require("./scan.js");

function stubAdapter(source, handler) {
  return { source, discover: handler };
}

function job(source, jobId, overrides = {}) {
  return {
    source,
    slug: "acme",
    companyName: "Acme",
    jobId: String(jobId),
    title: `Role ${jobId}`,
    url: `https://x/${source}/${jobId}`,
    locations: ["SF"],
    team: null,
    postedAt: "2026-04-15",
    rawExtra: {},
    ...overrides,
  };
}

test("scan invokes correct adapter per source and dedupes within batch", async () => {
  const calls = { gh: 0, lever: 0 };
  const adapters = [
    stubAdapter("greenhouse", async (targets) => {
      calls.gh += targets.length;
      return [job("greenhouse", 1), job("greenhouse", 2), job("greenhouse", 1)];
    }),
    stubAdapter("lever", async (targets) => {
      calls.lever += targets.length;
      return [job("lever", "a1")];
    }),
  ];
  const result = await scan({
    targetsBySource: {
      greenhouse: [{ name: "Acme", slug: "acme" }],
      lever: [{ name: "Acme", slug: "acme" }],
    },
    adapters,
  });
  assert.equal(calls.gh, 1);
  assert.equal(calls.lever, 1);
  assert.equal(result.fresh.length, 3);
  assert.equal(result.pool.length, 3);
  assert.equal(result.summary.greenhouse.total, 3);
  assert.equal(result.summary.lever.total, 1);
  assert.deepEqual(result.errors, []);
});

test("scan excludes jobs already in existing pool", async () => {
  const existing = [job("greenhouse", 1), job("greenhouse", 2)];
  const adapters = [
    stubAdapter("greenhouse", async () => [job("greenhouse", 2), job("greenhouse", 3)]),
  ];
  const result = await scan({
    targetsBySource: { greenhouse: [{ slug: "acme" }] },
    adapters,
    existing,
  });
  assert.equal(result.fresh.length, 1);
  assert.equal(result.fresh[0].jobId, "3");
  assert.equal(result.pool.length, 3);
});

test("scan isolates adapter failures (one failing does not stop others)", async () => {
  const adapters = [
    stubAdapter("greenhouse", async () => {
      throw new Error("boom");
    }),
    stubAdapter("lever", async () => [job("lever", "a")]),
  ];
  const result = await scan({
    targetsBySource: {
      greenhouse: [{ slug: "acme" }],
      lever: [{ slug: "acme" }],
    },
    adapters,
  });
  assert.equal(result.fresh.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].source, "greenhouse");
  assert.match(result.errors[0].message, /boom/);
  assert.equal(result.summary.lever.total, 1);
});

test("scan records error when adapter for source is missing", async () => {
  const result = await scan({
    targetsBySource: { ashby: [{ slug: "ramp" }] },
    adapters: [],
  });
  assert.equal(result.fresh.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /no adapter registered/);
});

test("scan is idempotent on repeated calls against same pool", async () => {
  const adapter = stubAdapter("greenhouse", async () => [job("greenhouse", 1), job("greenhouse", 2)]);
  const first = await scan({
    targetsBySource: { greenhouse: [{ slug: "acme" }] },
    adapters: [adapter],
    existing: [],
  });
  assert.equal(first.fresh.length, 2);
  const second = await scan({
    targetsBySource: { greenhouse: [{ slug: "acme" }] },
    adapters: [adapter],
    existing: first.pool,
  });
  assert.equal(second.fresh.length, 0);
  assert.equal(second.pool.length, 2);
});

test("scan accepts adapters passed as { source: adapter } map", async () => {
  const adapters = {
    greenhouse: stubAdapter("greenhouse", async () => [job("greenhouse", 10)]),
  };
  const result = await scan({
    targetsBySource: { greenhouse: [{ slug: "acme" }] },
    adapters,
  });
  assert.equal(result.fresh.length, 1);
});
