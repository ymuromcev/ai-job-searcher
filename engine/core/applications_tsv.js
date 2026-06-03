// Per-profile pipeline file: profiles/<id>/applications.tsv.
//
// Schema (header required), v6 (added 2026-06-03 for BL-169 / RFC 059 — append
// six hiring-manager / warm-contact outreach columns). The v6 columns extend v5
// with the outreach motion tracked on the vacancy card:
//   key <TAB> source <TAB> jobId <TAB> companyName <TAB> title <TAB> url
//             <TAB> locations <TAB> status <TAB> notion_page_id
//             <TAB> resume_ver <TAB> cl_key
//             <TAB> salary_min <TAB> salary_max <TAB> cl_path
//             <TAB> createdAt <TAB> updatedAt
//             <TAB> fit_score <TAB> fit_rationale <TAB> fit_evaluated_at
//             <TAB> skip_reason
//             <TAB> company_people_search_url <TAB> outreach_type
//             <TAB> contact_name <TAB> contact_linkedin
//             <TAB> hm_outreach_status <TAB> hm_outreach_date
//
// v6 outreach columns (RFC 059):
//   `company_people_search_url` — LinkedIn people-search URL, engine-authored by
//                                 `prepare --phase commit` for Medium+/Strong rows.
//   `outreach_type`             — "warm" | "cold" | "" (operator → Notion → sync).
//   `contact_name`              — free text (operator → Notion → sync).
//   `contact_linkedin`          — URL (operator → Notion → sync).
//   `hm_outreach_status`        — as-built Notion `Outreach` status, 4-state:
//                                 "To do" | "In flight" | "Replied" | "Dead".
//                                 Defaults to "To do" (Notion's first option) so a
//                                 fresh row matches the value Notion auto-assigns and
//                                 `sync` shows no spurious diff (operator → Notion → sync).
//   `hm_outreach_date`          — ISO date (operator → Notion → sync).
//
// v5 (added 2026-05-18 for BL-93 / RFC 038 — persist the full multi-element
// locations[] array from discovery instead of collapsing to locations[0]). The
// on-disk column is renamed `location` → `locations` and carries a JSON-encoded
// array of strings.
//
// `key` = "<source>:<jobId>" — primary, used for dedup against the master pool.
// New entries default to status="Inbox" (post-RFC 014, 2026-05-04). "Inbox" =
// fresh-after-scan, no URL liveness / fit / CL yet — TSV-only state. `prepare
// --phase commit` transitions Inbox → To Apply (ready to submit) or Inbox →
// Archived (filter reject). The TSV-level 9-status set: Inbox / To Apply /
// Applied / Interview / Offer / Rejected / Closed / No Response / Archived.
// Notion DBs keep the 8-status set (Inbox is local-only).
// `locations` carries every entry from the discovery `NormalizedJob.locations`
// array; empty array (`[]`) when the source didn't provide any. Stored JSON
// so the cell round-trips losslessly (commas, quotes, pipes, unicode all safe).
//
// v4 fit columns (unchanged in v5) are written by `prepare --phase commit`
// from the SKILL's results.json (Step 10):
//   `fit_score`        — "Strong" | "Medium" | "Weak" | ""
//   `fit_rationale`    — short free-text rationale (≤ ~200 chars typical)
//   `fit_evaluated_at` — ISO timestamp of the SKILL run that wrote it
//   `skip_reason`      — why a row reached `status="Archived"`. Two families
//                        share this column (RFC 035 / BL-91):
//                          - Engine-emitted (canonical enum in
//                            `engine/core/skip_reasons.js#ENGINE_SKIP_REASONS`):
//                            `company_blocklist` | `title_blocklist` |
//                            `title_requirelist` | `company_cap` |
//                            `geo_no_location` | `geo_blocklist` |
//                            `geo_metro_miss` | `geo_country_miss` |
//                            `geo_remote_only_miss` | `geo_unknown_mode` |
//                            `url_dead`. Written by `prepare --phase pre`
//                            when a filter rejects an Inbox row. First
//                            archive wins — later filter hits on an
//                            already-Archived row never overwrite a
//                            non-empty reason.
//                          - SKILL-legacy (`weak_fit` | `duplicate`):
//                            accepted on results.json entries for one
//                            release after RFC 034 removed `decision`.
//                            Written by `prepare --phase commit`.
//                        Empty string when the row hasn't been archived.
// Engine reads `fit_score === "Weak"` (or skip_reason ∈ {weak_fit, duplicate}),
// and `status === "Archived"`, in `prepare --phase pre` to drop
// already-evaluated rows from the batch candidates list — Claude no longer
// re-evaluates them.
//
// In-memory shape: `app.locations: string[]` (the flat `app.location` accessor
// from v3/v4 is gone — every caller now reads the array).
//
// Backward compat (auto-upgrade-on-save):
//   v5 (20 cols, 2026-05-18 — RFC 038 locations[]) → reader seeds the six v6
//     outreach defaults (empty + hm_outreach_status="To do").
//   v4 (20 cols, 2026-05-05 — BL-9 fit columns, single-string `location`) →
//     reader wraps non-empty `location` to `[location]`, empty to `[]`, and
//     seeds the v6 outreach defaults.
//   v3 (16 cols, 2026-05-03 — G-5 added location) → same wrap; empty fit cols;
//     v6 outreach defaults.
//   v2 (15 cols, 2026-04 — Stage 13 added salary_min/max/cl_path) → empty
//     locations array + empty fit cols + v6 outreach defaults.
//   v1 (12 cols, original) → empty locations + empty v2+v3+v4 fields + v6
//     outreach defaults.
// save() always writes v6.

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

