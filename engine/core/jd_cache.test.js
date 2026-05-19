const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  cacheKey,
  fetchJd,
  fetchAll,
  stripHtml,
  SUPPORTED,
  JD_UNSUPPORTED,
  formatWorkday,
  formatIcims,
  formatTaleo,
  formatWorkable,
  buildWorkdayApiUrl,
  buildWorkableApiUrl,
  extractJsonLdJob,
  isAllowedTaleoHost,
} = require("./jd_cache.js");
const fs = require("node:fs");
const path = require("node:path");

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
      writeFile: async (p, data) => {
        written[p] = data;
      },
      mkdirp: async () => {},
      fetchFn:
        overrides.fetchFn ||
        (async () => {
          throw new Error("network disabled");
        }),
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
      async json() {
        return entry.body;
      },
      async text() {
        return entry.html != null ? entry.html : entry.body;
      },
    };
  };
}

const GH_JOB = {
  source: "greenhouse",
  slug: "affirm",
  jobId: "12345",
  title: "Senior PM",
  companyName: "Affirm",
};
const LEVER_JOB = {
  source: "lever",
  slug: "stripe",
  jobId: "abc-123",
  title: "Lead PM",
  companyName: "Stripe",
};
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
      return {
        ok: true,
        status: 200,
        async json() {
          return ghData;
        },
      };
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

// --- Workday (RFC 030 Phase A) -----------------------------------------------

const WORKDAY_JOB = {
  source: "workday",
  slug: "sutterhealth",
  jobId: "/job/Sacramento/Ethics---Compliance-Auditor-II_R-127489",
  title: "Ethics & Compliance Auditor II",
  url: "https://sutterhealth.wd1.myworkdayjobs.com/en-US/jobs/job/Sacramento/Ethics---Compliance-Auditor-II_R-127489",
  companyName: "Sutter Health",
};
const WORKDAY_API_URL =
  "https://sutterhealth.wd1.myworkdayjobs.com/wday/cxs/sutterhealth/jobs/job/Sacramento/Ethics---Compliance-Auditor-II_R-127489";

test("buildWorkdayApiUrl derives /wday/cxs/ endpoint from user-facing url", () => {
  assert.equal(buildWorkdayApiUrl(WORKDAY_JOB), WORKDAY_API_URL);
});

test("buildWorkdayApiUrl honours non-default site (External) from url path", () => {
  const job = {
    ...WORKDAY_JOB,
    url: "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Foo_R1",
    jobId: "/job/Foo_R1",
  };
  assert.equal(
    buildWorkdayApiUrl(job),
    "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/Foo_R1"
  );
});

test("buildWorkdayApiUrl rejects non-Workday hostnames (SSRF guard)", () => {
  assert.equal(
    buildWorkdayApiUrl({ ...WORKDAY_JOB, url: "https://evil.example.com/en-US/jobs/job/X" }),
    null
  );
  assert.equal(
    buildWorkdayApiUrl({ ...WORKDAY_JOB, url: "http://sutterhealth.wd1.myworkdayjobs.com/x" }),
    null
  );
  assert.equal(buildWorkdayApiUrl({ ...WORKDAY_JOB, url: "not a url" }), null);
});

test("buildWorkdayApiUrl rejects jobId with path injection / query / fragment", () => {
  const bad = [
    "/job/../../../etc/passwd",
    "/job/X?evil=1",
    "/job/X#frag",
    "/job/X with space",
    "/job/X\nY",
    "/admin/job/X",
    "../job/X",
    "",
  ];
  for (const jobId of bad) {
    assert.equal(buildWorkdayApiUrl({ ...WORKDAY_JOB, jobId }), null, `should reject "${jobId}"`);
  }
});

