// Taleo (TalentBrew front-end) adapter — initially for Kaiser Permanente,
// generic enough that adding another Taleo/TalentBrew tenant later costs
// one TSV row and zero code.
//
//   GET https://www.kaiserpermanentejobs.org/search-jobs/{loc}?p=N
//
// Listings live under `<section id="search-results-list">`. Each posting:
//   <li><a href="/job/{city}/{slug}/{companyId}/{jobId}" data-job-id="{jobId}">
//     <h2>{title}</h2>
//     <span class="job-location">{location}, {workSetting}, {schedule}, {shift}</span>
//   </a><button>...</button></li>
//
// We accept <h2> or <h3> headings (resilience to layout drift) and read
// either the `data-job-id` attribute or the trailing numeric URL segment.
//
// `companyId` is the TalentBrew tenant id (Kaiser=641). It's required in
// the target meta so we can validate that hrefs really belong to the
// expected tenant (defense against href injection or accidental
// cross-tenant scrape).
//
// Per-target TSV row meta:
//   { siteUrl, companyId, searchLocations?, locationAllow? }
//   siteUrl          full https origin (e.g. https://www.kaiserpermanentejobs.org)
//   companyId        TalentBrew tenant id (numeric string).
//   searchLocations  array of location strings to iterate as separate
//                    search queries. Default: [""] (single unfiltered scan).
//   locationAllow    substring patterns matched (case-insensitive) against
//                    each posting's location string. Empty/unset = keep all.
//
// SSRF guard: siteUrl host must be in TALEO_HOST_ALLOW. We deliberately do
// not accept arbitrary `*.taleo.net` — only Kaiser's known public front-end
// for now. Add more tenants by extending TALEO_HOST_ALLOW in code (not via
// TSV) to keep the trust surface explicit.

const { runTargets, makeCtx } = require("./_ats.js");
const { assertJob } = require("./_types.js");
const { sanitizeText, dedupeLocations } = require("./_normalize.js");

const SOURCE = "taleo";
const UA = "Mozilla/5.0 (compatible; ai-job-searcher/1.0)";
const MAX_PAGES = 30;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

const TALEO_HOST_ALLOW = new Set([
  "www.kaiserpermanentejobs.org",
]);

const COMPANY_ID_RE = /^\d{1,8}$/;
const JOB_ID_RE = /^\d{6,16}$/;

function isAllowedHost(hostname) {
  return TALEO_HOST_ALLOW.has(String(hostname || "").toLowerCase());
}

