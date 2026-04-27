// migrate_lilia_from_prototype.js — full migration of Lilia's prototype Notion
// (Jobs Pipeline + Companies) into her new pipeline (applications.tsv +
// new Notion DB).
//
// Source DBs (in user's personal "Lilia's Job Search" Notion workspace):
//   Jobs Pipeline   data_source: 24efceac-fec8-46c0-aae5-0250fcea6000
//   Companies       data_source: 35d56633-c1fd-473d-9398-6c96e5d2f12c
//
// Prototype Status set: Inbox / To Apply / Applied / Interview / Offer /
//   Rejected / No Response / Closed / Archive
// New DB Status set:    To Apply / Applied / Interview / Offer / Rejected /
//   No Response / Closed / Archived (no Inbox; "Archive" → "Archived")
//
// Mapping: Inbox → To Apply (treat all unprocessed as To Apply); Archive →
//   Archived. Other statuses pass through unchanged.
//
// Strategy:
//   1. Pull all pages from prototype Jobs DB (paginated).
//   2. Pull all pages from prototype Companies DB (paginated) → name lookup map.
//   3. For each prototype job: derive job_id from Cover Letter field (which
//      stores the CL filename stem) when present, else from Role+Company slug.
//   4. Match to existing applications.tsv rows by job_id, OR create new rows.
//   5. Populate: url, title, status, notes, fit_score, schedule, work_format,
//      requirements, city, salary_min, salary_max.
//   6. Re-sync (separately) — this script writes TSV only; user runs sync.
//
// Dry-run default. --apply writes applications.tsv (backup .pre-migrate kept).
//
// Usage:
//   node scripts/stage18/migrate_lilia_from_prototype.js --profile lilia
//   node scripts/stage18/migrate_lilia_from_prototype.js --profile lilia --apply

const path = require("path");
const fs = require("fs");
const { Client } = require("@notionhq/client");

const {
  loadEnv,
  parseArgs,
  requireToken,
  banner,
  done,
  fatal,
  profileDir,
  loadIntake,
} = require("./_common.js");
const applications = require("../../engine/core/applications_tsv.js");

const PROTOTYPE_JOBS_DS = "24efceac-fec8-46c0-aae5-0250fcea6000";
const PROTOTYPE_COMPANIES_DS = "35d56633-c1fd-473d-9398-6c96e5d2f12c";
const NOTION_VERSION = "2025-09-03";

// Status remap from prototype → new DB.
const STATUS_REMAP = {
  Inbox: "To Apply",
  "To Apply": "To Apply",
  Applied: "Applied",
  Interview: "Interview",
  Offer: "Offer",
  Rejected: "Rejected",
  "No Response": "No Response",
  Closed: "Closed",
  Archive: "Archived",
};

function getPlainText(rich) {
  if (!Array.isArray(rich)) return "";
  return rich.map((r) => (r && r.plain_text) || "").join("").trim();
}

function getTitle(prop) {
  if (!prop) return "";
  if (prop.type === "title") return getPlainText(prop.title);
  if (prop.type === "rich_text") return getPlainText(prop.rich_text);
  return "";
}

function getRichText(prop) {
  if (!prop || prop.type !== "rich_text") return "";
  return getPlainText(prop.rich_text);
}

function getUrl(prop) {
  if (!prop || prop.type !== "url") return "";
  return prop.url || "";
}

function getSelect(prop) {
  if (!prop || prop.type !== "select") return "";
  return (prop.select && prop.select.name) || "";
}

function getNumber(prop) {
  if (!prop || prop.type !== "number") return "";
  if (prop.number === null || prop.number === undefined) return "";
  return String(prop.number);
}

function getRelationIds(prop) {
  if (!prop || prop.type !== "relation") return [];
  return (prop.relation || []).map((r) => r.id);
}

