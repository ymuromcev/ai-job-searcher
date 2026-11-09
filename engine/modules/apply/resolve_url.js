// Resolve a job URL to the real ATS application URL (RFC 068 §1).
//
// Aggregator / tracker links (Adzuna, newsletter short links such as grnh.se
// and lnkd.in) redirect — sometimes over several hops, sometimes through an
// HTML page with a meta refresh or a JS `location` assignment — to the
// employer's ATS. Company career pages that embed Greenhouse carry a
// `gh_jid=<id>` query and reference the board slug in their HTML.
//
// `resolveUrl(url, { fetchFn, detectAts, maxHops, job?, slugIndex? })` → {
//   ok: boolean,
//   url: string,          // final URL (the ATS URL when found)
//   ats: string | null,   // adapter name when the final URL is a supported ATS
//   status: number,       // last HTTP status seen
//   hops: string[],       // URLs visited
//   via?: string,         // "company_board" when found on the company's board
//   reason?: string,      // "dead" | "blocked" | "fetch_error" | "unsafe_url" | "no_ats"
//                         // | "no_company_form" (aggregator row + `job` given)
// }
//
// fetchFn has the engine `defaultFetch` shape: (url, {method, redirect,
// timeoutMs, retries, headers}) → Response-like {status, url, text()}.
// Redirects are followed by fetch itself (`redirect: "follow"`); this module
// adds the HTML-level hops fetch cannot see.
//
// Aggregator rows (RFC 069 §5). When `opts.job` ({ company, title,
// locations }) is passed and the URL is a job-aggregator link (Adzuna,
// Indeed, LinkedIn, …), the same job is first looked up on the company's own
// Greenhouse / Lever / Ashby board through the discovery adapters' public
// board endpoints. Board slugs: the ones already known in data/companies.tsv
// (`opts.slugIndex`, see canonical_url.buildSlugIndex) first, then slugs
// guessed from the company name. Match = same normalized title (location
// breaks ties and vetoes an obviously different city). Match → the canonical
// form URL (`via: "company_board"`). No match → the redirect resolver below
// still runs; if it finds no ATS either, the result is
// `reason: "no_company_form"` (the original reason in `redirect_reason`).

const { isSafeLivenessUrl } = require("../../core/url_check.js");
const { normalizeName } = require("../../core/company_keys.js");
const { formUrl } = require("./canonical_url.js");

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const ATS_HOST_RE = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com)$/i;

const DEAD_CODES = new Set([404, 410]);
const BLOCKED_CODES = new Set([401, 403, 429, 999]);

