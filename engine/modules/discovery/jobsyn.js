// NLX Jobsyn (Direct Employers Foundation) public job API.
//   GET https://prod-search-api.jobsyn.org/api/v1/solr/search
//     ?page=N&num_items=M
//   Header: X-Origin: {tenant-hostname}  — switches which employer's
//                                          listings the shared backend returns.
//
// Each target carries:
//   { name, slug, origin, locationAllow? }
//   origin        — hostname-shaped string sent verbatim as X-Origin (e.g.
//                   "dciinc.jobs"). Also used to build the apply URL
//                   (`https://{origin}/job/{guid}`). Required. Validated
//                   against a strict hostname pattern to prevent CRLF
//                   header injection.
//   locationAllow — substring patterns matched (case-insensitive) against the
//                   posting's `location_exact` (falling back to
//                   `"{city_exact}, {state_short}"`). Postings matching none
//                   are dropped client-side. Empty/unset = keep all.
//
// Response shape:
//   {
//     jobs: [{
//       guid, title_exact, location_exact, city_exact, state_short,
//       date_new, date_added, reqid, buid, category_exact, ...
//     }],
//     pagination: { has_more_pages, page, page_size, offset, total, total_pages }
//   }
//
// We drive pagination strictly off pagination.has_more_pages — independent
// of jobs.length vs page_size (so a page-size mismatch like the one that
// bit oracle_cloud cannot recur here).
//
// Concurrency hard-capped at 2: the Jobsyn backend is shared across many
// federal-contractor employers, so a single profile's scan must stay polite.

const { fetchJson, runTargets, makeCtx } = require("./_ats.js");
const { assertJob } = require("./_types.js");
const { sanitizeText, parseIsoDate, dedupeLocations } = require("./_normalize.js");

const SOURCE = "jobsyn";
const API_BASE = "https://prod-search-api.jobsyn.org/api/v1/solr/search";
const PAGE_SIZE = 100;
const MAX_JOBS_PER_TENANT = 5000;

// Hostname-shape: must start alnum, then alnum / dot / dash only, up to 254
// chars. Rejects whitespace, CR/LF (header injection), control chars, and
// outright junk like empty string or path fragments.
const ORIGIN_PATTERN = /^[a-z0-9][a-z0-9.-]{0,253}$/i;

function isValidOrigin(origin) {
  if (typeof origin !== "string" || !origin) return false;
  return ORIGIN_PATTERN.test(origin);
}

function buildPageUrl(page, numItems) {
  return `${API_BASE}?page=${page}&num_items=${numItems}`;
}

function joinCityState(city, state) {
  const c = sanitizeText(city);
  const s = sanitizeText(state);
  if (c && s) return `${c}, ${s}`;
  return c || s || "";
}

function locationMatchesAllow(primaryLocation, allow) {
  if (!Array.isArray(allow) || allow.length === 0) return true;
  const lt = String(primaryLocation == null ? "" : primaryLocation)
    .toLowerCase()
    .trim();
  if (!lt) return false;
  return allow.some((p) => {
    const needle = String(p == null ? "" : p)
      .toLowerCase()
      .trim();
    return needle.length > 0 && lt.includes(needle);
  });
}

function extract(body) {
  if (!body || typeof body !== "object") return { jobs: [], pagination: null };
  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  const pagination = body.pagination && typeof body.pagination === "object" ? body.pagination : null;
  return { jobs, pagination };
}

async function fetchAllPages(fetchFn, origin, signal) {
  const all = [];
  for (let page = 1; ; page += 1) {
    if (all.length >= MAX_JOBS_PER_TENANT) break;
    const url = buildPageUrl(page, PAGE_SIZE);
    const body = await fetchJson(fetchFn, url, {
      method: "GET",
      headers: { Accept: "application/json", "X-Origin": origin },
      signal,
    });
    const { jobs, pagination } = extract(body);
    all.push(...jobs);
    // Strict has_more_pages drives stop; if the field is missing or jobs is
    // empty, stop too (defensive — should not happen for a healthy NLX
    // response).
    if (!pagination || pagination.has_more_pages !== true) break;
    if (jobs.length === 0) break;
  }
  return all;
}

function mapJob(target, raw) {
  const id = raw && typeof raw.guid === "string" ? raw.guid.trim() : "";
  if (!id) return null;
  const primaryLocation =
    sanitizeText(raw.location_exact) || joinCityState(raw.city_exact, raw.state_short);
  if (!locationMatchesAllow(primaryLocation, target.locationAllow)) return null;
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId: id,
    title: sanitizeText(raw.title_exact),
    url: `https://${target.origin}/job/${id}`,
    locations: primaryLocation ? dedupeLocations([primaryLocation]) : [],
    team: sanitizeText(raw.category_exact) || null,
    postedAt: parseIsoDate(raw.date_new) || parseIsoDate(raw.date_added),
    rawExtra: {
      reqid: raw.reqid || null,
      buid: raw.buid || null,
    },
  };
  assertJob(job);
  return job;
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  // NLX backend is shared across tenants — be polite, cap at 2.
  const effectiveCtx = { ...c, concurrency: Math.min(c.concurrency || 2, 2) };
  return runTargets(targets, effectiveCtx, async (target) => {
    if (!target || !target.slug) return [];
    if (!isValidOrigin(target.origin)) {
      c.logger.warn(`[${SOURCE}] ${target.slug}: invalid origin "${target.origin}"`);
      return [];
    }
    const raws = await fetchAllPages(c.fetchFn, target.origin, c.signal);
    let droppedNoGuid = 0;
    let droppedByLocation = 0;
    const out = [];
    for (const r of raws) {
      const id = r && typeof r.guid === "string" ? r.guid.trim() : "";
      if (!id) {
        droppedNoGuid += 1;
        continue;
      }
      const job = mapJob(target, r);
      if (!job) {
        droppedByLocation += 1;
        continue;
      }
      out.push(job);
    }
    if (droppedNoGuid > 0) {
      c.logger.warn(`[${SOURCE}] ${target.slug}: dropped ${droppedNoGuid} postings without guid`);
    }
    if (droppedByLocation > 0) {
      c.logger.warn(
        `[${SOURCE}] ${target.slug}: dropped ${droppedByLocation} postings outside locationAllow`
      );
    }
    return out;
  });
}

module.exports = { source: SOURCE, discover };
