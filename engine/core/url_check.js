// Batch URL liveness checker for the prepare stage.
//
// HEAD first → GET fallback when HEAD returns 4xx/5xx/error.
// Board-root detection: 200 OK that redirects to a generic careers page = dead.
// SSRF guard: blocks requests to private/loopback IPs and schemes.
//
// Exports:
//   checkOne(row, fetchFn, opts) → Promise<CheckResult>
//   checkAll(rows, fetchFn, opts) → Promise<CheckResult[]>
//   isSafeLivenessUrl(url) → { ok, reason? }
//
// CheckResult shape:
//   { url, key?, ...passthrough, status, alive, finalUrl, boardRoot?, error?, blocked? }
//
// 403 is included in ALIVE_CODES: Greenhouse/Lever often return 403 to HEAD
// requests from bots — the job listing still exists on the board.

const ALIVE_CODES = new Set([200, 201, 202, 204, 301, 302, 303, 307, 308, 403]);

// Patterns indicating a redirect landed on a generic board root page (job
// was pulled but the ATS still returns 200 for the careers-home URL).
const BOARD_ROOT_RE = [
  /greenhouse\.io\/[^/]+\/?(?:\?|$)/i,      // /slug or /slug/
  /careers\.airbnb\.com\/positions\/?$/i,
  /careers\.airbnb\.com\/positions\/\?/i,
  /\/jobs\/?$/i,
  /\/careers\/?$/i,
  /\/search\/?/i,
];

// --- SSRF guard (inlined — no dependency on engine/commands/validate.js) -----

function ipv4Octets(host) {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return null;
  const oct = host.split(".").map(Number);
  if (oct.some((n) => n < 0 || n > 255)) return null;
  return oct;
}

function isPrivateIpv4(host) {
  const o = ipv4Octets(host);
  if (!o) return false;
  const [a, b] = o;
  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 127) return true;                        // loopback
  if (a === 169 && b === 254) return true;           // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12
  if (a === 192 && b === 168) return true;           // 192.168/16
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 255 && b === 255) return true;           // broadcast
  return false;
}

function isPrivateIpv6(host) {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (h.startsWith("fe80:") || h.startsWith("fe80::")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true;        // unique local
  return false;
}

function isSafeLivenessUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `blocked scheme ${u.protocol}` };
  }
  let host = u.hostname.toLowerCase();
  // WHATWG URL keeps IPv6 brackets — strip them for the checks below.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) return { ok: false, reason: "empty host" };
  if (ipv4Octets(host) && isPrivateIpv4(host)) {
    return { ok: false, reason: `blocked private/loopback host ${host}` };
  }
  if (host.includes(":") && isPrivateIpv6(host)) {
    return { ok: false, reason: `blocked private/loopback host ${host}` };
  }
  if (host === "localhost" || host === "localhost.localdomain") {
    return { ok: false, reason: `blocked loopback host ${host}` };
  }
  return { ok: true };
}

// --- Board-root detection ---------------------------------------------------

function looksLikeBoardRoot(finalUrl, originalUrl) {
  if (!finalUrl || finalUrl === originalUrl) return false;
  // If the original URL's job-id segment appears in the final URL, the redirect
  // preserved the job — not a board-root redirect.
  const origMatch = originalUrl.match(/\/([0-9a-f-]{4,})\/?$/i);
  const origId = origMatch ? origMatch[1] : null;
  if (origId && finalUrl.includes(origId)) return false;
  return BOARD_ROOT_RE.some((re) => re.test(finalUrl));
}

// --- Core check logic -------------------------------------------------------

async function checkOne(row, fetchFn, opts = {}) {
  const { timeoutMs = 12000 } = opts;
  const { url } = row;

  const safe = isSafeLivenessUrl(url);
  if (!safe.ok) {
    return { ...row, status: 0, alive: false, error: safe.reason, blocked: true };
  }

  let status = 0;
  let finalUrl = url;
  let error = null;

  // HEAD first: minimal data transfer, sufficient for liveness.
  try {
    const res = await fetchFn(url, { method: "HEAD", timeoutMs, retries: 0, redirect: "manual" });
    status = res.status || 0;
    // When redirect: "manual", res.url stays at the original; use it as-is.
    finalUrl = res.url || url;
  } catch (err) {
    error = err.message;
    status = 0;
  }

  // GET fallback when HEAD indicates failure (some ATS return 403/405 on HEAD).
  if (status >= 400 || status === 0) {
    try {
      const res = await fetchFn(url, { method: "GET", timeoutMs, retries: 0, redirect: "follow" });
      const gs = res.status || 0;
      // Use GET result if it indicates a live URL (alive codes) while HEAD did not,
      // or if HEAD completely failed (status 0) and GET gave any response.
      if (ALIVE_CODES.has(gs) || (status === 0 && gs > 0)) {
        status = gs;
        // redirect: "follow" → res.url is the final destination.
        finalUrl = res.url || url;
        error = null;
      }
    } catch (err) {
      if (status === 0) error = err.message;
    }
  }

  const inAliveCodes = ALIVE_CODES.has(status);
  const boardRoot = inAliveCodes && looksLikeBoardRoot(finalUrl, url);
  const alive = inAliveCodes && !boardRoot;

  const result = { ...row, status, alive, finalUrl };
  if (boardRoot) result.boardRoot = true;
  if (error) result.error = error;
  return result;
}

async function checkAll(rows, fetchFn, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const { concurrency = 12 } = opts;
  const results = new Array(rows.length);
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const idx = i++;
      results[idx] = await checkOne(rows[idx], fetchFn, opts);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, rows.length) }, () => worker())
  );
  return results;
}

module.exports = { checkOne, checkAll, isSafeLivenessUrl };
