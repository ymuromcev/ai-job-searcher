// push_lilia_extras_to_notion.js — one-shot push of migrated prototype data
// (URLs, statuses, fit/schedule/format/requirements/city/notes/salary/source)
// to Lilia's new Notion Jobs DB.
//
// Why this exists separately from `sync`: standard sync pull pulls Notion →
// TSV, and push only creates pages (doesn't update extras for existing pages).
// After migrate_lilia_from_prototype.js writes our new TSV truth (with URLs +
// real statuses + extras sidecar), we need to push those updates into Notion.
// One-time tool — not a generic engine feature.
//
// For rows with notion_page_id: update only.
// For rows without notion_page_id: create new page with all fields.
//
// Dry-run default. --apply mutates Notion.
//
// Usage:
//   node scripts/stage18/push_lilia_extras_to_notion.js --profile lilia
//   node scripts/stage18/push_lilia_extras_to_notion.js --profile lilia --apply

const path = require("path");
const fs = require("fs");
const { Client } = require("@notionhq/client");

const {
  loadEnv,
  parseArgs,
  requireToken,
  banner,
  done,
  fatal,
  profileDir,
  loadIntake,
} = require("./_common.js");
const applications = require("../../engine/core/applications_tsv.js");
const { resolveDataSourceId } = require("../../engine/core/notion_sync.js");

function makeCompanyResolver(client, companiesDsId) {
  // Lookup company page by name in Lilia's Companies DB.
  const cache = new Map();
  return async function resolve(name) {
    if (!name) return null;
    if (cache.has(name)) return cache.get(name);
    const resp = await client.dataSources.query({
      data_source_id: companiesDsId,
      page_size: 5,
      filter: {
        property: "Name",
        title: { equals: name },
      },
    });
    const pageId = resp.results && resp.results[0] && resp.results[0].id;
    cache.set(name, pageId || null);
    return pageId || null;
  };
}

function buildPageProperties(row, extras, companyPageId) {
  const props = {};

  // Title
  if (row.title) {
    props.Title = {
      title: [{ type: "text", text: { content: row.title } }],
    };
  }

  // Company relation
  if (companyPageId) {
    props.Company = {
      relation: [{ id: companyPageId }],
    };
  }

  // URL
  if (row.url) {
    props.URL = { url: row.url };
  }

  // Status (it's a status-type prop in the new DB)
  if (row.status) {
    props.Status = { status: { name: row.status } };
  }

  // Source (it's a select)
  if (extras.indeed_source) {
    props.Source = { select: { name: extras.indeed_source } };
  }

  // Resume Version (select)
  if (row.resume_ver) {
    props["Resume Version"] = { select: { name: row.resume_ver } };
  }

  // Cover Letter (rich_text — filename stem)
  if (row.cl_path) {
    const stem = path.basename(row.cl_path).replace(/\.(pdf|docx)$/i, "");
    props["Cover Letter"] = {
      rich_text: [{ type: "text", text: { content: stem } }],
    };
  }

  // Salary
  if (row.salary_min) {
    const n = Number(row.salary_min);
    if (Number.isFinite(n)) props["Salary Min"] = { number: n };
  }
  if (row.salary_max) {
    const n = Number(row.salary_max);
    if (Number.isFinite(n)) props["Salary Max"] = { number: n };
  }

  // Fit Score (select)
  if (extras.fit_score) {
    props["Fit Score"] = { select: { name: extras.fit_score } };
  }

  // Work Format (select)
  if (extras.work_format) {
    props["Work Format"] = { select: { name: extras.work_format } };
  }

  // Schedule + Requirements: prototype-only fields, NOT in new engine schema
  // (Jared and Lilia DBs both lack them). Preserved in .prototype_extras.json
  // for future reference. Skip silently here.

  // City (rich_text)
  if (extras.city) {
    props.City = {
      rich_text: [{ type: "text", text: { content: extras.city } }],
    };
  }

  // Notes (rich_text)
  if (extras.notes) {
    props.Notes = {
      rich_text: [{ type: "text", text: { content: extras.notes.slice(0, 2000) } }],
    };
  }

  return props;
}

