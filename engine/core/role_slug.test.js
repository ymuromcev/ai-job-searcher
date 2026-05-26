// engine/core/role_slug.test.js — BL-F

const test = require("node:test");
const assert = require("node:assert/strict");
const { slugifyRole } = require("./role_slug.js");

test("slugifyRole: simple title → lowercase dash-joined", () => {
  assert.equal(slugifyRole("Product Manager"), "product-manager");
});

test("slugifyRole: punctuation and parentheses collapsed to dashes", () => {
  assert.equal(slugifyRole("Product Manager (Builder)"), "product-manager-builder");
  assert.equal(
    slugifyRole("Senior PM, Ads & Measurement"),
    "senior-pm-ads-measurement"
  );
});

test("slugifyRole: caps to default maxLen=40 and re-trims trailing dash", () => {
  const long =
    "Member of Technical Staff (Forward Deployed Engineer, Applied AI)";
  const out = slugifyRole(long);
  assert.ok(out.length <= 40, `length=${out.length}: ${out}`);
  assert.ok(!out.endsWith("-"), `ends with dash: ${out}`);
  // First segment preserved
  assert.ok(out.startsWith("member-of-technical-staff"));
});

test("slugifyRole: empty / null / undefined → 'role' fallback", () => {
  assert.equal(slugifyRole(""), "role");
  assert.equal(slugifyRole(null), "role");
  assert.equal(slugifyRole(undefined), "role");
  assert.equal(slugifyRole("   "), "role");
});

test("slugifyRole: custom maxLen respected, never returns empty", () => {
  assert.equal(slugifyRole("Product Manager", 7), "product");
  // Edge case: tiny cap that lands on a dash — still trim, still non-empty
  assert.equal(slugifyRole("AB CD", 3), "ab");
  // Invalid maxLen falls back to default 40
  assert.equal(slugifyRole("Product Manager", 0), "product-manager");
  assert.equal(slugifyRole("Product Manager", -5), "product-manager");
});
