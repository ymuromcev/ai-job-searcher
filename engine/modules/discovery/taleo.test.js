const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const taleo = require("./taleo.js");
const { assertJob } = require("./_types.js");

const { _internals } = taleo;
const FIX_DIR = path.join(__dirname, "fixtures", "taleo");

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

const KAISER_TARGET = {
  name: "Kaiser Permanente",
  slug: "kaiser-641",
  siteUrl: "https://www.kaiserpermanentejobs.org",
  companyId: "641",
};

// --- pure helpers --------------------------------------------------------

test("isAllowedHost — kaiserpermanentejobs.org allowed", () => {
  assert.equal(_internals.isAllowedHost("www.kaiserpermanentejobs.org"), true);
  assert.equal(_internals.isAllowedHost("WWW.KAISERPERMANENTEJOBS.ORG"), true);
});

test("isAllowedHost — random hosts rejected", () => {
  assert.equal(_internals.isAllowedHost("kp.taleo.net"), false);
  assert.equal(_internals.isAllowedHost("evil.com"), false);
  assert.equal(_internals.isAllowedHost("internal"), false);
  assert.equal(_internals.isAllowedHost(""), false);
  assert.equal(_internals.isAllowedHost(null), false);
});

test("buildPageUrl — encodes location and uses 1-based ?p=", () => {
  const u1 = _internals.buildPageUrl(
    "https://www.kaiserpermanentejobs.org",
    "Sacramento, CA",
    0
  );
  assert.equal(u1, "https://www.kaiserpermanentejobs.org/search-jobs/Sacramento%2C%20CA?p=1");

  const u2 = _internals.buildPageUrl(
    "https://www.kaiserpermanentejobs.org/",
    "",
    4
  );
  // trailing slash stripped, empty location → no path segment
  assert.equal(u2, "https://www.kaiserpermanentejobs.org/search-jobs?p=5");
});

test("locationMatchesAllow — empty allow keeps everything", () => {
  assert.equal(_internals.locationMatchesAllow("Anywhere, CA", []), true);
  assert.equal(_internals.locationMatchesAllow("Anywhere, CA", undefined), true);
});

test("locationMatchesAllow — substring match is case-insensitive", () => {
  assert.equal(
    _internals.locationMatchesAllow("Sacramento, CA", ["sacramento", "Roseville"]),
    true
  );
  assert.equal(
    _internals.locationMatchesAllow("Oakland, CA", ["Sacramento", "Roseville"]),
    false
  );
});

test("TALEO_HOST_ALLOW — only contains expected hosts (regression guard)", () => {
  // If you add a host here, also extend RFC 031 §4.2 and the
  // matching test below so the SSRF guard surface stays explicit.
  const hosts = Array.from(_internals.TALEO_HOST_ALLOW);
  assert.deepEqual(hosts.sort(), ["www.kaiserpermanentejobs.org"]);
});

// --- HTML parser ---------------------------------------------------------

test("extractTaleo parses real Kaiser fixture", () => {
  const html = readFixture("kaiser-page1.html");
  const rows = _internals.extractTaleo(html, KAISER_TARGET);
  assert.equal(rows.length, 5, "fixture has 5 <li> entries");

  const first = rows[0];
  assert.equal(first.jobId, "94867233376");
  assert.equal(first.companyId, "641");
  assert.equal(
    first.title,
    "Physician Assistant - Sacramento - Addiction Medicine (Day/40)"
  );
  assert.equal(
    first.url,
    "https://www.kaiserpermanentejobs.org/job/sacramento/physician-assistant-sacramento-addiction-medicine-day-40/641/94867233376"
  );
  // metaLine "Sacramento, CA, Onsite, Full-time, Day" — 2-letter state at
  // parts[1] triggers City+ST collapse, so schedule lands on the actual
  // employment-type field (not "Onsite").
  assert.equal(first.location, "Sacramento, CA");
  assert.equal(first.workSetting, "Onsite");
  assert.equal(first.schedule, "Full-time");
  assert.equal(first.shift, "Day");
});

