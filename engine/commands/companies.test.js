const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const companiesTsv = require("../core/companies.js");
const { makeCompaniesCommand, nameFromSlug, withFileLock } = require("./companies.js");

// Board API fake: url → JSON body (200) or a number (that HTTP status).
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : 404;
    if (typeof r === "number") return { ok: false, status: r, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
  fn.calls = calls;
  return fn;
}

const GH = (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
const LEVER = (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`;
const ASHBY = (slug) =>
  `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;

function setup(rows = []) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "companies-cmd-"));
  const file = path.join(dataDir, "companies.tsv");
  if (rows.length) companiesTsv.save(file, rows);
  return { dataDir, file };
}

function run(cmdOverrides, { dataDir, flags, subcommand = "add", profileId = "jared" }) {
  const out = [];
  const err = [];
  const cmd = makeCompaniesCommand({ loadProfile: () => ({ id: profileId }), ...cmdOverrides });
  return cmd({
    profileId,
    subcommand,
    flags,
    dataDir,
    env: {},
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  }).then((code) => ({
    code,
    out,
    err,
    json: out.length ? JSON.parse(out[out.length - 1]) : null,
  }));
}

test("nameFromSlug", () => {
  assert.equal(nameFromSlug("acme-synthetic"), "Acme Synthetic");
  assert.equal(nameFromSlug("globex"), "Globex");
});

test("companies add: valid Greenhouse board is appended for this profile", async () => {
  const env = setup([
    { name: "Initech", source: "lever", slug: "initech", extra: null, profile: "" },
  ]);
  const fetchFn = fakeFetch({
    [GH("acmesynthetic")]: {
      jobs: [
        { id: 1, title: "Product Manager", absolute_url: "https://x.example/1" },
        { id: 2, title: "Data Analyst", absolute_url: "https://x.example/2" },
      ],
    },
  });
  const r = await run(
    { fetchFn },
    {
      dataDir: env.dataDir,
      flags: { ats: "greenhouse", slug: "acmesynthetic", name: "Acme Synthetic" },
    }
  );
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, {
    result: "added",
    ats: "greenhouse",
    slug: "acmesynthetic",
    name: "Acme Synthetic",
    jobs: 2,
  });
  assert.equal(r.out.length, 1, "exactly one JSON line on stdout");
  assert.deepEqual(fetchFn.calls, [GH("acmesynthetic")]);
  const { rows } = companiesTsv.load(env.file);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], {
    name: "Acme Synthetic",
    source: "greenhouse",
    slug: "acmesynthetic",
    extra: null,
    profile: "jared",
  });
  assert.ok(!fs.existsSync(`${env.file}.lock`), "lock released");
});

test("companies add: a valid empty board is still added (jobs: 0)", async () => {
  const env = setup();
  const r = await run(
    { fetchFn: fakeFetch({ [LEVER("quiet")]: [] }) },
    { dataDir: env.dataDir, flags: { ats: "lever", slug: "quiet" } }
  );
  assert.equal(r.code, 0);
  assert.equal(r.json.result, "added");
  assert.equal(r.json.jobs, 0);
  assert.equal(r.json.name, "Quiet");
  assert.equal(companiesTsv.load(env.file).rows.length, 1);
});

test("companies add: 404 board is invalid, nothing written", async () => {
  const env = setup();
  const r = await run(
    { fetchFn: fakeFetch({}) },
    { dataDir: env.dataDir, flags: { ats: "ashby", slug: "nope" } }
  );
  assert.equal(r.code, 1);
  assert.equal(r.json.result, "invalid");
  assert.match(r.json.error, /HTTP 404/);
  assert.equal(fs.existsSync(env.file), false);
});

test("companies add: 200 with an unexpected body is invalid", async () => {
  const env = setup();
  const r = await run(
    { fetchFn: fakeFetch({ [LEVER("weird")]: { ok: false, error: "Document not found" } }) },
    { dataDir: env.dataDir, flags: { ats: "lever", slug: "weird" } }
  );
  assert.equal(r.json.result, "invalid");
  assert.equal(r.json.error, "unexpected board response");
});

test("companies add: same (ats, slug) already listed → exists, no fetch", async () => {
  const env = setup([
    { name: "Globex", source: "ashby", slug: "Globex", extra: null, profile: "" },
  ]);
  const fetchFn = fakeFetch({});
  const r = await run(
    { fetchFn },
    { dataDir: env.dataDir, flags: { ats: "ashby", slug: "globex" } }
  );
  assert.equal(r.code, 0);
  assert.equal(r.json.result, "exists");
  assert.equal(r.json.name, "Globex");
  assert.equal(fetchFn.calls.length, 0);
  assert.equal(companiesTsv.load(env.file).rows.length, 1);
});

test("companies add: same slug on another ATS is a different board", async () => {
  const env = setup([
    { name: "Globex", source: "lever", slug: "globex", extra: null, profile: "" },
  ]);
  const r = await run(
    { fetchFn: fakeFetch({ [ASHBY("globex")]: { jobs: [] } }) },
    { dataDir: env.dataDir, flags: { ats: "ashby", slug: "globex", name: "Globex" } }
  );
  assert.equal(r.json.result, "added");
  assert.equal(companiesTsv.load(env.file).rows.length, 2);
});

test("companies add: row owned by another profile is shared with this one", async () => {
  const env = setup([
    { name: "Globex", source: "lever", slug: "globex", extra: null, profile: "lilia" },
  ]);
  const r = await run(
    { fetchFn: fakeFetch({ [LEVER("globex")]: [] }) },
    { dataDir: env.dataDir, flags: { ats: "lever", slug: "globex" } }
  );
  assert.equal(r.code, 0);
  assert.equal(r.json.result, "exists");
  assert.equal(r.json.shared_with_profile, true);
  const { rows } = companiesTsv.load(env.file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].profile, "lilia,jared");
});

test("companies add: argument errors", async () => {
  const env = setup();
  const bad = [
    { ats: "workday", slug: "x" },
    { ats: "lever", slug: "" },
    { ats: "lever", slug: "../etc" },
  ];
  for (const flags of bad) {
    const r = await run({ fetchFn: fakeFetch({}) }, { dataDir: env.dataDir, flags });
    assert.equal(r.code, 1);
    assert.equal(r.out.length, 0);
  }
  const r = await run(
    { fetchFn: fakeFetch({}) },
    { dataDir: env.dataDir, flags: {}, subcommand: "" }
  );
  assert.equal(r.code, 1);
});

test("withFileLock: serializes writers and breaks a stale lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "companies-lock-"));
  const lock = path.join(dir, "companies.tsv.lock");
  const order = [];
  await Promise.all([
    withFileLock(lock, async () => {
      order.push("a-in");
      await new Promise((r) => setTimeout(r, 50));
      order.push("a-out");
    }),
    withFileLock(lock, async () => {
      order.push("b-in");
      order.push("b-out");
    }),
  ]);
  assert.deepEqual(order.slice(0, 2), ["a-in", "a-out"]);
  fs.writeFileSync(lock, "99999");
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lock, old, old);
  assert.equal(await withFileLock(lock, async () => "ran"), "ran");
  assert.ok(!fs.existsSync(lock));
});