test("formatWorkday produces TITLE/LOCATION/SCHEDULE header + stripped body", () => {
  const data = {
    jobPostingInfo: {
      title: "Ethics & Compliance Auditor II",
      location: "Sacramento, CA",
      timeType: "Full time",
      jobReqId: "R-127489",
      jobDescription:
        "<p>Join our Ethics &amp; Compliance team.</p><ul><li>3+ years audit</li></ul>",
    },
  };
  const text = formatWorkday(data, WORKDAY_JOB);
  assert.match(text, /^TITLE: Ethics & Compliance Auditor II/m);
  assert.match(text, /^LOCATION: Sacramento, CA/m);
  assert.match(text, /^SCHEDULE: Full time/m);
  assert.match(text, /^REQ ID: R-127489/m);
  assert.match(text, /Join our Ethics & Compliance team\./);
  assert.match(text, /- 3\+ years audit/);
});

test("formatWorkday returns null when jobDescription is missing/empty", () => {
  assert.equal(formatWorkday({}, WORKDAY_JOB), null);
  assert.equal(
    formatWorkday({ jobPostingInfo: { title: "X", timeType: "Full time" } }, WORKDAY_JOB),
    null,
    "header-only payload must not poison the cache"
  );
});

test("Workday: cache miss fetches JSON, formats, and writes text", async () => {
  const data = {
    jobPostingInfo: {
      title: "Ethics & Compliance Auditor II",
      location: "Sacramento, CA",
      timeType: "Full time",
      jobDescription: "<p>Position summary.</p>",
    },
  };
  const { deps, written } = makeDeps({
    fetchFn: makeFetchFn({ [WORKDAY_API_URL]: { status: 200, body: data } }),
  });
  const result = await fetchJd(WORKDAY_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "fetched");
  assert.ok(result.text.includes("SCHEDULE: Full time"));
  assert.ok(result.text.includes("Position summary."));
  const writtenPath = `${CACHE_DIR}/${cacheKey(WORKDAY_JOB)}`;
  assert.equal(written[writtenPath], result.text);
});

test("Workday: 404 returns status=not_found", async () => {
  const { deps } = makeDeps({
    fetchFn: makeFetchFn({ [WORKDAY_API_URL]: { status: 404, body: {} } }),
  });
  const result = await fetchJd(WORKDAY_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "not_found");
});

test("Workday: header-only payload (no description) → not_found, no cache write", async () => {
  const data = { jobPostingInfo: { title: "X", timeType: "Full time" } };
  const { deps, written } = makeDeps({
    fetchFn: makeFetchFn({ [WORKDAY_API_URL]: { status: 200, body: data } }),
  });
  const result = await fetchJd(WORKDAY_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "not_found");
  assert.equal(Object.keys(written).length, 0);
});

test("Workday: non-Workday hostname short-circuits to not_found (no fetch)", async () => {
  let calls = 0;
  const { deps } = makeDeps({
    fetchFn: async () => {
      calls++;
      return { ok: true, status: 200, async json() {}, async text() {} };
    },
  });
  const job = { ...WORKDAY_JOB, url: "https://evil.example.com/foo" };
  const result = await fetchJd(job, CACHE_DIR, deps);
  assert.equal(result.status, "not_found");
  assert.equal(calls, 0, "fetchFn must not be called for unsafe URL");
});

// --- iCIMS (RFC 030 Phase B) -------------------------------------------------

const ICIMS_JOB = {
  source: "icims",
  slug: "shriners",
  jobId: "8535",
  title: "Supply Chain Technician (Per Diem)",
  url: "https://careers-shriners.icims.com/jobs/8535/supply-chain-tech/job?in_iframe=1",
  companyName: "Shriners",
};

const ICIMS_DEFAULT_HTML = `
<html><body>
  <span class="sr-only field-label">Job Locations</span>
  <span>US-CA-Sacramento</span>
  <div class="iCIMS_JobContent">
    <h1>Supply Chain Technician (Per Diem)</h1>
    <p>Join our Supply Chain team in a <strong>Per Diem</strong> capacity.</p>
    <ul>
      <li>HS diploma required</li>
      <li>BLS preferred</li>
    </ul>
  </div>
  <!-- /iCIMS_JobContent -->
</body></html>
`;

