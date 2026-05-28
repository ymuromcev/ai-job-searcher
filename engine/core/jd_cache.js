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

// Workable per-job JSON. The widget listing endpoint
// (api/v1/widget/accounts/{slug}) does NOT include per-job descriptions,
// and the per-job widget route 404s. The non-widget v1 route
//   https://apply.workable.com/api/v1/accounts/{slug}/jobs/{shortcode}
// is public, unauth'd, and returns { title, description, requirements,
// benefits, type, workplace, location, locations, ... } where
// description/requirements/benefits are HTML strings.
//
// We build the API URL from job.slug + job.jobId (already validated by
// the discovery adapter — assertJob enforces alphanumeric shape) rather
// than parsing job.url, so a tampered TSV row can't redirect the fetch
// to an arbitrary host.
const WORKABLE_API_BASE = "https://apply.workable.com/api/v1/accounts";
// Workable shortcodes seen in the wild are uppercase alphanumeric (e.g.
// "922D2C6549"); allow underscore/dash for forward-compat. The slug
// shape mirrors what `companies.tsv` accepts (lowercase, dot, dash).
const WORKABLE_JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WORKABLE_SLUG_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function buildWorkableApiUrl(job) {
  if (!job || typeof job.slug !== "string" || typeof job.jobId !== "string") return null;
  if (!WORKABLE_SLUG_RE.test(job.slug)) return null;
  if (!WORKABLE_JOB_ID_RE.test(job.jobId)) return null;
  return `${WORKABLE_API_BASE}/${encodeURIComponent(job.slug)}/jobs/${encodeURIComponent(job.jobId)}`;
}

function formatWorkable(data, job) {
  if (!data || typeof data !== "object") return null;
  const descHtml = typeof data.description === "string" ? data.description : "";
  const reqHtml = typeof data.requirements === "string" ? data.requirements : "";
  const benHtml = typeof data.benefits === "string" ? data.benefits : "";
  // Body = description + requirements + benefits joined. Description alone is
  // usually enough; requirements is where the "must have" bullets live and
  // matters for extractRequirements downstream. If all three are empty,
  // return null so fetchJd surfaces not_found instead of caching a
  // header-only stub.
  const bodyParts = [];
  if (descHtml) bodyParts.push(stripHtml(descHtml));
  if (reqHtml) bodyParts.push(`\nRequirements:\n${stripHtml(reqHtml)}`);
  if (benHtml) bodyParts.push(`\nBenefits:\n${stripHtml(benHtml)}`);
  const body = bodyParts.join("\n").trim();
  if (!body) return null;

  const title = (typeof data.title === "string" && data.title) || (job && job.title) || "";
  // Workable location is an object {country, countryCode, city, region};
  // join non-empty parts.
  let location = "";
  const loc = data.location && typeof data.location === "object" ? data.location : null;
  if (loc) {
    location = [loc.city, loc.region, loc.country]
      .filter((s) => typeof s === "string" && s.trim().length > 0)
      .join(", ");
  }
  // Schedule: workplace ("remote"/"hybrid"/"onsite") + type ("full"/"part"/...)
  // Mirror Workday/Taleo "SCHEDULE: Full time" line so extractSchedule can
  // pick it up without parsing the body.
  const TYPE_MAP = {
    full: "Full-time",
    part: "Part-time",
    contract: "Contract",
    temporary: "Temporary",
    intern: "Internship",
    internship: "Internship",
  };
  const typeRaw = typeof data.type === "string" ? data.type.toLowerCase() : "";
  const typeLabel = TYPE_MAP[typeRaw] || (typeRaw ? typeRaw : "");
  const workplaceRaw = typeof data.workplace === "string" ? data.workplace.toLowerCase() : "";
  const workplaceLabel = workplaceRaw
    ? workplaceRaw.charAt(0).toUpperCase() + workplaceRaw.slice(1)
    : "";
  const scheduleParts = [typeLabel, workplaceLabel].filter(Boolean);
  const scheduleLine = scheduleParts.join(" · ");

  const parts = [`TITLE: ${title}`];
  if (location) parts.push(`LOCATION: ${location}`);
  if (scheduleLine) parts.push(`SCHEDULE: ${scheduleLine}`);
  if (data.code) parts.push(`REQ ID: ${data.code}`);
  parts.push("");
  parts.push(body);
  return parts.join("\n").trim();
}

