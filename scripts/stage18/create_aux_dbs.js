// create_aux_dbs.js — provision Application Q&A + Job Platforms DBs under
// the profile's workspace page. Mirrors Jared's hub layout (originally created
// by stage16/create_aux_dbs which was archived after Jared's cutover).
//
// Schemas are profile-generic (the "Roles Found" column is named generically,
// not PM-specific like Jared's legacy "PM Roles Found"). Job Platforms is
// seeded from profile.json.modules — one row per discovery:<adapter> module.
//
// Idempotent: state.create_aux_dbs.{qa_db_id, platforms_db_id} + adopt-by-title
// fallback. Existing rows in Job Platforms are deduped by Platform title before
// seeding.
//
// Run order: AFTER create_jobs_db.js (workspace_page_id must be persisted in
// profile.json by the deploy_profile orchestrator).
//
// Usage:
//   node scripts/stage18/create_aux_dbs.js --profile lilia
//   node scripts/stage18/create_aux_dbs.js --profile lilia --apply

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
  loadIntake,
  loadState,
  saveState,
  profileDir,
  extractNotionPageId,
} = require("./_common.js");
const { resolveDataSourceId } = require("../../engine/core/notion_sync.js");

// ---------------------------------------------------------------------------
// Schemas (profile-generic; safe to apply to any profile)
// ---------------------------------------------------------------------------

const QA_PROPERTIES = {
  Question: { type: "title", title: {} },
  Answer: { type: "rich_text", rich_text: {} },
  Category: {
    type: "select",
    select: {
      options: [
        { name: "Behavioral", color: "blue" },
        { name: "Technical", color: "purple" },
        { name: "Culture Fit", color: "green" },
        { name: "Logistics", color: "yellow" },
        { name: "Salary", color: "orange" },
        { name: "Motivation", color: "pink" },
        { name: "Experience", color: "red" },
        { name: "Other", color: "gray" },
      ],
    },
  },
  Company: { type: "rich_text", rich_text: {} },
  Role: { type: "rich_text", rich_text: {} },
  Notes: { type: "rich_text", rich_text: {} },
};

const PLATFORMS_PROPERTIES = {
  Platform: { type: "title", title: {} },
  Type: {
    type: "select",
    select: {
      options: [
        { name: "ATS", color: "blue" },
        { name: "Job Board", color: "green" },
        { name: "Aggregator", color: "yellow" },
        { name: "Government", color: "red" },
      ],
    },
  },
  Status: {
    type: "select",
    select: {
      options: [
        { name: "Active", color: "green" },
        { name: "Paused", color: "yellow" },
        { name: "Disabled", color: "gray" },
        { name: "Planned", color: "blue" },
      ],
    },
  },
  "API URL Template": { type: "rich_text", rich_text: {} },
  "Companies Count": { type: "number", number: { format: "number" } },
  "Roles Found": { type: "number", number: { format: "number" } },
  "Last Scan": { type: "date", date: {} },
  Notes: { type: "rich_text", rich_text: {} },
};

// ---------------------------------------------------------------------------
// Adapter → Platforms row mapping. Used to seed Job Platforms.
// ---------------------------------------------------------------------------

const ADAPTER_PRESETS = {
  greenhouse: {
    name: "Greenhouse",
    type: "ATS",
    apiTemplate: "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs",
  },
  lever: {
    name: "Lever",
    type: "ATS",
    apiTemplate: "https://api.lever.co/v0/postings/{slug}?mode=json",
  },
  ashby: {
    name: "Ashby",
    type: "ATS",
    apiTemplate: "https://api.ashbyhq.com/posting-api/job-board/{slug}",
  },
  smartrecruiters: {
    name: "SmartRecruiters",
    type: "ATS",
    apiTemplate:
      "https://api.smartrecruiters.com/v1/companies/{slug}/postings",
  },
  workday: {
    name: "Workday",
    type: "ATS",
    apiTemplate: "https://{tenant}.wd1.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs",
  },
  remoteok: {
    name: "RemoteOK",
    type: "Aggregator",
    apiTemplate: "https://remoteok.com/api",
  },
  usajobs: {
    name: "USAJOBS",
    type: "Government",
    apiTemplate: "https://data.usajobs.gov/api/Search",
  },
  calcareers: {
    name: "CalCareers",
    type: "Government",
    apiTemplate: "https://www.calcareers.ca.gov/CalHrPublic/Jobs/JobSearchResults.aspx",
  },
  indeed: {
    name: "Indeed",
    type: "Aggregator",
    apiTemplate: "(scraping; not yet implemented — see BACKLOG)",
  },
};

