#!/usr/bin/env node
// One-time seed script: parses the legacy Job Search/find_jobs.js targets
// (read as text, no code execution) and writes them into data/companies.tsv.
//
// Usage:
//   node engine/bin/seed_companies.js [--legacy <path>] [--out <path>] [--dry-run]
// Defaults:
//   --legacy ../Job Search/find_jobs.js (resolved from this file)
//   --out    data/companies.tsv         (resolved from project root)
//
// The legacy file is treated as untrusted text — we only run regex extraction.

const fs = require("fs");
const path = require("path");
const { parseArgs } = require("util");

const companies = require("../core/companies.js");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_LEGACY = path.resolve(PROJECT_ROOT, "..", "Job Search", "find_jobs.js");
const DEFAULT_OUT = path.resolve(PROJECT_ROOT, "data", "companies.tsv");

const TARGET_RE = /\{\s*name:\s*"([^"]+)"\s*,\s*(?:platform:\s*"([^"]+)"\s*,\s*)?slug:\s*"([^"]+)"(?:\s*,\s*dc:\s*"([^"]+)")?(?:\s*,\s*site:\s*"([^"]+)")?\s*\}/g;

function extractFromGreenhouseLeverBlock(text) {
  // Lines like { name: "Affirm", platform: "greenhouse", slug: "affirm" }
  const out = [];
  for (const m of text.matchAll(TARGET_RE)) {
    const [, name, platform, slug, dc, site] = m;
    if (!platform) continue; // ASHBY_COMPANIES entries have no `platform:` — handled below
    const extra = {};
    if (dc) extra.dc = dc;
    if (site) extra.site = site;
    out.push({
      name,
      source: platform.toLowerCase(),
      slug,
      extra: Object.keys(extra).length ? extra : null,
    });
  }
  return out;
}

const ASHBY_RE = /ASHBY_COMPANIES\s*=\s*\[([\s\S]*?)\];/m;
const ASHBY_ITEM_RE = /\{\s*name:\s*"([^"]+)"\s*,\s*slug:\s*"([^"]+)"\s*\}/g;

function extractFromAshbyArray(text) {
  const block = text.match(ASHBY_RE);
  if (!block) return [];
  const out = [];
  for (const m of block[1].matchAll(ASHBY_ITEM_RE)) {
    out.push({ name: m[1], source: "ashby", slug: m[2], extra: null });
  }
  return out;
}

function extract(text) {
  const main = extractFromGreenhouseLeverBlock(text);
  const ashby = extractFromAshbyArray(text);
  // Dedupe by (source, slug) — earlier wins.
  const seen = new Set();
  const out = [];
  for (const r of [...main, ...ashby]) {
    const k = `${r.source}\t${r.slug}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function summarize(rows) {
  const bySource = {};
  for (const r of rows) bySource[r.source] = (bySource[r.source] || 0) + 1;
  return bySource;
}

function main() {
  const { values } = parseArgs({
    options: {
      legacy: { type: "string", default: DEFAULT_LEGACY },
      out: { type: "string", default: DEFAULT_OUT },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });

  if (!fs.existsSync(values.legacy)) {
    console.error(`error: legacy file not found: ${values.legacy}`);
    process.exit(1);
  }
  const text = fs.readFileSync(values.legacy, "utf8");
  const incoming = extract(text);
  if (!incoming.length) {
    console.error("error: no targets extracted — legacy file shape changed?");
    process.exit(1);
  }

  const existing = companies.load(values.out).rows;
  const { rows, added, updated } = companies.merge(existing, incoming);

  const summary = summarize(incoming);
  const summaryStr = Object.entries(summary)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

  console.log(`extracted ${incoming.length} targets from ${values.legacy}`);
  console.log(`  by source: ${summaryStr}`);
  console.log(`existing pool: ${existing.length} rows`);
  console.log(`merge: +${added} new, ~${updated} updated → ${rows.length} total`);

  if (values["dry-run"]) {
    console.log("(dry-run — no file written)");
    return;
  }

  const result = companies.save(values.out, rows);
  console.log(`wrote ${result.count} rows to ${result.path}`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { extract };
