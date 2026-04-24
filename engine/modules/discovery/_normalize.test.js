const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeText,
  parseIsoDate,
  normalizeLocation,
  dedupeLocations,
  safeJoinUrl,
} = require("./_normalize.js");

test("sanitizeText collapses whitespace and trims", () => {
  assert.equal(sanitizeText("  hello\u00a0\tworld  "), "hello world");
  assert.equal(sanitizeText(null), "");
  assert.equal(sanitizeText(undefined), "");
});

test("parseIsoDate returns YYYY-MM-DD or null", () => {
  assert.equal(parseIsoDate("2026-04-15T10:20:30Z"), "2026-04-15");
  assert.equal(parseIsoDate("April 15, 2026"), "2026-04-15");
  assert.equal(parseIsoDate(""), null);
  assert.equal(parseIsoDate("nope"), null);
  assert.equal(parseIsoDate(null), null);
});

test("normalizeLocation maps Remote variants", () => {
  assert.equal(normalizeLocation("Remote - US"), "Remote");
  assert.equal(normalizeLocation("remote"), "Remote");
  assert.equal(normalizeLocation("  San Francisco, CA  "), "San Francisco, CA");
  assert.equal(normalizeLocation(""), "");
});

test("normalizeLocation rejects non-primitive inputs", () => {
  assert.equal(normalizeLocation({ city: "SF" }), "");
  assert.equal(normalizeLocation(["a", "b"]), "");
});

test("dedupeLocations removes case-duplicates and empties", () => {
  assert.deepEqual(
    dedupeLocations(["SF", "sf", "New York", "", null, "Remote", "remote"]),
    ["SF", "New York", "Remote"]
  );
});

test("safeJoinUrl joins path to base", () => {
  assert.equal(safeJoinUrl("https://x.com/", "/a/b"), "https://x.com/a/b");
  assert.equal(safeJoinUrl("https://x.com", "a/b"), "https://x.com/a/b");
  assert.equal(safeJoinUrl("https://x.com", "https://y.com/z"), "https://y.com/z");
  assert.equal(safeJoinUrl("", "a"), "a");
  assert.equal(safeJoinUrl("https://x.com", ""), "https://x.com");
});
