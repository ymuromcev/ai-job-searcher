#!/usr/bin/env node
// BL-77 — one-shot cleanup of non-US rows landed in Notion before BL-24
// (multi-loc location_blocklist + US state-code fix).
//
// What it does
//   For each row in profiles/<id>/applications.tsv:
//     - Skip if status ∈ {Applied, Interview, Offer, Rejected, Archived} —
//       the user has interacted with the job; cleanup must not touch it.
//     - Skip if skip_reason === "location_post_BL24" — idempotent re-runs.
//     - Skip if location is empty — undecidable; leave alone.
//     - Otherwise run `matchBlocklists` (the post-BL-24 version) against
//       `{ location, locations: [location] }`. If it returns a
//       `location_blocklist` reason, the row is a cleanup candidate.
//   In --apply mode: mark TSV row status="Archived" + skip_reason set, and
//   (if notion_page_id present) call notion.updatePageStatus → "Archived".
//
// Why "Archived" and not "Discarded"
//   BL-77 Q1(a) proposed status "Discarded", but it is not in the schema
//   (Notion EXPECTED_STATUS_OPTIONS = To Apply / Applied / Interview / Offer
//   / Rejected / No Response / Closed / Archived). "Archived" is the
//   schema-blessed bucket for filter-reject (see applications_tsv.js header
//   comment). The audit trail lives in TSV skip_reason="location_post_BL24".
//
// Default = dry-run. Pass --apply to write.
//
// Usage:
//   node scripts/cleanup_non_us_jobs.js --profile <id>
//   node scripts/cleanup_non_us_jobs.js --profile <id> --apply

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const { loadProfile, loadSecrets } = require("../engine/core/profile_loader");
const { load: loadApps, save: saveApps } = require("../engine/core/applications_tsv");
const { matchBlocklists } = require("../engine/core/filter");
const { makeClient, updatePageStatus } = require("../engine/core/notion_sync");

const SKIP_REASON = "location_post_BL24";
const NEW_STATUS = "Archived";

// Statuses where the user has engaged with the job. Never touched by cleanup.
const PROTECTED_STATUSES = new Set(["Applied", "Interview", "Offer", "Rejected", "Archived"]);

function parseArgs(argv) {
  const out = { profile: null, apply: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write("Usage: node scripts/cleanup_non_us_jobs.js --profile <id> [--apply]\n");
      process.exit(0);
    }
  }
  if (!out.profile) {
    process.stderr.write("error: --profile <id> is required\n");
    process.exit(2);
  }
  return out;
}

// Pure planner. Returns { candidates, counts } so tests can assert behavior
// without touching the filesystem or Notion.
function plan(apps, filterRules) {
  const candidates = [];
  const counts = {
    total: apps.length,
    skipped_protected_status: 0,
    skipped_already_marked: 0,
    skipped_no_location: 0,
    not_a_match: 0,
    candidates: 0,
  };
  for (const app of apps) {
    // skip_reason check first: a row we already cleaned will show
    // status="Archived" (also in PROTECTED_STATUSES), but the more honest
    // diagnostic is "already marked" rather than "protected".
    if (app.skip_reason === SKIP_REASON) {
      counts.skipped_already_marked += 1;
      continue;
    }
    if (PROTECTED_STATUSES.has(app.status)) {
      counts.skipped_protected_status += 1;
      continue;
    }
    // v5 (RFC 038): TSV row carries the full multi-loc array. Skip when
    // empty; pass the array straight to matchBlocklists so the BL-24
    // "US-anywhere wins" rule fires correctly on multi-loc rows.
    const locations = Array.isArray(app.locations) ? app.locations : [];
    if (locations.length === 0) {
      counts.skipped_no_location += 1;
      continue;
    }
    const reason = matchBlocklists({ locations }, filterRules || {});
    if (reason && reason.kind === "location_blocklist") {
      counts.candidates += 1;
      candidates.push({
        key: app.key,
        companyName: app.companyName,
        title: app.title,
        location: locations.join(", "),
        status: app.status,
        notion_page_id: app.notion_page_id,
        match: reason.match,
      });
    } else {
      counts.not_a_match += 1;
    }
  }
  return { candidates, counts };
}

// Pure: returns a new apps array with the marked rows updated.
function applyPlanToTsv(apps, candidateKeys, now) {
  const set = new Set(candidateKeys);
  return apps.map((a) =>
    set.has(a.key) ? { ...a, status: NEW_STATUS, skip_reason: SKIP_REASON, updatedAt: now } : a
  );
}

