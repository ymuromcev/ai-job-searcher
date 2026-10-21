const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  scanRunsPath,
  buildRunEntries,
  parseRunLines,
  pruneEntries,
  readScanRuns,
  appendScanRuns,
} = require("./scan_health_log.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aijs-scan-health-log-"));
}

test("scanRunsPath lives under <profile>/.health", () => {
  assert.equal(scanRunsPath("/p/demo"), path.join("/p/demo", ".health", "scan_runs.jsonl"));
});

test("buildRunEntries: one entry per source, redacted and bounded errors", () => {
  const entries = buildRunEntries(
    {
      greenhouse: { total: 3, error: null },
      lever: { total: 0, error: `bad token SECRET ${"x".repeat(400)}` },
    },
    "2026-10-21T00:00:00Z",
    (s) => s.replace("SECRET", "***")
  );
  assert.deepEqual(entries[0], {
    ts: "2026-10-21T00:00:00Z",
    source: "greenhouse",
    found: 3,
    error: null,
  });
  assert.equal(entries[1].found, 0);
  assert.match(entries[1].error, /^bad token \*\*\* x+…$/);
  assert.ok(entries[1].error.length <= 300);
  assert.deepEqual(buildRunEntries(undefined, "t"), []);
});

test("parseRunLines skips malformed lines", () => {
  const text = [
    JSON.stringify({ ts: "2026-10-20T00:00:00Z", source: "lever", found: 2, error: null }),
    "{not json",
    JSON.stringify({ ts: "nope", source: "lever" }),
    JSON.stringify({ ts: "2026-10-20T00:00:00Z" }),
    "",
    JSON.stringify({ ts: "2026-10-21T00:00:00Z", source: "ashby", error: "boom" }),
  ].join("\n");
  assert.deepEqual(parseRunLines(text), [
    { ts: "2026-10-20T00:00:00Z", source: "lever", found: 2, error: null },
    { ts: "2026-10-21T00:00:00Z", source: "ashby", found: 0, error: "boom" },
  ]);
});

test("pruneEntries drops lines older than 60 days", () => {
  const now = Date.parse("2026-10-21T00:00:00Z");
  const kept = pruneEntries(
    [
      { ts: "2026-08-21T00:00:00Z", source: "a" }, // 61 days
      { ts: "2026-08-22T00:00:00Z", source: "b" }, // 60 days
      { ts: "2026-10-20T00:00:00Z", source: "c" },
    ],
    now
  );
  assert.deepEqual(
    kept.map((e) => e.source),
    ["b", "c"]
  );
});

test("appendScanRuns: creates the dir, appends, prunes old lines on write", () => {
  const root = tmpDir();
  const file = scanRunsPath(root);
  assert.deepEqual(readScanRuns(file), []);

  appendScanRuns(file, [{ ts: "2026-07-01T00:00:00Z", source: "old", found: 1, error: null }], {
    now: new Date("2026-07-01T00:00:00Z"),
  });
  appendScanRuns(file, [{ ts: "2026-10-20T00:00:00Z", source: "lever", found: 4, error: null }], {
    now: new Date("2026-10-20T00:00:00Z"),
  });
  const res = appendScanRuns(
    file,
    [{ ts: "2026-10-21T00:00:00Z", source: "ashby", found: 0, error: "x" }],
    { now: new Date("2026-10-21T00:00:00Z") }
  );
  assert.equal(res.added, 1);
  assert.deepEqual(
    readScanRuns(file).map((e) => e.source),
    ["lever", "ashby"]
  );
  assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"));
  // No temp files left behind.
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["scan_runs.jsonl"]);
});
