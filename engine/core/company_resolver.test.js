const { test } = require("node:test");
const assert = require("node:assert/strict");

const { makeCompanyResolver } = require("./company_resolver.js");

function fakeClient({ existing = {}, onCreate } = {}) {
  const calls = { queries: [], creates: [] };
  const client = {
    dataSources: {
      query: async (params) => {
        calls.queries.push(params);
        const filter = params.filter || {};
        const wanted = filter.title && filter.title.equals;
        if (existing[wanted]) return { results: [{ id: existing[wanted] }] };
        return { results: [] };
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