const ICIMS_TALENTBREW_HTML = `
<html><body>
  <section>
    <div class="ats-description">
      <p>Full time RN role at CommonSpirit.</p>
      <ul><li>ACLS required</li></ul>
    </div>
  </section>
</body></html>
`;

test("formatIcims extracts iCIMS_JobContent and surfaces TITLE/LOCATION header", () => {
  const text = formatIcims(ICIMS_DEFAULT_HTML, ICIMS_JOB);
  assert.match(text, /^TITLE: Supply Chain Technician/m);
  assert.match(text, /^LOCATION: US-CA-Sacramento/m);
  assert.match(text, /Per Diem capacity/);
  assert.match(text, /- HS diploma required/);
  assert.match(text, /- BLS preferred/);
});

test("formatIcims falls back to ats-description (talentbrew tenants)", () => {
  const text = formatIcims(ICIMS_TALENTBREW_HTML, { ...ICIMS_JOB, title: "RN" });
  assert.match(text, /^TITLE: RN/m);
  assert.match(text, /Full time RN role/);
  assert.match(text, /- ACLS required/);
});

test("formatIcims returns null when no recognized container is present", () => {
  assert.equal(formatIcims("<html><body><p>no container</p></body></html>", ICIMS_JOB), null);
  assert.equal(formatIcims("", ICIMS_JOB), null);
});

test("iCIMS: cache miss fetches HTML, scrapes, and writes text", async () => {
  const { deps, written } = makeDeps({
    fetchFn: makeFetchFn({ [ICIMS_JOB.url]: { status: 200, html: ICIMS_DEFAULT_HTML } }),
  });
  const result = await fetchJd(ICIMS_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "fetched");
  assert.ok(result.text.includes("TITLE: Supply Chain Technician"));
  assert.ok(result.text.includes("Per Diem capacity"));
  const writtenPath = `${CACHE_DIR}/${cacheKey(ICIMS_JOB)}`;
  assert.equal(written[writtenPath], result.text);
});

test("iCIMS: 404 returns status=not_found", async () => {
  const { deps } = makeDeps({
    fetchFn: makeFetchFn({ [ICIMS_JOB.url]: { status: 404, html: "" } }),
  });
  const result = await fetchJd(ICIMS_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "not_found");
});

test("iCIMS: passes User-Agent header to fetchFn", async () => {
  let seenOpts = null;
  const { deps } = makeDeps({
    fetchFn: async (url, opts) => {
      seenOpts = opts;
      return {
        ok: true,
        status: 200,
        async text() {
          return ICIMS_DEFAULT_HTML;
        },
        async json() {
          return {};
        },
      };
    },
  });
  await fetchJd(ICIMS_JOB, CACHE_DIR, deps);
  assert.ok(seenOpts && seenOpts.headers && /Mozilla/.test(seenOpts.headers["User-Agent"]));
});

test("iCIMS: missing description container returns not_found", async () => {
  const { deps } = makeDeps({
    fetchFn: makeFetchFn({
      [ICIMS_JOB.url]: { status: 200, html: "<html><body><p>nothing</p></body></html>" },
    }),
  });
  const result = await fetchJd(ICIMS_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "not_found");
});

test("iCIMS: iframes-only container yields not_found (no header-only cache)", async () => {
  const html = `<div class="iCIMS_JobContent"><iframe src="x"></iframe></div><!-- /iCIMS_JobContent -->`;
  const { deps, written } = makeDeps({
    fetchFn: makeFetchFn({ [ICIMS_JOB.url]: { status: 200, html } }),
  });
  const result = await fetchJd(ICIMS_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "not_found");
  assert.equal(Object.keys(written).length, 0, "must not write cache for header-only payload");
});

// --- Taleo (Kaiser) ---------------------------------------------------------

