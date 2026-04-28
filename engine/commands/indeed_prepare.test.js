const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  makeIndeedPrepCommand,
  buildUrl,
  buildScanUrls,
  buildInstructions,
  readIndeedConfig,
  EXTRACTION_SNIPPET,
  DEFAULT_CERT_BLOCKERS,
  SEARCH_BASE,
  VIEWJOB_BASE,
} = require("./indeed_prepare.js");

// ---- pure helpers ----

test("buildUrl: literal '+' in keyword is treated as word-boundary (Indeed convention)", () => {
  const url = buildUrl("medical+receptionist", {
    location: "Sacramento, CA",
    radius: 25,
    fromage: 14,
  });
  assert.match(url, /^https:\/\/www\.indeed\.com\/jobs\?/);
  // Plus-as-space convention: pluses stay as +, comma is %2C.
  assert.match(url, /q=medical\+receptionist/);
  assert.ok(!/q=medical%2Breceptionist/.test(url), "plus should not be percent-encoded");
  assert.match(url, /l=Sacramento%2C\+CA/);
  assert.match(url, /radius=25/);
  assert.match(url, /fromage=14/);
});

test("buildUrl: keyword with spaces encodes the same as keyword with '+'", () => {
  const a = buildUrl("medical receptionist", { location: "X", radius: 5, fromage: 7 });
  const b = buildUrl("medical+receptionist", { location: "X", radius: 5, fromage: 7 });
  assert.equal(a, b);
});

test("buildScanUrls preserves keyword order and pairs each with its URL", () => {
  const out = buildScanUrls(["a", "b", "c"], {
    location: "X",
    radius: 5,
    fromage: 7,
  });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((o) => o.keyword), ["a", "b", "c"]);
  for (const o of out) {
    assert.ok(o.url.startsWith(SEARCH_BASE));
    assert.match(o.url, /radius=5/);
    assert.match(o.url, /fromage=7/);
  }
});

test("buildInstructions includes batch hint when provided, omits when 0", () => {
  const withHint = buildInstructions({
    ingestFile: "/x/y.json",
    viewjobBase: VIEWJOB_BASE,
    batchHint: 30,
  });
  assert.ok(withHint.some((s) => /~30 entries/.test(s)));
  const noHint = buildInstructions({
    ingestFile: "/x/y.json",
    viewjobBase: VIEWJOB_BASE,
    batchHint: 0,
  });
  assert.ok(!noHint.some((s) => /entries/.test(s)));
});

test("EXTRACTION_SNIPPET is a self-invoking arrow that returns a string of pipe-rows", () => {
  // We don't execute it here (no DOM), but assert it's a syntactically valid
  // expression that mentions the prototype's selectors so refactors stay
  // intentional.
  assert.match(EXTRACTION_SNIPPET, /document\.querySelectorAll\('a\[data-jk\]'\)/);
  assert.match(EXTRACTION_SNIPPET, /data-testid="company-name"/);
  assert.match(EXTRACTION_SNIPPET, /data-testid="text-location"/);
  // self-invoking IIFE shape
  assert.match(EXTRACTION_SNIPPET, /^\(\(\)\s*=>/);
  assert.match(EXTRACTION_SNIPPET, /\}\)\(\);\s*$/);
});

test("DEFAULT_CERT_BLOCKERS contains the prototype's healthcare cert keywords", () => {
  for (const k of ["CMA", "COA", "COT", "RN", "LVN", "CPC"]) {
    assert.ok(DEFAULT_CERT_BLOCKERS.includes(k), `missing ${k}`);
  }
});

// ---- readIndeedConfig ----

test("readIndeedConfig: throws when discovery.indeed missing", () => {
  assert.throws(
    () => readIndeedConfig({ id: "p", discovery: {} }),
    /no discovery\.indeed config/
  );
});

test("readIndeedConfig: throws when keywords empty / missing", () => {
  assert.throws(
    () => readIndeedConfig({ id: "p", discovery: { indeed: {} } }),
    /keywords must be a non-empty array/
  );
  assert.throws(
    () => readIndeedConfig({ id: "p", discovery: { indeed: { keywords: [] } } }),
    /keywords must be a non-empty array/
  );
});

test("readIndeedConfig: defaults applied when fields omitted", () => {
  const cfg = readIndeedConfig({
    id: "p",
    discovery: { indeed: { keywords: ["a"] } },
  });
  assert.equal(cfg.location, "Sacramento, CA");
  assert.equal(cfg.radius, 25);
  assert.equal(cfg.fromage, 14);
  assert.equal(cfg.ingestFile, ".indeed-state/raw_indeed.json");
  assert.equal(cfg.batchHint, 30);
  assert.deepEqual(cfg.filters.cert_blockers, DEFAULT_CERT_BLOCKERS);
  assert.deepEqual(cfg.filters.location_whitelist, []);
  assert.deepEqual(cfg.filters.location_blocklist, []);
});

test("readIndeedConfig: explicit values override defaults", () => {
  const cfg = readIndeedConfig({
    id: "p",
    discovery: {
      indeed: {
        keywords: ["x"],
        location: "Other, CA",
        radius: 50,
        fromage: 7,
        ingest_file: "/abs/path.json",
        batch_hint: 10,
        filters: {
          cert_blockers: ["XYZ"],
          location_whitelist: ["W"],
          location_blocklist: ["B"],
        },
      },
    },
  });
  assert.equal(cfg.location, "Other, CA");
  assert.equal(cfg.radius, 50);
  assert.equal(cfg.fromage, 7);
  assert.equal(cfg.ingestFile, "/abs/path.json");
  assert.equal(cfg.batchHint, 10);
  assert.deepEqual(cfg.filters.cert_blockers, ["XYZ"]);
  assert.deepEqual(cfg.filters.location_whitelist, ["W"]);
  assert.deepEqual(cfg.filters.location_blocklist, ["B"]);
});

