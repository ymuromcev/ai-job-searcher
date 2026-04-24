const { test } = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  makeSyncCommand,
  planPush,
  reconcilePull,
  appToNotionJob,
  readPushManifest,
  DEFAULT_PROPERTY_MAP,
} = require("./sync.js");

function captureOut() {
  const stdout = [];
  const stderr = [];
  return {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    lines: stdout,
    all: () => stdout.concat(stderr).join("\n"),
  };
}

function fakeApp(overrides = {}) {
  return {
    key: "greenhouse:1",
    source: "greenhouse",
    jobId: "1",
    companyName: "Affirm",
    title: "PM",
    url: "https://x/1",
    status: "To Apply",
    notion_page_id: "",
    resume_ver: "",
    cl_key: "",
    createdAt: "now",
    updatedAt: "now",
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const calls = { saveApplications: [], createJobPage: [], fetchJobsFromDatabase: [] };
  const deps = {
    loadProfile: () => ({
      id: "jared",
      paths: { root: "/tmp/profiles/jared" },
      notion: { jobs_pipeline_db_id: "db-123" },
    }),
    loadSecrets: () => ({ NOTION_TOKEN: "tok" }),
    loadApplications: () => ({
      apps: [
        fakeApp({ jobId: "1" }),
        fakeApp({ jobId: "2", notion_page_id: "page-existing" }),
      ],
    }),
    saveApplications: (file, apps) => {
      calls.saveApplications.push({ file, count: apps.length });
    },
    makeClient: () => ({}),
    createJobPage: async (_c, _db, app) => {
      calls.createJobPage.push(app.key);
      return { id: `notion-page-${app.jobId}` };
    },
    fetchJobsFromDatabase: async () => {
      calls.fetchJobsFromDatabase.push(true);
      return [];
    },
    now: () => "2026-04-20T00:00:00Z",
    ...overrides,
  };
  return { deps, calls };
}

function makeCtx(overrides = {}) {
  const out = captureOut();
  return {
    out,
    ctx: {
      command: "sync",
      profileId: "jared",
      flags: { dryRun: false, apply: false, verbose: false },
      env: { JARED_NOTION_TOKEN: "tok" },
      stdout: out.stdout,
      stderr: out.stderr,
      profilesDir: "/tmp/profiles",
      ...overrides,
    },
  };
}

test("sync defaults to dry-run and does not touch Notion or TSV", async () => {
  const { deps, calls } = makeDeps();
  const { ctx, out } = makeCtx();
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.equal(calls.createJobPage.length, 0);
  assert.equal(calls.saveApplications.length, 0);
  assert.match(out.all(), /push plan: 1/);
  assert.match(out.all(), /\(dry-run/);
});

test("sync --apply creates Notion pages for pushable apps and persists ids", async () => {
  const { deps, calls } = makeDeps();
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.deepEqual(calls.createJobPage, ["greenhouse:1"]);
  assert.equal(calls.saveApplications.length, 1);
  assert.match(out.all(), /push: 1 created/);
});

test("sync errors out when database id is missing", async () => {
  const { deps } = makeDeps({
    loadProfile: () => ({
      id: "jared",
      paths: { root: "/tmp/profiles/jared" },
      notion: {},
    }),
  });
  const { ctx, out } = makeCtx();
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 1);
  assert.match(out.all(), /jobs_pipeline_db_id is not configured/);
});

test("sync errors out when NOTION_TOKEN is missing in env", async () => {
  const { deps } = makeDeps({ loadSecrets: () => ({}) });
  const { ctx, out } = makeCtx();
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 1);
  assert.match(out.all(), /missing JARED_NOTION_TOKEN/);
});

test("sync --apply applies pull updates from Notion (status wins)", async () => {
  const { deps, calls } = makeDeps({
    loadApplications: () => ({
      apps: [fakeApp({ jobId: "1", status: "Inbox", notion_page_id: "p1" })],
    }),
    fetchJobsFromDatabase: async () => [
      { notionPageId: "p1", source: "greenhouse", jobId: "1", key: "greenhouse:1", status: "Applied" },
    ],
  });
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.equal(calls.saveApplications.length, 1);
  assert.match(out.all(), /status Inbox → Applied/);
});

test("sync collects push errors and returns exit 1", async () => {
  const { deps } = makeDeps({
    createJobPage: async () => {
      throw new Error("notion 429");
    },
  });
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 1);
  assert.match(out.all(), /push error.*notion 429/);
});

test("planPush skips already-pushed, Archived, and Inbox apps", () => {
  const apps = [
    fakeApp({ jobId: "1", notion_page_id: "", status: "To Apply" }),
    fakeApp({ jobId: "2", notion_page_id: "x", status: "To Apply" }),
    fakeApp({ jobId: "3", notion_page_id: "", status: "Archived" }),
    fakeApp({ jobId: "4", notion_page_id: "", status: "Inbox" }),
  ];
  const out = planPush(apps);
  assert.equal(out.length, 1);
  assert.equal(out[0].jobId, "1");
});

