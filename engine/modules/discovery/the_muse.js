// The Muse public job-search API adapter.
//   https://www.themuse.com/api/public/jobs?category=Product&page=N
//
// Keyword-search mode: queries The Muse "Product" category, then filters
// for PM/Senior PM titles in the adapter. No API key required.
//
// feedMode: true — scan.js CLI injects a synthetic target so companies.tsv
// is not required. The `targets` argument is ignored.
//
// Response: { results: [{ id, name, company: { name }, locations: [{name}],
//              refs: { landing_page }, publication_date, levels: [{name}] }],
//             total, page_count }
//
// Title filter: only keep listings matching PM_RE (product manager / product
// lead / product owner / senior PM). The scan dedup + prepare title_requirelist
// together eliminate stray Product Designer / UX roles that slip through.

const { assertJob } = require("./_types.js");
const { defaultFetch } = require("./_http.js");
const { sanitizeText, parseIsoDate, dedupeLocations } = require("./_normalize.js");

const SOURCE = "the_muse";
const BASE = "https://www.themuse.com/api/public/jobs";
const MAX_PAGES = 4; // 20 results/page × 4 pages = up to 80 raw results
const PM_RE = /product\s+manag|product\s+lead|product\s+owner|\bsenior\s+pm\b|\bai\s+pm\b/i;

function companySlug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}

function mapJob(item) {
  const company = sanitizeText(
    (item.company && item.company.name) || "Unknown"
  );
  const locations = dedupeLocations(
    (Array.isArray(item.locations) ? item.locations : []).map(
      (l) => l && l.name
    )
  );
  const url = (item.refs && item.refs.landing_page) || "";
  const job = {
    source: SOURCE,
    slug: companySlug(company),
    companyName: company,
    jobId: String(item.id),
    title: sanitizeText(item.name),
    url: String(url),
    locations,
    team: null,
    postedAt: parseIsoDate(item.publication_date),
    rawExtra: {
      levels: Array.isArray(item.levels) ? item.levels.map((l) => l && l.name).filter(Boolean) : [],
    },
  };
  assertJob(job);
  return job;
}

async function discover(targets, ctx = {}) {
  const fetchFn = (ctx && ctx.fetchFn) || defaultFetch;
  const logger = (ctx && ctx.logger) || { warn: () => {} };

  const allJobs = [];
  const seenIds = new Set();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${BASE}?category=Product&page=${page}`;
    let body;
    try {
      const res = await fetchFn(url, {
        timeoutMs: 15000,
        retries: 1,
        headers: { "User-Agent": "Mozilla/5.0 (AIJobSearcher/0.1)" },
      });
      if (!res.ok) {
        logger.warn(`[the_muse] HTTP ${res.status} on page ${page}`);
        break;
      }
      body = await res.json();
    } catch (err) {
      logger.warn(`[the_muse] fetch error on page ${page}: ${err.message}`);
      break;
    }

    const results = Array.isArray(body && body.results) ? body.results : [];
    if (results.length === 0) break;

    for (const item of results) {
      if (!item || !item.id) continue;
      // Title-level PM filter: keep only PM / product lead / product owner titles.
      // The prepare-phase title_requirelist provides a second pass, but filtering
      // here keeps the shared pool clean of UX Designer / analyst noise.
      const title = String(item.name || "");
      if (!PM_RE.test(title)) continue;
      if (seenIds.has(String(item.id))) continue;
      seenIds.add(String(item.id));
      try {
        allJobs.push(mapJob(item));
      } catch (err) {
        logger.warn(`[the_muse] skip job ${item.id}: ${err.message}`);
      }
    }

    // Stop early if we've fetched all pages.
    const totalPages = body.page_count || 1;
    if (page + 1 >= totalPages) break;
  }

  return allJobs;
}

module.exports = { source: SOURCE, discover, feedMode: true };
