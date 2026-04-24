// RemoteOK public JSON feed adapter.
//   https://remoteok.com/api
//
// Feed-based: fetches the global feed (~100 most-recent jobs) on every call,
// regardless of `targets`. Filters for PM titles and US-compatible locations.
//
// Feed shape: first element is a legal/meta block (no `id`); skip it.
// Job shape: { id, company, position, location, url, slug, date, tags }
//
// To enable in a profile:
//   1. Add "discovery:remoteok" to profile.json `modules`.
//   2. The scan command automatically injects a synthetic feed target because
//      this adapter exports `feedMode: true` (no companies.tsv entry required).

const { assertJob } = require("./_types.js");
const { defaultFetch } = require("./_http.js");
const { parseIsoDate, dedupeLocations } = require("./_normalize.js");

const SOURCE = "remoteok";
const FEED_URL = "https://remoteok.com/api";
const PM_RE = /product\s+manag/i;

// Reject locations that are clearly non-US. Keep "Anywhere"/"Worldwide"/"Remote"
// (usually accept US applicants) and unknown locations (keep = inclusive default).
const NON_US_RE = /(india|europe|^eu$|emea|apac|australia|brazil|mexico|canada only|uk only|united kingdom only|russia|ukraine|philippines|only lat|only apac|only emea)/i;

function isUsCompatible(loc) {
  if (!loc) return true;
  const l = loc.toLowerCase();
  if (/anywhere|worldwide|global|remote/i.test(l) && !NON_US_RE.test(l)) return true;
  if (/united states|\busa\b|\bu\.s\.a\b|\bus$|\bca$|california|new york|san francisco|texas|washington|seattle|boston|chicago|denver|austin|oregon|arizona|colorado|florida|georgia|illinois/i.test(l)) return true;
  if (NON_US_RE.test(l)) return false;
  return true; // unknown → keep (inclusive)
}

function companySlug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "remoteok";
}

function mapJob(j) {
  const company = String(j.company || "Unknown");
  const job = {
    source: SOURCE,
    slug: companySlug(company),
    companyName: company,
    jobId: String(j.id),
    title: String(j.position || j.role || ""),
    url: j.url || `https://remoteok.com/remote-jobs/${j.slug || j.id}`,
    locations: dedupeLocations([j.location || "Remote"]),
    team: null,
    postedAt: parseIsoDate(j.date),
    rawExtra: { tags: Array.isArray(j.tags) ? j.tags : [] },
  };
  assertJob(job);
  return job;
}

async function discover(targets, ctx = {}) {
  const fetchFn = (ctx && ctx.fetchFn) || defaultFetch;
  const logger = (ctx && ctx.logger) || { warn: () => {} };

  let data;
  try {
    const res = await fetchFn(FEED_URL, {
      timeoutMs: 15000,
      retries: 1,
      headers: { "User-Agent": "Mozilla/5.0 (AIJobSearcher/0.1)" },
    });
    if (!res.ok) {
      logger.warn(`[remoteok] feed returned HTTP ${res.status}`);
      return [];
    }
    data = await res.json();
  } catch (err) {
    logger.warn(`[remoteok] fetch error: ${err.message}`);
    return [];
  }

  if (!Array.isArray(data)) {
    logger.warn("[remoteok] unexpected response shape");
    return [];
  }

  const jobs = [];
  for (const j of data) {
    if (!j || !j.id) continue; // skip meta block and malformed entries
    if (!PM_RE.test(j.position || "")) continue;
    if (!isUsCompatible(j.location)) continue;
    try {
      jobs.push(mapJob(j));
    } catch (err) {
      logger.warn(`[remoteok] skip job ${j.id}: ${err.message}`);
    }
  }
  return jobs;
}

module.exports = { source: SOURCE, discover, feedMode: true };
