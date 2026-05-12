// Oracle Recruiting Cloud (Fusion HCM Candidate Experience) public job API.
//   GET {siteUrl-host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions
//     ?onlyData=true&expand=requisitionList&limit=N&offset=N
//     &finder=findReqs;siteNumber={CX}
//
// Each target carries:
//   { name, slug, siteUrl, siteNumber?, locationAllow? }
//   siteUrl       — full URL to the CE site root, e.g.
//                   https://ecvz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/
//                   Required. Adapter derives both API base and apply-URL base
//                   from this single field.
//   siteNumber    — site identifier within the tenant; default "CX".
//   locationAllow — substring patterns matched (case-insensitive) against the
//                   posting's PrimaryLocation. Postings whose PrimaryLocation
//                   contains none are dropped client-side. Use for commute
//                   radius (e.g. ["Roseville", "Sacramento", "Folsom"]).
//                   Empty/unset = keep all locations.
//
// Response shape (top item is a search-state wrapper; actual jobs live under
// items[0].requisitionList):
//   {
//     items: [{
//       TotalJobsCount: number,
//       requisitionList: [{
//         Id, Title, PrimaryLocation, PostedDate, Department, JobFamily,
//         WorkplaceTypeCode, secondaryLocations, ...
//       }]
//     }]
//   }
//
// Pagination via limit/offset. Hard cap MAX_JOBS_PER_TENANT (2000) protects
// against runaway pulls if a tenant grows unexpectedly; Adventist sits at
// ~1400 active reqs as of 2026-05-11.

const { fetchJson, runTargets, makeCtx } = require("./_ats.js");
const { assertJob } = require("./_types.js");
const { sanitizeText, parseIsoDate, dedupeLocations, safeJoinUrl } = require("./_normalize.js");

const SOURCE = "oracle_cloud";
// Oracle Fusion HCM caps the CE listing endpoint at 25 items per response
// regardless of the requested `limit` param (verified against Adventist's
// us2 instance on 2026-05-11: limits 30/50/100/200 all returned 25). Using a
// higher value would trip our short-page break and silently truncate at 25,
// so we send what Oracle will actually honor.
const PAGE_LIMIT = 25;
const MAX_JOBS_PER_TENANT = 2000;
const DEFAULT_SITE_NUMBER = "CX";

// SSRF guard: siteUrl comes from data/companies.tsv (operator-controlled but
// also third-party-adapter-shaped data). Restrict to https + Oracle Cloud
// hostnames so a malformed or malicious row can never redirect adapter
// traffic to AWS metadata, localhost, or arbitrary intranet hosts.
const ALLOWED_HOST_SUFFIX = ".oraclecloud.com";

function deriveApiBase(siteUrl) {
  // siteUrl: https://{host}/hcmUI/CandidateExperience/en/sites/{site}/ — we
  // only need the origin for the REST API. Throws on malformed URL or
  // disallowed host; callers catch and short-circuit the target.
  const u = new URL(siteUrl);
  if (u.protocol !== "https:") {
    throw new Error(`siteUrl protocol must be https, got "${u.protocol}"`);
  }
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(ALLOWED_HOST_SUFFIX)) {
    throw new Error(`siteUrl host "${host}" outside ${ALLOWED_HOST_SUFFIX} allowlist`);
  }
  return `${u.protocol}//${u.host}`;
}

function buildPageUrl(apiBase, siteNumber, offset, limit) {
  const finder = `findReqs;siteNumber=${encodeURIComponent(siteNumber)}`;
  return (
    `${apiBase}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
    `?onlyData=true&expand=requisitionList` +
    `&limit=${limit}&offset=${offset}` +
    `&finder=${encodeURIComponent(finder)}`
  );
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

function extractRequisitions(body) {
  // Oracle wraps requisitions inside items[0].requisitionList. Be defensive:
  // anything unexpected returns an empty list rather than crashing the scan.
  if (!body || !Array.isArray(body.items) || body.items.length === 0) {
    return { reqs: [], total: 0 };
  }
  const wrapper = body.items[0] || {};
  const reqs = Array.isArray(wrapper.requisitionList) ? wrapper.requisitionList : [];
  const total = Number(wrapper.TotalJobsCount) || 0;
  return { reqs, total };
}

async function fetchAllPages(fetchFn, apiBase, siteNumber, signal) {
  const all = [];
  for (let offset = 0; offset < MAX_JOBS_PER_TENANT; offset += PAGE_LIMIT) {
    const url = buildPageUrl(apiBase, siteNumber, offset, PAGE_LIMIT);
    const body = await fetchJson(fetchFn, url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
    const { reqs, total } = extractRequisitions(body);
    all.push(...reqs);
    // Stop when the page is short (last page in the result set) or when we've
    // collected at least the reported TotalJobsCount. Either signal alone is
    // sufficient; together they handle the case where Oracle omits one.
    if (reqs.length < PAGE_LIMIT) break;
    if (total && all.length >= total) break;
  }
  return all;
}

function mapJob(target, raw) {
  const id = raw && raw.Id != null ? String(raw.Id) : "";
  if (!id) return null;
  if (!locationMatchesAllow(raw.PrimaryLocation, target.locationAllow)) {
    return null;
  }
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId: id,
    title: sanitizeText(raw.Title),
    url: safeJoinUrl(target.siteUrl, `job/${id}`),
    locations: dedupeLocations([raw.PrimaryLocation]),
    team: sanitizeText(raw.Department) || null,
    postedAt: parseIsoDate(raw.PostedDate),
    rawExtra: {
      jobFamily: raw.JobFamily || null,
      workplaceType: raw.WorkplaceTypeCode || null,
    },
  };
  assertJob(job);
  return job;
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  // Oracle Cloud hosts are shared across tenants — keep concurrency low.
  const effectiveCtx = { ...c, concurrency: Math.min(c.concurrency || 2, 2) };
  return runTargets(targets, effectiveCtx, async (target) => {
    if (!target || !target.slug || !target.siteUrl) return [];
    let apiBase;
    try {
      apiBase = deriveApiBase(target.siteUrl);
    } catch (err) {
      c.logger.warn(`[${SOURCE}] ${target.slug}: invalid siteUrl: ${err.message}`);
      return [];
    }
    const siteNumber = target.siteNumber || DEFAULT_SITE_NUMBER;
    const raws = await fetchAllPages(c.fetchFn, apiBase, siteNumber, c.signal);
    let droppedNoId = 0;
    let droppedByLocation = 0;
    const out = [];
    for (const r of raws) {
      const id = r && r.Id != null ? String(r.Id) : "";
      if (!id) {
        droppedNoId += 1;
        continue;
      }
      const job = mapJob(target, r);
      if (!job) {
        droppedByLocation += 1;
        continue;
      }
      out.push(job);
    }
    if (droppedNoId > 0) {
      c.logger.warn(`[${SOURCE}] ${target.slug}: dropped ${droppedNoId} postings without Id`);
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
