const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  computeCoverage,
  normalizeText,
  findExactMatch,
  findPartialMatch,
} = require("./coverage_score.js");

test("normalizeText — collapses whitespace and lowercases", () => {
  assert.equal(normalizeText("  Hello   World\n\tTHERE "), "hello world there");
  assert.equal(normalizeText(null), "");
  assert.equal(normalizeText(undefined), "");
  assert.equal(normalizeText(""), "");
});

test("findExactMatch — case- and whitespace-insensitive substring", () => {
  assert.equal(findExactMatch("Open Finance", "We built our open finance stack"), true);
  assert.equal(findExactMatch("open  finance", "open finance is here"), true);
  assert.equal(findExactMatch("kubernetes", "we use docker"), false);
  assert.equal(findExactMatch("", "anything"), false);
  assert.equal(findExactMatch("x", ""), false);
});

test("findPartialMatch — finds rewordings within 50-char window", () => {
  // 3 tokens, need ceil(3 * 0.6) = 2 hits in a 50-char window.
  assert.equal(
    findPartialMatch("own product area", "responsible for own product end-to-end"),
    true,
  );
  // Single-token degenerates to token presence.
  assert.equal(findPartialMatch("kubernetes", "we use kubernetes daily"), true);
  // No overlap → false.
  assert.equal(findPartialMatch("scrum of scrums", "agile retrospective notes"), false);
});

test("computeCoverage — empty JD returns 100%", () => {
  const result = computeCoverage([], "any resume text");
  assert.equal(result.coverage_pct, 100);
  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.partial, []);
  assert.deepEqual(result.missing, []);
});

test("computeCoverage — empty resume returns 0% and all phrases missing", () => {
  const phrases = [
    { phrase: "kubernetes", priority: "high" },
    { phrase: "open finance", priority: "medium" },
  ];
  const result = computeCoverage(phrases, "");
  assert.equal(result.coverage_pct, 0);
  assert.equal(result.matched.length, 0);
  assert.equal(result.partial.length, 0);
  assert.equal(result.missing.length, 2);
});

test("computeCoverage — exact matches give full credit", () => {
  const phrases = [
    { phrase: "kubernetes", priority: "high" },
    { phrase: "graphql", priority: "high" },
  ];
  const resume = "Built infra on kubernetes and graphql apis.";
  const result = computeCoverage(phrases, resume);
  assert.equal(result.coverage_pct, 100);
  assert.equal(result.matched.length, 2);
  assert.equal(result.partial.length, 0);
  assert.equal(result.missing.length, 0);
});

test("computeCoverage — mixed exact + partial + missing yields correct pct", () => {
  const phrases = [
    { phrase: "kubernetes", priority: "high" }, // exact
    { phrase: "own a product area", priority: "high" }, // partial
    { phrase: "scrum of scrums", priority: "low" }, // missing
    { phrase: "graphql", priority: "medium" }, // exact
  ];
  const resume =
    "Shipped kubernetes clusters; own product area end-to-end with graphql.";
  const result = computeCoverage(phrases, resume);
  // matched=2, partial=1 → (2 + 0.5) / 4 = 0.625 → 63%
  assert.equal(result.coverage_pct, 63);
  assert.equal(result.matched.length, 2);
  assert.equal(result.partial.length, 1);
  assert.equal(result.missing.length, 1);
});

test("computeCoverage — case-insensitive matching", () => {
  const phrases = [
    { phrase: "KUBERNETES", priority: "high" },
    { phrase: "Open Finance", priority: "high" },
  ];
  const resume = "we run kubernetes; open finance is core";
  const result = computeCoverage(phrases, resume);
  assert.equal(result.coverage_pct, 100);
  assert.equal(result.matched.length, 2);
});

test("computeCoverage — breakdown by priority", () => {
  const phrases = [
    { phrase: "kubernetes", priority: "high" }, // matched
    { phrase: "graphql", priority: "high" }, // missing
    { phrase: "react", priority: "medium" }, // matched
    { phrase: "vue", priority: "low" }, // missing
  ];
  const resume = "kubernetes and react";
  const result = computeCoverage(phrases, resume);
  assert.equal(result.coverage_pct, 50);
  assert.equal(result.breakdown.high.matched, 1);
  assert.equal(result.breakdown.high.missing, 1);
  assert.equal(result.breakdown.high.total, 2);
  assert.equal(result.breakdown.high.coverage_pct, 50);
  assert.equal(result.breakdown.medium.matched, 1);
  assert.equal(result.breakdown.medium.coverage_pct, 100);
  assert.equal(result.breakdown.low.missing, 1);
  assert.equal(result.breakdown.low.coverage_pct, 0);
});

test("computeCoverage — phrase with no alphanumeric content is missing", () => {
  const phrases = [
    { phrase: "---", priority: "high" },
    { phrase: "kubernetes", priority: "high" },
  ];
  const resume = "kubernetes is here";
  const result = computeCoverage(phrases, resume);
  // 1 matched, 1 missing → 50%
  assert.equal(result.coverage_pct, 50);
  assert.equal(result.missing.length, 1);
});
