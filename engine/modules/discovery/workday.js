// Workday tenant-specific jobs API.
//   https://{slug}.{dc}.myworkdayjobs.com/wday/cxs/{slug}/{site}/jobs
// Each target must carry tenant-specific metadata:
//   { name, slug, dc?, site?, searchText? }
//   dc   — worker's data center (wd1/wd5/wd103/...), default "wd1".
//   site — career site path (jobs, External, Careers), default "jobs".
//
// Response shape:
//   { total, jobPostings: [{ title, locationsText, externalPath, postedOn, bulletFields }] }
//
// We iterate through the paged response with a hard page cap to avoid runaway
// scans if a tenant returns millions of rows.

const { fetchJson, runTargets, makeCtx } = require("./_ats.js");
const { assertJob } = require("./_types.js");
const { sanitizeText, parseIsoDate, dedupeLocations, safeJoinUrl } = require("./_normalize.js");

const SOURCE = "workday";
const PAGE_SIZE = 20;
const MAX_JOBS_PER_TENANT = 200;

function relativeDateToIso(value) {
  // Workday often returns strings like "Posted Today", "Posted Yesterday",
  // "Posted 3 Days Ago". We map the first two to today/yesterday and leave the
  // rest unparsed (null) — reliably back-dating "N days ago" needs timezone
  // context we don't have here.
  const s = sanitizeText(value).toLowerCase();
  if (!s) return null;
  const now = new Date();
  if (s.includes("today")) {
    return now.toISOString().slice(0, 10);
  }
  if (s.includes("yesterday")) {
    now.setUTCDate(now.getUTCDate() - 1);
    return now.toISOString().slice(0, 10);
  }
  return parseIsoDate(value);
}

function buildTenantUrls(target) {
  const slug = encodeURIComponent(target.slug);
  const dc = encodeURIComponent(target.dc || "wd1");
  const site = encodeURIComponent(target.site || "jobs");
  const base = `https://${slug}.${dc}.myworkdayjobs.com`;
  return {
    apiUrl: `${base}/wday/cxs/${slug}/${site}/jobs`,
    viewBase: `${base}/en-US/${site}`,
  };
}

function mapJob(target, viewBase, raw) {
  // externalPath is the stable primary key Workday uses to identify a posting
  // within a tenant. Without it we cannot produce a reliable dedup key
  // (falling back to title collides whenever a tenant has two roles with the
  // same title), so we drop such entries.
  const externalPath = raw && raw.externalPath ? String(raw.externalPath) : "";
  if (!externalPath) return null;
  const locations = dedupeLocations([raw.locationsText]);
  const url = safeJoinUrl(viewBase, externalPath);
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId: externalPath,
    title: sanitizeText(raw.title),
    url,
    locations,
    team: null,
    postedAt: relativeDateToIso(raw.postedOn),
    rawExtra: { bulletFields: raw.bulletFields || [] },
  };
  assertJob(job);
  return job;
}

async function fetchAllPages(fetchFn, apiUrl, searchText, signal) {
  const all = [];
  for (let offset = 0; offset < MAX_JOBS_PER_TENANT; offset += PAGE_SIZE) {
    const body = await fetchJson(fetchFn, apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ limit: PAGE_SIZE, offset, searchText: searchText || "" }),
      signal,
    });
    const page = Array.isArray(body && body.jobPostings) ? body.jobPostings : [];
    all.push(...page);
    const total = Number(body && body.total) || 0;
    if (page.length < PAGE_SIZE) break;
    if (total && all.length >= total) break;
  }
  return all;
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  // Workday tenants rate-limit aggressively — keep concurrency low.
  const effectiveCtx = { ...c, concurrency: Math.min(c.concurrency || 2, 2) };
  return runTargets(targets, effectiveCtx, async (target) => {
    if (!target || !target.slug) return [];
    const { apiUrl, viewBase } = buildTenantUrls(target);
    const raws = await fetchAllPages(c.fetchFn, apiUrl, target.searchText, c.signal);
    const mapped = raws.map((r) => mapJob(target, viewBase, r));
    const dropped = mapped.filter((j) => j === null).length;
    if (dropped > 0) {
      c.logger.warn(
        `[${SOURCE}] ${target.slug}: dropped ${dropped} postings without externalPath`
      );
    }
    return mapped.filter(Boolean);
  });
}

module.exports = { source: SOURCE, discover };
