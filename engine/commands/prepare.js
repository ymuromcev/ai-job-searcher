// `prepare` command — two-phase processing of "fresh" pipeline rows.
//
// "Fresh" = status="To Apply" AND notion_page_id="" (never pushed). The 8-status
// set has no "Inbox" — fresh rows land directly as "To Apply" via scan/check.
//
// Phase `pre`:
//   1. Load fresh apps from applications.tsv.
//   2. Apply title blocklist + company cap from filter_rules.json.
//   3. Take first `batchSize` (default 30) passed jobs.
//   4. URL-check each job (HEAD + GET fallback, SSRF guard).
//   5. Fetch JD text from supported ATS APIs; cache in profiles/<id>/jd_cache/.
//   6. Compute salary from profile.company_tiers × parseLevel(title).
//   7. Write prepare_context.json to profiles/<id>/.
//
// Phase `commit`:
//   Read a results JSON file produced by the Claude SKILL (see SKILL.md) and
//   update applications.tsv accordingly:
//     decision "to_apply"  → status="To Apply", set cl_key / resume_ver / notion_page_id
//                            (row keeps "To Apply" but gains notion_page_id, so
//                             it stops appearing in fresh list on next pre run)
//     decision "skip"      → no change (still "To Apply" with no notion_page_id)
//     decision "archive"   → status="Archived"
//
//   The factory `makePrepareCommand({ deps })` is exported so tests can inject
//   fakes for all I/O.

const path = require("path");
const fs = require("fs");

const profileLoader = require("../core/profile_loader.js");
const applicationsTsv = require("../core/applications_tsv.js");
const { checkAll } = require("../core/url_check.js");
const { fetchAll: fetchAllJds } = require("../core/jd_cache.js");
const { calcSalary } = require("../core/salary_calc.js");
const { defaultFetch } = require("../modules/discovery/_http.js");
const { resolveProfilesDir } = require("../core/paths.js");

// Active statuses that count toward the company cap. "To Apply" is included
// because every triaged row will become Applied — counting it prevents over-
// preparing for the same company. Archived/Rejected/Closed/No Response don't
// block. (8-status set; there is no "Inbox" status.)
const CAP_ACTIVE_STATUSES = new Set(["To Apply", "Applied", "Interview", "Offer"]);

const DEFAULT_BATCH_SIZE = 30;

