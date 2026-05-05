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
  const result = apps.appendNew(
    [],
    [fixtureJob(), fixtureJob({ jobId: "2", title: "Staff PM" })],
    { now: "2026-04-20T00:00:00Z" }
  );
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
  // Distinct titles so the post-G-4 fuzzy-dedup doesn't collapse them.
  const r = apps.appendNew(
    [],
    [
      fixtureJob({ jobId: "10", title: "Senior PM", locations: ["Remote", "NYC"] }),
      fixtureJob({ jobId: "11", title: "Staff PM", locations: [] }),
      fixtureJob({ jobId: "12", title: "Lead PM", locations: undefined }),
    ],
    { now: "2026-04-20T00:00:00Z" }
  );
  assert.equal(r.apps[0].location, "Remote");
  assert.equal(r.apps[1].location, "");
  assert.equal(r.apps[2].location, "");
});

// G-4: cross-platform fuzzy dedup. Same role posted on a different ATS than the
// row already in applications.tsv must be skipped, even with a different
// source:jobId. Catches post-migration drift between pool and applications.
test("appendNew skips fuzzy duplicates of existing apps (cross-platform GH→Lever)", () => {
  const existing = [
    {
      key: "greenhouse:gh-1",
      source: "greenhouse",
      jobId: "gh-1",
      companyName: "Stripe",
      title: "Senior PM",
      url: "https://boards.greenhouse.io/stripe/gh-1",
      status: "Applied",
      notion_page_id: "abc",
      resume_ver: "v1",
      cl_key: "k1",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-02",
    },
  ];
  const incoming = [
    fixtureJob({ source: "lever", jobId: "lv-9", companyName: "Stripe, Inc.", title: "Senior PM", url: "https://jobs.lever.co/stripe/lv-9" }),
    fixtureJob({ source: "lever", jobId: "lv-10", companyName: "Stripe", title: "Staff PM", url: "https://jobs.lever.co/stripe/lv-10" }),
  ];
  const r = apps.appendNew(existing, incoming, { now: "2026-04-20T00:00:00Z" });
  assert.equal(r.fresh.length, 1, "Senior PM cross-platform dup must be skipped");
  assert.equal(r.fresh[0].jobId, "lv-10");
  assert.equal(r.fuzzyDuplicates.length, 1);
  assert.equal(r.fuzzyDuplicates[0].key, "lever:lv-9");
});

test("appendNew fuzzy-dedup does not over-match when company or title is missing", () => {
  // Feed adapters (remoteok) sometimes lack companyName — must not collide on
  // empty fuzzyKey.
  const existing = [
    {
      key: "remoteok:1",
      source: "remoteok",
      jobId: "1",
      companyName: "",
      title: "",
      url: "x",
      status: "To Apply",
      notion_page_id: "",
      resume_ver: "",
      cl_key: "",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
  ];
  const r = apps.appendNew(
    existing,
    [
      fixtureJob({ source: "remoteok", jobId: "2", companyName: "", title: "" }),
    ],
    { now: "2026-04-20T00:00:00Z" }
  );
  assert.equal(r.fresh.length, 1);
  assert.equal(r.fuzzyDuplicates.length, 0);
});