const TALEO_JOB = {
  source: "taleo",
  slug: "kaiser-641",
  jobId: "94858333792",
  title: "Speech Therapist I, Pediatrics, Part Time 32 Hours",
  companyName: "Kaiser Permanente",
  url: "https://www.kaiserpermanentejobs.org/job/sacramento/speech-therapist-i-pediatrics-part-time-32-hours/641/94858333792",
  rawExtra: { scheduleHint: "Part-time", workSetting: "Onsite", shift: "Day" },
};

const TALEO_HTML_FULL = `<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"http://schema.org","@type":"JobPosting",
 "title":"Speech Therapist I, Pediatrics, Part Time 32 Hours",
 "datePosted":"2026-5-8",
 "identifier":"1422687",
 "employmentType":"Standard",
 "jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Sacramento","addressRegion":"CA","addressCountry":"US"}},
 "description":"<div><b>Job Summary:</b></div><p>Provides diagnosis and treatment of communication disorders.</p>",
 "qualifications":"<div><b>Basic Qualifications:</b></div><ul><li>Completion of CFY.</li></ul>"}
</script></head><body>
<section><div class="ats-description">
<div><b>Job Summary:</b></div><p>Provides diagnosis and treatment.</p>
</div></section></body></html>`;

test("formatTaleo: JSON-LD path produces TITLE / LOCATION / SCHEDULE / REQ ID + body", () => {
  const text = formatTaleo(TALEO_HTML_FULL, TALEO_JOB);
  assert.ok(text);
  assert.ok(text.startsWith("TITLE: Speech Therapist I"), `unexpected: ${text.slice(0, 80)}`);
  assert.ok(text.includes("LOCATION: Sacramento, CA, US"));
  // Adapter hint "Part-time" wins over JSON-LD "Standard"
  assert.ok(text.includes("SCHEDULE: Part-time"));
  assert.ok(text.includes("REQ ID: 1422687"));
  assert.ok(text.includes("Provides diagnosis"));
  assert.ok(text.includes("Basic Qualifications"));
});

test("formatTaleo: filters out useless employmentType:'Standard' when no listing hint", () => {
  const job = { ...TALEO_JOB, rawExtra: {} };
  const text = formatTaleo(TALEO_HTML_FULL, job);
  assert.ok(text);
  assert.ok(!/^SCHEDULE:/m.test(text), "Standard alone should not produce SCHEDULE line");
});

test("formatTaleo: prefers listing scheduleHint over JSON-LD employmentType", () => {
  // employmentType present and not "Standard", but the listing hint differs.
  const html = TALEO_HTML_FULL.replace(
    '"employmentType":"Standard"',
    '"employmentType":"Full-time"'
  );
  const job = { ...TALEO_JOB, rawExtra: { scheduleHint: "Per Diem" } };
  const text = formatTaleo(html, job);
  assert.ok(text.includes("SCHEDULE: Per Diem"));
  assert.ok(!text.includes("SCHEDULE: Full-time"));
});

test("formatTaleo: falls back to ats-description when JSON-LD missing", () => {
  const html = `<html><body>
<section><div class="ats-description">
<div><b>Job Summary:</b></div><p>Fallback body text.</p>
</div></section></body></html>`;
  const job = { ...TALEO_JOB, rawExtra: { scheduleHint: "Full-time" } };
  const text = formatTaleo(html, job);
  assert.ok(text);
  assert.ok(text.includes("TITLE: Speech Therapist I"));
  assert.ok(text.includes("SCHEDULE: Full-time"));
  assert.ok(text.includes("Fallback body text"));
});

test("formatTaleo: returns null when there's no body anywhere (no cache poison)", () => {
  const html = `<html><body><h1>nothing useful</h1></body></html>`;
  assert.equal(formatTaleo(html, TALEO_JOB), null);
});

test("formatTaleo: tolerates non-string / empty input", () => {
  assert.equal(formatTaleo("", TALEO_JOB), null);
  assert.equal(formatTaleo(null, TALEO_JOB), null);
});