// ---- command end-to-end (with fakes) ----

function makeFakeProfile(overrides = {}) {
  return {
    id: "test_profile",
    paths: { root: "/tmp/test_profile" },
    discovery: {
      indeed: {
        keywords: ["medical+receptionist", "patient+access+representative"],
        location: "Sacramento, CA",
        radius: 25,
        fromage: 14,
        ingest_file: ".indeed-state/raw_indeed.json",
      },
    },
    ...overrides,
  };
}

function makeCtx(extras = {}) {
  const out = [];
  const err = [];
  return {
    ctx: {
      profileId: "test_profile",
      flags: { dryRun: false, apply: false, verbose: false },
      env: {},
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      ...extras,
    },
    out,
    err,
  };
}

test("indeed-prep: writes scaffold ingest file when missing, prints JSON payload", async () => {
  const writes = [];
  const dirs = [];
  const cmd = makeIndeedPrepCommand({
    loadProfile: () => makeFakeProfile(),
    ensureDir: (d) => dirs.push(d),
    writeFile: (p, c) => writes.push({ p, c }),
    fileExists: () => false,
    now: () => "2026-04-27T00:00:00.000Z",
  });
  const { ctx, out, err } = makeCtx();
  const code = await cmd(ctx);
  assert.equal(code, 0);
  assert.equal(err.length, 0);
  assert.equal(dirs.length, 1);
  assert.equal(dirs[0], "/tmp/test_profile/.indeed-state");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].p, "/tmp/test_profile/.indeed-state/raw_indeed.json");
  assert.equal(writes[0].c, "[]\n");

  assert.equal(out.length, 1);
  const payload = JSON.parse(out[0]);
  assert.equal(payload.profile_id, "test_profile");
  assert.equal(payload.ingest_file, "/tmp/test_profile/.indeed-state/raw_indeed.json");
  assert.equal(payload.scan_urls.length, 2);
  assert.equal(payload.scan_urls[0].keyword, "medical+receptionist");
  assert.match(payload.scan_urls[0].url, /q=medical\+receptionist/);
  assert.equal(payload.viewjob_template, `${VIEWJOB_BASE}?jk={jk}`);
  assert.deepEqual(payload.filters.cert_blockers, DEFAULT_CERT_BLOCKERS);
  assert.ok(Array.isArray(payload.instructions));
  assert.ok(payload.instructions.length >= 5);
});

test("indeed-prep: does NOT overwrite existing ingest file (preserves Claude's pending work)", async () => {
  const writes = [];
  const cmd = makeIndeedPrepCommand({
    loadProfile: () => makeFakeProfile(),
    ensureDir: () => {},
    writeFile: (p, c) => writes.push({ p, c }),
    fileExists: () => true, // file already exists
    now: () => "2026-04-27T00:00:00.000Z",
  });
  const { ctx, err } = makeCtx();
  const code = await cmd(ctx);
  assert.equal(code, 0);
  assert.equal(err.length, 0);
  assert.equal(writes.length, 0, "should not overwrite an existing ingest file");
});

test("indeed-prep: --dry-run prints summary, no side effects", async () => {
  const writes = [];
  const dirs = [];
  const cmd = makeIndeedPrepCommand({
    loadProfile: () => makeFakeProfile(),
    ensureDir: (d) => dirs.push(d),
    writeFile: (p, c) => writes.push({ p, c }),
    fileExists: () => false,
  });
  const { ctx, out, err } = makeCtx({
    flags: { dryRun: true, apply: false, verbose: false },
  });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  assert.equal(err.length, 0);
  assert.equal(dirs.length, 0);
  assert.equal(writes.length, 0);
  assert.ok(out.some((line) => /\(dry-run\)/.test(line)));
});

test("indeed-prep: errors when profile lacks discovery.indeed config", async () => {
  const cmd = makeIndeedPrepCommand({
    loadProfile: () => ({ id: "x", paths: { root: "/tmp/x" }, discovery: {} }),
  });
  const { ctx, err } = makeCtx();
  const code = await cmd(ctx);
  assert.equal(code, 1);
  assert.ok(err.some((line) => /no discovery\.indeed config/.test(line)));
});

test("indeed-prep: absolute ingest_file path is honored as-is", async () => {
  const writes = [];
  const cmd = makeIndeedPrepCommand({
    loadProfile: () => makeFakeProfile({
      discovery: {
        indeed: {
          keywords: ["a"],
          ingest_file: "/abs/elsewhere/raw.json",
        },
      },
    }),
    ensureDir: () => {},
    writeFile: (p, c) => writes.push({ p, c }),
    fileExists: () => false,
    now: () => "2026-04-27T00:00:00.000Z",
  });
  const { ctx, out } = makeCtx();
  const code = await cmd(ctx);
  assert.equal(code, 0);
  const payload = JSON.parse(out[0]);
  assert.equal(payload.ingest_file, "/abs/elsewhere/raw.json");
  assert.equal(writes[0].p, "/abs/elsewhere/raw.json");
});
