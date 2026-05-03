// Adzuna keyword-search discovery adapter.
//   https://api.adzuna.com/v1/api/jobs/us/search/{page}
//
// Keyword-search mode: queries Adzuna with PM-specific terms rather than
// targeting specific companies. Delivers 30–100 PM listings per scan
// regardless of company, from a wide pool including Greenhouse, Lever,
// Workday, and other ATS boards aggregated by Adzuna.
//
// feedMode: true — scan.js CLI injects a synthetic target so companies.tsv
// is not required. The `targets` argument is ignored.
//
// Secrets (from ctx.secrets, prefix-stripped by profile_loader):
//   ADZUNA_APP_ID, ADZUNA_API_KEY
// Free tier: https://developer.adzuna.com/ — 250 searches/month, no credit card.
//
// Discovery config (from ctx.discovery.keyword_search in profile.json):
//   keywords         string[]  default: ["Product Manager", "Senior Product Manager"]
//   location         string    default: "United States"
//   results_per_keyword number default: 50
//   max_age_days     number    default: 30

const { assertJob } = require("./_types.js");
const { defaultFetch } = require("./_http.js");
const { sanitizeText, parseIsoDate, dedupeLocations } = require("./_normalize.js");

const SOURCE = "adzuna";
const BASE = "https://api.adzuna.com/v1/api/jobs/us/search/1";

const DEFAULT_KEYWORDS = ["Product Manager", "Senior Product Manager"];
const DEFAULT_LOCATION = "United States";
const DEFAULT_RESULTS_PER_KEYWORD = 50;
const DEFAULT_MAX_AGE_DAYS = 30;

function companySlug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}

function mapJob(listing) {
  const company = sanitizeText(
    (listing.company && listing.company.display_name) || "Unknown"
  );
  const location = sanitizeText(
    (listing.location && listing.location.display_name) || ""
  );
  const job = {
    source: SOURCE,
    slug: companySlug(company),
    companyName: company,
    jobId: String(listing.id),
    title: sanitizeText(listing.title),
    url: String(listing.redirect_url || ""),
    locations: dedupeLocations([location]),
    team: null,
    postedAt: parseIsoDate(listing.created),
    rawExtra: {
      description: typeof listing.description === "string"
        ? listing.description.slice(0, 1000)
        : null,
      contractType: listing.contract_type || null,
    },
  };
  assertJob(job);
  return job;
}

async function fetchKeyword(fetchFn, appId, appKey, keyword, location, maxDays, resultsPerPage, logger) {
  const qs = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    what: keyword,
    where: location,
    max_days: String(maxDays),
    results_per_page: String(resultsPerPage),
    "content-type": "application/json",
  }).toString();
  const url = `${BASE}?${qs}`;

  let body;
  try {
    const res = await fetchFn(url, { timeoutMs: 20000, retries: 1 });
    if (!res.ok) {
      logger.warn(`[adzuna] HTTP ${res.status} for keyword "${keyword}"`);
      return [];
    }
    body = await res.json();
  } catch (err) {
    logger.warn(`[adzuna] fetch error for keyword "${keyword}": ${err.message}`);
    return [];
  }

  const results = Array.isArray(body && body.results) ? body.results : [];
  const jobs = [];
  for (const listing of results) {
    if (!listing || !listing.id) continue;
    try {
      jobs.push(mapJob(listing));
    } catch (err) {
      logger.warn(`[adzuna] skip listing ${listing.id}: ${err.message}`);
    }
  }
  return jobs;
}

async function discover(targets, ctx = {}) {
  const fetchFn = (ctx && ctx.fetchFn) || defaultFetch;
  const logger = (ctx && ctx.logger) || { warn: () => {} };
  const secrets = (ctx && ctx.secrets) || {};
  const kwConfig = (ctx && ctx.discovery && ctx.discovery.keyword_search) || {};

  const appId = secrets.ADZUNA_APP_ID;
  const appKey = secrets.ADZUNA_API_KEY;
  if (!appId || !appKey) {
    logger.warn("[adzuna] missing ADZUNA_APP_ID or ADZUNA_API_KEY — skipping");
    return [];
  }

  const keywords = Array.isArray(kwConfig.keywords) && kwConfig.keywords.length > 0
    ? kwConfig.keywords
    : DEFAULT_KEYWORDS;
  const location = (typeof kwConfig.location === "string" && kwConfig.location)
    ? kwConfig.location
    : DEFAULT_LOCATION;
  const resultsPerKeyword = Number.isFinite(Number(kwConfig.results_per_keyword))
    ? Math.min(Number(kwConfig.results_per_keyword), 50) // Adzuna max per page
    : DEFAULT_RESULTS_PER_KEYWORD;
  const maxAgeDays = Number.isFinite(Number(kwConfig.max_age_days))
    ? Number(kwConfig.max_age_days)
    : DEFAULT_MAX_AGE_DAYS;

  // Run keywords serially to be polite to the API (free tier rate limits).
  const allJobs = [];
  const seenIds = new Set();
  for (const keyword of keywords) {
    const jobs = await fetchKeyword(
      fetchFn, appId, appKey, keyword, location, maxAgeDays, resultsPerKeyword, logger
    );
    for (const job of jobs) {
      if (!seenIds.has(job.jobId)) {
        seenIds.add(job.jobId);
        allJobs.push(job);
      }
    }
  }

  return allJobs;
}

module.exports = { source: SOURCE, discover, feedMode: true };
