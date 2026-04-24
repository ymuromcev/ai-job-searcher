const { test } = require("node:test");
const assert = require("node:assert/strict");

const { cacheKey, fetchJd, fetchAll, stripHtml } = require("./jd_cache.js");

// Build minimal I/O deps with controllable state.
function makeDeps(overrides = {}) {
  const written = {};
  const existing = overrides.existing || {};
  return {
    written,
    deps: {
      exists: async (p) => Object.prototype.hasOwnProperty.call(existing, p),
      readFile: async (p) => {
        if (existing[p] === undefined) throw new Error(`no file: ${p}`);
        return existing[p];
      },
      writeFile: async (p, data) => { written[p] = data; },
      mkdirp: async () => {},
      fetchFn: overrides.fetchFn || (async () => { throw new Error("network disabled"); }),
    },
  };
}

function makeFetchFn(responses) {
  return async (url) => {
    const entry = responses[url];
    if (!entry) throw new Error(`unmocked: ${url}`);
    if (entry.throws) throw entry.throws;
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      async json() { return entry.body; },
    };
  };
}

const GH_JOB = { source: "greenhouse", slug: "affirm", jobId: "12345", title: "Senior PM", companyName: "Affirm" };
const LEVER_JOB = { source: "lever", slug: "stripe", jobId: "abc-123", title: "Lead PM", companyName: "Stripe" };
const CACHE_DIR = "/fake/cache";

// --- cacheKey ----------------------------------------------------------------

test("cacheKey is deterministic and filesystem-safe", () => {
  const key = cacheKey(GH_JOB);
  assert.ok(/^[a-zA-Z0-9._-]+\.txt$/.test(key), `key "${key}" not filesystem-safe`);
  assert.equal(key, cacheKey(GH_JOB)); // deterministic
});

test("cacheKey normalises special chars in slug and jobId", () => {
  const job = { source: "greenhouse", slug: "my-co/v2", jobId: "99 888" };
  const key = cacheKey(job);
  assert.ok(!/[/ ]/.test(key));
  assert.ok(key.endsWith(".txt"));
});

// --- fetchJd: cache hit ------------------------------------------------------

test("cache hit returns status=cached without calling fetchFn", async () => {
  const cachedText = "TITLE: Senior PM\n\nFull description here.";
  const cachePath = `${CACHE_DIR}/${cacheKey(GH_JOB)}`;
  const { deps } = makeDeps({ existing: { [cachePath]: cachedText } });
  const result = await fetchJd(GH_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "cached");
  assert.equal(result.text, cachedText);
  assert.equal(result.key, cacheKey(GH_JOB));
});

// --- fetchJd: Greenhouse fetch -----------------------------------------------

test("Greenhouse: cache miss fetches and writes text", async () => {
  const ghData = {
    title: "Senior PM",
    location: { name: "San Francisco, CA" },
    departments: [{ name: "Product" }],
    content: "<p>We are looking for a <strong>Senior PM</strong>.</p>",
  };
  const url = `https://boards-api.greenhouse.io/v1/boards/affirm/jobs/12345`;
  const { deps, written } = makeDeps({
    fetchFn: makeFetchFn({ [url]: { status: 200, body: ghData } }),
  });
  const result = await fetchJd(GH_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "fetched");
  assert.ok(result.text.includes("TITLE: Senior PM"));
  assert.ok(result.text.includes("LOCATION: San Francisco, CA"));
  assert.ok(result.text.includes("DEPARTMENT: Product"));
  assert.ok(result.text.includes("Senior PM")); // stripped HTML content
  // Verify write happened.
  const writtenPath = `${CACHE_DIR}/${cacheKey(GH_JOB)}`;
  assert.equal(written[writtenPath], result.text);
});

test("Greenhouse: 404 returns status=not_found", async () => {
  const url = `https://boards-api.greenhouse.io/v1/boards/affirm/jobs/12345`;
  const { deps } = makeDeps({ fetchFn: makeFetchFn({ [url]: { status: 404, body: {} } }) });
  const result = await fetchJd(GH_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "not_found");
});

// --- fetchJd: Lever fetch ----------------------------------------------------

