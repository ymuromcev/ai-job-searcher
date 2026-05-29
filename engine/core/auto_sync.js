// Auto-sync pre-hook: invoked by `scan` and `prepare` before their main
// work runs. Pulls Notion → TSV via the existing `sync` command with
// `--apply`, then archives used tailored artifacts for rows whose status
// moved past `To Apply`. Skipped entirely by `--no-sync`.
//
// Non-fatal: if Notion creds are missing or the sync call throws, the
// hook logs a single stderr warn line and proceeds. The caller's
// scan/prepare must NOT fail because auto-sync failed — bootstrapping a
// new profile shouldn't require Notion at all.
//
// Pure-ish: takes `ctx` and `handlers` (matching the runCli signature),
// no module-level state, no global env reads.

const fs = require("fs");
const path = require("path");

const profileLoader = require("../core/profile_loader.js");
const applicationsTsv = require("../core/applications_tsv.js");
const { resolveProfilesDir } = require("../core/paths.js");
const {
  planArchiveMoves,
  applyArchiveMoves,
} = require("./archive_used_artifacts.js");

const DEFAULT_DEPS = {
  loadProfile: profileLoader.loadProfile,
  loadSecrets: profileLoader.loadSecrets,
  loadApplications: applicationsTsv.load,
  saveApplications: applicationsTsv.save,
  fs: {
    existsSync: (p) => fs.existsSync(p),
    mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
    renameSync: (from, to) => fs.renameSync(from, to),
  },
};

// Run the archive sweep for `profileId`. Pure-of-Notion: works whether
// or not the sync step ran (e.g. operator can call manually after sync).
//
//   ctx — { stdout, stderr, env, profilesDir? }
//   deps — overridable for tests
function runArchiveSweep(profileId, ctx, deps = {}) {
  const merged = { ...DEFAULT_DEPS, ...deps };
  const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);
  const profile = merged.loadProfile(profileId, { profilesDir });
  const applicationsPath = path.join(profile.paths.root, "applications.tsv");

  const { apps } = merged.loadApplications(applicationsPath);
  // Plan against the current TSV state.
  const plan = planArchiveMoves({
    rows: apps,
    profileRoot: profile.paths.root,
    fs: merged.fs,
  });

  if (plan.moves.length === 0 && plan.skipped.length === 0) {
    return { moved: 0, skipped: 0, warnings: plan.warnings, byMonth: { cv: [], cl: [] } };
  }

  // tsvUpdater mutates the in-memory `apps` list keyed by row.key.
  const byKey = new Map(apps.map((a) => [a.key, a]));
  const tsvUpdater = (rowKey, patch) => {
    const row = byKey.get(rowKey);
    if (!row) return;
    Object.assign(row, patch);
  };

  const result = applyArchiveMoves(plan, {
    fs: merged.fs,
    tsvUpdater,
    logger: { warn: (m) => ctx.stderr(`[sync] warn: ${m}`) },
  });

  if (result.moved > 0) {
    merged.saveApplications(applicationsPath, apps);
  }
  return result;
}

// Format the archive-sweep stdout line.
//   [sync] archived 3 used artifacts → cv/archive/2026-05/, cover_letters/archive/2026-05/
// When there's nothing to report, returns null so caller can skip.
function formatArchiveSummary(result) {
  if (!result || result.moved === 0) return null;
  const dirs = [];
  for (const d of result.byMonth.cv || []) dirs.push(`${d}/`);
  for (const d of result.byMonth.cl || []) dirs.push(`${d}/`);
  const dirStr = dirs.length > 0 ? ` → ${dirs.join(", ")}` : "";
  return `[sync] archived ${result.moved} used artifact${result.moved === 1 ? "" : "s"}${dirStr}`;
}

// Full pre-hook: Notion pull → archive sweep. Invoked by cli.js for
// scan / prepare (unless --no-sync is set).
//
// Design: defer everything to the injected `sync` handler. It already
// knows how to (a) refuse gracefully when NOTION_TOKEN is missing
// (exits 1 with a stderr line) and (b) run the archive sweep after a
// successful pull. We just print the leading `[sync] pulling …` line
// and swallow non-fatal errors so scan/prepare can proceed even if
// Notion is unreachable.
//
//   ctx       — caller's ctx.
//   handlers  — runCli handlers map; we look up `handlers.sync`.
async function runAutoSync(profileId, ctx, handlers) {
  const syncHandler = handlers && handlers.sync;
  if (typeof syncHandler !== "function") return;
  ctx.stdout(`[sync] pulling Notion → TSV (${profileId}) ...`);
  try {
    await syncHandler({ ...ctx, flags: { ...ctx.flags, apply: true } });
  } catch (e) {
    ctx.stderr(`warn: auto-sync failed: ${e.message}`);
  }
}

module.exports = {
  runAutoSync,
  runArchiveSweep,
  formatArchiveSummary,
};
