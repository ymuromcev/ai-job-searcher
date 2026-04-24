const { test } = require("node:test");
const assert = require("node:assert/strict");

const { assertJob } = require("./_types.js");
const adapter = require("./remoteok.js");

function makeFetch(body, status = 200) {
  return async () => ({
    ok: status < 400,
    status,
    async json() { return body; },
  });
}

const FIXTURE = [
  // First element is the legal/meta block (no id).
  { legal: "true", api: "https://remoteok.com/api", disclaimer: "..." },
  // PM, US-compatible → should be included.
  {
    id: 111111,
    company: "Stripe",
    position: "Senior Product Manager",
    location: "Remote - USA",
    url: "https://remoteok.com/jobs/111111",
    slug: "stripe-senior-pm",
    date: "2026-04-15T10:00:00Z",
    tags: ["fintech", "payments"],
  },
  // PM, Worldwide → include.
  {
    id: 222222,
    company: "Acme",
    position: "Product Manager",
    location: "Worldwide",
    url: "https://remoteok.com/jobs/222222",
    slug: "acme-pm",
    date: "2026-04-14T09:00:00Z",
    tags: [],
  },
  // PM but Europe-only → exclude.
  {
    id: 333333,
    company: "EUCo",
    position: "Product Manager",
    location: "Europe Only",
    url: "https://remoteok.com/jobs/333333",
    slug: "euco-pm",
    date: "2026-04-13T08:00:00Z",
    tags: [],
  },
  // Non-PM title → exclude.
  {
    id: 444444,
    company: "InfraCo",
    position: "Software Engineer",
    location: "Remote",
    url: "https://remoteok.com/jobs/444444",
    slug: "infraco-se",
    date: null,
    tags: [],
  },
];

// --- Module shape ------------------------------------------------------------

test("remoteok exports correct source and feedMode", () => {
  assert.equal(adapter.source, "remoteok");
  assert.equal(typeof adapter.discover, "function");
  assert.equal(adapter.feedMode, true);
});

// --- discover: filtering -----------------------------------------------------

test("discover keeps PM + US-compatible, drops non-PM and non-US", async () => {
  const fetchFn = makeFetch(FIXTURE);
  const jobs = await adapter.discover([], { fetchFn });
  assert.equal(jobs.length, 2);
  const ids = jobs.map((j) => j.jobId);
  assert.ok(ids.includes("111111"), "Stripe PM should be included");
  assert.ok(ids.includes("222222"), "Worldwide PM should be included");
  assert.ok(!ids.includes("333333"), "Europe-only PM should be excluded");
  assert.ok(!ids.includes("444444"), "Non-PM should be excluded");
});

test("discover produces valid NormalizedJob records", async () => {
  const jobs = await adapter.discover([], { fetchFn: makeFetch(FIXTURE) });
  for (const j of jobs) {
    assertJob(j);
    assert.equal(j.source, "remoteok");
  }
});

test("discover maps fields correctly for Stripe job", async () => {
  const [j] = await adapter.discover([], { fetchFn: makeFetch(FIXTURE) });
  assert.equal(j.jobId, "111111");
  assert.equal(j.companyName, "Stripe");
  assert.equal(j.title, "Senior Product Manager");
  assert.equal(j.url, "https://remoteok.com/jobs/111111");
  assert.deepEqual(j.locations, ["Remote"]);
  assert.equal(j.postedAt, "2026-04-15");
  assert.deepEqual(j.rawExtra.tags, ["fintech", "payments"]);
});

// --- discover: feed-based (targets ignored) ----------------------------------

test("discover returns same results regardless of targets", async () => {
  const fetchFn = makeFetch(FIXTURE);
  const withoutTargets = await adapter.discover([], { fetchFn });
  const withTargets = await adapter.discover(
    [{ name: "Stripe", slug: "stripe" }, { name: "Acme", slug: "acme" }],
    { fetchFn }
  );
  assert.equal(withoutTargets.length, withTargets.length);
});

// --- discover: error handling ------------------------------------------------

test("discover handles network error gracefully", async () => {
  const logs = [];
  const fetchFn = async () => { throw new Error("ECONNRESET"); };
  const jobs = await adapter.discover([], { fetchFn, logger: { warn: (m) => logs.push(m) } });
  assert.deepEqual(jobs, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /ECONNRESET/);
});

test("discover handles non-200 HTTP status", async () => {
  const logs = [];
  const jobs = await adapter.discover([], {
    fetchFn: makeFetch({}, 503),
    logger: { warn: (m) => logs.push(m) },
  });
  assert.deepEqual(jobs, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /503/);
});

test("discover handles unexpected (non-array) response shape", async () => {
  const logs = [];
  const jobs = await adapter.discover([], {
    fetchFn: makeFetch({ error: "rate limited" }),
    logger: { warn: (m) => logs.push(m) },
  });
  assert.deepEqual(jobs, []);
  assert.match(logs[0], /unexpected/i);
});

test("discover handles empty feed array", async () => {
  const jobs = await adapter.discover([], { fetchFn: makeFetch([]) });
  assert.deepEqual(jobs, []);
});

test("discover skips meta block (no id)", async () => {
  const feed = [
    { legal: "true" }, // meta block — no id
    { id: 1, company: "X", position: "Product Manager", location: "Remote", url: "https://remoteok.com/jobs/1", slug: "x-pm", date: null, tags: [] },
  ];
  const jobs = await adapter.discover([], { fetchFn: makeFetch(feed) });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobId, "1");
});
