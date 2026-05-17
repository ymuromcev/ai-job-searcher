#!/usr/bin/env node
// One-off: backfill empty Company relation on Lilia's Notion job pages.
// Reads applications.tsv, identifies rows with notion_page_id but no Company
// relation in Notion, resolves the company via Companies DB (lookup-or-create),
// and patches the page. Run via: node scripts/oneoff_backfill_company_relation.js [--limit N]

const path = require("path");
const { loadProfile, loadSecrets } = require(
  path.resolve(__dirname, "../engine/core/profile_loader.js")
);
const { load: loadApplications } = require(
  path.resolve(__dirname, "../engine/core/applications_tsv.js")
);
const { makeClient, resolveDataSourceId } = require(
  path.resolve(__dirname, "../engine/core/notion_sync.js")
);
const { makeCompanyResolver } = require(
  path.resolve(__dirname, "../engine/core/company_resolver.js")
);

(async () => {
  // Manually parse .env for LILIA_NOTION_TOKEN
  const fs = require("fs");
  const envPath = path.resolve(__dirname, "../.env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }

  const args = process.argv.slice(2);
  const limit = parseInt(args[args.indexOf("--limit") + 1] || "9999", 10);
  const dryRun = args.includes("--dry-run");

  const profileId = "lilia";
  const profile = loadProfile(profileId, { profilesDir: path.resolve(__dirname, "../profiles") });
  const secrets = loadSecrets(profileId, process.env);
  const token = secrets.NOTION_TOKEN;
  if (!token) {
    console.error("error: LILIA_NOTION_TOKEN missing from env");
    process.exit(1);
  }
  const jobsDbId = profile.notion.jobs_pipeline_db_id;
  const companiesDbId = profile.notion.companies_db_id;

  const { apps } = loadApplications(profile.paths.applicationsTsv);
  const ACTIVE_PRE_APPLIED = new Set(["To Apply", "Inbox"]);
  const rowsWithPage = apps.filter(
    (a) => a.notion_page_id && a.companyName && ACTIVE_PRE_APPLIED.has(a.status)
  );
  console.log(`rows with notion_page_id (status in To Apply/Inbox): ${rowsWithPage.length}`);

  const client = makeClient(token);
  const [, companiesDsId] = await Promise.all([
    resolveDataSourceId(client, jobsDbId),
    resolveDataSourceId(client, companiesDbId),
  ]);
  const resolver = makeCompanyResolver({
    client,
    companiesDbId,
    companiesDataSourceId: companiesDsId,
    companyTiers: profile.company_tiers || {},
    log: (m) => console.log(`  resolver: ${m}`),
  });

  let checked = 0,
    missing = 0,
    patched = 0,
    failed = 0;
  for (const app of rowsWithPage) {
    if (checked >= limit) break;
    checked++;
    let page;
    try {
      page = await client.pages.retrieve({
        page_id: app.notion_page_id,
        filter_properties: ["gmM%7D"], // Company prop id
      });
    } catch (err) {
      console.log(`  ${app.key}: retrieve failed (${err.message})`);
      failed++;
      continue;
    }
    const rel = page.properties && page.properties.Company && page.properties.Company.relation;
    if (Array.isArray(rel) && rel.length > 0) continue;
    missing++;
    if (dryRun) {
      console.log(`  ${app.key}: would patch (${app.companyName})`);
      continue;
    }
    try {
      const companyPageId = await resolver.resolve(app.companyName);
      if (!companyPageId) {
        console.log(`  ${app.key}: resolver returned null for "${app.companyName}"`);
        failed++;
        continue;
      }
      await client.pages.update({
        page_id: app.notion_page_id,
        properties: { Company: { relation: [{ id: companyPageId }] } },
      });
      patched++;
      if (patched % 10 === 0) console.log(`  ...patched ${patched}`);
    } catch (err) {
      console.log(`  ${app.key}: patch failed (${err.message})`);
      failed++;
    }
  }
  console.log(
    `\nresult: checked=${checked} missing=${missing} patched=${patched} failed=${failed}`
  );
})().catch((err) => {
  console.error("fatal:", err.message);
  process.exit(1);
});
