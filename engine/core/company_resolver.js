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
  // Tracks pages we patched in this run, to avoid duplicate updates.
  const patchedTier = new Set();

  async function lookup(name) {
    const resp = await client.dataSources.query({
      data_source_id: companiesDataSourceId,
      filter: { property: titleField, title: { equals: name } },
      page_size: 1,
    });
    const results = Array.isArray(resp && resp.results) ? resp.results : [];
    if (!results.length) return null;
    const page = results[0];
    const tierProp = page.properties && page.properties.Tier;
    const currentTier =
      tierProp && tierProp.select && tierProp.select.name ? tierProp.select.name : null;
    return { id: page.id, currentTier };
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

  // Sync Tier for an existing page when profile says we know the tier but
  // Notion is missing it (e.g. company seeded before tier was assigned).
  // Idempotent within a run via patchedTier set.
  async function syncTier(name, pageId, currentTier) {
    if (patchedTier.has(pageId)) return;
    const desired = companyTiers[name];
    if (!desired) return;
    if (currentTier === desired) return;
    if (currentTier) return; // never overwrite an already-set tier from Notion
    if (typeof client.pages.update !== "function") return;
    await client.pages.update({
      page_id: pageId,
      properties: { Tier: { select: { name: desired } } },
    });
    patchedTier.add(pageId);
    log(`patched company tier: ${name} → ${desired} (${pageId})`);
  }

  async function resolve(rawName) {
    if (!rawName) return null;
    const name = String(rawName).trim();
    if (!name) return null;

    if (cache.has(name)) return cache.get(name);

    let id;
    const found = await lookup(name);
    if (found) {
      id = found.id;
      await syncTier(name, id, found.currentTier);
    } else {
      id = await create(name);
    }

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

// Reverse resolver (page-id → company name). The forward resolver above maps
// a name to a Companies-DB page id when *creating* job pages. `sync`'s
// reconcile needs the opposite: a Notion job page exposes its company only as
// a `relation` (an array of Companies-DB page ids), and we need the human name
// to populate `applications.tsv`'s `companyName` column. Without this, every
// reconcile-added row lands with an empty company and is silently dropped from
// the email matcher's active set (RFC 058 / BL-168).
//
// Reads the title property (`Name` by default) of each Companies-DB page.
// In-run cache by page id; a missing / untitled / unreadable page resolves to
// `null` (caller leaves companyName empty rather than guessing).
function makeCompanyNameResolver({ client, titleField = "Name", log = () => {} }) {
  if (!client) throw new Error("client is required");
  const cache = new Map();

  function extractTitle(page) {
    const prop = page && page.properties && page.properties[titleField];
    const rt = prop && Array.isArray(prop.title) ? prop.title : null;
    if (!rt) return null;
    const text = rt
      .map((t) => (t && (t.plain_text || (t.text && t.text.content))) || "")
      .join("")
      .trim();
    return text || null;
  }

  async function resolveId(pageId) {
    if (!pageId) return null;
    const id = String(pageId);
    if (cache.has(id)) return cache.get(id);
    let name = null;
    try {
      const page = await client.pages.retrieve({ page_id: id });
      name = extractTitle(page);
    } catch (err) {
      log(`company name resolve failed for ${id}: ${err.message}`);
      name = null;
    }
    cache.set(id, name);
    return name;
  }

  // Returns a map { pageId -> name|null }. Bounded concurrency; deduped.
  async function resolveIds(ids, { concurrency = 4 } = {}) {
    const unique = Array.from(new Set((ids || []).filter(Boolean).map(String)));
    const out = {};
    let idx = 0;
    async function worker() {
      while (idx < unique.length) {
        const i = idx++;
        out[unique[i]] = await resolveId(unique[i]);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, unique.length) || 0 }, () => worker())
    );
    return out;
  }

  return { resolveId, resolveIds, _cache: cache };
}

module.exports = { makeCompanyResolver, makeCompanyNameResolver };
