const { test } = require("node:test");
const assert = require("node:assert/strict");

const { checkOne, checkAll, isSafeLivenessUrl, SKIP_URL_CHECK_SOURCES } = require("./url_check.js");

// Builds a stub fetchFn keyed by "${METHOD}:${url}" or plain url.
function makeFetch(map) {
  return async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    const key = `${method}:${url}`;
    const entry = map[key] || map[url];
    if (!entry) throw new Error(`unmocked: ${method} ${url}`);
    if (entry.throws) throw entry.throws;
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      url: entry.finalUrl || url,
    };
  };
}

const JOB_URL = "https://boards.greenhouse.io/affirm/jobs/12345";

// --- isSafeLivenessUrl -------------------------------------------------------

test("isSafeLivenessUrl blocks private IPv4 ranges", () => {
  assert.deepEqual(isSafeLivenessUrl("http://10.0.0.1/"), {
    ok: false, reason: "blocked private/loopback host 10.0.0.1",
  });
  assert.deepEqual(isSafeLivenessUrl("http://192.168.1.100/"), {
    ok: false, reason: "blocked private/loopback host 192.168.1.100",
  });
  assert.deepEqual(isSafeLivenessUrl("http://172.16.5.1/"), {
    ok: false, reason: "blocked private/loopback host 172.16.5.1",
  });
  assert.deepEqual(isSafeLivenessUrl("http://127.0.0.1/"), {
    ok: false, reason: "blocked private/loopback host 127.0.0.1",
  });
});

test("isSafeLivenessUrl blocks loopback hostname", () => {
  assert.deepEqual(isSafeLivenessUrl("http://localhost/path"), {
    ok: false, reason: "blocked loopback host localhost",
  });
});

test("isSafeLivenessUrl blocks non-http schemes", () => {
  const r = isSafeLivenessUrl("ftp://example.com/");
  assert.equal(r.ok, false);
  assert.match(r.reason, /blocked scheme/);
});

test("isSafeLivenessUrl rejects invalid URLs", () => {
  assert.equal(isSafeLivenessUrl("not-a-url").ok, false);
});

test("isSafeLivenessUrl allows public https URL", () => {
  assert.deepEqual(isSafeLivenessUrl("https://boards.greenhouse.io/affirm/jobs/1"), { ok: true });
});

// --- checkOne: basic alive/dead ----------------------------------------------

test("checkOne returns alive=true on HEAD 200", async () => {
  const fetchFn = makeFetch({ [`HEAD:${JOB_URL}`]: { status: 200 } });
  const result = await checkOne({ url: JOB_URL }, fetchFn);
  assert.equal(result.alive, true);
  assert.equal(result.status, 200);
  assert.equal(result.finalUrl, JOB_URL);
});

test("checkOne returns alive=true on HEAD 403 (bot-block)", async () => {
  const fetchFn = makeFetch({ [`HEAD:${JOB_URL}`]: { status: 403 } });
  const result = await checkOne({ url: JOB_URL }, fetchFn);
  assert.equal(result.alive, true);
  assert.equal(result.status, 403);
});

test("checkOne returns alive=false on HEAD 404 and GET 404", async () => {
  const fetchFn = makeFetch({
    [`HEAD:${JOB_URL}`]: { status: 404 },
    [`GET:${JOB_URL}`]: { status: 404 },
  });
  const result = await checkOne({ url: JOB_URL }, fetchFn);
  assert.equal(result.alive, false);
  assert.equal(result.status, 404);
});

// --- checkOne: GET fallback --------------------------------------------------

test("checkOne falls back to GET when HEAD returns 405", async () => {
  const fetchFn = makeFetch({
    [`HEAD:${JOB_URL}`]: { status: 405 },
    [`GET:${JOB_URL}`]: { status: 200 },
  });
  const result = await checkOne({ url: JOB_URL }, fetchFn);
  assert.equal(result.alive, true);
  assert.equal(result.status, 200);
});

test("checkOne falls back to GET when HEAD errors", async () => {
  const fetchFn = makeFetch({
    [`HEAD:${JOB_URL}`]: { throws: new Error("ECONNRESET") },
    [`GET:${JOB_URL}`]: { status: 200 },
  });
  const result = await checkOne({ url: JOB_URL }, fetchFn);
  assert.equal(result.alive, true);
  assert.equal(result.status, 200);
  assert.equal(result.error, undefined);
});

test("checkOne reports error when both HEAD and GET fail", async () => {
  const fetchFn = makeFetch({
    [`HEAD:${JOB_URL}`]: { throws: new Error("timeout") },
    [`GET:${JOB_URL}`]: { throws: new Error("timeout") },
  });
  const result = await checkOne({ url: JOB_URL }, fetchFn);
  assert.equal(result.alive, false);
  assert.equal(result.status, 0);
  assert.equal(result.error, "timeout");
});

// --- checkOne: SSRF guard ----------------------------------------------------

test("checkOne blocks private IP and marks blocked=true", async () => {
  const fetchFn = makeFetch({});
  const result = await checkOne({ url: "http://192.168.1.1/jobs/1" }, fetchFn);
  assert.equal(result.alive, false);
  assert.equal(result.blocked, true);
  assert.match(result.error, /blocked/);
});

