// engine/core/notion_job_page.js
//
// Thin orchestrator that creates one Notion page in the per-profile Jobs
// Pipeline DB for one "to_apply" row. Owned by `prepare --phase commit`
// (RFC 022): atomic per-row PDF → Notion → TSV commit replaces the legacy
// SKILL Step 9 + Step 9.0 skip-guard.
//
// Pure-ish: takes pre-built dependencies (client, resolver) and a flat
// `jobFields` payload. Does no filesystem / no env access. All side
// effects go through the injected `client` (createJobPage, dataSources.query).
//
// Two guards prevent duplicate Notion pages on retry:
//   1. Caller-side: skip rows where TSV already has notion_page_id.
//   2. Here: dedup-by-`key` query against Jobs DB before create. Closes
//      the "engine crashed after Notion-create, before saveApplications"
//      window (notion_page_id in Notion but not yet in TSV).

const notion = require("./notion_sync.js");

// ---------- Salary display formatter ----------
//
// Formats a numeric salary range into the human-readable string that lands
// in the Notion "Salary Expectations" rich_text field. Mid is the
// arithmetic mean rounded to the nearest $5K (matches SKILL Step 9 output).
// Returns "" when both bounds are absent — caller should then omit the
// field (buildProperties drops empty strings).
//
// Examples:
//   formatSalaryDisplay(140000, 190000) → "$140-190K ($165K mid)"
//   formatSalaryDisplay(150000, null)   → "$150K+"
//   formatSalaryDisplay(null, 200000)   → "up to $200K"
//   formatSalaryDisplay(null, null)     → ""

function formatSalaryDisplay(minDollars, maxDollars) {
  const min = toNumberOrNull(minDollars);
  const max = toNumberOrNull(maxDollars);
  if (min === null && max === null) return "";
  const toK = (n) => Math.round(n / 1000);
  if (min !== null && max !== null) {
    const mid = Math.round((min + max) / 2 / 5000) * 5000;
    return `$${toK(min)}-${toK(max)}K ($${toK(mid)}K mid)`;
  }
  if (min !== null) return `$${toK(min)}K+`;
  return `up to $${toK(max)}K`;
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// ---------- Dedup lookup ----------
//
// Closes idempotency hole (RFC 022 §6.a): if engine wrote to Notion but
// crashed before saveApplications, the next run would otherwise create
// a duplicate page. One small dataSources.query before create catches it.
//
// Returns existing page id, or null if no match. Throws on client errors;
// the caller decides whether to treat as fatal.

async function findExistingJobPage({ client, jobsDataSourceId, propertyMap, key }) {
  if (!key) return null;
  const keyField = propertyMap.key && propertyMap.key.field;
  if (!keyField) return null;
  const resp = await client.dataSources.query({
    data_source_id: jobsDataSourceId,
    filter: { property: keyField, rich_text: { equals: String(key) } },
    page_size: 1,
  });
  const results = Array.isArray(resp && resp.results) ? resp.results : [];
  return results.length > 0 ? results[0].id : null;
}

// ---------- Push one job ----------
//
// `jobFields` must carry the flat object that buildProperties consumes.
// Caller is responsible for assembling all field origins (see RFC 022 §4
// and prepare.js buildJobFieldsForNotion). companyRelation is filled in
// here from the resolver — caller passes companyName instead.

async function pushJobPage({
  client,
  jobsDbId,
  jobsDataSourceId,
  propertyMap,
  companyResolver,
  jobFields,
  // testing hook — defaults wire to notion_sync.
  createJobPage = notion.createJobPage,
  resolveDataSourceId = notion.resolveDataSourceId,
}) {
  if (!client) throw new Error("client is required");
  if (!jobsDbId) throw new Error("jobsDbId is required");
  if (!propertyMap) throw new Error("propertyMap is required");
  if (!companyResolver || typeof companyResolver.resolve !== "function") {
    throw new Error("companyResolver with resolve() is required");
  }
  if (!jobFields || typeof jobFields !== "object") {
    throw new Error("jobFields object is required");
  }
  if (!jobFields.key) throw new Error("jobFields.key is required for dedup");

  // Resolve data_source_id lazily — caller may have it cached, or we look
  // it up once. (Tests pass an in-memory jobsDataSourceId to skip the API.)
  const dsId = jobsDataSourceId || (await resolveDataSourceId(client, jobsDbId));

  // Guard 1: dedup against existing page by key.
  const existingId = await findExistingJobPage({
    client,
    jobsDataSourceId: dsId,
    propertyMap,
    key: jobFields.key,
  });
  if (existingId) {
    return { pageId: existingId, dedup: true };
  }

  // Resolve Company relation. resolver returns null when name is empty —
  // we still push the page, just without the relation field.
  const companyPageId = await companyResolver.resolve(jobFields.companyName);

  // Compose the payload buildProperties expects. We MUST NOT include the
  // raw companyName — buildProperties only knows the mapped field shape.
  const payload = { ...jobFields };
  delete payload.companyName;
  if (companyPageId) {
    payload.companyRelation = [companyPageId];
  } else {
    delete payload.companyRelation;
  }

  const page = await createJobPage(client, jobsDbId, payload, propertyMap);
  return { pageId: page.id, dedup: false };
}

module.exports = {
  formatSalaryDisplay,
  findExistingJobPage,
  pushJobPage,
};