function modulesToPlatformRows(modules) {
  if (!Array.isArray(modules)) return [];
  const rows = [];
  for (const m of modules) {
    const match = String(m).match(/^discovery:([a-z0-9_]+)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const preset = ADAPTER_PRESETS[key];
    if (!preset) continue;
    rows.push({
      Platform: preset.name,
      Type: preset.type,
      Status: "Active",
      "API URL Template": preset.apiTemplate,
      Notes: `Discovery adapter (engine/modules/discovery/${key}.js)`,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Notion helpers
// ---------------------------------------------------------------------------

function qaTitle(intake) {
  const name = (intake.identity && intake.identity.full_name) || intake.identity.profile_id;
  return `${name} — Application Q&A`;
}

function platformsTitle(intake) {
  const name = (intake.identity && intake.identity.full_name) || intake.identity.profile_id;
  return `${name} — Job Platforms`;
}

async function databaseExists(client, id) {
  try {
    await client.databases.retrieve({ database_id: id });
    return true;
  } catch (err) {
    if (err && err.code === "object_not_found") return false;
    throw err;
  }
}

async function findDbByTitle(client, parentPageId, title) {
  let cursor;
  do {
    const resp = await client.blocks.children.list({
      block_id: parentPageId,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const block of resp.results || []) {
      if (
        block.type === "child_database" &&
        block.child_database &&
        block.child_database.title === title
      ) {
        return block.id;
      }
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return null;
}

async function createDb(client, parentPageId, title, properties, description) {
  return client.databases.create({
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: title } }],
    description: description
      ? [{ type: "text", text: { content: description } }]
      : undefined,
    is_inline: false,
    initial_data_source: { properties },
  });
}

async function ensureDb(client, parentPageId, title, properties, description, args, stateField) {
  const { data: state } = loadState(args.profile);
  state.create_aux_dbs = state.create_aux_dbs || {};

  let id = state.create_aux_dbs[stateField];

  if (id && !(await databaseExists(client, id))) {
    console.log(`    state.${stateField} ${id} is stale (404). Will re-adopt or re-create.`);
    id = null;
  }

  if (!id) {
    const byTitle = await findDbByTitle(client, parentPageId, title);
    if (byTitle) {
      console.log(`    adopting existing DB by title "${title}" → ${byTitle}`);
      id = byTitle;
    }
  }

  if (!id) {
    console.log(`    will create "${title}" (${Object.keys(properties).length} props) under ${parentPageId}`);
    if (!args.apply) return { id: "<dry-run>", created: true };
    const resp = await createDb(client, parentPageId, title, properties, description);
    id = resp.id;
    console.log(`    created: ${id}`);
  } else {
    console.log(`    [${stateField}] reusing ${id}`);
  }

  if (args.apply) {
    state.create_aux_dbs[stateField] = id;
    saveState(args.profile, state);
  }

  return { id, created: false };
}

// ---------------------------------------------------------------------------
// Seeding Job Platforms
// ---------------------------------------------------------------------------

async function existingPlatformTitles(client, dataSourceId) {
  const seen = new Set();
  let cursor;
  do {
    const resp = await client.dataSources.query({
      data_source_id: dataSourceId,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const page of resp.results || []) {
      const title = page.properties && page.properties.Platform;
      if (title && title.title && title.title[0]) {
        seen.add(title.title[0].plain_text || title.title[0].text?.content);
      }
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return seen;
}

function buildPlatformPageProperties(row) {
  return {
    Platform: { title: [{ type: "text", text: { content: row.Platform } }] },
    Type: { select: { name: row.Type } },
    Status: { select: { name: row.Status } },
    "API URL Template": {
      rich_text: [{ type: "text", text: { content: row["API URL Template"] || "" } }],
    },
    Notes: {
      rich_text: [{ type: "text", text: { content: row.Notes || "" } }],
    },
  };
}

async function seedPlatforms(client, dataSourceId, rows, apply) {
  const existing = await existingPlatformTitles(client, dataSourceId);
  const toCreate = rows.filter((r) => !existing.has(r.Platform));
  console.log(
    `    platforms to seed: ${toCreate.length} (skipping ${rows.length - toCreate.length} already present)`
  );

  if (!apply) {
    for (const r of toCreate) console.log(`      + ${r.Platform} [${r.Type}]`);
    return { seeded: 0, skipped: rows.length - toCreate.length };
  }

  let seeded = 0;
  for (const row of toCreate) {
    await client.pages.create({
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties: buildPlatformPageProperties(row),
    });
    console.log(`      + ${row.Platform} [${row.Type}]`);
    seeded++;
  }
  return { seeded, skipped: rows.length - toCreate.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();
  const args = parseArgs();
  banner("create_aux_dbs", args);

  const { data: intake } = loadIntake(args.profile);
  const id = intake.identity.profile_id;
  const token = requireToken(id);
  const client = new Client({ auth: token, notionVersion: "2025-09-03" });

  const profilePath = path.join(profileDir(id), "profile.json");
  if (!fs.existsSync(profilePath)) {
    fatal(new Error(`profile.json not found at ${profilePath}. Run deploy_profile.js first.`));
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));

  // Prefer profile.json.notion.workspace_page_id (set by deploy_profile);
  // fall back to intake.notion.parent_page_url for first-run scenarios.
  const workspacePageId =
    (profile.notion && profile.notion.workspace_page_id) ||
    (intake.notion && intake.notion.parent_page_url
      ? extractNotionPageId(intake.notion.parent_page_url)
      : null);
  if (!workspacePageId) {
    fatal(new Error("workspace_page_id missing — run deploy_profile.js first"));
  }

  console.log(`  workspace_page_id: ${workspacePageId}`);

  // --- Q&A DB ---
  console.log("\n  --- Application Q&A DB ---");
  const qaResult = await ensureDb(
    client,
    workspacePageId,
    qaTitle(intake),
    QA_PROPERTIES,
    "Curated Q&A bank for application-form questions. One row per question; reuse Answers across roles.",
    args,
    "qa_db_id"
  );

  // --- Job Platforms DB ---
  console.log("\n  --- Job Platforms DB ---");
  const platformsResult = await ensureDb(
    client,
    workspacePageId,
    platformsTitle(intake),
    PLATFORMS_PROPERTIES,
    "Discovery adapters / sources tracked by the engine. Seeded from profile.json.modules.",
    args,
    "platforms_db_id"
  );

  // --- Persist to profile.json ---
  if (args.apply) {
    profile.notion = profile.notion || {};
    profile.notion.application_qa_db_id = qaResult.id;
    profile.notion.job_platforms_db_id = platformsResult.id;
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + "\n");
    console.log(`\n  [profile.json] application_qa_db_id = ${qaResult.id}`);
    console.log(`  [profile.json] job_platforms_db_id = ${platformsResult.id}`);
  }

  // --- Seed platforms ---
  console.log("\n  --- seeding platforms ---");
  const platformRows = modulesToPlatformRows(profile.modules || []);
  console.log(`    candidate rows from modules: ${platformRows.length}`);

  let seedResult = { seeded: 0, skipped: 0 };
  if (args.apply && platformsResult.id !== "<dry-run>") {
    const platformsDsId = await resolveDataSourceId(client, platformsResult.id);
    seedResult = await seedPlatforms(client, platformsDsId, platformRows, true);
  } else {
    console.log("    [dry-run] would seed:");
    for (const r of platformRows) console.log(`      + ${r.Platform} [${r.Type}]`);
  }

  done("create_aux_dbs", {
    qa_db_id: qaResult.id,
    platforms_db_id: platformsResult.id,
    platforms_seeded: seedResult.seeded,
    platforms_skipped: seedResult.skipped,
  });
}

if (require.main === module) {
  main().catch(fatal);
}

module.exports = {
  QA_PROPERTIES,
  PLATFORMS_PROPERTIES,
  ADAPTER_PRESETS,
  modulesToPlatformRows,
  buildPlatformPageProperties,
  qaTitle,
  platformsTitle,
};
