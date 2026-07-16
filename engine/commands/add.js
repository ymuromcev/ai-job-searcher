// `add` command (RFC 063 / BL-208): enter one job into the pipeline by hand.
//
// For vacancies that arrive outside the ATS scan — referrals, newsletters,
// recruiter email, applying straight on a company site. Replaces the one-off
// scripts written for Virto Commerce, the Lenny's batch, and LawnStarter.
//
// This is NOT a second Notion writer. Page creation goes through the same
// shared helper `prepare --phase commit` uses — core/notion_job_page.pushJobPage
// — so the invariant is "all job-page creation goes through pushJobPage;
// prepare and add are its only callers".
//
// Ordering (RFC 063 §4), inverted vs RFC 022's batch case: Notion first, TSV
// second. One row, interactive, operator watching — so a Notion failure must
// write nothing rather than leave a row with an empty notion_page_id, which is
// not a valid state (only Inbox rows are legitimately Notion-less, RFC 014).
//
// Default is dry-run; --apply writes. Side effects live here; the row/payload
// logic is the pure core in engine/core/manual_job.js.

const fs = require("fs");
const path = require("path");

const profileLoader = require("../core/profile_loader.js");
const notion = require("../core/notion_sync.js");
const notionJobPage = require("../core/notion_job_page.js");
const companyResolver = require("../core/company_resolver.js");
const applicationsTsv = require("../core/applications_tsv.js");
const { resolveProfilesDir } = require("../core/paths.js");
const manualJob = require("../core/manual_job.js");

// Printed to stderr on a validation error. The pure core throws messages that
// name the offending flag; this gives the operator the full shape to fix it
// against without leaving the terminal.
const USAGE = `usage: node engine/cli.js add --profile <id> --company <name> --title <title> --status <status> [flags]

required:
  --company <name>       Company name. Resolved against the Notion Companies DB.
  --title <title>        Job title, stored verbatim.
  --status <status>      To Apply | Applied | Interview | Offer | Rejected | No Response | Closed | Archived
                         (Inbox is TSV-only per RFC 014 and is rejected here)

optional:
  --salary <range>       "MIN" or "MIN-MAX", whole dollars (140000-185000).
  --locations <list>     Comma-separated ("Remote,United States").
  --url <url>            Job posting URL.
  --fit <score>          Strong | Medium | Weak.
  --notes <text>         Free text → fit_rationale + the Notion Notes field.
  --applied-date <date>  YYYY-MM-DD.
  --resume-ver <name>    Resume archetype used for the application.
  --tier <S|A|B|C>       Writes company_tiers into profile.json.
  --force                Add despite detected duplicates.
  --apply                Create the page and write the row (default is dry-run).`;

const DEFAULT_DEPS = {
  loadProfile: profileLoader.loadProfile,
  loadSecrets: profileLoader.loadSecrets,
  makeClient: notion.makeClient,
  resolveDataSourceId: notion.resolveDataSourceId,
  makeCompanyResolver: companyResolver.makeCompanyResolver,
  pushJobPage: notionJobPage.pushJobPage,
  loadApps: applicationsTsv.load,
  saveApps: applicationsTsv.save,
  now: () => new Date().toISOString(),
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  copyFileSync: fs.copyFileSync,
  existsSync: fs.existsSync,
};

// Back up the TSV next to itself, mirroring the repo's existing
// `applications.tsv.pre-<what>-<date>` convention.
function backupPath(tsvPath, slug, date) {
  return `${tsvPath}.pre-add-${slug}-${date}`;
}

