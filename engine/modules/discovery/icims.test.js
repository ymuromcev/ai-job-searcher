const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const icims = require("./icims.js");
const { assertJob } = require("./_types.js");

const { _internals } = icims;
const FIX_DIR = path.join(__dirname, "fixtures", "icims");

function readFixture(name) {
  return fs.readFileSync(path.join(FIX_DIR, name), "utf8");
}

function makeResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => body,
  };
}

function makeFetch(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    return handler(url, opts);
  };
  fn.calls = calls;
  return fn;
}

// --- pure helpers --------------------------------------------------------

test("isValidSlug accepts standard tenant slugs", () => {
  for (const slug of ["shriners", "nvisioncenters", "commonspirit", "abc123"]) {
    assert.equal(_internals.isValidSlug(slug), true, `should accept ${slug}`);
  }
});

test("isValidSlug rejects garbage", () => {
  for (const bad of ["", "../foo", "ab cd", "abc.def", "abc/def", null, undefined, "UPPER", "-leading"]) {
    assert.equal(_internals.isValidSlug(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test("buildPageUrl — icims-default adds ?ss=1&pr=N&in_iframe=1", () => {
  const url = _internals.buildPageUrl(
    "https://careers-shriners.icims.com/jobs/search",
    "icims-default",
    0
  );
  assert.match(url, /\?ss=1&pr=0&in_iframe=1$/);
  const url2 = _internals.buildPageUrl(
    "https://careers-shriners.icims.com/jobs/search",
    "icims-default",
    3
  );
  assert.match(url2, /pr=3/);
});

test("buildPageUrl — talentbrew uses ?p=N (1-based)", () => {
  const url = _internals.buildPageUrl(
    "https://www.commonspirit.careers/search-jobs",
    "talentbrew",
    0
  );
  assert.equal(url, "https://www.commonspirit.careers/search-jobs?p=1");
  const url2 = _internals.buildPageUrl(
    "https://www.commonspirit.careers/search-jobs?q=rn",
    "talentbrew",
    4
  );
  assert.equal(url2, "https://www.commonspirit.careers/search-jobs?q=rn&p=5");
});

test("locationMatchesAllow — empty allow keeps everything", () => {
  assert.equal(_internals.locationMatchesAllow("Anywhere, USA", []), true);
  assert.equal(_internals.locationMatchesAllow("Anywhere, USA", undefined), true);
});

test("locationMatchesAllow — substring match is case-insensitive", () => {
  assert.equal(
    _internals.locationMatchesAllow("US-CA-Sacramento", ["Sacramento", "Roseville"]),
    true
  );
  assert.equal(
    _internals.locationMatchesAllow("Roseville, CA", ["sacramento"]),
    false
  );
  assert.equal(
    _internals.locationMatchesAllow("London, KY", ["Sacramento", "Roseville"]),
    false
  );
});

test("locationMatchesAllow — empty location with non-empty allow drops", () => {
  assert.equal(_internals.locationMatchesAllow("", ["Sacramento"]), false);
  assert.equal(_internals.locationMatchesAllow(null, ["Sacramento"]), false);
});

// --- icims-default HTML parser ------------------------------------------

test("extractIcimsDefault parses real Shriners fixture", () => {
  const html = readFixture("shriners-page0.html");
  const rows = _internals.extractIcimsDefault(html);
  assert.equal(rows.length, 3, "fixture has 3 job-card items");

  const first = rows[0];
  assert.equal(first.jobId, "8909");
  assert.equal(first.title, "Senior Radiology Technologist, PRN");
  assert.match(first.url, /careers-shriners\.icims\.com\/jobs\/8909\//);
  assert.equal(first.location, "US-WA-Vancouver");
  assert.equal(first.category, "Radiology");
});

test("extractIcimsDefault returns [] on empty page", () => {
  const html = readFixture("shriners-empty.html");
  assert.deepEqual(_internals.extractIcimsDefault(html), []);
});

test("extractIcimsDefault skips rows without a recognizable jobId", () => {
  const html =
    `<ul><li class="iCIMS_JobCardItem">` +
    `<a href="/something/else" class="iCIMS_Anchor" title="X"><h3>Junk</h3></a>` +
    `</li></ul>`;
  assert.deepEqual(_internals.extractIcimsDefault(html), []);
});

test("extractIcimsDefault skips rows without a title", () => {
  const html =
    `<ul><li class="iCIMS_JobCardItem">` +
    `<a href="/jobs/123/foo/job" class="iCIMS_Anchor" title="123 - "></a>` +
    `</li></ul>`;
  assert.deepEqual(_internals.extractIcimsDefault(html), []);
});

test("extractIcimsDefault tolerates non-string / null input", () => {
  assert.deepEqual(_internals.extractIcimsDefault(""), []);
  assert.deepEqual(_internals.extractIcimsDefault(null), []);
  assert.deepEqual(_internals.extractIcimsDefault(undefined), []);
});

// --- talentbrew HTML parser ---------------------------------------------

test("extractTalentbrew parses real CommonSpirit fixture", () => {
  const html = readFixture("commonspirit-page1.html");
  const rows = _internals.extractTalentbrew(html, "https://www.commonspirit.careers/search-jobs");
  assert.equal(rows.length, 3, "fixture has 3 search-results-list items");

  const first = rows[0];
  assert.equal(first.jobId, "94991436416");
  assert.equal(first.title, "Resource RN");
  assert.equal(
    first.url,
    "https://www.commonspirit.careers/job/london/resource-rn/35300/94991436416"
  );
  assert.equal(first.location, "London, KY");
  assert.equal(first.department, "Emergency Services");
  assert.equal(first.facility, "CHI Saint Joseph London");
});

test("extractTalentbrew falls back to URL-tail when data-job-id is missing", () => {
  const html =
    `<ul class="search-results-list__list">` +
    `<li class="search-results-list__item chi">` +
    `<h2><a class="search-results-list__job-link" href="/job/sac/rn/12/777">Nurse</a></h2>` +
    `</li></ul>`;
  const rows = _internals.extractTalentbrew(html, "https://www.commonspirit.careers/search-jobs");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].jobId, "777");
  assert.equal(rows[0].url, "https://www.commonspirit.careers/job/sac/rn/12/777");
});

test("extractTalentbrew returns [] on empty page", () => {
  const html = readFixture("commonspirit-empty.html");
  assert.deepEqual(_internals.extractTalentbrew(html, "https://www.commonspirit.careers/search-jobs"), []);
});

// --- mapJob + assertJob -------------------------------------------------

test("mapJob produces canonical Job shape (icims-default)", () => {
  const target = { name: "Shriners Children's", slug: "shriners", htmlMode: "icims-default" };
  const raw = {
    jobId: "8909",
    title: "Senior Radiology Technologist, PRN",
    url: "https://careers-shriners.icims.com/jobs/8909/x/job",
    location: "US-WA-Vancouver",
    category: "Radiology",
  };
  const job = _internals.mapJob(target, raw);
  assert.doesNotThrow(() => assertJob(job));
  assert.equal(job.source, "icims");
  assert.equal(job.companyName, "Shriners Children's");
  assert.equal(job.jobId, "8909");
  assert.equal(job.team, "Radiology");
  assert.deepEqual(job.locations, ["US-WA-Vancouver"]);
  assert.equal(job.postedAt, null);
});

test("mapJob produces canonical Job shape (talentbrew)", () => {
  const target = {
    name: "CommonSpirit Health",
    slug: "commonspirit",
    htmlMode: "talentbrew",
    urlBase: "https://www.commonspirit.careers/search-jobs",
  };
  const raw = {
    jobId: "94991436416",
    title: "Resource RN",
    url: "https://www.commonspirit.careers/job/london/resource-rn/35300/94991436416",
    location: "London, KY",
    department: "Emergency Services",
    facility: "CHI Saint Joseph London",
  };
  const job = _internals.mapJob(target, raw);
  assert.doesNotThrow(() => assertJob(job));
  assert.equal(job.team, "Emergency Services");
  assert.equal(job.rawExtra.facility, "CHI Saint Joseph London");
});

// --- discover() — end-to-end through a fake fetch ------------------------

function makeIcimsResponses({ slug, pages }) {
  // pages: array of HTML strings, one per ?pr=N. After exhausted, return 404.
  return makeFetch(async (url) => {
    if (!url.includes(`careers-${slug}.icims.com`)) {
      return makeResponse("", { ok: false, status: 404 });
    }
    const m = url.match(/[?&]pr=(\d+)/);
    const p = m ? Number(m[1]) : 0;
    if (p < pages.length) return makeResponse(pages[p]);
    if (p === 0) return makeResponse("<html><body></body></html>"); // empty first page
    return makeResponse("", { ok: false, status: 404 });
  });
}

test("discover — happy path returns jobs from page 1 (icims-default)", async () => {
  const html = readFixture("shriners-page0.html");
  const fetchFn = makeIcimsResponses({ slug: "shriners", pages: [html, ""] });
  const jobs = await icims.discover(
    [{ name: "Shriners Children's", slug: "shriners" }],
    { fetchFn }
  );
  assert.equal(jobs.length, 3);
  for (const j of jobs) {
    assert.doesNotThrow(() => assertJob(j));
    assert.equal(j.source, "icims");
    assert.equal(j.slug, "shriners");
  }
});

test("discover — pagination walks pages until empty", async () => {
  const html = readFixture("shriners-page0.html");
  const fetchFn = makeIcimsResponses({ slug: "shriners", pages: [html, html, ""] });
  const jobs = await icims.discover(
    [{ name: "Shriners Children's", slug: "shriners" }],
    { fetchFn }
  );
  assert.equal(jobs.length, 6, "two non-empty pages × 3 rows each");
  // fetched 3 pages total: pr=0 (jobs), pr=1 (jobs), pr=2 (empty → stop)
  assert.equal(fetchFn.calls.length, 3);
});

test("discover — locationAllow filters at the adapter level", async () => {
  const html = readFixture("shriners-page0.html");
  const fetchFn = makeIcimsResponses({ slug: "shriners", pages: [html, ""] });
  const jobs = await icims.discover(
    [{ name: "Shriners Children's", slug: "shriners", locationAllow: ["Sacramento"] }],
    { fetchFn }
  );
  assert.equal(jobs.length, 0, "fixture has no Sacramento rows");
});

test("discover — locationAllow keeps matches and drops others", async () => {
  const html =
    `<ul>` +
    `<li class="iCIMS_JobCardItem"><div class="col-xs-6 header left">` +
    `<span class="sr-only field-label">Job Locations</span><span >US-CA-Sacramento</span></div>` +
    `<a href="/jobs/100/x/job" class="iCIMS_Anchor" title="100 - A"><h3>A</h3></a></li>` +
    `<li class="iCIMS_JobCardItem"><div class="col-xs-6 header left">` +
    `<span class="sr-only field-label">Job Locations</span><span >US-WA-Vancouver</span></div>` +
    `<a href="/jobs/101/y/job" class="iCIMS_Anchor" title="101 - B"><h3>B</h3></a></li>` +
    `</ul>`;
  const fetchFn = makeIcimsResponses({ slug: "test", pages: [html, ""] });
  const jobs = await icims.discover(
    [{ name: "Test", slug: "test", locationAllow: ["Sacramento", "Roseville"] }],
    { fetchFn }
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobId, "100");
});

test("discover — talentbrew mode through urlBase", async () => {
  const html = readFixture("commonspirit-page1.html");
  const fetchFn = makeFetch(async (url) => {
    if (!url.startsWith("https://www.commonspirit.careers/search-jobs")) {
      return makeResponse("", { ok: false, status: 404 });
    }
    const m = url.match(/[?&]p=(\d+)/);
    const p = m ? Number(m[1]) : 1;
    if (p === 1) return makeResponse(html);
    return makeResponse("<html></html>");
  });
  const jobs = await icims.discover(
    [
      {
        name: "CommonSpirit Health",
        slug: "commonspirit",
        urlBase: "https://www.commonspirit.careers/search-jobs",
        htmlMode: "talentbrew",
      },
    ],
    { fetchFn }
  );
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].companyName, "CommonSpirit Health");
  assert.match(jobs[0].url, /^https:\/\/www\.commonspirit\.careers\/job\//);
});

test("discover — invalid slug logs warn and returns []", async () => {
  const warns = [];
  const fetchFn = makeFetch(async () => makeResponse(""));
  const jobs = await icims.discover(
    [{ name: "Bad", slug: "../etc/passwd" }],
    { fetchFn, logger: { warn: (m) => warns.push(m) } }
  );
  assert.equal(jobs.length, 0);
  assert.equal(fetchFn.calls.length, 0, "no HTTP call for invalid slug");
  assert.equal(warns.length, 1);
  assert.match(warns[0], /invalid slug/);
});

test("discover — unknown htmlMode is rejected", async () => {
  const warns = [];
  const fetchFn = makeFetch(async () => makeResponse(""));
  const jobs = await icims.discover(
    [{ name: "Bad", slug: "ok", htmlMode: "evil-mode" }],
    { fetchFn, logger: { warn: (m) => warns.push(m) } }
  );
  assert.equal(jobs.length, 0);
  assert.equal(fetchFn.calls.length, 0);
  assert.match(warns[0], /unknown htmlMode/);
});

test("discover — non-https urlBase is rejected (SSRF guard)", async () => {
  const warns = [];
  const fetchFn = makeFetch(async () => makeResponse(""));
  const jobs = await icims.discover(
    [{ name: "Bad", slug: "ok", urlBase: "http://localhost:8080/jobs/search" }],
    { fetchFn, logger: { warn: (m) => warns.push(m) } }
  );
  assert.equal(jobs.length, 0);
  assert.equal(fetchFn.calls.length, 0);
  assert.match(warns[0], /https/);
});

test("discover — malformed urlBase is rejected", async () => {
  const warns = [];
  const fetchFn = makeFetch(async () => makeResponse(""));
  const jobs = await icims.discover(
    [{ name: "Bad", slug: "ok", urlBase: "not a url" }],
    { fetchFn, logger: { warn: (m) => warns.push(m) } }
  );
  assert.equal(jobs.length, 0);
  assert.match(warns[0], /invalid urlBase/);
});

test("discover — HTTP 500 throws and gets isolated by runTargets", async () => {
  const warns = [];
  const fetchFn = makeFetch(async () =>
    makeResponse("", { ok: false, status: 500 })
  );
  const jobs = await icims.discover(
    [{ name: "Boom", slug: "shriners" }],
    { fetchFn, logger: { warn: (m) => warns.push(m) } }
  );
  assert.equal(jobs.length, 0, "500 from page 0 kills this target only");
  assert.ok(warns.some((w) => /HTTP 500/.test(w)), `expected HTTP 500 warning, got ${JSON.stringify(warns)}`);
});

test("discover — 404 on page > 0 terminates pagination cleanly", async () => {
  const html = readFixture("shriners-page0.html");
  const fetchFn = makeFetch(async (url) => {
    const m = url.match(/[?&]pr=(\d+)/);
    const p = m ? Number(m[1]) : 0;
    if (p === 0) return makeResponse(html);
    return makeResponse("", { ok: false, status: 404 });
  });
  const jobs = await icims.discover(
    [{ name: "Shriners", slug: "shriners" }],
    { fetchFn }
  );
  assert.equal(jobs.length, 3, "first page parsed; pr=1 404 ends pagination");
});

test("discover — multiple tenants run independently; one failure doesn't kill the other", async () => {
  const html = readFixture("shriners-page0.html");
  const fetchFn = makeFetch(async (url) => {
    if (url.includes("careers-good.icims.com")) {
      const m = url.match(/[?&]pr=(\d+)/);
      const p = m ? Number(m[1]) : 0;
      if (p === 0) return makeResponse(html);
      return makeResponse("<html></html>");
    }
    return makeResponse("", { ok: false, status: 500 });
  });
  const jobs = await icims.discover(
    [
      { name: "Bad", slug: "bad" },
      { name: "Good", slug: "good" },
    ],
    { fetchFn, logger: { warn: () => {} } }
  );
  assert.equal(jobs.length, 3, "good tenant returns jobs even after bad tenant fails");
  assert.ok(jobs.every((j) => j.slug === "good"));
});

test("discover — non-icims.com host without explicit htmlMode is rejected (SSRF hardening)", async () => {
  const warns = [];
  const fetchFn = makeFetch(async () => makeResponse(""));
  const jobs = await icims.discover(
    [{ name: "Suspicious", slug: "ok", urlBase: "https://evil.example.com/jobs/search" }],
    { fetchFn, logger: { warn: (m) => warns.push(m) } }
  );
  assert.equal(jobs.length, 0);
  assert.equal(fetchFn.calls.length, 0);
  assert.match(warns[0], /outside \*\.icims\.com/);
});

test("discover — non-icims.com host WITH talentbrew mode is allowed", async () => {
  const html = readFixture("commonspirit-page1.html");
  const fetchFn = makeFetch(async (url) => {
    if (url.startsWith("https://www.commonspirit.careers/")) return makeResponse(html);
    return makeResponse("<html></html>");
  });
  const jobs = await icims.discover(
    [
      {
        name: "CommonSpirit Health",
        slug: "commonspirit",
        urlBase: "https://www.commonspirit.careers/search-jobs",
        htmlMode: "talentbrew",
      },
    ],
    { fetchFn, logger: { warn: () => {} } }
  );
  assert.ok(jobs.length > 0, "talentbrew mode opens the gate for non-*.icims.com hosts");
});

test("discover — HTML response over MAX_HTML_BYTES gets truncated, not OOM'd", async () => {
  // Build a 6 MB response: 1 valid row + a long tail of junk past the cap.
  const validRow =
    `<ul><li class="iCIMS_JobCardItem">` +
    `<div class="col-xs-6 header left"><span class="sr-only field-label">Job Locations</span><span >US-CA-Sacramento</span></div>` +
    `<a href="/jobs/123/x/job" class="iCIMS_Anchor" title="123 - A"><h3>A</h3></a>` +
    `</li></ul>`;
  const padding = "X".repeat(6 * 1024 * 1024);
  const hugeHtml = validRow + padding;
  const fetchFn = makeFetch(async (url) => {
    const m = url.match(/[?&]pr=(\d+)/);
    const p = m ? Number(m[1]) : 0;
    if (p === 0) return makeResponse(hugeHtml);
    return makeResponse("<html></html>");
  });
  const t0 = Date.now();
  const jobs = await icims.discover(
    [{ name: "Test", slug: "test" }],
    { fetchFn }
  );
  const dt = Date.now() - t0;
  assert.equal(jobs.length, 1, "parses the one real row before the truncation cap");
  assert.ok(dt < 2000, `should complete fast even on huge input (took ${dt}ms)`);
});

test("decodeHtmlEntities — handles numeric, hex, and named entities", () => {
  // Inline test through extractIcimsDefault which calls decodeHtmlEntities on href.
  const html =
    `<ul><li class="iCIMS_JobCardItem">` +
    `<a href="/jobs/200/foo&amp;bar/job?x=1&#x26;y=2&#38;z=3" class="iCIMS_Anchor" title="200 - X"><h3>X</h3></a>` +
    `</li></ul>`;
  const rows = _internals.extractIcimsDefault(html);
  assert.equal(rows.length, 1);
  // All three ampersand entities should decode to literal "&"
  assert.match(rows[0].url, /\?x=1&y=2&z=3/);
  assert.match(rows[0].url, /foo&bar/);
});

test("decodeHtmlEntities — does NOT mangle &#x2A; (asterisk)", () => {
  // Regression: original implementation aliased &#x26; AND &#x2A; both to "&"
  // due to a too-broad regex. Verify asterisk decodes cleanly.
  const html =
    `<ul><li class="iCIMS_JobCardItem">` +
    `<a href="/jobs/300/foo&#x2A;bar/job" class="iCIMS_Anchor" title="300 - X"><h3>X</h3></a>` +
    `</li></ul>`;
  const rows = _internals.extractIcimsDefault(html);
  assert.equal(rows.length, 1);
  assert.match(rows[0].url, /foo\*bar/, `expected literal "*", got: ${rows[0].url}`);
});

test("discover — empty target list returns []", async () => {
  const fetchFn = makeFetch(async () => makeResponse(""));
  const jobs = await icims.discover([], { fetchFn });
  assert.deepEqual(jobs, []);
  assert.equal(fetchFn.calls.length, 0);
});
