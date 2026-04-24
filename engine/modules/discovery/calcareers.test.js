const { test } = require("node:test");
const assert = require("node:assert/strict");

const calcareers = require("./calcareers.js");
const { assertJob } = require("./_types.js");

const SEARCH_URL = "https://calcareers.ca.gov/CalHRPublic/Search/JobSearchResults.aspx";

function htmlShell({ total = 0, rows = "", viewstate = "vs1", eventval = "ev1" } = {}) {
  return `
    <html><body>
      <input name="__VIEWSTATE" value="${viewstate}" />
      <input name="__VIEWSTATEGENERATOR" value="g1" />
      <input name="__EVENTVALIDATION" value="${eventval}" />
      <span id="ResultCount">${total}</span>
      ${rows}
    </body></html>
  `;
}

function jobAnchor(i, { title = "IT Manager II", dept = "CDT" } = {}) {
  return `
    <a id="cphMainContent_rptResults_hlViewJobPosting_${i}" href="/CalHRPublic/JobPosting.aspx?JobControlId=${500000 + i}">${title}</a>
    <span>Working Title: Senior PM ${i}</span>
    <span>Job Control: ${500000 + i}</span>
    <span>Salary Range: $10,000 - $12,000</span>
    <span>Work Type/Schedule: Full Time / Permanent</span>
    <span>Department: ${dept}</span>
    <span>Location: Sacramento</span>
    <span>Telework: Remote available</span>
    <span>Publish Date: 4/15/2026</span>
    <span>Filing Deadline: 5/1/2026 View Job Posting</span>
  `;
}

function pagerButtons(pages) {
  let html = "";
  for (let i = 0; i < pages; i += 1) {
    const idx = String(i).padStart(2, "0");
    html += `<a id="cphMainContent_ucRepeaterPager_rptPager_ctl${idx}_btnPagerItem">${i + 1}</a>`;
  }
  return html;
}

function makeFetch(script, recorded = []) {
  let step = 0;
  return async function (url, opts = {}) {
    const body = opts.body || null;
    recorded.push({ url, method: opts.method || "GET", body });
    const entry = script[step];
    step += 1;
    if (!entry) throw new Error(`no response scripted for step ${step}`);
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      headers: {
        getSetCookie: () => entry.cookies || ["ASP.NET_SessionId=abc; path=/"],
      },
      async text() {
        return entry.html || "";
      },
    };
  };
}

test("calcareers.discover scrapes a single keyword with rowCount switch", async () => {
  const recorded = [];
  const script = [
    { status: 200, html: htmlShell({ total: 0 }) }, // initial GET
    {
      status: 200,
      html: htmlShell({
        total: 25,
        rows: jobAnchor(1) + jobAnchor(2) + pagerButtons(1),
      }),
    }, // keyword POST
    {
      status: 200,
      html: htmlShell({
        total: 25,
        rows: jobAnchor(1) + jobAnchor(2) + jobAnchor(3) + pagerButtons(1),
      }),
    }, // dense rowCount POST
  ];
  const fetchFn = makeFetch(script, recorded);

  const jobs = await calcareers.discover(
    [{ name: "CalCareers", slug: "itm", keyword: "information technology manager" }],
    { fetchFn, stepDelayMs: 0, keywordDelayMs: 0 }
  );
  assert.equal(jobs.length, 3);
  for (const j of jobs) assertJob(j);

  const [j1] = jobs;
  assert.equal(j1.source, "calcareers");
  assert.equal(j1.jobId, "500001");
  assert.equal(j1.title, "Senior PM 1");
  assert.equal(j1.companyName, "CDT");
  assert.equal(j1.postedAt, "2026-04-15");
  assert.equal(j1.rawExtra.finalFilingDate, "5/1/2026");
  assert.deepEqual(j1.locations, ["Sacramento"]);
  assert.equal(recorded.length, 3);
  assert.equal(recorded[0].method, "GET");
  assert.equal(recorded[1].method, "POST");
  assert.match(recorded[1].body, /btnUpdateResults/);
  assert.match(recorded[2].body, /ddlRowCount=100/);
});

test("calcareers.discover dedupes across pages by jobControlId", async () => {
  const script = [
    { status: 200, html: htmlShell() }, // GET
    {
      status: 200,
      html: htmlShell({ total: 150, rows: jobAnchor(1) + pagerButtons(2) }),
    }, // keyword POST
    {
      status: 200,
      html: htmlShell({
        total: 150,
        rows: jobAnchor(1) + jobAnchor(2) + pagerButtons(2),
      }),
    }, // rowCount switch
    {
      status: 200,
      html: htmlShell({
        total: 150,
        rows: jobAnchor(2) + jobAnchor(3) + pagerButtons(2),
      }),
    }, // page 2
  ];
  const fetchFn = makeFetch(script);
  const jobs = await calcareers.discover(
    [{ name: "x", slug: "x", keyword: "kw" }],
    { fetchFn, stepDelayMs: 0, keywordDelayMs: 0 }
  );
  const ids = jobs.map((j) => j.jobId).sort();
  assert.deepEqual(ids, ["500001", "500002", "500003"]);
});

test("calcareers.discover warns when ResultCount marker is missing but rows exist", async () => {
  const script = [
    { status: 200, html: htmlShell() }, // GET
    // Keyword POST — no ResultCount marker in HTML, but anchors are present.
    {
      status: 200,
      html: `
        <html><body>
          <input name="__VIEWSTATE" value="vs1" />
          <input name="__VIEWSTATEGENERATOR" value="g1" />
          <input name="__EVENTVALIDATION" value="ev1" />
          ${jobAnchor(1)}${jobAnchor(2)}${pagerButtons(1)}
        </body></html>
      `,
    },
  ];
  const fetchFn = makeFetch(script);
  const logs = [];
  const jobs = await calcareers.discover(
    [{ name: "x", slug: "x", keyword: "kw" }],
    { fetchFn, stepDelayMs: 0, keywordDelayMs: 0, logger: { warn: (m) => logs.push(m) } }
  );
  assert.equal(jobs.length, 2);
  assert.ok(logs.some((m) => m.includes("ResultCount marker missing")));
});

test("calcareers.discover surfaces errors via logger (no viewstate)", async () => {
  const script = [{ status: 200, html: "<html>no viewstate here</html>" }];
  const fetchFn = makeFetch(script);
  const logs = [];
  const jobs = await calcareers.discover(
    [{ name: "x", slug: "x", keyword: "kw" }],
    { fetchFn, logger: { warn: (m) => logs.push(m) } }
  );
  assert.deepEqual(jobs, []);
  assert.match(logs[0], /no viewstate/);
});