// Taleo (TalentBrew) JD page. No public JSON API — scrape HTML. Pages
// reliably carry a `<script type="application/ld+json">` block with
// schema.org JobPosting metadata, plus a `<div class="ats-description">`
// body container (same TalentBrew shape as CommonSpirit iCIMS — we
// re-use TALENTBREW_DESC_RE / TALENTBREW_DESC_FALLBACK_RE above).
const TALEO_HOST_ALLOW = new Set(["www.kaiserpermanentejobs.org"]);

function isAllowedTaleoHost(hostname) {
  return TALEO_HOST_ALLOW.has(String(hostname || "").toLowerCase());
}

function extractJsonLdJob(html) {
  if (typeof html !== "string" || !html) return null;
  const SCRIPT_RE = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const c of candidates) {
      if (c && typeof c === "object" && c["@type"] === "JobPosting") return c;
    }
  }
  return null;
}

function formatTaleo(html, job) {
  if (typeof html !== "string" || !html) return null;

  const ld = extractJsonLdJob(html) || {};
  const title = (typeof ld.title === "string" && ld.title) || (job && job.title) || "";

  // Location: JSON-LD jobLocation can be an object, array, or string. Be
  // defensive — we only need a printable line.
  let location = "";
  if (typeof ld.jobLocation === "string") {
    location = ld.jobLocation;
  } else if (ld.jobLocation && typeof ld.jobLocation === "object") {
    const arr = Array.isArray(ld.jobLocation) ? ld.jobLocation : [ld.jobLocation];
    const addr = arr[0] && arr[0].address;
    if (addr && typeof addr === "object") {
      const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(
        (s) => typeof s === "string" && s.trim().length > 0
      );
      location = parts.join(", ");
    }
  }
  if (!location && Array.isArray(job && job.locations) && job.locations.length > 0) {
    location = job.locations[0];
  }

  // Schedule priority: listing-tile hint (from adapter rawExtra) > JSON-LD
  // employmentType. Kaiser's employmentType is the useless "Standard" most
  // of the time; the listing tile carries the real value ("Full-time" /
  // "Per Diem" / "Part-time" etc.).
  const hint = (job && job.rawExtra && job.rawExtra.scheduleHint) || "";
  let scheduleLine = "";
  if (hint && hint.toLowerCase() !== "standard") {
    scheduleLine = hint;
  } else if (
    typeof ld.employmentType === "string" &&
    ld.employmentType.toLowerCase() !== "standard"
  ) {
    scheduleLine = ld.employmentType;
  }

  // Body: JSON-LD description + qualifications joined wins. Fall back to
  // ats-description container in the raw HTML if JSON-LD missing.
  let body = "";
  const ldDesc = typeof ld.description === "string" ? ld.description : "";
  const ldQual = typeof ld.qualifications === "string" ? ld.qualifications : "";
  if (ldDesc || ldQual) {
    body = stripHtml(`${ldDesc}\n${ldQual}`);
  } else {
    const m = TALENTBREW_DESC_RE.exec(html) || TALENTBREW_DESC_FALLBACK_RE.exec(html);
    body = m ? stripHtml(m[1]) : "";
  }
  if (!body) return null;

  const parts = [`TITLE: ${title}`];
  if (location) parts.push(`LOCATION: ${location}`);
  if (scheduleLine) parts.push(`SCHEDULE: ${scheduleLine}`);
  if (typeof ld.identifier === "string" && ld.identifier) {
    parts.push(`REQ ID: ${ld.identifier}`);
  } else if (
    ld.identifier &&
    typeof ld.identifier === "object" &&
    typeof ld.identifier.value === "string" &&
    ld.identifier.value
  ) {
    parts.push(`REQ ID: ${ld.identifier.value}`);
  }
  parts.push("");
  parts.push(body);
  return parts.join("\n").trim();
}

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

