// HTTP helper with timeout + exponential backoff retry.
// Adapters never call `fetch` directly; they take `fetchFn` from ctx so tests
// can stub the network without monkey-patching globals.
//
// defaultFetch(url, opts) -> { ok, status, headers, text(), json() }
//   opts: { method, headers, body, timeoutMs, retries, backoffMs, signal }

async function defaultFetch(url, opts = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 20000,
    retries = 2,
    backoffMs = 500,
    signal,
    redirect,
  } = opts;

  const mergedHeaders = {
    "User-Agent": "AIJobSearcher/0.1 (+https://github.com/ymuromcev/ai-job-searcher)",
    "Accept-Encoding": "gzip, deflate",
    ...headers,
  };

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
    let onAbort;
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw signal.reason || new Error("aborted");
      }
      onAbort = () => ctrl.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const fetchOpts = { method, headers: mergedHeaders, body, signal: ctrl.signal };
      if (redirect) fetchOpts.redirect = redirect;
      const res = await fetch(url, fetchOpts);
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      // Retry only on 5xx / 429 — client 4xx errors are non-retriable.
      if (res.status >= 500 || res.status === 429) {
        if (attempt < retries) {
          await drainBody(res);
          await sleep(backoffMs * Math.pow(2, attempt));
          continue;
        }
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      lastErr = err;
      if (signal && signal.aborted) throw err;
      if (attempt < retries) {
        await sleep(backoffMs * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("fetch failed");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function drainBody(res) {
  try {
    if (res.body && typeof res.body.cancel === "function") {
      await res.body.cancel();
    } else if (typeof res.arrayBuffer === "function") {
      await res.arrayBuffer();
    }
  } catch {
    // Body drain errors are not actionable — connection will be closed anyway.
  }
}

module.exports = { defaultFetch };
