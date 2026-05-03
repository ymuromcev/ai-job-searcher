// `sync` command: bidirectional reconcile between profile applications.tsv
// and the per-profile Notion jobs pipeline database.
//
//   PUSH:  apps with notion_page_id="" → create Notion page, persist id locally.
//   PULL:  fetch Notion pages → for any (source, jobId) match, update local
//          status / notion_page_id from Notion (Notion wins on status).
//
// Default mode is **dry-run** — prints planned changes without touching Notion
// or local TSV. `--apply` is required to commit any mutation.

const path = require("path");
const fs = require("fs");

const profileLoader = require("../core/profile_loader.js");
const { secretEnvName } = profileLoader;
const applications = require("../core/applications_tsv.js");
const notion = require("../core/notion_sync.js");
const { makeCompanyResolver } = require("../core/company_resolver.js");
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
  createJobPage: notion.createJobPage,
  fetchJobsFromDatabase: notion.fetchJobsFromDatabase,
  resolveDataSourceId: notion.resolveDataSourceId,
  updateCalloutBlock: notion.updateCalloutBlock,
  makeCompanyResolver,
  now: () => new Date().toISOString(),
};

// Transforms an applications.tsv row into a shape matching the Notion
// property_map. Only fields that should be written on push are included;
// buildProperties drops undefined keys, so absent data stays absent on Notion.
//
// canonicalArchetypes (optional Set): when provided, throws if app.resume_ver
// is set to a value outside the set. Refuses to re-pollute the Notion select
// dropdown the way pre-2026-04-30 mass-migration did (58 garbage options on
// 259 pages). Caller builds the Set from profile.resumeVersions.versions keys.
function appToNotionJob(app, companyRelationId, canonicalArchetypes) {
  const out = {
    title: app.title,
    source: app.source,
    jobId: app.jobId,
    url: app.url,
    status: app.status,
    key: app.key,
  };
  if (companyRelationId) out.companyRelation = [companyRelationId];
  if (app.resume_ver) {
    if (
      canonicalArchetypes &&
      canonicalArchetypes.size > 0 &&
      !canonicalArchetypes.has(app.resume_ver)
    ) {
      throw new Error(
        `non-canonical resume_ver "${app.resume_ver}" for ${app.key || "(no key)"}; ` +
          `expected one of: ${[...canonicalArchetypes].sort().join(", ")}`
      );
    }
    out.resumeVersion = app.resume_ver;
  }
  if (app.salary_min) {
    const n = Number(app.salary_min);
    if (Number.isFinite(n)) out.salaryMin = n;
  }
  if (app.salary_max) {
    const n = Number(app.salary_max);
    if (Number.isFinite(n)) out.salaryMax = n;
  }
  // TSV stores only Min/Max numbers; the display string for Notion's
  // "Salary Expectations" rich_text is derived on push so we don't need a
  // separate column. Skipped when either bound is missing — partial ranges
  // would render as "$0-190K (95K mid)" which is worse than empty.
  if (Number.isFinite(out.salaryMin) && Number.isFinite(out.salaryMax)) {
    const mid =
      Math.round((out.salaryMin + out.salaryMax) / 2 / 1000) * 1000;
    out.salaryExpectations =
      `$${out.salaryMin / 1000}-${out.salaryMax / 1000}K ` +
      `($${mid / 1000}K mid)`;
  }
  if (app.cl_path) out.coverLetter = app.cl_path;
  return out;
}

// 8-status set used by both Jared and Lilia DBs:
//   To Apply / Applied / Interview / Offer / Rejected / Closed / No Response / Archived
// Push step skips already-archived rows (terminal state, not worth touching).
// Inbox = local-only staging status (not yet through `prepare`). Notion has no
// "Inbox" option and these rows are not ready to be tracked there yet.
const PUSH_SKIP_STATUSES = new Set(["Archived", "Inbox"]);

// Stage 16 opt-in gate: if a push manifest is present, only its keys are
// eligible for push. Used during prototype→new-engine migration so TSV-only
// rows (archived / never-synced) don't leak into the new Notion DB.
//
// Behaviour on errors:
//   - missing file       → null (gate disabled; push all)
//   - corrupt JSON       → throws (fail closed: better to block a push than
//                           silently push everything; could indicate tampering
//                           or a broken migration script)
//   - wrong shape        → throws (same reason)
function readPushManifest(profileRoot) {
  const p = path.join(profileRoot, ".stage16", "push_manifest.json");
  if (!fs.existsSync(p)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    throw new Error(
      `push manifest at ${p} is not valid JSON (${err.message}). ` +
        `Delete it or regenerate via scripts/stage16/migrate_tsv_from_prototype.js.`
    );
  }
  if (!raw || !Array.isArray(raw.keys)) {
    throw new Error(
      `push manifest at ${p} is missing a "keys" array. ` +
        `Delete it or regenerate via scripts/stage16/migrate_tsv_from_prototype.js.`
    );
  }
  return { path: p, keys: new Set(raw.keys) };
}

