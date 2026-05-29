#!/usr/bin/env node
//
// scripts/migrate_cl_to_tailored.js — BL-152 one-shot migration
//
// Moves engine-generated cover-letter PDFs from the legacy layout
//
//   profiles/<id>/cover_letters/<CompanySlug>/<clKey>.pdf
//
// onto the archive-eligible layout the engine writes going forward
// (RFC 054 / BL-151 archive sweep only moves paths under a `tailored/`
// prefix):
//
//   profiles/<id>/cover_letters/tailored/<CompanySlug>/<clKey>.pdf
//
// The move is a pure path insert (`tailored/` after `cover_letters/`) —
// the existing slug subdirectory is preserved, so no re-slugify drift.
// TSV `cl_path` is rewritten to the new path for every migrated row.
//
// Out of scope: `cover_letters_md/` (editable MD sources are not archived
// and keep their existing layout) and sentinel cl_paths without a `.pdf`
// extension (e.g. "indeed_generic").
//
// Defaults to `--dry-run`. Pass `--apply` to mutate the filesystem and TSV.
// Always backs up the TSV first to applications.tsv.pre-cl-tailored-<ISO>.
//
// Idempotent: rows already under `cover_letters/tailored/` (or already
// archived under `cover_letters/archive/`) are skipped.
//
// Concurrency: this script and `prepare --phase commit` both mutate the
// TSV and CL files. Do not run them at the same time. There is no lock
// file; --apply prints a reminder and the pre-flight TSV backup is the
// safety net.
//
// Usage:
//   node scripts/migrate_cl_to_tailored.js --profile lilia            # dry-run
//   node scripts/migrate_cl_to_tailored.js --profile lilia --apply    # write

const fs = require("fs");
const path = require("path");

const { loadProfile } = require("../engine/core/profile_loader.js");
const applicationsTsv = require("../engine/core/applications_tsv.js");
const { resolveProfilesDir } = require("../engine/core/paths.js");

const LEGACY_PREFIX = "cover_letters/";
const TAILORED_PREFIX = "cover_letters/tailored/";
const ARCHIVE_PREFIX = "cover_letters/archive/";

// --- Pure planner -----------------------------------------------------------

// Compute what should happen for one TSV row. Returns a Plan object the
// caller (CLI or test) can execute or pretty-print. No filesystem writes.
//
// Inputs:
//   - app: TSV row (must have cl_path; key used only for messages)
//   - profileRoot: absolute path to the profile dir
//   - fileExists(absPath): boolean — pluggable for tests
//
// Output Plan:
//   {
//     skip: bool,                 // no-op
//     reason: "...",              // why skipped / action chosen
//     newClPath?: "cover_letters/tailored/<slug>/<key>.pdf",
//     move?: { from, to },        // move existing PDF (omitted if source missing)
//     warnings: string[],         // non-fatal issues
//   }
function planRow(app, profileRoot, { fileExists } = {}) {
  const out = { warnings: [] };
  const cl = String((app && app.cl_path) || "").trim();

  if (cl === "") {
    out.skip = true;
    out.reason = "empty cl_path";
    return out;
  }

  // Normalize backslashes defensively (hand edits / Windows-style paths).
  const norm = cl.replace(/\\/g, "/");

  // Sentinels and non-PDF pointers (e.g. "indeed_generic") are not engine
  // CL artifacts — never rewrite them.
  if (!/\.pdf$/i.test(norm)) {
    out.skip = true;
    out.reason = "sentinel cl_path";
    return out;
  }

  if (norm.startsWith(TAILORED_PREFIX)) {
    out.skip = true;
    out.reason = "already tailored";
    return out;
  }
  if (norm.startsWith(ARCHIVE_PREFIX)) {
    out.skip = true;
    out.reason = "already archived";
    return out;
  }
  if (!norm.startsWith(LEGACY_PREFIX)) {
    // Unexpected layout (absolute path, bare basename, something else).
    // Don't guess — leave it and warn so the operator can look.
    out.skip = true;
    out.reason = "unexpected layout";
    out.warnings.push(
      `cl_path "${cl}" is not under cover_letters/ — leaving unchanged (run migrate_cl_layout.js first?)`
    );
    return out;
  }

  // Insert `tailored/` after `cover_letters/`, preserving the rest of the path.
  const newRel = TAILORED_PREFIX + norm.slice(LEGACY_PREFIX.length);
  out.newClPath = newRel;

  const fromAbs = path.join(profileRoot, norm);
  const toAbs = path.join(profileRoot, newRel);

  if (fileExists(fromAbs)) {
    out.move = { from: fromAbs, to: toAbs };
  } else {
    // Source missing — the file may have been hand-deleted or already moved.
    // Still canonicalize the pointer so a future regen / archive resolves to
    // the new layout, but warn loudly.
    out.warnings.push(
      `no PDF on disk at "${norm}" — cl_path pointer will still be canonicalised to "${newRel}"`
    );
  }
  return out;
}

// --- Side-effect helpers (real fs) ------------------------------------------