async function pageThrough(client, dsId) {
  const out = [];
  let cursor;
  do {
    const resp = await client.dataSources.query({
      data_source_id: dsId,
      page_size: 100,
      start_cursor: cursor,
    });
    out.push(...(resp.results || []));
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return out;
}

function deriveJobId(coverLetterField, roleField, companyName) {
  // Cover Letter field stores filename like "CL_<First>_<Last>_<job_id>.pdf"
  // or just "<job_id>".
  const cl = String(coverLetterField || "").trim();
  if (cl) {
    // Match any "CL_<word>_<word>_<job_id>" prefix (profile-name-agnostic).
    const m = cl.match(/^CL_[A-Za-z]+_[A-Za-z]+_([a-z0-9_]+)/i);
    if (m) return m[1].toLowerCase();
    // strip extension if any
    const stem = cl.replace(/\.(pdf|docx)$/i, "").trim();
    if (stem) return stem.toLowerCase();
  }
  // Fallback: slug of company + role
  const co = String(companyName || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const ro = String(roleField || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return [co, ro].filter(Boolean).join("_") || "unknown";
}

function buildCompanyLookup(companyPages) {
  const out = new Map();
  for (const p of companyPages) {
    const props = p.properties || {};
    // Companies DB title prop is usually the first title-type one. Try common names.
    let name = "";
    for (const k of Object.keys(props)) {
      if (props[k] && props[k].type === "title") {
        name = getTitle(props[k]);
        break;
      }
    }
    if (name) out.set(p.id, name);
  }
  return out;
}

function mapPrototypePageToRow(p, companyLookup, nowIso) {
  const props = p.properties || {};
  const role = getTitle(props.Role) || getTitle(props.Name);
  const url = getUrl(props["Job URL"]);
  const cl = getRichText(props["Cover Letter"]);
  const status = getSelect(props.Status) || "Inbox";
  const newStatus = STATUS_REMAP[status] || "To Apply";
  const fitScore = getSelect(props["Fit Score"]);
  const schedule = getSelect(props.Schedule);
  const workFormat = getSelect(props["Work Format"]);
  const requirements = getRichText(props.Requirements);
  const city = getRichText(props.City);
  const notes = getRichText(props.Notes);
  const salaryMin = getNumber(props["Salary Min"]);
  const salaryMax = getNumber(props["Salary Max"]);
  const source = getSelect(props.Source) || "Indeed";

  const companyIds = getRelationIds(props.Company);
  const companyName = companyIds.length
    ? (companyLookup.get(companyIds[0]) || "")
    : "";

  const jobId = deriveJobId(cl, role, companyName);

  return {
    key: `prototype:${jobId}`,
    source: "prototype",
    jobId,
    companyName,
    title: role,
    url,
    status: newStatus,
    notion_page_id: "",
    resume_ver: "medadmin",
    cl_key: jobId,
    salary_min: salaryMin,
    salary_max: salaryMax,
    cl_path: "", // populated below from disk
    createdAt: p.created_time || nowIso,
    updatedAt: p.last_edited_time || nowIso,
    // extras stuffed into a side channel; sync.js reads core cols only,
    // we'll write them to a JSON sidecar for re-sync to consume.
    _extras: {
      fit_score: fitScore,
      schedule,
      work_format: workFormat,
      requirements,
      city,
      notes,
      indeed_source: source,
    },
  };
}

function resolveClPath(profileDirPath, jobId) {
  const dir = path.join(profileDirPath, "cover_letters");
  if (!fs.existsSync(dir)) return "";
  const files = fs.readdirSync(dir);
  const lower = jobId.toLowerCase();
  const match = files.find((f) => f.toLowerCase().includes(lower));
  return match ? path.join("cover_letters", match) : "";
}

async function main() {
  loadEnv();
  const args = parseArgs();
  banner("migrate_lilia_from_prototype", args);

  const { data: intake } = loadIntake(args.profile);
  const id = intake.identity.profile_id;
  const token = requireToken(id);
  const client = new Client({ auth: token, notionVersion: NOTION_VERSION });

  console.log(`  pulling prototype Jobs DB...`);
  const jobPages = await pageThrough(client, PROTOTYPE_JOBS_DS);
  console.log(`    ${jobPages.length} job pages`);

  console.log(`  pulling prototype Companies DB...`);
  const companyPages = await pageThrough(client, PROTOTYPE_COMPANIES_DS);
  console.log(`    ${companyPages.length} company pages`);

  const companyLookup = buildCompanyLookup(companyPages);

  const profileDirPath = profileDir(id);
  const now = new Date().toISOString();

  // Map prototype → rows.
  const protoRows = jobPages
    .map((p) => mapPrototypePageToRow(p, companyLookup, now))
    .filter((r) => r.title); // drop title-less garbage

  // Resolve cl_path from disk for each.
  for (const r of protoRows) {
    r.cl_path = resolveClPath(profileDirPath, r.jobId);
  }

  // Dedup proto rows by key (prefer the most recently edited one).
  const dedupMap = new Map();
  for (const r of protoRows) {
    const existing = dedupMap.get(r.key);
    if (!existing || r.updatedAt > existing.updatedAt) {
      dedupMap.set(r.key, r);
    }
  }
  const protoDeduped = [...dedupMap.values()];
  console.log(`  prototype rows (after dedup): ${protoDeduped.length}`);

  // Load existing applications.tsv. Strategy: REPLACE old prototype rows
  // (status="To Apply", source="prototype") with the new prototype-sourced
  // rows. Preserve any rows from other sources (none yet for Lilia).
  const appsPath = path.join(profileDirPath, "applications.tsv");
  const { apps: existing } = applications.load(appsPath);
  const nonProto = existing.filter((r) => r.source !== "prototype");
  console.log(`  existing rows: ${existing.length} (${existing.length - nonProto.length} prototype, ${nonProto.length} other)`);

  // Build a map of existing prototype rows by key to preserve notion_page_id
  // when re-running migration.
  const existingProtoById = new Map();
  for (const r of existing) {
    if (r.source === "prototype" && r.notion_page_id) {
      existingProtoById.set(r.key, r.notion_page_id);
    }
  }

  // Strip _extras before saving (TSV core schema doesn't include them).
  const newRows = protoDeduped.map((r) => {
    const { _extras, ...core } = r;
    if (existingProtoById.has(core.key)) {
      core.notion_page_id = existingProtoById.get(core.key);
    }
    return core;
  });

  const combined = nonProto.concat(newRows);

  // Stats.
  const withUrl = newRows.filter((r) => r.url).length;
  const withCl = newRows.filter((r) => r.cl_path).length;
  const reused = newRows.filter((r) => r.notion_page_id).length;
  const statusCounts = {};
  for (const r of newRows) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;

  console.log(`\n  --- migration plan ---`);
  console.log(`  proto rows to write:  ${newRows.length}`);
  console.log(`    with Job URL:       ${withUrl}`);
  console.log(`    with CL on disk:    ${withCl}`);
  console.log(`    reusing notion_page_id: ${reused}`);
  console.log(`    status counts:      ${JSON.stringify(statusCounts)}`);

  // Write extras sidecar always (used by re-sync extension).
  const extrasPath = path.join(profileDirPath, ".prototype_extras.json");
  const extrasMap = {};
  for (const r of protoDeduped) {
    extrasMap[r.key] = r._extras;
  }

  if (!args.apply) {
    console.log(`  (dry-run — pass --apply to write applications.tsv + extras sidecar)`);
    done("migrate_lilia_from_prototype", {
      would_write_rows: combined.length,
      proto_with_url: withUrl,
    });
    return;
  }

  // Backup current applications.tsv.
  if (fs.existsSync(appsPath)) {
    const stamp = now.replace(/[:.]/g, "-");
    const backupPath = appsPath + `.pre-migrate-${stamp}`;
    fs.copyFileSync(appsPath, backupPath);
    console.log(`  backup: ${backupPath}`);
  }

  applications.save(appsPath, combined);
  console.log(`  wrote ${combined.length} rows to ${appsPath}`);

  fs.writeFileSync(extrasPath, JSON.stringify(extrasMap, null, 2));
  console.log(`  wrote extras for ${Object.keys(extrasMap).length} rows to ${extrasPath}`);

  done("migrate_lilia_from_prototype", {
    rows_written: combined.length,
    proto_rows: newRows.length,
    proto_with_url: withUrl,
  });
}

if (require.main === module) {
  main().catch(fatal);
}

module.exports = { mapPrototypePageToRow, deriveJobId, STATUS_REMAP };
