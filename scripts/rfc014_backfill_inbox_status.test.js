// Pure-planner tests for RFC 014 backfill.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { plan, applyPlan } = require("./rfc014_backfill_inbox_status.js");

function row(overrides) {
  return {
    key: "greenhouse:1",
    source: "greenhouse",
    jobId: "1",
    companyName: "Acme",
    title: "Senior PM",
    url: "https://example.com/1",
    location: "Remote",
    status: "To Apply",
    notion_page_id: "",
    resume_ver: "",
    cl_key: "",
    salary_min: "",
    salary_max: "",
    cl_path: "",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

test("plan: To Apply + no notion_page_id → Inbox", () => {
  const apps = [row({ key: "greenhouse:1" })];
  const { updates, counts } = plan(apps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].toStatus, "Inbox");
  assert.equal(counts.toMigrate, 1);
  assert.equal(counts.alreadyPrepared, 0);
  assert.equal(counts.other, 0);
});

test("plan: To Apply + notion_page_id set → keep (already prepared)", () => {
  const apps = [row({ key: "greenhouse:2", notion_page_id: "abc-123" })];
  const { updates, counts } = plan(apps);
  assert.equal(updates.length, 0);
  assert.equal(counts.toMigrate, 0);
  assert.equal(counts.alreadyPrepared, 1);
});

test("plan: other statuses untouched (Applied / Archived / Inbox already / etc.)", () => {
  const apps = [
    row({ key: "k1", status: "Applied" }),
    row({ key: "k2", status: "Archived" }),
    row({ key: "k3", status: "Rejected" }),
    row({ key: "k4", status: "Inbox" }), // already migrated — idempotent
    row({ key: "k5", status: "Interview", notion_page_id: "p" }),
  ];
  const { updates, counts } = plan(apps);
  assert.equal(updates.length, 0);
  assert.equal(counts.toMigrate, 0);
  assert.equal(counts.other, 5);
});

test("plan: mixed batch — counts each bucket correctly", () => {
  const apps = [
    row({ key: "k1" }), // toMigrate
    row({ key: "k2" }), // toMigrate
    row({ key: "k3", notion_page_id: "p" }), // alreadyPrepared
    row({ key: "k4", status: "Applied", notion_page_id: "p" }), // other
    row({ key: "k5", status: "Inbox" }), // other (already migrated)
  ];
  const { updates, counts } = plan(apps);
  assert.equal(counts.toMigrate, 2);
  assert.equal(counts.alreadyPrepared, 1);
  assert.equal(counts.other, 2);
  assert.equal(updates.length, 2);
  assert.deepEqual(
    updates.map((u) => u.key).sort(),
    ["k1", "k2"]
  );
});

test("applyPlan: rewrites only the planned rows + bumps updatedAt", () => {
  const apps = [
    row({ key: "k1" }), // will migrate
    row({ key: "k2", notion_page_id: "p" }), // keep
    row({ key: "k3", status: "Applied", notion_page_id: "p" }), // keep
  ];
  const { updates } = plan(apps);
  const now = "2026-05-04T12:00:00Z";
  const next = applyPlan(apps, updates, now);

  assert.equal(next.length, 3);
  assert.equal(next[0].status, "Inbox");
  assert.equal(next[0].updatedAt, now);
  assert.equal(next[1].status, "To Apply");
  assert.equal(next[1].updatedAt, "2026-04-01T00:00:00Z"); // unchanged
  assert.equal(next[2].status, "Applied");
});

test("applyPlan: idempotent — running on already-migrated TSV is a no-op", () => {
  const apps = [row({ key: "k1", status: "Inbox" })];
  const { updates } = plan(apps);
  assert.equal(updates.length, 0);
  const next = applyPlan(apps, updates, "2026-05-04T12:00:00Z");
  assert.deepEqual(next, apps);
});

test("plan: empty TSV — zero everywhere", () => {
  const { updates, counts } = plan([]);
  assert.equal(updates.length, 0);
  assert.equal(counts.total, 0);
  assert.equal(counts.toMigrate, 0);
});
