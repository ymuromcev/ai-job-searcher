// RFC 069 §5: aggregator rows (Adzuna) → the same job on the company's own
// Greenhouse / Lever / Ashby board. All network is faked.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveUrl,
  findCompanyForm,
  guessSlugs,
  boardCandidates,
  titleMatches,
  pickBoardMatch,
  isAggregatorUrl,
} = require("./resolve_url.js");
const { buildSlugIndex } = require("./canonical_url.js");
const { detectAts } = require("./index.js");

// Board API fake: url → JSON body (status 200) or a number (that status).
// Unknown URLs answer 404, like a wrong board slug.
function fakeBoards(routes, pages = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (Object.prototype.hasOwnProperty.call(pages, url)) {
      return { ok: true, status: 200, url, text: async () => pages[url] };
    }
    const r = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : 404;
    if (typeof r === "number") {
      return { ok: false, status: r, url, json: async () => ({}), text: async () => "" };
    }
    return { ok: true, status: 200, url, json: async () => r, text: async () => "" };
  };
  fn.calls = calls;
  return fn;
}

const GH_API = (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
const LEVER_API = (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`;
const ASHBY_API = (slug) =>
  `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
const LEVER_ID = "0f0f0f0f-1111-4222-8333-444444444444";
const ADZUNA = "https://www.adzuna.com/land/ad/123?se=x";
const GH = "https://job-boards.greenhouse.io/acmesynthetic/jobs/1234567";

test("isAggregatorUrl: aggregators yes, ATS and short links no", () => {
  assert.equal(isAggregatorUrl(ADZUNA), true);
  assert.equal(isAggregatorUrl("https://www.indeed.com/viewjob?jk=1"), true);
  assert.equal(isAggregatorUrl(GH), false);
  assert.equal(isAggregatorUrl("https://grnh.se/abc"), false);
});

test("guessSlugs / boardCandidates: known slug first, then guesses on every ATS", () => {
  assert.deepEqual(guessSlugs("Acme Synthetic, Inc."), ["acmesynthetic", "acme-synthetic"]);
  assert.deepEqual(guessSlugs("Globex"), ["globex"]);
  assert.deepEqual(guessSlugs(""), []);
  const index = buildSlugIndex([{ name: "Acme Synthetic", source: "ashby", slug: "acme-ai" }]);
  const c = boardCandidates("Acme Synthetic Inc", index);
  assert.deepEqual(c[0], { ats: "ashby", slug: "acme-ai" });
  assert.deepEqual(
    c.slice(1, 4).map((x) => x.ats),
    ["greenhouse", "lever", "ashby"]
  );
  assert.equal(c.length, 7);
});

test("titleMatches: punctuation, Sr., (Remote) — but not a different role", () => {
  assert.equal(
    titleMatches("Sr. Product Manager - Growth", "Senior Product Manager, Growth"),
    true
  );
  assert.equal(titleMatches("Product Manager (Remote)", "Product Manager"), true);
  assert.equal(titleMatches("Product Manager", "Senior Product Manager"), false);
  assert.equal(titleMatches("", ""), false);
});

test("pickBoardMatch: location breaks ties and vetoes another city", () => {
  const jobs = [
    { jobId: "1", title: "Product Manager", locations: ["New York, NY"] },
    { jobId: "2", title: "Product Manager", locations: ["Austin, TX"] },
  ];
  const pm = (locations) => ({ title: "Product Manager", locations });
  assert.equal(pickBoardMatch(jobs, pm(["Austin, TX"])).jobId, "2");
  assert.equal(pickBoardMatch(jobs, pm([])).jobId, "1");
  assert.equal(pickBoardMatch(jobs.slice(0, 1), pm(["Austin, TX"])), null);
  // Remote on the board side never vetoes.
  const remote = [{ jobId: "3", title: "Product Manager", locations: ["Remote - US"] }];
  assert.equal(pickBoardMatch(remote, pm(["Austin, TX"])).jobId, "3");
  // A state-only row location is not a concrete city: no veto.
  assert.equal(pickBoardMatch(jobs.slice(0, 1), pm(["California"])).jobId, "1");
});

test("findCompanyForm: guessed Lever slug, matched title → canonical Lever form", async () => {
  const fetchFn = fakeBoards({
    [LEVER_API("acmesynthetic")]: [
      {
        id: "aaaaaaaa-1111-4222-8333-444444444444",
        text: "Data Analyst",
        categories: {},
        hostedUrl: "https://jobs.lever.co/acmesynthetic/a",
      },
      {
        id: LEVER_ID,
        text: "Senior Product Manager, Growth",
        categories: { location: "San Francisco, CA" },
        hostedUrl: `https://jobs.lever.co/acmesynthetic/${LEVER_ID}`,
      },
    ],
  });
  const r = await findCompanyForm(
    {
      company: "Acme Synthetic",
      title: "Sr Product Manager - Growth",
      locations: ["San Francisco, CA"],
    },
    { fetchFn }
  );
  assert.equal(r.ok, true);
  assert.equal(r.ats, "lever");
  assert.equal(r.url, `https://jobs.lever.co/acmesynthetic/${LEVER_ID}/apply`);
  assert.deepEqual(r.tried, ["greenhouse:acmesynthetic", "lever:acmesynthetic"]);
  assert.deepEqual(fetchFn.calls, [GH_API("acmesynthetic"), LEVER_API("acmesynthetic")]);
});

test("findCompanyForm: slug known in companies.tsv is tried first (Greenhouse embed form)", async () => {
  const fetchFn = fakeBoards({
    [GH_API("acme-real")]: {
      jobs: [
        {
          id: 555,
          title: "Product Manager",
          location: { name: "Remote" },
          absolute_url: "https://x.example/555",
        },
      ],
    },
  });
  const slugIndex = buildSlugIndex([
    { name: "Acme Synthetic", source: "greenhouse", slug: "acme-real" },
  ]);
  const r = await findCompanyForm(
    { companyName: "Acme Synthetic", title: "Product Manager", locations: ["Remote"] },
    { fetchFn, slugIndex }
  );
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://job-boards.greenhouse.io/embed/job_app?for=acme-real&token=555");
  assert.equal(fetchFn.calls.length, 1);
});

test("findCompanyForm: no board has the title → no_company_form", async () => {
  const fetchFn = fakeBoards({
    [ASHBY_API("globex")]: {
      jobs: [{ id: LEVER_ID, title: "Staff Engineer", jobUrl: "https://x.example/se" }],
    },
  });
  const r = await findCompanyForm({ company: "Globex", title: "Product Manager" }, { fetchFn });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_company_form");
  assert.deepEqual(r.tried, ["greenhouse:globex", "lever:globex", "ashby:globex"]);
});

test("findCompanyForm: a board fetch that throws is a miss, not a crash", async () => {
  const fetchFn = async () => {
    throw new Error("socket hang up");
  };
  const r = await findCompanyForm({ company: "Globex", title: "Product Manager" }, { fetchFn });
  assert.equal(r.reason, "no_company_form");
});

test("resolveUrl with job: Adzuna row found on the company board, no aggregator fetch", async () => {
  const fetchFn = fakeBoards({
    [GH_API("globex")]: {
      jobs: [{ id: 42, title: "Product Manager", absolute_url: "https://x.example/42" }],
    },
  });
  const r = await resolveUrl(ADZUNA, {
    fetchFn,
    detectAts,
    job: { company: "Globex", title: "Product Manager", locations: [] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.via, "company_board");
  assert.equal(r.ats, "greenhouse");
  assert.equal(r.url, "https://job-boards.greenhouse.io/embed/job_app?for=globex&token=42");
  assert.ok(!fetchFn.calls.includes(ADZUNA));
});

test("resolveUrl with job: no board match, aggregator has no ATS link → no_company_form", async () => {
  const fetchFn = fakeBoards({}, { [ADZUNA]: "<p>listing</p>" });
  const r = await resolveUrl(ADZUNA, {
    fetchFn,
    detectAts,
    job: { company: "Globex", title: "Product Manager" },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_company_form");
  assert.equal(r.redirect_reason, "no_ats");
});

test("resolveUrl with job: no board match but the aggregator links to the ATS → that ATS", async () => {
  const lever = `https://jobs.lever.co/globex-labs/${LEVER_ID}`;
  const fetchFn = fakeBoards({}, { [ADZUNA]: `<a href="${lever}">Apply</a>` });
  const r = await resolveUrl(ADZUNA, {
    fetchFn,
    detectAts,
    job: { company: "Globex", title: "Product Manager" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.ats, "lever");
});

test("resolveUrl without job keeps the RFC 068 behaviour for aggregators", async () => {
  const fetchFn = fakeBoards({}, { [ADZUNA]: "<p>x</p>" });
  const r = await resolveUrl(ADZUNA, { fetchFn, detectAts });
  assert.equal(r.reason, "no_ats");
  assert.deepEqual(fetchFn.calls, [ADZUNA]);
});

test("resolveUrl with job on a non-aggregator URL skips the board lookup", async () => {
  const fetchFn = fakeBoards({});
  const r = await resolveUrl(GH, {
    fetchFn,
    detectAts,
    job: { company: "Acme", title: "Product Manager" },
  });
  assert.equal(r.ok, true);
  assert.equal(fetchFn.calls.length, 0);
});
