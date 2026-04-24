// Ashby public job-board API.
//   https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
// Response shape: { jobs: [{ id, title, location, jobUrl, department, team,
//                              publishedAt, isRemote, compensationTierSummary }] }

const { fetchJson, runTargets, makeCtx } = require("./_ats.js");
const { assertJob } = require("./_types.js");
const { sanitizeText, parseIsoDate, dedupeLocations } = require("./_normalize.js");

const SOURCE = "ashby";
const BASE = "https://api.ashbyhq.com/posting-api/job-board";

function mapJob(target, raw) {
  const locations = dedupeLocations([
    raw.location,
    ...(raw.isRemote ? ["Remote"] : []),
    ...(Array.isArray(raw.secondaryLocations)
      ? raw.secondaryLocations.map((l) => (l && l.location) || "")
      : []),
  ]);
  const team = sanitizeText(raw.department || raw.team) || null;
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId: String(raw.id),
    title: sanitizeText(raw.title),
    url: String(raw.jobUrl || ""),
    locations,
    team,
    postedAt: parseIsoDate(raw.publishedAt),
    rawExtra: {
      isRemote: Boolean(raw.isRemote),
      compensation: raw.compensationTierSummary || null,
    },
  };
  assertJob(job);
  return job;
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  return runTargets(targets, c, async (target) => {
    if (!target || !target.slug) return [];
    const url = `${BASE}/${encodeURIComponent(target.slug)}?includeCompensation=true`;
    const body = await fetchJson(c.fetchFn, url, { signal: c.signal });
    const raws = Array.isArray(body && body.jobs) ? body.jobs : [];
    return raws.map((r) => mapJob(target, r)).filter(Boolean);
  });
}

module.exports = { source: SOURCE, discover };
