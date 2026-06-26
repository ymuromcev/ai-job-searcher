const test = require("node:test");
const assert = require("node:assert");

const { normalizeName, normalizeDomain } = require("./company_keys.js");

test("normalizeName: Cyrillic preserved, legal suffix peeled, casing folded", () => {
  assert.strictEqual(normalizeName("Яндекс"), "яндекс");
  assert.strictEqual(normalizeName("Virto Commerce, Inc."), "virto commerce");
  assert.strictEqual(normalizeName("KRISP"), "krisp");
});

test("normalizeDomain strips scheme, www, path, query, port", () => {
  assert.strictEqual(normalizeDomain("https://www.Lokalise.com/careers"), "lokalise.com");
  assert.strictEqual(normalizeDomain("lokalise.com"), "lokalise.com");
  assert.strictEqual(normalizeDomain("http://ntropy.com"), "ntropy.com");
  assert.strictEqual(normalizeDomain("https://example.com:8080/x?y=1"), "example.com");
  assert.strictEqual(normalizeDomain("www.example.com."), "example.com");
});

test("normalizeDomain: schemed and bare forms collide", () => {
  assert.strictEqual(
    normalizeDomain("https://www.improvado.io/about"),
    normalizeDomain("improvado.io")
  );
});

test("normalizeDomain: empty / non-string -> empty key", () => {
  assert.strictEqual(normalizeDomain(""), "");
  assert.strictEqual(normalizeDomain(null), "");
  assert.strictEqual(normalizeDomain(undefined), "");
});