function buildPageUrl(siteUrl, loc, pageIdx) {
  const safeLoc = encodeURIComponent(loc || "");
  const path = safeLoc ? `/search-jobs/${safeLoc}` : "/search-jobs";
  return `${siteUrl.replace(/\/+$/, "")}${path}?p=${pageIdx + 1}`;
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

function stripTags(s) {
  return String(s == null ? "" : s).replace(/<[^>]*>/g, " ");
}

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

// --- HTML extraction ---------------------------------------------------

// Scope the row search to the <section id="search-results-list"> block to
// avoid pulling unrelated <li> from page chrome (nav menus, footer links).
const SECTION_RE =
  /<section[^>]*id="search-results-list"[^>]*>([\s\S]*?)<\/section>/i;

// Match each <li>...<a href="...">{innerHTML}</a>... block. We capture
// the *entire* <li> body (not just the anchor) so we can read the
// optional sibling button's `data-org-id` for an extra companyId
// cross-check. The non-greedy stop is on `</li>` to keep rows isolated.
const ROW_RE =
  /<li[^>]*>\s*<a\s+([^>]*)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>([\s\S]*?)<\/li>/g;

function extractTaleo(html, target) {
  if (typeof html !== "string" || !html) return [];
  const sec = SECTION_RE.exec(html);
  if (!sec) return [];
  const inner = sec[1];
  const out = [];
  ROW_RE.lastIndex = 0;
  let m;
  while ((m = ROW_RE.exec(inner)) !== null) {
    // m[1] — pre-href anchor attrs, m[2] — href, m[3] — post-href attrs,
    // m[4] — anchor inner HTML, m[5] — post-anchor <li> body.
    const job = parseTaleoRow({
      rawHref: m[2],
      preAttrs: m[1],
      postAttrs: m[3],
      anchorInner: m[4],
      tail: m[5],
      target,
    });
    if (job) out.push(job);
  }
  return out;
}

function parseTaleoRow({ rawHref, preAttrs, postAttrs, anchorInner, tail, target }) {
  const href = decodeHtmlEntities(rawHref);

  // Path shape: /job/{city}/{title-slug}/{companyId}/{jobId}
  // We anchor on the trailing two segments to validate companyId tenancy.
  const pathMatch = /\/job\/[^/]+\/[^/]+\/(\d+)\/(\d+)\/?$/.exec(href);
  if (!pathMatch) return null;
  const companyIdFromPath = pathMatch[1];
  const jobIdFromPath = pathMatch[2];
  if (!COMPANY_ID_RE.test(companyIdFromPath)) return null;
  if (!JOB_ID_RE.test(jobIdFromPath)) return null;
  if (companyIdFromPath !== String(target.companyId)) return null;

  // Prefer data-job-id attribute on the <a> tag, fall back to URL tail.
  const attrs = `${preAttrs || ""} ${postAttrs || ""}`;
  const dataJobIdMatch = /data-job-id="([^"]+)"/.exec(attrs);
  let jobId = dataJobIdMatch ? dataJobIdMatch[1].trim() : "";
  if (!JOB_ID_RE.test(jobId)) jobId = jobIdFromPath;

  // Cross-check companyId via sibling button's data-org-id if present.
  // Mismatch is suspicious enough to drop the row.
  const orgIdMatch = /data-org-id="([^"]+)"/.exec(tail || "");
  if (orgIdMatch && orgIdMatch[1].trim() !== String(target.companyId)) return null;

  // Title — first <h2> or <h3>
  const headMatch = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/.exec(anchorInner);
  const title = sanitizeText(stripTags(headMatch ? headMatch[1] : ""));
  if (!title) return null;

  // Meta line — <span class="job-location"> (canonical), fall back to <p>.
  let metaLine = "";
  const locSpan = /<span[^>]*class="[^"]*\bjob-location\b[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(
    anchorInner
  );
  if (locSpan) {
    metaLine = sanitizeText(stripTags(locSpan[1]));
  } else {
    const pMatch = /<p[^>]*>([\s\S]*?)<\/p>/.exec(anchorInner);
    metaLine = pMatch ? sanitizeText(stripTags(pMatch[1])) : "";
  }
  // Kaiser's tile prints "City, ST, WorkSetting, Schedule, Shift" — 5 comma
  // fields when the state is present. Some entries omit the state, work
  // setting, or shift; we detect the 2-letter state at parts[1] and collapse
  // location into "City, ST" so schedule lands on metaParts[2] regardless of
  // whether the state qualifier was present.
  const rawParts = metaLine
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  let location;
  let workSetting;
  let schedule;
  let shift;
  if (rawParts.length >= 2 && /^[A-Z]{2}$/.test(rawParts[1])) {
    location = `${rawParts[0]}, ${rawParts[1]}`;
    workSetting = rawParts[2] || "";
    schedule = rawParts[3] || "";
    shift = rawParts[4] || "";
  } else {
    location = rawParts[0] || "";
    workSetting = rawParts[1] || "";
    schedule = rawParts[2] || "";
    shift = rawParts[3] || "";
  }

  // Absolute URL: hrefs are relative ("/job/..."); rebase on siteUrl.
  let absUrl = href;
  if (/^\/[^/]/.test(href)) {
    try {
      const base = new URL(target.siteUrl);
      absUrl = `${base.protocol}//${base.host}${href}`;
    } catch {
      return null;
    }
  } else if (/^https?:\/\//i.test(href)) {
    try {
      const parsed = new URL(href);
      if (!isAllowedHost(parsed.hostname)) return null;
      absUrl = parsed.toString();
    } catch {
      return null;
    }
  } else {
    // protocol-relative or unexpected — reject
    return null;
  }

  return {
    jobId,
    companyId: companyIdFromPath,
    title,
    url: absUrl,
    location,
    workSetting,
    schedule,
    shift,
  };
}

