// One-shot backfill: bridges the gap between data/jobs.tsv (master pool) and
// profiles/<id>/applications.tsv. The pool accumulated ~19k jobs across all
// scans, but only fresh-from-this-scan jobs ever made it into per-profile TSV.
// Result: thousands of pool jobs from a profile's companies were never run
// through filter rules and never landed as either "To Apply" or "Archived".
//
// This script reads the entire pool, intersects with the profile's company
// list (companies.tsv profile column), drops jobs already in the TSV, then
// runs the rest through the same filterJobs() that scan uses post-fix.
// Passed jobs get status="To Apply", rejected get status="Archived" — same
// shape the live scan now produces.
//
// Default = dry-run (reports counts, no write). --apply writes a backup
// `applications.tsv.pre-pool-backfill-YYYY-MM-DD` before overwriting.
// Idempotent: a second run finds 0 new rows because keys are already in TSV.
//
// Usage:
//   node scripts/backfill_apps_from_pool.js --profile jared
//   node scripts/backfill_apps_from_pool.js --profile jared --apply

const fs = require("fs");
const path = require("path");

const apps = require("../engine/core/applications_tsv.js");
const jobsTsv = require("../engine/core/jobs_tsv.js");
const { jobKey } = require("../engine/core/dedup.js");
const { filterJobs } = require("../engine/core/filter.js");
const { loadProfile } = require("../engine/core/profile_loader.js");

function parseArgs(argv) {
  const out = { profile: null, apply: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: node scripts/backfill_apps_from_pool.js --profile <id> [--apply]\n"
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

// Load companies.tsv and return Set of lowercased company NAMES that have
// the given profile id in the comma-separated profile column.
function loadProfileCompanies(repoRoot, profileId) {
  const file = path.join(repoRoot, "data", "companies.tsv");
  if (!fs.existsSync(file)) throw new Error(`companies.tsv not found: ${file}`);
  const lines = fs.readFileSync(file, "utf8").split("\n").slice(1).filter(Boolean);
  const out = new Set();
  for (const line of lines) {
    const cols = line.split("\t");
    const name = cols[0];
    const profCol = cols[4] || "";
    const profiles = profCol.split(",").map((s) => s.trim()).filter(Boolean);
    if (profiles.includes(profileId)) out.add(String(name).toLowerCase());
  }
  return out;
}

// Build active-counts map (company → number of active rows) so company_cap
// rule replicates exactly what scan does.
function buildActiveCounts(rows, rules) {
  const cap = rules.company_cap || {};
  const DEFAULT_ACTIVE = ["To Apply", "Applied", "Interview", "Offer"];
  const activeStatuses = new Set(
    Array.isArray(cap.active_statuses) && cap.active_statuses.length > 0
      ? cap.active_statuses
      : DEFAULT_ACTIVE
  );
  const counts = {};
  for (const r of rows) {
    if (activeStatuses.has(r.status)) {
      counts[r.companyName] = (counts[r.companyName] || 0) + 1;
    }
  }
  return counts;
}

function main() {
  const { profile: profileId, apply } = parseArgs(process.argv);
  const repoRoot = path.resolve(__dirname, "..");
  require("dotenv").config({ path: path.join(repoRoot, ".env") });

  const profile = loadProfile(profileId, {
    profilesDir: path.join(repoRoot, "profiles"),
  });
  const tsvPath = path.join(profile.paths.root, "applications.tsv");
  const poolPath = path.join(repoRoot, "data", "jobs.tsv");

  if (!fs.existsSync(tsvPath)) {
    process.stderr.write(`error: ${tsvPath} not found\n`);
    process.exit(1);
  }
  if (!fs.existsSync(poolPath)) {
    process.stderr.write(`error: ${poolPath} not found\n`);
    process.exit(1);
  }

  const { apps: rows } = apps.load(tsvPath);
  const { jobs: pool } = jobsTsv.load(poolPath);
  const tsvKeys = new Set(rows.map((r) => r.key));
  const profileCompanies = loadProfileCompanies(repoRoot, profileId);
  const rules = profile.filterRules || {};

  // Candidates = pool jobs from profile companies, not yet in TSV.
  const candidates = [];
  for (const j of pool) {
    if (tsvKeys.has(jobKey(j))) continue;
    const cn = String(j.companyName || "").toLowerCase();
    if (!profileCompanies.has(cn)) continue;
    candidates.push(j);
  }

  // Run through the same filter shape scan uses.
  const inputs = candidates.map((j) => ({
    _job: j,
    company: j.companyName,
    role: j.title,
    location: (Array.isArray(j.locations) && j.locations.length > 0
      ? String(j.locations[0])
      : ""),
  }));
  const activeCounts = buildActiveCounts(rows, rules);
  const result = filterJobs(inputs, rules, activeCounts);

  const passedJobs = result.passed.map((p) => p._job);
  const rejectedJobs = result.rejected.map((r) => r.job._job);

  // Reason breakdown for visibility.
  const reasonCounts = {};
  for (const r of result.rejected) {
    const k = r.reason.kind;
    reasonCounts[k] = (reasonCounts[k] || 0) + 1;
  }

  process.stdout.write(`profile: ${profileId}\n`);
  process.stdout.write(`tsv: ${tsvPath} (${rows.length} rows)\n`);
  process.stdout.write(`pool: ${poolPath} (${pool.length} jobs)\n`);
  process.stdout.write(`profile companies (companies.tsv profile col): ${profileCompanies.size}\n`);
  process.stdout.write(`candidates (pool ∩ profile companies, not in TSV): ${candidates.length}\n`);
  process.stdout.write(`filter result:\n`);
  process.stdout.write(`  passed (To Apply): ${result.passed.length}\n`);
  process.stdout.write(`  rejected (Archived): ${result.rejected.length}\n`);
  for (const [k, n] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`    ${k}: ${n}\n`);
  }

  if (!apply) {
    process.stdout.write(`(dry-run) no files written. Run with --apply to persist.\n`);
    return;
  }

  // Layered append: passed first (To Apply), then rejected (Archived) on top
  // of the result. Mirrors scan post-fix behaviour exactly.
  const now = new Date().toISOString();
  const date = now.slice(0, 10);
  const backupPath = `${tsvPath}.pre-pool-backfill-${date}`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(tsvPath, backupPath);
    process.stdout.write(`backup: wrote ${backupPath}\n`);
  } else {
    process.stdout.write(`backup: ${backupPath} already exists — not overwriting\n`);
  }

  let next = rows;
  if (passedJobs.length > 0) {
    const r1 = apps.appendNew(next, passedJobs, { now, defaultStatus: "To Apply" });
    next = r1.apps;
  }
  if (rejectedJobs.length > 0) {
    const r2 = apps.appendNew(next, rejectedJobs, { now, defaultStatus: "Archived" });
    next = r2.apps;
  }

  apps.save(tsvPath, next);
  process.stdout.write(`wrote ${next.length} rows to ${tsvPath} (was ${rows.length}, +${next.length - rows.length})\n`);
}

main();
