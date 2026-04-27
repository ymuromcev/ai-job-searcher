// seed_lilia_from_prototype.js — seed Lilia's applications.tsv with 95 "To Apply"
// rows generated from her prototype cover_letter_versions.json.
//
// Rationale: prototype has no URL tracking (scanning was done on Indeed, no
// state kept). What DOES exist: 95 prepared cover letters with {company, role,
// job_id} metadata. Seed those as "To Apply" rows so she can push them into
// her new Notion Jobs DB, fill URLs manually as she finds live postings, and
// start applying today.
//
// Dry-run default. --apply writes applications.tsv.
//
// Usage:
//   node scripts/stage18/seed_lilia_from_prototype.js --profile lilia
//   node scripts/stage18/seed_lilia_from_prototype.js --profile lilia --apply

const path = require("path");
const fs = require("fs");

const {
  parseArgs,
  banner,
  done,
  fatal,
  profileDir,
  loadIntake,
} = require("./_common.js");
const applications = require("../../engine/core/applications_tsv.js");

function resolveClPath(profileDirPath, jobId) {
  // CL files live in profiles/<id>/cover_letters/ — filename includes job_id.
  const dir = path.join(profileDirPath, "cover_letters");
  if (!fs.existsSync(dir)) return "";
  const files = fs.readdirSync(dir);
  const lower = jobId.toLowerCase();
  const match = files.find((f) => f.toLowerCase().includes(lower));
  return match ? path.join("cover_letters", match) : "";
}

function buildRowsFromLetters(letters, profileDirPath, nowIso) {
  const rows = [];
  const seen = new Set();
  for (const entry of letters) {
    if (!entry || !entry.job_id || !entry.company || !entry.role) continue;
    const key = `prototype:${entry.job_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key,
      source: "prototype",
      jobId: entry.job_id,
      companyName: entry.company,
      title: entry.role,
      url: "",
      status: "To Apply",
      notion_page_id: "",
      resume_ver: "medadmin",
      cl_key: entry.job_id,
      salary_min: "",
      salary_max: "",
      cl_path: resolveClPath(profileDirPath, entry.job_id),
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }
  return rows;
}

function main() {
  const args = parseArgs();
  banner("seed_lilia_from_prototype", args);

  const { data: intake } = loadIntake(args.profile);
  const id = intake.identity.profile_id;
  const profileDirPath = profileDir(id);
  const configPath = path.join(profileDirPath, "cover_letter_versions.json");
  if (!fs.existsSync(configPath)) {
    fatal(new Error(`cover_letter_versions.json not found at ${configPath} — run import_prototype first`));
  }
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const letters = Array.isArray(cfg.letters)
    ? cfg.letters
    : Object.values(cfg.letters || {});

  const now = new Date().toISOString();
  const rows = buildRowsFromLetters(letters, profileDirPath, now);

  // Load existing applications, dedup by key.
  const appsPath = path.join(profileDirPath, "applications.tsv");
  const { apps: existing } = applications.load(appsPath);
  const existingKeys = new Set(existing.map((r) => r.key));
  const newRows = rows.filter((r) => !existingKeys.has(r.key));

  console.log(`  prototype letters: ${letters.length}`);
  console.log(`  built rows:        ${rows.length}`);
  console.log(`  existing rows:     ${existing.length}`);
  console.log(`  new to append:     ${newRows.length}`);
  console.log(`  with CL file:      ${newRows.filter((r) => r.cl_path).length}`);

  if (!args.apply) {
    console.log("  (dry-run — pass --apply to write)");
    done("seed_lilia_from_prototype", { would_append: newRows.length });
    return;
  }

  const combined = existing.concat(newRows);
  applications.save(appsPath, combined);
  console.log(`  wrote ${combined.length} rows to ${appsPath}`);
  done("seed_lilia_from_prototype", { appended: newRows.length, total: combined.length });
}

if (require.main === module) {
  try { main(); } catch (err) { fatal(err); }
}

module.exports = { buildRowsFromLetters, resolveClPath };
