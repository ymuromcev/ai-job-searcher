const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  atsFromSource,
  cleanJobId,
  buildSlugIndex,
  findSlug,
  slugFromUrl,
  canonicalFormUrl,
  postingApiUrl,
  checkPostingOpen,
} = require("./canonical_url.js");
const { resolveViaPage } = require("./resolve_url.js");
const { detectAts } = require("./index.js");

const UUID = "0f0f0f0f-1111-4222-8333-444444444444";
const INDEX = buildSlugIndex([
  { name: "Samsara", source: "greenhouse", slug: "samsara" },
  { name: "Navan", source: "greenhouse", slug: "tripactions" },
  { name: "Hippo Insurance", source: "greenhouse", slug: "hippo70" },
  { name: "Acme, Inc.", source: "lever", slug: "acme" },
  { name: "Acme, Inc.", source: "ashby", slug: "acme-ashby" },
  { name: "Broken", source: "manual", slug: "" },
]);

test("atsFromSource / cleanJobId", () => {
  assert.equal(atsFromSource("Greenhouse"), "greenhouse");
  assert.equal(atsFromSource(" lever "), "lever");
  assert.equal(atsFromSource("adzuna"), null);
  assert.equal(cleanJobId("gh:8010057"), "8010057");
  assert.equal(cleanJobId("greenhouse:gh:8010057"), "8010057");
  assert.equal(cleanJobId(`lever:${UUID}`), UUID);
});

test("findSlug: normalized company name, same ATS only", () => {
  assert.equal(findSlug(INDEX, "samsara", "greenhouse"), "samsara");
  assert.equal(findSlug(INDEX, "Acme Inc", "lever"), "acme");
  assert.equal(findSlug(INDEX, "Acme", "ashby"), "acme-ashby");
  assert.equal(findSlug(INDEX, "Samsara", "lever"), null);
  assert.equal(findSlug(INDEX, "Unknown Co", "greenhouse"), null);
});

test("canonicalFormUrl: the real failing career-page rows", () => {
  const cases = [
    [
      "Samsara",
      "8017174",
      "https://www.samsara.com/company/careers/roles/8017174?gh_jid=8017174",
      "samsara",
    ],
    ["Navan", "gh:8010057", "https://navan.com/careers/openings?gh_jid=8010057", "tripactions"],
    [
      "Hippo Insurance",
      "8588582002",
      "https://boards.greenhouse.io/hippo70/jobs/8588582002?gh_jid=8588582002",
      "hippo70",
    ],
  ];
  for (const [companyName, jobId, url, slug] of cases) {
    const c = canonicalFormUrl({ source: "greenhouse", jobId, companyName, url }, INDEX);
    const id = jobId.replace(/^gh:/, "");
    assert.equal(c.url, `https://job-boards.greenhouse.io/embed/job_app?for=${slug}&token=${id}`);
    assert.equal(c.slugSource, "companies_tsv");
  }
});

test("canonicalFormUrl: lever / ashby / slug from the row URL / not applicable", () => {
  assert.equal(
    canonicalFormUrl({ source: "lever", jobId: UUID, companyName: "Acme Inc." }, INDEX).url,
    `https://jobs.lever.co/acme/${UUID}/apply`
  );
  assert.equal(
    canonicalFormUrl({ source: "Ashby", jobId: UUID, companyName: "Acme" }, INDEX).url,
    `https://jobs.ashbyhq.com/acme-ashby/${UUID}/application`
  );
  // Company missing from companies.tsv, but the row URL is on the board.
  const fromUrl = canonicalFormUrl(
    {
      source: "greenhouse",
      jobId: "7968044",
      companyName: "Robinhood",
      url: "https://boards.greenhouse.io/robinhood/jobs/7968044?t=gh_src=&gh_jid=7968044",
    },
    INDEX
  );
  assert.equal(fromUrl.slug, "robinhood");
  assert.equal(fromUrl.slugSource, "row_url");
  assert.equal(
    canonicalFormUrl({ source: "adzuna", jobId: "1", companyName: "Samsara" }, INDEX),
    null
  );
  assert.equal(
    canonicalFormUrl({ source: "greenhouse", jobId: "", companyName: "Samsara" }, INDEX),
    null
  );
  assert.equal(
    canonicalFormUrl({ source: "greenhouse", jobId: "abc", companyName: "Samsara" }, INDEX),
    null
  );
  assert.equal(
    canonicalFormUrl({ source: "lever", jobId: "123", companyName: "Acme" }, INDEX),
    null
  );
  assert.equal(
    canonicalFormUrl(
      {
        source: "greenhouse",
        jobId: "1",
        companyName: "Nobody",
        url: "https://x.example/?gh_jid=1",
      },
      INDEX
    ),
    null
  );
  // The canonical URL is something the registry recognizes.
  assert.equal(
    detectAts(
      canonicalFormUrl({ source: "greenhouse", jobId: "1", companyName: "Samsara" }, INDEX).url
    ),
    "greenhouse"
  );
});

