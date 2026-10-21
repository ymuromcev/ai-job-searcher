const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const log = require("./night_runs_log.js");

test("buildNightEntry: flat counts from the TSV + apply summaries", () => {
  const e = log.buildNightEntry({
    startedAt: "2026-10-22T05:00:00.000Z",
    finishedAt: "2026-10-22T13:30:00.000Z",
    target: 100,
    tsv: { scanned: 210, prepared: { total: 64, strong: 12, medium: 30, weak: 22 } },
    apply: { applyRounds: 3, queued: 45, submitted: 38, manual: 5, failed: 2, deferred: 4 },
    stopReason: "deadline",
  });
  assert.deepEqual(e, {
    started_at: "2026-10-22T05:00:00.000Z",
    finished_at: "2026-10-22T13:30:00.000Z",
    target: 100,
    scanned: 210,
    prepared: 64,
    strong: 12,
    medium: 30,
    weak: 22,
    queued: 45,
    submitted: 38,
    manual: 5,
    failed: 2,
    deferred: 4,
    apply_rounds: 3,
    stop_reason: "deadline",
  });
  const empty = log.buildNightEntry({ startedAt: "s", finishedAt: "f", stopReason: "" });
  assert.equal(empty.submitted, 0);
  assert.equal(empty.stop_reason, "unknown");
});

test("parseNightLines: tolerant of torn lines and junk values", () => {
  const text = [
    JSON.stringify({ started_at: "2026-10-22T05:00:00Z", submitted: 7, stop_reason: "deadline" }),
    "{torn",
    JSON.stringify({ started_at: "not a date", submitted: 1 }),
    JSON.stringify({ started_at: "2026-10-23T05:00:00Z", submitted: -4, manual: "x" }),
    "",
  ].join("\n");
  const out = log.parseNightLines(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].submitted, 7);
  assert.equal(out[0].finished_at, "");
  assert.equal(out[1].submitted, 0);
  assert.equal(out[1].manual, 0);
  assert.equal(out[1].stop_reason, "unknown");
});

test("appendNightRun: appends one line, prunes old nights, missing file reads as []", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aijs-nightlog-"));
  const file = log.nightRunsPath(dir);
  assert.equal(file, path.join(dir, ".health", "apply_runs.jsonl"));
  assert.deepEqual(log.readNightRuns(file), []);

  const now = new Date("2026-10-22T14:00:00Z");
  const old = log.buildNightEntry({
    startedAt: "2026-01-01T05:00:00.000Z",
    finishedAt: "2026-01-01T13:00:00.000Z",
    stopReason: "deadline",
  });
  log.appendNightRun(file, old, { now: new Date("2026-01-02T00:00:00Z") });
  const entry = log.buildNightEntry({
    startedAt: "2026-10-22T05:00:00.000Z",
    finishedAt: "2026-10-22T13:30:00.000Z",
    apply: { submitted: 3 },
    stopReason: "target_reached",
  });
  const res = log.appendNightRun(file, entry, { now });
  assert.equal(res.kept, 0, "a night older than 180 days is dropped");
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).submitted, 3);
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)),
    ["apply_runs.jsonl"],
    "no temp files left behind"
  );
});
