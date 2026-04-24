// SmartRecruiters public postings API.
//   https://api.smartrecruiters.com/v1/companies/{slug}/postings
// Response shape: { content: [{ id, name, location: {city, region, country, remote},
//                                 department: {label}, releasedDate }], totalFound }
//
// Legacy builds human-friendly URLs like
//   https://jobs.smartrecruiters.com/{slug}/{id}-{title-slug}
// which we keep for parity with existing pipeline.

const { fetchJson, runTargets, makeCtx } = require("./_ats.js");
const { assertJob } = require("./_types.js");
const { sanitizeText, parseIsoDate, dedupeLocations } = require("./_normalize.js");

const SOURCE = "smartrecruiters";
const BASE = "https://api.smartrecruiters.com/v1/companies";
const PUBLIC_BASE = "https://jobs.smartrecruiters.com";

function slugifyTitle(title) {
  return sanitizeText(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function formatLocation(loc) {
  if (!loc) return "";
  if (loc.remote) return "Remote";
  const city = sanitizeText(loc.city);
  const region = sanitizeText(loc.region);
  const country = sanitizeText(loc.country);
  return [city, region || country].filter(Boolean).join(", ");
}

function mapJob(target, raw) {
  const locations = dedupeLocations([formatLocation(raw.location)]);
  const team = sanitizeText(raw.department && raw.department.label) || null;
  const idEnc = encodeURIComponent(String(raw.id));
  const titleSlug = slugifyTitle(raw.name);
  const url = raw.applyUrl ||
    `${PUBLIC_BASE}/${encodeURIComponent(target.slug)}/${idEnc}${titleSlug ? "-" + titleSlug : ""}`;
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId: String(raw.id),
    title: sanitizeText(raw.name),
    url,
    locations,
    team,
    postedAt: parseIsoDate(raw.releasedDate),
    rawExtra: { location: raw.location || null },
  };
  assertJob(job);
  return job;
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  return runTargets(targets, c, async (target) => {
    if (!target || !target.slug) return [];
    const url = `${BASE}/${encodeURIComponent(target.slug)}/postings`;
    const body = await fetchJson(c.fetchFn, url, { signal: c.signal });
    const raws = Array.isArray(body && body.content) ? body.content : [];
    return raws.map((r) => mapJob(target, r)).filter(Boolean);
  });
}

module.exports = { source: SOURCE, discover };
