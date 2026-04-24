// Scan orchestrator — pure function.
//
// Takes a set of targets grouped by `source` and a list of adapters, runs them
// with Promise.allSettled (one failing adapter never blocks others), dedups
// against the existing shared pool and returns both the list of fresh jobs
// and the updated full pool (ready to be written by the CLI to data/jobs.tsv).
//
// No filesystem or network is used here. CLI wires in adapters + loads the
// existing pool + persists output. This keeps scan itself easy to test.

const { dedupeAgainst, dedupeJobs } = require("./dedup.js");

function validateAdapter(adapter, sourceKey) {
  if (!adapter || typeof adapter.discover !== "function" || typeof adapter.source !== "string") {
    throw new Error(`adapter for "${sourceKey}" must export { source, discover }`);
  }
  if (adapter.source !== sourceKey) {
    throw new Error(
      `adapter source mismatch: key "${sourceKey}" vs adapter.source "${adapter.source}"`
    );
  }
}

function indexAdapters(adapters) {
  // Accept either { source: adapter } map or array of adapter modules.
  if (Array.isArray(adapters)) {
    const map = {};
    for (const a of adapters) {
      if (a && typeof a.source === "string") map[a.source] = a;
    }
    return map;
  }
  return adapters || {};
}

async function scan({ targetsBySource, adapters, existing = [], ctx = {} }) {
  if (!targetsBySource || typeof targetsBySource !== "object") {
    throw new Error("targetsBySource must be an object keyed by adapter source");
  }
  const adapterMap = indexAdapters(adapters);
  const perSource = {};
  const errors = [];

  const sources = Object.keys(targetsBySource);
  const invocations = sources.map(async (sourceKey) => {
    const targets = targetsBySource[sourceKey] || [];
    if (!Array.isArray(targets) || targets.length === 0) {
      perSource[sourceKey] = { jobs: [], error: null };
      return;
    }
    const adapter = adapterMap[sourceKey];
    if (!adapter) {
      const err = new Error(`no adapter registered for source "${sourceKey}"`);
      perSource[sourceKey] = { jobs: [], error: err.message };
      errors.push({ source: sourceKey, message: err.message });
      return;
    }
    try {
      validateAdapter(adapter, sourceKey);
      const jobs = await adapter.discover(targets, ctx);
      perSource[sourceKey] = { jobs: Array.isArray(jobs) ? jobs : [], error: null };
    } catch (err) {
      perSource[sourceKey] = { jobs: [], error: err.message };
      errors.push({ source: sourceKey, message: err.message });
    }
  });
  await Promise.allSettled(invocations);

  const collected = [];
  for (const key of sources) collected.push(...(perSource[key].jobs || []));
  // Within-batch dedupe (one ATS key appearing twice in the same run), then
  // cross-run dedupe against the existing pool. `fresh` is exactly the set of
  // jobs we append, so the new pool is just existing + fresh.
  const batch = dedupeJobs(collected);
  const fresh = dedupeAgainst(existing, batch);
  const pool = existing.concat(fresh);

  const summary = {};
  for (const key of sources) {
    summary[key] = {
      total: perSource[key].jobs.length,
      error: perSource[key].error,
    };
  }

  return {
    fresh,
    pool,
    summary,
    errors,
  };
}

module.exports = { scan, indexAdapters };
