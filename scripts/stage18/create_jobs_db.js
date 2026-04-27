// create_jobs_db.js — provision the Jobs pipeline DB under workspace page.
//
// Run order: AFTER create_companies_db.js (Jobs DB has a Company relation).
// Idempotent: reuses state.create_jobs_db.db_id, adopts by title, or creates.

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
const { resolvePropertyMap, toNotionSchema } = require("./property_map.js");
const { resolveDataSourceId } = require("../../engine/core/notion_sync.js");

function jobsDbTitle(intake) {
  const name = (intake.identity && intake.identity.full_name) || intake.identity.profile_id;
  return `${name} — Jobs Pipeline`;
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

// Inject the actual Companies data_source_id into the schema wherever a
// relation has the __COMPANIES_DB__ placeholder.
//
// Notion SDK v5 requires `data_source_id` (not `database_id`) for relation
// properties at DB-create time. The caller must resolve the Companies DB's
// data_source_id via engine/core/notion_sync.resolveDataSourceId and pass it
// here — otherwise Notion returns 400 "data_source_id should be defined".
function injectCompaniesDbId(schema, companiesDataSourceId) {
  const out = {};
  for (const [field, body] of Object.entries(schema)) {
    if (body.type === "relation" && body.relation && body.relation.database_id === "__COMPANIES_DB__") {
      out[field] = {
        type: "relation",
        relation: {
          data_source_id: companiesDataSourceId,
          // single_property = regular one-way relation (no back-ref). Matches
          // the default Notion UI creates.
          type: "single_property",
          single_property: {},
        },
      };
      continue;
    }
    out[field] = body;
  }
  return out;
}

async function createDb(client, parentPageId, title, properties) {
  return client.databases.create({
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: title } }],
    description: [
      { type: "text", text: { content: "Applications pipeline. Created by Stage 18 wizard." } },
    ],
    is_inline: false,
    initial_data_source: { properties },
  });
}

async function main() {
  loadEnv();
  const args = parseArgs();
  banner("create_jobs_db", args);

  const { data: intake } = loadIntake(args.profile);
  const id = intake.identity.profile_id;
  const token = requireToken(id);
  const client = new Client({ auth: token });

  const workspacePageId = extractNotionPageId(intake.notion.parent_page_url);
  const title = jobsDbTitle(intake);

  // Resolve the Companies DB id — prefer state, fall back to profile.json.
  const { data: state } = loadState(id);
  state.create_jobs_db = state.create_jobs_db || {};

  let companiesDbId = state.create_companies_db && state.create_companies_db.db_id;
  if (!companiesDbId) {
    const profilePath = path.join(profileDir(id), "profile.json");
    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
      companiesDbId = profile.notion && profile.notion.companies_db_id;
    }
  }
  if (!companiesDbId && args.apply) {
    fatal(new Error(
      "Companies DB id unknown. Run create_companies_db.js --apply first."
    ));
  }

  const propertyMap = resolvePropertyMap(intake);
  const baseSchema = toNotionSchema(propertyMap);
  // Notion SDK v5 requires data_source_id (not database_id) for relation props
  // at DB-create time. Resolve the Companies DB's data_source_id before
  // injecting it into the schema.
  const companiesDataSourceId = companiesDbId
    ? await resolveDataSourceId(client, companiesDbId)
    : null;
  const schema = companiesDataSourceId
    ? injectCompaniesDbId(baseSchema, companiesDataSourceId)
    : baseSchema;

  let dbId = state.create_jobs_db.db_id;

  if (dbId && !(await databaseExists(client, dbId))) {
    console.log(`  state.jobs_db_id ${dbId} is stale (404). Will re-adopt or re-create.`);
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
    console.log(`  will create "${title}" (${Object.keys(propertyMap).length} properties) under ${workspacePageId}`);
    if (!args.apply) {
      done("create_jobs_db", { db_id: "<dry-run>" });
      return;
    }
    const resp = await createDb(client, workspacePageId, title, schema);
    dbId = resp.id;
    console.log(`  created: ${dbId}`);
  } else {
    console.log(`  [jobs_db_id] reusing ${dbId}`);
  }

  if (args.apply) {
    state.create_jobs_db = { done: true, db_id: dbId, title };
    saveState(id, state);
    const profilePath = path.join(profileDir(id), "profile.json");
    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
      profile.notion = profile.notion || {};
      profile.notion.jobs_pipeline_db_id = dbId;
      fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + "\n");
      console.log(`  [profile.json] jobs_pipeline_db_id = ${dbId}`);
    }
  }

  done("create_jobs_db", { db_id: dbId });
}

if (require.main === module) {
  main().catch(fatal);
}

module.exports = {
  jobsDbTitle,
  injectCompaniesDbId,
  findDbByTitle,
  databaseExists,
};
