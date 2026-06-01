const { test } = require("node:test");
const assert = require("node:assert/strict");

const { makeSyncCommand, reconcilePull, DEFAULT_PROPERTY_MAP } = require("./sync.js");

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
      apps: [fakeApp({ jobId: "1" }), fakeApp({ jobId: "2", notion_page_id: "page-existing" })],
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
      {
        notionPageId: "p1",
        source: "greenhouse",
        jobId: "1",
        key: "greenhouse:1",
        status: "Applied",
      },
    ],
  });
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.equal(calls.saveApplications.length, 1);
  assert.match(out.all(), /status To Apply → Applied/);
});

test("sync --apply adds a new row for a Notion page with no local match (RFC 055)", async () => {
  const saved = [];
  const { deps } = makeDeps({
    loadApplications: () => ({ apps: [fakeApp({ jobId: "1" })] }),
    saveApplications: (file, apps) => saved.push({ file, apps }),
    fetchJobsFromDatabase: async () => [
      {
        notionPageId: "p2",
        key: "lever:abc",
        source: "lever",
        jobId: "abc",
        companyName: "Stripe",
        title: "Senior PM",
        status: "Interview",
      },
    ],
  });
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.equal(saved.length, 1);
  const addedRow = saved[0].apps.find((a) => a.key === "lever:abc");
  assert.ok(addedRow, "added row is persisted");
  assert.equal(addedRow.notion_page_id, "p2");
  assert.equal(addedRow.status, "Interview");
  assert.match(out.all(), /1 added/);
});

