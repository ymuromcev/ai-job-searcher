const { test } = require("node:test");
const assert = require("node:assert/strict");

const { makeCompanyResolver } = require("./company_resolver.js");

// `existing` accepts two shapes (back-compat):
//   - string:  Affirm: "page-affirm"          → page with no Tier prop
//   - object:  Affirm: { id, tier: "S" }      → page with Tier.select.name = tier
function fakeClient({ existing = {}, onCreate, supportsUpdate = true } = {}) {
  const calls = { queries: [], creates: [], updates: [] };
  const client = {
    dataSources: {
      query: async (params) => {
        calls.queries.push(params);
        const filter = params.filter || {};
        const wanted = filter.title && filter.title.equals;
        const entry = existing[wanted];
        if (!entry) return { results: [] };
        if (typeof entry === "string") {
          return { results: [{ id: entry, properties: {} }] };
        }
        const props = {};
        if (entry.tier) {
          props.Tier = { select: { name: entry.tier } };
        } else {
          props.Tier = { select: null };
        }
        return { results: [{ id: entry.id, properties: props }] };
      },
    },
    pages: {
      create: async (params) => {
        calls.creates.push(params);
        const id = onCreate ? onCreate(params) : `new-${calls.creates.length}`;
        return { id };
      },
    },
  };
  if (supportsUpdate) {
    client.pages.update = async (params) => {
      calls.updates.push(params);
      return { id: params.page_id };
    };
  }
  return { client, calls };
}

test("resolve: returns existing page id without creating", async () => {
  const { client, calls } = fakeClient({ existing: { Affirm: "page-affirm" } });
  const resolver = makeCompanyResolver({
    client,
    companiesDbId: "db",
    companiesDataSourceId: "ds",
  });
  const id = await resolver.resolve("Affirm");
  assert.equal(id, "page-affirm");
  assert.equal(calls.creates.length, 0);
});

test("resolve: creates page with Tier from companyTiers when not found", async () => {
  const { client, calls } = fakeClient();
  const resolver = makeCompanyResolver({
    client,
    companiesDbId: "db",
    companiesDataSourceId: "ds",
    companyTiers: { Affirm: "S", Ramp: "A" },
  });
  const id = await resolver.resolve("Affirm");
  assert.equal(id, "new-1");
  assert.equal(calls.creates.length, 1);
  const payload = calls.creates[0];
  assert.equal(payload.parent.database_id, "db");
  assert.equal(payload.properties.Name.title[0].text.content, "Affirm");
  assert.equal(payload.properties.Tier.select.name, "S");
});

test("resolve: creates page without Tier when not in companyTiers", async () => {
  const { client, calls } = fakeClient();
  const resolver = makeCompanyResolver({
    client,
    companiesDbId: "db",
    companiesDataSourceId: "ds",
    companyTiers: {},
  });
  await resolver.resolve("UnknownCo");
  assert.equal(calls.creates[0].properties.Tier, undefined);
});

test("resolve: caches results — repeat lookup doesn't hit API", async () => {
  const { client, calls } = fakeClient({ existing: { Affirm: "page-affirm" } });
  const resolver = makeCompanyResolver({
    client,
    companiesDbId: "db",
    companiesDataSourceId: "ds",
  });
  const a = await resolver.resolve("Affirm");
  const b = await resolver.resolve("Affirm");
  assert.equal(a, b);
  assert.equal(calls.queries.length, 1);
});

test("resolve: null/empty input returns null", async () => {
  const { client, calls } = fakeClient();
  const resolver = makeCompanyResolver({
    client,
    companiesDbId: "db",
    companiesDataSourceId: "ds",
  });
  assert.equal(await resolver.resolve(null), null);
  assert.equal(await resolver.resolve(""), null);
  assert.equal(await resolver.resolve("   "), null);
  assert.equal(calls.queries.length, 0);
});

test("resolve: trims whitespace", async () => {
  const { client } = fakeClient({ existing: { Stripe: "page-stripe" } });
  const resolver = makeCompanyResolver({
    client,
    companiesDbId: "db",
    companiesDataSourceId: "ds",
  });
  assert.equal(await resolver.resolve("  Stripe  "), "page-stripe");
});

