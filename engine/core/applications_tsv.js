// Per-profile pipeline file: profiles/<id>/applications.tsv.
//
// Schema (header required), v4 (added 2026-05-05 for BL-9 — persist Claude's
// fit verdict on each row so subsequent prepare runs skip already-evaluated
// jobs instead of re-paying the SKILL cost):
//   key <TAB> source <TAB> jobId <TAB> companyName <TAB> title <TAB> url
//             <TAB> location <TAB> status <TAB> notion_page_id
//             <TAB> resume_ver <TAB> cl_key
//             <TAB> salary_min <TAB> salary_max <TAB> cl_path
//             <TAB> createdAt <TAB> updatedAt
//             <TAB> fit_score <TAB> fit_rationale <TAB> fit_evaluated_at
//             <TAB> skip_reason
//
// `key` = "<source>:<jobId>" — primary, used for dedup against the master pool.
// New entries default to status="Inbox" (post-RFC 014, 2026-05-04). "Inbox" =
// fresh-after-scan, no URL liveness / fit / CL yet — TSV-only state. `prepare
// --phase commit` transitions Inbox → To Apply (ready to submit) or Inbox →
// Archived (filter reject). The TSV-level 9-status set: Inbox / To Apply /
// Applied / Interview / Offer / Rejected / Closed / No Response / Archived.
// Notion DBs keep the 8-status set (Inbox is local-only).
// `location` carries the first non-empty entry from the discovery `locations`
// array; "" when the source didn't provide one.
//
// v4 fit columns are written by `prepare --phase commit` from the SKILL's
// results.json (Step 10):
//   `fit_score`        — "Strong" | "Medium" | "Weak" | ""
//   `fit_rationale`    — short free-text rationale (≤ ~200 chars typical)
//   `fit_evaluated_at` — ISO timestamp of the SKILL run that wrote it
//   `skip_reason`      — when decision="skip": "weak_fit" | "duplicate" | ""
//                        (only SKILL-level reasons; engine-level skips like
//                        company_cap / title_blocklist are recomputed each run
//                        and not persisted)
// Engine reads `fit_score === "Weak"` (or skip_reason ∈ {weak_fit, duplicate})
// in `prepare --phase pre` to drop already-evaluated rows from the batch
// candidates list — Claude no longer re-evaluates them.
//
// Backward compat:
//   v3 (16 cols, 2026-05-03 — G-5 added location) → auto-upgrade with empty
//     values for the 4 fit cols. save() always writes v4.
//   v2 (15 cols, 2026-04 — Stage 13 added salary_min/max/cl_path) → auto-upgrade
//     with location="" + empty fit cols on read.
//   v1 (12 cols, original) → auto-upgrade with empty values for all new cols.

const fs = require("fs");
const path = require("path");

const { fuzzyKey } = require("./dedup.js");

// BL-12 (2026-05-06): peel ATS prefixes from a jobId, preserving the case of
// the remainder. Mirrors the prefix list in `engine/core/dedup.js` /
// `tsv_dedup.js` (gh / ashby / lever / workday / smart / sr) but does NOT
// lowercase the surviving id — workday IDs like `REQ-9991` are case-sensitive
// in the source ATS and must round-trip unchanged.
const ATS_PREFIX_RE = /^(gh|ashby|lever|workday|smart|sr):(.+)$/i;
function stripAtsPrefixes(id) {
  let prev = String(id || "").trim();
  while (true) {
    const m = prev.match(ATS_PREFIX_RE);
    if (!m) return prev;
    prev = m[2];
  }
}

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
  "fit_score",
  "fit_rationale",
  "fit_evaluated_at",
  "skip_reason",
];

const HEADER_V3 = [
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

// BL-12 (2026-05-06): idempotent — strip any leading ATS prefixes from `jobId`
// before joining. Catches the legacy-prefix collision `lever:abc` ↔
// `lever:lever:abc` at write time so it never lands in TSV in the first place
// (was previously detectable only post-hoc via `validate --dedup`). Case of
// the surviving id is preserved so workday IDs like `REQ-9991` round-trip
// unchanged — only the recognized ATS prefix is consumed.
function makeKey(source, jobId) {
  return `${String(source).toLowerCase()}:${stripAtsPrefixes(jobId)}`;
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
    escapeField(app.fit_score || ""),
    escapeField(app.fit_rationale || ""),
    escapeField(app.fit_evaluated_at || ""),
    escapeField(app.skip_reason || ""),
  ].join("\t");
}

function rowToAppV4(parts, lineNo) {
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
    fit_score,
    fit_rationale,
    fit_evaluated_at,
    skip_reason,
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
    fit_score: fit_score || "",
    fit_rationale: fit_rationale || "",
    fit_evaluated_at: fit_evaluated_at || "",
    skip_reason: skip_reason || "",
  };
}

function rowToAppV3(parts, lineNo) {
  if (parts.length < HEADER_V3.length) {
    throw new Error(
      `applications.tsv line ${lineNo}: expected ${HEADER_V3.length} cols, got ${parts.length}`
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
    fit_score: "",
    fit_rationale: "",
    fit_evaluated_at: "",
    skip_reason: "",
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
    fit_score: "",
    fit_rationale: "",
    fit_evaluated_at: "",
    skip_reason: "",
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
    fit_score: "",
    fit_rationale: "",
    fit_evaluated_at: "",
    skip_reason: "",
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

  const isV4 = matchHeader(headerCols, HEADER);
  const isV3 = !isV4 && matchHeader(headerCols, HEADER_V3);
  const isV2 = !isV4 && !isV3 && matchHeader(headerCols, HEADER_V2);
  const isV1 = !isV4 && !isV3 && !isV2 && matchHeader(headerCols, HEADER_V1);

  if (!isV4 && !isV3 && !isV2 && !isV1) {
    throw new Error(
      `applications.tsv header mismatch: expected v4 [${HEADER.join(", ")}], v3 [${HEADER_V3.join(", ")}], v2 [${HEADER_V2.join(", ")}] or v1 [${HEADER_V1.join(", ")}], got [${headerCols.join(", ")}]`
    );
  }

  const apps = [];
  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i].split("\t");
    if (isV4) apps.push(rowToAppV4(parts, i + 1));
    else if (isV3) apps.push(rowToAppV3(parts, i + 1));
    else if (isV2) apps.push(rowToAppV2(parts, i + 1));
    else apps.push(rowToAppV1(parts, i + 1));
  }
  const schemaVersion = isV4 ? 4 : isV3 ? 3 : isV2 ? 2 : 1;
  return { apps, path: filePath, schemaVersion };
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
  { now = new Date().toISOString(), defaultStatus = "Inbox" } = {}
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
      fit_score: "",
      fit_rationale: "",
      fit_evaluated_at: "",
      skip_reason: "",
    });
  }
  return { apps: existing.concat(fresh), fresh, fuzzyDuplicates };
}

module.exports = { load, save, appendNew, makeKey, HEADER, HEADER_V1, HEADER_V2, HEADER_V3 };