// ATS application URLs that may appear inside an aggregator / career page.
const ATS_LINK_RES = [
  /https?:\/\/(?:job-boards|boards)\.greenhouse\.io\/[A-Za-z0-9_-]+\/jobs\/\d+[^"'<>\s\\]*/i,
  /https?:\/\/(?:job-boards|boards)\.greenhouse\.io\/embed\/job_app\?[^"'<>\s\\]+/i,
  /https?:\/\/jobs\.lever\.co\/[A-Za-z0-9_.-]+\/[0-9a-f-]{36}[^"'<>\s\\]*/i,
  /https?:\/\/jobs\.ashbyhq\.com\/[A-Za-z0-9_.%-]+\/[0-9a-f-]{36}[^"'<>\s\\]*/i,
];

const META_REFRESH_RE =
  /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>]+)["']/i;
const JS_LOCATION_RE =
  /(?:window\.|document\.)?location(?:\.href)?\s*(?:=|\.replace\(|\.assign\()\s*["'](https?:\/\/[^"']+)["']/i;

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/");
}

// Greenhouse embeds on company sites: `?gh_jid=123` + slug in the HTML
// (`for=<slug>` on the embed script, or a boards URL).
function greenhouseFromEmbed(pageUrl, html) {
  let jid = null;
  try {
    jid = new URL(pageUrl).searchParams.get("gh_jid");
  } catch {
    return null;
  }
  if (!jid || !/^\d+$/.test(jid)) return null;
  const body = decodeEntities(html);
  const m =
    body.match(/greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([A-Za-z0-9_-]+)/i) ||
    body.match(/greenhouse\.io\/embed\/job_app\?[^"'\s]*for=([A-Za-z0-9_-]+)/i) ||
    body.match(/(?:job-boards|boards)\.greenhouse\.io\/([A-Za-z0-9_-]+)(?:\/|["'?])/i);
  if (!m || m[1] === "embed") return null;
  return `https://job-boards.greenhouse.io/${m[1]}/jobs/${jid}`;
}

function findHtmlHop(pageUrl, html) {
  const body = decodeEntities(html || "");
  for (const re of ATS_LINK_RES) {
    const m = body.match(re);
    if (m) return m[0];
  }
  const gh = greenhouseFromEmbed(pageUrl, body);
  if (gh) return gh;
  const meta = body.match(META_REFRESH_RE);
  if (meta) return absolutize(meta[1].trim(), pageUrl);
  const js = body.match(JS_LOCATION_RE);
  if (js) return js[1];
  return null;
}

function absolutize(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

async function readText(res) {
  if (!res || typeof res.text !== "function") return "";
  try {
    const t = await res.text();
    return typeof t === "string" ? t.slice(0, 2 * 1024 * 1024) : "";
  } catch {
    return "";
  }
}

// --- Aggregator rows → the company's own board (RFC 069 §5) -----------------

// Job aggregators whose listing points at someone else's posting. Short links
// (grnh.se, lnkd.in) are not here: they redirect to the ATS by themselves.
const AGGREGATOR_HOST_RE =
  /(^|\.)(adzuna\.[a-z.]+|indeed\.com|linkedin\.com|glassdoor\.com|ziprecruiter\.com|simplyhired\.com|talent\.com|jooble\.org)$/i;

function isAggregatorUrl(u) {
  return AGGREGATOR_HOST_RE.test(hostOf(u));
}

const BOARD_ATS = ["greenhouse", "lever", "ashby"];

let defaultBoards = null;
function boardAdapters() {
  if (!defaultBoards) {
    defaultBoards = {
      greenhouse: require("../discovery/greenhouse.js"),
      lever: require("../discovery/lever.js"),
      ashby: require("../discovery/ashby.js"),
    };
  }
  return defaultBoards;
}

// "Acme Synthetic, Inc." → ["acmesynthetic", "acme-synthetic"]. Board slugs
// are the company name squashed or hyphenated; a first-word guess ("acme")
// is left out on purpose — it lands on unrelated companies' boards.
function guessSlugs(company) {
  const key = normalizeName(String(company || "").replace(/&/g, " and "));
  const words = key.split(" ").filter((w) => /^[a-z0-9]+$/.test(w));
  if (!words.length) return [];
  const out = [words.join("")];
  if (words.length > 1) out.push(words.join("-"));
  return out;
}

// (ats, slug) pairs to try: slugs known in companies.tsv first, then guesses
// on every supported ATS. No duplicates.
function boardCandidates(company, slugIndex) {
  const seen = new Set();
  const out = [];
  const add = (ats, slug) => {
    const k = `${ats}\t${String(slug).toLowerCase()}`;
    if (!slug || seen.has(k)) return;
    seen.add(k);
    out.push({ ats, slug });
  };
  const known = (slugIndex && slugIndex.get && slugIndex.get(normalizeName(company))) || [];
  for (const r of known) if (BOARD_ATS.includes(r.source)) add(r.source, r.slug);
  for (const slug of guessSlugs(company)) for (const ats of BOARD_ATS) add(ats, slug);
  return out;
}

const TITLE_WORDS = [
  [/\bsr\b/g, "senior"],
  [/\bjr\b/g, "junior"],
  [/\bmgr\b/g, "manager"],
  [/\bvp\b/g, "vice president"],
];

function normalizeTitle(t) {
  let s = String(t || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  for (const [re, to] of TITLE_WORDS) s = s.replace(re, to);
  return s.replace(/\s+/g, " ").trim();
}

// Same title with any "(…)" part removed: "PM (Remote)" ≈ "PM".
function bareTitle(t) {
  return normalizeTitle(String(t || "").replace(/\([^)]*\)/g, " "));
}

function titleMatches(a, b) {
  const na = normalizeTitle(a);
  if (!na) return false;
  if (na === normalizeTitle(b)) return true;
  const ba = bareTitle(a);
  return ba !== "" && ba === bareTitle(b);
}

function normLoc(l) {
  return String(l || "")
    .toLowerCase()
    .replace(/[^a-z0-9,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const REMOTE_RE = /\b(remote|anywhere|distributed)\b/;

// 2 = a city / region in common, 1 = both remote, 0 = nothing in common.
function locationScore(rowLocs, jobLocs) {
  const a = (rowLocs || []).map(normLoc).filter(Boolean);
  const b = (jobLocs || []).map(normLoc).filter(Boolean);
  const place = (l) => l.split(",")[0].trim();
  for (const x of a) {
    for (const y of b) {
      const px = place(x);
      const py = place(y);
      if (px && !REMOTE_RE.test(px) && y.includes(px)) return 2;
      if (py && !REMOTE_RE.test(py) && x.includes(py)) return 2;
    }
  }
  if (a.some((x) => REMOTE_RE.test(x)) && b.some((y) => REMOTE_RE.test(y))) return 1;
  return 0;
}

// A different concrete city ("Austin, TX" vs "New York, NY", no remote on
// the board side) means another posting with the same title.
function locationVeto(rowLocs, jobLocs) {
  const a = (rowLocs || []).map(normLoc).filter(Boolean);
  const b = (jobLocs || []).map(normLoc).filter(Boolean);
  if (!a.length || !b.length) return false;
  if (b.some((y) => REMOTE_RE.test(y))) return false;
  const concrete = (l) => l.includes(",") && !REMOTE_RE.test(l);
  if (!a.some(concrete) || !b.some(concrete)) return false;
  return locationScore(a, b) === 0;
}

// The board job that is the row's job, or null.
function pickBoardMatch(boardJobs, job) {
  const same = (boardJobs || []).filter((j) => j && j.jobId && titleMatches(job.title, j.title));
  if (!same.length) return null;
  const scored = same
    .map((j) => ({ j, score: locationScore(job.locations, j.locations) }))
    .sort((x, y) => y.score - x.score);
  const best = scored[0];
  if (best.score === 0 && locationVeto(job.locations, best.j.locations)) return null;
  return best.j;
}

// Look an aggregator row up on the company's own board.
// job: { company | companyName, title, locations? }.
// → { ok: true, url, ats, slug, jobId, via: "company_board", tried }
// | { ok: false, reason: "no_company_form", tried }
async function findCompanyForm(job, opts = {}) {
  const { fetchFn, slugIndex = null, adapters = boardAdapters() } = opts;
  if (!fetchFn) throw new Error("findCompanyForm: fetchFn is required");
  const company = (job && (job.company || job.companyName)) || "";
  const tried = [];
  if (!company || !job.title) return { ok: false, reason: "no_company_form", tried };
  const silent = { warn: () => {} };
  for (const { ats, slug } of boardCandidates(company, slugIndex)) {
    const adapter = adapters[ats];
    if (!adapter || typeof adapter.discover !== "function") continue;
    tried.push(`${ats}:${slug}`);
    let jobs = [];
    try {
      // A wrong slug answers 404; the adapter logs it and returns [].
      jobs = await adapter.discover([{ name: company, slug }], {
        fetchFn,
        logger: silent,
        concurrency: 1,
      });
    } catch {
      jobs = [];
    }
    const hit = pickBoardMatch(jobs, job);
    if (hit) {
      return {
        ok: true,
        url: formUrl(ats, slug, hit.jobId),
        ats,
        slug,
        jobId: hit.jobId,
        via: "company_board",
        tried,
      };
    }
  }
  return { ok: false, reason: "no_company_form", tried };
}

async function resolveUrl(url, opts = {}) {
  const { job = null, slugIndex = null, boardAdapters: adapters } = opts;
  const start = String(url || "").trim();
  if (job && opts.fetchFn && isSafeLivenessUrl(start).ok && isAggregatorUrl(start)) {
    const board = await findCompanyForm(job, {
      fetchFn: opts.fetchFn,
      slugIndex,
      ...(adapters ? { adapters } : {}),
    });
    if (board.ok) {
      return {
        ok: true,
        url: board.url,
        ats: board.ats,
        status: 200,
        hops: [start],
        via: "company_board",
      };
    }
    const res = await followUrl(start, opts);
    if (res.ok || res.reason === "unsafe_url") return res;
    return { ...res, reason: "no_company_form", redirect_reason: res.reason };
  }
  return followUrl(url, opts);
}

// The redirect / HTML-hop resolver (RFC 068 §1).
async function followUrl(url, opts = {}) {
  const { fetchFn, detectAts = () => null, maxHops = 4, timeoutMs = 15000 } = opts;
  const hops = [];
  let current = String(url || "").trim();
  let status = 0;

  if (!fetchFn) throw new Error("resolveUrl: fetchFn is required");

  for (let i = 0; i <= maxHops; i += 1) {
    const safe = isSafeLivenessUrl(current);
    if (!safe.ok) return { ok: false, url: current, ats: null, status, hops, reason: "unsafe_url" };

    // Already at a supported ATS: no need to fetch the page itself — the
    // adapter opens it in the browser. Liveness is checked there.
    const atsHere = detectAts(current);
    if (atsHere && !hasGhJidOnly(current)) {
      return { ok: true, url: current, ats: atsHere, status, hops };
    }

    hops.push(current);
    let res;
    try {
      res = await fetchFn(current, {
        method: "GET",
        redirect: "follow",
        timeoutMs,
        retries: 0,
        headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml" },
      });
    } catch (err) {
      return {
        ok: false,
        url: current,
        ats: null,
        status: 0,
        hops,
        reason: "fetch_error",
        error: err.message,
      };
    }
    status = (res && res.status) || 0;
    const finalUrl = (res && res.url) || current;
    if (finalUrl !== current && !hops.includes(finalUrl)) hops.push(finalUrl);

    const atsFinal = detectAts(finalUrl);
    if (atsFinal && !hasGhJidOnly(finalUrl) && !DEAD_CODES.has(status)) {
      return { ok: true, url: finalUrl, ats: atsFinal, status, hops };
    }
    if (DEAD_CODES.has(status)) {
      return { ok: false, url: finalUrl, ats: atsFinal, status, hops, reason: "dead" };
    }
    // Landed on an ATS host but not on a job (board root, `?error=true`):
    // the posting was taken down and the ATS bounced us to the listing.
    // Never scrape a board page for "some" job link.
    if (!atsFinal && ATS_HOST_RE.test(hostOf(finalUrl))) {
      return { ok: false, url: finalUrl, ats: null, status, hops, reason: "dead" };
    }
    if (BLOCKED_CODES.has(status)) {
      return { ok: false, url: finalUrl, ats: null, status, hops, reason: "blocked" };
    }

    const html = await readText(res);
    const next = findHtmlHop(finalUrl, html);
    if (!next || next === finalUrl || hops.includes(next)) {
      return { ok: false, url: finalUrl, ats: null, status, hops, reason: "no_ats" };
    }
    current = next;
  }
  return { ok: false, url: current, ats: null, status, hops, reason: "no_ats" };
}

// A company page carrying `gh_jid` is not itself an ATS form, even when
// detectAts is permissive; the explicit check keeps the embed path honest.
function hasGhJidOnly(u) {
  try {
    const parsed = new URL(u);
    return parsed.searchParams.has("gh_jid") && !/greenhouse\.io$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

// Browser fallback for aggregators that block plain fetch (Adzuna answers
// 403 / a bot page to non-browser clients). Navigates in a real page, lets
// JS redirects run, then reads the final URL or an outbound ATS link.
// Returns the same shape as resolveUrl.
async function resolveViaPage(
  page,
  url,
  { detectAts = () => null, settleMs = 4000, timeoutMs = 30000 } = {}
) {
  const safe = isSafeLivenessUrl(url);
  if (!safe.ok) return { ok: false, url, ats: null, status: 0, hops: [url], reason: "unsafe_url" };
  let status = 0;
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    status = (res && res.status()) || 0;
  } catch (err) {
    return {
      ok: false,
      url,
      ats: null,
      status: 0,
      hops: [url],
      reason: "fetch_error",
      error: err.message,
    };
  }
  await new Promise((r) => setTimeout(r, settleMs));
  const finalUrl = page.url();
  const hops = finalUrl !== url ? [url, finalUrl] : [url];
  const atsFinal = detectAts(finalUrl);
  if (atsFinal) return { ok: true, url: finalUrl, ats: atsFinal, status, hops };
  let html = "";
  try {
    html = await page.content();
  } catch {
    html = "";
  }
  // A 404/410 that stayed on the same page (or shows a not-found page) is a
  // gone posting. Aggregators answer 404 on the land URL even for live ads
  // and then redirect in-page (Adzuna /land/ad -> /details), so a 404 that
  // moved to another path is not treated as dead.
  if (GONE_CODES.has(status)) {
    const samePath = pathOf(finalUrl) === pathOf(url);
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
    if (samePath || /not found|no longer (available|exists)/i.test((title && title[1]) || "")) {
      return { ok: false, url: finalUrl, ats: null, status, hops, reason: "dead" };
    }
  }
  const next = findHtmlHop(finalUrl, html);
  if (next && detectAts(next))
    return { ok: true, url: next, ats: detectAts(next), status, hops: hops.concat(next) };
  if (
    BLOCKED_CODES.has(status) ||
    /access denied|are you a robot|verify you are human/i.test(html.slice(0, 5000))
  ) {
    return { ok: false, url: finalUrl, ats: null, status, hops, reason: "blocked" };
  }
  // Landed on an employer page that is not an ATS: hand back the URL so the
  // caller can run the fetch resolver on it (gh_jid embeds etc.).
  return { ok: false, url: next || finalUrl, ats: null, status, hops, reason: "no_ats" };
}

const GONE_CODES = new Set([404, 410]);

function pathOf(u) {
  try {
    return new URL(u).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

module.exports = {
  resolveUrl,
  resolveViaPage,
  findHtmlHop,
  greenhouseFromEmbed,
  hostOf,
  isAggregatorUrl,
  findCompanyForm,
  guessSlugs,
  boardCandidates,
  normalizeTitle,
  titleMatches,
  pickBoardMatch,
};
