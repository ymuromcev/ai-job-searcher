// One-shot migration: applications.tsv v4 (single-string `location`) →
// v5 (JSON-encoded `locations` array). Companion to RFC 038 / BL-93.
//
// Behaviour:
//   - Dry-run by default. Pass --apply to write.
//   - --profile <id> targets profiles/<id>/applications.tsv.
//   - Omit --profile to scan every profiles/* with an applications.tsv.
//   - Idempotent: a file already at v5 is left untouched (no backup written).
//   - For each migrated file we drop a backup at
//     `applications.tsv.pre-v5-<YYYY-MM-DD>` next to the file. Existing
//     backup at that path is preserved (we never overwrite).
//
// Usage:
//   node scripts/migrate_tsv_v4_to_v5.js              # dry-run, all profiles
//   node scripts/migrate_tsv_v4_to_v5.js --profile jared
//   node scripts/migrate_tsv_v4_to_v5.js --profile jared --apply
//   node scripts/migrate_tsv_v4_to_v5.js --apply      # apply to all profiles
//
// Note: the writer in `engine/core/applications_tsv.js` auto-upgrades v1..v4
// to v5 on the next save() anyway. This script is the explicit, auditable
// path — runs once after the PR lands so the migration is recorded as a
// discrete event (with a backup file) rather than buried in a routine
// `prepare` / `sync` run.

const fs = require("fs");
const path = require("path");

const apps = require("../engine/core/applications_tsv.js");

function parseArgs(argv) {
  const out = { profile: null, apply: false, root: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--apply") out.apply = true;
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: node scripts/migrate_tsv_v4_to_v5.js [--profile <id>] [--apply] [--root <path>]\n"
      );
      process.exit(0);
    }
  }
  return out;
}

function todayStamp(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// Pure (file-system aware but injectable). Exposed for the golden test.
function migrateOne(tsvPath, { apply, now = new Date(), fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(tsvPath)) {
    return { path: tsvPath, status: "missing" };
  }
  const result = apps.load(tsvPath);
  const { apps: rows, schemaVersion } = result;
  // This one-shot migration only needs to wrap `location` → `locations[]`,
  // which is satisfied at v5 and any later schema (v6+ supersedes v5 and
  // already carries the array). Treat anything already at v5 or newer as a
  // no-op so the script stays idempotent after later schema bumps.
  if (schemaVersion >= 5) {
    return { path: tsvPath, status: "already_v5", rows: rows.length };
  }
  if (!apply) {
    return {
      path: tsvPath,
      status: "would_migrate",
      fromVersion: schemaVersion,
      rows: rows.length,
    };
  }
  const backupPath = `${tsvPath}.pre-v5-${todayStamp(now)}`;
  let backupNote = "wrote";
  if (fsImpl.existsSync(backupPath)) {
    backupNote = "exists";
  } else {
    fsImpl.copyFileSync(tsvPath, backupPath);
  }
  apps.save(tsvPath, rows);
  return {
    path: tsvPath,
    status: "migrated",
    fromVersion: schemaVersion,
    rows: rows.length,
    backupPath,
    backupNote,
  };
}

function discoverProfiles(repoRoot) {
  const profilesDir = path.join(repoRoot, "profiles");
  if (!fs.existsSync(profilesDir)) return [];
  return fs
    .readdirSync(profilesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => id !== "_example")
    .filter((id) => fs.existsSync(path.join(profilesDir, id, "applications.tsv")));
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = args.root ? path.resolve(args.root) : path.resolve(__dirname, "..");

  let profiles;
  if (args.profile) {
    profiles = [args.profile];
  } else {
    profiles = discoverProfiles(repoRoot);
    if (profiles.length === 0) {
      process.stderr.write("no profiles found under profiles/*/applications.tsv\n");
      process.exit(2);
    }
  }

  const mode = args.apply ? "apply" : "dry-run";
  process.stdout.write(`migrate_tsv_v4_to_v5 (${mode}): ${profiles.length} profile(s)\n`);

  let migrated = 0;
  let skipped = 0;
  let missing = 0;
  for (const profile of profiles) {
    const tsvPath = path.join(repoRoot, "profiles", profile, "applications.tsv");
    const res = migrateOne(tsvPath, { apply: args.apply });
    if (res.status === "missing") {
      missing += 1;
      process.stdout.write(`  ${profile}: missing (${tsvPath})\n`);
      continue;
    }
    if (res.status === "already_v5") {
      skipped += 1;
      process.stdout.write(`  ${profile}: already v5 (${res.rows} rows) — skipped\n`);
      continue;
    }
    if (res.status === "would_migrate") {
      migrated += 1;
      process.stdout.write(
        `  ${profile}: would migrate v${res.fromVersion} → v5 (${res.rows} rows)\n`
      );
      continue;
    }
    if (res.status === "migrated") {
      migrated += 1;
      process.stdout.write(
        `  ${profile}: migrated v${res.fromVersion} → v5 (${res.rows} rows); backup ${res.backupNote} ${res.backupPath}\n`
      );
    }
  }
  process.stdout.write(
    `done: migrated=${migrated} skipped=${skipped} missing=${missing} mode=${mode}\n`
  );
  if (!args.apply && migrated > 0) {
    process.stdout.write("(dry-run) re-run with --apply to write.\n");
  }
}

if (require.main === module) {
  main();
}

module.exports = { migrateOne, discoverProfiles, todayStamp };
