// Canonical application-form URL from the TSV row itself (RFC 068 §1).
//
// Rows discovered by the Greenhouse / Lever / Ashby adapters carry the ATS
// job id, and data/companies.tsv carries the board slug. Together they give
// the form URL directly — no dependence on the company's career page (which
// often embeds the form in an iframe, sits behind a cookie wall, or times
// out). The redirect-following resolver stays as the fallback for rows
// without a slug (aggregators, newsletters).
//
// Greenhouse form URL is the hosted *embed* form:
//   https://job-boards.greenhouse.io/embed/job_app?for=<slug>&token=<id>
// Learned live (2026-10): boards with a custom careers site redirect
// job-boards.greenhouse.io/<slug>/jobs/<id> to that site (Samsara, Asana,
// Robinhood…), while the embed URL always renders the form itself and, for a
// closed job, bounces to `embed/job_board?for=<slug>&error=true`.
//
// Posting liveness before the browser opens:
//   Greenhouse  GET boards-api.greenhouse.io/v1/boards/<slug>/jobs/<id>  404 → closed
//   Lever       GET api.lever.co/v0/postings/<slug>/<id>                  404 → closed
//   Ashby       no per-posting public endpoint → "unknown" (the page decides)

const { normalizeName } = require("../../core/company_keys.js");

const SUPPORTED = new Set(["greenhouse", "lever", "ashby"]);
const PREFIX_RE = /^(gh|greenhouse|lever|ashby):(.+)$/i;

function atsFromSource(source) {
  const s = String(source || "")
    .trim()
    .toLowerCase();
  return SUPPORTED.has(s) ? s : null;
}

function cleanJobId(jobId) {
  let id = String(jobId || "").trim();
  for (;;) {
    const m = id.match(PREFIX_RE);
    if (!m) return id;
    id = m[2];
  }
}

// companies.tsv rows ({name, source, slug}) → Map normalizedName → rows[].
function buildSlugIndex(companyRows) {
  const index = new Map();
  for (const r of companyRows || []) {
    if (!r || !r.slug) continue;
    const key = normalizeName(r.name);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ source: String(r.source || "").toLowerCase(), slug: r.slug });
  }
  return index;
}

// Board slug for this company on this ATS. A slug from another ATS is no use
// for building this ATS's URL, so only same-source rows count.
function findSlug(index, companyName, ats) {
  const rows = (index && index.get(normalizeName(companyName))) || [];
  const hit = rows.find((r) => r.source === ats);
  return hit ? hit.slug : null;
}

// Slug straight from an ATS URL already on the row (boards.greenhouse.io/<slug>/jobs/…).
function slugFromUrl(url, ats) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (ats === "greenhouse" && /(^|\.)greenhouse\.io$/.test(host)) {
    if (/^\/embed\//.test(u.pathname)) return u.searchParams.get("for");
    const m = u.pathname.match(/^\/([A-Za-z0-9_-]+)\/jobs\//);
    return m ? m[1] : null;
  }
  if (ats === "lever" && /(^|\.)lever\.co$/.test(host)) {
    const m = u.pathname.match(/^\/([A-Za-z0-9_.-]+)\//);
    return m ? m[1] : null;
  }
  if (ats === "ashby" && host === "jobs.ashbyhq.com") {
    const m = u.pathname.match(/^\/([^/]+)\//);
    return m ? decodeURIComponent(m[1]) : null;
  }
  return null;
}

function formUrl(ats, slug, jobId) {
  const s = encodeURIComponent(slug);
  const id = encodeURIComponent(jobId);
  if (ats === "greenhouse")
    return `https://job-boards.greenhouse.io/embed/job_app?for=${s}&token=${id}`;
  if (ats === "lever") return `https://jobs.lever.co/${s}/${id}/apply`;
  if (ats === "ashby") return `https://jobs.ashbyhq.com/${s}/${id}/application`;
  return null;
}

// Returns { ats, slug, jobId, url, slugSource } or null when the row is not
// ATS-sourced or no slug can be found.
function canonicalFormUrl(app, slugIndex) {
  const ats = atsFromSource(app && app.source);
  if (!ats) return null;
  const jobId = cleanJobId(app.jobId);
  if (!jobId) return null;
  if (ats === "greenhouse" && !/^\d+$/.test(jobId)) return null;
  if ((ats === "lever" || ats === "ashby") && !/^[0-9a-f-]{36}$/i.test(jobId)) return null;
  let slug = findSlug(slugIndex, app.companyName, ats);
  let slugSource = "companies_tsv";
  if (!slug) {
    slug = slugFromUrl(app.url, ats);
    slugSource = "row_url";
  }
  if (!slug) return null;
  return { ats, slug, jobId, url: formUrl(ats, slug, jobId), slugSource };
}

function postingApiUrl({ ats, slug, jobId }) {
  if (ats === "greenhouse") {
    return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(jobId)}`;
  }
  if (ats === "lever") {
    return `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${encodeURIComponent(jobId)}`;
  }
  return null;
}

// "open" | "closed" | "unknown". Network errors and odd statuses are
// "unknown" — the browser step then decides; a closed verdict needs a 404/410.
async function checkPostingOpen(ref, fetchFn) {
  const url = postingApiUrl(ref || {});
  if (!url || typeof fetchFn !== "function") return "unknown";
  let res;
  try {
    res = await fetchFn(url, { method: "GET", timeoutMs: 15000, retries: 1 });
  } catch {
    return "unknown";
  }
  const status = (res && res.status) || 0;
  if (status === 404 || status === 410) return "closed";
  if (status >= 200 && status < 300) return "open";
  return "unknown";
}

module.exports = {
  atsFromSource,
  cleanJobId,
  buildSlugIndex,
  findSlug,
  slugFromUrl,
  formUrl,
  canonicalFormUrl,
  postingApiUrl,
  checkPostingOpen,
};
