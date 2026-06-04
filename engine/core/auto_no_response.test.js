const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  daysBetween,
  decideAppliedDate,
  selectStaleApplied,
  epochDay,
  DEFAULT_THRESHOLD_DAYS,
} = require("./auto_no_response.js");

// ---------- shared date math (re-exported from auto_dead) ----------

test("daysBetween / epochDay are the shared auto_dead helpers", () => {
  assert.equal(daysBetween("2026-06-01", "2026-06-15"), 14);
  assert.equal(epochDay("not-a-date"), null);
});

// ---------- selectStaleApplied ----------

const today = "2026-06-15";

function row(overrides) {
  return {
    key: "lever:abc",
    status: "Applied",
    applied_date: "2026-06-01",
    notion_page_id: "page-1",
    ...overrides,
  };
}

test("selectStaleApplied: exactly 14 days is stale (boundary inclusive)", () => {
  const apps = [row({ applied_date: "2026-06-01" })]; // 14 days before 06-15
  const stale = selectStaleApplied(apps, today);
  assert.equal(stale.length, 1);
});

test("selectStaleApplied: 15 days is stale", () => {
  const apps = [row({ applied_date: "2026-05-31" })]; // 15 days
  assert.equal(selectStaleApplied(apps, today).length, 1);
});

test("selectStaleApplied: 13 days is NOT stale (below threshold)", () => {
  const apps = [row({ applied_date: "2026-06-02" })]; // 13 days
  assert.equal(selectStaleApplied(apps, today).length, 0);
});

test("selectStaleApplied: empty anchor date is skipped (no timer)", () => {
  const apps = [row({ applied_date: "" })];
  assert.equal(selectStaleApplied(apps, today).length, 0);
});

test("selectStaleApplied: malformed anchor date is skipped", () => {
  const apps = [row({ applied_date: "garbage" })];
  assert.equal(selectStaleApplied(apps, today).length, 0);
});

test("selectStaleApplied: No Response is never selected (idempotent)", () => {
  const apps = [row({ status: "No Response", applied_date: "2026-01-01" })];
  assert.equal(selectStaleApplied(apps, today).length, 0);
});

test("selectStaleApplied: non-Applied statuses are never selected", () => {
  for (const status of ["Interview", "Offer", "Rejected", "To Apply", "Inbox", "Archived"]) {
    const apps = [row({ status, applied_date: "2026-01-01" })];
    assert.equal(selectStaleApplied(apps, today).length, 0, `${status} must never be selected`);
  }
});

test("selectStaleApplied: returns references to the original objects", () => {
  const r = row({ applied_date: "2026-06-01" });
  const stale = selectStaleApplied([r], today);
  assert.equal(stale[0], r); // same reference, caller mutates in place
});

test("selectStaleApplied: mixed batch picks only the stale Applied rows", () => {
  const apps = [
    row({ key: "a", applied_date: "2026-06-01" }), // 14d → stale
    row({ key: "b", status: "Interview", applied_date: "2026-01-01" }),
    row({ key: "c", applied_date: "2026-06-10" }), // 5 days, fresh
    row({ key: "d", applied_date: "" }), // no anchor
    row({ key: "e", status: "No Response", applied_date: "2026-01-01" }),
  ];
  const stale = selectStaleApplied(apps, today);
  assert.deepEqual(
    stale.map((s) => s.key),
    ["a"]
  );
});

test("selectStaleApplied: custom threshold respected", () => {
  const apps = [row({ applied_date: "2026-06-13" })]; // 2 days
  assert.equal(selectStaleApplied(apps, today, 2).length, 1);
  assert.equal(selectStaleApplied(apps, today, 3).length, 0);
});

test("selectStaleApplied: empty / null input is a no-op", () => {
  assert.deepEqual(selectStaleApplied([], today), []);
  assert.deepEqual(selectStaleApplied(null, today), []);
  assert.deepEqual(selectStaleApplied(undefined, today), []);
});

test("DEFAULT_THRESHOLD_DAYS is 14", () => {
  assert.equal(DEFAULT_THRESHOLD_DAYS, 14);
});

// ---------- decideAppliedDate (transition stamp) ----------

test("decideAppliedDate: entering Applied with no anchor stamps today", () => {
  const d = decideAppliedDate("Applied", "", today);
  assert.deepEqual(d, { action: "stamp", date: today });
});

test("decideAppliedDate: entering Applied with an existing anchor keeps it", () => {
  const d = decideAppliedDate("Applied", "2026-06-01", today);
  assert.deepEqual(d, { action: "keep", date: "2026-06-01" });
});

test("decideAppliedDate: non-Applied status with empty anchor is a no-op keep", () => {
  const d = decideAppliedDate("To Apply", "", today);
  assert.deepEqual(d, { action: "keep", date: "" });
});

test("decideAppliedDate: moving forward out of Applied leaves the anchor as-is", () => {
  for (const status of ["Interview", "Offer", "Rejected", "No Response"]) {
    const d = decideAppliedDate(status, "2026-06-01", today);
    assert.deepEqual(d, { action: "keep", date: "2026-06-01" }, `${status} keeps the anchor`);
  }
});

test("decideAppliedDate: never re-stamps even if today differs from the anchor", () => {
  const d = decideAppliedDate("Applied", "2026-05-01", today);
  assert.equal(d.action, "keep");
  assert.equal(d.date, "2026-05-01");
});
