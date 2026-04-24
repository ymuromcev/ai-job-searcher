// Indeed browser-ingest adapter.
//
// Indeed has no public API; live scraping is blocked by Cloudflare + TOS risks.
// The supported path is: Claude opens indeed.com in a browser session via the
// job-pipeline skill (Stage 6), extracts the structured fields from each
// viewjob card, and writes them to a staging JSON file. This adapter then
// reads that staging file and normalizes entries into the shared pool.
//
// Target shape: { name, slug, ingestFile, keyword?, location? }
//   ingestFile — absolute or cwd-relative path to the JSON file produced by
//                the skill's scan step. Required.
//   keyword/location — informational; recorded in rawExtra for traceability.
//
// Staging file format: an array of objects (browser-extracted):
//   [{
//     jk:        "abc123",               // Indeed's internal job key (required)
//     title:     "Diagnostic Sonographer",
//     company:   "Sutter Health",
//     location:  "Sacramento, CA",
//     url:       "https://www.indeed.com/viewjob?jk=abc123",  // optional
//     postedAt:  "2026-04-15"            // optional ISO date
//   }, ...]
//
// The adapter never hits the network.

const fs = require("fs");
const path = require("path");

const { assertJob } = require("./_types.js");
const { sanitizeText, parseIsoDate, dedupeLocations } = require("./_normalize.js");

const SOURCE = "indeed";
const VIEWJOB_BASE = "https://www.indeed.com/viewjob";

function resolveIngestPath(ingestFile) {
  if (!ingestFile || typeof ingestFile !== "string") {
    throw new Error("target.ingestFile must be a string path");
  }
  return path.isAbsolute(ingestFile) ? ingestFile : path.resolve(process.cwd(), ingestFile);
}

function readIngest(ingestPath) {
  if (!fs.existsSync(ingestPath)) {
    throw new Error(`ingest file not found: ${ingestPath}`);
  }
  const raw = fs.readFileSync(ingestPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`ingest file is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("ingest file must contain an array of job entries");
  }
  return parsed;
}

function mapEntry(target, entry) {
  const jk = sanitizeText(entry && entry.jk);
  if (!jk) {
    throw new Error("entry missing required field: jk");
  }
  const title = sanitizeText(entry.title);
  const companyName = sanitizeText(entry.company) || target.name;
  const url = entry.url
    ? String(entry.url)
    : `${VIEWJOB_BASE}?jk=${encodeURIComponent(jk)}`;
  const locations = dedupeLocations([entry.location]);
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName,
    jobId: jk,
    title,
    url,
    locations,
    team: null,
    postedAt: parseIsoDate(entry.postedAt),
    rawExtra: {
      keyword: target.keyword || null,
      ingestedFrom: target.ingestFile || null,
    },
  };
  assertJob(job);
  return job;
}

async function discover(targets, ctx = {}) {
  const logger = (ctx && ctx.logger) || { warn: () => {} };
  const out = [];
  for (const target of targets || []) {
    if (!target || !target.ingestFile) continue;
    let entries;
    try {
      const ingestPath = resolveIngestPath(target.ingestFile);
      entries = readIngest(ingestPath);
    } catch (err) {
      logger.warn(`[${SOURCE}] ${target.slug || target.name}: ${err.message}`);
      continue;
    }
    for (const entry of entries) {
      try {
        out.push(mapEntry(target, entry));
      } catch (err) {
        logger.warn(
          `[${SOURCE}] ${target.slug || target.name}: skipped entry — ${err.message}`
        );
      }
    }
  }
  return out;
}

module.exports = { source: SOURCE, discover };
