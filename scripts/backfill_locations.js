// One-shot backfill: fills the new `location` column (schema v3, G-5) on
// existing applications.tsv rows by joining against the shared master pool
// data/jobs.tsv on `key = "<source>:<jobId>"`.
//
// Default = dry-run (reports counts, no write). Pass --apply to write.
// Per-profile execution: --profile <id>. Each --apply run creates a backup
// `applications.tsv.pre-stage-g5` next to the file before overwriting.
//
// Orphan rows (key not found in master pool) keep location="" and are
// counted under "orphans" in the summary. Common causes: imported from
// prototype Stage 16 (no master-pool entry), recruiter-source rows
// (source="recruiter"; never went through discovery).
//
// Usage:
//   node scripts/backfill_locations.js --profile jared
//   node scripts/backfill_locations.js --profile jared --apply

const fs = require("fs");
const path = require("path");

const apps = require("../engine/core/applications_tsv.js");
const jobsTsv = require("../engine/core/jobs_tsv.js");

function parseArgs(argv) {
  const out = { profile: null, apply: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: node scripts/backfill_locations.js --profile <id> [--apply]\n"
      );
      process.exit(0);
    }
  }
  if (!out.profile) {
    process.stderr.write("error: --profile <id> is required\n");
    process.exit(2);
  }
  return out;
}

function main() {
  const { profile, apply } = parseArgs(process.argv);
  const repoRoot = path.resolve(__dirname, "..");
  const tsvPath = path.join(repoRoot, "profiles", profile, "applications.tsv");
  const jobsPath = path.join(repoRoot, "data", "jobs.tsv");

  if (!fs.existsSync(tsvPath)) {
    process.stderr.write(`error: ${tsvPath} not found\n`);
    process.exit(1);
  }
  if (!fs.existsSync(jobsPath)) {
    process.stderr.write(`error: ${jobsPath} not found\n`);
    process.exit(1);
  }

  const { apps: rows, schemaVersion } = apps.load(tsvPath);
  const { jobs } = jobsTsv.load(jobsPath);

  // Build key index from master pool: "<source>:<jobId>" → first location.
  const locByKey = new Map();
  for (const j of jobs) {
    const key = `${String(j.source || "").toLowerCase()}:${j.jobId}`;
    if (!locByKey.has(key)) {
      const loc =
        Array.isArray(j.locations) && j.locations.length > 0
          ? String(j.locations[0])
          : "";
      locByKey.set(key, loc);
    }
  }

  // Some prototype-imported rows have ATS-coded prefixes in jobId
  // ("gh:7615044003", "lv:abc-123") while master pool stores the bare id.
  // Try both shapes when looking up.
  function lookup(r) {
    if (locByKey.has(r.key)) return { hit: true, loc: locByKey.get(r.key) };
    const m = String(r.jobId || "").match(/^([a-z]{1,3}):(.+)$/i);
    if (m) {
      const altKey = `${String(r.source || "").toLowerCase()}:${m[2]}`;
      if (locByKey.has(altKey)) return { hit: true, loc: locByKey.get(altKey) };
    }
    return { hit: false };
  }

  let filled = 0;
  let alreadyHad = 0;
  let orphan = 0;
  let orphanNoMatch = 0;
  let orphanNoPoolLoc = 0;
  const orphanSources = new Map();

  const next = rows.map((r) => {
    if (r.location && r.location.length > 0) {
      alreadyHad += 1;
      return r;
    }
    const res = lookup(r);
    if (!res.hit) {
      orphan += 1;
      orphanNoMatch += 1;
      orphanSources.set(r.source, (orphanSources.get(r.source) || 0) + 1);
      return r;
    }
    if (!res.loc) {
      orphan += 1;
      orphanNoPoolLoc += 1;
      orphanSources.set(r.source, (orphanSources.get(r.source) || 0) + 1);
      return r;
    }
    filled += 1;
    return { ...r, location: res.loc };
  });

  const total = rows.length;
  process.stdout.write(`profile: ${profile}\n`);
  process.stdout.write(`tsv: ${tsvPath}\n`);
  process.stdout.write(`master pool: ${jobsPath} (${jobs.length} jobs)\n`);
  process.stdout.write(`current schema version: v${schemaVersion}\n`);
  process.stdout.write(`rows: ${total}\n`);
  process.stdout.write(`  already had location: ${alreadyHad}\n`);
  process.stdout.write(`  filled from pool: ${filled}\n`);
  process.stdout.write(`  orphans (kept location=""): ${orphan}\n`);
  process.stdout.write(`    - key not in pool: ${orphanNoMatch}\n`);
  process.stdout.write(`    - pool match but pool location empty: ${orphanNoPoolLoc}\n`);
  if (orphanSources.size > 0) {
    process.stdout.write(`  orphan breakdown by source:\n`);
    const entries = [...orphanSources.entries()].sort((a, b) => b[1] - a[1]);
    for (const [src, n] of entries) {
      process.stdout.write(`    ${src || "(empty)"}: ${n}\n`);
    }
  }

  if (!apply) {
    process.stdout.write(`(dry-run) no files written. Run with --apply to persist.\n`);
    return;
  }

  const backupPath = `${tsvPath}.pre-stage-g5`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(tsvPath, backupPath);
    process.stdout.write(`backup: wrote ${backupPath}\n`);
  } else {
    process.stdout.write(`backup: ${backupPath} already exists — not overwriting\n`);
  }

  apps.save(tsvPath, next);
  process.stdout.write(`wrote ${next.length} rows to ${tsvPath} (now schema v3)\n`);
}

main();
