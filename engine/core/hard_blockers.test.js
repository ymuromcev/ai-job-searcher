// Tests for `engine/core/hard_blockers.js` (RFC 039 §3.2 / BL-89).
//
// Pure regex isolation: every test passes a fake `structuredJD` literal
// directly, so we never depend on `jd_extract` here. The wired integration
// is exercised in `engine/commands/prepare.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { findHardBlockers } = require("./hard_blockers.js");

function makeProfile(hardBlockers) {
  return { filterRules: { hard_blockers: hardBlockers } };
}

test("findHardBlockers: empty/missing config → []", () => {
  const codes = findHardBlockers({
    structuredJD: { requirements: ["5+ years Python required"] },
    profile: { filterRules: {} },
  });
  assert.deepEqual(codes, []);
});

test("findHardBlockers: no profile → []", () => {
  const codes = findHardBlockers({
    structuredJD: { requirements: ["5+ years Python required"] },
  });
  assert.deepEqual(codes, []);
});

test("findHardBlockers: required_skill_excluded fires with years co-occurrence", () => {
  const profile = makeProfile({
    required_skills_excluded: [
      { skill: "Python", patterns: ["\\bPython\\b"], min_years: 1 },
    ],
  });
  const codes = findHardBlockers({
    structuredJD: {
      requirements: ["5+ years Python required", "MS in CS preferred"],
    },
    profile,
  });
  assert.deepEqual(codes, ["required_skill_excluded:Python"]);
});

test("findHardBlockers: 'nice to have' qualifier does NOT fire", () => {
  const profile = makeProfile({
    required_skills_excluded: [
      { skill: "Python", patterns: ["\\bPython\\b"], min_years: 1 },
    ],
  });
  const codes = findHardBlockers({
    structuredJD: {
      requirements: ["Familiarity with Python a plus", "5 years PM experience"],
    },
    profile,
  });
  assert.deepEqual(codes, []);
});

test("findHardBlockers: 'preferred' qualifier does NOT fire", () => {
  const profile = makeProfile({
    required_skills_excluded: [
      { skill: "Python", patterns: ["\\bPython\\b"], min_years: 1 },
    ],
  });
  const codes = findHardBlockers({
    structuredJD: { requirements: ["Python preferred but not required"] },
    profile,
  });
  assert.deepEqual(codes, []);
});

test("findHardBlockers: pattern alternates (Django) fire under the Python skill bucket", () => {
  const profile = makeProfile({
    required_skills_excluded: [
      {
        skill: "Python",
        patterns: ["\\bPython\\b", "\\bDjango\\b", "\\bFastAPI\\b"],
        min_years: 1,
      },
    ],
  });
  const codes = findHardBlockers({
    structuredJD: { requirements: ["3+ years Django experience required"] },
    profile,
  });
  assert.deepEqual(codes, ["required_skill_excluded:Python"]);
});

test("findHardBlockers: ±3-line co-occurrence — required marker on neighboring line", () => {
  const profile = makeProfile({
    required_skills_excluded: [
      { skill: "Python", patterns: ["\\bPython\\b"], min_years: 1 },
    ],
  });
  // Skill appears alone; required marker appears 2 lines below.
  const codes = findHardBlockers({
    structuredJD: {
      requirements: [
        "Solid Python skills",
        "Familiarity with infrastructure",
        "All of the above required",
      ],
    },
    profile,
  });
  assert.deepEqual(codes, ["required_skill_excluded:Python"]);
});

test("findHardBlockers: years_required_max_exceeded fires", () => {
  const profile = makeProfile({ years_required_max: 10 });
  const codes = findHardBlockers({
    structuredJD: { requirements: ["20 years of leadership experience required"] },
    profile,
  });
  assert.deepEqual(codes, ["years_required_max_exceeded:20"]);
});

test("findHardBlockers: years_required_max — equal-to cap does NOT fire", () => {
  const profile = makeProfile({ years_required_max: 10 });
  const codes = findHardBlockers({
    structuredJD: { requirements: ["10 years experience required"] },
    profile,
  });
  assert.deepEqual(codes, []);
});

test("findHardBlockers: cert_required:RN fires (word-boundary)", () => {
  const profile = makeProfile({ cert_blockers: ["RN", "CMA"] });
  const codes = findHardBlockers({
    structuredJD: { requirements: ["Active RN license required"] },
    profile,
  });
  assert.deepEqual(codes, ["cert_required:RN"]);
});

test("findHardBlockers: cert word-boundary — 'WARN' does NOT fire RN", () => {
  const profile = makeProfile({ cert_blockers: ["RN"] });
  const codes = findHardBlockers({
    structuredJD: { requirements: ["You will WARN clinicians of risk."] },
    profile,
  });
  assert.deepEqual(codes, []);
});

test("findHardBlockers: multi-code — Python AND 15 years required", () => {
  const profile = makeProfile({
    required_skills_excluded: [
      { skill: "Python", patterns: ["\\bPython\\b"], min_years: 1 },
    ],
    years_required_max: 10,
  });
  const codes = findHardBlockers({
    structuredJD: {
      requirements: ["15+ years Python required at scale", "Lead infra teams"],
    },
    profile,
  });
  assert.deepEqual(codes, [
    "required_skill_excluded:Python",
    "years_required_max_exceeded:15",
  ]);
});

test("findHardBlockers: empty requirements array — only cert blockers can fire", () => {
  const profile = makeProfile({
    required_skills_excluded: [
      { skill: "Python", patterns: ["\\bPython\\b"], min_years: 1 },
    ],
    cert_blockers: ["RN"],
  });
  const codes = findHardBlockers({
    structuredJD: { requirements: [] },
    profile,
  });
  // Both skill and cert lookups operate on requirements[]; an empty array
  // means no firing.
  assert.deepEqual(codes, []);
});

test("findHardBlockers: malformed regex pattern is skipped without throwing", () => {
  const profile = makeProfile({
    required_skills_excluded: [
      { skill: "Python", patterns: ["(unclosed", "\\bPython\\b"], min_years: 1 },
    ],
  });
  const codes = findHardBlockers({
    structuredJD: { requirements: ["5+ years Python required"] },
    profile,
  });
  assert.deepEqual(codes, ["required_skill_excluded:Python"]);
});

test("findHardBlockers: pure-input isolation — no JD parsing inside", () => {
  // Hand-craft requirements; ensure the module doesn't fall back to scanning
  // any other field on `structuredJD`.
  const profile = makeProfile({
    required_skills_excluded: [
      { skill: "Python", patterns: ["\\bPython\\b"], min_years: 1 },
    ],
  });
  const codes = findHardBlockers({
    structuredJD: {
      requirements: ["5 years PM experience required"],
      responsibilities: ["Write Python required"],
      full_text_excerpt: "5+ years Python required",
    },
    profile,
  });
  // Python doesn't appear in requirements[]; full_text_excerpt /
  // responsibilities are explicitly NOT consulted today.
  assert.deepEqual(codes, []);
});

test("findHardBlockers: cert family + min_years are independent", () => {
  const profile = makeProfile({
    cert_blockers: ["CMA"],
    years_required_max: 5,
  });
  const codes = findHardBlockers({
    structuredJD: { requirements: ["CMA certification required; 8 years experience"] },
    profile,
  });
  assert.deepEqual(codes, [
    "years_required_max_exceeded:8",
    "cert_required:CMA",
  ]);
});