test("extractJsonLdJob: returns the JobPosting payload when present", () => {
  const ld = extractJsonLdJob(TALEO_HTML_FULL);
  assert.ok(ld);
  assert.equal(ld["@type"], "JobPosting");
  assert.equal(ld.identifier, "1422687");
});

test("extractJsonLdJob: ignores non-JobPosting JSON-LD", () => {
  const html = `<script type="application/ld+json">{"@type":"Organization","name":"Kaiser"}</script>`;
  assert.equal(extractJsonLdJob(html), null);
});

test("extractJsonLdJob: handles array-shaped JSON-LD", () => {
  const html = `<script type="application/ld+json">[{"@type":"BreadcrumbList"},{"@type":"JobPosting","title":"X"}]</script>`;
  const ld = extractJsonLdJob(html);
  assert.ok(ld);
  assert.equal(ld.title, "X");
});

test("extractJsonLdJob: skips malformed JSON safely", () => {
  const html = `<script type="application/ld+json">{not valid json</script>`;
  assert.equal(extractJsonLdJob(html), null);
});

test("isAllowedTaleoHost: only kaiserpermanentejobs.org allowed", () => {
  assert.equal(isAllowedTaleoHost("www.kaiserpermanentejobs.org"), true);
  assert.equal(isAllowedTaleoHost("kp.taleo.net"), false);
  assert.equal(isAllowedTaleoHost("internal"), false);
});

test("Taleo: fetchJd writes cache on first call (status=fetched)", async () => {
  const { deps, written } = makeDeps({
    fetchFn: makeFetchFn({ [TALEO_JOB.url]: { status: 200, html: TALEO_HTML_FULL } }),
  });
  const result = await fetchJd(TALEO_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "fetched");
  assert.ok(result.text.includes("SCHEDULE: Part-time"));
  assert.ok(result.text.includes("Provides diagnosis"));
  assert.equal(written[`${CACHE_DIR}/${cacheKey(TALEO_JOB)}`], result.text);
});

test("Taleo: 404 returns status=not_found, no cache write", async () => {
  const { deps, written } = makeDeps({
    fetchFn: makeFetchFn({ [TALEO_JOB.url]: { status: 404, html: "" } }),
  });
  const result = await fetchJd(TALEO_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "not_found");
  assert.equal(Object.keys(written).length, 0);
});

test("Taleo: passes User-Agent header to fetchFn", async () => {
  let seenOpts = null;
  const { deps } = makeDeps({
    fetchFn: async (url, opts) => {
      seenOpts = opts;
      return {
        ok: true,
        status: 200,
        async text() {
          return TALEO_HTML_FULL;
        },
        async json() {
          return {};
        },
      };
    },
  });
  await fetchJd(TALEO_JOB, CACHE_DIR, deps);
  assert.ok(seenOpts && seenOpts.headers && /Mozilla/.test(seenOpts.headers["User-Agent"]));
});

test("Taleo: SSRF — non-allowed host returns not_found without fetching", async () => {
  let fetched = false;
  const badJob = { ...TALEO_JOB, url: "https://kp.taleo.net/careersection/external/x.ftl" };
  const { deps } = makeDeps({
    fetchFn: async () => {
      fetched = true;
      return {
        ok: true,
        status: 200,
        async text() {
          return TALEO_HTML_FULL;
        },
      };
    },
  });
  const result = await fetchJd(badJob, CACHE_DIR, deps);
  assert.equal(result.status, "not_found");
  assert.equal(fetched, false, "must short-circuit before network");
});

test("Taleo: SSRF — http:// (non-TLS) returns not_found", async () => {
  const badJob = { ...TALEO_JOB, url: "http://www.kaiserpermanentejobs.org/job/x/y/641/123" };
  let fetched = false;
  const { deps } = makeDeps({
    fetchFn: async () => {
      fetched = true;
      return {
        ok: true,
        status: 200,
        async text() {
          return TALEO_HTML_FULL;
        },
      };
    },
  });
  const result = await fetchJd(badJob, CACHE_DIR, deps);
  assert.equal(result.status, "not_found");
  assert.equal(fetched, false);
});