// Writing the tier into profile.json is a read-modify-write of a small JSON
// file the loader owns elsewhere; we touch only the company_tiers map and
// preserve formatting by re-serializing with 2-space indent (matches the file).
function writeCompanyTier(deps, profilePath, companyName, tier) {
  const raw = deps.readFileSync(profilePath, "utf8");
  const json = JSON.parse(raw);
  if (!json.company_tiers) json.company_tiers = {};
  json.company_tiers[companyName] = tier;
  deps.writeFileSync(profilePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

function renderPlan(row, fields, { tier, dryRun }) {
  const lines = [];
  const salary =
    row.salary_min || row.salary_max
      ? `${row.salary_min ?? "?"} - ${row.salary_max ?? "?"}`
      : "(none)";
  lines.push(`  key:        ${row.key}`);
  lines.push(`  company:    ${row.companyName}${tier ? `  (tier ${tier} → profile.json)` : ""}`);
  lines.push(`  title:      ${row.title}`);
  lines.push(`  status:     ${row.status}`);
  lines.push(`  locations:  ${row.locations.length ? row.locations.join(", ") : "(none)"}`);
  lines.push(
    `  salary:     ${salary}${fields.salaryExpectations ? `  → "${fields.salaryExpectations}"` : ""}`
  );
  lines.push(`  url:        ${row.url || "(none)"}`);
  lines.push(`  fit:        ${row.fit_score || "(none)"}`);
  lines.push(`  applied:    ${row.applied_date || "(none)"}`);
  if (dryRun) lines.push("");
  return lines;
}

function makeAddCommand(overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };

  return async function addCommand(ctx) {
    const { profileId, flags, env, stdout, stderr } = ctx;
    const apply = Boolean(flags.apply);
    const profilesDir = resolveProfilesDir(ctx, env || process.env);

    const profile = deps.loadProfile(profileId, { profilesDir });

    const jobsDbId = profile.notion && profile.notion.jobs_pipeline_db_id;
    const companiesDbId = profile.notion && profile.notion.companies_db_id;
    const propertyMap = profile.notion && profile.notion.property_map;
    if (!jobsDbId) {
      stderr("error: profile.notion.jobs_pipeline_db_id is not configured");
      return 1;
    }
    if (!companiesDbId) {
      stderr("error: profile.notion.companies_db_id is not configured");
      return 1;
    }

    // 1. Build + validate the row from flags (pure; throws with a usable message).
    let row;
    let tier;
    try {
      tier = manualJob.validateTier(flags.tier);
      row = manualJob.buildManualRow(
        {
          company: flags.company,
          title: flags.title,
          status: flags.status,
          salary: flags.salary,
          locations: flags.locations,
          url: flags.url,
          fit: flags.fit,
          notes: flags.notes,
          appliedDate: flags.appliedDate,
          resumeVer: flags.resumeVer,
        },
        deps.now()
      );
    } catch (err) {
      stderr(`error: ${err.message}`);
      stderr("");
      stderr(USAGE);
      return 2;
    }

    const fields = manualJob.buildJobFields(row);
    const tsvPath = path.join(profile.paths.root, "applications.tsv");
    const { apps } = deps.loadApps(tsvPath);

    // 2. Duplicate guard — before any write, before touching Notion.
    const dupes = manualJob.findDuplicates(apps, row);
    if (dupes.length && !flags.force) {
      stderr(`refusing: ${dupes.length} existing row(s) look like this job:`);
      for (const d of dupes) {
        stderr(`  - [${d.reason}] ${d.row.key}`);
        stderr(`    ${d.row.companyName} — ${d.row.title}  (status=${d.row.status})`);
      }
      stderr("pass --force to add anyway");
      return 1;
    }
    if (dupes.length && flags.force) {
      stdout(`warning: --force set, adding despite ${dupes.length} similar row(s)`);
    }

    stdout(`${apply ? "adding" : "would add"} to ${profileId}:`);
    for (const line of renderPlan(row, fields, { tier, dryRun: !apply })) stdout(line);

    if (!apply) {
      stdout("(dry-run — pass --apply to create the Notion page and write the TSV row)");
      return 0;
    }

    // 3. Notion first. Any failure here writes nothing.
    const secrets = deps.loadSecrets(profileId, env || process.env);
    const token = secrets.NOTION_TOKEN || null;
    if (!token) {
      stderr(`error: missing ${profileLoader.secretEnvName(profileId, "NOTION_TOKEN")} in env`);
      return 1;
    }

    let pageId;
    let dedup = false;
    try {
      const client = deps.makeClient(token);
      const companiesDataSourceId = await deps.resolveDataSourceId(client, companiesDbId);
      const resolver = deps.makeCompanyResolver({
        client,
        companiesDbId,
        companiesDataSourceId,
        companyTiers: profile.company_tiers || {},
        log: (msg) => stdout(`  resolver: ${msg}`),
      });

      const res = await deps.pushJobPage({
        client,
        jobsDbId,
        propertyMap,
        companyResolver: resolver,
        jobFields: fields,
      });
      pageId = res.pageId;
      dedup = Boolean(res.dedup);
    } catch (err) {
      stderr(`error: Notion push failed — ${err.message}`);
      stderr(
        "TSV not modified. Fix the cause and re-run; the page dedup guard makes a retry safe."
      );
      return 1;
    }

    if (dedup) {
      stdout(`  note: page already existed for this key — reusing ${pageId}, no duplicate created`);
    } else {
      stdout(`  created page ${pageId}`);
    }

    // 4. TSV second, with a backup.
    row.notion_page_id = pageId;
    row.updatedAt = deps.now();
    try {
      if (deps.existsSync(tsvPath)) {
        const bak = backupPath(
          tsvPath,
          manualJob.slugify(row.companyName),
          row.createdAt.slice(0, 10)
        );
        deps.copyFileSync(tsvPath, bak);
        stdout(`  backup: ${path.basename(bak)}`);
      }
      apps.push(row);
      deps.saveApps(tsvPath, apps);
      stdout(`  TSV row written (${apps.length} rows total)`);
    } catch (err) {
      stderr(
        `error: TSV write failed after the Notion page was created (${pageId}) — ${err.message}`
      );
      stderr("the page exists; re-running will reuse it rather than duplicate.");
      return 1;
    }

    // 5. Tier, last — a profile.json failure must not fail the whole add.
    if (tier) {
      try {
        writeCompanyTier(
          deps,
          path.join(profile.paths.root, "profile.json"),
          row.companyName,
          tier
        );
        stdout(`  profile.json: company_tiers["${row.companyName}"] = "${tier}"`);
      } catch (err) {
        stderr(`warning: could not write tier to profile.json — ${err.message}`);
        stderr(`the row and page are fine; set company_tiers["${row.companyName}"] by hand.`);
      }
    }

    stdout(`\nhttps://www.notion.so/${String(pageId).replace(/-/g, "")}`);
    return 0;
  };
}

module.exports = makeAddCommand();
module.exports.makeAddCommand = makeAddCommand;
module.exports.backupPath = backupPath;
