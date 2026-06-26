// `companies-upsert` command (RFC 062): push relokant-sweep sweet-zone targets
// into the per-profile Notion Companies DB, two-way deduped, fill-gaps.
//
// Reuses the same Notion path the job pipeline already uses to populate the
// Companies DB (lookup-or-create by name, `pages.create` with
// `parent: { database_id }`, data_source resolved via notion_sync). The
// difference vs company_resolver: relokant rows carry extra fields, dedup is by
// domain AND name, and existing pages are back-filled (empty fields only).
//
// Default mode is dry-run (prints the plan). `--apply` writes to Notion.
//
// Side effects live here; the create/fill/skip decision is the pure core in
// engine/core/companies_upsert.js.

const fs = require("fs");
const path = require("path");

const profileLoader = require("../core/profile_loader.js");
const { secretEnvName } = profileLoader;
const notion = require("../core/notion_sync.js");
const { resolveProfilesDir } = require("../core/paths.js");
const { planUpsert, buildKnownIndex } = require("../core/companies_upsert.js");

// ---- TSV readers (single I/O point; injectable for tests) ----

// Parse the 10-column relokant targets TSV into row objects keyed by header.
function readTargetsRows(targetsPath) {
  if (!targetsPath || !fs.existsSync(targetsPath)) return [];
  const text = fs.readFileSync(targetsPath, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length <= 1) return [];
  const header = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row = {};
    header.forEach((h, i) => {
      row[h] = (cells[i] || "").trim();
    });
    return row;
  });
}

// Read the first (name) column of a TSV, skipping the header. Missing file -> [].
function readNamesColumn(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length <= 1) return [];
  return lines.slice(1).map((line) => line.split("\t")[0]);
}

// ---- Notion property extraction / construction ----

// Read a Notion property's text value. Probed by shape in priority order; the
// Companies schema guarantees one shape per field (a field is title OR url OR
// rich_text OR select), so the order never masks a real value.
function extractText(prop) {
  if (!prop) return "";
  if (Array.isArray(prop.title)) return prop.title.map((t) => t.plain_text || "").join("");
  if (Array.isArray(prop.rich_text)) return prop.rich_text.map((t) => t.plain_text || "").join("");
  if (prop.url) return prop.url;
  if (prop.select && prop.select.name) return prop.select.name;
  return "";
}

// Turn a Notion page into the shape buildKnownIndex expects.
function pageToKnown(page) {
  const props = page.properties || {};
  const values = {};
  for (const field of ["Website", "Careers URL", "Why Interested", "Notes", "Outbound Status"]) {
    values[field] = extractText(props[field]);
  }
  return {
    pageId: page.id,
    name: extractText(props.Name),
    website: extractText(props.Website),
    values,
  };
}

function toNotionProp({ type, value }) {
  switch (type) {
    case "title":
      return { title: [{ text: { content: String(value) } }] };
    case "rich_text":
      return { rich_text: [{ text: { content: String(value) } }] };
    case "url":
      return { url: String(value) };
    case "select":
      return { select: { name: String(value) } };
    default:
      return { rich_text: [{ text: { content: String(value) } }] };
  }
}

function propsToNotion(propList) {
  const out = {};
  for (const p of propList) out[p.field] = toNotionProp(p);
  return out;
}

