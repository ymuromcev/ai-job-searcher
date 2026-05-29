// UltiPro / UKG Pro Recruiting (new-gen UUID JobBoard JSON API).
//
//   POST https://{host}.ultipro.com/{TENANT}/JobBoard/{BOARD_ID}/JobBoardView/LoadSearchResults
//   Body: { opportunitySearch:{ Top, Skip, QueryString, OrderBy, Filters },
//           matchCriteria:{ ... } }
//   Response: { opportunities:[ { Id, Title, Locations:[...], PostingDate,
//                                 RequisitionNumber, JobCategoryName, ... } ],
//               totalCount }
//
// Scope (per RFC 051 §3, BL-39 §"RFC §10 — decisions"):
// - New-gen UUID boards only. Classic SearchJobs.aspx tenants are tracked as
//   a separate follow-up BL; this adapter skips a target if `boardId` is
//   missing rather than guessing the legacy URL shape.
// - `extra_json` carries `{host, boardId}` per company row. `host` defaults
//   to `recruiting` (the most common new-gen host); `boardId` is required.
// - Pagination via Skip/Top; capped at MAX_PAGES * PAGE_SIZE = 2000 jobs per
//   tenant as a runaway-loop safety net.
// - Location filtering is post-hoc on `opportunities[].Locations[]` — same
//   approach as Workable/Greenhouse adapters — to avoid per-tenant Filter
//   discovery work.
// - JD body fetch happens later in `engine/core/jd_cache.js` via the public
//   `OpportunityDetail` HTML page (two-stage fetch matches BL-39 decisions).

const { fetchJsonPost, runTargets, makeCtx } = require("./_ats.js");
const { assertJob } = require("./_types.js");
const { sanitizeText, parseIsoDate, dedupeLocations } = require("./_normalize.js");

const SOURCE = "ultipro";
const PAGE_SIZE = 50;
const MAX_PAGES = 40;

// `host` and `tenant` form the URL path; constrain to safe shapes so a
// corrupted companies.tsv row cannot build an arbitrary URL.
const HOST_RE = /^[a-z0-9]{1,32}$/;
const TENANT_RE = /^[A-Za-z0-9]{1,32}$/;
const BOARD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveBase(target) {
  const extra = (target && (target.rawExtra || target.extraJson || target.extra)) || {};
  const host = String(extra.host || "recruiting").toLowerCase();
  const tenant = String(target && target.slug ? target.slug : "");
  const boardId = String(extra.boardId || extra.board || "");
  if (!HOST_RE.test(host)) return null;
  if (!TENANT_RE.test(tenant)) return null;
  if (!BOARD_ID_RE.test(boardId)) return null;
  return {
    base: `https://${host}.ultipro.com/${tenant}/JobBoard/${boardId}`,
    host,
    tenant,
    boardId,
  };
}

function buildBody(skip) {
  return {
    opportunitySearch: {
      Top: PAGE_SIZE,
      Skip: skip,
      QueryString: "",
      OrderBy: [],
      Filters: [],
    },
    matchCriteria: {
      PreferredJobs: [],
      Educations: [],
      LicenseAndCertifications: [],
      Skills: [],
      hasNoLicenses: false,
      SkippedSkills: [],
    },
  };
}

function formatLocation(loc) {
  if (!loc || typeof loc !== "object") return "";
  if (loc.IsRemote === true) return "Remote";
  const localized = sanitizeText(loc.LocalizedName);
  if (localized) return localized;
  const addr = loc.Address || loc.address || {};
  const city = sanitizeText(addr.City || loc.City);
  const state = sanitizeText(addr.State || addr.Region || loc.State);
  const country = sanitizeText(addr.CountryCode || addr.Country || loc.Country);
  return [city, state, country].filter(Boolean).join(", ");
}

function mapJob(target, resolved, raw) {
  const jobId = String((raw && (raw.Id || raw.RequisitionNumber)) || "").trim();
  if (!jobId) return null;
  const url = `${resolved.base}/OpportunityDetail?opportunityId=${encodeURIComponent(jobId)}`;
  const locations = Array.isArray(raw.Locations)
    ? raw.Locations.map(formatLocation).filter(Boolean)
    : [];
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId,
    title: sanitizeText(raw.Title),
    url,
    locations: dedupeLocations(locations),
    team: sanitizeText(raw.JobCategoryName) || null,
    postedAt: parseIsoDate(raw.PostingDate || raw.PostedDate),
    rawExtra: {
      requisition: sanitizeText(raw.RequisitionNumber) || null,
      employment_type: sanitizeText(raw.EmploymentTypeName) || null,
      brief: sanitizeText(raw.BriefDescription) || null,
      host: resolved.host,
      boardId: resolved.boardId,
    },
  };
  assertJob(job);
  return job;
}

async function fetchPage(c, base, skip) {
  return fetchJsonPost(c.fetchFn, `${base}/JobBoardView/LoadSearchResults`, buildBody(skip), {
    headers: { "X-Requested-With": "XMLHttpRequest" },
    signal: c.signal,
    timeoutMs: 15000,
    retries: 1,
  });
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  return runTargets(targets, c, async (target) => {
    const resolved = resolveBase(target);
    if (!resolved) {
      if (c.logger && c.logger.warn) {
        c.logger.warn(
          `[${SOURCE}] ${target && target.slug}: missing/invalid host|boardId in extra_json — skipping`
        );
      }
      return [];
    }
    const out = [];
    let total = Infinity;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const skip = page * PAGE_SIZE;
      const body = await fetchPage(c, resolved.base, skip);
      const opps = Array.isArray(body && body.opportunities) ? body.opportunities : [];
      if (opps.length === 0) break;
      for (const raw of opps) {
        const job = mapJob(target, resolved, raw);
        if (job) out.push(job);
      }
      const reported = Number(body && body.totalCount);
      if (Number.isFinite(reported)) total = reported;
      if (out.length >= total) break;
      if (opps.length < PAGE_SIZE) break;
      if (page === MAX_PAGES - 1 && c.logger && c.logger.warn) {
        c.logger.warn(
          `[${SOURCE}] ${target.slug}: hit MAX_PAGES=${MAX_PAGES} (${out.length} jobs) — truncating`
        );
      }
    }
    return out;
  });
}

module.exports = {
  source: SOURCE,
  discover,
  // exported for tests
  _internal: { resolveBase, mapJob, buildBody, PAGE_SIZE, MAX_PAGES },
};
