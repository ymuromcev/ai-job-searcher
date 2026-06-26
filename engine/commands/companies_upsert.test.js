const test = require("node:test");
const assert = require("node:assert");

const { makeCompaniesUpsertCommand } = require("./companies_upsert.js");

function targetRow(over = {}) {
  return {
    name: "New Co",
    website: "newco.com",
    ru_signal: "RU founder (Yerevan)",
    market: "US SaaS",
    us_viability: "HIGH",
    channel: "outreach",
    ats: "",
    contact: "Jane Doe (CEO)",
    open_roles_url: "https://newco.com/careers",
    notes: "early stage",
    ...over,
  };
}

function makeCtx(over = {}) {
  const out = [];
  const err = [];
  return {
    ctx: {
      profileId: "jared",
      flags: { apply: false },
      env: {},
      profilesDir: "/fake/profiles",
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      ...over,
    },
    out,
    err,
  };
}

function fakeClient(recorder) {
  return {
    pages: {
      create: async (args) => {
        recorder.creates.push(args);
        return { id: `created-${recorder.creates.length}` };
      },
      update: async (args) => {
        recorder.updates.push(args);
        return { id: args.page_id };
      },
    },
  };
}

function baseDeps(overrides = {}) {
  return {
    loadProfile: () => ({
      paths: { root: "/fake/profiles/jared" },
      notion: { companies_db_id: "db-123" },
    }),
    loadSecrets: () => ({ NOTION_TOKEN: "secret-token" }),
    makeClient: () => overrides.__client,
    resolveDataSourceId: async () => "ds-123",
    readTargetsRows: () => [targetRow()],
    readNamesColumn: () => [],
    fetchCompaniesPages: async () => [],
    ...overrides,
  };
}

test("dry-run: plans a create, writes nothing", async () => {
  const rec = { creates: [], updates: [] };
  const client = fakeClient(rec);
  const cmd = makeCompaniesUpsertCommand(baseDeps({ __client: client, makeClient: () => client }));
  const { ctx, out } = makeCtx({ flags: { apply: false } });
  const code = await cmd(ctx);
  assert.strictEqual(code, 0);
  assert.strictEqual(rec.creates.length, 0);
  assert.ok(out.some((l) => l.includes("1 to create")));
  assert.ok(out.some((l) => l.includes("dry-run")));
});

test("--apply: creates a Notion page for the new company", async () => {
  const rec = { creates: [], updates: [] };
  const client = fakeClient(rec);
  const cmd = makeCompaniesUpsertCommand(baseDeps({ __client: client, makeClient: () => client }));
  const { ctx } = makeCtx({ flags: { apply: true } });
  const code = await cmd(ctx);
  assert.strictEqual(code, 0);
  assert.strictEqual(rec.creates.length, 1);
  assert.deepStrictEqual(rec.creates[0].parent, { database_id: "db-123" });
  assert.ok(rec.creates[0].properties.Name);
  assert.ok(rec.creates[0].properties.Website);
  assert.ok(!rec.creates[0].properties.Tier);
});

test("--apply: existing page with empty fields gets a fill, not a create", async () => {
  const rec = { creates: [], updates: [] };
  const client = fakeClient(rec);
  const cmd = makeCompaniesUpsertCommand(
    baseDeps({
      __client: client,
      makeClient: () => client,
      fetchCompaniesPages: async () => [
        {
          id: "page-existing",
          properties: {
            Name: { title: [{ plain_text: "New Co" }] },
            Website: { url: "https://newco.com" },
            Notes: { rich_text: [] },
            "Why Interested": { rich_text: [{ plain_text: "kept" }] },
            "Careers URL": { url: "" },
            "Outbound Status": { select: { name: "Contacted" } },
          },
        },
      ],
    })
  );
  const { ctx } = makeCtx({ flags: { apply: true } });
  const code = await cmd(ctx);
  assert.strictEqual(code, 0);
  assert.strictEqual(rec.creates.length, 0);
  assert.strictEqual(rec.updates.length, 1);
  assert.strictEqual(rec.updates[0].page_id, "page-existing");
  // only the empty fields (Notes, Careers URL) get patched
  const patched = Object.keys(rec.updates[0].properties).sort();
  assert.deepStrictEqual(patched, ["Careers URL", "Notes"]);
});

test("missing token: --apply is a no-op with exit 1", async () => {
  const rec = { creates: [], updates: [] };
  const client = fakeClient(rec);
  const cmd = makeCompaniesUpsertCommand(
    baseDeps({ __client: client, makeClient: () => client, loadSecrets: () => ({}) })
  );
  const { ctx, err } = makeCtx({ flags: { apply: true } });
  const code = await cmd(ctx);
  assert.strictEqual(code, 1);
  assert.strictEqual(rec.creates.length, 0);
  assert.ok(err.some((l) => l.includes("NOTION_TOKEN")));
});

test("missing companies_db_id -> error exit 1", async () => {
  const cmd = makeCompaniesUpsertCommand(
    baseDeps({ loadProfile: () => ({ paths: { root: "/x" }, notion: {} }) })
  );
  const { ctx, err } = makeCtx({});
  const code = await cmd(ctx);
  assert.strictEqual(code, 1);
  assert.ok(err.some((l) => l.includes("companies_db_id")));
});

test("no targets -> clean exit 0", async () => {
  const cmd = makeCompaniesUpsertCommand(baseDeps({ readTargetsRows: () => [] }));
  const { ctx, out } = makeCtx({});
  const code = await cmd(ctx);
  assert.strictEqual(code, 0);
  assert.ok(out.some((l) => l.includes("no relokant targets")));
});