test("Taleo: missing job.url returns not_found", async () => {
  const badJob = { ...TALEO_JOB };
  delete badJob.url;
  const { deps } = makeDeps({
    fetchFn: async () => {
      throw new Error("nope");
    },
  });
  const result = await fetchJd(badJob, CACHE_DIR, deps);
  assert.equal(result.status, "not_found");
});

test("Taleo: empty HTML response returns not_found", async () => {
  const { deps } = makeDeps({
    fetchFn: makeFetchFn({ [TALEO_JOB.url]: { status: 200, html: "" } }),
  });
  const result = await fetchJd(TALEO_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "not_found");
});

test("Taleo: cache hit on second call (no second fetch)", async () => {
  const cachedText = "TITLE: Speech Therapist I\nSCHEDULE: Part-time\n\nBody.";
  const cachePath = `${CACHE_DIR}/${cacheKey(TALEO_JOB)}`;
  const { deps } = makeDeps({ existing: { [cachePath]: cachedText } });
  const result = await fetchJd(TALEO_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "cached");
  assert.equal(result.text, cachedText);
});

// --- Workable (BL-95) --------------------------------------------------------

const WORKABLE_JOB = {
  source: "workable",
  slug: "huggingface",
  jobId: "922D2C6549",
  title: "Cloud ML DevRel Engineer - EMEA remote",
  companyName: "Hugging Face",
  url: "https://apply.workable.com/j/922D2C6549",
  locations: ["Remote", "Paris, Île-de-France, France"],
  rawExtra: { telecommuting: true, employment_type: "Full-time" },
};
const WORKABLE_API_URL =
  "https://apply.workable.com/api/v1/accounts/huggingface/jobs/922D2C6549";

// Minimal record mirrored from a real recon probe on 2026-05-18 against
// apply.workable.com/api/v1/accounts/huggingface/jobs/922D2C6549. HTML
// snippets condensed for fixture readability — the real payload is
// ~5 KB; the structure (HTML strings in description/requirements/benefits)
// is reproduced verbatim.
const WORKABLE_API_PAYLOAD = {
  id: 5537738,
  shortcode: "922D2C6549",
  title: "Cloud ML DevRel Engineer - EMEA remote",
  remote: true,
  location: {
    country: "France",
    countryCode: "FR",
    city: "Paris",
    region: "Île-de-France",
  },
  state: "published",
  code: "HF-CLOUD-001",
  published: "2026-02-12T00:00:00.000Z",
  type: "full",
  language: "en",
  department: ["Revenue-Share"],
  workplace: "remote",
  description:
    "<p>At Hugging Face, we're on a journey to democratize good AI.</p>" +
    "<p><strong>About the Role</strong></p>" +
    "<p>You will grow the impact of the Hugging Face ML Cloud team.</p>",
  requirements:
    "<ul><li>5+ years of relevant experience</li>" +
    "<li>Deep familiarity with cloud platforms (AWS / GCP / Azure)</li></ul>",
  benefits:
    "<ul><li>Flexible remote work</li><li>Competitive compensation</li></ul>",
};

test("buildWorkableApiUrl builds api URL from slug + jobId", () => {
  assert.equal(buildWorkableApiUrl(WORKABLE_JOB), WORKABLE_API_URL);
});

test("buildWorkableApiUrl rejects malformed slug / jobId (SSRF guard)", () => {
  const bad = [
    { ...WORKABLE_JOB, slug: "evil/path" },
    { ...WORKABLE_JOB, slug: "" },
    { ...WORKABLE_JOB, jobId: "X Y" },
    { ...WORKABLE_JOB, jobId: "?evil=1" },
    { ...WORKABLE_JOB, jobId: "../../etc/passwd" },
    { ...WORKABLE_JOB, jobId: "" },
    { ...WORKABLE_JOB, slug: 123 },
  ];
  for (const job of bad) {
    assert.equal(buildWorkableApiUrl(job), null, `should reject ${JSON.stringify(job.slug)}/${JSON.stringify(job.jobId)}`);
  }
});

