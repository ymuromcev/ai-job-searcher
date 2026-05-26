const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildMatrix } = require("./coverage_matrix.js");

test("buildMatrix returns empty string when no tailored results", () => {
  assert.equal(buildMatrix([]), "");
  assert.equal(buildMatrix(null), "");
  assert.equal(buildMatrix(undefined), "");
  // Rows present but no usable coverage_table → empty.
  assert.equal(buildMatrix([{ row_key: "a", coverage_table: [] }]), "");
  assert.equal(buildMatrix([{ row_key: "a" }]), "");
});

test("buildMatrix renders a single-row matrix with all status glyphs", () => {
  const md = buildMatrix(
    [
      {
        row_key: "greenhouse:1",
        coverage_table: [
          { jd_phrase: "agent workflow", status: "exact_match" },
          { jd_phrase: "regulated industries", status: "partial" },
          { jd_phrase: "Capitol Hill", status: "missing" },
        ],
      },
    ],
    { batchTs: "20260525_120000" }
  );

  assert.match(md, /# Coverage Matrix — batch 20260525_120000/);
  assert.match(md, /\| JD phrase \| greenhouse:1 \|/);
  assert.match(md, /\| "agent workflow" \| ✓ exact \|/);
  assert.match(md, /\| "regulated industries" \| partial \|/);
  // "Capitol Hill" is missing in the only row → goes into Gaps.
  assert.match(md, /## Gaps \(phrases never matched in any row\)/);
  assert.match(md, /- "Capitol Hill" — greenhouse:1 JD only/);
});

test("buildMatrix unions phrases across rows and fills '—' for absent phrases", () => {
  const md = buildMatrix([
    {
      row_key: "greenhouse:1",
      coverage_table: [
        { jd_phrase: "agent workflow", status: "exact_match" },
        { jd_phrase: "open finance", status: "partial" },
      ],
    },
    {
      row_key: "lever:99",
      coverage_table: [
        { jd_phrase: "agent workflow", status: "exact_match" },
        { jd_phrase: "developer network", status: "exact_match" },
      ],
    },
  ]);

  // Three columns in header (JD phrase + 2 row_keys).
  assert.match(md, /\| JD phrase \| greenhouse:1 \| lever:99 \|/);
  // "open finance" appears only in row 1, so row 2 cell is "—".
  assert.match(md, /\| "open finance" \| partial \| — \|/);
  // "developer network" appears only in row 2, so row 1 cell is "—".
  assert.match(md, /\| "developer network" \| — \| ✓ exact \|/);
  // "agent workflow" appears in both.
  assert.match(md, /\| "agent workflow" \| ✓ exact \| ✓ exact \|/);
  // No phrase was missing-everywhere → no Gaps section.
  assert.equal(md.includes("## Gaps"), false);
});

test("buildMatrix Gaps section lists phrases never matched anywhere", () => {
  const md = buildMatrix([
    {
      row_key: "greenhouse:1",
      coverage_table: [
        { jd_phrase: "ML platform", status: "exact_match" },
        { jd_phrase: "U.S. federal court", status: "missing" },
      ],
    },
    {
      row_key: "lever:99",
      coverage_table: [
        { jd_phrase: "ML platform", status: "partial" },
        { jd_phrase: "policy work", status: "missing" },
      ],
    },
  ]);

  assert.match(md, /## Gaps \(phrases never matched in any row\)/);
  // "U.S. federal court" only seen by row 1 — gap, attributed.
  assert.match(md, /- "U\.S\. federal court" — greenhouse:1 JD only/);
  // "policy work" only seen by row 2 — gap, attributed.
  assert.match(md, /- "policy work" — lever:99 JD only/);
  // "ML platform" matched somewhere (partial counts) → NOT in gaps.
  assert.equal(md.includes('"ML platform"' + " — "), false);
});

test("buildMatrix ignores malformed coverage_table entries", () => {
  const md = buildMatrix([
    {
      row_key: "greenhouse:1",
      coverage_table: [
        { jd_phrase: "valid", status: "exact_match" },
        { jd_phrase: 42, status: "exact_match" }, // non-string phrase → dropped
        null, // null entry → dropped
        { status: "missing" }, // missing jd_phrase → dropped
      ],
    },
  ]);
  // Only the "valid" row should appear; output is a one-row table.
  assert.match(md, /\| "valid" \| ✓ exact \|/);
  assert.equal(md.includes("42"), false);
});

test("buildMatrix escapes pipe characters in phrases and row keys", () => {
  const md = buildMatrix([
    {
      row_key: "greenhouse:weird|key",
      coverage_table: [{ jd_phrase: "a|b phrase", status: "exact_match" }],
    },
  ]);
  // Pipes escaped to keep the table well-formed.
  assert.match(md, /greenhouse:weird\\\|key/);
  assert.match(md, /"a\\\|b phrase"/);
});
