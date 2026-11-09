const { test } = require("node:test");
const assert = require("node:assert/strict");

const rm = require("./ready_manifest.js");

const local = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

test("buildManifest: the RFC 069 contract, rows deduped in order", () => {
  const m = rm.buildManifest({
    stamp: "s1",
    answersDir: "/a",
    deadline: "2026-11-10T19:00:00.000Z",
    rows: ["k2", "k1", "k2", "", null],
    createdAt: "2026-11-10T10:00:00.000Z",
  });
  assert.deepEqual(m, {
    stamp: "s1",
    answers_dir: "/a",
    deadline: "2026-11-10T19:00:00.000Z",
    rows: ["k2", "k1"],
    created_at: "2026-11-10T10:00:00.000Z",
  });
  assert.deepEqual(Object.keys(m), ["stamp", "answers_dir", "deadline", "rows", "created_at"]);
});

test("parseManifest: rejects a manifest without stamp / answers_dir / ISO deadline / rows", () => {
  assert.deepEqual(rm.parseManifest(null).problems, ["not a JSON object"]);
  const bad = rm.parseManifest({ stamp: "", answers_dir: "", deadline: "soon", rows: "k" });
  assert.equal(bad.manifest, null);
  assert.equal(bad.problems.length, 4);
  const ok = rm.parseManifest({
    stamp: "s",
    answers_dir: "/a",
    deadline: "2026-11-10T19:00:00Z",
    rows: ["k"],
    extra: 1,
  });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.manifest.rows, ["k"]);
});

test("orderManifestNames: stamp order, no tmp or hidden files", () => {
  assert.deepEqual(
    rm.orderManifestNames([
      "2026-11-10T03-00-00-000Z.json",
      "2026-11-10T02-00-00-000Z.json",
      "2026-11-10T04-00-00-000Z.json.tmp.123.456",
      ".DS_Store",
      "claimed",
      "done",
    ]),
    ["2026-11-10T02-00-00-000Z.json", "2026-11-10T03-00-00-000Z.json"]
  );
});

test("parseWindow: HH:MM-HH:MM, default 02:00-11:00", () => {
  assert.deepEqual(rm.parseWindow(""), { start: 120, end: 660, text: "02:00-11:00" });
  assert.deepEqual(rm.parseWindow("22:30-06:00"), { start: 1350, end: 360, text: "22:30-06:00" });
  for (const bad of ["2-11", "02:00", "02:00-02:00", "25:00-11:00", "02:00-11:60"]) {
    assert.throws(() => rm.parseWindow(bad), /apply_window/, bad);
  }
});

test("windowState: open inside 02:00-11:00, lastClose names the morning", () => {
  const w = rm.parseWindow("02:00-11:00");
  const before = rm.windowState(local(2026, 11, 10, 1, 59), w);
  assert.equal(before.open, false);
  assert.equal(before.lastClose.getTime(), local(2026, 11, 9, 11).getTime());
  assert.equal(before.lastCloseDate, "2026-11-09");

  const inside = rm.windowState(local(2026, 11, 10, 2), w);
  assert.equal(inside.open, true);
  assert.equal(inside.closesAt.getTime(), local(2026, 11, 10, 11).getTime());

  const after = rm.windowState(local(2026, 11, 10, 11), w);
  assert.equal(after.open, false, "the close minute is outside");
  assert.equal(after.lastCloseDate, "2026-11-10");
  assert.equal(after.closesAt.getTime(), local(2026, 11, 11, 11).getTime());
});

test("windowState: a window across midnight", () => {
  const w = rm.parseWindow("22:00-06:00");
  assert.equal(rm.windowState(local(2026, 11, 10, 23), w).open, true);
  assert.equal(
    rm.windowState(local(2026, 11, 10, 23), w).closesAt.getTime(),
    local(2026, 11, 11, 6).getTime()
  );
  assert.equal(rm.windowState(local(2026, 11, 11, 5, 59), w).open, true);
  assert.equal(rm.windowState(local(2026, 11, 11, 12), w).open, false);
});

test("effectiveDeadline: the earlier of the manifest deadline and the window close", () => {
  const ws = rm.windowState(local(2026, 11, 10, 3), "02:00-11:00");
  const early = local(2026, 11, 10, 9);
  assert.equal(
    rm.effectiveDeadline({ deadline: early.toISOString() }, ws).getTime(),
    early.getTime()
  );
  const late = local(2026, 11, 10, 13);
  assert.equal(
    rm.effectiveDeadline({ deadline: late.toISOString() }, ws).getTime(),
    local(2026, 11, 10, 11).getTime()
  );
});