// Ashby public posting API. Per-board endpoint returns the full job list with
// `descriptionHtml` / `descriptionPlain` inline:
//   https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true
// The per-job route (/posting-api/job-board/{org}/{id}) is auth-gated (401),
// so we fetch the board and locate the job by `id`. The board is small enough
// (~100-200 KB) and the response is cacheable per (org, job) by the existing
// cacheKey scheme — no extra in-memory dedupe needed for the first pass.
const ASHBY_API_BASE = "https://api.ashbyhq.com/posting-api/job-board";
// Org slug shape mirrors the discovery adapter target (`target.slug`):
// lowercase alphanumeric + dash, no path separators or unicode tricks.
const ASHBY_SLUG_RE = /^[a-z0-9-]{1,64}$/;
// Ashby job IDs are canonical UUID v4: 8-4-4-4-12 lowercase hex.
const ASHBY_JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function buildAshbyApiUrl(job) {
  if (!job || typeof job.slug !== "string" || typeof job.jobId !== "string") return null;
  if (!ASHBY_SLUG_RE.test(job.slug)) return null;
  if (!ASHBY_JOB_ID_RE.test(job.jobId)) return null;
  return `${ASHBY_API_BASE}/${encodeURIComponent(job.slug)}?includeCompensation=true`;
}

function formatAshby(data, job) {
  if (!data || typeof data !== "object") return null;
  const jobs = Array.isArray(data.jobs) ? data.jobs : null;
  if (!jobs) return null;
  const wanted = job && typeof job.jobId === "string" ? job.jobId : "";
  const entry = jobs.find((j) => j && typeof j === "object" && j.id === wanted);
  if (!entry) return null;

  const descHtml = typeof entry.descriptionHtml === "string" ? entry.descriptionHtml : "";
  const descPlain = typeof entry.descriptionPlain === "string" ? entry.descriptionPlain : "";
  // Prefer HTML (richer structure — bullets, headings) then fall back to plain.
  // stripHtml flattens both to the same shape extractRequirements expects.
  let body = "";
  if (descHtml) body = stripHtml(descHtml);
  if (!body && descPlain) body = descPlain.trim();
  if (!body) return null;

  const title = (typeof entry.title === "string" && entry.title) || (job && job.title) || "";

  // Primary location + secondaryLocations[].location joined into one printable
  // line. Schema.org-shaped `address.postalAddress` is ignored — `location`
  // field is the human label Ashby surfaces in its UI.
  const locParts = [];
  if (typeof entry.location === "string" && entry.location.trim()) {
    locParts.push(entry.location.trim());
  }
  if (Array.isArray(entry.secondaryLocations)) {
    for (const sec of entry.secondaryLocations) {
      if (sec && typeof sec.location === "string" && sec.location.trim()) {
        locParts.push(sec.location.trim());
      }
    }
  }
  const location = locParts.join(" / ");

  // Schedule line: employmentType + workplaceType when present.
  // employmentType seen in the wild: "FullTime", "PartTime", "Contract",
  // "Intern", "Temporary". Normalize the CamelCase to the same labels
  // Workable produces for downstream extractSchedule.
  const EMPLOYMENT_MAP = {
    FullTime: "Full-time",
    PartTime: "Part-time",
    Contract: "Contract",
    Temporary: "Temporary",
    Intern: "Internship",
  };
  const empRaw = typeof entry.employmentType === "string" ? entry.employmentType : "";
  const empLabel = EMPLOYMENT_MAP[empRaw] || (empRaw ? empRaw : "");
  // workplaceType: "Remote" / "Hybrid" / "Onsite" — sometimes null.
  // isRemote is a separate boolean; fall back to it when workplaceType missing.
  let workplaceLabel = "";
  if (typeof entry.workplaceType === "string" && entry.workplaceType.trim()) {
    const w = entry.workplaceType.trim();
    workplaceLabel = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  } else if (entry.isRemote === true) {
    workplaceLabel = "Remote";
  }
  const scheduleLine = [empLabel, workplaceLabel].filter(Boolean).join(" · ");

  const parts = [`TITLE: ${title}`];
  if (location) parts.push(`LOCATION: ${location}`);
  if (scheduleLine) parts.push(`SCHEDULE: ${scheduleLine}`);
  // Ashby doesn't surface a req-ID-style externalId on the posting-api; the
  // UUID `id` itself is the closest thing. Skip REQ ID line — no signal.
  parts.push("");
  parts.push(body);
  return parts.join("\n").trim();
}

