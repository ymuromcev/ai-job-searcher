// Tests for `engine/core/requirement_blockers.js` (RFC 046 / BL-B).
//
// Pure regex isolation — every test passes a fake `jdStructure` literal so we
// never depend on `jd_extract`. The wired integration is exercised in
// `engine/commands/prepare.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  compilePatterns,
  applyRequirementBlockers,
} = require("./requirement_blockers.js");

// Silence the stderr warnings from `compilePatterns` during the test run so
// the test output is grep-able. Each test that exercises an error path
// asserts the error appears in the returned `errors[]` array instead.
function withSilencedConsoleError(fn) {
  const orig = console.error;
  const captured = [];
  console.error = (...args) => {
    captured.push(args.join(" "));
  };
  try {
    return { result: fn(), captured };
  } finally {
    console.error = orig;
  }
}

test("compilePatterns: happy path — 3 valid patterns compile cleanly", () => {
  const { result } = withSilencedConsoleError(() =>
    compilePatterns([
      { pattern: "\\bPython\\b", reason: "python-required" },
      { pattern: "\\bJD or PhD\\b", reason: "advanced-degree-required", flags: "i" },
      { pattern: "\\bSWE\\b", reason: "swe-required", match_in: ["requirements"] },
    ])
  );
  assert.equal(result.compiled.length, 3);
  assert.equal(result.errors.length, 0);
  assert.ok(result.compiled[0].pattern instanceof RegExp);
  assert.equal(result.compiled[0].reason, "python-required");
  // Default flags = "i", default match_in = ["requirements", "full_text_excerpt"].
  assert.equal(result.compiled[0].pattern.flags, "i");
  assert.deepEqual(result.compiled[0].match_in, ["requirements", "full_text_excerpt"]);
  // Explicit match_in overrides default.
  assert.deepEqual(result.compiled[2].match_in, ["requirements"]);
});

test("compilePatterns: single hit in requirements", () => {
  const { result } = withSilencedConsoleError(() =>
    compilePatterns([
      {
        pattern: "\\b(JD|PhD)\\b[^.]{0,80}\\brequired\\b",
        reason: "advanced-degree-required",
      },
    ])
  );
  const hit = applyRequirementBlockers(
    {
      requirements: ["JD or PhD required", "5 years policy experience"],
      responsibilities: [],
      full_text_excerpt: "irrelevant",
    },
    result.compiled
  );
  assert.equal(hit.hit, true);
  assert.equal(hit.reason, "advanced-degree-required");
  assert.ok(hit.matched_pattern.includes("JD"));
});

test("applyRequirementBlockers: single hit in full_text_excerpt fallback", () => {
  const { result } = withSilencedConsoleError(() =>
    compilePatterns([
      {
        pattern: "\\bstrong\\s+programming\\s+ability\\s+in\\s+Python\\b",
        reason: "python-strong-required",
      },
    ])
  );
  // Heuristic JD-extract missed the section heading → requirements[] empty,
  // but excerpt still carries the offending sentence. Should match.
  const hit = applyRequirementBlockers(
    {
      requirements: [],
      responsibilities: [],
      full_text_excerpt:
        "About the role: we need strong programming ability in Python and a track record of shipping.",
    },
    result.compiled
  );
  assert.equal(hit.hit, true);
  assert.equal(hit.reason, "python-strong-required");
});

test("applyRequirementBlockers: multi-pattern first-wins (declaration order)", () => {
  const { result } = withSilencedConsoleError(() =>
    compilePatterns([
      { pattern: "\\bPython\\b", reason: "python-required" },
      { pattern: "\\bPhD\\b", reason: "phd-required" },
    ])
  );
  // JD matches BOTH — the FIRST one wins (declaration order), §4.3.
  const hit = applyRequirementBlockers(
    {
      requirements: ["Python and PhD required"],
      responsibilities: [],
      full_text_excerpt: "",
    },
    result.compiled
  );
  assert.equal(hit.hit, true);
  assert.equal(hit.reason, "python-required");
});

test("compilePatterns: invalid regex → error captured, pattern dropped", () => {
  const { result, captured } = withSilencedConsoleError(() =>
    compilePatterns([
      { pattern: "\\bgood\\b", reason: "good-pattern" },
      { pattern: "[invalid(regex", reason: "bad-regex" }, // unterminated class.
      { pattern: "\\balso-good\\b", reason: "another-good" },
    ])
  );
  assert.equal(result.compiled.length, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].reason, "bad-regex");
  assert.match(result.errors[0].error, /invalid regex/);
  assert.equal(captured.length, 1);
  assert.match(captured[0], /bad-regex/);
});

test("compilePatterns: invalid reason label → error captured, pattern dropped", () => {
  const { result, captured } = withSilencedConsoleError(() =>
    compilePatterns([
      { pattern: "\\bok\\b", reason: "kebab-ok" },
      { pattern: "\\bbad\\b", reason: "Has_Underscore_And_Caps" },
      { pattern: "\\balso-bad\\b", reason: "" },
      { pattern: "\\bnope\\b", reason: "9-starts-with-digit" },
    ])
  );
  assert.equal(result.compiled.length, 1);
  assert.equal(result.errors.length, 3);
  for (const err of result.errors) {
    assert.match(err.error, /invalid reason label/);
  }
  assert.equal(captured.length, 3);
});

test("compilePatterns: non-array input returns empty result without throwing", () => {
  const r1 = compilePatterns(undefined);
  const r2 = compilePatterns(null);
  const r3 = compilePatterns({ not: "array" });
  assert.deepEqual(r1, { compiled: [], errors: [] });
  assert.deepEqual(r2, { compiled: [], errors: [] });
  assert.deepEqual(r3, { compiled: [], errors: [] });
});

test("applyRequirementBlockers: no JD text → no match", () => {
  const { result } = withSilencedConsoleError(() =>
    compilePatterns([{ pattern: "\\bPython\\b", reason: "python-required" }])
  );
  const hit = applyRequirementBlockers(
    { requirements: [], responsibilities: [], full_text_excerpt: "" },
    result.compiled
  );
  assert.equal(hit.hit, false);
  assert.equal(hit.reason, null);
});

test("applyRequirementBlockers: empty compiled set → no match (no-op)", () => {
  const hit = applyRequirementBlockers(
    {
      requirements: ["Python required"],
      responsibilities: [],
      full_text_excerpt: "",
    },
    []
  );
  assert.equal(hit.hit, false);
});

test("compilePatterns: match_in restricted to requirements only", () => {
  const { result } = withSilencedConsoleError(() =>
    compilePatterns([
      {
        pattern: "\\bPython\\b",
        reason: "python-required",
        match_in: ["requirements"],
      },
    ])
  );
  // Excerpt mentions Python, requirements[] does not — should NOT match.
  const hit = applyRequirementBlockers(
    {
      requirements: ["10 years PM experience"],
      responsibilities: [],
      full_text_excerpt: "Strong Python helps.",
    },
    result.compiled
  );
  assert.equal(hit.hit, false);
});

test("compilePatterns: invalid match_in entries dropped, empty array drops pattern", () => {
  const { result } = withSilencedConsoleError(() =>
    compilePatterns([
      {
        pattern: "\\bok\\b",
        reason: "still-fine",
        match_in: ["requirements", "nonsense-field"], // one valid → kept
      },
      {
        pattern: "\\bdrop\\b",
        reason: "dropped",
        match_in: ["nonsense", "also-nonsense"], // all invalid → drop pattern
      },
    ])
  );
  assert.equal(result.compiled.length, 1);
  assert.deepEqual(result.compiled[0].match_in, ["requirements"]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].reason, "dropped");
});