test("extractTaleo: Per Diem fixture row lands schedule on correct field", () => {
  const html = readFixture("kaiser-page1.html");
  const rows = _internals.extractTaleo(html, KAISER_TARGET);
  const perDiem = rows.find((r) => r.jobId === "95012180001");
  assert.ok(perDiem, "fixture has Roseville Medical Assistant PRN row");
  // metaLine "Roseville, CA, Onsite, Per Diem, Variable" → 5 parts.
  assert.equal(perDiem.location, "Roseville, CA");
  assert.equal(perDiem.workSetting, "Onsite");
  assert.equal(perDiem.schedule, "Per Diem");
  assert.equal(perDiem.shift, "Variable");
});

test("extractTaleo: 4-field tile (no state qualifier) keeps fields aligned", () => {
  // Defensive case — if Kaiser ever drops the state qualifier the parser
  // still produces a coherent record (rather than mis-aligning fields).
  const html = `<!doctype html><html><body>
<section id="search-results-list">
<ul>
<li><a href="/job/remote/foo/641/123456789" data-job-id="123456789">
<h2>Remote Role</h2>
<span class="job-location">Remote, Onsite, Full-time, Day</span>
</a></li>
</ul></section></body></html>`;
  const rows = _internals.extractTaleo(html, KAISER_TARGET);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].location, "Remote");
  assert.equal(rows[0].workSetting, "Onsite");
  assert.equal(rows[0].schedule, "Full-time");
  assert.equal(rows[0].shift, "Day");
});

test("extractTaleo returns [] when section is empty", () => {
  const html = readFixture("kaiser-empty.html");
  assert.deepEqual(_internals.extractTaleo(html, KAISER_TARGET), []);
});

test("extractTaleo returns [] when section is missing entirely", () => {
  const html = "<html><body><p>no jobs here</p></body></html>";
  assert.deepEqual(_internals.extractTaleo(html, KAISER_TARGET), []);
});

test("extractTaleo rejects rows whose companyId differs from target.companyId", () => {
  const html = `<!doctype html><html><body>
<section id="search-results-list">
<ul>
<li><a href="/job/x/y/999/123456789" data-job-id="123456789">
<h2>Wrong Tenant</h2><span class="job-location">Sacramento, CA, Onsite, Full-time</span>
</a><button data-org-id="999"></button></li>
</ul></section></body></html>`;
  const rows = _internals.extractTaleo(html, KAISER_TARGET);
  assert.deepEqual(rows, []);
});

test("extractTaleo rejects rows where button's data-org-id mismatches anchor companyId", () => {
  // Anchor says 641, button says 777 — refuse to trust.
  const html = `<!doctype html><html><body>
<section id="search-results-list">
<ul>
<li><a href="/job/x/y/641/123456789" data-job-id="123456789">
<h2>Spoof</h2><span class="job-location">Sacramento, CA, Onsite, Full-time</span>
</a><button data-org-id="777"></button></li>
</ul></section></body></html>`;
  const rows = _internals.extractTaleo(html, KAISER_TARGET);
  assert.deepEqual(rows, []);
});

test("extractTaleo skips rows without a recognizable jobId path", () => {
  const html = `<!doctype html><html><body>
<section id="search-results-list">
<ul>
<li><a href="/static/about" data-job-id="not-a-job"><h2>About</h2></a></li>
</ul></section></body></html>`;
  assert.deepEqual(_internals.extractTaleo(html, KAISER_TARGET), []);
});

test("extractTaleo skips rows without a title", () => {
  const html = `<!doctype html><html><body>
<section id="search-results-list">
<ul>
<li><a href="/job/x/y/641/123456789" data-job-id="123456789">
<span class="job-location">Sacramento, CA</span>
</a></li>
</ul></section></body></html>`;
  assert.deepEqual(_internals.extractTaleo(html, KAISER_TARGET), []);
});

