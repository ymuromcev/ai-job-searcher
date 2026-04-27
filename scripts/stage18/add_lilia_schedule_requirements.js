// add_lilia_schedule_requirements.js — one-shot tool, Stage 8 follow-up.
//
// Why this exists: Lilia's prototype intake captured Schedule + Requirements
// for healthcare/dental jobs (e.g. "Mon-Fri Day", "HS diploma typical").
// These are healthcare-specific and we deliberately did NOT add them to the
// generic engine schema (Jared's PM pipeline doesn't need them). Instead, we
// extend Lilia's Jobs DB only.
//
// Three steps, all idempotent, all gated by --apply:
//   1. Add `Schedule` (select with 4 known options) and `Requirements`
//      (rich_text) to Lilia's Jobs data source.
//   2. Add `schedule` + `requirements` keys to profile.json.notion.property_map.
//   3. Backfill existing pages from .prototype_extras.json (89 with reqs,
//      67 with schedule).
//
// Usage:
//   node scripts/stage18/add_lilia_schedule_requirements.js --profile lilia
//   node scripts/stage18/add_lilia_schedule_requirements.js --profile lilia --apply

const fs = require("fs");
const path = require("path");
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

const SCHEDULE_OPTIONS = [
  { name: "Mon-Fri Day", color: "blue" },
  { name: "Mon-Fri Flexible", color: "green" },
  { name: "Shift Work", color: "yellow" },
  { name: "Unknown Schedule", color: "gray" },
];

async function ensureSchema(client, dsId, apply) {
  const ds = await client.dataSources.retrieve({ data_source_id: dsId });
  const hasSchedule = "Schedule" in ds.properties;
  const hasRequirements = "Requirements" in ds.properties;

  console.log(`  Schedule prop:     ${hasSchedule ? "present (skip)" : "MISSING — will add"}`);
  console.log(`  Requirements prop: ${hasRequirements ? "present (skip)" : "MISSING — will add"}`);

  if (hasSchedule && hasRequirements) return { added: 0 };

  const properties = {};
  if (!hasSchedule) {
    properties.Schedule = { select: { options: SCHEDULE_OPTIONS } };
  }
  if (!hasRequirements) {
    properties.Requirements = { rich_text: {} };
  }

  if (!apply) {
    console.log(`  [dry-run] would dataSources.update with:`);
    for (const k of Object.keys(properties)) console.log(`    + ${k}`);
    return { added: Object.keys(properties).length };
  }

  await client.dataSources.update({
    data_source_id: dsId,
    properties,
  });
  console.log(`  ✓ added ${Object.keys(properties).join(" + ")} to data source`);
  return { added: Object.keys(properties).length };
}

function ensurePropertyMap(profilePath, apply) {
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  const pm = profile.notion.property_map;
  const adds = [];
  if (!pm.schedule) {
    adds.push("schedule");
  }
  if (!pm.requirements) {
    adds.push("requirements");
  }

  if (adds.length === 0) {
    console.log(`  property_map already has schedule + requirements (skip)`);
    return { added: 0 };
  }

  console.log(`  property_map missing: ${adds.join(", ")}`);

  if (!apply) {
    console.log(`  [dry-run] would patch profile.json with new keys`);
    return { added: adds.length };
  }

  if (!pm.schedule) {
    pm.schedule = { field: "Schedule", type: "select" };
  }
  if (!pm.requirements) {
    pm.requirements = { field: "Requirements", type: "rich_text" };
  }
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + "\n");
  console.log(`  ✓ patched profile.json (added ${adds.join(" + ")})`);
  return { added: adds.length };
}

function planRowUpdate(row, extras) {
  const props = {};
  if (extras.schedule) {
    props.Schedule = { select: { name: extras.schedule } };
  }
  if (extras.requirements) {
    props.Requirements = {
      rich_text: [{ type: "text", text: { content: String(extras.requirements).slice(0, 2000) } }],
    };
  }
  return props;
}

async function backfillPages(client, profileDirPath, apply) {
  const appsPath = path.join(profileDirPath, "applications.tsv");
  const extrasPath = path.join(profileDirPath, ".prototype_extras.json");

  const { apps } = applications.load(appsPath);
  const extrasMap = fs.existsSync(extrasPath)
    ? JSON.parse(fs.readFileSync(extrasPath, "utf8"))
    : {};

  const candidates = apps.filter(
    (r) => r.notion_page_id && (extrasMap[r.key]?.schedule || extrasMap[r.key]?.requirements)
  );

  let withSchedule = 0;
  let withRequirements = 0;
  for (const r of candidates) {
    const e = extrasMap[r.key] || {};
    if (e.schedule) withSchedule++;
    if (e.requirements) withRequirements++;
  }

  console.log(`  candidates with notion_page_id: ${candidates.length}`);
  console.log(`    with schedule:     ${withSchedule}`);
  console.log(`    with requirements: ${withRequirements}`);

  if (!apply) {
    console.log(`  [dry-run] would call pages.update on ${candidates.length} pages`);
    return { patched: 0, errors: 0 };
  }

  let patched = 0;
  let errors = 0;
  const errs = [];

  for (const row of candidates) {
    const extras = extrasMap[row.key] || {};
    const props = planRowUpdate(row, extras);
    if (Object.keys(props).length === 0) continue;
    try {
      await client.pages.update({
        page_id: row.notion_page_id,
        properties: props,
      });
      patched++;
      if (patched % 10 === 0) console.log(`    progress: ${patched}/${candidates.length}`);
    } catch (e) {
      errors++;
      errs.push(`${row.key}: ${e.message}`);
    }
  }

  console.log(`  ✓ patched ${patched}, errors ${errors}`);
  if (errs.length) {
    console.log(`  first 5 errors:`);
    for (const e of errs.slice(0, 5)) console.log(`    ${e}`);
  }

  return { patched, errors };
}

async function main() {
  loadEnv();
  const args = parseArgs();
  banner("add_lilia_schedule_requirements", args);

  const { data: intake } = loadIntake(args.profile);
  const id = intake.identity.profile_id;
  if (id !== "lilia") {
    fatal("This script is healthcare-specific and only runs for --profile lilia");
  }

  const token = requireToken(id);
  const client = new Client({ auth: token, notionVersion: "2025-09-03" });

  const profileDirPath = profileDir(id);
  const profilePath = path.join(profileDirPath, "profile.json");
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  const dbId = profile.notion.jobs_pipeline_db_id;
  const dsId = await resolveDataSourceId(client, dbId);

  console.log(`\n[1/3] schema check (data_source_id=${dsId})`);
  const schemaResult = await ensureSchema(client, dsId, args.apply);

  console.log(`\n[2/3] property_map check`);
  const pmResult = ensurePropertyMap(profilePath, args.apply);

  console.log(`\n[3/3] page backfill`);
  const backfillResult = await backfillPages(client, profileDirPath, args.apply);

  console.log(`\n  --- summary ---`);
  console.log(`  schema props added:    ${schemaResult.added}`);
  console.log(`  property_map keys:     ${pmResult.added}`);
  console.log(`  pages patched:         ${backfillResult.patched}`);
  console.log(`  page-level errors:     ${backfillResult.errors}`);

  done("add_lilia_schedule_requirements", {
    schemaAdded: schemaResult.added,
    propertyMapAdded: pmResult.added,
    pagesPatched: backfillResult.patched,
    pageErrors: backfillResult.errors,
  });
}

if (require.main === module) {
  main().catch(fatal);
}

module.exports = { ensureSchema, ensurePropertyMap, planRowUpdate, backfillPages, SCHEDULE_OPTIONS };
