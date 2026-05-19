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
//   keywords         string[]  default: derived from filterRules.role_targets
//                               (RFC 030/033 single source of truth) when
//                               absent/empty; otherwise the hardcoded fallback
//                               ["Product Manager", "Senior Product Manager"].
//   location         string    default: "United States"
//   results_per_keyword number default: 50
//   max_age_days     number    default: 30
//
// Keyword derivation (BL-87, 2026-05-18):
//   When `keyword_search.keywords` is absent or empty, read
//   `ctx.filterRules.role_targets.tracks[].patterns[].pattern`,
//   flatten + dedupe (case-insensitive, preserve original casing),
//   strip regex anchors (^, $, \b), expand simple `(a|b)` alternations,
//   skip patterns too regex-y to convert. This keeps adzuna aligned with
//   role_targets so a profile only edits one place.

const { assertJob } = require("./_types.js");
const { defaultFetch } = require("./_http.js");
const { sanitizeText, parseIsoDate, dedupeLocations } = require("./_normalize.js");

const SOURCE = "adzuna";
const BASE = "https://api.adzuna.com/v1/api/jobs/us/search/1";

const DEFAULT_KEYWORDS = ["Product Manager", "Senior Product Manager"];
const DEFAULT_LOCATION = "United States";
const DEFAULT_RESULTS_PER_KEYWORD = 50;
const DEFAULT_MAX_AGE_DAYS = 30;

// BL-87: regex tokens we don't try to query as plain keywords. If a pattern
// contains any of these after anchor-stripping + alternation expansion, the
// pattern is dropped (silent skip — fallback handles empty result).
//   - character classes  : [ ]
//   - backslash classes  : \w \d \s \b \W \D \S (after anchor strip we still
//                          see \w-style remnants; treat anything `\<letter>`
//                          as regex-y)
//   - quantifiers        : ? * + { }
//   - leftover parens    : ( )
//   - alternation pipe   : | (only inside an unconverted group; bare top-level
//                          pipes are unusual and we err on dropping)
const REGEXY_RE = /[\[\]?*+{}()|]|\\[a-zA-Z]/;

// Strip regex anchors from a single token (no parens involved).
function stripAnchors(s) {
  return String(s || "")
    .replace(/\\b/g, "")
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .trim();
}

// Expand a SINGLE top-level `(a|b|c)` group into multiple tokens.
// Examples:
//   "product (manager|owner)" -> ["product manager", "product owner"]
//   "senior pm"               -> ["senior pm"] (no group, returned as-is)
//   "(a|b) (c|d)"             -> [] (two groups — too complex, skipped)
//   "(foo|bar)$"              -> ["foo", "bar"] (anchors already stripped)
// Returns [] when the group is unbalanced or contains regex-y inner content.
function expandSimpleAlternation(token) {
  const open = token.indexOf("(");
  if (open === -1) return [token];
  const close = token.indexOf(")", open + 1);
  if (close === -1) return [];
  // Reject if there's a second `(` after the first group — multiple groups
  // multiply combinatorially and we keep the conversion deliberate-small.
  if (token.indexOf("(", close) !== -1) return [];
  const before = token.slice(0, open);
  const inner = token.slice(open + 1, close);
  const after = token.slice(close + 1);
  // Inner must be a flat `a|b|c` list — no nested groups, anchors, or
  // regex meta in any alternative.
  if (!inner.includes("|")) return [];
  const alts = inner
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  if (alts.length === 0) return [];
  if (alts.some((a) => REGEXY_RE.test(a))) return [];
  // before/after must be plain text too.
  if (REGEXY_RE.test(before) || REGEXY_RE.test(after)) return [];
  return alts.map((a) => `${before}${a}${after}`.trim()).filter(Boolean);
}

// Convert a single role-target pattern string into zero or more keyword
// strings. Returns [] when the pattern is too regex-y to safely query.
function patternToKeywords(rawPattern) {
  const stripped = stripAnchors(rawPattern);
  if (!stripped) return [];
  const expanded = expandSimpleAlternation(stripped);
  // Drop any leftover regex-y tokens (e.g. quantifiers `?+*`, char classes,
  // backslash escapes that aren't anchors). Anchors were already removed.
  return expanded.filter((t) => t && !REGEXY_RE.test(t));
}

// Walk `filterRules.role_targets.tracks[].patterns[]`, convert each, dedupe
// case-insensitively (preserving the original casing of the first occurrence),
// and return a flat keyword list. Empty array when nothing usable was found.
function deriveKeywordsFromRoleTargets(filterRules) {
  const rt = filterRules && filterRules.role_targets;
  const tracks = rt && Array.isArray(rt.tracks) ? rt.tracks : [];
  if (tracks.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const track of tracks) {
    const patterns = track && Array.isArray(track.patterns) ? track.patterns : [];
    for (const p of patterns) {
      const raw = p && typeof p === "object" ? p.pattern : p;
      if (!raw) continue;
      const expanded = patternToKeywords(raw);
      for (const kw of expanded) {
        const key = kw.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(kw);
      }
    }
  }
  return out;
}

function companySlug(name) {
  return (
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "unknown"
  );
}

function mapJob(listing) {
  const company = sanitizeText((listing.company && listing.company.display_name) || "Unknown");
  const location = sanitizeText((listing.location && listing.location.display_name) || "");
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
      description:
        typeof listing.description === "string" ? listing.description.slice(0, 1000) : null,
      contractType: listing.contract_type || null,
    },
  };
  assertJob(job);
  return job;
}

async function fetchKeyword(
  fetchFn,
  appId,
  appKey,
  keyword,
  location,
  maxDays,
  resultsPerPage,
  logger
) {
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

  // BL-87: when keyword_search.keywords is non-empty it wins (explicit
  // override). Otherwise derive from role_targets so the profile only has
  // to maintain one place. Final fallback = hardcoded PM defaults so
  // older profiles / ad-hoc test ctx still work.
  let keywords;
  if (Array.isArray(kwConfig.keywords) && kwConfig.keywords.length > 0) {
    keywords = kwConfig.keywords;
  } else {
    const derived = deriveKeywordsFromRoleTargets(ctx && ctx.filterRules);
    keywords = derived.length > 0 ? derived : DEFAULT_KEYWORDS;
  }
  const location =
    typeof kwConfig.location === "string" && kwConfig.location
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
      fetchFn,
      appId,
      appKey,
      keyword,
      location,
      maxAgeDays,
      resultsPerKeyword,
      logger
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

module.exports = {
  source: SOURCE,
  discover,
  feedMode: true,
  // Exported for unit tests (BL-87). Not part of the adapter contract.
  _internals: { deriveKeywordsFromRoleTargets, patternToKeywords },
};
