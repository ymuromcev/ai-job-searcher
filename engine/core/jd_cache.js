// JD text cache for the prepare stage.
//
// Downloads job descriptions from supported ATS public APIs (Greenhouse, Lever)
// and stores plain-text versions in profiles/<id>/jd_cache/<key>.txt.
//
// All I/O is injected via `deps` so the module is fully unit-testable without
// touching the filesystem or the network.
//
// Exports:
//   cacheKey(job) → string          — deterministic filesystem-safe key
//   fetchJd(job, cacheDir, deps)    → Promise<JdResult>
//   fetchAll(jobs, cacheDir, deps, opts) → Promise<JdResult[]>
//
// JdResult:
//   { key, status: 'cached'|'fetched'|'not_found'|'unsupported'|'error', text?, error? }

const path = require("path");
const fsp = require("fs/promises");

const { defaultFetch } = require("../modules/discovery/_http.js");

// --- Cache key ---------------------------------------------------------------

function cacheKey(job) {
  // Normalise each segment to lowercase alphanumeric + safe punctuation,
  // then cap at 60 chars per segment to avoid OS path-length issues.
  const safe = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 60);
  return `${safe(job.source)}_${safe(job.slug)}_${safe(job.jobId)}.txt`;
}

// --- HTML stripping ----------------------------------------------------------

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "  - ")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- ATS formatters ----------------------------------------------------------

function formatGreenhouse(data, job) {
  const parts = [`TITLE: ${data.title || job.title || ""}`];
  if (data.location && data.location.name) parts.push(`LOCATION: ${data.location.name}`);
  if (data.departments && data.departments[0] && data.departments[0].name) {
    parts.push(`DEPARTMENT: ${data.departments[0].name}`);
  }
  parts.push("");
  if (data.content) parts.push(stripHtml(data.content));
  return parts.join("\n").trim();
}

function formatLever(data, job) {
  const parts = [`TITLE: ${data.text || job.title || ""}`];
  const cat = data.categories || {};
  if (cat.location) parts.push(`LOCATION: ${cat.location}`);
  if (cat.team) parts.push(`TEAM: ${cat.team}`);
  parts.push("");
  if (data.descriptionPlain) parts.push(data.descriptionPlain.trim());
  if (Array.isArray(data.lists)) {
    for (const list of data.lists) {
      if (list.text) parts.push(`\n${list.text}:`);
      if (list.content) parts.push(stripHtml(list.content));
    }
  }
  return parts.join("\n").trim();
}

// --- Default I/O deps --------------------------------------------------------

const DEFAULT_DEPS = {
  fetchFn: defaultFetch,
  exists: (p) => fsp.access(p).then(() => true, () => false),
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, data) => fsp.writeFile(p, data, "utf8"),
  mkdirp: (dir) => fsp.mkdir(dir, { recursive: true }),
};

// --- Core fetch logic --------------------------------------------------------

async function fetchJd(job, cacheDir, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const key = cacheKey(job);
  const cachePath = path.join(cacheDir, key);

  if (await d.exists(cachePath)) {
    const text = await d.readFile(cachePath);
    return { key, status: "cached", text };
  }

  const { source, slug, jobId } = job;

  if (source !== "greenhouse" && source !== "lever") {
    return { key, status: "unsupported" };
  }

  let text = null;
  try {
    if (source === "greenhouse") {
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(jobId)}`;
      const res = await d.fetchFn(url, { timeoutMs: 15000, retries: 1 });
      if (!res.ok) return { key, status: "not_found" };
      const data = await res.json();
      text = formatGreenhouse(data, job);
    } else {
      const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${encodeURIComponent(jobId)}`;
      const res = await d.fetchFn(url, { timeoutMs: 15000, retries: 1 });
      if (!res.ok) return { key, status: "not_found" };
      const data = await res.json();
      text = formatLever(data, job);
    }
  } catch (err) {
    return { key, status: "error", error: err.message };
  }

  if (!text) return { key, status: "not_found" };

  await d.mkdirp(cacheDir);
  await d.writeFile(cachePath, text);
  return { key, status: "fetched", text };
}

async function fetchAll(jobs, cacheDir, deps = {}, opts = {}) {
  if (!Array.isArray(jobs) || jobs.length === 0) return [];
  const { concurrency = 8 } = opts;
  const results = new Array(jobs.length);
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const idx = i++;
      results[idx] = await fetchJd(jobs[idx], cacheDir, deps);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker())
  );
  return results;
}

module.exports = { cacheKey, fetchJd, fetchAll, stripHtml };
