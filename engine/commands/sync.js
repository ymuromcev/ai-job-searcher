// `sync` command: one-way pull from Notion → applications.tsv.
//
// Notion is the source of truth for status. This command fetches all pages
// from the per-profile Jobs Pipeline DB and reconciles local TSV rows by
// `key` (or composite source+jobId match): pulls new `notion_page_id` and
// `status` whenever Notion differs from local.
//
// Push is intentionally absent. Jobs reach Notion through `prepare` only
// (which generates CL, picks resume version, records fit score, and creates
// the page in one atomic step). A bare push from `sync` would create empty
// pages without any of that context. The legacy push phase + Stage 16
// `push_manifest.json` allow-list were removed 2026-05-04 — see
// `incidents.md` "Pool/TSV reconciliation gap" entry for context.
//
// Default mode is **dry-run** — prints planned changes without touching
// local TSV. `--apply` is required to commit any mutation.

const path = require("path");

const profileLoader = require("../core/profile_loader.js");
const { secretEnvName } = profileLoader;
const applications = require("../core/applications_tsv.js");
const notion = require("../core/notion_sync.js");
const { resolveProfilesDir } = require("../core/paths.js");

const DEFAULT_PROPERTY_MAP = {
  title: { field: "Title", type: "title" },
  companyRelation: { field: "Company", type: "relation" },
  source: { field: "Source", type: "select" },
  jobId: { field: "JobID", type: "rich_text" },
  url: { field: "URL", type: "url" },
  status: { field: "Status", type: "status" },
  key: { field: "Key", type: "rich_text" },
  fitScore: { field: "Fit Score", type: "select" },
  dateAdded: { field: "Date Added", type: "date" },
  workFormat: { field: "Work Format", type: "select" },
  city: { field: "City", type: "rich_text" },
  state: { field: "State", type: "rich_text" },
  notes: { field: "Notes", type: "rich_text" },
  salaryExpectations: { field: "Salary Expectations", type: "rich_text" },
  salaryMin: { field: "Salary Min", type: "number" },
  salaryMax: { field: "Salary Max", type: "number" },
  coverLetter: { field: "Cover Letter", type: "rich_text" },
  resumeVersion: { field: "Resume Version", type: "select" },
};

const DEFAULT_DEPS = {
  loadProfile: profileLoader.loadProfile,
  loadSecrets: profileLoader.loadSecrets,
  loadApplications: applications.load,
  saveApplications: applications.save,
  makeClient: notion.makeClient,
  fetchJobsFromDatabase: notion.fetchJobsFromDatabase,
  updateCalloutBlock: notion.updateCalloutBlock,
  now: () => new Date().toISOString(),
};

function reconcilePull(apps, notionPages, propertyMap) {
  // Notion is source of truth for status (and notion_page_id, naturally).
  // We match by `key` field if present in the Notion property map; otherwise
  // by composite (source, jobId).
  const keyField = propertyMap.key && propertyMap.key.field;
  const sourceField = propertyMap.source && propertyMap.source.field;
  const jobIdField = propertyMap.jobId && propertyMap.jobId.field;

  const byKey = new Map();
  for (const page of notionPages) {
    const k = keyField ? page.key : null;
    const composite =
      sourceField && jobIdField && page.source && page.jobId
        ? `${String(page.source).toLowerCase()}:${page.jobId}`
        : null;
    const matchKey = k || composite;
    if (matchKey) byKey.set(matchKey, page);
  }

  const updates = [];
  for (const app of apps) {
    const page = byKey.get(app.key);
    if (!page) continue;
    const next = { ...app };
    let changed = false;
    if (page.notionPageId && app.notion_page_id !== page.notionPageId) {
      next.notion_page_id = page.notionPageId;
      changed = true;
    }
    if (page.status && app.status !== page.status) {
      next.status = page.status;
      changed = true;
    }
    if (changed) updates.push({ before: app, after: next });
  }
  return updates;
}