// --- checkOne: board-root detection ------------------------------------------

test("checkOne marks alive=false when GET redirects to board root", async () => {
  const boardRootUrl = "https://greenhouse.io/acme/";
  const fetchFn = makeFetch({
    [`HEAD:${JOB_URL}`]: { status: 404 },
    [`GET:${JOB_URL}`]: { status: 200, finalUrl: boardRootUrl },
  });
  const result = await checkOne({ url: JOB_URL }, fetchFn);
  assert.equal(result.alive, false);
  assert.equal(result.boardRoot, true);
  assert.equal(result.finalUrl, boardRootUrl);
});

test("checkOne does NOT flag as board-root when job id appears in final URL", async () => {
  // finalUrl contains the original job id (12345) → redirect is fine
  const finalUrl = "https://boards.greenhouse.io/affirm/jobs/12345/apply";
  const fetchFn = makeFetch({
    [`HEAD:${JOB_URL}`]: { status: 404 },
    [`GET:${JOB_URL}`]: { status: 200, finalUrl },
  });
  const result = await checkOne({ url: JOB_URL }, fetchFn);
  assert.equal(result.alive, true);
  assert.equal(result.boardRoot, undefined);
});

// --- checkOne: passthrough of extra fields -----------------------------------

test("checkOne passes through extra row fields", async () => {
  const fetchFn = makeFetch({ [`HEAD:${JOB_URL}`]: { status: 200 } });
  const result = await checkOne(
    { url: JOB_URL, key: "greenhouse:12345", company: "Affirm" },
    fetchFn
  );
  assert.equal(result.key, "greenhouse:12345");
  assert.equal(result.company, "Affirm");
});

// --- checkAll ----------------------------------------------------------------

test("checkAll returns empty array for empty input", async () => {
  const results = await checkAll([], makeFetch({}));
  assert.deepEqual(results, []);
});

test("checkAll processes all rows and returns same count", async () => {
  const urls = [
    "https://boards.greenhouse.io/stripe/jobs/1",
    "https://boards.greenhouse.io/brex/jobs/2",
    "https://boards.greenhouse.io/ramp/jobs/3",
  ];
  const fetchMap = {};
  for (const u of urls) fetchMap[`HEAD:${u}`] = { status: 200 };
  const results = await checkAll(urls.map((u) => ({ url: u })), makeFetch(fetchMap), { concurrency: 2 });
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.alive === true));
});

test("checkAll respects concurrency — one failure does not block others", async () => {
  const good = "https://boards.greenhouse.io/good/jobs/1";
  const bad = "https://boards.greenhouse.io/bad/jobs/2";
  const fetchFn = makeFetch({
    [`HEAD:${good}`]: { status: 200 },
    [`HEAD:${bad}`]: { throws: new Error("timeout") },
    [`GET:${bad}`]: { throws: new Error("timeout") },
  });
  const results = await checkAll(
    [{ url: good }, { url: bad }],
    fetchFn,
    { concurrency: 1 }
  );
  assert.equal(results.length, 2);
  assert.equal(results[0].alive, true);
  assert.equal(results[1].alive, false);
});

// --- checkOne: early-skip for LinkedIn / Indeed / custom ---------------------

test("SKIP_URL_CHECK_SOURCES contains linkedin, indeed, custom", () => {
  assert.ok(SKIP_URL_CHECK_SOURCES.has("linkedin"));
  assert.ok(SKIP_URL_CHECK_SOURCES.has("indeed"));
  assert.ok(SKIP_URL_CHECK_SOURCES.has("custom"));
});

test("checkOne skips HEAD/GET for linkedin source and marks alive", async () => {
  const fetchFn = async () => {
    throw new Error("fetchFn must not be called for skipped sources");
  };
  const result = await checkOne(
    { url: "https://linkedin.com/jobs/view/123", source: "linkedin" },
    fetchFn,
  );
  assert.equal(result.alive, true);
  assert.equal(result.skipped, true);
  assert.equal(result.status, 0);
});

test("checkOne early-skip is case-insensitive on source", async () => {
  const fetchFn = async () => {
    throw new Error("fetchFn must not be called");
  };
  const result = await checkOne(
    { url: "https://indeed.com/job/abc", source: "Indeed" },
    fetchFn,
  );
  assert.equal(result.alive, true);
  assert.equal(result.skipped, true);
});

test("checkOne early-skip for custom source", async () => {
  const fetchFn = async () => {
    throw new Error("fetchFn must not be called");
  };
  const result = await checkOne(
    { url: "https://example.com/careers/role-42", source: "custom" },
    fetchFn,
  );
  assert.equal(result.alive, true);
  assert.equal(result.skipped, true);
});

test("checkOne does not skip for greenhouse/lever/ashby", async () => {
  const fetchFn = makeFetch({
    "HEAD:https://boards.greenhouse.io/x/jobs/1": { status: 200 },
  });
  const result = await checkOne(
    { url: "https://boards.greenhouse.io/x/jobs/1", source: "greenhouse" },
    fetchFn,
  );
  assert.equal(result.alive, true);
  assert.equal(result.skipped, undefined);
});