test("resolveMany: resolves a batch with dedup and returns map", async () => {
  const { client, calls } = fakeClient({ existing: { Affirm: "a", Stripe: "s" } });
  const resolver = makeCompanyResolver({
    client,
    companiesDbId: "db",
    companiesDataSourceId: "ds",
  });
  const out = await resolver.resolveMany(["Affirm", "Stripe", "Affirm", "Stripe"]);
  assert.deepEqual(out, { Affirm: "a", Stripe: "s" });
  assert.equal(calls.queries.length, 2, "each unique name queried once");
});

test("makeCompanyResolver: throws on missing required args", () => {
  assert.throws(
    () => makeCompanyResolver({ companiesDbId: "x", companiesDataSourceId: "y" }),
    /client is required/
  );
  assert.throws(
    () => makeCompanyResolver({ client: {}, companiesDataSourceId: "y" }),
    /companiesDbId is required/
  );
  assert.throws(
    () => makeCompanyResolver({ client: {}, companiesDbId: "x" }),
    /companiesDataSourceId is required/
  );
});

// --- syncTier (G-11/G-15) ----------------------------------------------------

test("syncTier: patches existing page when Notion Tier is empty but profile knows it", async () => {
  const { client, calls } = fakeClient({
    existing: { Affirm: { id: "page-affirm", tier: null } },
  });
  const resolver = makeCompanyResolver({
    client,
    companiesDbId: "db",
    companiesDataSourceId: "ds",
    companyTiers: { Affirm: "S" },
  });
  const id = await resolver.resolve("Affirm");
  assert.equal(id, "page-affirm");
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].page_id, "page-affirm");
  assert.equal(calls.updates[0].properties.Tier.select.name, "S");
});

test("syncTier: does NOT overwrite an already-set tier on Notion", async () => {
  const { client, calls } = fakeClient({
    existing: { Affirm: { id: "page-affirm", tier: "B" } },
  });
  const resolver = makeCompanyResolver({
    client,
    companiesDbId: "db",
    companiesDataSourceId: "ds",
    companyTiers: { Affirm: "S" }, // profile says S, Notion already has B → leave Notion alone
  });
  await resolver.resolve("Affirm");
  assert.equal(calls.updates.length, 0);
});

test("syncTier: skips when profile has no tier for company", async () => {
  const { client, calls } = fakeClient({
    existing: { Mystery: { id: "page-mystery", tier: null } },
  });
  const resolver = makeCompanyResolver({
    client,
    companiesDbId: "db",
    companiesDataSourceId: "ds",
    companyTiers: {}, // no tier known
  });
  await resolver.resolve("Mystery");
  assert.equal(calls.updates.length, 0);
});

test("syncTier: idempotent within a run — repeat resolve doesn't re-patch", async () => {
  const { client, calls } = fakeClient({
    existing: { Affirm: { id: "page-affirm", tier: null } },
  });
  const resolver = makeCompanyResolver({
    client,
    companiesDbId: "db",
    companiesDataSourceId: "ds",
    companyTiers: { Affirm: "S" },
  });
  await resolver.resolve("Affirm");
  await resolver.resolve("Affirm");
  await resolver.resolve("Affirm");
  // First call patches; subsequent calls hit the in-memory cache anyway.
  assert.equal(calls.updates.length, 1);
});

test("syncTier: gracefully skips when client lacks pages.update", async () => {
  const { client, calls } = fakeClient({
    existing: { Affirm: { id: "page-affirm", tier: null } },
    supportsUpdate: false,
  });
  const resolver = makeCompanyResolver({
    client,
    companiesDbId: "db",
    companiesDataSourceId: "ds",
    companyTiers: { Affirm: "S" },
  });
  // Should not throw — guard returns early. Validates back-compat for older
  // Notion SDK shims that may not expose pages.update.
  const id = await resolver.resolve("Affirm");
  assert.equal(id, "page-affirm");
  assert.equal(calls.updates.length, 0);
});
