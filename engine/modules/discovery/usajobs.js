// USAJOBS.gov Search API adapter.
//   GET https://data.usajobs.gov/api/Search?{qs}&Page={N}
//   Headers: Host + User-Agent (email) + Authorization-Key.
//
// Target shape: { name, slug, query: { JobCategoryCode, LocationName, ... } }
//   Each target represents one search query; the adapter paginates over it.
// Secrets (from ctx.secrets, injected by the CLI via profile_loader.loadSecrets):
//   USAJOBS_API_KEY, USAJOBS_EMAIL.
//
// This adapter does NOT filter by title/geography/seniority — per RFC Engine
// isolation, profile-specific filtering belongs in core/filter.js.

const { fetchJson, runTargets, makeCtx } = require("./_ats.js");
const { assertJob } = require("./_types.js");
const { sanitizeText, parseIsoDate, dedupeLocations } = require("./_normalize.js");

const SOURCE = "usajobs";
const BASE = "https://data.usajobs.gov/api/Search";
const MAX_PAGES = 5;
const RESULTS_PER_PAGE = 50;

function mapJob(target, descriptor) {
  const locations = dedupeLocations(
    (descriptor.PositionLocation || []).map((l) => l && l.LocationName)
  );
  const companyName = sanitizeText(
    descriptor.OrganizationName || descriptor.DepartmentName || target.name
  );
  const postedAt = parseIsoDate(descriptor.PublicationStartDate);
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: companyName || target.name,
    jobId: String(descriptor.PositionID || descriptor.MatchedObjectId || ""),
    title: sanitizeText(descriptor.PositionTitle),
    url: String(descriptor.PositionURI || ""),
    locations,
    team: sanitizeText(descriptor.DepartmentName) || null,
    postedAt,
    rawExtra: {
      closingDate: parseIsoDate(descriptor.ApplicationCloseDate),
      category: descriptor.JobCategory || [],
    },
  };
  assertJob(job);
  return job;
}

async function fetchPages(fetchFn, headers, query, signal) {
  const items = [];
  const seenIds = new Set();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const qs = new URLSearchParams({
      ...query,
      ResultsPerPage: String(RESULTS_PER_PAGE),
      Page: String(page),
    }).toString();
    const body = await fetchJson(fetchFn, `${BASE}?${qs}`, { headers, signal });
    const batch = (body && body.SearchResult && body.SearchResult.SearchResultItems) || [];
    for (const it of batch) {
      const d = it && it.MatchedObjectDescriptor;
      if (!d) continue;
      const key = d.PositionID || it.MatchedObjectId;
      if (!key || seenIds.has(key)) continue;
      seenIds.add(key);
      items.push(d);
    }
    if (batch.length < RESULTS_PER_PAGE) break;
  }
  return items;
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  const apiKey = c.secrets.USAJOBS_API_KEY;
  const email = c.secrets.USAJOBS_EMAIL;
  if (!apiKey || !email) {
    (c.logger.warn || (() => {}))(
      "[usajobs] missing USAJOBS_API_KEY or USAJOBS_EMAIL in secrets — skipping"
    );
    return [];
  }
  const headers = {
    Host: "data.usajobs.gov",
    "User-Agent": email,
    "Authorization-Key": apiKey,
  };
  // USAJOBS allows ~5 req/s but we stay gentle on a single-key workload.
  const effectiveCtx = { ...c, concurrency: Math.min(c.concurrency || 2, 2) };
  return runTargets(targets, effectiveCtx, async (target) => {
    if (!target || !target.query) return [];
    const descriptors = await fetchPages(c.fetchFn, headers, target.query, c.signal);
    return descriptors.map((d) => mapJob(target, d)).filter(Boolean);
  });
}

module.exports = { source: SOURCE, discover };
