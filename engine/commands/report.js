// `report` command (RFC 068 §10): write the weekly review page.
//
//   node engine/cli.js report --profile <id> --weekly [--out <dir>]
//
// Reads applications.tsv and .health/apply_runs.jsonl (read-only) and the
// answer bank + the owner's ratings (Notion or the local backup; best-effort,
// BL-225 U7), builds the weekly stats for today (nightly runs included) and
// writes a self-contained HTML page `weekly-<YYYY-MM-DD>.html` into <dir>.
// Default <dir>: $AI_JOB_SEARCHER_DATA_DIR/reports, else <repo>/data/reports.
// Prints the written path. Re-running the same day overwrites that day's page.

const fs = require("fs");
const path = require("path");

const profileLoader = require("../core/profile_loader.js");
const applications = require("../core/applications_tsv.js");
const { resolveProfilesDir } = require("../core/paths.js");
const { buildWeeklyReport, renderWeeklyHtml } = require("../core/weekly_report.js");
const { todayLocalISO } = require("../core/auto_dead_sweep.js");
const { readNightRuns, nightRunsPath } = require("../core/night_runs_log.js");
const { makeClient } = require("../core/notion_sync.js");
const { fetchAllAnswers } = require("../core/qa_notion.js");
const bankStore = require("../core/answer_bank_store.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function defaultReportsDir(env = process.env) {
  const fromEnv = env && env.AI_JOB_SEARCHER_DATA_DIR;
  if (fromEnv && String(fromEnv).trim()) return path.join(path.resolve(fromEnv), "reports");
  return path.join(REPO_ROOT, "data", "reports");
}

const DEFAULT_DEPS = {
  loadProfile: profileLoader.loadProfile,
  loadApplications: applications.load,
  loadSecrets: profileLoader.loadSecrets,
  makeNotionClient: makeClient,
  fetchAllAnswers,
  today: () => todayLocalISO(),
  now: () => new Date().toISOString(),
};

function makeReportCommand(overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };

  return async function reportCommand(ctx) {
    const { profileId, flags = {}, stdout, stderr } = ctx;
    const env = ctx.env || process.env;
    if (!flags.weekly) {
      stderr("error: report needs a kind; the only one so far is --weekly");
      return 1;
    }
    const profilesDir = resolveProfilesDir(ctx, env);
    const profile = deps.loadProfile(profileId, { profilesDir, warn: () => {} });
    const { apps } = deps.loadApplications(profile.paths.applicationsTsv);

    const today = deps.today();
    const nights = readNightRuns(nightRunsPath(profile.paths.root));
    let bank;
    try {
      const b = await bankStore.loadAnswerBank({
        profile,
        secrets: deps.loadSecrets(profile.id, env) || {},
        deps: { makeClient: deps.makeNotionClient, fetchAllAnswers: deps.fetchAllAnswers },
      });
      if (b.notice) stderr(`note: ${b.notice}`);
      bank = {
        entries: b.entries,
        ratings: bankStore.readRatings(bankStore.ratingsPath(profile.paths.root)),
      };
    } catch (err) {
      stderr(`warn: answer bank line skipped (${err.message})`);
    }
    const report = buildWeeklyReport(apps, today, { nights, bank });
    const html = renderWeeklyHtml(report, { profileId: profile.id, generatedAt: deps.now() });

    const outDir = flags.out ? path.resolve(flags.out) : defaultReportsDir(env);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `weekly-${report.refDate}.html`);
    const tmp = `${outPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, html);
    fs.renameSync(tmp, outPath);

    stdout(outPath);
    return 0;
  };
}

module.exports = makeReportCommand();
module.exports.makeReportCommand = makeReportCommand;
module.exports.defaultReportsDir = defaultReportsDir;
