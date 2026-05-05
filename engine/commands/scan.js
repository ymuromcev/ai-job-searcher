// `scan` command: run discovery adapters, write fresh jobs into the shared
// pool (data/jobs.tsv) and into the per-profile pipeline
// (profiles/<id>/applications.tsv).
//
// Pure data-flow with two side effects (TSV writes), both atomic. With
// --dry-run the function reports counts without writing.
//
// The factory `makeScanCommand({ deps })` is exported so tests can inject
// fakes for profile loading / companies / adapters / jobs+applications I/O.

const path = require("path");
const fs = require("fs");

const profileLoader = require("../core/profile_loader.js");
const companies = require("../core/companies.js");
const jobsTsv = require("../core/jobs_tsv.js");
const applications = require("../core/applications_tsv.js");
const { scan } = require("../core/scan.js");
const { filterJobs } = require("../core/filter.js");
const adapterRegistry = require("../modules/discovery/index.js");
const { resolveProfilesDir } = require("../core/paths.js");

const DEFAULT_ACTIVE_STATUSES = ["Applied", "To Apply", "Interview", "Offer"];

function appendRejectionsLogDefault(filePath, lines) {
  // jsonl append, one rejection per line. Caller provides full lines.
  if (!lines || lines.length === 0) return;
  fs.appendFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const DEFAULT_DEPS = {
  loadProfile: profileLoader.loadProfile,
  loadSecrets: profileLoader.loadSecrets,
  loadCompanies: companies.load,
  filterCompaniesByProfile: companies.filterByProfile,
  loadJobs: jobsTsv.load,
  saveJobs: jobsTsv.save,
  loadApplications: applications.load,
  saveApplications: applications.save,
  appendNewApplications: applications.appendNew,
  appendRejectionsLog: appendRejectionsLogDefault,
  groupBySource: companies.groupBySource,
  filterJobs,
  scan,
  listAdapters: adapterRegistry.listAdapters,
  getAdapter: adapterRegistry.getAdapter,
  now: () => new Date().toISOString(),
};

function redactor(secretValues) {
  // Returns a function that masks every occurrence of any non-trivial secret
  // value in the input string. Trivial/short values (<6 chars) are skipped to
  // avoid over-redaction of common words.
  const values = (Array.isArray(secretValues) ? secretValues : [])
    .filter((v) => typeof v === "string" && v.length >= 6)
    .sort((a, b) => b.length - a.length); // longest first so overlaps mask fully
  if (!values.length) return (s) => String(s == null ? "" : s);
  return function redact(input) {
    let out = String(input == null ? "" : input);
    for (const v of values) {
      const idx = out.indexOf(v);
      if (idx === -1) continue;
      out = out.split(v).join("***");
    }
    return out;
  };
}

function modulesToSources(modules) {
  // profile.json `modules` looks like ["discovery:greenhouse", "discovery:lever", ...].
  if (!Array.isArray(modules)) return new Set();
  const out = new Set();
  for (const m of modules) {
    if (typeof m !== "string") continue;
    const [kind, name] = m.split(":");
    if (kind === "discovery" && name) out.add(name.toLowerCase());
  }
  return out;
}

function applyTargetFilters(grouped, profile) {
  const discovery = (profile && profile.discovery) || {};
  const whitelist = Array.isArray(discovery.companies_whitelist)
    ? new Set(discovery.companies_whitelist.map((s) => String(s).toLowerCase()))
    : null;
  const blacklist = new Set(
    Array.isArray(discovery.companies_blacklist)
      ? discovery.companies_blacklist.map((s) => String(s).toLowerCase())
      : []
  );
  const out = {};
  for (const [source, targets] of Object.entries(grouped)) {
    const filtered = targets.filter((t) => {
      const name = String(t.name || "").toLowerCase();
      if (whitelist && !whitelist.has(name)) return false;
      if (blacklist.has(name)) return false;
      return true;
    });
    if (filtered.length) out[source] = filtered;
  }
  return out;
}

function makeScanCommand(overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };

  return async function scanCommand(ctx) {
    const { profileId, flags, env, stdout } = ctx;
    const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);
    const dataDir = ctx.dataDir || path.resolve(process.cwd(), "data");

    const profile = deps.loadProfile(profileId, { profilesDir });
    const secrets = deps.loadSecrets(profileId, env);

    const enabledSources = modulesToSources(profile.modules);
    if (enabledSources.size === 0) {
      // No-op success: a profile may be valid with no discovery modules (it
      // might only run sync/validate). Cron should not treat this as an error.
      stdout(`profile "${profileId}" has no discovery modules enabled — nothing to scan`);
      return 0;
    }

    const companiesPath = path.join(dataDir, "companies.tsv");
    const { rows: companyRows } = deps.loadCompanies(companiesPath);

    // Per-profile visibility (RFC 010 part B). `profile` column in
    // companies.tsv gates rows BEFORE whitelist/blacklist. Public rows
    // (profile="" / "both") are always visible. This is the structural
    // replacement for the cross-profile blacklist hack.
    const visibleRows = deps.filterCompaniesByProfile
      ? deps.filterCompaniesByProfile(companyRows, profileId)
      : companyRows;

    const grouped = deps.groupBySource(visibleRows);
    const enabledGrouped = {};
    for (const src of Object.keys(grouped)) {
      if (enabledSources.has(src)) enabledGrouped[src] = grouped[src];
    }
    const targetsBySource = applyTargetFilters(enabledGrouped, profile);

    // Feed-based adapters (e.g. remoteok) have no entries in companies.tsv, so
    // they never appear in targetsBySource after the company-pool grouping.
    // Inject a synthetic target so scan.js core will actually invoke them.
    const knownSources = new Set(deps.listAdapters());
    for (const src of enabledSources) {
      if (!targetsBySource[src] && knownSources.has(src)) {
        const feedAdapter = deps.getAdapter(src);
        if (feedAdapter && feedAdapter.feedMode) {
          targetsBySource[src] = [{ name: "feed", slug: "__feed__" }];
        }
      }
    }

    const totalTargets = Object.values(targetsBySource).reduce((n, t) => n + t.length, 0);

    // Distinguish empty-pool (needs seeding) from empty-after-filters (may be intentional).
    // Show the seeding hint only when the companies pool itself is empty and no feed
    // adapters produced targets — i.e. a likely first-run without bootstrap.
    if (companyRows.length === 0 && totalTargets === 0) {
      ctx.stderr(`error: companies pool is empty at ${companiesPath}`);
      ctx.stderr("hint: run `node engine/bin/seed_companies.js` to bootstrap");
      return 1;
    }
    if (totalTargets === 0) {
      stdout(`no targets after applying profile filters — nothing to scan`);
      return 0;
    }
    stdout(
      `scanning ${totalTargets} targets across ${Object.keys(targetsBySource).length} sources for profile "${profileId}"`
    );

    const adapters = {};
    for (const src of Object.keys(targetsBySource)) {
      if (!knownSources.has(src)) {
        ctx.stderr(
          `warn: no adapter for source "${src}" — skipping ${targetsBySource[src].length} targets`
        );
        continue;
      }
      adapters[src] = deps.getAdapter(src);
    }

    const jobsPath = path.join(dataDir, "jobs.tsv");
    const { jobs: existingJobs } = deps.loadJobs(jobsPath);

    const secretValues = Object.values(secrets || {});
    const redact = redactor(secretValues);
    if (flags.verbose) {
      const activeMasks = secretValues.filter(
        (v) => typeof v === "string" && v.length >= 6
      ).length;
      stdout(`redactor: ${activeMasks} secret value(s) will be masked in output`);
    }
    const result = await deps.scan({
      targetsBySource,
      adapters,
      existing: existingJobs,
      ctx: {
        secrets,
        // Pass the profile's discovery config so keyword-search adapters
        // (adzuna, the_muse) can read keywords, location, and result limits
        // without requiring companies.tsv entries.
        discovery: profile.discovery || {},
        logger: {
          // Adapters only emit benign warnings here (missing slug, per-target
          // fetch failures). We still redact defensively in case an HTTP
          // client ever echoes a header back.
          warn: (m) => ctx.stderr(redact(m)),
        },
      },
    });

    stdout(`discovery summary:`);
    for (const [src, info] of Object.entries(result.summary)) {
      const errStr = info.error ? ` (error: ${redact(info.error)})` : "";
      stdout(`  ${src}: ${info.total} returned${errStr}`);
    }
    stdout(`fresh jobs: ${result.fresh.length}`);
    if (result.errors.length) {
      stdout(`adapter errors: ${result.errors.length}`);
    }

    if (result.fresh.length === 0) {
      stdout("no new jobs — nothing to write");
      return 0;
    }

    const applicationsPath = path.join(profile.paths.root, "applications.tsv");
    const { apps: existingApps } = deps.loadApplications(applicationsPath);

    // Filter stage (incident 2026-05-04 fix): apply per-profile rules to fresh
    // jobs before appending. Pool in data/jobs.tsv stays unfiltered — it's
    // shared and a job rejected by this profile may be valid for another.
    //
    // Rejected jobs are still appended to applications.tsv but with
    // status="Archived" so the user has a per-profile record (parity with
    // prototype find_jobs.js). Reason details go to filter_rejections.log
    // (jsonl) to avoid a TSV schema change.
    // profile_loader normalizes rules onto `filterRules` (camelCase). Some
     // callers/tests still pass `filter_rules` (snake_case) — accept both.
    const filterRules = profile.filterRules || profile.filter_rules || {};
    const cap = filterRules.company_cap || {};
    const activeStatuses = new Set(
      Array.isArray(cap.active_statuses) && cap.active_statuses.length > 0
        ? cap.active_statuses
        : DEFAULT_ACTIVE_STATUSES
    );
    const activeCounts = {};
    for (const app of existingApps) {
      if (activeStatuses.has(app.status)) {
        activeCounts[app.companyName] = (activeCounts[app.companyName] || 0) + 1;
      }
    }

    // Adapter shape uses companyName/title/locations[]; filter expects
    // company/role/location. Map and keep a back-ref to the original job so
    // we can re-emit it in adapter shape after filtering.
    //
    // L-4 (RFC 013): also pass `locations` array for geo_enforcer multi-loc
    // matching (a posting like ["Sacramento", "Remote"] should pass for
    // someone whose policy allows either). Single-location string (`location`)
    // kept for blocklist back-compat — historic contract.
    const filterInputs = result.fresh.map((j) => ({
      _job: j,
      company: j.companyName,
      role: j.title,
      locations: Array.isArray(j.locations) ? j.locations.map(String) : [],
      location:
        Array.isArray(j.locations) && j.locations.length > 0
          ? String(j.locations[0])
          : "",
    }));
    // L-4: inject profile.geo into filter rules. Default unrestricted block
    // means the geo check is a no-op for Jared (back-compat).
    const filterRulesWithGeo = { ...filterRules, geo: profile.geo };
    const filterResult = deps.filterJobs(filterInputs, filterRulesWithGeo, activeCounts);
    const passedJobs = filterResult.passed.map((p) => p._job);
    const rejectedEntries = filterResult.rejected.map((r) => ({
      job: r.job._job,
      reason: r.reason,
    }));

    const reasonCounts = {};
    for (const r of rejectedEntries) {
      const k = r.reason.kind || "unknown";
      reasonCounts[k] = (reasonCounts[k] || 0) + 1;
    }
    const reasonSummary = Object.entries(reasonCounts)
      .map(([k, n]) => `${k}=${n}`)
      .join(", ");
    stdout(
      `filter: ${passedJobs.length} passed, ${rejectedEntries.length} rejected${
        reasonSummary ? ` (${reasonSummary})` : ""
      }`
    );

    // Two-step append: passed first (To Apply), then rejected layered on top
    // of that result (Archived). Both go into the same TSV.
    const passedAppend = deps.appendNewApplications(
      existingApps,
      passedJobs,
      { now: deps.now(), defaultStatus: "To Apply" }
    );
    const rejectedAppend = deps.appendNewApplications(
      passedAppend.apps,
      rejectedEntries.map((r) => r.job),
      { now: deps.now(), defaultStatus: "Archived" }
    );
    const nextApps = rejectedAppend.apps;
    const freshApps = passedAppend.fresh;
    const archivedApps = rejectedAppend.fresh;

    const rejectionsPath = path.join(profile.paths.root, "filter_rejections.log");
    const rejectionLines = rejectedEntries.map((r) => ({
      ts: deps.now(),
      source: r.job.source,
      jobId: r.job.jobId,
      company: r.job.companyName,
      title: r.job.title,
      location:
        Array.isArray(r.job.locations) && r.job.locations.length > 0
          ? r.job.locations[0]
          : "",
      kind: r.reason.kind,
      detail: r.reason,
    }));

    if (flags.dryRun) {
      stdout(`(dry-run) would write ${result.pool.length} rows to ${jobsPath}`);
      stdout(
        `(dry-run) would append ${freshApps.length} To Apply + ${archivedApps.length} Archived rows to ${applicationsPath}`
      );
      if (rejectionLines.length > 0) {
        stdout(
          `(dry-run) would append ${rejectionLines.length} entries to ${rejectionsPath}`
        );
      }
      return 0;
    }

    deps.saveJobs(jobsPath, result.pool, { now: deps.now() });
    deps.saveApplications(applicationsPath, nextApps);
    if (rejectionLines.length > 0) {
      deps.appendRejectionsLog(rejectionsPath, rejectionLines);
    }
    stdout(`wrote ${result.pool.length} jobs to ${jobsPath}`);
    stdout(
      `appended ${freshApps.length} To Apply + ${archivedApps.length} Archived rows to ${applicationsPath}`
    );
    if (rejectionLines.length > 0) {
      stdout(`appended ${rejectionLines.length} entries to ${rejectionsPath}`);
    }
    return 0;
  };
}

module.exports = makeScanCommand();
module.exports.makeScanCommand = makeScanCommand;
module.exports.modulesToSources = modulesToSources;
module.exports.applyTargetFilters = applyTargetFilters;
module.exports.redactor = redactor;