function printTable(candidates) {
  if (candidates.length === 0) {
    process.stdout.write("  (none)\n");
    return;
  }
  // Lazy-width columns capped at sensible maxes so a runaway field doesn't
  // shred the terminal.
  const widths = {
    company: Math.min(28, Math.max(...candidates.map((c) => c.companyName.length))),
    title: Math.min(44, Math.max(...candidates.map((c) => c.title.length))),
    location: Math.min(28, Math.max(...candidates.map((c) => c.location.length))),
    status: Math.max(...candidates.map((c) => c.status.length)),
  };
  const pad = (s, w) => {
    const str = String(s);
    return str.length > w ? str.slice(0, w - 1) + "…" : str.padEnd(w);
  };
  const header =
    `  ${pad("COMPANY", widths.company)}  ${pad("TITLE", widths.title)}  ` +
    `${pad("LOCATION", widths.location)}  ${pad("STATUS", widths.status)}  NOTION`;
  process.stdout.write(header + "\n");
  process.stdout.write("  " + "─".repeat(header.length - 2) + "\n");
  for (const c of candidates) {
    process.stdout.write(
      `  ${pad(c.companyName, widths.company)}  ${pad(c.title, widths.title)}  ` +
        `${pad(c.location, widths.location)}  ${pad(c.status, widths.status)}  ` +
        `${c.notion_page_id ? "↗" : "—"}\n`
    );
  }
}

// Wrapped so tests can inject a fake Notion client. Returns { ok: [keys],
// failed: [{key, error}] }.
async function pushNotionUpdates(client, candidates, propertyMap, log = () => {}) {
  const ok = [];
  const failed = [];
  for (const c of candidates) {
    if (!c.notion_page_id) {
      // No Notion page → TSV-only update; counted as success.
      ok.push(c.key);
      continue;
    }
    try {
      await updatePageStatus(client, c.notion_page_id, NEW_STATUS, propertyMap);
      log(`  ✓ ${c.key} → Notion Status=${NEW_STATUS}`);
      ok.push(c.key);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      log(`  ✗ ${c.key} → ${msg}`);
      failed.push({ key: c.key, error: msg });
    }
  }
  return { ok, failed };
}

async function main() {
  const { profile: profileId, apply } = parseArgs(process.argv);
  const profile = loadProfile(profileId);
  const tsvPath = profile.paths.applicationsTsv;

  if (!fs.existsSync(tsvPath)) {
    process.stderr.write(`error: ${tsvPath} not found\n`);
    process.exit(1);
  }

  const filterRules = profile.filterRules || {};
  const { apps } = loadApps(tsvPath);
  const { candidates, counts } = plan(apps, filterRules);

  process.stdout.write(`profile: ${profileId}\n`);
  process.stdout.write(`tsv: ${tsvPath} (${counts.total} rows)\n`);
  process.stdout.write(
    `triage:\n` +
      `  candidates (non-US, will Archive):   ${counts.candidates}\n` +
      `  skipped (protected status):           ${counts.skipped_protected_status}\n` +
      `  skipped (already cleaned post-BL24):  ${counts.skipped_already_marked}\n` +
      `  skipped (empty location):             ${counts.skipped_no_location}\n` +
      `  not a match:                          ${counts.not_a_match}\n`
  );

  if (candidates.length === 0) {
    process.stdout.write("\nNothing to clean up — exiting.\n");
    return;
  }

  process.stdout.write(`\nCandidates (${candidates.length}):\n`);
  printTable(candidates);

  if (!apply) {
    process.stdout.write(
      `\n(dry-run) Pass --apply to set Status="${NEW_STATUS}" + skip_reason="${SKIP_REASON}".\n`
    );
    return;
  }

  // --apply path: backup TSV first, then push Notion updates, then write TSV
  // with successful keys only. If Notion fails on a row, the TSV is not marked
  // for that row → next run will retry that row only (idempotent).
  const backupPath = `${tsvPath}.pre-bl77-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(tsvPath, backupPath);
  process.stdout.write(`\nbackup written: ${backupPath}\n`);

  const secrets = loadSecrets(profileId, process.env);
  const token = secrets.NOTION_TOKEN;
  if (!token) {
    process.stderr.write(
      `error: missing ${profileId.toUpperCase()}_NOTION_TOKEN in env — cannot push Notion updates\n`
    );
    process.exit(1);
  }
  const client = makeClient(token);
  const propertyMap = (profile.notion && profile.notion.property_map) || undefined;

  process.stdout.write(`\npushing Notion updates...\n`);
  const { ok, failed } = await pushNotionUpdates(client, candidates, propertyMap, (msg) =>
    process.stdout.write(msg + "\n")
  );

  const now = new Date().toISOString();
  const nextApps = applyPlanToTsv(apps, ok, now);
  saveApps(tsvPath, nextApps);
  process.stdout.write(`\napplied: ${ok.length} TSV row(s) updated in ${tsvPath}\n`);

  if (failed.length > 0) {
    process.stdout.write(
      `\n${failed.length} Notion update(s) failed (TSV not marked for these):\n`
    );
    for (const f of failed) process.stdout.write(`  - ${f.key}: ${f.error}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}

module.exports = { plan, applyPlanToTsv, pushNotionUpdates, SKIP_REASON, NEW_STATUS };
