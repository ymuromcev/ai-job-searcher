// Apply adapter registry (RFC 068 §2).
//
// Each adapter implements:
//   detect(url) → boolean
//   tenantKey(url) → "<ats>:<board slug>" (per-tenant concurrency key)
//   jobRef(url) → { slug, jobId } | null (for JD cache lookups)
//   normalizeUrl(url) → URL of the application form itself
//   open(page, url) → { ok } | { ok: false, reason }
//   readSchema(page) → [{ id, label, type, required, options }]
//   fill(page, values) → { filled, errors }
//   checkFilled(page) → { missing, state }       (pre-submit check)
//   submit(page) → { ok, evidence } | { ok: false, reason, evidence }
//
// Selectors live only inside the adapters.

const greenhouse = require("./greenhouse.js");
const lever = require("./lever.js");
const ashby = require("./ashby.js");

const ADAPTERS = Object.freeze({ greenhouse, lever, ashby });

function detectAts(url) {
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    if (adapter.detect(url)) return name;
  }
  return null;
}

function getAdapter(name) {
  return ADAPTERS[name] || null;
}

module.exports = { ADAPTERS, detectAts, getAdapter };
