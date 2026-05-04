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
    // Defaults represent a "prepared" row (CL + resume assigned via
    // `prepare commit`). Tests that exercise the push gate explicitly set
    // these to "" to represent raw scan/check rows.
    resume_ver: "Risk_Fraud",
    cl_key: "default-cl",
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
    updateCalloutBlock: async () => {},
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
      flags: { dryRun: false, apply: false, verbose: false, noCallout: false },
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
      apps: [fakeApp({ jobId: "1", status: "To Apply", notion_page_id: "p1" })],
    }),
    fetchJobsFromDatabase: async () => [
      { notionPageId: "p1", source: "greenhouse", jobId: "1", key: "greenhouse:1", status: "Applied" },
    ],
  });
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.equal(calls.saveApplications.length, 1);
  assert.match(out.all(), /status To Apply → Applied/);
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

test("planPush skips already-pushed and Archived apps; pushes 'To Apply' rows", () => {
  // 8-status set: planPush only skips notion_page_id-set rows (already pushed)
  // and Archived rows (terminal). All other statuses without a page_id are pushed.
  const apps = [
    fakeApp({ jobId: "1", notion_page_id: "", status: "To Apply" }),
    fakeApp({ jobId: "2", notion_page_id: "x", status: "To Apply" }),
    fakeApp({ jobId: "3", notion_page_id: "", status: "Archived" }),
  ];
  const out = planPush(apps);
  assert.equal(out.length, 1);
  assert.equal(out[0].jobId, "1");
});

