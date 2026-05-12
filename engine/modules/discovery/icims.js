// iCIMS public job-board adapter — two HTML extractor modes:
//
//   1. `icims-default` — direct iCIMS-hosted subdomain (most tenants):
//        GET https://careers-{slug}.icims.com/jobs/search?ss=1&pr=N&in_iframe=1
//      Job rows are <li class="iCIMS_JobCardItem"> with an embedded
//      <a class="iCIMS_Anchor" href=".../jobs/{numericId}/{slug-title}/job">.
//      Pagination: ?pr=N (0-based).
//
//   2. `talentbrew` — custom front-end layered over iCIMS (CommonSpirit):
//        GET https://www.commonspirit.careers/search-jobs?p=N
//      Job rows are <li class="search-results-list__item"> with a
//      <a class="search-results-list__job-link" href="/job/..."
//         data-job-id="{jobId}">. Hrefs are relative — adapter prepends
//      `urlBase`'s origin.
//      Pagination: ?p=N (1-based).
//
// Each TSV target row carries:
//   { name, slug, urlBase?, htmlMode?, locationAllow? }
//   urlBase       — full search URL. Optional; if absent the adapter builds
//                   `https://careers-{slug}.icims.com/jobs/search` from slug.
//                   Required when htmlMode === "talentbrew" (no slug-to-URL
//                   convention for non-iCIMS frontends).
//   htmlMode      — "icims-default" (default) or "talentbrew".
//   locationAllow — substring patterns matched (case-insensitive) against
//                   each posting's location string. Empty/unset = keep all.
//                   Used as a post-fetch geo filter (per RFC 025 §2 probe 5
//                   the request-level location filter behaves inconsistently
//                   across tenants).
//
// SSRF guard: only allow https URLs on the iCIMS subdomain pattern OR a
// hostname explicitly whitelisted via TSV `urlBase`. Hostname goes through
// URL parsing — no string concat shortcuts.
//
// Failure isolation: HTTP errors per tenant become per-target warnings via
// runTargets; one tenant going dark cannot kill the scan. HTML structure
// drift on a single tenant produces a 0-jobs result for that tenant (logged
// downstream as a stale-source signal once RFC 017 §7 detection lands).

const { runTargets, makeCtx } = require("./_ats.js");
const { assertJob } = require("./_types.js");
const { sanitizeText, dedupeLocations } = require("./_normalize.js");

const SOURCE = "icims";
const UA = "Mozilla/5.0 (compatible; ai-job-searcher/1.0)";
const MAX_PAGES = 30;
// Cap how much HTML we'll parse per page. Largest real iCIMS page seen in
// recon was ~2.8 MB (CommonSpirit). 5 MB leaves headroom for growth while
// guarding against runaway responses (truncated streams, malicious pages).
const MAX_HTML_BYTES = 5 * 1024 * 1024;

// Slug shape: lowercase alnum + dash. Validated to prevent SSRF via
// crafted slugs (e.g. "../foo" or "internal-host"). Matches every real
// iCIMS tenant slug we have today.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isValidSlug(slug) {
  if (typeof slug !== "string" || !slug) return false;
  return SLUG_PATTERN.test(slug);
}

function defaultIcimsUrlBase(slug) {
  return `https://careers-${slug}.icims.com/jobs/search`;
}

function buildPageUrl(base, mode, pageIdx) {
  const sep = base.includes("?") ? "&" : "?";
  if (mode === "talentbrew") {
    // CommonSpirit-style: ?p=N, N is 1-based.
    return `${base}${sep}p=${pageIdx + 1}`;
  }
  // icims-default: ?ss=1 starts a search, ?pr=N is 0-based pagination,
  // &in_iframe=1 selects the static-HTML iframe variant (no JS hydration).
  return `${base}${sep}ss=1&pr=${pageIdx}&in_iframe=1`;
}

function locationMatchesAllow(loc, allow) {
  if (!Array.isArray(allow) || allow.length === 0) return true;
  const lt = String(loc == null ? "" : loc)
    .toLowerCase()
    .trim();
  if (!lt) return false;
  return allow.some((p) => {
    const needle = String(p == null ? "" : p)
      .toLowerCase()
      .trim();
    return needle.length > 0 && lt.includes(needle);
  });
}

// --- icims-default HTML parser -----------------------------------------
// Strategy: split on the row marker <li class="iCIMS_JobCardItem"> and
// pull title/url/jobId/location/category out of each block via narrow
// regexes. No JSDOM (matches calcareers / indeed pattern in this repo).
function extractIcimsDefault(html) {
  if (typeof html !== "string" || !html) return [];
  const ROW_RE = /<li[^>]*class="[^"]*\biCIMS_JobCardItem\b[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  const out = [];
  let m;
  while ((m = ROW_RE.exec(html)) !== null) {
    const body = m[1];
    const job = parseIcimsDefaultRow(body);
    if (job) out.push(job);
  }
  return out;
}

