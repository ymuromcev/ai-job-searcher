// create_companies_db.js — provision the Companies DB under workspace page.
//
// Run order: BEFORE create_jobs_db.js (Jobs relates to Companies).
// Idempotent: if profile.notion.companies_db_id already set and the DB
// exists, skip. Otherwise walk workspace children for a child_database
// titled "<Profile Name> — Companies" and adopt it; if still nothing, create.

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

// Schema — mirrors the Companies DB Jared ended up with after Stage 16.
// Industry is multi_select (prototype is multi). HQ Location relation skipped.
const COMPANIES_PROPERTIES = {
  Name: { type: "title", title: {} },
  Tier: {
    type: "select",
    select: {
      options: [
        { name: "S", color: "red" },
        { name: "A", color: "orange" },
        { name: "B", color: "yellow" },
        { name: "C", color: "gray" },
      ],
    },
  },
  Industry: {
    type: "multi_select",
    multi_select: { options: [] }, // populated organically as companies are added
  },
  Website: { type: "url", url: {} },
  "Careers URL": { type: "url", url: {} },
  "Company Size": {
    type: "select",
    select: {
      options: [
        { name: "Startup", color: "green" },
        { name: "Scaleup", color: "blue" },
        { name: "Mid", color: "purple" },
        { name: "Enterprise", color: "orange" },
      ],
    },
  },
  "Remote Policy": {
    type: "select",
    select: {
      options: [
        { name: "Remote-first", color: "green" },
        { name: "Hybrid", color: "yellow" },
        { name: "Onsite", color: "orange" },
        { name: "Unknown", color: "gray" },
      ],
    },
  },
  "Why Interested": { type: "rich_text", rich_text: {} },
  Notes: { type: "rich_text", rich_text: {} },
};

function companiesDbTitle(intake) {
  const name = (intake.identity && intake.identity.full_name) || intake.identity.profile_id;
  return `${name} — Companies`;
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
      if (block.type === "child_database" &&
          block.child_database &&
          block.child_database.title === title) {
        return block.id;
      }
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return null;
}

async function createDb(client, parentPageId, title, properties) {
  // Notion SDK v5 requires initial_data_source.properties (not top-level).
  // See incidents in Stage 16.
  return client.databases.create({
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: title } }],
    description: [
      { type: "text", text: { content: "Target companies — tiered and enriched. Created by Stage 18 wizard." } },
    ],
    is_inline: false,
    initial_data_source: { properties },
  });
}

async function main() {
  loadEnv();
  const args = parseArgs();
  banner("create_companies_db", args);

  const { data: intake } = loadIntake(args.profile);
  const id = intake.identity.profile_id;
  if (!id) fatal(new Error("intake.identity.profile_id missing"));

  const token = requireToken(id);
  const client = new Client({ auth: token });

  const workspacePageId = extractNotionPageId(intake.notion.parent_page_url);
  const title = companiesDbTitle(intake);

  // Load prior state.
  const { data: state } = loadState(id);
  state.create_companies_db = state.create_companies_db || {};

  let dbId = state.create_companies_db.db_id;

  if (dbId && !(await databaseExists(client, dbId))) {
    console.log(`  state.companies_db_id ${dbId} is stale (404). Will re-adopt or re-create.`);
    dbId = null;
  }

  if (!dbId) {
    const byTitle = await findDbByTitle(client, workspacePageId, title);
    if (byTitle) {
      console.log(`  adopting existing DB by title "${title}" → ${byTitle}`);
      dbId = byTitle;
    }
  }

  if (!dbId) {
    console.log(`  will create "${title}" under ${workspacePageId}`);
    if (!args.apply) {
      done("create_companies_db", { db_id: "<dry-run>" });
      return;
    }
    const resp = await createDb(client, workspacePageId, title, COMPANIES_PROPERTIES);
    dbId = resp.id;
    console.log(`  created: ${dbId}`);
  } else {
    console.log(`  [companies_db_id] reusing ${dbId}`);
  }

  if (args.apply) {
    state.create_companies_db = { done: true, db_id: dbId, title };
    saveState(id, state);
    // Also write into profile.json if it already exists (post-generate step).
    const profilePath = path.join(profileDir(id), "profile.json");
    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
      profile.notion = profile.notion || {};
      profile.notion.companies_db_id = dbId;
      fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + "\n");
      console.log(`  [profile.json] companies_db_id = ${dbId}`);
    }
  }

  done("create_companies_db", { db_id: dbId });
}

if (require.main === module) {
  main().catch(fatal);
}

module.exports = {
  COMPANIES_PROPERTIES,
  companiesDbTitle,
  databaseExists,
  findDbByTitle,
};
