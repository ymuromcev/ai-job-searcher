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

const profileLoader = require("../core/profile_loader.js");
const companies = require("../core/companies.js");
const jobsTsv = require("../core/jobs_tsv.js");
const applications = require("../core/applications_tsv.js");
const { scan } = require("../core/scan.js");
const adapterRegistry = require("../modules/discovery/index.js");
const { resolveProfilesDir } = require("../core/paths.js");

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
  groupBySource: companies.groupBySource,
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
    const { apps: nextApps, fresh: freshApps } = deps.appendNewApplications(
      existingApps,
      result.fresh,
      { now: deps.now() }
    );

    if (flags.dryRun) {
      stdout(`(dry-run) would write ${result.pool.length} rows to ${jobsPath}`);
      stdout(`(dry-run) would append ${freshApps.length} rows to ${applicationsPath}`);
      return 0;
    }

    deps.saveJobs(jobsPath, result.pool, { now: deps.now() });
    deps.saveApplications(applicationsPath, nextApps);
    stdout(`wrote ${result.pool.length} jobs to ${jobsPath}`);
    stdout(`appended ${freshApps.length} new applications to ${applicationsPath}`);
    return 0;
  };
}

module.exports = makeScanCommand();
module.exports.makeScanCommand = makeScanCommand;
module.exports.modulesToSources = modulesToSources;
module.exports.applyTargetFilters = applyTargetFilters;
module.exports.redactor = redactor;