const HEADER_V6 = [
  "key",
  "source",
  "jobId",
  "companyName",
  "title",
  "url",
  "locations",
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
  "company_people_search_url",
  "outreach_type",
  "contact_name",
  "contact_linkedin",
  "hm_outreach_status",
  "hm_outreach_date",
];

const HEADER_V5 = [
  "key",
  "source",
  "jobId",
  "companyName",
  "title",
  "url",
  "locations",
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

// Current schema header. Aliased so legacy callers reading `HEADER` keep
// working; readers expect this constant to track the latest version.
const HEADER = HEADER_V6;

// RFC 059: default values for the six v6 outreach fields. Older rowToApp*
// paths seed these so an old file loads cleanly; the next save() rewrites it
// as v6. `hm_outreach_status` defaults to "To do" — the first option of the
// as-built Notion `Outreach` status (4-state: To do / In flight / Replied /
// Dead). Matching Notion's first option means a fresh `scan` row never drifts
// from the value Notion auto-assigns, so `sync` shows no spurious diff. The
// other five default empty.
function outreachDefaults() {
  return {
    company_people_search_url: "",
    outreach_type: "",
    contact_name: "",
    contact_linkedin: "",
    hm_outreach_status: "To do",
    hm_outreach_date: "",
  };
}

const HEADER_V4 = [
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

// Encode app.locations[] for the v5 TSV cell.
//   - undefined / null / non-array → "[]"
//   - array → JSON-encoded (filters non-strings; strings are kept verbatim
//     but tab/CR/LF are stripped to keep the row a single line).
function encodeLocations(locations) {
  if (!Array.isArray(locations)) return "[]";
  const sanitized = locations
    .filter((v) => v !== undefined && v !== null && v !== "")
    .map((v) => String(v).replace(/[\t\r\n]/g, " "));
  return JSON.stringify(sanitized);
}

// Decode a v5 cell value back to string[].
//   - "" → [] (legacy / hand-edited empty cell)
//   - valid JSON array → array (non-string entries coerced)
//   - any other non-JSON string → [cell] (defensive single-element wrap;
//     covers hand edits that lose the brackets)
function decodeLocations(cell) {
  const s = String(cell || "").trim();
  if (s === "" || s === "[]") return [];
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      // fall through to single-element wrap
    }
  }
  return [s];
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
    encodeLocations(app.locations),
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
    escapeField(app.company_people_search_url || ""),
    escapeField(app.outreach_type || ""),
    escapeField(app.contact_name || ""),
    escapeField(app.contact_linkedin || ""),
    escapeField(app.hm_outreach_status || ""),
    escapeField(app.hm_outreach_date || ""),
  ].join("\t");
}

function rowToAppV6(parts, lineNo) {
  if (parts.length < HEADER_V6.length) {
    throw new Error(
      `applications.tsv line ${lineNo}: expected ${HEADER_V6.length} cols, got ${parts.length}`
    );
  }
  const [
    key,
    source,
    jobId,
    companyName,
    title,
    url,
    locationsCell,
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
    company_people_search_url,
    outreach_type,
    contact_name,
    contact_linkedin,
    hm_outreach_status,
    hm_outreach_date,
  ] = parts;
  return {
    key,
    source,
    jobId,
    companyName,
    title,
    url,
    locations: decodeLocations(locationsCell),
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
    company_people_search_url: company_people_search_url || "",
    outreach_type: outreach_type || "",
    contact_name: contact_name || "",
    contact_linkedin: contact_linkedin || "",
    hm_outreach_status: hm_outreach_status || "",
    hm_outreach_date: hm_outreach_date || "",
  };
}

