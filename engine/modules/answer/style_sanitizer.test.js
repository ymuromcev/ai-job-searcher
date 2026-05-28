// Tests for engine/modules/answer/style_sanitizer.js — RFC 050 / BL-138.

const test = require("node:test");
const assert = require("node:assert/strict");

const { sanitize, KNOWN_RULES } = require("./style_sanitizer.js");

const ALL_RULES = ["tilde_to_about", "em_dash_to_hyphen", "x_multiplier_to_times"];

test("style_sanitizer: KNOWN_RULES exports the three implemented rules", () => {
  assert.deepEqual(new Set(KNOWN_RULES), new Set(ALL_RULES));
});

// --- tilde_to_about ---------------------------------------------------------

test("style_sanitizer: tilde_to_about replaces ~N with 'about N'", () => {
  const { sanitized, changes } = sanitize("we had ~5 candidates and ~120 calls", ["tilde_to_about"]);
  assert.equal(sanitized, "we had about 5 candidates and about 120 calls");
  assert.equal(changes.length, 2);
  assert.equal(changes[0].rule, "tilde_to_about");
});

test("style_sanitizer: tilde_to_about preserves ~/.bashrc and ~user (no digit follows)", () => {
  const { sanitized, changes } = sanitize("see ~/.bashrc or ~user/config", ["tilde_to_about"]);
  assert.equal(sanitized, "see ~/.bashrc or ~user/config");
  assert.equal(changes.length, 0);
});

// --- em_dash_to_hyphen ------------------------------------------------------

test("style_sanitizer: em_dash_to_hyphen replaces — with ' - '", () => {
  const { sanitized, changes } = sanitize("I led the team — we shipped on time", ["em_dash_to_hyphen"]);
  assert.equal(sanitized, "I led the team - we shipped on time");
  assert.equal(changes.length, 1);
});

test("style_sanitizer: em_dash_to_hyphen collapses runs of spaces created by replacement", () => {
  // input has space before and after em dash → ' — ' becomes '  -  ', then collapses to ' - '
  const { sanitized } = sanitize("alpha — beta — gamma", ["em_dash_to_hyphen"]);
  assert.equal(sanitized, "alpha - beta - gamma");
});

test("style_sanitizer: em_dash_to_hyphen leaves regular hyphens alone", () => {
  const { sanitized, changes } = sanitize("multi-tenant rollout - phase 2", ["em_dash_to_hyphen"]);
  assert.equal(sanitized, "multi-tenant rollout - phase 2");
  assert.equal(changes.length, 0);
});

// --- x_multiplier_to_times --------------------------------------------------

test("style_sanitizer: x_multiplier_to_times replaces 10x with '10 times'", () => {
  const { sanitized, changes } = sanitize("we saw 10x growth and 2.5x speedup", ["x_multiplier_to_times"]);
  assert.equal(sanitized, "we saw 10 times growth and 2.5 times speedup");
  assert.equal(changes.length, 2);
});

test("style_sanitizer: x_multiplier_to_times preserves identifier tokens like 'box' and 'tex'", () => {
  const { sanitized, changes } = sanitize("the box has a tex file and a regex", ["x_multiplier_to_times"]);
  assert.equal(sanitized, "the box has a tex file and a regex");
  assert.equal(changes.length, 0);
});

test("style_sanitizer: x_multiplier_to_times preserves URL hosts like 2x.example.com", () => {
  const { sanitized, changes } = sanitize("see 2x.example.com for the asset", ["x_multiplier_to_times"]);
  assert.equal(sanitized, "see 2x.example.com for the asset");
  assert.equal(changes.length, 0);
});

// --- combined / idempotency / edge cases ------------------------------------

test("style_sanitizer: all-rules applied together on realistic answer", () => {
  const input = "about ~5 — 10x improvement";
  const { sanitized, changes } = sanitize(input, ALL_RULES);
  assert.equal(sanitized, "about about 5 - 10 times improvement");
  assert.equal(changes.length, 3);
});

test("style_sanitizer: idempotent — sanitize(sanitize(x)) === sanitize(x)", () => {
  const input = "we ran ~3 — 60x faster jobs";
  const first = sanitize(input, ALL_RULES).sanitized;
  const second = sanitize(first, ALL_RULES).sanitized;
  assert.equal(first, second);
});

test("style_sanitizer: empty string returns empty + no changes", () => {
  const { sanitized, changes } = sanitize("", ALL_RULES);
  assert.equal(sanitized, "");
  assert.equal(changes.length, 0);
});

test("style_sanitizer: non-string input returns safely (no throw)", () => {
  const { sanitized, changes } = sanitize(null, ALL_RULES);
  assert.equal(sanitized, "");
  assert.equal(changes.length, 0);
});

test("style_sanitizer: empty rules list is no-op", () => {
  const input = "~5 — 10x";
  const { sanitized, changes } = sanitize(input, []);
  assert.equal(sanitized, input);
  assert.equal(changes.length, 0);
});

test("style_sanitizer: unknown rule names are silently ignored (forward-compat)", () => {
  const input = "~5 — 10x";
  const { sanitized, changes } = sanitize(input, ["tilde_to_about", "future_rule_v2"]);
  assert.equal(sanitized, "about 5 — 10x");
  assert.equal(changes.length, 1);
});

test("style_sanitizer: subset of rules applies only those rules", () => {
  const input = "we saw ~5 — 10x growth";
  const { sanitized } = sanitize(input, ["tilde_to_about"]);
  // em dash and x-multiplier untouched
  assert.equal(sanitized, "we saw about 5 — 10x growth");
});

test("style_sanitizer: changes[] reports before/after fragments accurately", () => {
  const { changes } = sanitize("~5 — 10x", ALL_RULES);
  assert.deepEqual(changes, [
    { rule: "tilde_to_about", before: "~", after: "about " },
    { rule: "em_dash_to_hyphen", before: "—", after: " - " },
    { rule: "x_multiplier_to_times", before: "10x", after: "10 times" },
  ]);
});