test("sync dry-run reports add count but does not save (RFC 055)", async () => {
  const { deps, calls } = makeDeps({
    loadApplications: () => ({ apps: [] }),
    fetchJobsFromDatabase: async () => [
      { notionPageId: "p2", key: "lever:abc", source: "lever", jobId: "abc", status: "Applied" },
    ],
  });
  const { ctx, out } = makeCtx(); // dry-run by default
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.equal(calls.saveApplications.length, 0, "dry-run must not write");
  assert.match(out.all(), /1 new row\(s\) would be added/);
  assert.match(out.all(), /add: lever:abc/);
  assert.match(out.all(), /\(dry-run/);
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

const NOW = "2026-04-20T00:00:00Z";

test("reconcilePull matches by key and reports status changes", () => {
  const apps = [
    fakeApp({ key: "greenhouse:1", jobId: "1", status: "To Apply", notion_page_id: "" }),
    fakeApp({ key: "greenhouse:2", jobId: "2", status: "Applied", notion_page_id: "p2" }),
  ];
  const pages = [
    { notionPageId: "p1", key: "greenhouse:1", status: "Applied" },
    { notionPageId: "p2", key: "greenhouse:2", status: "Applied" }, // no change
  ];
  const { updates, adds } = reconcilePull(apps, pages, DEFAULT_PROPERTY_MAP, NOW);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].after.notion_page_id, "p1");
  assert.equal(updates[0].after.status, "Applied");
  assert.equal(adds.length, 0, "all pages matched existing rows → no adds");
});

test("reconcilePull adds a Notion page with no matching local row (RFC 055)", () => {
  const apps = [fakeApp({ key: "greenhouse:1", jobId: "1" })];
  const pages = [
    { notionPageId: "p1", key: "greenhouse:1", status: "Applied" }, // existing → update
    {
      notionPageId: "p2",
      key: "lever:abc",
      source: "lever",
      jobId: "abc",
      companyName: "Stripe",
      title: "Senior PM",
      url: "https://x/abc",
      status: "Interview",
    },
  ];
  const { updates, adds } = reconcilePull(apps, pages, DEFAULT_PROPERTY_MAP, NOW);
  assert.equal(updates.length, 1);
  assert.equal(adds.length, 1);
  const row = adds[0];
  assert.equal(row.key, "lever:abc");
  assert.equal(row.notion_page_id, "p2");
  assert.equal(row.status, "Interview");
  assert.equal(row.companyName, "Stripe");
  assert.equal(row.title, "Senior PM");
  assert.equal(row.source, "lever");
  assert.equal(row.jobId, "abc");
  assert.equal(row.url, "https://x/abc");
  assert.deepEqual(row.locations, []);
  assert.equal(row.createdAt, NOW);
  assert.equal(row.updatedAt, NOW);
  // Empties for fields Notion doesn't supply.
  assert.equal(row.resume_ver, "");
  assert.equal(row.cl_key, "");
  assert.equal(row.salary_min, "");
  assert.equal(row.fit_score, "");
  assert.equal(row.skip_reason, "");
});

test("reconcilePull defaults source to 'notion' when the page has none", () => {
  const apps = [];
  const pages = [{ notionPageId: "p9", key: "manual-entry", status: "Applied" }];
  const { adds } = reconcilePull(apps, pages, DEFAULT_PROPERTY_MAP, NOW);
  assert.equal(adds.length, 1);
  assert.equal(adds[0].source, "notion");
  assert.equal(adds[0].key, "manual-entry");
});

test("reconcilePull is idempotent: a previously-added row is not re-added", () => {
  const page = {
    notionPageId: "p2",
    key: "lever:abc",
    source: "lever",
    jobId: "abc",
    companyName: "Stripe",
    title: "Senior PM",
    status: "Interview",
  };
  // First pass: row does not exist locally → add.
  const firstApps = [fakeApp({ key: "greenhouse:1", jobId: "1" })];
  const first = reconcilePull(firstApps, [page], DEFAULT_PROPERTY_MAP, NOW);
  assert.equal(first.adds.length, 1);

  // Simulate the saved state: the added row is now part of the local TSV.
  const secondApps = firstApps.concat([first.adds[0]]);
  const second = reconcilePull(secondApps, [page], DEFAULT_PROPERTY_MAP, NOW);
  assert.equal(second.adds.length, 0, "no duplicate add on rerun");
  // Status already matches → no spurious update either.
  assert.equal(second.updates.length, 0);
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
  const { ctx, out } = makeCtx({
    flags: { dryRun: false, apply: true, verbose: false, noCallout: false },
  });
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
  const { ctx, out } = makeCtx({
    flags: { dryRun: false, apply: true, verbose: false, noCallout: true },
  });
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

// BL-151 / RFC 054: archive used tailored artifacts on --apply ----------------

function fakeArchiveFs(initialFiles = []) {
  const path = require("path");
  const files = new Set(initialFiles.map((p) => path.normalize(p)));
  const calls = { mkdir: [], rename: [] };
  return {
    files,
    calls,
    existsSync: (p) => files.has(path.normalize(p)),
    mkdirSync: (p) => calls.mkdir.push(p),
    renameSync: (from, to) => {
      const f = path.normalize(from);
      const t = path.normalize(to);
      if (!files.has(f)) {
        const err = new Error(`ENOENT: ${from}`);
        err.code = "ENOENT";
        throw err;
      }
      files.delete(f);
      files.add(t);
      calls.rename.push({ from, to });
    },
  };
}

test("sync --apply archives tailored artifacts for rows past To Apply (BL-151)", async () => {
  const path = require("path");
  const profileRoot = "/tmp/profiles/jared";
  const taggedApp = fakeApp({
    key: "greenhouse:9",
    jobId: "9",
    notion_page_id: "p9",
    status: "Applied",
    resume_ver: "resumes/tailored/affirm_pm_20260520.docx",
    cl_path: "cover_letters/tailored/affirm_pm_20260520.pdf",
    updatedAt: "2026-05-21T00:00:00Z",
  });
  const archiveFs = fakeArchiveFs([
    path.join(profileRoot, taggedApp.resume_ver),
    path.join(profileRoot, taggedApp.cl_path),
  ]);
  const saved = [];
  const { deps } = makeDeps({
    loadApplications: () => ({ apps: [taggedApp] }),
    fetchJobsFromDatabase: async () => [], // no pull changes
    saveApplications: (file, apps) => saved.push({ file, apps }),
  });
  deps.archiveFs = archiveFs;
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.equal(archiveFs.calls.rename.length, 2);
  assert.equal(saved.length, 1);
  const savedRow = saved[0].apps.find((a) => a.key === "greenhouse:9");
  assert.equal(savedRow.resume_ver, "cv/archive/2026-05/affirm_pm_20260520.docx");
  assert.equal(savedRow.cl_path, "cover_letters/archive/2026-05/affirm_pm_20260520.pdf");
  assert.match(out.all(), /\[sync\] archived 2 used artifacts/);
});

test("sync --apply does not archive when no rows are eligible", async () => {
  const path = require("path");
  // App is still in "To Apply" → no archive trigger.
  const app = fakeApp({
    status: "To Apply",
    resume_ver: "resumes/tailored/x_y_20260520.docx",
    cl_path: "cover_letters/tailored/x_y_20260520.pdf",
  });
  const archiveFs = fakeArchiveFs([
    path.join("/tmp/profiles/jared", app.resume_ver),
    path.join("/tmp/profiles/jared", app.cl_path),
  ]);
  const { deps } = makeDeps({
    loadApplications: () => ({ apps: [app] }),
    fetchJobsFromDatabase: async () => [],
  });
  deps.archiveFs = archiveFs;
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  await makeSyncCommand(deps)(ctx);
  assert.equal(archiveFs.calls.rename.length, 0);
  assert.doesNotMatch(out.all(), /\[sync\] archived/);
});

test("sync dry-run does NOT archive (mutations gated on --apply)", async () => {
  const path = require("path");
  const app = fakeApp({
    status: "Applied",
    resume_ver: "resumes/tailored/x_y_20260520.docx",
    cl_path: "",
  });
  const archiveFs = fakeArchiveFs([path.join("/tmp/profiles/jared", app.resume_ver)]);
  const { deps } = makeDeps({
    loadApplications: () => ({ apps: [app] }),
    fetchJobsFromDatabase: async () => [],
  });
  deps.archiveFs = archiveFs;
  const { ctx, out } = makeCtx(); // dry-run by default
  await makeSyncCommand(deps)(ctx);
  assert.equal(archiveFs.calls.rename.length, 0);
  assert.doesNotMatch(out.all(), /\[sync\] archived/);
});

// ---------------------------------------------------------------------------
// RFC 058 / BL-168 — reconcile resolves the Company relation to a name.
// ---------------------------------------------------------------------------

const { matchKeyForPage } = require("./sync.js");
const { makeCompanyNameResolver } = require("../core/company_resolver.js");

test("reconcilePull add-path fills companyName from the relation map (RFC 058)", () => {
  const apps = [];
  const pages = [
    {
      notionPageId: "p9",
      key: "lever:pix",
      source: "lever",
      jobId: "pix",
      companyRelation: ["co-1"], // relation id, NO companyName text
      title: "Senior PM - Pix Squad",
      status: "Applied",
    },
  ];
  const { adds } = reconcilePull(apps, pages, DEFAULT_PROPERTY_MAP, NOW, { "co-1": "dLocal" });
  assert.equal(adds.length, 1);
  assert.equal(adds[0].companyName, "dLocal");
});

test("reconcilePull add-path leaves companyName empty when relation unresolved", () => {
  const pages = [
    { notionPageId: "p9", key: "lever:pix", source: "lever", jobId: "pix", companyRelation: ["co-x"], status: "Applied" },
  ];
  const { adds } = reconcilePull([], pages, DEFAULT_PROPERTY_MAP, NOW, {}); // no map entry
  assert.equal(adds[0].companyName, "");
});

test("reconcilePull backfills an existing row's empty companyName (RFC 058)", () => {
  const apps = [fakeApp({ key: "lever:pix", source: "lever", jobId: "pix", companyName: "", status: "Applied" })];
  const pages = [
    { notionPageId: "p9", key: "lever:pix", source: "lever", jobId: "pix", companyRelation: ["co-1"], status: "Applied" },
  ];
  const { updates } = reconcilePull(apps, pages, DEFAULT_PROPERTY_MAP, NOW, { "co-1": "dLocal" });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].after.companyName, "dLocal");
});

test("reconcilePull never overwrites a populated companyName", () => {
  const apps = [fakeApp({ key: "lever:pix", source: "lever", jobId: "pix", companyName: "dLocal Inc", status: "Applied" })];
  const pages = [
    { notionPageId: "p9", key: "lever:pix", source: "lever", jobId: "pix", companyRelation: ["co-1"], status: "Applied" },
  ];
  // Same status + page id → no change; companyName must stay as the local value.
  const withPage = pages.map((p) => ({ ...p, notionPageId: "", status: "Applied" }));
  const { updates } = reconcilePull(apps, withPage, DEFAULT_PROPERTY_MAP, NOW, { "co-1": "OtherName" });
  assert.equal(updates.length, 0);
});

test("matchKeyForPage prefers key, falls back to composite", () => {
  assert.equal(matchKeyForPage({ key: "lever:a" }, DEFAULT_PROPERTY_MAP), "lever:a");
  assert.equal(matchKeyForPage({ source: "Lever", jobId: "a" }, DEFAULT_PROPERTY_MAP), "lever:a");
});

test("makeCompanyNameResolver reads the title and caches per id", async () => {
  let retrieves = 0;
  const client = {
    pages: {
      retrieve: async ({ page_id }) => {
        retrieves += 1;
        const names = { "co-1": "dLocal", "co-2": "Stripe" };
        return { properties: { Name: { title: [{ plain_text: names[page_id] || "" }] } } };
      },
    },
  };
  const r = makeCompanyNameResolver({ client });
  const map = await r.resolveIds(["co-1", "co-2", "co-1"]);
  assert.deepEqual(map, { "co-1": "dLocal", "co-2": "Stripe" });
  assert.equal(retrieves, 2, "deduped: one retrieve per unique id");
});

test("makeCompanyNameResolver returns null for untitled and unreadable pages", async () => {
  const client = {
    pages: {
      retrieve: async ({ page_id }) => {
        if (page_id === "boom") throw new Error("not found");
        return { properties: { Name: { title: [] } } }; // untitled
      },
    },
  };
  const r = makeCompanyNameResolver({ client, log: () => {} });
  const map = await r.resolveIds(["empty", "boom"]);
  assert.equal(map.empty, null);
  assert.equal(map.boom, null);
});

test("sync --apply resolves relation ids and persists the resolved company (RFC 058)", async () => {
  const saved = [];
  const resolverCalls = [];
  const { deps } = makeDeps({
    loadApplications: () => ({ apps: [fakeApp({ jobId: "1" })] }),
    saveApplications: (file, apps) => saved.push({ file, apps }),
    fetchJobsFromDatabase: async () => [
      {
        notionPageId: "p2",
        key: "lever:pix",
        source: "lever",
        jobId: "pix",
        companyRelation: ["co-1"], // relation only, no companyName text
        title: "Senior PM - Pix Squad",
        status: "Applied",
      },
    ],
    makeCompanyNameResolver: () => ({
      resolveIds: async (ids) => {
        resolverCalls.push(ids);
        return { "co-1": "dLocal" };
      },
    }),
  });
  const { ctx } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeSyncCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.deepEqual(resolverCalls, [["co-1"]], "resolver called with the needed id");
  const addedRow = saved[0].apps.find((a) => a.key === "lever:pix");
  assert.equal(addedRow.companyName, "dLocal");
});
