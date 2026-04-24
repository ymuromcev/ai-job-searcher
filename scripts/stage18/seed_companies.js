// seed_companies.js — bulk-insert target companies into the Companies DB.
//
// Reads profile.company_tiers (generated from intake §D) and creates one
// row per company with Tier set. Dedups against existing rows by Name.

const { Client } = require("@notionhq/client");

const {
  loadEnv,
  parseArgs,
  requireToken,
  banner,
  done,
  fatal,
  loadState,
  saveState,
  loadIntake,
} = require("./_common.js");
const path = require("path");
const fs = require("fs");
const { profileDir } = require("./_common.js");

async function resolveDataSourceId(client, databaseId) {
  const db = await client.databases.retrieve({ database_id: databaseId });
  const sources = Array.isArray(db.data_sources) ? db.data_sources : [];
  if (!sources.length) throw new Error(`no data_sources on ${databaseId}`);
  return sources[0].id;
}

// Index existing rows by Name (title), case-insensitive. Used for dedup
// so re-runs don't create duplicates if user ran seed partially before.
async function indexExistingByName(client, dataSourceId) {
  const byName = new Map();
  let cursor;
  do {
    const resp = await client.dataSources.query({
      data_source_id: dataSourceId,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const row of resp.results || []) {
      const title =
        (row.properties &&
          row.properties.Name &&
          row.properties.Name.title &&
          row.properties.Name.title.map((t) => t.plain_text).join("")) || "";
      if (title) byName.set(title.toLowerCase(), row.id);
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return byName;
}

async function main() {
  loadEnv();
  const args = parseArgs();
  banner("seed_companies", args);

  const { data: intake } = loadIntake(args.profile);
  const id = intake.identity.profile_id;

  // Short-circuit if user opted out.
  if (intake.flags && intake.flags.include_companies_seed === false) {
    console.log("  intake.flags.include_companies_seed is false — skipping seed.");
    done("seed_companies", { skipped: true });
    return;
  }

  const token = requireToken(id);
  const client = new Client({ auth: token });

  const { data: state } = loadState(id);
  const companiesDbId =
    (state.create_companies_db && state.create_companies_db.db_id) ||
    (() => {
      const pPath = path.join(profileDir(id), "profile.json");
      if (!fs.existsSync(pPath)) return null;
      const p = JSON.parse(fs.readFileSync(pPath, "utf8"));
      return (p.notion && p.notion.companies_db_id) || null;
    })();

  if (!companiesDbId) {
    fatal(new Error("companies_db_id unknown. Run create_companies_db.js first."));
  }

  const profilePath = path.join(profileDir(id), "profile.json");
  if (!fs.existsSync(profilePath)) {
    fatal(new Error(`profile.json not found at ${profilePath}. Run generators first.`));
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  const tiers = profile.company_tiers || {};
  const names = Object.keys(tiers);
  if (!names.length) {
    console.log("  no companies in profile.company_tiers — nothing to seed.");
    done("seed_companies", { created: 0, skipped: 0 });
    return;
  }

  const dsId = await resolveDataSourceId(client, companiesDbId);
  const existing = await indexExistingByName(client, dsId);
  console.log(`  existing rows in Companies DB: ${existing.size}`);

  let created = 0;
  let skipped = 0;
  for (const name of names) {
    if (existing.has(name.toLowerCase())) {
      skipped += 1;
      continue;
    }
    const tier = tiers[name];
    console.log(`  + ${name} [${tier}]`);
    if (!args.apply) {
      created += 1;
      continue;
    }
    await client.pages.create({
      parent: { data_source_id: dsId },
      properties: {
        Name: { title: [{ type: "text", text: { content: name } }] },
        Tier: { select: { name: tier } },
      },
    });
    created += 1;
  }

  if (args.apply) {
    state.seed_companies = { done: true, created, skipped, at: new Date().toISOString() };
    saveState(id, state);
  }

  done("seed_companies", { created, skipped });
}

if (require.main === module) {
  main().catch(fatal);
}

module.exports = {
  resolveDataSourceId,
  indexExistingByName,
};
