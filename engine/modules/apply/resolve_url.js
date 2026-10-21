// Resolve a job URL to the real ATS application URL (RFC 068 §1).
//
// Aggregator / tracker links (Adzuna, newsletter short links such as grnh.se
// and lnkd.in) redirect — sometimes over several hops, sometimes through an
// HTML page with a meta refresh or a JS `location` assignment — to the
// employer's ATS. Company career pages that embed Greenhouse carry a
// `gh_jid=<id>` query and reference the board slug in their HTML.
//
// `resolveUrl(url, { fetchFn, detectAts, maxHops })` → {
//   ok: boolean,
//   url: string,          // final URL (the ATS URL when found)
//   ats: string | null,   // adapter name when the final URL is a supported ATS
//   status: number,       // last HTTP status seen
//   hops: string[],       // URLs visited
//   reason?: string,      // "dead" | "blocked" | "fetch_error" | "unsafe_url" | "no_ats"
// }
//
// fetchFn has the engine `defaultFetch` shape: (url, {method, redirect,
// timeoutMs, retries, headers}) → Response-like {status, url, text()}.
// Redirects are followed by fetch itself (`redirect: "follow"`); this module
// adds the HTML-level hops fetch cannot see.

const { isSafeLivenessUrl } = require("../../core/url_check.js");

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

async function resolveUrl(url, opts = {}) {
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

function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

module.exports = { resolveUrl, findHtmlHop, greenhouseFromEmbed, hostOf };
