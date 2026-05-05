// Per-profile pipeline file: profiles/<id>/applications.tsv.
//
// Schema (header required), v3 (added 2026-05-03 for G-5 — restores prototype
// parity; prototype `job_registry.tsv` had `location` as column 10):
//   key <TAB> source <TAB> jobId <TAB> companyName <TAB> title <TAB> url
//             <TAB> location <TAB> status <TAB> notion_page_id
//             <TAB> resume_ver <TAB> cl_key
//             <TAB> salary_min <TAB> salary_max <TAB> cl_path
//             <TAB> createdAt <TAB> updatedAt
//
// `key` = "<source>:<jobId>" — primary, used for dedup against the master pool.
// New entries default to status="To Apply", notion_page_id="" until sync runs.
// (Notion DBs use the 8-status set: To Apply / Applied / Interview / Offer /
// Rejected / Closed / No Response / Archived. There is no "Inbox" status.)
// `location` carries the first non-empty entry from the discovery `locations`
// array; "" when the source didn't provide one.
//
// Backward compat:
//   v2 (15 cols, 2026-04 — Stage 13 added salary_min/max/cl_path) → auto-upgrade
//     with location="" on read. save() always writes v3.
//   v1 (12 cols, original) → auto-upgrade with empty values for the 4 new cols.

const fs = require("fs");
const path = require("path");

const { fuzzyKey } = require("./dedup.js");

const HEADER = [
  "key",
  "source",
  "jobId",
  "companyName",
  "title",
  "url",
  "location",
  "status",
  "notion_page_id",
  "resume_ver",
  "cl_key",
  "salary_min",
  "salary_max",
  "cl_path",
  "createdAt",
  "updatedAt",
];

const HEADER_V2 = [
  "key",
  "source",
  "jobId",
  "companyName",
  "title",
  "url",
  "status",
  "notion_page_id",
  "resume_ver",
  "cl_key",
  "salary_min",
  "salary_max",
  "cl_path",
  "createdAt",
  "updatedAt",
];

const HEADER_V1 = [
  "key",
  "source",
  "jobId",
  "companyName",
  "title",
  "url",
  "status",
  "notion_page_id",
  "resume_ver",
  "cl_key",
  "createdAt",
  "updatedAt",
];

function escapeField(v) {
  if (v === undefined || v === null) return "";
  return String(v).replace(/[\t\r\n]/g, " ");
}

function makeKey(source, jobId) {
  return `${String(source).toLowerCase()}:${jobId}`;
}

function rowFor(app) {
  return [
    escapeField(app.key),
    escapeField(app.source),
    escapeField(app.jobId),
    escapeField(app.companyName),
    escapeField(app.title),
    escapeField(app.url),
    escapeField(app.location || ""),
    escapeField(app.status),
    escapeField(app.notion_page_id || ""),
    escapeField(app.resume_ver || ""),
    escapeField(app.cl_key || ""),
    escapeField(app.salary_min || ""),
    escapeField(app.salary_max || ""),
    escapeField(app.cl_path || ""),
    escapeField(app.createdAt),
    escapeField(app.updatedAt),
  ].join("\t");
}

function rowToAppV3(parts, lineNo) {
  if (parts.length < HEADER.length) {
    throw new Error(
      `applications.tsv line ${lineNo}: expected ${HEADER.length} cols, got ${parts.length}`
    );
  }
  const [
    key,
    source,
    jobId,
    companyName,
    title,
    url,
    location,
    status,
    notion_page_id,
    resume_ver,
    cl_key,
    salary_min,
    salary_max,
    cl_path,
    createdAt,
    updatedAt,
  ] = parts;
  return {
    key,
    source,
    jobId,
    companyName,
    title,
    url,
    location: location || "",
    status,
    notion_page_id: notion_page_id || "",
    resume_ver: resume_ver || "",
    cl_key: cl_key || "",
    salary_min: salary_min || "",
    salary_max: salary_max || "",
    cl_path: cl_path || "",
    createdAt,
    updatedAt,
  };
}

function rowToAppV2(parts, lineNo) {
  if (parts.length < HEADER_V2.length) {
    throw new Error(
      `applications.tsv line ${lineNo}: expected ${HEADER_V2.length} cols, got ${parts.length}`
    );
  }
  const [
    key,
    source,
    jobId,
    companyName,
    title,
    url,
    status,
    notion_page_id,
    resume_ver,
    cl_key,
    salary_min,
    salary_max,
    cl_path,
    createdAt,
    updatedAt,
  ] = parts;
  return {
    key,
    source,
    jobId,
    companyName,
    title,
    url,
    location: "",
    status,
    notion_page_id: notion_page_id || "",
    resume_ver: resume_ver || "",
    cl_key: cl_key || "",
    salary_min: salary_min || "",
    salary_max: salary_max || "",
    cl_path: cl_path || "",
    createdAt,
    updatedAt,
  };
}