function parseIcimsDefaultRow(body) {
  // Title anchor: <a href="..." class="iCIMS_Anchor" title="..."><h3>{TITLE}</h3>
  const anchor = /<a\s+[^>]*href="([^"]+)"[^>]*class="[^"]*\biCIMS_Anchor\b[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(body);
  if (!anchor) return null;
  const href = decodeHtmlEntities(anchor[1]);
  const titleHtml = anchor[2];
  // Title is inside <h3>...</h3> (sometimes other tags); fall back to anchor
  // inner text after stripping all tags.
  let title = "";
  const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(titleHtml);
  if (h3) {
    title = stripTags(h3[1]);
  } else {
    title = stripTags(titleHtml);
  }
  title = sanitizeText(title);
  if (!title) return null;

  // jobId from URL: /jobs/{numeric}/...
  const idMatch = /\/jobs\/(\d+)\//.exec(href);
  if (!idMatch) return null;
  const jobId = idMatch[1];

  // Location: <span class="sr-only field-label">Job Locations</span><span>{LOC}</span>
  let location = "";
  const locMatch =
    /<span[^>]*class="sr-only[^"]*"[^>]*>\s*Job Locations\s*<\/span>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/i.exec(
      body
    );
  if (locMatch) {
    location = sanitizeText(locMatch[1]);
  }

  // Category (department-equivalent): <dt>Category</dt><dd>...<span>{CAT}</span></dd>
  let category = "";
  const catMatch =
    /<dt[^>]*>\s*Category\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i.exec(body);
  if (catMatch) {
    category = sanitizeText(stripTags(catMatch[1]));
  }

  return {
    jobId,
    title,
    url: href,
    location,
    category,
  };
}

// --- talentbrew HTML parser --------------------------------------------
// CommonSpirit-style: <li class="search-results-list__item ..."> rows.
function extractTalentbrew(html, urlBase) {
  if (typeof html !== "string" || !html) return [];
  const ROW_RE =
    /<li[^>]*class="[^"]*\bsearch-results-list__item\b[^"]*"[^>]*>([\s\S]*?)(?=<li[^>]*class="[^"]*\bsearch-results-list__item\b|<\/ul>|<\/ol>|$)/g;
  const out = [];
  let m;
  while ((m = ROW_RE.exec(html)) !== null) {
    const body = m[1];
    const job = parseTalentbrewRow(body, urlBase);
    if (job) out.push(job);
  }
  return out;
}