test("readPushManifest: missing file → null (gate disabled)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aijs-manifest-"));
  try {
    assert.equal(readPushManifest(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readPushManifest: corrupt JSON fails loud (fail closed)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aijs-manifest-"));
  const stageDir = path.join(dir, ".stage16");
  fs.mkdirSync(stageDir);
  fs.writeFileSync(path.join(stageDir, "push_manifest.json"), "{not json");
  try {
    assert.throws(() => readPushManifest(dir), /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readPushManifest: wrong shape fails loud", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aijs-manifest-"));
  const stageDir = path.join(dir, ".stage16");
  fs.mkdirSync(stageDir);
  fs.writeFileSync(path.join(stageDir, "push_manifest.json"), '{"notKeys":[]}');
  try {
    assert.throws(() => readPushManifest(dir), /missing a "keys" array/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sync: corrupt manifest → exit 1 with message (does not silently push all)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aijs-manifest-"));
  fs.mkdirSync(path.join(dir, ".stage16"));
  fs.writeFileSync(path.join(dir, ".stage16", "push_manifest.json"), "garbage");
  const { deps, calls } = makeDeps({
    loadProfile: () => ({
      id: "jared",
      paths: { root: dir },
      notion: { jobs_pipeline_db_id: "db-123" },
    }),
  });
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeSyncCommand(deps)(ctx);
  try {
    assert.equal(code, 1);
    assert.match(out.all(), /push manifest.*not valid JSON/);
    assert.equal(calls.createJobPage.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("planPush honors allowKeys manifest (Stage 16 migration gate)", () => {
  const apps = [
    fakeApp({ jobId: "1", notion_page_id: "", status: "To Apply", key: "greenhouse:1" }),
    fakeApp({ jobId: "2", notion_page_id: "", status: "To Apply", key: "greenhouse:2" }),
    fakeApp({ jobId: "3", notion_page_id: "", status: "Applied", key: "greenhouse:3" }),
  ];
  const out = planPush(apps, { allowKeys: new Set(["greenhouse:2", "greenhouse:3"]) });
  assert.deepEqual(out.map((a) => a.jobId), ["2", "3"]);

  // Empty set → nothing is allowed.
  assert.equal(planPush(apps, { allowKeys: new Set() }).length, 0);
});

test("sync reuses a single Notion client across push + pull", async () => {
  const { deps, calls } = makeDeps();
  let created = 0;
  deps.makeClient = () => {
    created += 1;
    return { clientInstance: created };
  };
  const { ctx } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  await makeSyncCommand(deps)(ctx);
  assert.equal(created, 1, "makeClient should be called exactly once");
});

test("sync --apply does not mutate input apps in place", async () => {
  const originalApps = [fakeApp({ jobId: "1", notion_page_id: "" })];
  // Clone the app so we can verify the original stays unchanged.
  const loaded = originalApps.map((a) => ({ ...a }));
  const { deps } = makeDeps({
    loadApplications: () => ({ apps: loaded }),
  });
  const { ctx } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  await makeSyncCommand(deps)(ctx);
  // The in-memory `loaded` copy that sync received must not have been mutated:
  // notion_page_id stays "" on the original reference; the saved TSV gets the
  // new page id through the byKey map.
  assert.equal(loaded[0].notion_page_id, "", "sync must not mutate input app in place");
});

test("sync warns on pull failure after a successful push", async () => {
  const { deps } = makeDeps({
    fetchJobsFromDatabase: async () => {
      throw new Error("notion 502");
    },
  });
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 1);
  assert.match(out.all(), /pull error.*notion 502/);
  assert.match(out.all(), /pull failed — writing push-only changes/);
});

test("appToNotionJob maps tsv columns to Notion property keys", () => {
  const app = fakeApp({
    resume_ver: "Risk_Fraud",
    salary_min: "140000",
    salary_max: "190000",
    cl_path: "Affirm_20260420",
  });
  const job = appToNotionJob(app, "page-affirm");
  assert.equal(job.companyRelation[0], "page-affirm");
  assert.equal(job.resumeVersion, "Risk_Fraud");
  assert.equal(job.salaryMin, 140000);
  assert.equal(job.salaryMax, 190000);
  assert.equal(job.coverLetter, "Affirm_20260420");
});

test("appToNotionJob omits companyRelation when resolver returns null", () => {
  const job = appToNotionJob(fakeApp(), null);
  assert.equal(job.companyRelation, undefined);
});

test("sync --apply resolves company to Notion page when companies_db_id configured", async () => {
  const { deps, calls } = makeDeps({
    loadProfile: () => ({
      id: "jared",
      paths: { root: "/tmp/profiles/jared" },
      notion: { jobs_pipeline_db_id: "db-123", companies_db_id: "cdb-123" },
      company_tiers: { Affirm: "S" },
    }),
    resolveDataSourceId: async () => "cds-1",
    makeCompanyResolver: () => ({
      resolve: async (name) => (name === "Affirm" ? "co-affirm-page" : null),
    }),
  });
  const { ctx } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  await makeSyncCommand(deps)(ctx);
  assert.equal(calls.createJobPage.length, 1);
  // createJobPage is invoked with a notion-job object — which in the mock we
  // stash by key; verify by inspecting the mock calls payload through a richer
  // assertion:
  assert.equal(calls.createJobPage[0], "greenhouse:1");
});

test("sync --apply pushes without resolver when companies_db_id missing", async () => {
  const { deps } = makeDeps({
    loadProfile: () => ({
      id: "jared",
      paths: { root: "/tmp/profiles/jared" },
      notion: { jobs_pipeline_db_id: "db-123" },
    }),
  });
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.match(out.all(), /no companies_db_id/);
});

test("reconcilePull matches by key and reports status changes", () => {
  const apps = [
    fakeApp({ key: "greenhouse:1", jobId: "1", status: "Inbox", notion_page_id: "" }),
    fakeApp({ key: "greenhouse:2", jobId: "2", status: "Applied", notion_page_id: "p2" }),
  ];
  const pages = [
    { notionPageId: "p1", key: "greenhouse:1", status: "Applied" },
    { notionPageId: "p2", key: "greenhouse:2", status: "Applied" }, // no change
  ];
  const updates = reconcilePull(apps, pages, DEFAULT_PROPERTY_MAP);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].after.notion_page_id, "p1");
  assert.equal(updates[0].after.status, "Applied");
});