// Push gate: every non-archived row without a Notion page id is eligible.
// Raw Inbox rows (no cl_key / resume_ver) are included so that Notion always
// reflects the full pipeline — the Inbox counter in the hub page is the live
// DB view, not a static callout. Prepared rows (To Apply+) carry the full
// field set; Inbox rows carry only the base fields (title, company, URL,
// source, status). Both are valid Notion pages.
//
// Prerequisite: the Notion Jobs Pipeline DB must have "Inbox" as a Status
// option. Add it manually in the Notion UI if it is missing.
function planPush(apps, options = {}) {
  const allowed = options.allowKeys instanceof Set ? options.allowKeys : null;
  return apps.filter((a) => {
    if (a.notion_page_id) return false;
    if (PUSH_SKIP_STATUSES.has(a.status)) return false;
    if (allowed && !allowed.has(a.key)) return false;
    return true;
  });
}

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

    // Canonical archetype gate: build the Set once from the profile's
    // resume_versions.json. appToNotionJob throws if a TSV row carries a
    // resume_ver outside this set, blocking a push that would re-pollute
    // the Notion select dropdown. Empty set → no gate (e.g. profile has no
    // resume_versions configured).
    const canonicalArchetypes = new Set(
      Object.keys((profile.resumeVersions && profile.resumeVersions.versions) || {})
    );

    const applicationsPath = path.join(profile.paths.root, "applications.tsv");
    const { apps } = deps.loadApplications(applicationsPath);

    // Build a keyed working set once. Push/pull both mutate through this map;
    // originals in `apps` stay unmodified until we save.
    const byKey = new Map(apps.map((a) => [a.key, a]));

    let manifest;
    try {
      manifest = readPushManifest(profile.paths.root);
    } catch (err) {
      ctx.stderr(`error: ${err.message}`);
      return 1;
    }
    const pushPlan = planPush(apps, manifest ? { allowKeys: manifest.keys } : {});
    if (manifest) {
      stdout(
        `push manifest: ${manifest.keys.size} key(s) allow-listed (.stage16/push_manifest.json)`
      );
    }
    stdout(`push plan: ${pushPlan.length} application(s) need a Notion page`);

    if (!flags.apply) {
      stdout(`(dry-run — pass --apply to mutate Notion and TSV)`);
      for (const a of pushPlan.slice(0, 10)) {
        stdout(`  push: ${a.key} | ${a.companyName} | ${a.title}`);
      }
      if (pushPlan.length > 10) stdout(`  … and ${pushPlan.length - 10} more`);
    }

    // Single Notion client shared by push and pull phases. Any future statefulness
    // (connection pool, rate-limiter) stays consistent across the two phases.
    let client = null;
    const getClient = () => {
      if (!client) client = deps.makeClient(token);
      return client;
    };

    // Build a company resolver if the profile has a Companies DB configured.
    // If not, push proceeds without the Company relation — a warning is printed.
    let companyResolver = null;
    const companiesDbId = profile.notion && profile.notion.companies_db_id;
    if (flags.apply && pushPlan.length && companiesDbId) {
      try {
        const companiesDataSourceId = await deps.resolveDataSourceId(
          getClient(),
          companiesDbId
        );
        companyResolver = deps.makeCompanyResolver({
          client: getClient(),
          companiesDbId,
          companiesDataSourceId,
          companyTiers: profile.company_tiers || {},
          log: (m) => stdout(`  ${m}`),
        });
      } catch (err) {
        ctx.stderr(`  warn: could not init company resolver: ${err.message}`);
      }
    } else if (flags.apply && pushPlan.length && !companiesDbId) {
      stdout(`  (no companies_db_id in profile.notion — Company relation will be empty)`);
    }

    let pushed = 0;
    let pushErrors = 0;
    if (flags.apply && pushPlan.length) {
      for (const app of pushPlan) {
        try {
          let companyRelationId = null;
          if (companyResolver) {
            try {
              companyRelationId = await companyResolver.resolve(app.companyName);
            } catch (err) {
              ctx.stderr(`  company resolve error for ${app.companyName}: ${err.message}`);
            }
          }
          const notionJob = appToNotionJob(app, companyRelationId, canonicalArchetypes);
          const page = await deps.createJobPage(getClient(), databaseId, notionJob, propertyMap);
          // Immutable update: write the page id through byKey rather than
          // mutating the original app in place, to keep `apps` clean.
          byKey.set(app.key, {
            ...app,
            notion_page_id: page.id,
            updatedAt: deps.now(),
          });
          pushed += 1;
        } catch (err) {
          pushErrors += 1;
          ctx.stderr(`  push error for ${app.key}: ${err.message}`);
        }
      }
      stdout(`push: ${pushed} created${pushErrors ? `, ${pushErrors} errors` : ""}`);
    }

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
      if (flags.apply && pushed > 0) {
        // Pull failed but push already committed — warn so the user knows the
        // saved TSV reflects push changes only and pull reconcile is pending.
        ctx.stderr(
          `  pull failed — writing push-only changes; re-run sync to retry pull`
        );
      }
    }

    if (!flags.apply) {
      return pushErrors + pullErrors > 0 ? 1 : 0;
    }

    // Apply pull updates into the same keyed map, then save once.
    for (const u of pulled) {
      byKey.set(u.before.key, { ...u.after, updatedAt: deps.now() });
    }
    if (pushed > 0 || pulled.length) {
      const merged = Array.from(byKey.values());
      deps.saveApplications(applicationsPath, merged);
      const changes = [];
      if (pushed > 0) changes.push(`${pushed} new page id(s)`);
      if (pulled.length) changes.push(`${pulled.length} updated from Notion`);
      stdout(`saved ${merged.length} applications to ${applicationsPath} (${changes.join(", ")})`);
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

    return pushErrors + pullErrors > 0 ? 1 : 0;
  };
}

module.exports = makeSyncCommand();
module.exports.makeSyncCommand = makeSyncCommand;
module.exports.planPush = planPush;
module.exports.reconcilePull = reconcilePull;
module.exports.appToNotionJob = appToNotionJob;
module.exports.readPushManifest = readPushManifest;
module.exports.DEFAULT_PROPERTY_MAP = DEFAULT_PROPERTY_MAP;
