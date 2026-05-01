const { test } = require("node:test");
const assert = require("node:assert/strict");

const { dedupKey, isExactMatch, QUESTION_HEAD_LIMIT } = require("./qa_dedup.js");

test("dedupKey lowercases and trims all fields", () => {
  assert.equal(
    dedupKey({ company: "  Figma ", role: " Product Manager ", question: " Why? " }),
    "figma||product manager||why?"
  );
});

test("dedupKey truncates question to 120 chars", () => {
  const longQ = "a".repeat(200);
  const key = dedupKey({ company: "x", role: "y", question: longQ });
  const headChars = key.split("||")[2];
  assert.equal(headChars.length, QUESTION_HEAD_LIMIT);
  assert.equal(headChars, "a".repeat(QUESTION_HEAD_LIMIT));
});

test("dedupKey handles missing fields without throwing", () => {
  assert.equal(dedupKey({}), "||||");
  assert.equal(dedupKey({ company: "Stripe" }), "stripe||||");
  assert.equal(dedupKey(), "||||");
});

test("dedupKey is case-insensitive across same logical entry", () => {
  const a = { company: "FIGMA", role: "Product Manager, AI Platform", question: "Why do you want to join Figma?" };
  const b = { company: "figma", role: "product manager, ai platform", question: "why do you want to join figma?" };
  assert.equal(dedupKey(a), dedupKey(b));
});

test("dedupKey is sensitive to question content beyond just whitespace", () => {
  const a = { company: "Figma", role: "PM", question: "Why join Figma?" };
  const b = { company: "Figma", role: "PM", question: "Why leave Figma?" };
  assert.notEqual(dedupKey(a), dedupKey(b));
});

test("isExactMatch returns true for equivalent entries", () => {
  assert.equal(
    isExactMatch(
      { company: "Linear", role: "PM", question: "What motivates you?" },
      { company: "linear", role: "pm", question: "  What motivates you?  " }
    ),
    true
  );
});

test("isExactMatch returns false for different roles at same company", () => {
  assert.equal(
    isExactMatch(
      { company: "Linear", role: "PM", question: "What motivates you?" },
      { company: "Linear", role: "Engineering Manager", question: "What motivates you?" }
    ),
    false
  );
});

test("dedupKey treats null/undefined consistently", () => {
  assert.equal(dedupKey({ company: null, role: undefined, question: "" }), "||||");
});
