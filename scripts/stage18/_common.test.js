const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  validateProfileId,
  extractNotionPageId,
} = require("./_common.js");

test("validateProfileId accepts valid ids", () => {
  for (const id of ["profile_b", "user_2", "ab", "a1", "ab_cd_ef"]) {
    assert.equal(validateProfileId(id), id);
  }
});

test("validateProfileId rejects invalid ids", () => {
  for (const bad of [
    "",
    "a", // too short
    "A", // uppercase
    "1user", // starts with digit
    "user-name", // dash
    "user name", // space
    "x".repeat(33), // too long
    "_example", // reserved
    "example",
    "default",
    null,
    undefined,
  ]) {
    assert.throws(() => validateProfileId(bad));
  }
});

test("extractNotionPageId handles plain 32-hex", () => {
  assert.equal(
    extractNotionPageId("00000000000000000000000000000000"),
    "00000000-0000-0000-0000-000000000000"
  );
});

test("extractNotionPageId handles dashed form", () => {
  assert.equal(
    extractNotionPageId("00000000-0000-0000-0000-000000000000"),
    "00000000-0000-0000-0000-000000000000"
  );
});

test("extractNotionPageId handles full Notion URL", () => {
  assert.equal(
    extractNotionPageId(
      "https://www.notion.so/Hub-Title-00000000000000000000000000000000"
    ),
    "00000000-0000-0000-0000-000000000000"
  );
});

test("extractNotionPageId strips URL params and fragments", () => {
  assert.equal(
    extractNotionPageId(
      "https://www.notion.so/00000000000000000000000000000000?v=abc#xyz"
    ),
    "00000000-0000-0000-0000-000000000000"
  );
});

test("extractNotionPageId is case-insensitive (returns lowercase)", () => {
  assert.equal(
    extractNotionPageId("00000000000000000000000000000000"),
    "00000000-0000-0000-0000-000000000000"
  );
});

test("extractNotionPageId throws on missing/short input", () => {
  for (const bad of ["", "notahex", "abc123", null, undefined]) {
    assert.throws(() => extractNotionPageId(bad));
  }
});