test("slugFromUrl", () => {
  assert.equal(
    slugFromUrl("https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1", "greenhouse"),
    "acme"
  );
  assert.equal(slugFromUrl(`https://jobs.lever.co/acme/${UUID}`, "lever"), "acme");
  assert.equal(slugFromUrl(`https://jobs.ashbyhq.com/acme/${UUID}`, "ashby"), "acme");
  assert.equal(slugFromUrl("https://acme.example/jobs/1", "greenhouse"), null);
  assert.equal(slugFromUrl("nope", "lever"), null);
});

function fetchReturning(status, calls) {
  return async (url) => {
    calls.push(url);
    if (status === "throw") throw new Error("ECONNRESET");
    return { status };
  };
}

test("checkPostingOpen: posting APIs, 404 = closed, anything odd = unknown", async () => {
  const calls = [];
  const gh = { ats: "greenhouse", slug: "samsara", jobId: "8017174" };
  const lv = { ats: "lever", slug: "acme", jobId: UUID };
  assert.equal(await checkPostingOpen(gh, fetchReturning(200, calls)), "open");
  assert.equal(await checkPostingOpen(gh, fetchReturning(404, calls)), "closed");
  assert.equal(await checkPostingOpen(lv, fetchReturning(404, calls)), "closed");
  assert.equal(await checkPostingOpen(lv, fetchReturning(410, calls)), "closed");
  assert.equal(await checkPostingOpen(gh, fetchReturning(500, calls)), "unknown");
  assert.equal(await checkPostingOpen(gh, fetchReturning(429, calls)), "unknown");
  assert.equal(await checkPostingOpen(gh, fetchReturning("throw", calls)), "unknown");
  assert.equal(calls[0], "https://boards-api.greenhouse.io/v1/boards/samsara/jobs/8017174");
  assert.equal(calls[2], `https://api.lever.co/v0/postings/acme/${UUID}`);
  // Ashby has no per-posting endpoint: never fetched, the page decides.
  const before = calls.length;
  assert.equal(
    await checkPostingOpen({ ats: "ashby", slug: "a", jobId: UUID }, fetchReturning(404, calls)),
    "unknown"
  );
  assert.equal(calls.length, before);
  assert.equal(postingApiUrl({ ats: "ashby", slug: "a", jobId: UUID }), null);
});

function fakePage({ finalUrl, status = 200, html = "", throws = null }) {
  let current = "";
  return {
    goto: async (url) => {
      if (throws) throw new Error(throws);
      current = finalUrl || url;
      return { status: () => status };
    },
    url: () => current,
    content: async () => html,
  };
}

test("resolveViaPage: browser redirect, outbound link, blocked, employer page", async () => {
  const gh = "https://job-boards.greenhouse.io/acme/jobs/123";
  const opts = { detectAts, settleMs: 0 };
  const r1 = await resolveViaPage(
    fakePage({ finalUrl: gh }),
    "https://www.adzuna.com/land/ad/1",
    opts
  );
  assert.equal(r1.ok, true);
  assert.equal(r1.ats, "greenhouse");
  const r2 = await resolveViaPage(
    fakePage({
      finalUrl: "https://www.adzuna.com/details/1",
      html: `<a href="https://jobs.lever.co/acme/${UUID}">Apply</a>`,
    }),
    "https://www.adzuna.com/land/ad/1",
    opts
  );
  assert.equal(r2.ats, "lever");
  const r3 = await resolveViaPage(
    fakePage({ status: 403, html: "<title>Access Denied</title>" }),
    "https://www.adzuna.com/land/ad/1",
    opts
  );
  assert.equal(r3.reason, "blocked");
  const r4 = await resolveViaPage(
    fakePage({ finalUrl: "https://careers.acme.example/job/9", html: "<p>Apply</p>" }),
    "https://www.adzuna.com/land/ad/1",
    opts
  );
  assert.equal(r4.reason, "no_ats");
  assert.equal(r4.url, "https://careers.acme.example/job/9");
  const r5 = await resolveViaPage(
    fakePage({ throws: "net::ERR" }),
    "https://www.adzuna.com/land/ad/1",
    opts
  );
  assert.equal(r5.reason, "fetch_error");
  assert.equal(
    (await resolveViaPage(fakePage({}), "http://127.0.0.1/", opts)).reason,
    "unsafe_url"
  );
});

test("resolveViaPage: 404 on the same page is dead, 404 that redirects in-page is not", async () => {
  const opts = { detectAts, settleMs: 0 };
  const land = "https://www.adzuna.com/land/ad/5749252312?se=x";
  const dead = await resolveViaPage(
    fakePage({ status: 404, html: "<title>Page not found - adzuna.com</title>" }),
    land,
    opts
  );
  assert.equal(dead.reason, "dead");
  const deadByTitle = await resolveViaPage(
    fakePage({
      finalUrl: "https://www.adzuna.com/search",
      status: 404,
      html: "<title>Page not found</title>",
    }),
    land,
    opts
  );
  assert.equal(deadByTitle.reason, "dead");
  const live = await resolveViaPage(
    fakePage({
      finalUrl: "https://www.adzuna.com/details/5850461353?se=x",
      status: 404,
      html: "<title>Solutions Engineer Job in Iselin, NJ</title>",
    }),
    land,
    opts
  );
  assert.equal(live.reason, "no_ats");
  assert.equal(live.url, "https://www.adzuna.com/details/5850461353?se=x");
});
