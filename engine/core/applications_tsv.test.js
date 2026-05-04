const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const apps = require("./applications_tsv.js");

function tmp() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aijs-apps-")), "applications.tsv");
}

function fixtureJob(overrides = {}) {
  return {
    source: "greenhouse",
    jobId: "1",
    companyName: "Affirm",
    title: "Senior PM",
    url: "https://x/1",
    locations: ["SF"],
    team: "Product",
    postedAt: "2026-04-15",
    rawExtra: {},
    slug: "affirm",
    ...overrides,
  };
}

test("load returns empty when file missing", () => {
  const { apps: out } = apps.load("/tmp/does-not-exist-aijs-apps.tsv");
  assert.deepEqual(out, []);
});

test("appendNew adds previously-unseen jobs as 'To Apply' entries (default status)", () => {
  const result = apps.appendNew([], [fixtureJob(), fixtureJob({ jobId: "2" })], {
    now: "2026-04-20T00:00:00Z",
  });
  assert.equal(result.apps.length, 2);
  assert.equal(result.fresh.length, 2);
  assert.equal(result.apps[0].key, "greenhouse:1");
  // 8-status set has no "Inbox"; fresh rows start as "To Apply" with no notion_page_id.
  assert.equal(result.apps[0].status, "To Apply");
  assert.equal(result.apps[0].notion_page_id, "");
  assert.equal(result.apps[0].createdAt, "2026-04-20T00:00:00Z");
});

test("appendNew skips duplicates by (source, jobId)", () => {
  const existing = [
    {
      key: "greenhouse:1",
      source: "greenhouse",
      jobId: "1",
      companyName: "X",
      title: "X",
      url: "x",
      status: "Applied",
      notion_page_id: "abc",
      resume_ver: "v1",
      cl_key: "k1",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-02",
    },
  ];
  const result = apps.appendNew(existing, [fixtureJob({ jobId: "1" }), fixtureJob({ jobId: "2" })]);
  assert.equal(result.fresh.length, 1);
  assert.equal(result.apps.length, 2);
  // existing entry must be preserved verbatim (status="Applied", not overwritten).
  assert.equal(result.apps[0].status, "Applied");
});

test("save + load round-trips entries", () => {
  const file = tmp();
  const { apps: built } = apps.appendNew([], [fixtureJob()], { now: "2026-04-20T00:00:00Z" });
  apps.save(file, built);
  const back = apps.load(file).apps;
  assert.equal(back.length, 1);
  assert.equal(back[0].companyName, "Affirm");
});

test("load throws on header mismatch", () => {
  const file = tmp();
  fs.writeFileSync(file, "wrong\theader\n");
  assert.throws(() => apps.load(file), /header mismatch/);
});

test("appendNew initializes salary_min/salary_max/cl_path as empty strings", () => {
  const r = apps.appendNew([], [fixtureJob()], { now: "2026-04-20T00:00:00Z" });
  assert.equal(r.apps[0].salary_min, "");
  assert.equal(r.apps[0].salary_max, "");
  assert.equal(r.apps[0].cl_path, "");
});

test("save + load round-trips v3 fields (salary_min, salary_max, cl_path, location)", () => {
  const file = tmp();
  const { apps: built } = apps.appendNew([], [fixtureJob()], { now: "2026-04-20T00:00:00Z" });
  built[0].salary_min = "140000";
  built[0].salary_max = "190000";
  built[0].cl_path = "Affirm_analyst_20260420";
  built[0].location = "San Francisco, CA";
  apps.save(file, built);
  const back = apps.load(file);
  assert.equal(back.schemaVersion, 3);
  assert.equal(back.apps[0].salary_min, "140000");
  assert.equal(back.apps[0].salary_max, "190000");
  assert.equal(back.apps[0].cl_path, "Affirm_analyst_20260420");
  assert.equal(back.apps[0].location, "San Francisco, CA");
});

test("load auto-upgrades v1 files (12 cols) with empty v2+v3 fields", () => {
  const file = tmp();
  const v1Header = apps.HEADER_V1.join("\t");
  const v1Row = [
    "greenhouse:1", "greenhouse", "1", "Affirm", "PM", "https://x/1",
    "To Apply", "abc", "Risk_Fraud", "cl_key1",
    "2026-01-01", "2026-01-02",
  ].join("\t");
  fs.writeFileSync(file, `${v1Header}\n${v1Row}\n`);

  const back = apps.load(file);
  assert.equal(back.schemaVersion, 1);
  assert.equal(back.apps.length, 1);
  assert.equal(back.apps[0].salary_min, "");
  assert.equal(back.apps[0].salary_max, "");
  assert.equal(back.apps[0].cl_path, "");
  assert.equal(back.apps[0].location, "");
  assert.equal(back.apps[0].status, "To Apply");
  assert.equal(back.apps[0].notion_page_id, "abc");

  // Re-saving promotes the file to v3.
  apps.save(file, back.apps);
  const after = apps.load(file);
  assert.equal(after.schemaVersion, 3);
});

test("load auto-upgrades v2 files (15 cols) with empty location", () => {
  const file = tmp();
  const v2Header = apps.HEADER_V2.join("\t");
  const v2Row = [
    "greenhouse:1", "greenhouse", "1", "Affirm", "PM", "https://x/1",
    "To Apply", "abc", "Risk_Fraud", "cl_key1",
    "140000", "190000", "Affirm_analyst_20260420",
    "2026-01-01", "2026-01-02",
  ].join("\t");
  fs.writeFileSync(file, `${v2Header}\n${v2Row}\n`);

  const back = apps.load(file);
  assert.equal(back.schemaVersion, 2);
  assert.equal(back.apps.length, 1);
  assert.equal(back.apps[0].location, "");
  assert.equal(back.apps[0].salary_min, "140000");
  assert.equal(back.apps[0].cl_path, "Affirm_analyst_20260420");

  // Re-saving promotes to v3.
  apps.save(file, back.apps);
  const after = apps.load(file);
  assert.equal(after.schemaVersion, 3);
});

test("appendNew copies first locations entry to row.location, falls back to ''", () => {
  const r = apps.appendNew(
    [],
    [
      fixtureJob({ jobId: "10", locations: ["Remote", "NYC"] }),
      fixtureJob({ jobId: "11", locations: [] }),
      fixtureJob({ jobId: "12", locations: undefined }),
    ],
    { now: "2026-04-20T00:00:00Z" }
  );
  assert.equal(r.apps[0].location, "Remote");
  assert.equal(r.apps[1].location, "");
  assert.equal(r.apps[2].location, "");
});
