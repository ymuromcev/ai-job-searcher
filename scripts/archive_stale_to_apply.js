#!/usr/bin/env node
// RFC 068 §12 — one-off: archive the pre-auto-apply "To Apply" backlog.
//
// The apply bot only submits vacancies found after it launched. Every row
// still sitting in "To Apply" without an `applied_date` is retired:
//   status      → "Archived"
//   skip_reason → "stale_pre_autoapply"
// in the TSV (through applications_tsv.js) and, when the row has a Notion
// page, Status → "Archived" in Notion through the same targeted
// `notion_sync.updatePageStatus` helper `check` and the auto-No-Response
// sweep use (no new Notion writer).
//
// Default = dry-run: prints the count and a short list
// (company — title — createdAt). Makes NO network calls and writes nothing.
// Pass --apply to write.
//
// --apply order: back up the TSV, push Notion per row, then save the TSV
// with every row whose Notion update succeeded (or that has no Notion page).
// A row whose Notion update failed stays "To Apply" in the TSV, so a re-run
// retries exactly those rows (idempotent).
//
// Usage:
//   node scripts/archive_stale_to_apply.js --profile <id>
//   node scripts/archive_stale_to_apply.js --profile <id> --apply

const fs = require("fs");

const SKIP_REASON = "stale_pre_autoapply";
const NEW_STATUS = "Archived";
const TARGET_STATUS = "To Apply";
const LIST_LIMIT = 30;

function parseArgs(argv) {
  const out = { profile: null, apply: false, help: false, error: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i] || null;
    else if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else out.error = `unknown argument: ${a}`;
  }
  if (!out.help && !out.error && !out.profile) out.error = "--profile <id> is required";
  return out;
}

// Pure: rows to retire — "To Apply" with no applied_date.
function plan(apps) {
  return apps.filter(
    (a) => a && a.status === TARGET_STATUS && !String(a.applied_date || "").trim()
  );
}

// Pure: "company — title — createdAt" lines, capped at `limit`.
function formatList(candidates, limit = LIST_LIMIT) {
  const lines = candidates
    .slice(0, limit)
    .map((c) => `  ${c.companyName || "?"} — ${c.title || "?"} — ${c.createdAt || "?"}`);
  if (candidates.length > limit) lines.push(`  … and ${candidates.length - limit} more`);
  return lines;
}

// Pure: new apps array with the given keys archived.
function applyArchive(apps, keys, now) {
  const set = new Set(keys);
  return apps.map((a) =>
    set.has(a.key) ? { ...a, status: NEW_STATUS, skip_reason: SKIP_REASON, updatedAt: now } : a
  );
}

function defaultDeps() {
  const profileLoader = require("../engine/core/profile_loader.js");
  const applicationsTsv = require("../engine/core/applications_tsv.js");
  const notion = require("../engine/core/notion_sync.js");
  return {
    loadProfile: profileLoader.loadProfile,
    loadSecrets: profileLoader.loadSecrets,
    secretEnvName: profileLoader.secretEnvName,
    loadApplications: applicationsTsv.load,
    saveApplications: applicationsTsv.save,
    makeClient: notion.makeClient,
    updatePageStatus: notion.updatePageStatus,
    defaultPropertyMap: notion.DEFAULT_PROPERTY_MAP,
    copyFile: (src, dst) => fs.copyFileSync(src, dst),
    now: () => new Date().toISOString(),
  };
}

/**
 * @param {{profileId: string, apply: boolean, profilesDir: string, env: object,
 *          stdout: (s: string) => void, stderr: (s: string) => void}} ctx
 * @param {object} [overrides]  dependency overrides (tests).
 * @returns {Promise<number>} exit code
 */
async function run(ctx, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const { profileId, apply, profilesDir, env, stdout, stderr } = ctx;

  const profile = deps.loadProfile(profileId, { profilesDir, warn: () => {} });
  const tsvPath = profile.paths.applicationsTsv;
  const { apps } = deps.loadApplications(tsvPath);
  const candidates = plan(apps);
  const withPage = candidates.filter((c) => c.notion_page_id).length;

  stdout(`profile: ${profileId}`);
  stdout(`tsv: ${tsvPath} (${apps.length} rows)`);
  stdout(
    `stale "${TARGET_STATUS}" rows (no applied_date): ${candidates.length}` +
      ` (${withPage} with a Notion page)`
  );
  for (const line of formatList(candidates)) stdout(line);

  if (candidates.length === 0) {
    stdout("nothing to archive.");
    return 0;
  }
  if (!apply) {
    stdout(
      `(dry-run) pass --apply to set status="${NEW_STATUS}" + skip_reason="${SKIP_REASON}" ` +
        `in the TSV and Status="${NEW_STATUS}" in Notion.`
    );
    return 0;
  }

  let client = null;
  if (withPage > 0) {
    const secrets = deps.loadSecrets(profileId, env) || {};
    if (!secrets.NOTION_TOKEN) {
      stderr(
        `error: missing ${deps.secretEnvName(profileId, "NOTION_TOKEN")} in env — ` +
          `cannot update Notion; nothing written`
      );
      return 1;
    }
    client = deps.makeClient(secrets.NOTION_TOKEN);
  }
  const propertyMap = (profile.notion && profile.notion.property_map) || deps.defaultPropertyMap;

  const now = deps.now();
  const backupPath = `${tsvPath}.pre-stale-archive-${String(now).replace(/[:.]/g, "-")}`;
  deps.copyFile(tsvPath, backupPath);
  stdout(`backup: ${backupPath}`);

  const ok = [];
  const failed = [];
  for (const c of candidates) {
    if (!c.notion_page_id) {
      ok.push(c.key);
      continue;
    }
    try {
      await deps.updatePageStatus(client, c.notion_page_id, NEW_STATUS, propertyMap);
      ok.push(c.key);
    } catch (err) {
      failed.push({ key: c.key, error: err && err.message ? err.message : String(err) });
    }
  }

  deps.saveApplications(tsvPath, applyArchive(apps, ok, now));
  stdout(`archived: ${ok.length} row(s) in TSV${withPage ? " (Notion updated)" : ""}`);
  if (failed.length > 0) {
    stderr(
      `${failed.length} Notion update(s) failed — left as "${TARGET_STATUS}", re-run to retry:`
    );
    for (const f of failed) stderr(`  - ${f.key}: ${f.error}`);
    return 1;
  }
  return 0;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      "Usage: node scripts/archive_stale_to_apply.js --profile <id> [--apply]\n"
    );
    return 0;
  }
  if (args.error) {
    process.stderr.write(`error: ${args.error}\n`);
    return 2;
  }
  require("dotenv").config();
  const { resolveProfilesDir } = require("../engine/core/paths.js");
  return run({
    profileId: args.profile,
    apply: args.apply,
    profilesDir: resolveProfilesDir({}, process.env),
    env: process.env,
    stdout: (s) => process.stdout.write(s + "\n"),
    stderr: (s) => process.stderr.write(s + "\n"),
  });
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`fatal: ${err && err.stack ? err.stack : err}\n`);
      process.exit(1);
    });
}

module.exports = {
  parseArgs,
  plan,
  formatList,
  applyArchive,
  run,
  SKIP_REASON,
  NEW_STATUS,
};
