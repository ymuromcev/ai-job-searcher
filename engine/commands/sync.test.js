const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  makeSyncCommand,
  reconcilePull,
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
    resume_ver: "Risk_Fraud",
    cl_key: "default-cl",
    createdAt: "now",
    updatedAt: "now",
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const calls = { saveApplications: [], fetchJobsFromDatabase: [] };
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

test("sync defaults to dry-run and does not touch TSV", async () => {
  const { deps, calls } = makeDeps();
  const { ctx, out } = makeCtx();
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.equal(calls.saveApplications.length, 0);
  assert.match(out.all(), /pull plan: 0/);
  assert.match(out.all(), /\(dry-run/);
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

test("sync --apply with no pull changes does not save TSV", async () => {
  const { deps, calls } = makeDeps();
  const { ctx } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 0);
  // No Notion pages returned → no diffs → no save.
  assert.equal(calls.saveApplications.length, 0);
});

test("sync reuses a single Notion client across pull + callout", async () => {
  const { deps } = makeDeps({
    loadProfile: () => ({
      id: "jared",
      paths: { root: "/tmp/profiles/jared" },
      notion: {
        jobs_pipeline_db_id: "db-123",
        hub_layout: { inbox_callout_block_id: "callout-block-1" },
      },
    }),
  });
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
  const originalApps = [
    fakeApp({ key: "greenhouse:1", jobId: "1", status: "To Apply", notion_page_id: "p1" }),
  ];
  // Clone the app so we can verify the original stays unchanged.
  const loaded = originalApps.map((a) => ({ ...a }));
  const { deps } = makeDeps({
    loadApplications: () => ({ apps: loaded }),
    fetchJobsFromDatabase: async () => [
      { notionPageId: "p1", key: "greenhouse:1", status: "Applied" },
    ],
  });
  const { ctx } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  await makeSyncCommand(deps)(ctx);
  // The in-memory `loaded` copy that sync received must not have been mutated:
  // status stays "To Apply" on the original reference; the saved TSV gets the
  // new status through the byKey map.
  assert.equal(loaded[0].status, "To Apply", "sync must not mutate input app in place");
});

test("sync exits 1 on pull failure", async () => {
  const { deps } = makeDeps({
    fetchJobsFromDatabase: async () => {
      throw new Error("notion 502");
    },
  });
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 1);
  assert.match(out.all(), /pull error.*notion 502/);
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
  assert.equal(calloutCalls.length, 0);
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
  // sync itself should still exit 0 (pull OK, callout failure is non-fatal)
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
