// Workable public widget API.
//   https://apply.workable.com/api/v1/widget/accounts/{slug}
// Response shape: { name, description, jobs: [{ shortcode, title, url,
//                     published_on, telecommuting, department,
//                     country, city, state, locations: [{country,
//                     region, city, hidden}] }] }
// See rfc/032-workable-adapter.md for recon details and field semantics.

const { fetchJson, runTargets, makeCtx } = require("./_ats.js");
const { assertJob } = require("./_types.js");
const { sanitizeText, parseIsoDate, dedupeLocations } = require("./_normalize.js");

const SOURCE = "workable";
const BASE = "https://apply.workable.com/api/v1/widget/accounts";

function formatLocation(loc) {
  if (!loc || typeof loc !== "object") return "";
  const city = sanitizeText(loc.city);
  const region = sanitizeText(loc.region);
  const country = sanitizeText(loc.country);
  return [city, region, country].filter(Boolean).join(", ");
}

function mapJob(target, raw) {
  // shortcode is the natural primary key on Workable and the basis of canonical
  // URLs (`apply.workable.com/j/{shortcode}`). Drop malformed records here
  // rather than letting assertJob throw — a single broken record from a tenant
  // would otherwise sink the entire batch via runTargets' per-target catch.
  const jobId = String(raw.shortcode || raw.id || "");
  if (!jobId) return null;
  const url = String(raw.url || raw.shortlink || `https://apply.workable.com/j/${jobId}`);
  const fromLocations = Array.isArray(raw.locations)
    ? raw.locations.filter((l) => l && !l.hidden).map(formatLocation)
    : [];
  const fromLegacy = [raw.city, raw.state, raw.country]
    .map((v) => sanitizeText(v))
    .filter(Boolean)
    .join(", ");
  const locations = dedupeLocations([
    ...(raw.telecommuting ? ["Remote"] : []),
    ...fromLocations,
    fromLegacy,
  ]);
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId,
    title: sanitizeText(raw.title),
    url,
    locations,
    team: sanitizeText(raw.department) || null,
    postedAt: parseIsoDate(raw.published_on || raw.created_at),
    rawExtra: {
      telecommuting: Boolean(raw.telecommuting),
      employment_type: raw.employment_type || null,
      experience: raw.experience || null,
      function: raw.function || null,
      industry: raw.industry || null,
    },
  };
  assertJob(job);
  return job;
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  return runTargets(targets, c, async (target) => {
    if (!target || !target.slug) return [];
    const url = `${BASE}/${encodeURIComponent(target.slug)}`;
    const body = await fetchJson(c.fetchFn, url, { signal: c.signal });
    const raws = Array.isArray(body && body.jobs) ? body.jobs : [];
    return raws.map((r) => mapJob(target, r)).filter(Boolean);
  });
}

module.exports = { source: SOURCE, discover };
