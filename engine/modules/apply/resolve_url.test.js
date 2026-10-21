const { test } = require("node:test");
const assert = require("node:assert/strict");

const { resolveUrl, findHtmlHop, greenhouseFromEmbed } = require("./resolve_url.js");
const { detectAts } = require("./index.js");

// Fake fetch: map of url → { status, url (final after redirects), body }.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = routes[url];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    if (r.throws) throw new Error(r.throws);
    return { status: r.status || 200, url: r.url || url, text: async () => r.body || "" };
  };
  fn.calls = calls;
  return fn;
}

const GH = "https://job-boards.greenhouse.io/acmesynthetic/jobs/1234567";

test("direct ATS URL resolves without fetching", async () => {
  const fetchFn = fakeFetch({});
  const r = await resolveUrl(GH, { fetchFn, detectAts });
  assert.equal(r.ok, true);
  assert.equal(r.ats, "greenhouse");
  assert.equal(fetchFn.calls.length, 0);
});

test("short link redirect (grnh.se style) → ATS", async () => {
  const fetchFn = fakeFetch({ "https://grnh.se/abc": { status: 200, url: GH } });
  const r = await resolveUrl("https://grnh.se/abc", { fetchFn, detectAts });
  assert.equal(r.ok, true);
  assert.equal(r.url, GH);
  assert.equal(r.ats, "greenhouse");
  assert.equal(fetchFn.calls[0].opts.redirect, "follow");
});

test("aggregator page with an outbound ATS link (Adzuna style)", async () => {
  const lever = "https://jobs.lever.co/acmesynthetic/0f0f0f0f-1111-4222-8333-444444444444";
  const fetchFn = fakeFetch({
    "https://www.adzuna.com/land/ad/1?se=x": {
      status: 200,
      url: "https://www.adzuna.com/details/1",
      body: `<html><a class="apply" href="${lever}?lever-source=adzuna">Apply</a></html>`,
    },
  });
  const r = await resolveUrl("https://www.adzuna.com/land/ad/1?se=x", { fetchFn, detectAts });
  assert.equal(r.ok, true);
  assert.equal(r.ats, "lever");
  assert.match(r.url, /^https:\/\/jobs\.lever\.co\/acmesynthetic\//);
});

test("meta refresh hop, then redirect to Ashby", async () => {
  const ashby = "https://jobs.ashbyhq.com/acmesynthetic/0f0f0f0f-1111-4222-8333-444444444444";
  const fetchFn = fakeFetch({
    "https://news.example.com/t/1": {
      body: '<meta http-equiv="refresh" content="0; url=https://click.example.com/r/2">',
    },
    "https://click.example.com/r/2": { status: 200, url: ashby },
  });
  const r = await resolveUrl("https://news.example.com/t/1", { fetchFn, detectAts });
  assert.equal(r.ok, true);
  assert.equal(r.ats, "ashby");
  assert.deepEqual(r.hops.slice(0, 2), [
    "https://news.example.com/t/1",
    "https://click.example.com/r/2",
  ]);
});

test("company career page with gh_jid → Greenhouse board URL from the embed script", async () => {
  const page = "https://acme.example.com/careers/jobs/1234567?gh_jid=1234567";
  const fetchFn = fakeFetch({
    [page]: {
      body: '<script src="https://boards.greenhouse.io/embed/job_board/js?for=acmesynthetic"></script>',
    },
  });
  const r = await resolveUrl(page, { fetchFn, detectAts });
  assert.equal(r.ok, true);
  assert.equal(r.url, GH);
});

test("dead posting: 404, or bounce to the board root", async () => {
  const f1 = fakeFetch({ "https://grnh.se/gone": { status: 404, url: GH } });
  assert.equal(
    (await resolveUrl("https://grnh.se/gone", { fetchFn: f1, detectAts })).reason,
    "dead"
  );
  const f2 = fakeFetch({
    "https://grnh.se/closed": {
      status: 200,
      url: "https://job-boards.greenhouse.io/acmesynthetic?error=true",
      body: `<a href="${GH.replace("1234567", "999")}">Other job</a>`,
    },
  });
  const r2 = await resolveUrl("https://grnh.se/closed", { fetchFn: f2, detectAts });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "dead", "never pick some other job off the board page");
});

test("blocked aggregator (403) and unknown pages", async () => {
  const f = fakeFetch({
    "https://www.adzuna.com/land/ad/2": { status: 403 },
    "https://careers.example.com/job/1": {
      status: 200,
      body: "<html>Apply on our own portal</html>",
    },
  });
  assert.equal(
    (await resolveUrl("https://www.adzuna.com/land/ad/2", { fetchFn: f, detectAts })).reason,
    "blocked"
  );
  const r = await resolveUrl("https://careers.example.com/job/1", { fetchFn: f, detectAts });
  assert.equal(r.reason, "no_ats");
  assert.equal(r.url, "https://careers.example.com/job/1");
});

test("network error and unsafe URL", async () => {
  const f = fakeFetch({ "https://down.example.com/": { throws: "ECONNRESET" } });
  assert.equal(
    (await resolveUrl("https://down.example.com/", { fetchFn: f, detectAts })).reason,
    "fetch_error"
  );
  assert.equal(
    (await resolveUrl("http://127.0.0.1/x", { fetchFn: f, detectAts })).reason,
    "unsafe_url"
  );
  assert.equal(
    (await resolveUrl("file:///etc/passwd", { fetchFn: f, detectAts })).reason,
    "unsafe_url"
  );
});

test("findHtmlHop / greenhouseFromEmbed helpers", () => {
  assert.equal(findHtmlHop("https://a.example/", "<p>nothing</p>"), null);
  assert.equal(
    findHtmlHop(
      "https://a.example/",
      '<script>window.location.href = "https://b.example/x";</script>'
    ),
    "https://b.example/x"
  );
  assert.equal(
    greenhouseFromEmbed(
      "https://a.example/j?gh_jid=42",
      'src="https://job-boards.greenhouse.io/embed/job_app?for=acme&amp;token=42"'
    ),
    "https://job-boards.greenhouse.io/acme/jobs/42"
  );
  assert.equal(greenhouseFromEmbed("https://a.example/j", "for=acme"), null);
});
