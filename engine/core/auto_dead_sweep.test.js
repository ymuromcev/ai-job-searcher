const { test } = require("node:test");
const assert = require("node:assert/strict");

const { runAutoDeadSweep, todayLocalISO } = require("./auto_dead_sweep.js");

// Minimal ctx with captured stdout/stderr.
function makeCtx() {
  const out = [];
  const err = [];
  return {
    ctx: {
      env: {},
      profilesDir: "/fake/profiles",
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    },
    out,
    err,
  };
}

const PROFILE = {
  paths: { root: "/fake/profiles/jared" },
  notion: { property_map: { status: { field: "Status", type: "status" } } },
};

function appsFixture() {
  return [
    {
      key: "lever:stale",
      status: "In flight",
      hm_outreach_date: "2026-06-01", // 9 days before 2026-06-10 → stale
      notion_page_id: "page-stale",
    },
    {
      key: "lever:fresh",
      status: "In flight",
      hm_outreach_date: "2026-06-09", // 1 day → fresh
      notion_page_id: "page-fresh",
    },
    {
      key: "lever:replied",
      status: "Replied",
      hm_outreach_date: "2026-01-01",
      notion_page_id: "page-replied",
    },
  ];
}

const TODAY = "2026-06-10";

test("sweep: flips stale In-flight rows to Dead in TSV + pushes to Notion", async () => {
  const { ctx, out } = makeCtx();
  const apps = appsFixture();
  let savedApps = null;
  const statusCalls = [];

  await runAutoDeadSweep("jared", ctx, {
    todayStr: TODAY,
    deps: {
      loadProfile: () => PROFILE,
      loadSecrets: () => ({ NOTION_TOKEN: "secret_token" }),
      loadApplications: () => ({ apps }),
      saveApplications: (_path, a) => {
        savedApps = a;
      },
      makeClient: (token) => ({ token }),
      updatePageStatus: async (client, pageId, status) => {
        statusCalls.push({ pageId, status, token: client.token });
      },
    },
  });

  // Only the stale row flips.
  assert.equal(apps.find((a) => a.key === "lever:stale").status, "Dead");
  assert.equal(apps.find((a) => a.key === "lever:fresh").status, "In flight");
  assert.equal(apps.find((a) => a.key === "lever:replied").status, "Replied");

  // TSV saved once with the mutated rows.
  assert.equal(savedApps, apps);

  // Exactly one targeted Notion status write, for the stale page, value Dead.
  assert.equal(statusCalls.length, 1);
  assert.deepEqual(statusCalls[0], {
    pageId: "page-stale",
    status: "Dead",
    token: "secret_token",
  });

  assert.ok(out.some((l) => l.includes("swept 1")));
});

test("sweep: no stale rows → no save, no Notion call, no output (cheap no-op)", async () => {
  const { ctx, out, err } = makeCtx();
  const apps = [
    { key: "a", status: "In flight", hm_outreach_date: "2026-06-09", notion_page_id: "p" },
    { key: "b", status: "To do", hm_outreach_date: "", notion_page_id: "p2" },
  ];
  let saved = false;
  let notionCalled = false;

  const res = await runAutoDeadSweep("jared", ctx, {
    todayStr: TODAY,
    deps: {
      loadProfile: () => PROFILE,
      loadSecrets: () => ({ NOTION_TOKEN: "t" }),
      loadApplications: () => ({ apps }),
      saveApplications: () => {
        saved = true;
      },
      makeClient: () => ({}),
      updatePageStatus: async () => {
        notionCalled = true;
      },
    },
  });

  assert.equal(res.swept, 0);
  assert.equal(saved, false);
  assert.equal(notionCalled, false);
  assert.equal(out.length, 0);
  assert.equal(err.length, 0);
});

test("sweep: no NOTION_TOKEN → marks Dead in TSV only + warns, never fails", async () => {
  const { ctx, err } = makeCtx();
  const apps = appsFixture();
  let saved = false;
  let notionCalled = false;

  const res = await runAutoDeadSweep("jared", ctx, {
    todayStr: TODAY,
    deps: {
      loadProfile: () => PROFILE,
      loadSecrets: () => ({}), // no token
      loadApplications: () => ({ apps }),
      saveApplications: () => {
        saved = true;
      },
      makeClient: () => {
        throw new Error("makeClient should not be called without a token");
      },
      updatePageStatus: async () => {
        notionCalled = true;
      },
    },
  });

  assert.equal(res.swept, 1);
  assert.equal(res.notionPushed, 0);
  assert.equal(apps.find((a) => a.key === "lever:stale").status, "Dead");
  assert.equal(saved, true);
  assert.equal(notionCalled, false);
  assert.ok(err.some((l) => l.includes("TSV only")));
});

test("sweep: Notion error on one row is counted, TSV still saved, no throw", async () => {
  const { ctx, err } = makeCtx();
  const apps = appsFixture();
  let saved = false;

  const res = await runAutoDeadSweep("jared", ctx, {
    todayStr: TODAY,
    deps: {
      loadProfile: () => PROFILE,
      loadSecrets: () => ({ NOTION_TOKEN: "t" }),
      loadApplications: () => ({ apps }),
      saveApplications: () => {
        saved = true;
      },
      makeClient: () => ({}),
      updatePageStatus: async () => {
        throw new Error("notion 503");
      },
    },
  });

  assert.equal(res.swept, 1);
  assert.equal(res.notionErrors, 1);
  assert.equal(apps.find((a) => a.key === "lever:stale").status, "Dead");
  assert.equal(saved, true); // TSV write not blocked by Notion error
  assert.ok(err.some((l) => l.includes("notion error")));
});

test("sweep: stale row without notion_page_id is marked Dead in TSV, no Notion call", async () => {
  const { ctx } = makeCtx();
  const apps = [
    { key: "x", status: "In flight", hm_outreach_date: "2026-06-01", notion_page_id: "" },
  ];
  let notionCalled = false;

  const res = await runAutoDeadSweep("jared", ctx, {
    todayStr: TODAY,
    deps: {
      loadProfile: () => PROFILE,
      loadSecrets: () => ({ NOTION_TOKEN: "t" }),
      loadApplications: () => ({ apps }),
      saveApplications: () => {},
      makeClient: () => ({}),
      updatePageStatus: async () => {
        notionCalled = true;
      },
    },
  });

  assert.equal(res.swept, 1);
  assert.equal(apps[0].status, "Dead");
  assert.equal(notionCalled, false);
});

test("sweep: unexpected error (e.g. loadProfile throws) is caught, never propagates", async () => {
  const { ctx, err } = makeCtx();
  const res = await runAutoDeadSweep("jared", ctx, {
    todayStr: TODAY,
    deps: {
      loadProfile: () => {
        throw new Error("profile boom");
      },
    },
  });
  assert.equal(res.swept, 0);
  assert.ok(err.some((l) => l.includes("sweep skipped")));
});

test("todayLocalISO: formats a Date as YYYY-MM-DD (local)", () => {
  const d = new Date(2026, 5, 3); // June 3, 2026 local
  assert.equal(todayLocalISO(d), "2026-06-03");
  assert.match(todayLocalISO(), /^\d{4}-\d{2}-\d{2}$/);
});