// applications.tsv rows don't carry an ATS board slug — it's derivable from
// the public job URL. jd_cache needs a slug to build the Greenhouse/Lever
// public-API endpoint (e.g. boards-api.greenhouse.io/v1/boards/<slug>/jobs/<id>).
function parseSlugFromUrl(source, url) {
  const u = String(url || "");
  if (source === "greenhouse") {
    const m = u.match(/greenhouse\.io\/([^/?#]+)\/jobs\//i);
    return m ? m[1] : "";
  }
  if (source === "lever") {
    const m = u.match(/jobs\.lever\.co\/([^/?#]+)\//i);
    return m ? m[1] : "";
  }
  return "";
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Filtering ---------------------------------------------------------------

function buildActiveCounts(apps) {
  const counts = {};
  for (const app of apps) {
    if (!CAP_ACTIVE_STATUSES.has(app.status)) continue;
    const co = app.companyName;
    counts[co] = (counts[co] || 0) + 1;
  }
  return counts;
}

function applyPrepareFilter(apps, rules, activeCounts) {
  const companyCap = (rules && rules.company_cap) || {};
  const maxActive =
    companyCap.max_active != null ? Number(companyCap.max_active) : Infinity;
  const capOverrides = (companyCap.overrides) || {};

  // Blocklists arrive in the flat engine shape from profile_loader's
  // normalizeFilterRules (company_blocklist: [strings], title_blocklist:
  // [{pattern, reason}], title_requirelist: [{pattern, reason}]).
  // Plain-string fallback is kept for tests that pass rules inline without
  // going through the loader.
  const companyBlocklist = new Set(
    (Array.isArray(rules && rules.company_blocklist) ? rules.company_blocklist : [])
      .map((c) => (c && typeof c === "object" ? c.name : c))
      .filter((c) => typeof c === "string" && c.length > 0)
      .map((c) => c.toLowerCase())
  );

  const titlePatterns = (
    Array.isArray(rules && rules.title_blocklist) ? rules.title_blocklist : []
  )
    .map((p) => (p && typeof p === "object" ? p.pattern : p))
    .filter((p) => typeof p === "string" && p.length > 0)
    .map((p) => p.toLowerCase());

  // Positive gate: if non-empty, at least one slash-part of the title must
  // match a required pattern (word-boundary regex, case-insensitive).
  // Prevents non-PM roles (SWE, DevOps, Analyst…) from reaching the batch when
  // ATS adapters return all company openings.
  const titleRequirelist = (
    Array.isArray(rules && rules.title_requirelist) ? rules.title_requirelist : []
  )
    .map((p) => (p && typeof p === "object" ? p.pattern : p))
    .filter((p) => typeof p === "string" && p.length > 0)
    .map((p) => p.toLowerCase());

  const counts = { ...activeCounts };
  const passed = [];
  const skipped = [];

  for (const app of apps) {
    const companyLower = String(app.companyName || "").toLowerCase();

    if (companyBlocklist.has(companyLower)) {
      skipped.push({ key: app.key, reason: "company_blocklist", url: app.url });
      continue;
    }

    const titleLower = String(app.title || "").toLowerCase();

    // title_requirelist: positive gate checked before blocklist
    if (titleRequirelist.length > 0 && titleLower) {
      const parts = titleLower.split("/").map((p) => p.trim()).filter(Boolean);
      const titleParts = parts.length > 0 ? parts : [titleLower];
      const anyMatches = titleParts.some((part) =>
        titleRequirelist.some((pat) => new RegExp(`\\b${escapeRegex(pat)}\\b`, "i").test(part))
      );
      if (!anyMatches) {
        skipped.push({ key: app.key, reason: "title_requirelist", url: app.url });
        continue;
      }
    }

    let blocked = false;
    for (const pat of titlePatterns) {
      if (titleLower.includes(pat)) {
        skipped.push({ key: app.key, reason: "title_blocklist", pattern: pat, url: app.url });
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    const cap = Object.prototype.hasOwnProperty.call(capOverrides, app.companyName)
      ? Number(capOverrides[app.companyName])
      : maxActive;
    const current = counts[app.companyName] || 0;
    if (current >= cap) {
      skipped.push({ key: app.key, reason: "company_cap", cap, current, url: app.url });
      continue;
    }

    passed.push(app);
    counts[app.companyName] = current + 1;
  }

  return { passed, skipped };
}

// --- Deps & defaults ---------------------------------------------------------

function makeDefaultDeps() {
  return {
    loadProfile: profileLoader.loadProfile,
    saveProfile: profileLoader.saveProfile,
    loadApplications: applicationsTsv.load,
    saveApplications: applicationsTsv.save,
    checkUrls: checkAll,
    fetchJds: fetchAllJds,
    calcSalary,
    fetchFn: defaultFetch,
    readFile: (p) => fs.readFileSync(p, "utf8"),
    writeFile: (p, data) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, p);
    },
    now: () => new Date().toISOString(),
  };
}

const VALID_TIERS = new Set(["S", "A", "B", "C"]);

// --- Phase: pre --------------------------------------------------------------

async function runPre(ctx, deps) {
  const { profileId, flags, stdout, stderr } = ctx;
  const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);
  const batchSize = Number.isFinite(flags.batch) && flags.batch > 0
    ? flags.batch
    : DEFAULT_BATCH_SIZE;

  const profile = deps.loadProfile(profileId, { profilesDir });
  const filterRules = profile.filterRules || {};

  const applicationsPath = profile.paths.applicationsTsv;
  const { apps } = deps.loadApplications(applicationsPath);

  // 8-status set has no "Inbox". "Fresh / not triaged" now = status "To Apply"
  // AND no notion_page_id (never pushed). After prepare commit, the row keeps
  // status "To Apply" and gains a notion_page_id, so it stops appearing here.
  const inboxApps = apps.filter(
    (a) => a.status === "To Apply" && !a.notion_page_id
  );
  stdout(`fresh-to-prepare: ${inboxApps.length} jobs`);

  const activeCounts = buildActiveCounts(apps);
  const { passed, skipped: filteredOut } = applyPrepareFilter(
    inboxApps,
    filterRules,
    activeCounts
  );
  stdout(`after filter: ${passed.length} passed, ${filteredOut.length} skipped`);

  const batch = passed.slice(0, batchSize);
  stdout(`batch: ${batch.length} jobs (limit ${batchSize})`);

  // URL check
  stdout(`checking URLs…`);
  const urlRows = batch.map((a) => ({ ...a, url: a.url }));
  const urlResults = await deps.checkUrls(urlRows, deps.fetchFn, { concurrency: 12 });

  const alive = urlResults.filter((r) => r.alive);
  const dead = urlResults.filter((r) => !r.alive);
  stdout(`URLs: ${alive.length} alive, ${dead.length} dead`);

  // JD fetch for alive URLs only. Enrich each alive row with a `slug` parsed
  // from the public job URL so the ATS API endpoint is resolvable; map results
  // back to app keys by index (fetchAll preserves input order) since
  // jd_cache.fetchJd returns a cache-filename key, not the app composite key.
  const companyTiers = (profile.company_tiers) || {};
  const jdCacheDir = profile.paths.jdCacheDir;
  const jdInputs = alive.map((a) => ({ ...a, slug: parseSlugFromUrl(a.source, a.url) }));
  const jdResults = jdInputs.length > 0
    ? await deps.fetchJds(jdInputs, jdCacheDir, { fetchFn: deps.fetchFn }, { concurrency: 8 })
    : [];
  const jdByAppKey = {};
  for (let i = 0; i < jdInputs.length; i++) {
    jdByAppKey[jdInputs[i].key] = jdResults[i];
  }

  // Assemble batch entries. Track unique companies in batch whose tier is
  // unknown — SKILL Step 5.7 will assign them and pass back via results
  // (G-11/G-15: "Claude должен выставлять тиры самостоятельно").
  const unknownTierSet = new Set();
  const batchOut = urlResults.map((urlRes) => {
    const entry = {
      key: urlRes.key,
      source: urlRes.source,
      jobId: urlRes.jobId,
      companyName: urlRes.companyName,
      title: urlRes.title,
      url: urlRes.url,
      urlAlive: urlRes.alive,
      urlStatus: urlRes.status,
    };

    if (urlRes.boardRoot) entry.urlBoardRoot = true;

    const jd = jdByAppKey[urlRes.key];
    if (jd) {
      entry.jdStatus = jd.status;
      if (jd.text) entry.jdText = jd.text;
    } else {
      entry.jdStatus = urlRes.alive ? "not_fetched" : "skipped_dead_url";
    }

    const tierKnown = Object.prototype.hasOwnProperty.call(
      companyTiers,
      String(urlRes.companyName || "")
    );
    if (!tierKnown && urlRes.companyName) {
      entry.unknownTier = true;
      unknownTierSet.add(urlRes.companyName);
    }

    const salary = deps.calcSalary(urlRes.companyName, urlRes.title, { companyTiers });
    if (salary) entry.salary = salary;

    return entry;
  });

  const unknownTierCompanies = [...unknownTierSet].sort();

  const deadSkipped = dead.map((r) => ({
    key: r.key,
    reason: "url_dead",
    url: r.url,
    urlStatus: r.status,
  }));

  const context = {
    profileId,
    generatedAt: deps.now(),
    batchSize,
    batch: batchOut,
    skipped: [...filteredOut, ...deadSkipped],
    unknownTierCompanies,
    stats: {
      inboxTotal: inboxApps.length,
      afterFilter: passed.length,
      inBatch: batch.length,
      urlAlive: alive.length,
      urlDead: dead.length,
      unknownTierCompanies: unknownTierCompanies.length,
    },
  };

  if (unknownTierCompanies.length > 0) {
    stdout(
      `unknown tiers: ${unknownTierCompanies.length} companies — SKILL Step 5.7 will auto-assign`
    );
  }

  const contextPath = path.join(profile.paths.root, "prepare_context.json");

  if (flags.dryRun) {
    stdout(`(dry-run) would write prepare_context.json with ${batchOut.length} jobs`);
    stdout(`(dry-run) stats: ${JSON.stringify(context.stats)}`);
    return 0;
  }

  deps.writeFile(contextPath, JSON.stringify(context, null, 2));
  stdout(`wrote prepare_context.json (${batchOut.length} jobs → ${contextPath})`);
  stdout(
    `next: run the SKILL prepare mode with --profile ${profileId} to generate CLs and push to Notion`
  );
  return 0;
}

// --- Phase: commit -----------------------------------------------------------

async function runCommit(ctx, deps) {
  const { profileId, flags, stdout, stderr } = ctx;
  const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);

  if (!flags.resultsFile) {
    stderr("error: --results-file <path> is required for --phase commit");
    return 1;
  }

  let resultsRaw;
  try {
    resultsRaw = deps.readFile(flags.resultsFile);
  } catch (err) {
    stderr(`error: cannot read results file: ${err.message}`);
    return 1;
  }

  let results;
  try {
    const parsed = JSON.parse(resultsRaw);
    if (!parsed || !Array.isArray(parsed.results)) {
      throw new Error("results file must have a top-level 'results' array");
    }
    if (parsed.profileId && parsed.profileId !== profileId) {
      stderr(
        `warn: results file profileId "${parsed.profileId}" does not match --profile "${profileId}"`
      );
    }
    results = parsed.results;
  } catch (err) {
    stderr(`error: invalid results file: ${err.message}`);
    return 1;
  }

  const profile = deps.loadProfile(profileId, { profilesDir });
  const applicationsPath = profile.paths.applicationsTsv;
  const { apps } = deps.loadApplications(applicationsPath);

  const byKey = Object.fromEntries(apps.map((a) => [a.key, a]));
  const now = deps.now();

  // Persist tier assignments from SKILL Step 5.7 (G-11/G-15). The results
  // file may carry a top-level `companyTiers` map. Validate values, drop
  // tiers that already match, then write back via saveProfile so future
  // pre-runs find the company in profile.company_tiers and don't re-prompt.
  const tierUpdates = {};
  const tierStats = { added: 0, invalid: 0, alreadyKnown: 0 };
  let parsedTiers;
  try {
    parsedTiers = JSON.parse(resultsRaw).companyTiers;
  } catch (_err) {
    parsedTiers = undefined;
  }
  if (parsedTiers && typeof parsedTiers === "object" && !Array.isArray(parsedTiers)) {
    const existing = (profile.company_tiers) || {};
    for (const [name, tier] of Object.entries(parsedTiers)) {
      const t = String(tier || "").toUpperCase();
      if (!name || !VALID_TIERS.has(t)) {
        tierStats.invalid++;
        stderr(
          `warn: invalid tier "${tier}" for company "${name}" — must be one of S/A/B/C`
        );
        continue;
      }
      if (existing[name] === t) {
        tierStats.alreadyKnown++;
        continue;
      }
      tierUpdates[name] = t;
      tierStats.added++;
    }
  }

  if (tierStats.added > 0 && !flags.dryRun && deps.saveProfile) {
    try {
      deps.saveProfile(
        profileId,
        { company_tiers: { ...(profile.company_tiers || {}), ...tierUpdates } },
        { profilesDir }
      );
      stdout(
        `tiers: persisted ${tierStats.added} new tier(s) → profile.json (${
          Object.entries(tierUpdates)
            .map(([n, t]) => `${n}=${t}`)
            .join(", ")
        })`
      );
    } catch (err) {
      stderr(`warn: failed to persist company_tiers: ${err.message}`);
    }
  } else if (tierStats.added > 0 && flags.dryRun) {
    stdout(
      `(dry-run) would persist ${tierStats.added} new tier(s): ${
        Object.entries(tierUpdates)
          .map(([n, t]) => `${n}=${t}`)
          .join(", ")
      }`
    );
  }

  // Canonical archetype gate (G-18 backstop): block to_apply rows whose
  // resumeVer isn't a real key in resume_versions.json. Without this, a typo
  // from the SKILL would silently land in TSV → propagate to Notion's select
  // dropdown via sync push and pollute the canonical set. Empty profile set
  // → no gate (early profiles before resume_versions.json exists).
  const validArchetypes = new Set(
    Object.keys((profile.resumeVersions && profile.resumeVersions.versions) || {})
  );

  const VALID_DECISIONS = new Set(["to_apply", "archive", "skip"]);

  const updates = {
    toApply: 0,
    archive: 0,
    skip: 0,
    notFound: 0,
    invalidDecision: 0,
    invalidArchetype: 0,
  };
  for (const r of results) {
    const app = byKey[r.key];
    if (!app) {
      updates.notFound++;
      stderr(`warn: key not found in applications.tsv: ${r.key}`);
      continue;
    }

    if (!VALID_DECISIONS.has(r.decision)) {
      updates.invalidDecision++;
      stderr(
        `warn: unknown decision "${r.decision}" for key ${r.key} — treating as skip ` +
        `(valid: ${[...VALID_DECISIONS].join(", ")})`
      );
      updates.skip++;
      continue;
    }

    if (r.decision === "to_apply") {
      if (r.resumeVer && validArchetypes.size > 0 && !validArchetypes.has(r.resumeVer)) {
        updates.invalidArchetype++;
        stderr(
          `warn: unknown resumeVer "${r.resumeVer}" for key ${r.key} — treating as skip ` +
          `(valid keys: ${[...validArchetypes].join(", ")})`
        );
        updates.skip++;
        continue;
      }
      app.status = "To Apply";
      if (r.clKey) app.cl_key = r.clKey;
      if (r.resumeVer) app.resume_ver = r.resumeVer;
      if (r.notionPageId) app.notion_page_id = r.notionPageId;
      if (r.salaryMin !== undefined && r.salaryMin !== null && r.salaryMin !== "") {
        app.salary_min = String(r.salaryMin);
      }
      if (r.salaryMax !== undefined && r.salaryMax !== null && r.salaryMax !== "") {
        app.salary_max = String(r.salaryMax);
      }
      if (r.clPath) app.cl_path = r.clPath;
      else if (r.clKey && !app.cl_path) app.cl_path = r.clKey;
      app.updatedAt = now;
      updates.toApply++;
    } else if (r.decision === "archive") {
      app.status = "Archived";
      app.updatedAt = now;
      updates.archive++;
    } else {
      // "skip"
      updates.skip++;
    }
  }

  const extras = [];
  if (updates.invalidDecision > 0) extras.push(`${updates.invalidDecision} invalid decision`);
  if (updates.invalidArchetype > 0) extras.push(`${updates.invalidArchetype} invalid archetype`);
  if (tierStats.invalid > 0) extras.push(`${tierStats.invalid} invalid tier`);
  const extraStr = extras.length > 0 ? `, ${extras.join(", ")}` : "";

  stdout(
    `commit: ${updates.toApply} → To Apply, ${updates.archive} archived, ` +
    `${updates.skip} skipped, ${updates.notFound} not found${extraStr}`
  );

  if (flags.dryRun) {
    stdout(`(dry-run) would write ${apps.length} rows to ${applicationsPath}`);
    return 0;
  }

  deps.saveApplications(applicationsPath, apps);
  stdout(`updated ${applicationsPath}`);
  return 0;
}

// --- Factory + export --------------------------------------------------------

function makePrepareCommand(overrides = {}) {
  const deps = { ...makeDefaultDeps(), ...overrides };

  return async function prepareCommand(ctx) {
    const phase = (ctx.flags && ctx.flags.phase) || "";

    if (phase === "pre") return runPre(ctx, deps);
    if (phase === "commit") return runCommit(ctx, deps);

    ctx.stderr(
      `error: --phase <pre|commit> is required for the prepare command`
    );
    return 1;
  };
}

module.exports = makePrepareCommand();
module.exports.makePrepareCommand = makePrepareCommand;
module.exports.applyPrepareFilter = applyPrepareFilter;
module.exports.buildActiveCounts = buildActiveCounts;