function makeSyncCommand(overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };

  return async function syncCommand(ctx) {
    const { profileId, flags, env, stdout } = ctx;
    const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);

    const profile = deps.loadProfile(profileId, { profilesDir });
    const secrets = deps.loadSecrets(profileId, env);
    const databaseId = profile.notion && profile.notion.jobs_pipeline_db_id;
    const token = secrets.NOTION_TOKEN;

    if (!databaseId) {
      ctx.stderr(`error: profile.notion.jobs_pipeline_db_id is not configured`);
      return 1;
    }
    if (!token) {
      ctx.stderr(`error: missing ${secretEnvName(profileId, "NOTION_TOKEN")} in env`);
      return 1;
    }

    const propertyMap =
      (profile.notion && profile.notion.property_map) || DEFAULT_PROPERTY_MAP;

    const applicationsPath = path.join(profile.paths.root, "applications.tsv");
    const { apps } = deps.loadApplications(applicationsPath);

    // Build a keyed working set once. Pull mutates through this map; originals
    // in `apps` stay unmodified until we save.
    const byKey = new Map(apps.map((a) => [a.key, a]));

    let client = null;
    const getClient = () => {
      if (!client) client = deps.makeClient(token);
      return client;
    };

    // PULL phase always runs (read-only against Notion) so users see what
    // Notion state will land locally, whether they passed --apply or not.
    let pulled = [];
    let pullErrors = 0;
    try {
      const pages = await deps.fetchJobsFromDatabase(getClient(), databaseId, propertyMap);
      pulled = reconcilePull(apps, pages, propertyMap);
      stdout(`pull plan: ${pulled.length} local row(s) would change from Notion state`);
      for (const u of pulled.slice(0, 10)) {
        stdout(
          `  pull: ${u.before.key} | status ${u.before.status || "(none)"} → ${u.after.status || "(none)"}`
        );
      }
      if (pulled.length > 10) stdout(`  … and ${pulled.length - 10} more`);
    } catch (err) {
      pullErrors += 1;
      ctx.stderr(`  pull error: ${err.message}`);
    }

    if (!flags.apply) {
      stdout(`(dry-run — pass --apply to mutate TSV)`);
      return pullErrors > 0 ? 1 : 0;
    }

    // Apply pull updates into the keyed map, then save once.
    for (const u of pulled) {
      byKey.set(u.before.key, { ...u.after, updatedAt: deps.now() });
    }
    if (pulled.length) {
      const merged = Array.from(byKey.values());
      deps.saveApplications(applicationsPath, merged);
      stdout(
        `saved ${merged.length} applications to ${applicationsPath} ` +
          `(${pulled.length} updated from Notion)`
      );
    }

    // Update the hub callout counter if the profile has one configured.
    // Counts the **inbox**: fresh rows that haven't been pushed to Notion yet
    // (status="To Apply" + no notion_page_id). The label stays "Inbox" because
    // "To Apply" is the Notion *status* of cards already in the DB, while the
    // callout shows the pre-Notion staging queue — different concepts.
    //
    // Runs unconditionally on --apply (not just when rows changed) so the
    // "Updated:" timestamp stays accurate even if nothing changed this run.
    // Non-fatal: a missing callout or Notion error should not fail the sync.
    const calloutBlockId =
      profile.notion &&
      profile.notion.hub_layout &&
      profile.notion.hub_layout.inbox_callout_block_id;
    if (calloutBlockId) {
      try {
        const inboxCount = apps.filter(
          (a) => a.status === "To Apply" && !a.notion_page_id
        ).length;
        const today = deps.now().slice(0, 10);
        await deps.updateCalloutBlock(
          getClient(),
          calloutBlockId,
          `Inbox: ${inboxCount} | Updated: ${today}`
        );
        stdout(`hub callout: Inbox: ${inboxCount}`);
      } catch (err) {
        ctx.stderr(`  warn: hub callout update failed: ${err.message}`);
      }
    } else if (!flags.noCallout) {
      stdout(
        `hub callout: not configured — add notion.hub_layout.inbox_callout_block_id ` +
          `to profile.json to keep the hub counter current. ` +
          `Pass --no-callout to skip this message for this run.`
      );
    }

    return pullErrors > 0 ? 1 : 0;
  };
}

module.exports = makeSyncCommand();
module.exports.makeSyncCommand = makeSyncCommand;
module.exports.reconcilePull = reconcilePull;
module.exports.DEFAULT_PROPERTY_MAP = DEFAULT_PROPERTY_MAP;