function rowToAppV1(parts, lineNo) {
  if (parts.length < HEADER_V1.length) {
    throw new Error(
      `applications.tsv line ${lineNo}: expected ${HEADER_V1.length} cols, got ${parts.length}`
    );
  }
  const [
    key,
    source,
    jobId,
    companyName,
    title,
    url,
    status,
    notion_page_id,
    resume_ver,
    cl_key,
    createdAt,
    updatedAt,
  ] = parts;
  return {
    key,
    source,
    jobId,
    companyName,
    title,
    url,
    location: "",
    status,
    notion_page_id: notion_page_id || "",
    resume_ver: resume_ver || "",
    cl_key: cl_key || "",
    salary_min: "",
    salary_max: "",
    cl_path: "",
    createdAt,
    updatedAt,
  };
}

function matchHeader(headerCols, expected) {
  return (
    headerCols.length === expected.length &&
    expected.every((c, i) => c === headerCols[i])
  );
}

function load(filePath) {
  if (!fs.existsSync(filePath)) return { apps: [], path: filePath };
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return { apps: [], path: filePath };
  const headerCols = lines[0].split("\t");

  const isV3 = matchHeader(headerCols, HEADER);
  const isV2 = !isV3 && matchHeader(headerCols, HEADER_V2);
  const isV1 = !isV3 && !isV2 && matchHeader(headerCols, HEADER_V1);

  if (!isV3 && !isV2 && !isV1) {
    throw new Error(
      `applications.tsv header mismatch: expected v3 [${HEADER.join(", ")}], v2 [${HEADER_V2.join(", ")}] or v1 [${HEADER_V1.join(", ")}], got [${headerCols.join(", ")}]`
    );
  }

  const apps = [];
  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i].split("\t");
    if (isV3) apps.push(rowToAppV3(parts, i + 1));
    else if (isV2) apps.push(rowToAppV2(parts, i + 1));
    else apps.push(rowToAppV1(parts, i + 1));
  }
  return { apps, path: filePath, schemaVersion: isV3 ? 3 : isV2 ? 2 : 1 };
}

function save(filePath, apps) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [HEADER.join("\t")];
  for (const a of apps) lines.push(rowFor(a));
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, lines.join("\n") + "\n");
  fs.renameSync(tmp, filePath);
  return { path: filePath, count: apps.length };
}

// G-4: fuzzy-dedup against existing apps catches the same role posted on a
// different ATS than the prior scan picked up (e.g. company migrated GH→Lever,
// or the pool/applications drifted post-migration). Without this, `appendNew`
// only deduped on exact `source:jobId` and a Lever variant of an already-tracked
// Greenhouse role would silently land as a duplicate row in applications.tsv.
function appendNew(
  existing,
  jobs,
  { now = new Date().toISOString(), defaultStatus = "To Apply" } = {}
) {
  const seen = new Set(existing.map((a) => a.key));
  const seenFuzzy = new Set();
  for (const a of existing) {
    const fk = fuzzyKey(a);
    if (fk) seenFuzzy.add(fk);
  }
  const fresh = [];
  const fuzzyDuplicates = [];
  for (const job of jobs) {
    const key = makeKey(job.source, job.jobId);
    if (seen.has(key)) continue;
    const fk = fuzzyKey(job);
    if (fk && seenFuzzy.has(fk)) {
      fuzzyDuplicates.push({ key, fuzzyKey: fk });
      continue;
    }
    seen.add(key);
    if (fk) seenFuzzy.add(fk);
    // Discovery `NormalizedJob.locations` is an array; the first entry is
    // canonical. Fall back to "" when the source didn't provide one.
    const location =
      Array.isArray(job.locations) && job.locations.length > 0
        ? String(job.locations[0])
        : "";
    fresh.push({
      key,
      source: job.source,
      jobId: job.jobId,
      companyName: job.companyName,
      title: job.title,
      url: job.url,
      location,
      status: defaultStatus,
      notion_page_id: "",
      resume_ver: "",
      cl_key: "",
      salary_min: "",
      salary_max: "",
      cl_path: "",
      createdAt: now,
      updatedAt: now,
    });
  }
  return { apps: existing.concat(fresh), fresh, fuzzyDuplicates };
}

module.exports = { load, save, appendNew, makeKey, HEADER, HEADER_V1, HEADER_V2 };