async function main() {
  loadEnv();
  const args = parseArgs();
  banner("push_lilia_extras_to_notion", args);

  const { data: intake } = loadIntake(args.profile);
  const id = intake.identity.profile_id;
  const token = requireToken(id);
  const client = new Client({ auth: token, notionVersion: "2025-09-03" });

  const profile = JSON.parse(
    fs.readFileSync(path.join(profileDir(id), "profile.json"), "utf8")
  );
  const jobsDbId = profile.notion.jobs_pipeline_db_id;
  const companiesDbId = profile.notion.companies_db_id;
  const jobsDsId = await resolveDataSourceId(client, jobsDbId);
  const companiesDsId = await resolveDataSourceId(client, companiesDbId);

  const profileDirPath = profileDir(id);
  const appsPath = path.join(profileDirPath, "applications.tsv");
  const extrasPath = path.join(profileDirPath, ".prototype_extras.json");

  const { apps } = applications.load(appsPath);
  const extrasMap = fs.existsSync(extrasPath)
    ? JSON.parse(fs.readFileSync(extrasPath, "utf8"))
    : {};

  const protoRows = apps.filter((r) => r.source === "prototype");
  console.log(`  prototype rows: ${protoRows.length}`);
  console.log(`    with notion_page_id: ${protoRows.filter((r) => r.notion_page_id).length}`);
  console.log(`    without notion_page_id: ${protoRows.filter((r) => !r.notion_page_id).length}`);

  const resolveCompany = makeCompanyResolver(client, companiesDsId);

  let updates = 0;
  let creates = 0;
  let errors = 0;
  const errs = [];
  const newPageIds = new Map(); // key → page_id for newly created rows

  for (const row of protoRows) {
    const extras = extrasMap[row.key] || {};
    const companyPageId = await resolveCompany(row.companyName);

    if (!companyPageId && row.companyName) {
      console.log(`  warn: no company match for "${row.companyName}" — skipping relation`);
    }

    const props = buildPageProperties(row, extras, companyPageId);

    if (!args.apply) {
      if (row.notion_page_id) updates++;
      else creates++;
      continue;
    }

    try {
      if (row.notion_page_id) {
        await client.pages.update({
          page_id: row.notion_page_id,
          properties: props,
        });
        updates++;
      } else {
        const resp = await client.pages.create({
          parent: { type: "data_source_id", data_source_id: jobsDsId },
          properties: props,
        });
        newPageIds.set(row.key, resp.id);
        creates++;
      }
      if ((updates + creates) % 10 === 0) {
        console.log(`    progress: ${updates} updated, ${creates} created`);
      }
    } catch (e) {
      errors++;
      errs.push(`${row.key}: ${e.message}`);
    }
  }

  console.log(`\n  --- result ---`);
  console.log(`  updated: ${updates}`);
  console.log(`  created: ${creates}`);
  console.log(`  errors:  ${errors}`);
  if (errs.length) {
    console.log(`  first 5 errors:`);
    for (const e of errs.slice(0, 5)) console.log(`    ${e}`);
  }

  if (args.apply && newPageIds.size > 0) {
    // Persist new notion_page_ids back to TSV.
    const updated = apps.map((r) =>
      newPageIds.has(r.key) ? { ...r, notion_page_id: newPageIds.get(r.key), updatedAt: new Date().toISOString() } : r
    );
    applications.save(appsPath, updated);
    console.log(`  wrote ${newPageIds.size} new notion_page_id(s) back to TSV`);
  }

  done("push_lilia_extras_to_notion", { updated: updates, created: creates, errors });
}

if (require.main === module) {
  main().catch(fatal);
}

module.exports = { buildPageProperties };
