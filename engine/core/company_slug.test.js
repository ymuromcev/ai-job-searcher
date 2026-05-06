const { test } = require("node:test");
const assert = require("node:assert/strict");

const { slugifyCompany } = require("./company_slug.js");

test("simple alphanumeric name preserves case", () => {
  assert.equal(slugifyCompany("Affirm"), "Affirm");
  assert.equal(slugifyCompany("Stripe"), "Stripe");
});

test("ampersand becomes 'and', not '_'", () => {
  // Real cases: "Procter & Gamble", "AT&T", "Johnson & Johnson".
  assert.equal(slugifyCompany("Procter & Gamble"), "Procter_and_Gamble");
  assert.equal(slugifyCompany("AT&T"), "AT_and_T");
  assert.equal(slugifyCompany("Johnson & Johnson"), "Johnson_and_Johnson");
});

test("comma and dot collapse to single underscore", () => {
  // Most common: legal-entity suffixes in scraped names.
  assert.equal(slugifyCompany("Stripe, Inc."), "Stripe_Inc");
  assert.equal(slugifyCompany("Acme, LLC"), "Acme_LLC");
  assert.equal(slugifyCompany("Foo Co., Ltd."), "Foo_Co_Ltd");
});

test("hyphen and slash treated as separator", () => {
  assert.equal(slugifyCompany("Bristol-Myers Squibb"), "Bristol_Myers_Squibb");
  assert.equal(slugifyCompany("Alphabet/Google"), "Alphabet_Google");
});

test("multiple spaces collapse, leading/trailing trimmed", () => {
  assert.equal(slugifyCompany("  Acme    Corp  "), "Acme_Corp");
  assert.equal(slugifyCompany("\tAcme\nCorp\n"), "Acme_Corp");
});

test("preserves digits and mixed case", () => {
  assert.equal(slugifyCompany("3M"), "3M");
  assert.equal(slugifyCompany("7-Eleven"), "7_Eleven");
  assert.equal(slugifyCompany("Web3 Labs"), "Web3_Labs");
});

test("empty / null / undefined / pure-symbol → '_unknown'", () => {
  assert.equal(slugifyCompany(""), "_unknown");
  assert.equal(slugifyCompany("   "), "_unknown");
  assert.equal(slugifyCompany(null), "_unknown");
  assert.equal(slugifyCompany(undefined), "_unknown");
  assert.equal(slugifyCompany("!!!"), "_unknown");
  assert.equal(slugifyCompany("---"), "_unknown");
});

test("non-ASCII collapses through the non-alphanumeric pass", () => {
  // Profiles are US-only for now — these get surfaced in migration dry-run.
  // Pure Cyrillic / kanji → all chars stripped → "_unknown".
  assert.equal(slugifyCompany("Авито"), "_unknown");
  // Mixed Latin + accent: "é" is non-ASCII so it's replaced by "_",
  // trailing "_" then trimmed → "Caf".
  assert.equal(slugifyCompany("Café"), "Caf");
});

test("idempotent on already-slugified input", () => {
  const first = slugifyCompany("Stripe, Inc.");
  assert.equal(slugifyCompany(first), first);
  const second = slugifyCompany("Procter & Gamble");
  // Note: "and" becomes part of the slug, re-slugifying is idempotent.
  assert.equal(slugifyCompany(second), second);
});

test("non-string types coerced sanely", () => {
  // Defensive — numbers and booleans shouldn't crash the helper.
  assert.equal(slugifyCompany(42), "42");
  assert.equal(slugifyCompany(true), "true");
});