test("formatWorkable produces TITLE / LOCATION / SCHEDULE / REQ ID + stripped body", () => {
  const text = formatWorkable(WORKABLE_API_PAYLOAD, WORKABLE_JOB);
  assert.ok(text);
  assert.match(text, /^TITLE: Cloud ML DevRel Engineer/m);
  assert.match(text, /^LOCATION: Paris, Île-de-France, France/m);
  assert.match(text, /^SCHEDULE: Full-time · Remote/m);
  assert.match(text, /^REQ ID: HF-CLOUD-001/m);
  assert.match(text, /democratize good AI/);
  // Requirements section is present and bullets are converted by stripHtml.
  assert.match(text, /Requirements:/);
  assert.match(text, /- 5\+ years/);
  assert.match(text, /Benefits:/);
  assert.match(text, /- Flexible remote work/);
});

test("formatWorkable returns null when description/requirements/benefits all empty", () => {
  const data = { title: "X", type: "full", workplace: "remote" };
  assert.equal(
    formatWorkable(data, WORKABLE_JOB),
    null,
    "header-only payload must not poison the cache"
  );
});

test("formatWorkable: missing schedule fields → no SCHEDULE line", () => {
  const data = {
    title: "X",
    description: "<p>Body text.</p>",
  };
  const text = formatWorkable(data, WORKABLE_JOB);
  assert.ok(text);
  assert.ok(!/^SCHEDULE:/m.test(text));
});

test("formatWorkable: tolerates non-object input", () => {
  assert.equal(formatWorkable(null, WORKABLE_JOB), null);
  assert.equal(formatWorkable("string", WORKABLE_JOB), null);
});

test("Workable: cache miss fetches JSON, formats, and writes text", async () => {
  const { deps, written } = makeDeps({
    fetchFn: makeFetchFn({ [WORKABLE_API_URL]: { status: 200, body: WORKABLE_API_PAYLOAD } }),
  });
  const result = await fetchJd(WORKABLE_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "fetched");
  assert.ok(result.text.includes("TITLE: Cloud ML DevRel Engineer"));
  assert.ok(result.text.includes("SCHEDULE: Full-time · Remote"));
  assert.ok(result.text.includes("democratize good AI"));
  const writtenPath = `${CACHE_DIR}/${cacheKey(WORKABLE_JOB)}`;
  assert.equal(written[writtenPath], result.text);
});

test("Workable: 404 returns status=not_found, no cache write", async () => {
  const { deps, written } = makeDeps({
    fetchFn: makeFetchFn({ [WORKABLE_API_URL]: { status: 404, body: {} } }),
  });
  const result = await fetchJd(WORKABLE_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "not_found");
  assert.equal(Object.keys(written).length, 0);
});

test("Workable: empty payload returns not_found (no header-only cache)", async () => {
  const { deps, written } = makeDeps({
    fetchFn: makeFetchFn({
      [WORKABLE_API_URL]: { status: 200, body: { title: "X", type: "full", workplace: "remote" } },
    }),
  });
  const result = await fetchJd(WORKABLE_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "not_found");
  assert.equal(Object.keys(written).length, 0);
});

test("Workable: malformed jobId short-circuits to not_found (no fetch)", async () => {
  let fetched = false;
  const { deps } = makeDeps({
    fetchFn: async () => {
      fetched = true;
      return { ok: true, status: 200, async json() {}, async text() {} };
    },
  });
  const badJob = { ...WORKABLE_JOB, jobId: "../../evil" };
  const result = await fetchJd(badJob, CACHE_DIR, deps);
  assert.equal(result.status, "not_found");
  assert.equal(fetched, false, "fetchFn must not be called for unsafe jobId");
});