// Default Notion reader: page through the Companies data source.
async function fetchCompaniesPages(client, dataSourceId) {
  const pages = [];
  let cursor;
  do {
    const params = { data_source_id: dataSourceId, page_size: 100 };
    if (cursor) params.start_cursor = cursor;
    const resp = await client.dataSources.query(params);
    for (const page of resp.results || []) pages.push(page);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return pages;
}

const DEFAULT_DEPS = {
  loadProfile: profileLoader.loadProfile,
  loadSecrets: profileLoader.loadSecrets,
  makeClient: notion.makeClient,
  resolveDataSourceId: notion.resolveDataSourceId,
  readTargetsRows,
  readNamesColumn,
  fetchCompaniesPages,
};

function makeCompaniesUpsertCommand(overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };

  return async function companiesUpsertCommand(ctx) {
    const { profileId, flags, env, stdout, stderr } = ctx;
    const apply = Boolean(flags.apply);
    const profilesDir = resolveProfilesDir(ctx, env || process.env);
    // Resolve the shared companies.tsv the SAME way scan.js does (the writer of
    // that file): ctx.dataDir override, else <cwd>/data. Using the paths.js
    // AI_JOB_SEARCHER_DATA_DIR resolver here would diverge from where scan
    // actually writes the pool.
    const dataDir = ctx.dataDir || path.resolve(process.cwd(), "data");

    const profile = deps.loadProfile(profileId, { profilesDir });
    const secrets = deps.loadSecrets(profileId, env || process.env);
    const token = secrets.NOTION_TOKEN || null;
    const companiesDbId = profile.notion && profile.notion.companies_db_id;

    if (!companiesDbId) {
      stderr("error: profile.notion.companies_db_id is not configured");
      return 1;
    }

    // Candidate rows = relokant targets ledger.
    const root = profile.paths.root;
    const targetsPath = path.join(root, "ru_friendly_targets.tsv");
    const rejectsPath = path.join(root, "ru_friendly_rejects.tsv");
    const companiesTsvPath = path.join(dataDir, "companies.tsv");

    const rows = deps.readTargetsRows(targetsPath);
    if (!rows.length) {
      stdout("no relokant targets found — nothing to upsert.");
      return 0;
    }

    const ledgerNames = [
      ...deps.readNamesColumn(targetsPath),
      ...deps.readNamesColumn(rejectsPath),
    ];
    const tsvNames = deps.readNamesColumn(companiesTsvPath);

    // Notion read: the authoritative existing-pages source. Without a token we
    // cannot read Notion — degrade to tsv/ledger-only dedup and warn.
    let notionPages = [];
    let client = null;
    if (token) {
      try {
        client = deps.makeClient(token);
        const dataSourceId = await deps.resolveDataSourceId(client, companiesDbId);
        const pages = await deps.fetchCompaniesPages(client, dataSourceId);
        notionPages = pages.map(pageToKnown);
      } catch (err) {
        stderr(`error: failed to read Notion Companies DB: ${err.message}`);
        return 1;
      }
    } else {
      stderr(
        `warn: missing ${secretEnvName(profileId, "NOTION_TOKEN")} — Notion state unknown; ` +
          `plan computed against data/companies.tsv + relokant ledgers only.`
      );
    }

    const known = buildKnownIndex({ notionPages, tsvNames, ledgerNames });
    const { creates, fills, skips } = planUpsert({ rows, known });

    stdout(
      `plan: ${creates.length} to create, ${fills.length} to fill, ${skips.length} already there (skip)`
    );
    for (const c of creates) stdout(`  create: ${c.name}`);
    for (const f of fills) {
      stdout(`  fill:   ${f.name} (${f.props.map((p) => p.field).join(", ")})`);
    }

    if (!apply) {
      stdout("dry-run — no changes written. Re-run with --apply to commit.");
      return 0;
    }
    if (!token) {
      stderr(
        `warn: ${secretEnvName(profileId, "NOTION_TOKEN")} missing — --apply is a no-op. ` +
          `Add the token to .env and re-run.`
      );
      return 1;
    }

    let created = 0;
    let filled = 0;
    let errors = 0;
    for (const c of creates) {
      try {
        await client.pages.create({
          parent: { database_id: companiesDbId },
          properties: propsToNotion(c.props),
        });
        created++;
        stdout(`  created: ${c.name}`);
      } catch (err) {
        errors++;
        stderr(`  error creating ${c.name}: ${err.message}`);
      }
    }
    for (const f of fills) {
      try {
        await client.pages.update({
          page_id: f.pageId,
          properties: propsToNotion(f.props),
        });
        filled++;
        stdout(`  filled: ${f.name}`);
      } catch (err) {
        errors++;
        stderr(`  error filling ${f.name}: ${err.message}`);
      }
    }

    stdout(`done: created ${created}, filled ${filled}, errors ${errors}.`);
    return errors > 0 ? 1 : 0;
  };
}

module.exports = makeCompaniesUpsertCommand();
module.exports.makeCompaniesUpsertCommand = makeCompaniesUpsertCommand;
module.exports.readTargetsRows = readTargetsRows;
module.exports.readNamesColumn = readNamesColumn;
module.exports.pageToKnown = pageToKnown;
module.exports.propsToNotion = propsToNotion;