// --- core fetch loop ---------------------------------------------------

async function fetchAllPages(fetchFn, siteUrl, loc, target, signal) {
  const all = [];
  const seen = new Set();
  let prevPageIds = "";
  for (let p = 0; p < MAX_PAGES; p += 1) {
    const url = buildPageUrl(siteUrl, loc, p);
    const res = await fetchFn(url, {
      method: "GET",
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal,
    });
    if (!res.ok) {
      if ((res.status === 404 || res.status === 410) && p > 0) break;
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.status = res.status;
      throw err;
    }
    let html = await res.text();
    if (typeof html === "string" && html.length > MAX_HTML_BYTES) {
      html = html.slice(0, MAX_HTML_BYTES);
    }
    const pageJobs = extractTaleo(html, target);
    if (pageJobs.length === 0) break;

    // Duplicate-content short-circuit: TalentBrew sometimes returns the
    // last page indefinitely for ?p=> total. If this page's jobId set
    // matches the previous page exactly, stop.
    const pageIds = pageJobs.map((j) => j.jobId).sort().join(",");
    if (pageIds === prevPageIds) break;
    prevPageIds = pageIds;

    let added = 0;
    for (const j of pageJobs) {
      if (seen.has(j.jobId)) continue;
      seen.add(j.jobId);
      all.push(j);
      added += 1;
    }
    // No new jobs on this page (all were already seen) — pagination is
    // looping back to the start, stop.
    if (added === 0) break;
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
    team: null,
    postedAt: null,
    rawExtra: {
      companyId: raw.companyId,
      workSetting: raw.workSetting || null,
      scheduleHint: raw.schedule || null,
      shift: raw.shift || null,
    },
  };
  assertJob(job);
  return job;
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  return runTargets(targets, c, async (target) => {
    if (!target || !target.name || !target.slug) return [];
    if (!target.siteUrl) {
      c.logger.warn(`[${SOURCE}] ${target.slug}: missing siteUrl`);
      return [];
    }
    if (!target.companyId || !COMPANY_ID_RE.test(String(target.companyId))) {
      c.logger.warn(`[${SOURCE}] ${target.slug}: missing or invalid companyId`);
      return [];
    }
    let parsed;
    try {
      parsed = new URL(target.siteUrl);
    } catch {
      c.logger.warn(`[${SOURCE}] ${target.slug}: invalid siteUrl "${target.siteUrl}"`);
      return [];
    }
    if (parsed.protocol !== "https:") {
      c.logger.warn(`[${SOURCE}] ${target.slug}: siteUrl must be https`);
      return [];
    }
    if (!isAllowedHost(parsed.hostname)) {
      c.logger.warn(
        `[${SOURCE}] ${target.slug}: siteUrl host "${parsed.hostname}" not in TALEO_HOST_ALLOW`
      );
      return [];
    }

    const searchLocations = Array.isArray(target.searchLocations) && target.searchLocations.length > 0
      ? target.searchLocations
      : [""];

    const seenJobIds = new Set();
    const out = [];
    let droppedByLocation = 0;
    let droppedNoId = 0;

    for (const loc of searchLocations) {
      const raws = await fetchAllPages(c.fetchFn, target.siteUrl, loc, target, c.signal);
      for (const r of raws) {
        if (!r || !r.jobId) {
          droppedNoId += 1;
          continue;
        }
        if (seenJobIds.has(r.jobId)) continue;
        if (!locationMatchesAllow(r.location, target.locationAllow)) {
          droppedByLocation += 1;
          continue;
        }
        seenJobIds.add(r.jobId);
        const job = mapJob(target, r);
        if (job) out.push(job);
      }
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
  _internals: {
    extractTaleo,
    parseTaleoRow,
    buildPageUrl,
    locationMatchesAllow,
    isAllowedHost,
    mapJob,
    TALEO_HOST_ALLOW,
  },
};
