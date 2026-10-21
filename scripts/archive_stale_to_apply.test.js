// Smoke tests for scripts/archive_stale_to_apply.js (RFC 068 §12).
// All I/O and Notion calls are injected fakes — no filesystem, no network.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseArgs,
  plan,
  formatList,
  applyArchive,
  run,
  SKIP_REASON,
  NEW_STATUS,
} = require("./archive_stale_to_apply.js");

function row(overrides = {}) {
  return {
    key: "gh:1",
    companyName: "Acme",
    title: "Senior PM",
    status: "To Apply",
    notion_page_id: "",
    applied_date: "",
    skip_reason: "",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function fixtureApps() {
  return [
    row({ key: "gh:1", companyName: "Acme", notion_page_id: "page-1" }),
    row({ key: "gh:2", companyName: "Beta", notion_page_id: "" }),
    row({ key: "gh:3", companyName: "Gamma", applied_date: "2026-09-10" }), // has applied_date
    row({ key: "gh:4", companyName: "Delta", status: "Applied", notion_page_id: "page-4" }),
    row({ key: "gh:5", companyName: "Eps", status: "Inbox" }),
  ];
}

function makeHarness({
  apps = fixtureApps(),
  secrets = { NOTION_TOKEN: "tok" },
  failKeys = [],
} = {}) {
  const calls = {
    loadSecrets: 0,
    makeClient: 0,
    updatePageStatus: [],
    saveApplications: [],
    copyFile: [],
  };
  const out = [];
  const err = [];
  const deps = {
    loadProfile: () => ({
      id: "testuser",
      paths: { applicationsTsv: "/fake/profiles/testuser/applications.tsv" },
      notion: { property_map: { status: { field: "Status", type: "status" } } },
    }),
    loadApplications: () => ({ apps }),
    saveApplications: (file, next) => calls.saveApplications.push({ file, apps: next }),
    loadSecrets: () => {
      calls.loadSecrets += 1;
      return secrets;
    },
    secretEnvName: (id, key) => `${id.toUpperCase()}_${key}`,
    makeClient: () => {
      calls.makeClient += 1;
      return { __fake: true };
    },
    updatePageStatus: async (client, pageId, status, propertyMap) => {
      calls.updatePageStatus.push({ pageId, status, propertyMap });
      if (failKeys.includes(pageId)) throw new Error("notion 500");
    },
    defaultPropertyMap: {},
    copyFile: (src, dst) => calls.copyFile.push({ src, dst }),
    now: () => "2026-10-21T00:00:00.000Z",
  };
  const ctx = (apply) => ({
    profileId: "testuser",
    apply,
    profilesDir: "/fake/profiles",
    env: {},
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });
  return { deps, calls, out, err, ctx };
}

test("parseArgs: --profile required, --apply optional, unknown args rejected", () => {
  assert.deepEqual(parseArgs(["node", "x", "--profile", "jared"]), {
    profile: "jared",
    apply: false,
    help: false,
    error: null,
  });
  assert.equal(parseArgs(["node", "x", "--profile", "jared", "--apply"]).apply, true);
  assert.match(parseArgs(["node", "x"]).error, /--profile/);
  assert.match(parseArgs(["node", "x", "--profile", "j", "--force"]).error, /unknown/);
});

test("plan: only To Apply rows with empty applied_date", () => {
  assert.deepEqual(
    plan(fixtureApps()).map((a) => a.key),
    ["gh:1", "gh:2"]
  );
});

test("formatList: company — title — createdAt, capped with a tail line", () => {
  const many = Array.from({ length: 3 }, (_, i) => row({ key: `k${i}`, companyName: `C${i}` }));
  assert.deepEqual(formatList(many, 2), [
    "  C0 — Senior PM — 2026-09-01T00:00:00Z",
    "  C1 — Senior PM — 2026-09-01T00:00:00Z",
    "  … and 1 more",
  ]);
});

test("applyArchive: sets Archived + stale_pre_autoapply + updatedAt only on given keys", () => {
  const next = applyArchive(fixtureApps(), ["gh:1"], "NOW");
  const r1 = next.find((a) => a.key === "gh:1");
  assert.equal(r1.status, NEW_STATUS);
  assert.equal(r1.skip_reason, SKIP_REASON);
  assert.equal(r1.updatedAt, "NOW");
  assert.equal(next.find((a) => a.key === "gh:2").status, "To Apply");
});

test("run (dry-run): prints count + list, no secrets, no client, no network, no writes", async () => {
  const h = makeHarness();
  const code = await run(h.ctx(false), h.deps);
  assert.equal(code, 0);
  assert.equal(h.calls.loadSecrets, 0);
  assert.equal(h.calls.makeClient, 0);
  assert.equal(h.calls.updatePageStatus.length, 0);
  assert.equal(h.calls.saveApplications.length, 0);
  assert.equal(h.calls.copyFile.length, 0);
  const text = h.out.join("\n");
  assert.match(text, /stale "To Apply" rows \(no applied_date\): 2 \(1 with a Notion page\)/);
  assert.match(text, /Acme — Senior PM — 2026-09-01T00:00:00Z/);
  assert.match(text, /\(dry-run\)/);
});

test("run (--apply): backs up, updates Notion via updatePageStatus, archives TSV rows", async () => {
  const h = makeHarness();
  const code = await run(h.ctx(true), h.deps);
  assert.equal(code, 0);
  assert.equal(h.calls.copyFile.length, 1);
  assert.deepEqual(h.calls.updatePageStatus, [
    {
      pageId: "page-1",
      status: "Archived",
      propertyMap: { status: { field: "Status", type: "status" } },
    },
  ]);
  assert.equal(h.calls.saveApplications.length, 1);
  const saved = h.calls.saveApplications[0].apps;
  for (const key of ["gh:1", "gh:2"]) {
    const r = saved.find((a) => a.key === key);
    assert.equal(r.status, "Archived");
    assert.equal(r.skip_reason, "stale_pre_autoapply");
  }
  assert.equal(saved.find((a) => a.key === "gh:3").status, "To Apply");
  assert.equal(saved.find((a) => a.key === "gh:4").status, "Applied");
});

test("run (--apply): Notion failure leaves that row To Apply and exits 1", async () => {
  const h = makeHarness({ failKeys: ["page-1"] });
  const code = await run(h.ctx(true), h.deps);
  assert.equal(code, 1);
  const saved = h.calls.saveApplications[0].apps;
  assert.equal(saved.find((a) => a.key === "gh:1").status, "To Apply");
  assert.equal(saved.find((a) => a.key === "gh:2").status, "Archived");
  assert.match(h.err.join("\n"), /gh:1: notion 500/);
});

test("run (--apply): missing Notion token → error, nothing written", async () => {
  const h = makeHarness({ secrets: {} });
  const code = await run(h.ctx(true), h.deps);
  assert.equal(code, 1);
  assert.equal(h.calls.saveApplications.length, 0);
  assert.equal(h.calls.copyFile.length, 0);
  assert.match(h.err.join("\n"), /TESTUSER_NOTION_TOKEN/);
});

test("run: nothing stale → exit 0, no writes", async () => {
  const h = makeHarness({ apps: [row({ status: "Applied" })] });
  const code = await run(h.ctx(true), h.deps);
  assert.equal(code, 0);
  assert.equal(h.calls.saveApplications.length, 0);
  assert.match(h.out.join("\n"), /nothing to archive/);
});
