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

const fs = require("fs");
const path = require("path");

const profileLoader = require("../core/profile_loader.js");
const { secretEnvName } = profileLoader;
const applications = require("../core/applications_tsv.js");
const notion = require("../core/notion_sync.js");
const { resolveProfilesDir } = require("../core/paths.js");
const archiveSweep = require("../core/archive_used_artifacts.js");
const { makeCompanyNameResolver } = require("../core/company_resolver.js");
const { decideOutreachDate } = require("../core/auto_dead.js");

// Canonical map lives in notion_sync.js — all Notion-touching commands
// share it. Re-export here as a const so the rest of this file stays
// readable. Profiles may override via profile.notion.property_map.
const { DEFAULT_PROPERTY_MAP } = notion;

const DEFAULT_DEPS = {
  loadProfile: profileLoader.loadProfile,
  loadSecrets: profileLoader.loadSecrets,
  loadApplications: applications.load,
  saveApplications: applications.save,
  makeClient: notion.makeClient,
  fetchJobsFromDatabase: notion.fetchJobsFromDatabase,
  updateCalloutBlock: notion.updateCalloutBlock,
  // RFC 058: reverse company resolver (relation page-id → name). Injected so
  // tests can fake Notion. Defaults to the real Companies-DB reader.
  makeCompanyNameResolver,
  now: () => new Date().toISOString(),
  // BL-151 / RFC 054: archive-sweep facade. Defaults to the real `fs`
  // module; tests inject in-memory fakes.
  archiveFs: {
    existsSync: (p) => fs.existsSync(p),
    mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
    renameSync: (from, to) => fs.renameSync(from, to),
  },
};

// Page → matchKey: `key` field if present in the Notion property map,
// otherwise composite (source, jobId). Shared by reconcilePull and the
// sync command's company-id collection so the two never drift.
function matchKeyForPage(page, propertyMap) {
  const keyField = propertyMap.key && propertyMap.key.field;
  const sourceField = propertyMap.source && propertyMap.source.field;
  const jobIdField = propertyMap.jobId && propertyMap.jobId.field;
  const k = keyField ? page.key : null;
  const composite =
    sourceField && jobIdField && page.source && page.jobId
      ? `${String(page.source).toLowerCase()}:${page.jobId}`
      : null;
  return k || composite;
}

// Resolve a page's company name. Profiles that store company as a Notion
// `relation` expose it as `page.companyRelation = [companyPageId]` with NO
// `page.companyName`; the caller resolves those ids to names up front and
// passes them in `companyNameById`. Text-company profiles fall back to the
// plain `page.companyName`. Returns "" when neither is available (RFC 058).
function companyNameForPage(page, companyNameById) {
  const relIds = Array.isArray(page.companyRelation) ? page.companyRelation : [];
  const resolved = relIds.length ? companyNameById[String(relIds[0])] : null;
  return resolved || page.companyName || "";
}

