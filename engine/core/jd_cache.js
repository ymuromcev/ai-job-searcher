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

// Cap iCIMS HTML at 5 MB — same hardening as the iCIMS discovery adapter
// (BL-30). Largest real JD page seen in recon was ~1.2 MB; 5 MB leaves
// headroom while guarding against runaway responses.
const MAX_HTML_BYTES = 5 * 1024 * 1024;

// User-Agent for HTML scraping. iCIMS gates some responses behind a
// non-empty UA; reuse the same value as the discovery adapter.
const HTML_UA = "Mozilla/5.0 (compatible; ai-job-searcher/1.0)";

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

// Workday tenants expose JD JSON at
//   https://{tenant}.{dc}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/job/{path}
// We derive {host, tenant, site} from the user-facing `job.url` (stored at
// discovery time) and append `job.jobId` (which is the externalPath, already
// starting with /job/...). SSRF guard: host must match the canonical Workday
// pattern; everything else is rejected.
const WORKDAY_HOST_RE = /^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/;
// externalPath shape: `/job/{location}/{slug}_{reqId}`. We accept anything
// that looks like a Workday path segment (alphanumeric + the punctuation
// they actually use), but reject query strings, fragments, whitespace, and
// percent-encoding sequences that could smuggle a different path.
const WORKDAY_JOB_ID_RE = /^\/?job\/[A-Za-z0-9._\-/]+$/;

function buildWorkdayApiUrl(job) {
  if (!job || typeof job.url !== "string" || typeof job.jobId !== "string") return null;
  if (!WORKDAY_JOB_ID_RE.test(job.jobId)) return null;
  // Reject `..` segments (path traversal) — URL parsing would resolve them,
  // dropping `/wday/cxs/{tenant}/{site}` and landing on an unrelated path.
  if (job.jobId.split("/").some((seg) => seg === "..")) return null;
  let u;
  try {
    u = new URL(job.url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (!WORKDAY_HOST_RE.test(u.hostname)) return null;
  const tenant = u.hostname.split(".")[0];
  // pathname is `/{locale}/{site}/job/...` (e.g. /en-US/jobs/job/...)
  const m = /^\/[a-z]{2}-[A-Z]{2}\/([^/]+)\//.exec(u.pathname);
  const site = m ? m[1] : "jobs";
  // externalPath stored on the job already starts with "/job/...".
  const externalPath = job.jobId.startsWith("/") ? job.jobId : `/${job.jobId}`;
  const built = `${u.origin}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}${externalPath}`;
  // Defense-in-depth: re-parse the assembled URL and verify host hasn't
  // mutated (e.g. backslash or unicode normalization shifting the origin).
  try {
    const out = new URL(built);
    if (out.hostname !== u.hostname) return null;
    return out.toString();
  } catch {
    return null;
  }
}

function formatWorkday(data, job) {
  const info = (data && data.jobPostingInfo) || {};
  const body = info.jobDescription ? stripHtml(info.jobDescription) : "";
  // If the tenant returned no description text, return null so fetchJd
  // surfaces this as not_found instead of caching a useless header-only
  // 1-liner — prevents poisoned cache hits on subsequent runs.
  if (!body) return null;
  const parts = [`TITLE: ${info.title || job.title || ""}`];
  if (info.location) parts.push(`LOCATION: ${info.location}`);
  // timeType surfaces "Full time" / "Part time" / "Contractor" verbatim from
  // the tenant. Prepending it as a labeled line lets extractSchedule pick up
  // the explicit vocabulary before falling back to a generic body scan.
  if (info.timeType) parts.push(`SCHEDULE: ${info.timeType}`);
  if (info.jobReqId) parts.push(`REQ ID: ${info.jobReqId}`);
  parts.push("");
  parts.push(body);
  return parts.join("\n").trim();
}

// iCIMS JD pages. No public JSON API (RFC 025 §2 — session-hash gated), so we
// scrape the HTML. Two container shapes seen in the wild:
//   - `<div class="iCIMS_JobContent">...</div>` (default iCIMS frontend)
//   - `<div class="ats-description">...</div>` (talentbrew, CommonSpirit)
// We also pull TITLE / LOCATION header markers when present so the body has
// the same `LABEL: value` shape as Greenhouse / Workday for extractSchedule.
const ICIMS_JOB_CONTENT_RE =
  /<div[^>]*class="[^"]*\biCIMS_JobContent\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<!--\s*\/iCIMS_JobContent\s*-->/i;
// Fallback terminates at structural anchors (</section>, </main>, <footer>,
// <nav>, </body>) so footer/nav copy doesn't leak into the JD body when the
// closing `<!-- /iCIMS_JobContent -->` comment is missing.
const ICIMS_JOB_CONTENT_FALLBACK_RE =
  /<div[^>]*class="[^"]*\biCIMS_JobContent\b[^"]*"[^>]*>([\s\S]*?)(?:<\/(?:section|main|body)>|<(?:footer|nav)\b)/i;
const TALENTBREW_DESC_RE =
  /<div[^>]*class="[^"]*\bats-description\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/section>/i;
