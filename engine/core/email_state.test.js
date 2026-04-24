const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  loadProcessed,
  saveProcessed,
  computeCursorEpoch,
  loadContext,
  saveContext,
  loadRawEmails,
  MAX_DAYS,
} = require("./email_state.js");

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "emstate-")), name);
}

test("loadProcessed: missing file → empty state", () => {
  const fp = tmpFile("p.json");
  const s = loadProcessed(fp);
  assert.deepEqual(s, { processed: [], last_check: null });
});

test("saveProcessed: creates dir, dedups, prunes, sets last_check", () => {
  const fp = tmpFile("p.json");
  const oldDate = new Date(Date.now() - 40 * 86400 * 1000).toISOString(); // > 30d
  const recent = new Date().toISOString();
  const existing = {
    processed: [
      { id: "a", date: oldDate, company: "X", type: "OTHER" },
      { id: "b", date: recent, company: "Y", type: "REJECTION" },
    ],
    last_check: null,
  };
  const saved = saveProcessed(fp, existing, [
    { id: "b", date: recent, company: "Y", type: "REJECTION" }, // dup
    { id: "c", date: recent, company: "Z", type: "REJECTION" },
  ]);
  assert.equal(saved.processed.length, 2, "old entry pruned, dup not added");
  const ids = saved.processed.map((e) => e.id).sort();
  assert.deepEqual(ids, ["b", "c"]);
  assert.ok(saved.last_check);
  assert.ok(fs.existsSync(fp));
});

test("saveProcessed: round-trip via load", () => {
  const fp = tmpFile("p.json");
  saveProcessed(fp, null, [
    { id: "x", date: new Date().toISOString(), company: "A", type: "OTHER" },
  ]);
  const loaded = loadProcessed(fp);
  assert.equal(loaded.processed.length, 1);
  assert.equal(loaded.processed[0].id, "x");
});

test("computeCursorEpoch: no last_check → now - 30d", () => {
  const now = new Date("2026-04-20T12:00:00Z");
  const ep = computeCursorEpoch({ lastCheck: null, now });
  const expected = Math.floor(now.getTime() / 1000) - MAX_DAYS * 86400;
  assert.equal(ep, expected);
});

test("computeCursorEpoch: recent last_check wins over 30d floor", () => {
  const now = new Date("2026-04-20T12:00:00Z");
  const lastCheck = new Date("2026-04-19T12:00:00Z").toISOString();
  const ep = computeCursorEpoch({ lastCheck, now });
  assert.equal(ep, Math.floor(new Date(lastCheck).getTime() / 1000));
});

test("computeCursorEpoch: old last_check clamps to 30d floor", () => {
  const now = new Date("2026-04-20T12:00:00Z");
  const lastCheck = new Date("2026-01-01T12:00:00Z").toISOString();
  const ep = computeCursorEpoch({ lastCheck, now });
  const floor = Math.floor(now.getTime() / 1000) - MAX_DAYS * 86400;
  assert.equal(ep, floor);
});

test("computeCursorEpoch: --since override applies with same 30d clamp", () => {
  const now = new Date("2026-04-20T12:00:00Z");
  const ep = computeCursorEpoch({ sinceIso: "2026-04-15T00:00:00Z", now });
  assert.equal(ep, Math.floor(new Date("2026-04-15T00:00:00Z").getTime() / 1000));
});

test("saveContext / loadContext round-trip", () => {
  const fp = tmpFile("ctx.json");
  saveContext(fp, { epoch: 123, batches: ["a", "b"] });
  const ctx = loadContext(fp);
  assert.deepEqual(ctx, { epoch: 123, batches: ["a", "b"] });
});

test("loadContext: missing → null", () => {
  assert.equal(loadContext(tmpFile("missing.json")), null);
});

test("loadRawEmails: missing → []", () => {
  assert.deepEqual(loadRawEmails(tmpFile("missing.json")), []);
});

test("loadRawEmails: reads array", () => {
  const fp = tmpFile("raw.json");
  fs.writeFileSync(fp, JSON.stringify([{ messageId: "1" }]));
  assert.deepEqual(loadRawEmails(fp), [{ messageId: "1" }]);
});