test("extractTaleo accepts <h3> as fallback heading", () => {
  const html = `<!doctype html><html><body>
<section id="search-results-list">
<ul>
<li><a href="/job/x/y/641/123456789" data-job-id="123456789">
<h3>H3 Title</h3>
<span class="job-location">Sacramento, CA, Onsite, Full-time</span>
</a></li>
</ul></section></body></html>`;
  const rows = _internals.extractTaleo(html, KAISER_TARGET);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "H3 Title");
});

test("extractTaleo tolerates non-string / null input", () => {
  assert.deepEqual(_internals.extractTaleo("", KAISER_TARGET), []);
  assert.deepEqual(_internals.extractTaleo(null, KAISER_TARGET), []);
  assert.deepEqual(_internals.extractTaleo(undefined, KAISER_TARGET), []);
});

// --- mapJob + assertJob --------------------------------------------------

test("mapJob produces canonical Job shape", () => {
  const raw = {
    jobId: "94867233376",
    companyId: "641",
    title: "Physician Assistant",
    url: "https://www.kaiserpermanentejobs.org/job/x/y/641/94867233376",
    location: "Sacramento",
    workSetting: "Onsite",
    schedule: "Full-time",
    shift: "Day",
  };
  const job = _internals.mapJob(KAISER_TARGET, raw);
  assert.doesNotThrow(() => assertJob(job));
  assert.equal(job.source, "taleo");
  assert.equal(job.companyName, "Kaiser Permanente");
  assert.equal(job.slug, "kaiser-641");
  assert.equal(job.jobId, "94867233376");
  assert.deepEqual(job.locations, ["Sacramento"]);
  assert.equal(job.rawExtra.companyId, "641");
  assert.equal(job.rawExtra.workSetting, "Onsite");
  assert.equal(job.rawExtra.scheduleHint, "Full-time");
  assert.equal(job.rawExtra.shift, "Day");
});

// --- discover() — end-to-end through a fake fetch ------------------------

function makeKaiserResponses(pages) {
  // pages: array of HTML strings, one per ?p=N (1-based). After exhausted,
  // return an empty results page (which the adapter treats as end-of-pagination).
  return makeFetch(async (url) => {
    if (!url.includes("www.kaiserpermanentejobs.org")) {
      return makeResponse("", { ok: false, status: 404 });
    }
    const m = url.match(/[?&]p=(\d+)/);
    const p = m ? Number(m[1]) - 1 : 0; // page idx 0-based
    if (p < pages.length) return makeResponse(pages[p]);
    return makeResponse(readFixtureOrEmpty("kaiser-empty.html"));
  });
}

function readFixtureOrEmpty(name) {
  try {
    return readFixture(name);
  } catch {
    return "";
  }
}

test("discover — happy path returns jobs from page 1", async () => {
  const html = readFixture("kaiser-page1.html");
  const fetchFn = makeKaiserResponses([html]);
  const jobs = await taleo.discover([KAISER_TARGET], { fetchFn });
  assert.equal(jobs.length, 5);
  for (const j of jobs) {
    assert.doesNotThrow(() => assertJob(j));
    assert.equal(j.source, "taleo");
    assert.equal(j.slug, "kaiser-641");
  }
});

test("discover — locationAllow prunes NorCal to Sacramento metro", async () => {
  const html = readFixture("kaiser-page1.html");
  const fetchFn = makeKaiserResponses([html]);
  const jobs = await taleo.discover(
    [{ ...KAISER_TARGET, locationAllow: ["Sacramento", "Roseville"] }],
    { fetchFn }
  );
  // 5 fixture rows: Sacramento, Sacramento, Roseville, Oakland, Santa Clara
  // → 3 keep, 2 drop
  assert.equal(jobs.length, 3);
  const locs = jobs.map((j) => j.locations[0]).sort();
  assert.deepEqual(locs, ["Roseville, CA", "Sacramento, CA", "Sacramento, CA"]);
});

