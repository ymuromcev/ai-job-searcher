// Greenhouse public job-board API.
//   https://boards-api.greenhouse.io/v1/boards/{slug}/jobs
// Response shape: { jobs: [{ id, title, location: {name}, absolute_url,
//                             departments: [{name}], updated_at }] }

const { fetchJson, runTargets, makeCtx } = require("./_ats.js");
const { assertJob } = require("./_types.js");
const { sanitizeText, parseIsoDate, dedupeLocations } = require("./_normalize.js");

const SOURCE = "greenhouse";
const BASE = "https://boards-api.greenhouse.io/v1/boards";

function mapJob(target, raw) {
  const locations = dedupeLocations([raw.location && raw.location.name]);
  const department = sanitizeText(raw.departments && raw.departments[0] && raw.departments[0].name);
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId: String(raw.id),
    title: sanitizeText(raw.title),
    url: String(raw.absolute_url || ""),
    locations,
    team: department || null,
    postedAt: parseIsoDate(raw.updated_at),
    rawExtra: { departments: raw.departments || [] },
  };
  assertJob(job);
  return job;
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  return runTargets(targets, c, async (target) => {
    if (!target || !target.slug) return [];
    const url = `${BASE}/${encodeURIComponent(target.slug)}/jobs`;
    const body = await fetchJson(c.fetchFn, url, { signal: c.signal });
    const raws = Array.isArray(body && body.jobs) ? body.jobs : [];
    return raws.map((r) => mapJob(target, r)).filter(Boolean);
  });
}

module.exports = { source: SOURCE, discover };