function parseTalentbrewRow(body, urlBase) {
  // Title anchor: <a class="search-results-list__job-link" href="..."
  //                   data-job-id="...">{TITLE}</a>
  const anchor =
    /<a[^>]*class="[^"]*\bsearch-results-list__job-link\b[^"]*"[^>]*href="([^"]+)"[^>]*?(?:data-job-id="([^"]+)")?[^>]*>([\s\S]*?)<\/a>/.exec(
      body
    );
  if (!anchor) return null;
  const href = decodeHtmlEntities(anchor[1]);
  const dataJobId = anchor[2] ? sanitizeText(anchor[2]) : "";
  const title = sanitizeText(stripTags(anchor[3]));
  if (!title) return null;

  // jobId: prefer data-job-id attr; fall back to last numeric URL segment.
  let jobId = dataJobId;
  if (!jobId) {
    const m2 = /\/(\d+)(?:[?#].*)?$/.exec(href);
    if (m2) jobId = m2[1];
  }
  if (!jobId) return null;

  // Absolute URL: hrefs are relative ("/job/..."). Prepend urlBase origin.
  let absUrl = href;
  if (/^\/[^/]/.test(href)) {
    try {
      const base = new URL(urlBase);
      absUrl = `${base.protocol}//${base.host}${href}`;
    } catch {
      // urlBase is malformed but adapter already validated it earlier;
      // fall through with raw href.
    }
  }

  // Location, department, facility — three <li class="search-results-list__job-info job-{kind}">
  const grab = (kind) => {
    const re = new RegExp(
      `<li[^>]*class="[^"]*\\bsearch-results-list__job-info\\s+job-${kind}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/li>`,
      "i"
    );
    const mm = re.exec(body);
    return mm ? sanitizeText(stripTags(mm[1])) : "";
  };
  const location = grab("location");
  const department = grab("department");
  const facility = grab("facility");

  return {
    jobId,
    title,
    url: absUrl,
    location,
    department,
    facility,
  };
}

// --- shared HTML helpers ------------------------------------------------
function stripTags(s) {
  return String(s == null ? "" : s).replace(/<[^>]*>/g, " ");
}

// Decode the entity classes iCIMS pages actually emit (named for the common
// ASCII set, plus numeric for the long tail). Named entities are applied
// after numerics so a payload of "&amp;" decodes correctly even if a malicious
// page tries to pre-encode it.
function decodeHtmlEntities(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    })
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// --- core fetch loop ----------------------------------------------------
async function fetchAllPages(fetchFn, base, mode, urlBase, signal) {
  const all = [];
  for (let p = 0; p < MAX_PAGES; p += 1) {
    const url = buildPageUrl(base, mode, p);
    const res = await fetchFn(url, {
      method: "GET",
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal,
    });
    if (!res.ok) {
      // 404 after the first page = end of pagination (some iCIMS tenants
      // return 404 for ?pr=N beyond the last). Throw on any other status.
      if (res.status === 404 && p > 0) break;
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.status = res.status;
      throw err;
    }
    let html = await res.text();
    if (typeof html === "string" && html.length > MAX_HTML_BYTES) {
      // Truncate rather than throw: a runaway page should produce zero
      // parseable rows (and end this tenant's loop on the next iteration),
      // not poison the whole scan.
      html = html.slice(0, MAX_HTML_BYTES);
    }
    const pageJobs =
      mode === "talentbrew"
        ? extractTalentbrew(html, urlBase)
        : extractIcimsDefault(html);
    if (pageJobs.length === 0) break;
    all.push(...pageJobs);
  }
  return all;
}

function mapJob(target, raw) {
  const jobId = String(raw.jobId || "").trim();
  if (!jobId) return null;
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId,
    title: raw.title,
    url: raw.url,
    locations: raw.location ? dedupeLocations([raw.location]) : [],
    team: raw.category || raw.department || null,
    postedAt: null,
    rawExtra: {
      htmlMode: target.htmlMode || "icims-default",
      facility: raw.facility || null,
    },
  };
  if (job.team) job.team = sanitizeText(job.team) || null;
  assertJob(job);
  return job;
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  return runTargets(targets, c, async (target) => {
    if (!target || !target.name) return [];
    if (!isValidSlug(target.slug)) {
      c.logger.warn(`[${SOURCE}] ${target.slug}: invalid slug`);
      return [];
    }
    const mode = target.htmlMode || "icims-default";
    if (mode !== "icims-default" && mode !== "talentbrew") {
      c.logger.warn(`[${SOURCE}] ${target.slug}: unknown htmlMode "${mode}"`);
      return [];
    }
    const urlBase = target.urlBase || defaultIcimsUrlBase(target.slug);
    // urlBase SSRF guard: https only, hostname must look like a host (not a
    // path or scheme-relative URL).
    let parsed;
    try {
      parsed = new URL(urlBase);
    } catch {
      c.logger.warn(`[${SOURCE}] ${target.slug}: invalid urlBase "${urlBase}"`);
      return [];
    }
    if (parsed.protocol !== "https:") {
      c.logger.warn(
        `[${SOURCE}] ${target.slug}: urlBase must be https, got "${parsed.protocol}"`
      );
      return [];
    }
    // SSRF hardening: hosts outside `*.icims.com` must explicitly opt in via
    // a non-default htmlMode. This ties trust to the same TSV field that
    // already signals "this is a non-iCIMS front-end" (e.g. CommonSpirit's
    // TalentBrew), so a typo can't silently redirect adapter traffic
    // somewhere arbitrary.
    if (!parsed.hostname.toLowerCase().endsWith(".icims.com") && mode === "icims-default") {
      c.logger.warn(
        `[${SOURCE}] ${target.slug}: urlBase host "${parsed.hostname}" outside *.icims.com requires non-default htmlMode`
      );
      return [];
    }

    const raws = await fetchAllPages(c.fetchFn, urlBase, mode, urlBase, c.signal);

    let droppedNoId = 0;
    let droppedByLocation = 0;
    const out = [];
    for (const r of raws) {
      if (!r || !r.jobId) {
        droppedNoId += 1;
        continue;
      }
      if (!locationMatchesAllow(r.location, target.locationAllow)) {
        droppedByLocation += 1;
        continue;
      }
      const job = mapJob(target, r);
      if (job) out.push(job);
    }
    if (droppedNoId > 0) {
      c.logger.warn(`[${SOURCE}] ${target.slug}: dropped ${droppedNoId} postings without jobId`);
    }
    if (droppedByLocation > 0) {
      c.logger.warn(
        `[${SOURCE}] ${target.slug}: dropped ${droppedByLocation} postings outside locationAllow`
      );
    }
    return out;
  });
}

module.exports = {
  source: SOURCE,
  discover,
  // Exports below are for unit tests only.
  _internals: {
    extractIcimsDefault,
    extractTalentbrew,
    buildPageUrl,
    locationMatchesAllow,
    isValidSlug,
    mapJob,
  },
};
