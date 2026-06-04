const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const apps = require("../engine/core/applications_tsv.js");
const { migrateOne, todayStamp } = require("./migrate_tsv_v4_to_v5.js");

function tmp() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aijs-mig-")), "applications.tsv");
}

function writeV4Fixture(tsvPath, rows) {
  const lines = [apps.HEADER_V4.join("\t")];
  for (const r of rows) lines.push(r.join("\t"));
  fs.writeFileSync(tsvPath, lines.join("\n") + "\n");
}

test("migrateOne: v4 → v5, drops backup, locations wrapped to single-element array", () => {
  const file = tmp();
  writeV4Fixture(file, [
    [
      "greenhouse:1",
      "greenhouse",
      "1",
      "Affirm",
      "PM",
      "https://x/1",
      "San Francisco, CA",
      "To Apply",
      "page-1",
      "Risk_Fraud",
      "cl_key1",
      "140000",
      "190000",
      "Affirm_analyst_20260420",
      "2026-04-20T00:00:00Z",
      "2026-04-20T00:00:00Z",
      "Strong",
      "Great fit",
      "2026-05-05T00:00:00Z",
      "",
    ],
    [
      "lever:2",
      "lever",
      "2",
      "Stripe",
      "Senior PM",
      "https://x/2",
      "",
      "Inbox",
      "",
      "",
      "",
      "",
      "",
      "",
      "2026-04-21T00:00:00Z",
      "2026-04-21T00:00:00Z",
      "",
      "",
      "",
      "",
    ],
  ]);

  const now = new Date("2026-05-18T00:00:00Z");
  const res = migrateOne(file, { apply: true, now });
  assert.equal(res.status, "migrated");
  assert.equal(res.fromVersion, 4);
  assert.equal(res.rows, 2);
  assert.equal(res.backupPath, `${file}.pre-v5-${todayStamp(now)}`);
  assert.ok(fs.existsSync(res.backupPath), "backup file must exist");

  // File on disk now reads as the current schema (v7 — save() always writes
  // the latest header; the v4→v5 location-wrap is still applied en route).
  const back = apps.load(file);
  assert.equal(back.schemaVersion, 7);
  assert.deepEqual(back.apps[0].locations, ["San Francisco, CA"]);
  assert.deepEqual(back.apps[1].locations, []);
  assert.equal(back.apps[0].fit_score, "Strong");
  assert.equal(back.apps[0].notion_page_id, "page-1");

  // Backup still holds the original v4 header.
  const backupRaw = fs.readFileSync(res.backupPath, "utf8");
  assert.ok(backupRaw.startsWith(apps.HEADER_V4.join("\t")), "backup retains v4 header");
});

test("migrateOne: idempotent — already-v5 file is a no-op", () => {
  const file = tmp();
  // Write a v5 file directly via save().
  apps.save(file, [
    {
      key: "greenhouse:1",
      source: "greenhouse",
      jobId: "1",
      companyName: "Affirm",
      title: "PM",
      url: "https://x/1",
      locations: ["Remote", "United States"],
      status: "Inbox",
      notion_page_id: "",
      resume_ver: "",
      cl_key: "",
      salary_min: "",
      salary_max: "",
      cl_path: "",
      createdAt: "2026-05-18T00:00:00Z",
      updatedAt: "2026-05-18T00:00:00Z",
      fit_score: "",
      fit_rationale: "",
      fit_evaluated_at: "",
      skip_reason: "",
    },
  ]);
  const now = new Date("2026-05-18T00:00:00Z");
  const res = migrateOne(file, { apply: true, now });
  assert.equal(res.status, "already_v5");
  assert.equal(res.rows, 1);
  // No backup written when there's nothing to migrate.
  assert.equal(fs.existsSync(`${file}.pre-v5-${todayStamp(now)}`), false);
});

test("migrateOne: dry-run reports would_migrate without touching files", () => {
  const file = tmp();
  writeV4Fixture(file, [
    [
      "greenhouse:1",
      "greenhouse",
      "1",
      "Affirm",
      "PM",
      "https://x/1",
      "Remote",
      "Inbox",
      "",
      "",
      "",
      "",
      "",
      "",
      "2026-04-20T00:00:00Z",
      "2026-04-20T00:00:00Z",
      "",
      "",
      "",
      "",
    ],
  ]);
  const before = fs.readFileSync(file, "utf8");
  const now = new Date("2026-05-18T00:00:00Z");
  const res = migrateOne(file, { apply: false, now });
  assert.equal(res.status, "would_migrate");
  assert.equal(res.fromVersion, 4);
  assert.equal(res.rows, 1);
  // File on disk is untouched.
  assert.equal(fs.readFileSync(file, "utf8"), before);
  // No backup file produced.
  assert.equal(fs.existsSync(`${file}.pre-v5-${todayStamp(now)}`), false);
});

test("migrateOne: missing file returns status=missing", () => {
  const res = migrateOne("/tmp/does-not-exist-aijs-mig.tsv", { apply: true });
  assert.equal(res.status, "missing");
});

// Golden test: a v4 row with a multi-element discovery `locations[]` would
// have been collapsed to locations[0] at scan time (pre-v5 appendNew). The
// migration cannot recover the lost elements, but it must wrap whatever
// single-string remains into a single-element array — and any downstream
// scan after the migration will repopulate the row with the full array.
test("migrateOne: v4 single-string location wraps as single-element array (lossy historic)", () => {
  const file = tmp();
  writeV4Fixture(file, [
    [
      "greenhouse:1",
      "greenhouse",
      "1",
      "Affirm",
      "PM",
      "https://x/1",
      "Remote (UK)", // pre-v5 lost the "United States" element here
      "Inbox",
      "",
      "",
      "",
      "",
      "",
      "",
      "2026-04-20T00:00:00Z",
      "2026-04-20T00:00:00Z",
      "",
      "",
      "",
      "",
    ],
  ]);
  const now = new Date("2026-05-18T00:00:00Z");
  migrateOne(file, { apply: true, now });
  const back = apps.load(file);
  assert.deepEqual(back.apps[0].locations, ["Remote (UK)"]);
});