function defaultBackupTsv(applicationsPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${applicationsPath}.pre-cl-tailored-${stamp}`;
  fs.copyFileSync(applicationsPath, dest);
  return dest;
}

function moveFile(from, to) {
  if (from === to) return;
  if (fs.existsSync(to)) {
    throw new Error(`target already exists: ${to}`);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

// --- Orchestration ----------------------------------------------------------

async function migrate({
  profileId,
  apply = false,
  profilesDir,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  if (!profileId) {
    stderr("error: --profile <id> is required");
    return 1;
  }

  const dirs = profilesDir || resolveProfilesDir({}, process.env);
  const profile = loadProfile(profileId, { profilesDir: dirs });
  const root = profile.paths.root;
  const applicationsPath = profile.paths.applicationsTsv;

  if (!fs.existsSync(applicationsPath)) {
    stderr(`error: ${applicationsPath} not found`);
    return 1;
  }

  const { apps } = applicationsTsv.load(applicationsPath);

  const stats = {
    total: apps.length,
    rowsWithCl: 0,
    skippedTailored: 0,
    skippedArchived: 0,
    skippedSentinel: 0,
    skippedOther: 0,
    moved: 0,
    tsvUpdated: 0,
    warnings: 0,
    errors: 0,
  };

  const rowsToUpdate = []; // [{ app, plan }]

  for (const app of apps) {
    if (!app.cl_path || String(app.cl_path).trim() === "") continue;
    stats.rowsWithCl++;
    const plan = planRow(app, root, { fileExists: fs.existsSync });
    for (const w of plan.warnings) {
      stderr(`warn: [${app.key}] ${w}`);
      stats.warnings++;
    }
    if (plan.skip) {
      if (plan.reason === "already tailored") stats.skippedTailored++;
      else if (plan.reason === "already archived") stats.skippedArchived++;
      else if (plan.reason === "sentinel cl_path") stats.skippedSentinel++;
      else stats.skippedOther++;
      continue;
    }
    rowsToUpdate.push({ app, plan });
  }

  const skipSummary = (() => {
    const parts = [];
    if (stats.skippedTailored > 0) parts.push(`${stats.skippedTailored} already tailored`);
    if (stats.skippedArchived > 0) parts.push(`${stats.skippedArchived} already archived`);
    if (stats.skippedSentinel > 0) parts.push(`${stats.skippedSentinel} sentinel(s)`);
    if (stats.skippedOther > 0) parts.push(`${stats.skippedOther} unexpected layout`);
    return parts.length > 0 ? parts.join(", ") : "0 skipped";
  })();

  if (rowsToUpdate.length === 0) {
    stdout(
      `nothing to do — ${stats.rowsWithCl}/${stats.total} rows have cl_path, ` +
        `${skipSummary} (${stats.warnings} warning(s))`
    );
    return 0;
  }

  const planMoves = rowsToUpdate.filter(({ plan }) => plan.move).length;
  const planPointerOnly = rowsToUpdate.length - planMoves;
  stdout(
    `plan: ${rowsToUpdate.length} row(s) to migrate ` +
      `(of ${stats.rowsWithCl} cl_path rows; ${skipSummary})`
  );
  stdout(
    `  ${planMoves} PDF move(s), ${planPointerOnly} pointer-only (source missing), ` +
      `${rowsToUpdate.length} TSV cl_path update(s)`
  );

  if (!apply) {
    stdout("(dry-run — pass --apply to mutate filesystem and TSV)");
    return 0;
  }

  stdout("note: do not run `prepare --phase commit` for this profile while this migration runs.");
  const backupPath = defaultBackupTsv(applicationsPath);
  stdout(`backed up TSV → ${backupPath}`);

  // Per-row failures are warned and skipped; TSV save still runs at the end so
  // partial progress sticks (backup is the safety net).
  for (const { app, plan } of rowsToUpdate) {
    try {
      if (plan.move) {
        moveFile(plan.move.from, plan.move.to);
        stats.moved++;
      }
      app.cl_path = plan.newClPath;
      stats.tsvUpdated++;
    } catch (err) {
      stats.errors++;
      stderr(`error: [${app.key}] ${err.message}`);
    }
  }

  applicationsTsv.save(applicationsPath, apps);
  stdout(
    `applied: ${stats.moved} PDF moved, ${stats.tsvUpdated} TSV cl_path(s) updated, ` +
      `${stats.warnings} warning(s), ${stats.errors} error(s)`
  );
  return stats.errors === 0 ? 0 : 1;
}

// --- CLI entry --------------------------------------------------------------

function parseCliArgs(argv) {
  const args = { profile: "", apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false;
    else if (a === "--profile") {
      args.profile = argv[i + 1] || "";
      i++;
    }
  }
  return args;
}

if (require.main === module) {
  (async () => {
    const args = parseCliArgs(process.argv.slice(2));
    if (!args.profile) {
      console.error("usage: migrate_cl_to_tailored.js --profile <id> [--apply]");
      process.exit(1);
    }
    try {
      require("dotenv").config();
    } catch (_err) {
      // dotenv optional
    }
    const code = await migrate({ profileId: args.profile, apply: args.apply });
    process.exit(code);
  })();
}

module.exports = { migrate, planRow, parseCliArgs };
