// Auto-Dead lazy sweep (BL-169 / RFC 059 amendment).
//
// Runs at the START of every engine CLI command (scan / prepare / check /
// sync / validate — wired once in `engine/cli.js` so it fires regardless of
// which command the operator runs). The funnel self-cleans exactly when the
// operator is working with the engine — no cron, no scheduler (explicitly
// rejected, paid-plan / infra-free design).
//
// Mechanism:
//   1. Load the profile's TSV.
//   2. `selectStaleInFlight(apps, todayStr, 7)` — pure scan for rows that
//      have been "In flight" for >= 7 days with a non-empty anchor date.
//   3. For each stale row: set status = "Dead", write the TSV via the single
//      writer (`applications_tsv.js`), and push "Dead" to Notion via the same
//      targeted `updatePageStatus` pattern `check` uses. This is engine-
//      authored status data (same class as `check`'s write) — it does NOT
//      reintroduce a push path; "sync pull-only" is preserved.
//
// Properties:
//   - Idempotent: a "Dead" row is never re-selected; "Replied" is never
//     touched; an empty anchor is a no-op (no timer).
//   - Cheap: pure scan first; only writes when something is actually stale.
//   - Resilient: no NOTION_TOKEN → mark Dead in TSV only + a stderr warn,
//     never fail the command. Notion calls are wrapped per-row in try/catch
//     so a Notion outage can never break the underlying command (scan /
//     validate must still run offline). The sweep never throws out of the
//     CLI entry — `runAutoDeadSweep` catches and logs.
//
// "today" is injected as a `YYYY-MM-DD` string by the CLI glue (computed
// once), so the pure helpers stay deterministic and unit-testable.

const path = require("path");

const profileLoader = require("../core/profile_loader.js");
const { secretEnvName } = profileLoader;
const applications = require("../core/applications_tsv.js");
const notion = require("../core/notion_sync.js");
const { resolveProfilesDir } = require("../core/paths.js");
const { selectStaleInFlight, DEAD, DEFAULT_THRESHOLD_DAYS } = require("./auto_dead.js");

const DEFAULT_DEPS = {
  loadProfile: profileLoader.loadProfile,
  loadSecrets: profileLoader.loadSecrets,
  loadApplications: applications.load,
  saveApplications: applications.save,
  makeClient: notion.makeClient,
  // Targeted single-field status write — the engine-authored pattern used by
  // `check`'s status update. Injected so tests mock the network.
  updatePageStatus: notion.updatePageStatus,
};

// Compute today's date as a `YYYY-MM-DD` string in local time. The single
// `Date` read for the whole sweep — kept out of the pure helpers. Exported so
// the CLI can compute "today" once and inject it.
function todayLocalISO(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Run the In-flight → Dead sweep for `profileId`.
//
//   profileId — profile to sweep.
//   ctx       — { stdout, stderr, env, profilesDir? }.
//   options   — { todayStr?, thresholdDays?, deps? }. `todayStr` is injected
//               by the CLI (defaults to local today if omitted, for manual
//               callers). `deps` overrides the I/O / Notion functions in tests.
//
// Returns { swept, notionPushed, notionErrors } for callers that care; the
// CLI ignores the return (fire-and-forget). Never throws — any unexpected
// error is caught and logged so the underlying command always proceeds.
async function runAutoDeadSweep(profileId, ctx, options = {}) {
  const deps = { ...DEFAULT_DEPS, ...(options.deps || {}) };
  const todayStr = options.todayStr || todayLocalISO();
  const thresholdDays = options.thresholdDays || DEFAULT_THRESHOLD_DAYS;
  const result = { swept: 0, notionPushed: 0, notionErrors: 0 };

  try {
    const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);
    const profile = deps.loadProfile(profileId, { profilesDir });
    const applicationsPath = path.join(profile.paths.root, "applications.tsv");
    const { apps } = deps.loadApplications(applicationsPath);

    const stale = selectStaleInFlight(apps, todayStr, thresholdDays);
    if (stale.length === 0) return result; // cheap no-op — nothing to kill

    // Resolve Notion creds once. Without a token (or a status mapping) we still
    // mark Dead in the TSV — the local ledger is canonical, Notion is a view.
    const secrets = (deps.loadSecrets && deps.loadSecrets(profileId, ctx.env)) || {};
    const token = secrets.NOTION_TOKEN || null;
    const propertyMap =
      (profile.notion && profile.notion.property_map) || notion.DEFAULT_PROPERTY_MAP;

    let client = null;
    const getClient = () => {
      if (!client) client = deps.makeClient(token);
      return client;
    };

    if (!token) {
      ctx.stderr(
        `[auto-dead] warn: missing ${secretEnvName(profileId, "NOTION_TOKEN")} in env — ` +
          `marking ${stale.length} stale row(s) Dead in TSV only, Notion not updated`
      );
    }

    for (const app of stale) {
      app.status = DEAD;
      result.swept += 1;

      if (token && app.notion_page_id) {
        try {
          await deps.updatePageStatus(getClient(), app.notion_page_id, DEAD, propertyMap);
          result.notionPushed += 1;
        } catch (err) {
          result.notionErrors += 1;
          ctx.stderr(
            `[auto-dead] notion error for ${app.key} (${app.notion_page_id}): ${err.message}`
          );
        }
      }
    }

    deps.saveApplications(applicationsPath, apps);

    const notionNote = token
      ? `, ${result.notionPushed} pushed to Notion` +
        (result.notionErrors ? `, ${result.notionErrors} Notion error(s)` : "")
      : ` (TSV only)`;
    ctx.stdout(`[auto-dead] swept ${result.swept} stale In-flight row(s) → Dead${notionNote}`);
  } catch (err) {
    // The sweep must never break the underlying command. Log and move on.
    ctx.stderr(`[auto-dead] warn: sweep skipped: ${err.message}`);
  }

  return result;
}

module.exports = {
  runAutoDeadSweep,
  todayLocalISO,
  DEFAULT_DEPS,
};
