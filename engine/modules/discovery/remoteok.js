// RemoteOK public JSON feed adapter.
//   https://remoteok.com/api
//
// Feed-based: fetches the global feed (~100 most-recent jobs) on every call,
// regardless of `targets`. Pre-filters by US-compat locations + a profile-aware
// title gate. Unlike the_muse (which has API-level `?category=Product`), remoteok
// returns mixed PM/SWE/Designer jobs, so adapter-level title filtering keeps
// the shared pool from ballooning by ~100 archived rows per scan.
//
// Title filter sourcing (G-3, 2026-05-04):
//   - `ctx.filterRules.title_requirelist.patterns` if provided — single source
//     of truth, profile-driven.
//   - Falls back to `DEFAULT_PM_RE` for back-compat when the caller didn't
//     plumb filter rules (older tests, ad-hoc scripts).
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
const DEFAULT_PM_RE = /product\s+manag/i;

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Compile a single regex from profile's `title_requirelist.patterns` (the same
// list that filter.matchBlocklists uses at scan-time gate). Falls back to the
// default PM regex when the profile didn't declare a requirelist.
function buildTitleFilter(filterRules) {
  const patterns =
    (filterRules && filterRules.title_requirelist && filterRules.title_requirelist.patterns) ||
    [];
  const tokens = patterns
    .map((p) => String(p && p.pattern ? p.pattern : "").trim())
    .filter(Boolean);
  if (tokens.length === 0) return DEFAULT_PM_RE;
  // Build word-boundary regex: \b(token1|token2|...)\b. Patterns may contain
  // multi-word tokens (e.g. "product manager") — escape and join.
  const alts = tokens.map((t) => escapeRegex(t)).join("|");
  return new RegExp(`\\b(${alts})\\b`, "i");
}

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
  // G-3: derive the title gate from profile's title_requirelist when plumbed.
  const titleRe = buildTitleFilter(ctx && ctx.filterRules);

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
    if (!titleRe.test(j.position || "")) continue;
    if (!isUsCompatible(j.location)) continue;
    try {
      jobs.push(mapJob(j));
    } catch (err) {
      logger.warn(`[remoteok] skip job ${j.id}: ${err.message}`);
    }
  }
  return jobs;
}

module.exports = { source: SOURCE, discover, feedMode: true, buildTitleFilter, DEFAULT_PM_RE };