// --- UltiPro / UKG Pro Recruiting JD fetcher --------------------------------
//
// New-gen UUID JobBoard publishes a public `OpportunityDetail` HTML page,
// server-rendered (no JS needed for the description body). The discovery
// adapter (`engine/modules/discovery/ultipro.js`) already validated the URL's
// shape before storing it on `job.url` (host/tenant/boardId all regex-gated),
// so we trust the URL but still cap response size and require the recruiting
// `.ultipro.com` host.

const ULTIPRO_HOST_RE = /^[a-z0-9]{1,32}\.ultipro\.com$/;

// Description body lives inside `<div class="opportunity-description">…</div>`
// in new-gen rendering. Fallback to `<div id="JobDescription">` from the
// classic shell where the SPA still ships some legacy markup.
const ULTIPRO_DESC_RE =
  /<div[^>]*class="[^"]*opportunity-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
const ULTIPRO_DESC_FALLBACK_RE =
  /<div[^>]*id="JobDescription"[^>]*>([\s\S]*?)<\/div>/i;

function isAllowedUltiproHost(hostname) {
  return typeof hostname === "string" && ULTIPRO_HOST_RE.test(hostname);
}

function extractUltiproBody(html) {
  for (const re of [ULTIPRO_DESC_RE, ULTIPRO_DESC_FALLBACK_RE]) {
    const m = re.exec(html);
    if (m && m[1]) return m[1];
  }
  return null;
}

function formatUltipro(html, job) {
  if (typeof html !== "string" || !html) return null;
  const raw = extractUltiproBody(html);
  if (!raw) return null;
  const body = stripHtml(raw);
  if (!body) return null;
  const parts = [`TITLE: ${(job && job.title) || ""}`];
  const loc = Array.isArray(job && job.locations) ? job.locations.join(" / ") : "";
  if (loc) parts.push(`LOCATION: ${loc}`);
  const req = job && job.rawExtra && job.rawExtra.requisition;
  if (req) parts.push(`REQ ID: ${req}`);
  parts.push("");
  parts.push(body);
  return parts.join("\n").trim();
}

// --- Source registry --------------------------------------------------------
//
// SUPPORTED — discovery sources for which jd_cache has a fetcher.
// JD_UNSUPPORTED — discovery sources explicitly opted out of per-job
// fetching (typically feed aggregators that already include the JD body
// in their search result). Each exemption MUST carry a reason — the
// adapter↔jd_cache coverage test (engine/core/jd_cache.test.js) will fail
// if a new adapter source appears in neither set.
const SUPPORTED = new Set([
  "greenhouse",
  "lever",
  "workday",
  "icims",
  "taleo",
  "workable",
  "ashby",
  "ultipro",
]);

