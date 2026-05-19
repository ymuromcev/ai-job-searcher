#!/usr/bin/env node
// One-off push: reads prepare_results_*.json + applications.tsv, creates Notion pages
// for each `decision=to_apply` entry with full property set per SKILL Step 9, persists
// notion_page_id back to TSV.
//
// Usage:  node scripts/push_prepare_results_to_notion.js --profile <id> --results <path> [--apply]

require("dotenv").config();
const path = require("path");
const fs = require("fs");

const { loadProfile, loadSecrets } = require("../engine/core/profile_loader");
const { makeClient, createJobPage, resolveDataSourceId } = require("../engine/core/notion_sync");
const { makeCompanyResolver } = require("../engine/core/company_resolver");
const { load: loadApps, save: saveApps } = require("../engine/core/applications_tsv");

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") args.profile = argv[++i];
    else if (a === "--results") args.results = argv[++i];
    else if (a === "--apply") args.apply = true;
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.profile || !args.results) {
    console.error("usage: --profile <id> --results <path> [--apply]");
    process.exit(2);
  }

  const profile = loadProfile(args.profile);
  const secrets = loadSecrets(args.profile, process.env);
  const token = secrets.NOTION_TOKEN;
  if (!token) {
    console.error(`missing ${args.profile.toUpperCase()}_NOTION_TOKEN in env`);
    process.exit(1);
  }

  const jobsDb = profile.notion.jobs_pipeline_db_id;
  const companiesDb = profile.notion.companies_db_id;
  const propMap = profile.notion.property_map;
  const companyTiers = profile.company_tiers || {};

  const resultsFile = path.resolve(args.results);
  const resultsJson = JSON.parse(fs.readFileSync(resultsFile, "utf-8"));
  const tsvPath = path.join(profile.paths.root, "applications.tsv");
  const { apps } = loadApps(tsvPath);
  const byKey = new Map(apps.map((a) => [a.key, a]));

  const client = makeClient(token);
  const companiesDataSourceId = await resolveDataSourceId(client, companiesDb);
  const resolver = makeCompanyResolver({
    client,
    companiesDbId: companiesDb,
    companiesDataSourceId,
    companyTiers,
    log: (msg) => console.log(`  resolver: ${msg}`),
  });

  const today = new Date().toISOString().slice(0, 10);
  const updates = [];

  for (const r of resultsJson.results) {
    if (r.decision !== "to_apply") continue;
    const app = byKey.get(r.key);
    if (!app) {
      console.error(`skip: ${r.key} — no TSV row`);
      continue;
    }
    if (app.notion_page_id) {
      console.log(`skip: ${r.key} — already has notion_page_id ${app.notion_page_id}`);
      continue;
    }

    const companyName = app.companyName;
    console.log(`\nprocessing: ${companyName} — ${app.title}`);

    // 1. Resolve Company relation (resolver returns pageId string directly)
    let companyPageId;
    try {
      companyPageId = await resolver.resolve(companyName);
      console.log(`  company resolved: ${companyName} → ${companyPageId}`);
    } catch (err) {
      console.error(`  company resolve failed: ${err.message}`);
      continue;
    }

    // 2. Build job object
    const salaryExp =
      r.salaryMin && r.salaryMax
        ? `$${Math.round(r.salaryMin / 1000)}-${Math.round(r.salaryMax / 1000)}K TC`
        : "";

    const job = {
      title: app.title,
      companyRelation: [companyPageId],
      source: app.source || r.key.split(":")[0],
      jobId: app.jobId,
      url: app.url,
      status: "To Apply",
      key: app.key,
      fitScore: r.fitScore,
      dateAdded: today,
      // v5 (RFC 038): TSV now stores the full multi-loc array; the Notion
      // City property is single-text, so we join with ", " for display.
      city: Array.isArray(app.locations) ? app.locations.join(", ") : "",
      state: "Any",
      notes: r.fitRationale || "",
      salaryExpectations: salaryExp,
      salaryMin: r.salaryMin || null,
      salaryMax: r.salaryMax || null,
      coverLetter: r.clKey || "",
      resumeVersion: r.resumeVer || "",
    };

    if (!args.apply) {
      console.log(`  (dry-run) would create page in ${jobsDb}:`);
      console.log(
        `    title=${job.title} | company=${companyName} | fit=${job.fitScore} | salary=${salaryExp} | cl=${job.coverLetter}`
      );
      continue;
    }

    // 3. Create Notion page
    try {
      const page = await createJobPage(client, jobsDb, job, propMap);
      const pageId = page.id;
      console.log(`  ✓ created page ${pageId}`);
      app.notion_page_id = pageId;
      app.updatedAt = new Date().toISOString();
      updates.push({ key: r.key, pageId });
    } catch (err) {
      console.error(`  ✗ create failed: ${err.message}`);
    }
  }

  if (args.apply && updates.length > 0) {
    saveApps(tsvPath, apps);
    console.log(`\nupdated ${updates.length} row(s) in ${tsvPath}`);
  } else if (!args.apply) {
    console.log(`\n(dry-run — pass --apply to push)`);
  }
})().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