function rowToAppV5(parts, lineNo) {
  if (parts.length < HEADER_V5.length) {
    throw new Error(
      `applications.tsv line ${lineNo}: expected ${HEADER_V5.length} cols, got ${parts.length}`
    );
  }
  const [
    key,
    source,
    jobId,
    companyName,
    title,
    url,
    locationsCell,
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
    locations: decodeLocations(locationsCell),
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
    ...outreachDefaults(),
  };
}

function rowToAppV4(parts, lineNo) {
  if (parts.length < HEADER_V4.length) {
    throw new Error(
      `applications.tsv line ${lineNo}: expected ${HEADER_V4.length} cols, got ${parts.length}`
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
    locations: location ? [String(location)] : [],
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
    ...outreachDefaults(),
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
    locations: location ? [String(location)] : [],
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
    ...outreachDefaults(),
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
    locations: [],
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
    ...outreachDefaults(),
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
    locations: [],
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
    ...outreachDefaults(),
  };
}

function matchHeader(headerCols, expected) {
  return headerCols.length === expected.length && expected.every((c, i) => c === headerCols[i]);
}

function load(filePath) {
  if (!fs.existsSync(filePath)) return { apps: [], path: filePath };
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return { apps: [], path: filePath };
  const headerCols = lines[0].split("\t");

  const isV6 = matchHeader(headerCols, HEADER_V6);
  const isV5 = !isV6 && matchHeader(headerCols, HEADER_V5);
  const isV4 = !isV6 && !isV5 && matchHeader(headerCols, HEADER_V4);
  const isV3 = !isV6 && !isV5 && !isV4 && matchHeader(headerCols, HEADER_V3);
  const isV2 = !isV6 && !isV5 && !isV4 && !isV3 && matchHeader(headerCols, HEADER_V2);
  const isV1 = !isV6 && !isV5 && !isV4 && !isV3 && !isV2 && matchHeader(headerCols, HEADER_V1);

  if (!isV6 && !isV5 && !isV4 && !isV3 && !isV2 && !isV1) {
    throw new Error(
      `applications.tsv header mismatch: expected v6 [${HEADER_V6.join(", ")}], v5 [${HEADER_V5.join(", ")}], v4 [${HEADER_V4.join(", ")}], v3 [${HEADER_V3.join(", ")}], v2 [${HEADER_V2.join(", ")}] or v1 [${HEADER_V1.join(", ")}], got [${headerCols.join(", ")}]`
    );
  }

  const apps = [];
  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i].split("\t");
    if (isV6) apps.push(rowToAppV6(parts, i + 1));
    else if (isV5) apps.push(rowToAppV5(parts, i + 1));
    else if (isV4) apps.push(rowToAppV4(parts, i + 1));
    else if (isV3) apps.push(rowToAppV3(parts, i + 1));
    else if (isV2) apps.push(rowToAppV2(parts, i + 1));
    else apps.push(rowToAppV1(parts, i + 1));
  }
  const schemaVersion = isV6 ? 6 : isV5 ? 5 : isV4 ? 4 : isV3 ? 3 : isV2 ? 2 : 1;
  return { apps, path: filePath, schemaVersion };
}

function save(filePath, apps) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [HEADER_V6.join("\t")];
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
    // v5 (RFC 038): persist the full discovery locations[] array so the
    // multi-loc signal survives into prepare's geo recheck and validate's
    // retro-sweep. Fall back to [] when the source didn't provide one.
    const locations = Array.isArray(job.locations) ? job.locations.map(String).filter(Boolean) : [];
    fresh.push({
      key,
      source: job.source,
      jobId: job.jobId,
      companyName: job.companyName,
      title: job.title,
      url: job.url,
      locations,
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
      ...outreachDefaults(),
    });
  }
  return { apps: existing.concat(fresh), fresh, fuzzyDuplicates };
}

module.exports = {
  load,
  save,
  appendNew,
  makeKey,
  encodeLocations,
  decodeLocations,
  HEADER,
  HEADER_V1,
  HEADER_V2,
  HEADER_V3,
  HEADER_V4,
  HEADER_V5,
  HEADER_V6,
};
