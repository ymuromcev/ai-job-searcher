// Lever public postings API.
//   https://api.lever.co/v0/postings/{slug}?mode=json
// Response shape: [{ id, text, categories: {location, team, department},
//                    hostedUrl, createdAt }]

const { fetchJson, runTargets, makeCtx } = require("./_ats.js");
const { assertJob } = require("./_types.js");
const { sanitizeText, parseIsoDate, dedupeLocations } = require("./_normalize.js");

const SOURCE = "lever";
const BASE = "https://api.lever.co/v0/postings";

function mapJob(target, raw) {
  const cat = raw.categories || {};
  const locations = dedupeLocations([cat.location, ...(Array.isArray(cat.allLocations) ? cat.allLocations : [])]);
  const team = sanitizeText(cat.team || cat.department) || null;
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId: String(raw.id),
    title: sanitizeText(raw.text),
    url: String(raw.hostedUrl || ""),
    locations,
    team,
    postedAt: parseIsoDate(raw.createdAt),
    rawExtra: { categories: cat },
  };
  assertJob(job);
  return job;
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  return runTargets(targets, c, async (target) => {
    if (!target || !target.slug) return [];
    const url = `${BASE}/${encodeURIComponent(target.slug)}?mode=json`;
    const body = await fetchJson(c.fetchFn, url, { signal: c.signal });
    const raws = Array.isArray(body) ? body : [];
    return raws.map((r) => mapJob(target, r)).filter(Boolean);
  });
}

module.exports = { source: SOURCE, discover };
