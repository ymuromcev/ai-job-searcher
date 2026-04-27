// Per-profile pipeline file: profiles/<id>/applications.tsv.
//
// Schema (header required), v2:
//   key <TAB> source <TAB> jobId <TAB> companyName <TAB> title <TAB> url
//             <TAB> status <TAB> notion_page_id <TAB> resume_ver <TAB> cl_key
//             <TAB> salary_min <TAB> salary_max <TAB> cl_path
//             <TAB> createdAt <TAB> updatedAt
//
// `key` = "<source>:<jobId>" — primary, used for dedup against the master pool.
// New entries default to status="To Apply", notion_page_id="" until sync runs.
// (Notion DBs use the 8-status set: To Apply / Applied / Interview / Offer /
// Rejected / Closed / No Response / Archived. There is no "Inbox" status.)
// Backward compat: v1 files (12 cols) are auto-upgraded on load with empty
// values for the three new columns — save() always writes v2.

const fs = require("fs");
const path = require("path");

const HEADER = [
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

function rowToAppV2(parts, lineNo) {
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

  const isV2 = matchHeader(headerCols, HEADER);
  const isV1 = !isV2 && matchHeader(headerCols, HEADER_V1);

  if (!isV2 && !isV1) {
    throw new Error(
      `applications.tsv header mismatch: expected [${HEADER.join(", ")}] or v1 [${HEADER_V1.join(", ")}], got [${headerCols.join(", ")}]`
    );
  }

  const apps = [];
  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i].split("\t");
    apps.push(isV2 ? rowToAppV2(parts, i + 1) : rowToAppV1(parts, i + 1));
  }
  return { apps, path: filePath, schemaVersion: isV2 ? 2 : 1 };
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

function appendNew(existing, jobs, { now = new Date().toISOString(), defaultStatus = "To Apply" } = {}) {
  const seen = new Set(existing.map((a) => a.key));
  const fresh = [];
  for (const job of jobs) {
    const key = makeKey(job.source, job.jobId);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push({
      key,
      source: job.source,
      jobId: job.jobId,
      companyName: job.companyName,
      title: job.title,
      url: job.url,
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
  return { apps: existing.concat(fresh), fresh };
}

module.exports = { load, save, appendNew, makeKey, HEADER, HEADER_V1 };