// Reconcile Notion → local TSV. Pure: no I/O, no Date.now(). `now` (ISO
// string) is passed in so added rows get deterministic createdAt/updatedAt.
// `companyNameById` (RFC 058 / BL-168) maps Companies-DB page ids → names so
// relation-company profiles get a populated `companyName` instead of "".
//
// Returns { updates, adds }:
//   updates — { before, after } pairs for existing local rows whose
//             notion_page_id / status / (empty) companyName / outreach status
//             drifted from Notion (Notion wins; a populated local companyName
//             is never overwritten; an empty Notion outreach value never
//             clobbers the local placeholder).
//   adds    — full TSV row objects for Notion pages with NO matching local
//             row. This makes the pull additive: the fly.io cron's stale
//             TSV picks up apps created on the operator's Mac (RFC 055).
//
// Idempotent: on a rerun the previously-added rows now exist locally, so
// they match in the update pass and never re-appear in `adds`.
function reconcilePull(apps, notionPages, propertyMap, now, companyNameById = {}) {
  const byKey = new Map();
  for (const page of notionPages) {
    const matchKey = matchKeyForPage(page, propertyMap);
    if (matchKey) byKey.set(matchKey, page);
  }

  const updates = [];
  const consumed = new Set();
  for (const app of apps) {
    const page = byKey.get(app.key);
    if (!page) continue;
    consumed.add(app.key);
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
    // Backfill an empty companyName from Notion (self-heals the rows BL-154
    // added blank). Never overwrite a name the local row already has.
    if (!app.companyName) {
      const resolvedName = companyNameForPage(page, companyNameById);
      if (resolvedName) {
        next.companyName = resolvedName;
        changed = true;
      }
    }
    // RFC 059 (BL-169): pull the operator-owned Outreach status (Notion wins).
    // The `page.hmOutreachStatus` truthiness guard means an empty/unset Notion
    // value never clobbers the local one — the engine-seeded "To do"
    // placeholder survives until the operator actually sets Outreach in Notion.
    // `company_people_search_url` is engine-written (one-way, set at prepare
    // commit) so it is deliberately NOT pulled back here.
    if (page.hmOutreachStatus && app.hm_outreach_status !== page.hmOutreachStatus) {
      next.hm_outreach_status = page.hmOutreachStatus;
      changed = true;
    }
    // RFC 059 amendment (BL-169 auto-Dead): stamp/clear the `hm_outreach_date`
    // anchor on outreach-status transitions so the lazy In-flight→Dead sweep
    // has a 7-day timer. Entering "In flight" with no anchor stamps today;
    // leaving In flight back to "To do" clears it (a re-entry re-stamps);
    // terminal "Replied"/"Dead" leave the date as-is. The "today" string is
    // derived from the injected `now` (date portion of the ISO timestamp) so
    // the decision stays pure / deterministic.
    const effectiveOutreach = page.hmOutreachStatus || next.hm_outreach_status;
    const todayStr = typeof now === "string" ? now.slice(0, 10) : "";
    const dateDecision = decideOutreachDate(
      effectiveOutreach,
      next.hm_outreach_date || "",
      todayStr
    );
    if (dateDecision.action !== "keep" && next.hm_outreach_date !== dateDecision.date) {
      next.hm_outreach_date = dateDecision.date;
      changed = true;
    }
    if (changed) updates.push({ before: app, after: next });
  }

  // Any Notion page whose matchKey was not consumed by an existing local row
  // becomes an add. Build a full v5 TSV row so save() round-trips cleanly.
  const adds = [];
  for (const [matchKey, page] of byKey) {
    if (consumed.has(matchKey)) continue;
    const source = page.source ? String(page.source) : "notion";
    adds.push({
      key: matchKey,
      source,
      jobId: page.jobId || "",
      companyName: companyNameForPage(page, companyNameById),
      title: page.title || "",
      url: page.url || "",
      locations: Array.isArray(page.locations) ? page.locations.map(String) : [],
      status: page.status || "",
      notion_page_id: page.notionPageId || "",
      resume_ver: "",
      cl_key: "",
      salary_min: "",
      salary_max: "",
      cl_path: "",
      createdAt: now,
      updatedAt: now,
      fit_score: "",
      fit_rationale: "",
      fit_evaluated_at: "",
      skip_reason: "",
      // RFC 059 (BL-169): outreach columns. company_people_search_url is left
      // empty for pulled rows (it is computed by prepare commit, not on pull);
      // hm_outreach_status takes Notion's value when present, else the
      // engine-default placeholder.
      company_people_search_url: "",
      outreach_type: "",
      contact_name: "",
      contact_linkedin: "",
      hm_outreach_status: page.hmOutreachStatus || "To do",
      hm_outreach_date: "",
    });
  }

  return { updates, adds };
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

    const propertyMap = (profile.notion && profile.notion.property_map) || DEFAULT_PROPERTY_MAP;

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
    let updates = [];
    let adds = [];
    let pullErrors = 0;
    try {
      const pages = await deps.fetchJobsFromDatabase(getClient(), databaseId, propertyMap);
      // RFC 058: profiles that store company as a Notion `relation` expose it
      // as page ids, not names. Resolve the ids we actually need — pages that
      // will be added (no local row) or whose local row has an empty
      // companyName — so reconcile populates the column instead of leaving it
      // blank (which would silently drop the row from check's active set).
      // Non-fatal: a resolver failure leaves names empty, same as before.
      let companyNameById = {};
      const hasRelation = propertyMap.companyRelation && propertyMap.companyRelation.field;
      if (hasRelation) {
        const localByKey = new Map(apps.map((a) => [a.key, a]));
        const neededIds = new Set();
        for (const page of pages) {
          const relIds = Array.isArray(page.companyRelation) ? page.companyRelation : [];
          if (!relIds.length) continue;
          const mk = matchKeyForPage(page, propertyMap);
          const local = mk ? localByKey.get(mk) : null;
          if (!local || !local.companyName) neededIds.add(String(relIds[0]));
        }
        if (neededIds.size) {
          try {
            const resolver = deps.makeCompanyNameResolver({
              client: getClient(),
              log: (m) => ctx.stderr(`  ${m}`),
            });
            companyNameById = await resolver.resolveIds(Array.from(neededIds));
          } catch (err) {
            ctx.stderr(`  warn: company-name resolve failed: ${err.message}`);
          }
        }
      }
      ({ updates, adds } = reconcilePull(apps, pages, propertyMap, deps.now(), companyNameById));
      stdout(
        `pull plan: ${updates.length} local row(s) would change from Notion state, ` +
          `${adds.length} new row(s) would be added`
      );
      for (const u of updates.slice(0, 10)) {
        stdout(
          `  pull: ${u.before.key} | status ${u.before.status || "(none)"} → ${u.after.status || "(none)"}`
        );
      }
      if (updates.length > 10) stdout(`  … and ${updates.length - 10} more`);
      for (const a of adds.slice(0, 10)) {
        stdout(`  add: ${a.key} | status ${a.status || "(none)"}`);
      }
      if (adds.length > 10) stdout(`  … and ${adds.length - 10} more`);
    } catch (err) {
      pullErrors += 1;
      ctx.stderr(`  pull error: ${err.message}`);
    }

    if (!flags.apply) {
      stdout(`(dry-run — pass --apply to mutate TSV)`);
      return pullErrors > 0 ? 1 : 0;
    }

    // Apply pull updates + adds into the keyed map, then save once.
    for (const u of updates) {
      byKey.set(u.before.key, { ...u.after, updatedAt: deps.now() });
    }
    for (const row of adds) {
      byKey.set(row.key, row);
    }
    const changedCount = updates.length + adds.length;
    if (changedCount) {
      const merged = Array.from(byKey.values());
      deps.saveApplications(applicationsPath, merged);
      stdout(
        `saved ${merged.length} applications to ${applicationsPath} ` +
          `(${updates.length} updated from Notion, ${adds.length} added)`
      );
    }

    // BL-151 / RFC 054: archive used tailored artifacts for rows whose
    // status moved past To Apply (Applied / Interview / Offer / Rejected
    // / Closed / No Response). Runs on every --apply so manual `sync
    // --apply` invocations behave identically to the auto-sync pre-hook.
    try {
      const post = Array.from(byKey.values());
      const plan = archiveSweep.planArchiveMoves({
        rows: post,
        profileRoot: profile.paths.root,
        fs: deps.archiveFs,
      });
      if (plan.moves.length > 0 || plan.skipped.length > 0) {
        const byKeyMutable = new Map(post.map((a) => [a.key, { ...a }]));
        const tsvUpdater = (rowKey, patch) => {
          const row = byKeyMutable.get(rowKey);
          if (!row) return;
          Object.assign(row, patch);
        };
        const result = archiveSweep.applyArchiveMoves(plan, {
          fs: deps.archiveFs,
          tsvUpdater,
          logger: { warn: (m) => ctx.stderr(`[sync] warn: ${m}`) },
        });
        if (result.moved > 0) {
          deps.saveApplications(applicationsPath, Array.from(byKeyMutable.values()));
          const dirs = (result.byMonth.cv || [])
            .map((d) => `${d}/`)
            .concat((result.byMonth.cl || []).map((d) => `${d}/`));
          const dirStr = dirs.length > 0 ? ` → ${dirs.join(", ")}` : "";
          stdout(
            `[sync] archived ${result.moved} used artifact${result.moved === 1 ? "" : "s"}${dirStr}`
          );
        }
      }
    } catch (err) {
      ctx.stderr(`  warn: archive sweep failed: ${err.message}`);
    }

    // Update the hub callout counter if the profile has one configured.
    // Counts the **inbox**: fresh rows that haven't been pushed to Notion yet.
    // Post-RFC 014 (2026-05-04) the canonical predicate is `status === "Inbox"`
    // (TSV-only state). Back-compat: pre-RFC 014 rows with `status === "To
    // Apply" && !notion_page_id` also count — backfill normally rewrites them
    // but the dual filter protects against partial migrations.
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
          (a) => a.status === "Inbox" || (a.status === "To Apply" && !a.notion_page_id)
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
module.exports.matchKeyForPage = matchKeyForPage;
module.exports.DEFAULT_PROPERTY_MAP = DEFAULT_PROPERTY_MAP;
