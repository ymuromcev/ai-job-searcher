const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  daysBetween,
  decideOutreachDate,
  selectStaleInFlight,
  epochDay,
  DEFAULT_THRESHOLD_DAYS,
} = require("./auto_dead.js");

// ---------- daysBetween / epochDay ----------

test("daysBetween: whole-day deltas, parse-tolerant", () => {
  assert.equal(daysBetween("2026-06-01", "2026-06-08"), 7);
  assert.equal(daysBetween("2026-06-01", "2026-06-01"), 0);
  assert.equal(daysBetween("2026-06-08", "2026-06-01"), -7);
  // Crosses a month boundary.
  assert.equal(daysBetween("2026-05-30", "2026-06-02"), 3);
});

test("daysBetween / epochDay: malformed or empty input returns null", () => {
  assert.equal(daysBetween("", "2026-06-08"), null);
  assert.equal(daysBetween("2026-06-08", ""), null);
  assert.equal(daysBetween("not-a-date", "2026-06-08"), null);
  assert.equal(daysBetween("2026-6-8", "2026-06-08"), null); // not strict YYYY-MM-DD
  assert.equal(epochDay(null), null);
  assert.equal(epochDay(undefined), null);
});

// ---------- selectStaleInFlight ----------

const today = "2026-06-10";

function row(overrides) {
  return {
    key: "lever:abc",
    status: "In flight",
    hm_outreach_date: "2026-06-01",
    notion_page_id: "page-1",
    ...overrides,
  };
}

test("selectStaleInFlight: exactly 7 days is stale (boundary inclusive)", () => {
  const apps = [row({ hm_outreach_date: "2026-06-03" })]; // 7 days before 06-10
  const stale = selectStaleInFlight(apps, today);
  assert.equal(stale.length, 1);
});

test("selectStaleInFlight: 8 days is stale", () => {
  const apps = [row({ hm_outreach_date: "2026-06-02" })]; // 8 days
  assert.equal(selectStaleInFlight(apps, today).length, 1);
});

test("selectStaleInFlight: 6 days is NOT stale (below threshold)", () => {
  const apps = [row({ hm_outreach_date: "2026-06-04" })]; // 6 days
  assert.equal(selectStaleInFlight(apps, today).length, 0);
});

test("selectStaleInFlight: empty anchor date is skipped (no timer)", () => {
  const apps = [row({ hm_outreach_date: "" })];
  assert.equal(selectStaleInFlight(apps, today).length, 0);
});

test("selectStaleInFlight: malformed anchor date is skipped", () => {
  const apps = [row({ hm_outreach_date: "garbage" })];
  assert.equal(selectStaleInFlight(apps, today).length, 0);
});

test("selectStaleInFlight: Replied is never selected even when old", () => {
  const apps = [row({ status: "Replied", hm_outreach_date: "2026-01-01" })];
  assert.equal(selectStaleInFlight(apps, today).length, 0);
});

test("selectStaleInFlight: already Dead is never selected (idempotent)", () => {
  const apps = [row({ status: "Dead", hm_outreach_date: "2026-01-01" })];
  assert.equal(selectStaleInFlight(apps, today).length, 0);
});

test("selectStaleInFlight: To do is never selected", () => {
  const apps = [row({ status: "To do", hm_outreach_date: "2026-01-01" })];
  assert.equal(selectStaleInFlight(apps, today).length, 0);
});

test("selectStaleInFlight: returns references to the original objects", () => {
  const r = row({ hm_outreach_date: "2026-06-01" });
  const stale = selectStaleInFlight([r], today);
  assert.equal(stale[0], r); // same reference, caller mutates in place
});

test("selectStaleInFlight: mixed batch picks only the stale In-flight rows", () => {
  const apps = [
    row({ key: "a", hm_outreach_date: "2026-06-01" }), // stale
    row({ key: "b", status: "Replied", hm_outreach_date: "2026-01-01" }),
    row({ key: "c", hm_outreach_date: "2026-06-09" }), // 1 day, fresh
    row({ key: "d", hm_outreach_date: "" }), // no anchor
    row({ key: "e", status: "To do" }),
  ];
  const stale = selectStaleInFlight(apps, today);
  assert.deepEqual(
    stale.map((s) => s.key),
    ["a"]
  );
});

test("selectStaleInFlight: custom threshold respected", () => {
  const apps = [row({ hm_outreach_date: "2026-06-08" })]; // 2 days
  assert.equal(selectStaleInFlight(apps, today, 2).length, 1);
  assert.equal(selectStaleInFlight(apps, today, 3).length, 0);
});

test("selectStaleInFlight: empty / null input is a no-op", () => {
  assert.deepEqual(selectStaleInFlight([], today), []);
  assert.deepEqual(selectStaleInFlight(null, today), []);
  assert.deepEqual(selectStaleInFlight(undefined, today), []);
});

test("DEFAULT_THRESHOLD_DAYS is 7", () => {
  assert.equal(DEFAULT_THRESHOLD_DAYS, 7);
});

// ---------- decideOutreachDate (transition stamp) ----------

test("decideOutreachDate: entering In flight with no anchor stamps today", () => {
  const d = decideOutreachDate("In flight", "", today);
  assert.deepEqual(d, { action: "stamp", date: today });
});

test("decideOutreachDate: entering In flight with an existing anchor keeps it", () => {
  const d = decideOutreachDate("In flight", "2026-06-01", today);
  assert.deepEqual(d, { action: "keep", date: "2026-06-01" });
});

test("decideOutreachDate: moving to To do clears an existing anchor", () => {
  const d = decideOutreachDate("To do", "2026-06-01", today);
  assert.deepEqual(d, { action: "clear", date: "" });
});

test("decideOutreachDate: To do with no anchor is a no-op keep", () => {
  const d = decideOutreachDate("To do", "", today);
  assert.deepEqual(d, { action: "keep", date: "" });
});

test("decideOutreachDate: terminal Replied leaves the date as-is", () => {
  const d = decideOutreachDate("Replied", "2026-06-01", today);
  assert.deepEqual(d, { action: "keep", date: "2026-06-01" });
});

test("decideOutreachDate: terminal Dead leaves the date as-is", () => {
  const d = decideOutreachDate("Dead", "2026-06-01", today);
  assert.deepEqual(d, { action: "keep", date: "2026-06-01" });
});

test("decideOutreachDate: re-entry after clear re-stamps today", () => {
  // To do clears → empty → In flight re-stamps.
  const cleared = decideOutreachDate("To do", "2026-06-01", today);
  assert.equal(cleared.date, "");
  const restamp = decideOutreachDate("In flight", cleared.date, today);
  assert.deepEqual(restamp, { action: "stamp", date: today });
});
