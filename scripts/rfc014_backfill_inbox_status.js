// One-shot backfill for RFC 014 (TSV-only `Inbox` status).
//
// Rewrites status="To Apply" + notion_page_id="" rows (pre-RFC014 fresh-after-
// scan rows) to status="Inbox". Rows with notion_page_id set (already
// prepared) keep status="To Apply" untouched.
//
// Default = dry-run (reports counts, no write). Pass --apply to write.
// Per-profile execution: --profile <id>. Each --apply run creates a backup
// `applications.tsv.pre-rfc014` next to the file before overwriting.
//
// Notion is NOT touched — `Inbox` is a TSV-only status.
//
// Usage:
//   node scripts/rfc014_backfill_inbox_status.js --profile jared
//   node scripts/rfc014_backfill_inbox_status.js --profile jared --apply

const fs = require("fs");
const path = require("path");

const apps = require("../engine/core/applications_tsv.js");

function parseArgs(argv) {
  const out = { profile: null, apply: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: node scripts/rfc014_backfill_inbox_status.js --profile <id> [--apply]\n"
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

// Pure planner — no I/O. Returns {plan, summary} so tests can assert behavior.
function plan(loadedApps) {
  const updates = [];
  const counts = {
    total: loadedApps.length,
    toMigrate: 0, // To Apply + no notion_page_id → Inbox
    alreadyPrepared: 0, // To Apply + has notion_page_id → keep
    other: 0, // any other status → ignore
  };

  for (const app of loadedApps) {
    if (app.status === "To Apply") {
      if (!app.notion_page_id) {
        counts.toMigrate += 1;
        updates.push({
          key: app.key,
          companyName: app.companyName,
          title: app.title,
          fromStatus: "To Apply",
          toStatus: "Inbox",
        });
      } else {
        counts.alreadyPrepared += 1;
      }
    } else {
      counts.other += 1;
    }
  }

  return { updates, counts };
}

function applyPlan(loadedApps, updates, now) {
  const updateKeys = new Set(updates.map((u) => u.key));
  return loadedApps.map((a) =>
    updateKeys.has(a.key) ? { ...a, status: "Inbox", updatedAt: now } : a
  );
}

function main() {
  const { profile, apply } = parseArgs(process.argv);
  const repoRoot = path.resolve(__dirname, "..");
  const tsvPath = path.join(repoRoot, "profiles", profile, "applications.tsv");

  if (!fs.existsSync(tsvPath)) {
    process.stderr.write(`error: ${tsvPath} not found\n`);
    process.exit(1);
  }

  const loaded = apps.load(tsvPath);
  const { updates, counts } = plan(loaded.apps);

  process.stdout.write(`profile: ${profile}\n`);
  process.stdout.write(`tsv: ${tsvPath} (${counts.total} rows)\n`);
  process.stdout.write(
    `plan: ${counts.toMigrate} rows To Apply → Inbox, ${counts.alreadyPrepared} already-prepared rows kept, ${counts.other} other-status rows untouched\n`
  );

  if (counts.toMigrate === 0) {
    process.stdout.write("nothing to do — exiting\n");
    return;
  }

  // Show first 10 examples
  const sample = updates.slice(0, 10);
  for (const u of sample) {
    process.stdout.write(`  ${u.key}  ${u.companyName} — ${u.title}\n`);
  }
  if (updates.length > 10) {
    process.stdout.write(`  … and ${updates.length - 10} more\n`);
  }

  if (!apply) {
    process.stdout.write("\n(dry-run) pass --apply to rewrite TSV\n");
    return;
  }

  // Backup before write
  const backupPath = `${tsvPath}.pre-rfc014`;
  fs.copyFileSync(tsvPath, backupPath);
  process.stdout.write(`backup written: ${backupPath}\n`);

  const now = new Date().toISOString();
  const next = applyPlan(loaded.apps, updates, now);
  apps.save(tsvPath, next);
  process.stdout.write(
    `applied: rewrote ${updates.length} rows to status="Inbox" in ${tsvPath}\n`
  );
}

if (require.main === module) main();

module.exports = { plan, applyPlan };