const JD_UNSUPPORTED = new Map([
  // Feed / aggregator adapters — the search result the adapter produces
  // already carries everything the prepare stage needs; per-job fetching
  // is a no-op for the pipeline's downstream consumers.
  ["adzuna", "feed aggregator — listing stores description snippet in rawExtra"],
  ["remoteok", "feed aggregator — public JSON includes JD body in the search result"],
  ["the_muse", "feed aggregator — listing API returns JD contents alongside metadata"],
  ["indeed", "feed aggregator — manual ingest only, no public per-job route"],
  ["usajobs", "feed aggregator — USAJOBS search API returns the JD body inline"],
  ["jobsyn", "feed aggregator — Jobs Syndication search returns JD body inline"],
  ["calcareers", "scraped HTML listing — adapter already pulls the per-job page during discovery"],
  // ATS adapters with documented gaps (no JD fetcher yet — tracked as
  // follow-ups). Listed here so the coverage test stays green; remove
  // an entry once the matching fetcher lands.
  ["smartrecruiters", "ATS — JD fetcher not yet implemented (gap audited 2026-05-18)"],
  ["oracle_cloud", "ATS — JD fetcher not yet implemented (gap audited 2026-05-18)"],
]);

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
    } else if (source === "workable") {
      // Workable per-job JSON. URL is rebuilt from job.slug + job.jobId
      // (both validated by buildWorkableApiUrl) so a tampered url field
      // cannot redirect the fetch elsewhere.
      const url = buildWorkableApiUrl(job);
      if (!url) return { key, status: "not_found" };
      const res = await d.fetchFn(url, {
        timeoutMs: 15000,
        retries: 1,
        headers: { "User-Agent": HTML_UA },
      });
      if (!res.ok) return { key, status: "not_found" };
      const data = await res.json();
      text = formatWorkable(data, job);
    } else if (source === "ashby") {
      // Ashby per-board JSON. URL is rebuilt from job.slug + validated UUID
      // job.jobId so a tampered url field cannot redirect the fetch.
      const url = buildAshbyApiUrl(job);
      if (!url) return { key, status: "not_found" };
      const res = await d.fetchFn(url, {
        timeoutMs: 15000,
        retries: 1,
        headers: { "User-Agent": HTML_UA },
      });
      if (!res.ok) return { key, status: "not_found" };
      const data = await res.json();
      text = formatAshby(data, job);
    } else if (source === "taleo") {
      // SSRF guard: only fetch from the explicit Taleo host allow-list. The
      // adapter already wrote `job.url` with a vetted host, but we re-check
      // here so an attacker-tampered TSV row can't redirect JD fetches.
      if (!job.url || typeof job.url !== "string") {
        return { key, status: "not_found" };
      }
      let parsed;
      try {
        parsed = new URL(job.url);
      } catch {
        return { key, status: "not_found" };
      }
      if (parsed.protocol !== "https:" || !isAllowedTaleoHost(parsed.hostname)) {
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
      text = formatTaleo(capped, job);
    } else if (source === "ultipro") {
      // SSRF guard: only fetch from `*.ultipro.com`. Adapter already builds
      // the URL from regex-validated host/tenant/boardId, but we re-check
      // here so an attacker-tampered TSV row cannot redirect the GET.
      if (!job.url || typeof job.url !== "string") {
        return { key, status: "not_found" };
      }
      let parsed;
      try {
        parsed = new URL(job.url);
      } catch {
        return { key, status: "not_found" };
      }
      if (parsed.protocol !== "https:" || !isAllowedUltiproHost(parsed.hostname)) {
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
      text = formatUltipro(capped, job);
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
  SUPPORTED,
  JD_UNSUPPORTED,
  // exported for tests / debugging
  formatGreenhouse,
  formatLever,
  formatWorkday,
  formatIcims,
  formatTaleo,
  formatWorkable,
  formatAshby,
  formatUltipro,
  buildWorkdayApiUrl,
  buildWorkableApiUrl,
  buildAshbyApiUrl,
  extractJsonLdJob,
  isAllowedTaleoHost,
  isAllowedUltiproHost,
};
