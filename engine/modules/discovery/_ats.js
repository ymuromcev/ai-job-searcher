// Shared helpers for ATS adapters (greenhouse / lever / ashby / smartrecruiters).
// Adapters pass a normalized mapper; this module handles fetch + error containment,
// so a single company failure never kills a scan across 200+ targets.

const { defaultFetch } = require("./_http.js");

async function fetchJson(fetchFn, url, opts = {}) {
  const res = await fetchFn(url, opts);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Runs async fn per target with bounded concurrency (default 4, hard-capped
// at 8 to stay polite on public ATS endpoints). Errors per-target are captured
// (logged via ctx.logger) and do NOT abort the batch.
async function runTargets(targets, ctx, fn) {
  if (!Array.isArray(targets) || targets.length === 0) return [];
  const requested = ctx.concurrency || 4;
  if (requested > 8 && ctx.logger && ctx.logger.warn) {
    ctx.logger.warn(`[${ctx.source || "adapter"}] concurrency ${requested} capped at 8`);
  }
  const concurrency = Math.max(1, Math.min(8, requested));
  const logger = ctx.logger || { warn: () => {} };
  const out = [];
  let i = 0;
  async function worker() {
    while (i < targets.length) {
      const idx = i;
      i += 1;
      const target = targets[idx];
      try {
        const jobs = await fn(target);
        if (Array.isArray(jobs)) out.push(...jobs);
      } catch (err) {
        logger.warn(`[${ctx.source || "adapter"}] ${target && target.slug}: ${err.message}`);
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

function makeCtx(ctx) {
  return {
    fetchFn: (ctx && ctx.fetchFn) || defaultFetch,
    logger: (ctx && ctx.logger) || { warn: () => {} },
    concurrency: ctx && ctx.concurrency,
    secrets: (ctx && ctx.secrets) || {},
    signal: ctx && ctx.signal,
    source: ctx && ctx.source,
  };
}

module.exports = { fetchJson, runTargets, makeCtx };