test("discover — pagination stops when duplicate page returned", async () => {
  // TalentBrew sometimes echoes the last page indefinitely past total. Verify
  // the duplicate-jobIds short-circuit catches it.
  const html = readFixture("kaiser-page1.html");
  const fetchFn = makeKaiserResponses([html, html, html]);
  const jobs = await taleo.discover([KAISER_TARGET], { fetchFn });
  assert.equal(jobs.length, 5, "duplicate pages collapse to unique 5");
  // 2 fetches total: page 1 collects, page 2 detects duplicate-content → stop.
  assert.equal(fetchFn.calls.length, 2);
});

test("discover — pagination stops on empty page", async () => {
  const html = readFixture("kaiser-page1.html");
  const empty = readFixture("kaiser-empty.html");
  const fetchFn = makeKaiserResponses([html, empty]);
  const jobs = await taleo.discover([KAISER_TARGET], { fetchFn });
  assert.equal(jobs.length, 5);
  // 2 fetches: page 1 yields 5, page 2 empty → stop.
  assert.equal(fetchFn.calls.length, 2);
});

test("discover — SSRF: siteUrl outside allow-list is skipped, no fetch made", async () => {
  const fetchFn = makeFetch(async () => makeResponse("should not be reached"));
  const jobs = await taleo.discover(
    [
      {
        name: "Evil",
        slug: "evil",
        siteUrl: "https://internal.example/search-jobs",
        companyId: "641",
      },
    ],
    { fetchFn }
  );
  assert.deepEqual(jobs, []);
  assert.equal(fetchFn.calls.length, 0, "no network calls for rejected host");
});

test("discover — SSRF: http:// (non-TLS) siteUrl is skipped", async () => {
  const fetchFn = makeFetch(async () => makeResponse("should not be reached"));
  const jobs = await taleo.discover(
    [
      {
        ...KAISER_TARGET,
        siteUrl: "http://www.kaiserpermanentejobs.org",
      },
    ],
    { fetchFn }
  );
  assert.deepEqual(jobs, []);
  assert.equal(fetchFn.calls.length, 0);
});

test("discover — missing companyId rejected before fetch", async () => {
  const fetchFn = makeFetch(async () => makeResponse("nope"));
  const jobs = await taleo.discover(
    [
      {
        name: "Kaiser",
        slug: "kaiser",
        siteUrl: "https://www.kaiserpermanentejobs.org",
        // companyId missing
      },
    ],
    { fetchFn }
  );
  assert.deepEqual(jobs, []);
  assert.equal(fetchFn.calls.length, 0);
});

test("discover — invalid companyId (non-numeric) rejected", async () => {
  const fetchFn = makeFetch(async () => makeResponse("nope"));
  const jobs = await taleo.discover(
    [{ ...KAISER_TARGET, companyId: "abc" }],
    { fetchFn }
  );
  assert.deepEqual(jobs, []);
  assert.equal(fetchFn.calls.length, 0);
});

test("discover — searchLocations iterates and dedups across queries", async () => {
  const html = readFixture("kaiser-page1.html");
  const fetchFn = makeFetch(async (url) => {
    // Return the same fixture for both queries; the same 5 jobs in both.
    return makeResponse(/[?&]p=1\b/.test(url) ? html : readFixture("kaiser-empty.html"));
  });
  const jobs = await taleo.discover(
    [
      {
        ...KAISER_TARGET,
        searchLocations: ["Sacramento, CA", "Roseville, CA"],
      },
    ],
    { fetchFn }
  );
  // Dedup across queries → 5 unique jobs, not 10.
  assert.equal(jobs.length, 5);
  // 4 fetches: ?p=1 twice (one per location), then ?p=2 (empty) twice.
  assert.equal(fetchFn.calls.length, 4);
});

test("discover — 5xx errors are isolated; scan continues for other targets", async () => {
  const fetchFn = makeFetch(async (url) => {
    if (url.includes("p=1")) return makeResponse("", { ok: false, status: 503 });
    return makeResponse(readFixture("kaiser-empty.html"));
  });
  const jobs = await taleo.discover([KAISER_TARGET], { fetchFn });
  assert.deepEqual(jobs, [], "5xx → target reported as failed, returns no jobs");
});