test("planPush skips Inbox rows — Inbox is local-only, Notion has no Inbox status option", () => {
  // "Inbox" rows have not been through `prepare` yet and must not be pushed to
  // Notion. They are counted in the hub callout but are not pipeline pages.
  const apps = [
    // Inbox — skip (not ready for Notion)
    fakeApp({ jobId: "raw", cl_key: "", resume_ver: "", status: "Inbox" }),
    // prepared with CL only → push
    fakeApp({ jobId: "cl-only", cl_key: "x", resume_ver: "" }),
    // prepared with resume only → push
    fakeApp({ jobId: "resume-only", cl_key: "", resume_ver: "Risk_Fraud" }),
    // fully prepared → push
    fakeApp({ jobId: "full", cl_key: "x", resume_ver: "Risk_Fraud" }),
    // already synced → skip
    fakeApp({ jobId: "synced", cl_key: "x", resume_ver: "Risk_Fraud", notion_page_id: "p1" }),
    // archived → skip
    fakeApp({ jobId: "arch", cl_key: "", resume_ver: "", status: "Archived" }),
  ];
  const out = planPush(apps);
  assert.deepEqual(
    out.map((a) => a.jobId).sort(),
    ["cl-only", "full", "resume-only"]
  );
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

test("appToNotionJob exposes location when set; buildProperties drops it without map entry (G-5)", () => {
  const { buildProperties } = require("../core/notion_sync.js");

  const app = fakeApp({ location: "San Francisco, CA" });
  const job = appToNotionJob(app, "page-affirm");
  assert.equal(job.location, "San Francisco, CA");

  // Default property_map (no `location` entry) → location does NOT reach Notion props.
  const propsDefault = buildProperties(job, {
    title: { field: "Title", type: "title" },
  });
  assert.equal(propsDefault.Location, undefined);

  // With explicit map entry → location pushes through.
  const propsWithMap = buildProperties(job, {
    title: { field: "Title", type: "title" },
    location: { field: "Location", type: "rich_text" },
  });
  assert.ok(propsWithMap.Location);
});

test("appToNotionJob omits location when app.location is empty (G-5)", () => {
  const job = appToNotionJob(fakeApp({ location: "" }), "page-affirm");
  assert.equal(job.location, undefined);
});

// Regression: pre-2026-04-30 the push path wrote Salary Min/Max numbers but
// never populated the "Salary Expectations" rich_text, leaving the user-facing
// display string empty on hundreds of pipeline pages. The display string is
// derived from min+max at push time.
test("appToNotionJob derives salaryExpectations display string from min+max", () => {
  const app = fakeApp({ salary_min: "140000", salary_max: "190000" });
  const job = appToNotionJob(app, "page-affirm");
  assert.equal(job.salaryExpectations, "$140-190K ($165K mid)");
});

test("appToNotionJob omits salaryExpectations when either bound is missing", () => {
  const onlyMin = appToNotionJob(
    fakeApp({ salary_min: "140000", salary_max: "" }),
    "page-x"
  );
  assert.equal(onlyMin.salaryExpectations, undefined);

  const onlyMax = appToNotionJob(
    fakeApp({ salary_min: "", salary_max: "190000" }),
    "page-x"
  );
  assert.equal(onlyMax.salaryExpectations, undefined);

  const neither = appToNotionJob(fakeApp(), "page-x");
  assert.equal(neither.salaryExpectations, undefined);
});

test("appToNotionJob rounds salaryExpectations midpoint to nearest $1k", () => {
  // 140k + 191k = 331k; mid = 165500 → rounds to 166000.
  const app = fakeApp({ salary_min: "140000", salary_max: "191000" });
  const job = appToNotionJob(app, "page-x");
  assert.equal(job.salaryExpectations, "$140-191K ($166K mid)");
});

// Regression: pre-2026-04-30 the Notion Resume Version dropdown accumulated 58
// non-canonical options across 259 pages because no gate validated resume_ver
// before push. The canonical Set is built from resume_versions.json keys and
// passed into appToNotionJob to refuse non-canonical values.
test("appToNotionJob accepts resume_ver inside canonical archetype set", () => {
  const canon = new Set(["ConsumerGrowth", "Risk_Fraud", "AI_Platform"]);
  const job = appToNotionJob(
    fakeApp({ resume_ver: "Risk_Fraud" }),
    "page-x",
    canon
  );
  assert.equal(job.resumeVersion, "Risk_Fraud");
});

test("appToNotionJob throws on resume_ver outside canonical archetype set", () => {
  const canon = new Set(["ConsumerGrowth", "Risk_Fraud", "AI_Platform"]);
  assert.throws(
    () =>
      appToNotionJob(
        fakeApp({ resume_ver: "CV_Jared_Moore_PaymentsInfra.docx" }),
        "page-x",
        canon
      ),
    /non-canonical resume_ver "CV_Jared_Moore_PaymentsInfra\.docx"/
  );
});

test("appToNotionJob skips canonical check when archetype set is empty/unset", () => {
  // Empty set → no gate (profile may not have resume_versions configured yet).
  const job1 = appToNotionJob(
    fakeApp({ resume_ver: "Anything" }),
    "page-x",
    new Set()
  );
  assert.equal(job1.resumeVersion, "Anything");

  // Unset 3rd arg → also no gate (preserves callers that don't validate).
  const job2 = appToNotionJob(fakeApp({ resume_ver: "Anything" }), "page-x");
  assert.equal(job2.resumeVersion, "Anything");
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
    fakeApp({ key: "greenhouse:1", jobId: "1", status: "To Apply", notion_page_id: "" }),
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

// ---------- hub callout update ----------

test("sync --apply updates the hub callout block when configured", async () => {
  const calloutCalls = [];
  const { deps } = makeDeps({
    loadProfile: () => ({
      id: "jared",
      paths: { root: "/tmp/profiles/jared" },
      notion: {
        jobs_pipeline_db_id: "db-123",
        hub_layout: { inbox_callout_block_id: "callout-block-1" },
      },
    }),
    loadApplications: () => ({
      apps: [
        // Two fresh "To Apply" rows without notion_page_id — these count.
        fakeApp({ jobId: "1", status: "To Apply", notion_page_id: "" }),
        fakeApp({ jobId: "2", status: "To Apply", notion_page_id: "" }),
        // "To Apply" but already pushed to Notion — does NOT count.
        fakeApp({ jobId: "3", status: "To Apply", notion_page_id: "p3" }),
        // Other status — does NOT count.
        fakeApp({ jobId: "4", status: "Applied", notion_page_id: "p4" }),
      ],
    }),
    updateCalloutBlock: async (_client, blockId, text) => {
      calloutCalls.push({ blockId, text });
    },
  });
  const { ctx } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.equal(calloutCalls.length, 1);
  assert.equal(calloutCalls[0].blockId, "callout-block-1");
  assert.match(calloutCalls[0].text, /^Inbox: 2 \| Updated: /);
});

test("sync --apply prints setup prompt when inbox_callout_block_id not configured", async () => {
  const calloutCalls = [];
  const { deps } = makeDeps({
    updateCalloutBlock: async (_client, blockId, text) => {
      calloutCalls.push({ blockId, text });
    },
  });
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false, noCallout: false } });
  await makeSyncCommand(deps)(ctx);
  // updateCalloutBlock must NOT be called (no block id)
  assert.equal(calloutCalls.length, 0);
  // but the user must see a prompt to configure it
  assert.match(out.all(), /hub callout: not configured/);
  assert.match(out.all(), /inbox_callout_block_id/);
  assert.match(out.all(), /--no-callout/);
});

test("sync --apply + --no-callout silently skips when callout not configured", async () => {
  const calloutCalls = [];
  const { deps } = makeDeps({
    updateCalloutBlock: async (_client, blockId, text) => {
      calloutCalls.push({ blockId, text });
    },
  });
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false, noCallout: true } });
  await makeSyncCommand(deps)(ctx);
  assert.equal(calloutCalls.length, 0);
  assert.doesNotMatch(out.all(), /hub callout/);
});

test("sync --apply callout update failure is non-fatal", async () => {
  const { deps } = makeDeps({
    loadProfile: () => ({
      id: "jared",
      paths: { root: "/tmp/profiles/jared" },
      notion: {
        jobs_pipeline_db_id: "db-123",
        hub_layout: { inbox_callout_block_id: "callout-block-1" },
      },
    }),
    updateCalloutBlock: async () => {
      throw new Error("notion 403");
    },
  });
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeSyncCommand(deps)(ctx);
  // sync itself should still exit 0 (push + pull both OK)
  assert.equal(code, 0);
  assert.match(out.all(), /hub callout update failed.*notion 403/);
});

test("sync dry-run does not update the callout block or print setup prompt", async () => {
  const calloutCalls = [];
  const { deps } = makeDeps({
    loadProfile: () => ({
      id: "jared",
      paths: { root: "/tmp/profiles/jared" },
      notion: {
        jobs_pipeline_db_id: "db-123",
        hub_layout: { inbox_callout_block_id: "callout-block-1" },
      },
    }),
    updateCalloutBlock: async (_client, blockId, text) => {
      calloutCalls.push({ blockId, text });
    },
  });
  const { ctx, out } = makeCtx(); // apply: false → dry-run
  await makeSyncCommand(deps)(ctx);
  assert.equal(calloutCalls.length, 0);
  assert.doesNotMatch(out.all(), /hub callout/);
});
