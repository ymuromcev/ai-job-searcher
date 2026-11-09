// applications_tsv: cross-process writes (BL-225 review) — snapshotRows /
// mergeRowChanges (pure) and withLock / update on a real temp file.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tsv = require("./applications_tsv.js");

function row(key, over = {}) {
  return {
    key,
    source: "greenhouse",
    jobId: key,
    companyName: "Acme",
    title: "PM",
    url: "",
    locations: [],
    status: "To Apply",
    applied_date: "",
    apply_state: "",
    apply_note: "",
    ...over,
  };
}

test("mergeRowChanges: only this writer's per-row changes land on the fresh rows", () => {
  const loaded = [row("a"), row("b"), row("c")];
  const snap = tsv.snapshotRows(loaded);
  const working = tsv.snapshotRows(loaded); // independent copies
  const mine = [...working.values()];
  mine[0].apply_state = "queued"; // a: changed by me
  mine[1].fit_score = "Strong"; // b: changed by me, other field changed by someone else
  // c: untouched by me; someone else changed it
  const fresh = [
    row("a"),
    row("b", { cl_path: "cover_letters/b.pdf" }),
    row("c", { status: "Archived" }),
    row("d"), // added by another writer
  ];
  const m = tsv.mergeRowChanges(fresh, mine, snap);
  const by = Object.fromEntries(m.apps.map((a) => [a.key, a]));
  assert.equal(by.a.apply_state, "queued");
  assert.equal(by.b.fit_score, "Strong");
  assert.equal(by.b.cl_path, "cover_letters/b.pdf", "the other writer's field is kept");
  assert.equal(by.c.status, "Archived");
  assert.ok(by.d, "rows added meanwhile are kept");
  assert.deepEqual(m.conflicts, []);
});

test("mergeRowChanges: a row submitted meanwhile is never overwritten", () => {
  for (const submitted of [
    { status: "Applied", applied_date: "2026-11-10", apply_state: "submitted" },
    { apply_state: "queued", apply_note: "submitting:2026-11-10T03:00:00Z" },
    { applied_date: "2026-11-10" },
  ]) {
    const loaded = [row("a")];
    const snap = tsv.snapshotRows(loaded);
    const mine = [{ ...loaded[0], apply_state: "skipped", apply_note: "captcha" }];
    const fresh = [row("a", submitted)];
    const m = tsv.mergeRowChanges(fresh, mine, snap);
    assert.deepEqual(m.conflicts, ["a"]);
    assert.deepEqual(m.apps[0], fresh[0], JSON.stringify(submitted));
  }
});

test("mergeRowChanges: an Applied row nobody else touched still takes my change", () => {
  const loaded = [row("a", { status: "Applied", applied_date: "2026-10-01" })];
  const snap = tsv.snapshotRows(loaded);
  const mine = [{ ...loaded[0], cl_path: "cover_letters/archive/a.pdf" }];
  const m = tsv.mergeRowChanges(
    [row("a", { status: "Applied", applied_date: "2026-10-01" })],
    mine,
    snap
  );
  assert.equal(m.apps[0].cl_path, "cover_letters/archive/a.pdf");
  assert.deepEqual(m.conflicts, []);
});

test("mergeRowChanges: new rows append; rows I dropped go only if nobody changed them", () => {
  const loaded = [row("a"), row("b")];
  const snap = tsv.snapshotRows(loaded);
  const mine = [row("new")]; // dropped a and b
  const fresh = [row("a"), row("b", { status: "Applied", apply_state: "submitted" })];
  const m = tsv.mergeRowChanges(fresh, mine, snap);
  assert.deepEqual(m.apps.map((a) => a.key).sort(), ["b", "new"]);
  assert.deepEqual(m.conflicts, ["b"]);
});

test("update / withLock: load → mutate → save under the lock file, lock removed after", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apps-lock-"));
  const file = path.join(dir, "applications.tsv");
  tsv.save(file, [row("a")]);
  let sawLock = false;
  await tsv.update(file, (apps) => {
    sawLock = fs.existsSync(tsv.lockPathFor(file));
    apps[0].apply_state = "queued";
  });
  assert.equal(sawLock, true);
  assert.equal(fs.existsSync(tsv.lockPathFor(file)), false);
  assert.equal(tsv.load(file).apps[0].apply_state, "queued");
  // Parallel writers in one process serialize: no lost update.
  await Promise.all(
    ["x", "y", "z"].map((k) =>
      tsv.update(file, async (apps) => {
        await new Promise((r) => setTimeout(r, 5));
        apps.push(row(k));
      })
    )
  );
  assert.deepEqual(
    tsv
      .load(file)
      .apps.map((a) => a.key)
      .sort(),
    ["a", "x", "y", "z"]
  );
});
