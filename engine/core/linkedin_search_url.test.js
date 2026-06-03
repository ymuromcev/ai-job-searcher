const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { buildCompanyPeopleSearchUrl } = require("./linkedin_search_url.js");

const BASE = "https://www.linkedin.com/search/results/people/";

// Parse out the `keywords` query value from a produced URL for assertions.
function keywordsOf(url) {
  return new URL(url).searchParams.get("keywords");
}

test("company-only: builds a valid people-search URL with the company in keywords", () => {
  const url = buildCompanyPeopleSearchUrl({ company: "Affirm" });
  assert.ok(url.startsWith(BASE), "must start with the LinkedIn people-search base");
  const kw = keywordsOf(url);
  assert.ok(kw.includes("Affirm"), "keywords include the company");
  // US bias is always present (ToS-safe keyword bias, not a geoUrn).
  assert.ok(kw.includes("United States"), "keywords carry the US bias");
  assert.ok(!url.includes("geoUrn"), "must not hardcode a LinkedIn geoUrn");
});

test("company + role: keywords gain role-derived hiring keywords", () => {
  const url = buildCompanyPeopleSearchUrl({ company: "Stripe", roleTitle: "Senior PM" });
  const kw = keywordsOf(url);
  assert.ok(kw.includes("Stripe"));
  assert.ok(kw.includes("recruiter"));
  assert.ok(kw.includes("hiring manager"));
});

test("company + role + location: keywords include the location too", () => {
  const url = buildCompanyPeopleSearchUrl({
    company: "Stripe",
    roleTitle: "Senior PM",
    location: "San Francisco, CA",
  });
  const kw = keywordsOf(url);
  assert.ok(kw.includes("Stripe"));
  assert.ok(kw.includes("recruiter"));
  assert.ok(kw.includes("San Francisco, CA"));
  assert.ok(kw.includes("United States"));
});

test("missing company throws a clear error", () => {
  assert.throws(() => buildCompanyPeopleSearchUrl({}), /company.*required/i);
  assert.throws(() => buildCompanyPeopleSearchUrl({ company: "" }), /company.*required/i);
  assert.throws(() => buildCompanyPeopleSearchUrl({ company: "   " }), /company.*required/i);
  assert.throws(() => buildCompanyPeopleSearchUrl(), /company.*required/i);
});

test("role/location absent → company-only is still valid", () => {
  const url = buildCompanyPeopleSearchUrl({ company: "Affirm", roleTitle: "", location: "" });
  const kw = keywordsOf(url);
  assert.ok(kw.includes("Affirm"));
  // empty role → no role fragments injected
  assert.ok(!kw.includes("recruiter"));
});

test("encodes spaces, &, and unicode in the company name (single well-formed URL)", () => {
  const url = buildCompanyPeopleSearchUrl({ company: "Ben & Jerry's São Paulo" });
  // Single well-formed URL: parses without throwing and round-trips the value.
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, BASE);
  // Raw spaces and `&` must be percent/`+`-encoded, never literal in the string.
  const query = url.slice(url.indexOf("?") + 1);
  assert.ok(!query.includes(" "), "no raw spaces in the query string");
  // The `&` inside the company name must not appear as a bare separator: there
  // is exactly one `keywords` param and one `origin` param.
  const params = parsed.searchParams;
  assert.equal([...params.keys()].filter((k) => k === "keywords").length, 1);
  // Decoded value preserves the unicode + ampersand verbatim.
  assert.ok(params.get("keywords").includes("Ben & Jerry's São Paulo"));
});

test("returns a plain string", () => {
  const url = buildCompanyPeopleSearchUrl({ company: "Affirm" });
  assert.equal(typeof url, "string");
});

// ToS / purity guard (load-bearing per RFC 059): the module assembles a URL
// only. It must import nothing network-related — assert by source inspection so
// a future edit that pulls in fetch/http/https/net is caught.
test("module imports nothing network-related", () => {
  const src = fs.readFileSync(path.join(__dirname, "linkedin_search_url.js"), "utf8");
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, [], "helper must not require any module");
  for (const banned of ["http", "https", "net", "fetch", "node-fetch", "undici", "dns"]) {
    assert.ok(!requires.includes(banned), `must not import ${banned}`);
  }
});