const TALENTBREW_DESC_FALLBACK_RE =
  /<div[^>]*class="[^"]*\bats-description\b[^"]*"[^>]*>([\s\S]*?)(?:<\/(?:section|main|body)>|<(?:footer|nav)\b)/i;

function extractIcimsBody(html) {
  // Prefer the closed-container shape (anchored on the matching end-of-block
  // marker), then fall back to greedy if the page omits the closing comment.
  const candidates = [
    ICIMS_JOB_CONTENT_RE,
    TALENTBREW_DESC_RE,
    ICIMS_JOB_CONTENT_FALLBACK_RE,
    TALENTBREW_DESC_FALLBACK_RE,
  ];
  for (const re of candidates) {
    const m = re.exec(html);
    if (m && m[1]) return m[1];
  }
  return null;
}

// Try to pluck a labeled header value (Title / Location) from the page.
// iCIMS surfaces these in `<span class="iCIMS_JobHeaderField">` or similar;
// we accept any preceding text node + value, capped to 200 chars to avoid
// pulling the whole body if the regex misfires.
function extractIcimsHeader(html, label) {
  const re = new RegExp(
    `<span[^>]*class="[^"]*(?:iCIMS_JobHeaderField|sr-only[^"]*field-label)[^"]*"[^>]*>\\s*${label}\\s*<\\/span>\\s*<span[^>]*>\\s*([^<]{1,200})\\s*<\\/span>`,
    "i"
  );
  const m = re.exec(html);
  return m ? m[1].trim() : null;
}

function formatIcims(html, job) {
  if (typeof html !== "string" || !html) return null;
  const body = extractIcimsBody(html);
  if (!body) return null;
  const stripped = stripHtml(body);
  // iframes-only / tag-only containers produce empty text after strip — treat
  // as not_found so fetchJd doesn't cache a header-only 1-liner.
  if (!stripped) return null;
  const parts = [`TITLE: ${job.title || ""}`];
  const loc = extractIcimsHeader(html, "Job Locations") || extractIcimsHeader(html, "Location");
  if (loc) parts.push(`LOCATION: ${loc}`);
  // iCIMS doesn't expose a structured timeType field — extractSchedule will
  // sniff the body for "Per Diem" / "Full-time" / "Days" etc. on its own.
  parts.push("");
  parts.push(stripped);
  return parts.join("\n").trim();
}

// --- Default I/O deps --------------------------------------------------------

const DEFAULT_DEPS = {
  fetchFn: defaultFetch,
  exists: (p) =>
    fsp.access(p).then(
      () => true,
      () => false
    ),
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

  const SUPPORTED = new Set(["greenhouse", "lever", "workday", "icims"]);
  if (!SUPPORTED.has(source)) {
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
    } else if (source === "lever") {
      const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${encodeURIComponent(jobId)}`;
      const res = await d.fetchFn(url, { timeoutMs: 15000, retries: 1 });
      if (!res.ok) return { key, status: "not_found" };
      const data = await res.json();
      text = formatLever(data, job);
    } else if (source === "workday") {
      const url = buildWorkdayApiUrl(job);
      if (!url) return { key, status: "not_found" };
      const res = await d.fetchFn(url, { timeoutMs: 15000, retries: 1 });
      if (!res.ok) return { key, status: "not_found" };
      const data = await res.json();
      text = formatWorkday(data, job);
    } else if (source === "icims") {
      // iCIMS uses the same URL we already stored at discovery time. Cap the
      // body size before parsing — runaway responses cannot exhaust memory.
      if (!job.url || typeof job.url !== "string") {
        return { key, status: "not_found" };
      }
      const res = await d.fetchFn(job.url, {
        timeoutMs: 15000,
        retries: 1,
        headers: { "User-Agent": HTML_UA },
      });
      if (!res.ok) return { key, status: "not_found" };
      const html = await res.text();
      if (typeof html !== "string" || html.length === 0) {
        return { key, status: "not_found" };
      }
      const capped = html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;
      text = formatIcims(capped, job);
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
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
  return results;
}

module.exports = {
  cacheKey,
  fetchJd,
  fetchAll,
  stripHtml,
  // exported for tests / debugging
  formatGreenhouse,
  formatLever,
  formatWorkday,
  formatIcims,
  buildWorkdayApiUrl,
};
