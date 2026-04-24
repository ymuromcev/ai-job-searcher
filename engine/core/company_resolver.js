// Resolves a company name to a Notion page id in the per-profile Companies DB.
// Lookup-or-create:
//   1. dataSources.query by title = name (case-sensitive; Notion doesn't expose
//      a built-in case-insensitive match, so we rely on caller-normalised names).
//   2. If no match, pages.create with Name = name and Tier = profile tier (if known).
//
// Results are cached in-memory per-instance to avoid repeated API calls within
// a single command invocation. The resolver is pure w.r.t. profiles: it takes
// a client, db id, data_source id, and a tier map.
//
// The caller is responsible for constructing the client and looking up the
// Companies DB id + data_source_id from profile.notion.companies_db_id.
//
// Title property is assumed to be named "Name" (default for our Companies DB).

function makeCompanyResolver({
  client,
  companiesDbId,
  companiesDataSourceId,
  companyTiers = {},
  titleField = "Name",
  log = () => {},
}) {
  if (!client) throw new Error("client is required");
  if (!companiesDbId) throw new Error("companiesDbId is required");
  if (!companiesDataSourceId) throw new Error("companiesDataSourceId is required");

  const cache = new Map();

  async function lookup(name) {
    const resp = await client.dataSources.query({
      data_source_id: companiesDataSourceId,
      filter: { property: titleField, title: { equals: name } },
      page_size: 1,
    });
    const results = Array.isArray(resp && resp.results) ? resp.results : [];
    return results.length ? results[0].id : null;
  }

  async function create(name) {
    const tier = companyTiers[name] || null;
    const properties = {
      [titleField]: { title: [{ text: { content: name } }] },
    };
    if (tier) properties.Tier = { select: { name: tier } };

    const page = await client.pages.create({
      parent: { database_id: companiesDbId },
      properties,
    });
    log(`created company: ${name} (${page.id}${tier ? `, tier=${tier}` : ""})`);
    return page.id;
  }

  async function resolve(rawName) {
    if (!rawName) return null;
    const name = String(rawName).trim();
    if (!name) return null;

    if (cache.has(name)) return cache.get(name);

    let id = await lookup(name);
    if (!id) id = await create(name);

    cache.set(name, id);
    return id;
  }

  // Batch variant: parallel but bounded. Returns a map { name -> page_id | null }.
  async function resolveMany(names, { concurrency = 4 } = {}) {
    const unique = Array.from(new Set(names.filter(Boolean).map((n) => String(n).trim())));
    const out = {};
    let idx = 0;
    async function worker() {
      while (idx < unique.length) {
        const i = idx++;
        const n = unique[i];
        out[n] = await resolve(n);
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, unique.length) }, () => worker());
    await Promise.all(workers);
    return out;
  }

  return { resolve, resolveMany, _cache: cache };
}

module.exports = { makeCompanyResolver };