test("Workable: passes User-Agent header to fetchFn", async () => {
  let seenOpts = null;
  const { deps } = makeDeps({
    fetchFn: async (url, opts) => {
      seenOpts = opts;
      return {
        ok: true,
        status: 200,
        async json() {
          return WORKABLE_API_PAYLOAD;
        },
      };
    },
  });
  await fetchJd(WORKABLE_JOB, CACHE_DIR, deps);
  assert.ok(seenOpts && seenOpts.headers && /Mozilla/.test(seenOpts.headers["User-Agent"]));
});

test("Workable: cache hit on second call (no second fetch)", async () => {
  const cachedText = "TITLE: Cloud ML DevRel\nSCHEDULE: Full-time · Remote\n\nBody.";
  const cachePath = `${CACHE_DIR}/${cacheKey(WORKABLE_JOB)}`;
  const { deps } = makeDeps({ existing: { [cachePath]: cachedText } });
  const result = await fetchJd(WORKABLE_JOB, CACHE_DIR, deps);
  assert.equal(result.status, "cached");
  assert.equal(result.text, cachedText);
});

// --- Adapter ↔ jd_cache coverage (BL-96) ------------------------------------
//
// Enumerate every discovery adapter file (excluding helpers / tests) and
// assert each `source` is either in `SUPPORTED` (has a JD fetcher) or in
// `JD_UNSUPPORTED` (explicitly opted out with a reason). Adding a new
// adapter without considering JD-cache wiring will fail this test.
test("adapter ↔ jd_cache coverage: every discovery source is either SUPPORTED or JD_UNSUPPORTED", () => {
  const DISCOVERY_DIR = path.resolve(__dirname, "..", "modules", "discovery");
  const files = fs
    .readdirSync(DISCOVERY_DIR)
    .filter((name) => name.endsWith(".js"))
    .filter((name) => !name.startsWith("_"))
    .filter((name) => !name.endsWith(".test.js"))
    .filter((name) => name !== "index.js");

  const sources = [];
  for (const file of files) {
    const mod = require(path.join(DISCOVERY_DIR, file));
    assert.ok(
      typeof mod.source === "string" && mod.source,
      `${file}: adapter must export a non-empty "source" string`
    );
    sources.push({ file, source: mod.source });
  }
  assert.ok(sources.length > 0, "expected at least one discovery adapter");

  const missing = [];
  for (const { file, source } of sources) {
    const hasFetcher = SUPPORTED.has(source);
    const isExempt = JD_UNSUPPORTED.has(source);
    if (!hasFetcher && !isExempt) {
      missing.push({ file, source });
    }
    // Sanity: no source should be in BOTH sets — exempt means "no fetcher
    // by design", supported means "fetcher present". Conflict signals a
    // bug in jd_cache.js.
    assert.ok(
      !(hasFetcher && isExempt),
      `source "${source}" cannot be both SUPPORTED and JD_UNSUPPORTED`
    );
  }
  assert.deepEqual(
    missing,
    [],
    `discovery adapter(s) missing from jd_cache wiring — add to SUPPORTED (with fetcher) or JD_UNSUPPORTED (with reason): ${JSON.stringify(missing)}`
  );
});

test("JD_UNSUPPORTED reasons are non-empty strings", () => {
  for (const [source, reason] of JD_UNSUPPORTED) {
    assert.equal(typeof reason, "string", `${source} reason must be a string`);
    assert.ok(reason.length >= 10, `${source} reason too short: ${JSON.stringify(reason)}`);
  }
});

test("SUPPORTED and JD_UNSUPPORTED are disjoint", () => {
  for (const source of SUPPORTED) {
    assert.ok(
      !JD_UNSUPPORTED.has(source),
      `source "${source}" appears in both SUPPORTED and JD_UNSUPPORTED`
    );
  }
});