test("Lever: cache miss fetches and writes text", async () => {
  const leverData = {
    text: "Lead PM",
    categories: { location: "Remote", team: "Product" },
    descriptionPlain: "You will own the product roadmap.",
    lists: [{ text: "Requirements", content: "<li>5+ years PM</li>" }],
  };
  const url = `https://api.lever.co/v0/postings/stripe/abc-123`;
  const { deps, written } = makeDeps({
    fetchFn: makeFetchFn({ [url]: { status: 200, body: leverData } }),
  });
  const result = await fetchJd(LEVER_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "fetched");
  assert.ok(result.text.includes("TITLE: Lead PM"));
  assert.ok(result.text.includes("LOCATION: Remote"));
  assert.ok(result.text.includes("TEAM: Product"));
  assert.ok(result.text.includes("own the product roadmap"));
  assert.ok(result.text.includes("Requirements"));
  const writtenPath = `${CACHE_DIR}/${cacheKey(LEVER_JOB)}`;
  assert.equal(written[writtenPath], result.text);
});

// --- fetchJd: unsupported source ---------------------------------------------

test("unsupported source returns status=unsupported", async () => {
  const job = { source: "ashby", slug: "ramp", jobId: "x", title: "PM", companyName: "Ramp" };
  const { deps } = makeDeps();
  const result = await fetchJd(job, CACHE_DIR, deps);
  assert.equal(result.status, "unsupported");
});

// --- fetchJd: network error --------------------------------------------------

test("network error returns status=error with message", async () => {
  const url = `https://boards-api.greenhouse.io/v1/boards/affirm/jobs/12345`;
  const { deps } = makeDeps({
    fetchFn: makeFetchFn({ [url]: { throws: new Error("ECONNREFUSED") } }),
  });
  const result = await fetchJd(GH_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "error");
  assert.match(result.error, /ECONNREFUSED/);
});

// --- fetchJd: dedup by key (second call hits cache) --------------------------

test("second call for same job returns cached (write once)", async () => {
  const ghData = { title: "PM", content: "desc", location: { name: "SF" } };
  const url = `https://boards-api.greenhouse.io/v1/boards/affirm/jobs/12345`;
  let fetchCount = 0;
  const { deps, written } = makeDeps({
    fetchFn: async (u, o) => {
      fetchCount++;
      return { ok: true, status: 200, async json() { return ghData; } };
    },
  });

  const r1 = await fetchJd(GH_JOB, CACHE_DIR, deps);
  assert.equal(r1.status, "fetched");
  assert.equal(fetchCount, 1);

  // Simulate the written file now existing (inject into existing map).
  const cachePath = `${CACHE_DIR}/${cacheKey(GH_JOB)}`;
  deps.exists = async (p) => p === cachePath;
  deps.readFile = async () => written[cachePath];

  const r2 = await fetchJd(GH_JOB, CACHE_DIR, deps);
  assert.equal(r2.status, "cached");
  assert.equal(fetchCount, 1); // not called again
});

// --- fetchAll ----------------------------------------------------------------

test("fetchAll returns empty array for empty input", async () => {
  const { deps } = makeDeps();
  const results = await fetchAll([], CACHE_DIR, deps);
  assert.deepEqual(results, []);
});

test("fetchAll processes all jobs and returns same count", async () => {
  const jobs = [
    { source: "greenhouse", slug: "affirm", jobId: "1", title: "PM", companyName: "Affirm" },
    { source: "lever", slug: "stripe", jobId: "2", title: "PM", companyName: "Stripe" },
    { source: "ashby", slug: "ramp", jobId: "3", title: "PM", companyName: "Ramp" },
  ];
  const ghData = { title: "PM", content: "desc", location: { name: "SF" } };
  const leverData = { text: "PM", categories: {}, descriptionPlain: "desc" };
  const fetchFn = makeFetchFn({
    "https://boards-api.greenhouse.io/v1/boards/affirm/jobs/1": { status: 200, body: ghData },
    "https://api.lever.co/v0/postings/stripe/2": { status: 200, body: leverData },
  });
  const { deps } = makeDeps({ fetchFn });
  const results = await fetchAll(jobs, CACHE_DIR, deps, { concurrency: 2 });
  assert.equal(results.length, 3);
  assert.equal(results[0].status, "fetched");
  assert.equal(results[1].status, "fetched");
  assert.equal(results[2].status, "unsupported");
});

// --- stripHtml ---------------------------------------------------------------

test("stripHtml converts tags to readable text", () => {
  const html = "<p>Hello <strong>world</strong></p><ul><li>Item 1</li><li>Item 2</li></ul>";
  const result = stripHtml(html);
  assert.ok(result.includes("Hello world"));
  assert.ok(result.includes("  - Item 1"));
  assert.ok(result.includes("  - Item 2"));
});

test("stripHtml decodes HTML entities", () => {
  const result = stripHtml("A &amp; B &lt;tag&gt; &quot;quoted&quot; &#39;apos&#39;");
  assert.ok(result.includes("A & B <tag> \"quoted\" 'apos'"));
});
