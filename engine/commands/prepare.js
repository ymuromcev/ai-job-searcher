// `prepare` command — two-phase processing of "fresh" pipeline rows.
//
// "Fresh" = status="Inbox" (RFC 014, 2026-05-04). Scan writes status="Inbox"
// for passed jobs; prepare consumes them and transitions to "To Apply" or
// "Archived". TSV-level 9-status set: Inbox / To Apply / Applied / Interview /
// Offer / Rejected / Closed / No Response / Archived. (Notion DBs keep the
// 8-status set; "Inbox" is local-only.)
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
//     decision "to_apply"  → status="To Apply" (transition from Inbox), set
//                            cl_key / resume_ver / notion_page_id. Card is
//                            now ready for the operator to actually submit.
//     decision "skip"      → no change (still "Inbox", reappears next pre run)
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
const { extractFromJd } = require("../core/jd_extract.js");
const { enforceGeo } = require("../core/geo_enforcer.js");
const { defaultFetch } = require("../modules/discovery/_http.js");
const { resolveProfilesDir } = require("../core/paths.js");
const { slugifyCompany } = require("../core/company_slug.js");
const { generateCoverLetterPdf } = require("../modules/generators/cover_letter_pdf.js");
const { planDedup } = require("../core/tsv_dedup.js");
const notionSync = require("../core/notion_sync.js");
const { makeCompanyResolver } = require("../core/company_resolver.js");
const notionJobPage = require("../core/notion_job_page.js");

// Active statuses that count toward the company cap. "To Apply" is included
// because every triaged-and-prepared row is committed to be applied —
// counting it prevents over-preparing for the same company. "Inbox" is NOT
// counted: those rows are pre-triage and may yet be archived. Also excluded:
// Archived / Rejected / Closed / No Response. (RFC 014 / TSV 9-status set.)
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

// BL-9 (TSV schema v4): drop rows the SKILL has already judged in a previous
// run before they hit `applyPrepareFilter` / URL-check / JD-fetch. Two cases:
//
//   * `fit_score === "Weak"` (or legacy `skip_reason === "weak_fit"`)
//     → Claude already decided this isn't a fit. Re-asking just burns tokens.
//
//   * `skip_reason === "duplicate"`
//     → Claude flagged the row as a SKILL-level dupe (same posting under a
//       different key, e.g. post-prefix-migration). Engine-level fuzzy dedup
//       happens at scan; this catches the residue Claude found at SKILL time.
//
// Engine-level skips (company_cap / blocklists / geo) are NOT persisted on
// the row and continue to be recomputed each run by `applyPrepareFilter` —
// rule changes must take effect immediately. Only SKILL verdicts persist.
//
// BL-9 Step 5: `mode = "weak-fallback"` opts INTO including already-Weak rows
// in the passed pool (the autonomous prepare loop pulls them as fallback when
// Strong+Medium can't fill the batch). `duplicate` rows are still always
// dropped — they're noise regardless of mode.
function filterAlreadyEvaluated(apps, { mode = "default" } = {}) {
  const passed = [];
  const skipped = [];
  const includeWeak = mode === "weak-fallback";
  for (const app of apps) {
    if (!includeWeak && (app.fit_score === "Weak" || app.skip_reason === "weak_fit")) {
      skipped.push({ key: app.key, reason: "already_evaluated_weak", url: app.url });
      continue;
    }
    if (app.skip_reason === "duplicate") {
      skipped.push({ key: app.key, reason: "already_evaluated_duplicate", url: app.url });
      continue;
    }
    passed.push(app);
  }
  return { passed, skipped };
}

function applyPrepareFilter(apps, rules, activeCounts) {
  const companyCap = (rules && rules.company_cap) || {};
  const maxActive = companyCap.max_active != null ? Number(companyCap.max_active) : Infinity;
  const capOverrides = companyCap.overrides || {};

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

  const titlePatterns = (Array.isArray(rules && rules.title_blocklist) ? rules.title_blocklist : [])
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
      const parts = titleLower
        .split("/")
        .map((p) => p.trim())
        .filter(Boolean);
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

    // L-4 (RFC 013): profile-level geo enforcement at prepare time.
    // app.location comes from TSV (schema v3, G-5). Empty location in metro
    // mode → geo_no_location reject. The check is gated on rules.geo.mode
    // !== "unrestricted" so Jared sees zero behavior change.
    if (rules && rules.geo && rules.geo.mode && rules.geo.mode !== "unrestricted") {
      const locsForGeo = app.location ? [app.location] : [];
      const geoResult = enforceGeo(locsForGeo, rules.geo);
      if (!geoResult.ok) {
        skipped.push({
          key: app.key,
          reason: geoResult.reason,
          mode: rules.geo.mode,
          url: app.url,
        });
        continue;
      }
    }

    passed.push(app);
    counts[app.companyName] = current + 1;
  }

  return { passed, skipped };
}

// --- Shared helpers (used by both fresh and topup modes) --------------------

// G-12 fill-up loop: consume `passed` in chunks, URL-check each, stop when we
// have `target` alive entries (or the pool is exhausted). Returns the alive
// results (capped at target), all URL-check results in chunk order
// (alive+dead, unbounded — caller may exclude beyond-target alive overshoot),
// and how many input rows were consumed from `passed`.
//
// BL-9 Step 4: extracted from runPre so runPreTopup can re-use the same
// invariants (chunked URL-checks, alive-only target, dead reporting). Caller
// constructs the batch entries from `aliveResults`; `passed[consumed:]` is
// the remaining queue.
async function fillUpAliveBatch(passed, target, deps) {
  const aliveResults = [];
  const allUrlResults = [];
  let consumed = 0;
  while (aliveResults.length < target && consumed < passed.length) {
    const remaining = target - aliveResults.length;
    // Chunk size: ask for what's still needed, with a small floor so we don't
    // chip away one-at-a-time on a string of dead URLs.
    const chunkSize = Math.max(remaining, 5);
    const chunk = passed.slice(consumed, consumed + chunkSize);
    consumed += chunk.length;
    const checked = await deps.checkUrls(
      chunk.map((a) => ({ ...a, url: a.url })),
      deps.fetchFn,
      { concurrency: 12 }
    );
    allUrlResults.push(...checked);
    for (const r of checked) {
      if (r.alive && aliveResults.length < target) {
        aliveResults.push(r);
      }
    }
  }
  return { aliveResults, allUrlResults, consumed };
}

// Build a single batch entry (the SKILL-facing JSON shape) from a URL-check
// result + matching JD result + profile context. Mutates `unknownTierSet` to
// accumulate companies whose tier hasn't been assigned yet (G-11/G-15).
//
// BL-9 Step 4: extracted so both fresh and topup modes produce identical
// entry shape. No behavior change vs the inline block runPre had before.
//
// BL-9 Step 5: optional `wasAlreadyWeak` opts the entry into the SKILL's
// weak-fallback path. The SKILL reads it as "the row was judged Weak in a
// prior run, do not re-judge — carry over fit_score/fit_rationale from TSV
// and proceed straight to CL gen + Notion push as a fallback candidate".
function buildBatchEntry(
  urlRes,
  jd,
  profile,
  deps,
  companyTiers,
  salaryOpts,
  unknownTierSet,
  opts = {}
) {
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

  if (opts.wasAlreadyWeak) {
    entry.wasAlreadyWeak = true;
    if (opts.priorFitScore) entry.priorFitScore = opts.priorFitScore;
    if (opts.priorFitRationale) entry.priorFitRationale = opts.priorFitRationale;
  }

  if (urlRes.boardRoot) entry.urlBoardRoot = true;

  if (jd) {
    entry.jdStatus = jd.status;
    if (jd.text) entry.jdText = jd.text;
  } else {
    entry.jdStatus = urlRes.alive ? "not_fetched" : "skipped_dead_url";
  }

  // L-5: extract Schedule + Requirements from JD text. Fields land on the
  // entry only when extractors return non-null. Profiles whose property_map
  // doesn't declare schedule/requirements simply ignore these in Step 9
  // (back-compat: Jared has no Schedule field, his pages stay unchanged).
  if (entry.jdText) {
    const extracted = deps.extractFromJd(entry.jdText);
    if (extracted.schedule) entry.schedule = extracted.schedule;
    if (extracted.requirements) entry.requirements = extracted.requirements;
  }

  // L-4 (RFC 013): geo decision. Entries that reach the batch already passed
  // applyPrepareFilter geo check, so geo_decision is "allowed" by construction.
  // We still surface the field on every entry so SKILL Step 3 has a
  // deterministic source-of-truth. matchedBy describes WHY it passed.
  if (profile.geo) {
    const locsForGeo = urlRes.location ? [urlRes.location] : [];
    const geoResult = enforceGeo(locsForGeo, profile.geo);
    entry.geo_decision = geoResult.ok ? "allowed" : "rejected";
    if (geoResult.matchedBy) entry.geo_matched_by = geoResult.matchedBy;
    if (geoResult.reason) entry.geo_reason = geoResult.reason;
  }

  const tierKnown = Object.prototype.hasOwnProperty.call(
    companyTiers,
    String(urlRes.companyName || "")
  );
  if (!tierKnown && urlRes.companyName) {
    entry.unknownTier = true;
    unknownTierSet.add(urlRes.companyName);
  }

  const salary = deps.calcSalary(urlRes.companyName, urlRes.title, {
    companyTiers,
    ...salaryOpts,
  });
  if (salary) entry.salary = salary;

  return entry;
}

// JD-fetch + index by app key. Wraps fetchJds so callers don't have to
// re-derive the slug parsing or empty-input branch.
async function fetchJdsByKey(aliveResults, jdCacheDir, deps) {
  const jdInputs = aliveResults.map((a) => ({
    ...a,
    slug: parseSlugFromUrl(a.source, a.url),
  }));
  const jdResults =
    jdInputs.length > 0
      ? await deps.fetchJds(jdInputs, jdCacheDir, { fetchFn: deps.fetchFn }, { concurrency: 8 })
      : [];
  const jdByAppKey = {};
  for (let i = 0; i < jdInputs.length; i++) {
    jdByAppKey[jdInputs[i].key] = jdResults[i];
  }
  return jdByAppKey;
}

// Compute skip-reason breakdown from a flat list of skip records.
function computeSkipReasons(skipped) {
  const skipReasons = {};
  for (const s of skipped) {
    const reason = s.reason || "unknown";
    skipReasons[reason] = (skipReasons[reason] || 0) + 1;
  }
  return skipReasons;
}

// RFC 030: surface role_targets to the SKILL via prepare_context.json.
// Strips regex patterns — scan already applied them; the LLM only needs
// (id, name, fit_treatment) per track plus the treatments-prose to reason
// about Fit Score. Returns null if no role_targets configured (back-compat
// for profiles that pre-date RFC 030 — SKILL falls back to memory cues).
function buildRoleTargetsForContext(rt) {
  if (!rt || !Array.isArray(rt.tracks) || rt.tracks.length === 0) return null;
  return {
    tracks: rt.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      fit_treatment: t.fit_treatment || "primary",
      ...(t.bridge_note ? { bridge_note: t.bridge_note } : {}),
    })),
    fit_treatments: rt.fit_treatments || {},
  };
}

// RFC 024 (BL-28): forward-looking Inbox-health signal for the SKILL.
// "How many filter-passing rows are left in Inbox for the NEXT prepare run?"
// Live smoke 2026-05-11 made the gap visible: target=30, got 26, but the
// engine never said "your NEXT run will also be short — scan first." This
// helper produces a structured field the SKILL reads at the end of
// `/job-pipeline` to decide whether to prompt the operator to run `scan`.
//
// `remainingViable` is the count of rows that passed filters and
// already-evaluated checks but were not consumed into this batch — for
// `runPre` that's `deferredQueue.length` (passed.slice(consumed)); for
// `runPreTopup` / `runPreWeakFallback` it's the rebuilt `stillQueuedKeys`
// length after each merge. Rows filtered out by company_cap, blocklists,
// etc. are NOT counted as viable — they'd be filtered again next time.
//
// Threshold is exactly `target` (no coefficient). `target` is the operator's
// chosen `--batch`; an extra cushion knob would never get tuned in practice.
function computeInboxHealth({ remainingViable, target, inBatch, dropsThisRun }) {
  const safeRemaining =
    Number.isFinite(remainingViable) && remainingViable >= 0 ? remainingViable : 0;
  const safeTarget = Number.isFinite(target) && target > 0 ? target : 0;
  // target=0 (defensive: no shortfall possible) → "healthy" vacuously.
  const status = safeRemaining < safeTarget ? "low" : "healthy";
  return {
    status,
    remaining_viable: safeRemaining,
    target: safeTarget,
    short_by: Math.max(0, safeTarget - safeRemaining),
    in_batch: Number.isFinite(inBatch) && inBatch >= 0 ? inBatch : 0,
    drops_this_run: dropsThisRun && typeof dropsThisRun === "object" ? dropsThisRun : {},
    recommendation: status === "low" ? "run_scan" : null,
  };
}

// RFC 014 + back-compat: a TSV row is "fresh / not yet committed to apply"
// when status is "Inbox" (post-RFC014) OR status="To Apply" with no
// notion_page_id (legacy rows from before the migration).
function isFreshInboxApp(app) {
  return app.status === "Inbox" || (app.status === "To Apply" && !app.notion_page_id);
}

// BL-9 Step 5: signal for the autonomous SKILL loop. `inboxExhausted=true`
// means there's nothing left in the TSV that could enter a future batch —
// every fresh-inbox row is either already in the current batch or marked
// `skip_reason="duplicate"` (which we always drop). The SKILL's loop should
// stop iterating when this flips true, even if it hasn't reached its 30-job
// target.
//
// Note: weak-flagged rows are NOT counted as exhausted in normal mode
// (they're still picked up by `--mode weak-fallback`). They become exhausted
// only after weak-fallback has pulled them into the batch.
function computeInboxExhausted(apps, batchKeys) {
  for (const app of apps) {
    if (!isFreshInboxApp(app)) continue;
    if (batchKeys.has(app.key)) continue;
    if (app.skip_reason === "duplicate") continue;
    return false;
  }
  return true;
}

// --- Deps & defaults ---------------------------------------------------------

function makeDefaultDeps() {
  return {
    loadProfile: profileLoader.loadProfile,
    saveProfile: profileLoader.saveProfile,
    loadSecrets: profileLoader.loadSecrets,
    loadApplications: applicationsTsv.load,
    saveApplications: applicationsTsv.save,
    checkUrls: checkAll,
    fetchJds: fetchAllJds,
    calcSalary,
    extractFromJd,
    fetchFn: defaultFetch,
    readFile: (p) => fs.readFileSync(p, "utf8"),
    writeFile: (p, data) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, p);
    },
    fileExists: (p) => fs.existsSync(p),
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
    copyFileSync: (src, dst) => fs.copyFileSync(src, dst),
    generateCoverLetterPdf,
    slugifyCompany,
    // RFC 022: per-row Notion push in commit phase. All Notion deps are
    // injectable so unit / integration tests can swap in a mock client +
    // resolver without hitting the network.
    makeNotionClient: notionSync.makeClient,
    resolveDataSourceId: notionSync.resolveDataSourceId,
    createJobPage: notionSync.createJobPage,
    makeCompanyResolver,
    pushJobPage: notionJobPage.pushJobPage,
    formatSalaryDisplay: notionJobPage.formatSalaryDisplay,
    now: () => new Date().toISOString(),
  };
}

// BL-13 (2026-05-06): auto-dedup TSV at the start of `prepare --phase pre`.
// Code-first: the user never reaches for `validate --dedup --apply` to clean
// up legacy-prefix collisions or BL-12-era residue — the engine collapses
// non-suspicious duplicate groups (with a backup) before any other prepare
// work runs. Suspicious groups (rows whose company or url path disagree on
// the same canonical key) are NEVER auto-collapsed; they're surfaced as a
// stderr warning so the user can review manually.
//
//   apps              — array of apps loaded from applications.tsv
//   applicationsPath  — path to applications.tsv (for backup + save)
//   ctx               — { stdout, stderr, flags } (flags.dryRun gates writes)
//   deps              — { now, copyFileSync, saveApplications, fileExists }
// Returns the (possibly mutated) apps list. When pairs > 0 and --dry-run is
// set, returns the original apps unchanged but prints what WOULD happen.
function runAutoDedup(apps, applicationsPath, ctx, deps) {
  const plan = planDedup(apps);
  const dryRun = !!ctx.flags && ctx.flags.dryRun;

  if (plan.pairs === 0 && plan.suspicious.length === 0) {
    return apps; // silent: no duplicates, no work
  }

  if (plan.pairs > 0) {
    const removed = plan.dropped.length;
    const kept = plan.kept.length;
    if (dryRun) {
      ctx.stdout(
        `dedup: would auto-collapse ${plan.pairs} duplicate group(s) — ` +
          `would keep ${kept} row(s), would remove ${removed} row(s) (dry-run, no write)`
      );
    } else {
      const stamp = String(deps.now()).replace(/[:.]/g, "-");
      const backupPath = `${applicationsPath}.pre-dedup-${stamp}`;
      if (deps.fileExists(applicationsPath)) {
        deps.copyFileSync(applicationsPath, backupPath);
      }
      deps.saveApplications(applicationsPath, plan.kept);
      ctx.stdout(
        `dedup: found ${plan.pairs} duplicate group(s) in TSV — ` +
          `auto-collapsed, kept ${kept} row(s), removed ${removed} row(s) ` +
          `(backup: ${path.basename(backupPath)})`
      );
    }
  }

  if (plan.suspicious.length > 0) {
    ctx.stderr(
      `dedup: ${plan.suspicious.length} suspicious group(s) NOT auto-collapsed ` +
        `(rows disagree on company or url) — manual review required, ` +
        `run \`validate --dedup\` for details`
    );
  }

  // After collapse, the rest of runPre uses the deduped apps. On dry-run we
  // return the original apps so downstream filtering matches what the actual
  // pre-phase would see if --apply were given.
  return dryRun ? apps : plan.kept;
}

const VALID_TIERS = new Set(["S", "A", "B", "C"]);

// --- Phase: pre --------------------------------------------------------------

async function runPre(ctx, deps) {
  const { profileId, flags, stdout, stderr } = ctx;
  const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);
  const batchSize =
    Number.isFinite(flags.batch) && flags.batch > 0 ? flags.batch : DEFAULT_BATCH_SIZE;

  const profile = deps.loadProfile(profileId, { profilesDir });
  // L-4 (RFC 013): inject profile.geo into filter rules so applyPrepareFilter
  // can call enforceGeo. Profiles without `profile.geo` get
  // {mode:"unrestricted"} from normalizeGeo (no-op for Jared).
  const filterRules = { ...(profile.filterRules || {}), geo: profile.geo };

  const applicationsPath = profile.paths.applicationsTsv;
  const loaded = deps.loadApplications(applicationsPath);

  // BL-13: collapse non-suspicious duplicate groups before any filtering.
  // Silent when there's nothing to do; emits an explicit "found N + collapsed
  // M, removed K (backup: …)" line otherwise so the user sees in Claude's
  // final report that the engine touched the TSV.
  const apps = runAutoDedup(loaded.apps, applicationsPath, ctx, deps);

  // RFC 014 (2026-05-04): "Fresh / not triaged" = status "Inbox" (TSV-only).
  // After commit, the row transitions to "To Apply" (decision=to_apply) or
  // "Archived" (decision=archive) and stops appearing in this filter.
  // Back-compat: pre-RFC014 rows with status="To Apply" + no notion_page_id
  // are also accepted — backfill script normally rewrites them, but the dual
  // filter protects against partial migrations / forgotten profiles.
  const inboxApps = apps.filter(isFreshInboxApp);
  stdout(`fresh-to-prepare: ${inboxApps.length} jobs`);

  // BL-9: pre-filter rows the SKILL has already evaluated in an earlier run.
  // These never reach URL-check / JD-fetch / SKILL judgement, so we don't
  // re-pay the token cost on every run.
  const { passed: notYetEvaluated, skipped: alreadyEvaluatedSkips } =
    filterAlreadyEvaluated(inboxApps);
  if (alreadyEvaluatedSkips.length > 0) {
    stdout(
      `already-evaluated: ${alreadyEvaluatedSkips.length} skipped (` +
        `${alreadyEvaluatedSkips.filter((s) => s.reason === "already_evaluated_weak").length} weak, ` +
        `${alreadyEvaluatedSkips.filter((s) => s.reason === "already_evaluated_duplicate").length} duplicate)`
    );
  }

  const activeCounts = buildActiveCounts(apps);
  const { passed, skipped: filteredOut } = applyPrepareFilter(
    notYetEvaluated,
    filterRules,
    activeCounts
  );
  stdout(`after filter: ${passed.length} passed, ${filteredOut.length} skipped`);

  // G-12: fill-up loop. Earlier behavior took the first batchSize candidates
  // and URL-checked them, so dead URLs would shrink the actual pushable count
  // (e.g. 30 → 18 alive). Now we keep pulling from `passed` in chunks until
  // we have batchSize alive entries (or the pool is exhausted). Dead entries
  // from consumed chunks are reported in `skipped` with reason "url_dead";
  // BL-9 Step 4: unconsumed `passed` entries are persisted as `deferredQueue`
  // (array of TSV keys) on the context so a follow-up `--mode topup` run can
  // pull more without rebuilding the filter pipeline from scratch.
  stdout(`checking URLs (target: ${batchSize} alive)…`);
  const { aliveResults, allUrlResults, consumed } = await fillUpAliveBatch(passed, batchSize, deps);
  const dead = allUrlResults.filter((r) => !r.alive);
  stdout(
    `URLs: checked ${allUrlResults.length}, ${aliveResults.length} alive (target ${batchSize}), ${dead.length} dead, ${passed.length - consumed} deferred`
  );

  // JD fetch for alive URLs only.
  const companyTiers = profile.company_tiers || {};
  // L-1: per-profile salary config (parser + matrix + COL). null when block
  // missing → calcSalary falls back to engine defaults (Jared parity).
  const salaryOpts = profile.salaryConfig || {};
  const jdCacheDir = profile.paths.jdCacheDir;
  const jdByAppKey = await fetchJdsByKey(aliveResults, jdCacheDir, deps);

  // Assemble batch entries. Track unique companies in batch whose tier is
  // unknown — SKILL Step 5.7 will assign them and pass back via results
  // (G-11/G-15: "Claude должен выставлять тиры самостоятельно").
  const unknownTierSet = new Set();
  const batchOut = aliveResults.map((urlRes) =>
    buildBatchEntry(
      urlRes,
      jdByAppKey[urlRes.key],
      profile,
      deps,
      companyTiers,
      salaryOpts,
      unknownTierSet
    )
  );

  const unknownTierCompanies = [...unknownTierSet].sort();

  const deadSkipped = dead.map((r) => ({
    key: r.key,
    reason: "url_dead",
    url: r.url,
    urlStatus: r.status,
  }));

  const allSkipped = [...alreadyEvaluatedSkips, ...filteredOut, ...deadSkipped];
  // G-12: skip-reason breakdown so the user sees WHY 12 jobs got skipped
  // (company_cap: 5, title_blocklist: 2, url_dead: 1, …) instead of just
  // a total count.
  const skipReasons = computeSkipReasons(allSkipped);

  // BL-9 Step 4: unconsumed (deferred) keys persisted on the context so a
  // follow-up topup run can pull from them without re-running the engine
  // filter. Topup re-validates each key against TSV (status / fit_score) and
  // applyPrepareFilter (rules may have changed) before URL-checking.
  const deferredQueue = passed.slice(consumed).map((a) => a.key);

  // L-2: surface profile-level memory so SKILL Step 1 / Humanizer Rules read
  // from prepare_context instead of disk. Missing files come back as null and
  // the SKILL falls back to resume_versions.json / cover_letter_template.md.
  const memory = profile.memory || { writingStyle: null, resumeKeyPoints: null, feedback: [] };

  // RFC 030: surface role_targets so SKILL Fit Score knows which tracks are
  // acceptable and how to treat each (primary / bridge). Strip regex patterns
  // — the LLM doesn't need them (scan already enforced the title gate) and
  // they bloat the prompt. Treatments-prose only.
  const roleTargets = buildRoleTargetsForContext(profile.filterRules && profile.filterRules.role_targets);

  // BL-9 Step 5: signal for the autonomous SKILL loop ("Inbox is empty, stop
  // iterating even if 30-target not yet hit").
  const batchKeys = new Set(batchOut.map((e) => e.key));
  const inboxExhausted = computeInboxExhausted(apps, batchKeys);

  // RFC 024 (BL-28): forward-looking signal for SKILL `/job-pipeline` final
  // step. `remaining_viable < target` → SKILL prompts operator to run `scan`
  // before next prepare. See computeInboxHealth above for the contract.
  const inbox_health = computeInboxHealth({
    remainingViable: deferredQueue.length,
    target: batchSize,
    inBatch: batchOut.length,
    dropsThisRun: skipReasons,
  });

  // G-16: explicit schema version on the context file so future schema bumps
  // can migrate (or fail loudly) instead of silently re-using stale fields.
  // Bump only when shape changes break consumers; the SKILL must handle
  // unknown major versions defensively. Reader contract: "if absent, treat as 1".
  const context = {
    version: 1,
    profileId,
    generatedAt: deps.now(),
    mode: "fresh",
    memory,
    roleTargets,
    salaryConfig: profile.salaryConfig || null,
    batchSize,
    batch: batchOut,
    skipped: allSkipped,
    deferredQueue,
    unknownTierCompanies,
    stats: {
      inboxTotal: inboxApps.length,
      alreadyEvaluated: alreadyEvaluatedSkips.length,
      afterFilter: passed.length,
      inBatch: batchOut.length,
      urlChecked: allUrlResults.length,
      urlAlive: aliveResults.length,
      urlDead: dead.length,
      deferred: deferredQueue.length,
      unknownTierCompanies: unknownTierCompanies.length,
      inboxExhausted,
      skipReasons,
    },
    inbox_health,
  };

  const skipBreakdown = Object.entries(skipReasons)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  if (skipBreakdown) {
    stdout(`skip reasons — ${skipBreakdown}`);
  }
  if (passed.length - consumed > 0) {
    stdout(
      `deferred: ${passed.length - consumed} eligible jobs not URL-checked (target met) — they stay queued for next pre run`
    );
  }

  if (unknownTierCompanies.length > 0) {
    stdout(
      `unknown tiers: ${unknownTierCompanies.length} companies — SKILL Step 5.7 will auto-assign`
    );
  }

  // RFC 024: one-line forward-looking summary. SKILL reads the structured
  // field below; this stdout line is for the standalone-CLI operator.
  stdout(
    `inbox health: ${inbox_health.status} (${inbox_health.remaining_viable} viable for next run, target ${inbox_health.target})`
  );

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

// --- Phase: pre, mode topup --------------------------------------------------
//
// BL-9 Step 4: two-pass prepare. After a fresh `--phase pre` writes the first
// `batchSize` jobs to prepare_context.json, the SKILL may judge several of
// them as Weak / duplicate / archive and the resulting `to_apply` count drops
// below batch capacity. Instead of waiting for the next scan to refill the
// queue, the operator can run:
//
//     prepare --phase pre --mode topup --need K
//
// This pulls K next entries from `context.deferredQueue` (the unconsumed tail
// from the fresh run), URL-checks + JD-fetches them, builds new batch entries,
// appends to `context.batch[]`, and rewrites the context file.
//
// Re-validation: between fresh and topup the operator may have:
//   * committed some keys (status moves out of Inbox → drop from queue).
//   * received a SKILL verdict that flipped earlier rows to Weak (now in
//     fit_score=Weak → filterAlreadyEvaluated drops them).
//   * edited filter_rules.json (blocklists tightened → applyPrepareFilter
//     drops them).
// Topup re-applies all three checks so the new batch entries are always
// fresh-by-construction.
async function runPreTopup(ctx, deps) {
  const { profileId, flags, stdout, stderr } = ctx;
  const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);

  const profile = deps.loadProfile(profileId, { profilesDir });
  const filterRules = { ...(profile.filterRules || {}), geo: profile.geo };
  const contextPath = path.join(profile.paths.root, "prepare_context.json");

  // 1) Load existing context.
  let prev;
  try {
    prev = JSON.parse(deps.readFile(contextPath));
  } catch (err) {
    stderr(`error: cannot read prepare_context.json at ${contextPath}: ${err.message}`);
    stderr(`hint: run --mode fresh first (default mode) to create the context file`);
    return 1;
  }
  if (!Array.isArray(prev.batch)) {
    stderr(`error: prepare_context.json missing 'batch' array`);
    return 1;
  }
  const prevQueue = Array.isArray(prev.deferredQueue) ? prev.deferredQueue : [];
  const prevSkipped = Array.isArray(prev.skipped) ? prev.skipped : [];
  const prevBatch = prev.batch;
  const prevStats = prev.stats || {};
  const prevUnknownTiers = Array.isArray(prev.unknownTierCompanies)
    ? prev.unknownTierCompanies
    : [];
  const batchSize = Number.isFinite(prev.batchSize) ? prev.batchSize : DEFAULT_BATCH_SIZE;

  // 2) Compute need: explicit flag, else fill the deficit (batchSize - current).
  const explicitNeed = Number.isFinite(flags.need) && flags.need > 0 ? flags.need : null;
  const need = explicitNeed != null ? explicitNeed : Math.max(0, batchSize - prevBatch.length);
  if (need === 0) {
    stdout(
      `topup: nothing to add (current batch ${prevBatch.length} already at batchSize ${batchSize})`
    );
    stdout(`hint: pass --need <K> to force pulling more entries`);
    return 0;
  }
  stdout(
    `topup: need ${need} more entries (current batch ${prevBatch.length}, queue ${prevQueue.length})`
  );

  if (prevQueue.length === 0) {
    stdout(
      `topup: deferredQueue is empty — nothing to top up from. Run --mode fresh after a new scan.`
    );
    return 0;
  }

  // 3) Re-load TSV and re-validate queued keys.
  const applicationsPath = profile.paths.applicationsTsv;
  const { apps } = deps.loadApplications(applicationsPath);
  const byKey = Object.fromEntries(apps.map((a) => [a.key, a]));
  // Drop committed keys (status moved out of Inbox / has notion_page_id).
  const inBatchKeys = new Set(prevBatch.map((e) => e.key));
  const liveQueueApps = [];
  const droppedFromQueue = [];
  for (const key of prevQueue) {
    if (inBatchKeys.has(key)) continue; // shouldn't happen, but defensive
    const app = byKey[key];
    if (!app) {
      droppedFromQueue.push({ key, reason: "not_in_tsv" });
      continue;
    }
    if (!isFreshInboxApp(app)) {
      droppedFromQueue.push({ key, reason: "no_longer_fresh", url: app.url });
      continue;
    }
    liveQueueApps.push(app);
  }
  if (droppedFromQueue.length > 0) {
    stdout(`topup: dropped ${droppedFromQueue.length} stale queue entries (committed or removed)`);
  }

  // 4) filterAlreadyEvaluated (commit may have written new Weak / duplicate verdicts).
  const { passed: notYetEvaluated, skipped: alreadyEvaluatedSkips } =
    filterAlreadyEvaluated(liveQueueApps);
  if (alreadyEvaluatedSkips.length > 0) {
    stdout(
      `topup: ${alreadyEvaluatedSkips.length} already-evaluated dropped (` +
        `${alreadyEvaluatedSkips.filter((s) => s.reason === "already_evaluated_weak").length} weak, ` +
        `${alreadyEvaluatedSkips.filter((s) => s.reason === "already_evaluated_duplicate").length} duplicate)`
    );
  }

  // 5) applyPrepareFilter (rules may have changed; cap counts include the
  //    fresh batch entries that are now To Apply / about to be).
  const activeCounts = buildActiveCounts(apps);
  // Pre-account for prevBatch entries: they're going to become To Apply, so
  // count them toward the cap. Without this, topup could push past the cap.
  for (const e of prevBatch) {
    const co = e.companyName;
    if (co) activeCounts[co] = (activeCounts[co] || 0) + 1;
  }
  const { passed, skipped: filteredOut } = applyPrepareFilter(
    notYetEvaluated,
    filterRules,
    activeCounts
  );
  stdout(`topup: after filter ${passed.length} passed, ${filteredOut.length} skipped`);

  // 6) Fill-up loop on the residue.
  stdout(`topup: checking URLs (target: ${need} alive)…`);
  const { aliveResults, allUrlResults, consumed } = await fillUpAliveBatch(passed, need, deps);
  const dead = allUrlResults.filter((r) => !r.alive);
  stdout(
    `topup: URLs checked ${allUrlResults.length}, ${aliveResults.length} alive (target ${need}), ${dead.length} dead, ${passed.length - consumed} still queued`
  );

  // 7) JD fetch + entry construction.
  const companyTiers = profile.company_tiers || {};
  const salaryOpts = profile.salaryConfig || {};
  const jdCacheDir = profile.paths.jdCacheDir;
  const jdByAppKey = await fetchJdsByKey(aliveResults, jdCacheDir, deps);

  const unknownTierSet = new Set(prevUnknownTiers);
  const newEntries = aliveResults.map((urlRes) =>
    buildBatchEntry(
      urlRes,
      jdByAppKey[urlRes.key],
      profile,
      deps,
      companyTiers,
      salaryOpts,
      unknownTierSet
    )
  );

  // 8) Build new skip records and rebuild the queue.
  const deadSkipped = dead.map((r) => ({
    key: r.key,
    reason: "url_dead",
    url: r.url,
    urlStatus: r.status,
  }));
  // Stale queue drops carry their own reasons but are still skips.
  const newSkipped = [
    ...alreadyEvaluatedSkips,
    ...filteredOut,
    ...deadSkipped,
    ...droppedFromQueue,
  ];

  // Remaining queue: apps that were eligible but not URL-checked yet, plus any
  // alive overshoot that didn't fit into `need` (rare with chunk-floor=5).
  // We rebuild from `passed.slice(consumed)` — everything still pending — and
  // exclude keys we just URL-checked.
  const checkedKeys = new Set(allUrlResults.map((r) => r.key));
  const stillQueuedKeys = [];
  for (const a of passed.slice(consumed)) {
    if (!checkedKeys.has(a.key)) stillQueuedKeys.push(a.key);
  }

  // 9) Merge into context.
  const mergedBatch = [...prevBatch, ...newEntries];
  const mergedBatchKeys = new Set(mergedBatch.map((e) => e.key));
  const inboxExhausted = computeInboxExhausted(apps, mergedBatchKeys);
  const mergedSkipReasons = computeSkipReasons([...prevSkipped, ...newSkipped]);
  // RFC 024 (BL-28): keep `inbox_health` written from every prepare_context.json
  // writer so the SKILL contract is uniform regardless of which mode produced
  // the final context (fresh / topup / weak-fallback).
  const merged_inbox_health = computeInboxHealth({
    remainingViable: stillQueuedKeys.length,
    target: batchSize,
    inBatch: mergedBatch.length,
    dropsThisRun: mergedSkipReasons,
  });
  const merged = {
    ...prev,
    mode: "topup",
    generatedAt: deps.now(),
    batch: mergedBatch,
    skipped: [...prevSkipped, ...newSkipped],
    deferredQueue: stillQueuedKeys,
    unknownTierCompanies: [...unknownTierSet].sort(),
    stats: {
      ...prevStats,
      alreadyEvaluated: (prevStats.alreadyEvaluated || 0) + alreadyEvaluatedSkips.length,
      inBatch: mergedBatch.length,
      urlChecked: (prevStats.urlChecked || 0) + allUrlResults.length,
      urlAlive: (prevStats.urlAlive || 0) + aliveResults.length,
      urlDead: (prevStats.urlDead || 0) + dead.length,
      deferred: stillQueuedKeys.length,
      unknownTierCompanies: unknownTierSet.size,
      topupRuns: (prevStats.topupRuns || 0) + 1,
      inboxExhausted,
      skipReasons: mergedSkipReasons,
    },
    inbox_health: merged_inbox_health,
  };

  if (flags.dryRun) {
    stdout(`(dry-run) would append ${newEntries.length} entries → batch=${merged.batch.length}`);
    stdout(`(dry-run) stats: ${JSON.stringify(merged.stats)}`);
    return 0;
  }

  deps.writeFile(contextPath, JSON.stringify(merged, null, 2));
  stdout(
    `topup: appended ${newEntries.length} entries → batch=${merged.batch.length} (${contextPath})`
  );
  stdout(
    `inbox health: ${merged_inbox_health.status} (${merged_inbox_health.remaining_viable} viable for next run, target ${merged_inbox_health.target})`
  );
  stdout(
    `next: re-run the SKILL prepare mode for the new keys: ${newEntries.map((e) => e.key).join(", ")}`
  );
  return 0;
}

// --- Phase: pre, mode weak-fallback ------------------------------------------
//
// BL-9 Step 5: the fallback step of the autonomous prepare loop. After the
// SKILL has run several `--mode topup` iterations and Strong + Medium
// candidates still don't fill the batch (target = batchSize, e.g. 30), the
// loop falls back to Weak candidates so the user gets a complete batch
// instead of underfilling Notion.
//
// Source pool (deduped by key, neither bucket counted twice):
//   1. Whatever's left in `context.deferredQueue` — rows that passed the
//      filter pipeline in the original fresh run but never got URL-checked
//      (target was already met).
//   2. Already-Weak fresh-Inbox rows in the TSV. These are rows the SKILL
//      previously judged Weak (decision=skip → status stays Inbox,
//      fit_score="Weak" persisted). `filterAlreadyEvaluated({mode:"weak-fallback"})`
//      lets them through; the SKILL reads the entry's `wasAlreadyWeak` flag
//      and reuses the saved verdict instead of re-judging.
//
// Re-validation (same as topup): drop committed / no-longer-fresh keys,
// re-apply `applyPrepareFilter` (rules may have tightened, cap pre-accounts
// for prevBatch entries already going to Notion). Fill-up loop URL-checks
// until `--need K` alive (or pool exhausted).
//
// Output: appends new entries to `context.batch[]` with `wasAlreadyWeak:true`
// where applicable; carries `priorFitScore` + `priorFitRationale` from TSV
// so the SKILL doesn't re-fetch them. Sets `context.mode = "weak-fallback"`
// and stamps `stats.weakFallbackRuns`.
async function runPreWeakFallback(ctx, deps) {
  const { profileId, flags, stdout, stderr } = ctx;
  const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);

  const profile = deps.loadProfile(profileId, { profilesDir });
  const filterRules = { ...(profile.filterRules || {}), geo: profile.geo };
  const contextPath = path.join(profile.paths.root, "prepare_context.json");

  // 1) Load existing context.
  let prev;
  try {
    prev = JSON.parse(deps.readFile(contextPath));
  } catch (err) {
    stderr(`error: cannot read prepare_context.json at ${contextPath}: ${err.message}`);
    stderr(`hint: run --mode fresh first (default mode) to create the context file`);
    return 1;
  }
  if (!Array.isArray(prev.batch)) {
    stderr(`error: prepare_context.json missing 'batch' array`);
    return 1;
  }
  const prevQueue = Array.isArray(prev.deferredQueue) ? prev.deferredQueue : [];
  const prevSkipped = Array.isArray(prev.skipped) ? prev.skipped : [];
  const prevBatch = prev.batch;
  const prevStats = prev.stats || {};
  const prevUnknownTiers = Array.isArray(prev.unknownTierCompanies)
    ? prev.unknownTierCompanies
    : [];
  const batchSize = Number.isFinite(prev.batchSize) ? prev.batchSize : DEFAULT_BATCH_SIZE;

  // 2) Compute need.
  const explicitNeed = Number.isFinite(flags.need) && flags.need > 0 ? flags.need : null;
  const need = explicitNeed != null ? explicitNeed : Math.max(0, batchSize - prevBatch.length);
  if (need === 0) {
    stdout(
      `weak-fallback: nothing to add (current batch ${prevBatch.length} already at batchSize ${batchSize})`
    );
    return 0;
  }

  // 3) Build the source pool.
  const applicationsPath = profile.paths.applicationsTsv;
  const { apps } = deps.loadApplications(applicationsPath);
  const byKey = Object.fromEntries(apps.map((a) => [a.key, a]));
  const inBatchKeys = new Set(prevBatch.map((e) => e.key));

  // 3a) deferredQueue → live apps (drop committed / no-longer-fresh).
  const seen = new Set();
  const droppedFromQueue = [];
  const liveQueueApps = [];
  for (const key of prevQueue) {
    if (inBatchKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    const app = byKey[key];
    if (!app) {
      droppedFromQueue.push({ key, reason: "not_in_tsv" });
      continue;
    }
    if (!isFreshInboxApp(app)) {
      droppedFromQueue.push({ key, reason: "no_longer_fresh", url: app.url });
      continue;
    }
    liveQueueApps.push(app);
  }

  // 3b) Already-Weak fresh-inbox apps not yet in batch.
  const alreadyWeakApps = [];
  for (const app of apps) {
    if (!isFreshInboxApp(app)) continue;
    if (inBatchKeys.has(app.key) || seen.has(app.key)) continue;
    if (app.fit_score !== "Weak" && app.skip_reason !== "weak_fit") continue;
    seen.add(app.key);
    alreadyWeakApps.push(app);
  }

  const pool = [...liveQueueApps, ...alreadyWeakApps];
  stdout(
    `weak-fallback: pool ${pool.length} (${liveQueueApps.length} from deferredQueue, ` +
      `${alreadyWeakApps.length} already-Weak in TSV); need ${need}`
  );

  if (pool.length === 0) {
    stdout(`weak-fallback: pool empty — nothing more to pull`);
    // Still write inboxExhausted so SKILL loop sees the signal.
    const noopMerged = {
      ...prev,
      mode: "weak-fallback",
      generatedAt: deps.now(),
      stats: {
        ...prevStats,
        weakFallbackRuns: (prevStats.weakFallbackRuns || 0) + 1,
        inboxExhausted: computeInboxExhausted(apps, inBatchKeys),
      },
    };
    if (!flags.dryRun) {
      deps.writeFile(contextPath, JSON.stringify(noopMerged, null, 2));
    }
    return 0;
  }

  // 4) filterAlreadyEvaluated — keep weak rows, only drop duplicates.
  const { passed: notDuplicate, skipped: duplicateSkips } = filterAlreadyEvaluated(pool, {
    mode: "weak-fallback",
  });
  if (duplicateSkips.length > 0) {
    stdout(`weak-fallback: ${duplicateSkips.length} duplicate-flagged dropped`);
  }

  // 5) applyPrepareFilter (rules + cap pre-account from prevBatch).
  const activeCounts = buildActiveCounts(apps);
  for (const e of prevBatch) {
    const co = e.companyName;
    if (co) activeCounts[co] = (activeCounts[co] || 0) + 1;
  }
  const { passed, skipped: filteredOut } = applyPrepareFilter(
    notDuplicate,
    filterRules,
    activeCounts
  );
  stdout(`weak-fallback: after filter ${passed.length} passed, ${filteredOut.length} skipped`);

  // 6) Fill-up.
  stdout(`weak-fallback: checking URLs (target: ${need} alive)…`);
  const { aliveResults, allUrlResults, consumed } = await fillUpAliveBatch(passed, need, deps);
  const dead = allUrlResults.filter((r) => !r.alive);
  stdout(
    `weak-fallback: URLs checked ${allUrlResults.length}, ${aliveResults.length} alive ` +
      `(target ${need}), ${dead.length} dead, ${passed.length - consumed} still queued`
  );

  // 7) JD fetch + entry construction.
  const companyTiers = profile.company_tiers || {};
  const salaryOpts = profile.salaryConfig || {};
  const jdCacheDir = profile.paths.jdCacheDir;
  const jdByAppKey = await fetchJdsByKey(aliveResults, jdCacheDir, deps);

  // Lookup table for "was this row already Weak?" — needed because aliveResults
  // come from the URL-check path which only carries app fields applyPrepareFilter
  // forwarded; we re-key against the original TSV row to read fit_score / fit_rationale.
  const poolByKey = Object.fromEntries(pool.map((a) => [a.key, a]));
  const unknownTierSet = new Set(prevUnknownTiers);
  const newEntries = aliveResults.map((urlRes) => {
    const tsvRow = poolByKey[urlRes.key] || {};
    const wasAlreadyWeak = tsvRow.fit_score === "Weak" || tsvRow.skip_reason === "weak_fit";
    return buildBatchEntry(
      urlRes,
      jdByAppKey[urlRes.key],
      profile,
      deps,
      companyTiers,
      salaryOpts,
      unknownTierSet,
      {
        wasAlreadyWeak,
        priorFitScore: wasAlreadyWeak ? tsvRow.fit_score || "Weak" : "",
        priorFitRationale: wasAlreadyWeak ? tsvRow.fit_rationale || "" : "",
      }
    );
  });

  // 8) Skip records.
  const deadSkipped = dead.map((r) => ({
    key: r.key,
    reason: "url_dead",
    url: r.url,
    urlStatus: r.status,
  }));
  const newSkipped = [...duplicateSkips, ...filteredOut, ...deadSkipped, ...droppedFromQueue];

  // 9) Rebuild deferred queue. Anything that passed but didn't fit `need`,
  // plus the previously-queued items we couldn't push through (already-Weak
  // residue and queue residue). Excluding URL-checked keys.
  const checkedKeys = new Set(allUrlResults.map((r) => r.key));
  const stillQueuedKeys = [];
  for (const a of passed.slice(consumed)) {
    if (!checkedKeys.has(a.key)) stillQueuedKeys.push(a.key);
  }

  // 10) Merge.
  const mergedBatch = [...prevBatch, ...newEntries];
  const mergedBatchKeys = new Set(mergedBatch.map((e) => e.key));
  const inboxExhausted = computeInboxExhausted(apps, mergedBatchKeys);
  const mergedSkipReasons = computeSkipReasons([...prevSkipped, ...newSkipped]);
  // RFC 024 (BL-28): weak-fallback rewrites prepare_context.json too, so it
  // also stamps `inbox_health` — SKILL reads the field uniformly regardless of
  // which prepare mode produced the final context.
  //
  // Important (P1 from code review): in weak-fallback `stillQueuedKeys` may
  // include already-Weak rows that were pulled into the pool here. The next
  // `runPre` (mode fresh) drops those via `filterAlreadyEvaluated`, so they
  // do NOT represent capacity for the next prepare. Exclude them from
  // `remaining_viable` to keep semantics consistent with the fresh-writer
  // and avoid false-healthy reports.
  const viableStillQueued = stillQueuedKeys.filter((k) => {
    const a = poolByKey[k];
    return a && a.fit_score !== "Weak" && a.skip_reason !== "weak_fit";
  });
  const merged_inbox_health = computeInboxHealth({
    remainingViable: viableStillQueued.length,
    target: batchSize,
    inBatch: mergedBatch.length,
    dropsThisRun: mergedSkipReasons,
  });

  const merged = {
    ...prev,
    mode: "weak-fallback",
    generatedAt: deps.now(),
    batch: mergedBatch,
    skipped: [...prevSkipped, ...newSkipped],
    deferredQueue: stillQueuedKeys,
    unknownTierCompanies: [...unknownTierSet].sort(),
    stats: {
      ...prevStats,
      inBatch: mergedBatch.length,
      urlChecked: (prevStats.urlChecked || 0) + allUrlResults.length,
      urlAlive: (prevStats.urlAlive || 0) + aliveResults.length,
      urlDead: (prevStats.urlDead || 0) + dead.length,
      deferred: stillQueuedKeys.length,
      unknownTierCompanies: unknownTierSet.size,
      weakFallbackRuns: (prevStats.weakFallbackRuns || 0) + 1,
      inboxExhausted,
      skipReasons: mergedSkipReasons,
    },
    inbox_health: merged_inbox_health,
  };

  if (flags.dryRun) {
    stdout(
      `(dry-run) would append ${newEntries.length} weak-fallback entries → batch=${merged.batch.length}`
    );
    stdout(`(dry-run) stats: ${JSON.stringify(merged.stats)}`);
    return 0;
  }

  deps.writeFile(contextPath, JSON.stringify(merged, null, 2));
  const weakCount = newEntries.filter((e) => e.wasAlreadyWeak).length;
  stdout(
    `weak-fallback: appended ${newEntries.length} entries (${weakCount} already-Weak, ` +
      `${newEntries.length - weakCount} fresh) → batch=${merged.batch.length} (${contextPath})`
  );
  stdout(
    `inbox health: ${merged_inbox_health.status} (${merged_inbox_health.remaining_viable} viable for next run, target ${merged_inbox_health.target})`
  );
  if (inboxExhausted) {
    stdout(`inbox-exhausted: no more fresh rows in TSV — SKILL loop should stop`);
  }
  return 0;
}

// --- Notion-push helpers (RFC 022) -------------------------------------------

// Loads `profiles/<id>/prepare_context.json` and returns an entry-by-key map
// so the commit phase can resolve per-job extras (city/state/workFormat/
// schedule/requirements) without re-parsing JDs. Returns an empty map when
// the file is missing or unreadable — caller falls back to base TSV fields
// and prints a warning. We don't fail hard: multi-day workflows commonly
// run commit on a stale results.json, and "page missing schedule" is
// better than "page never created".
async function loadPrepareContextByKey(profile, deps, stderr) {
  const contextPath = path.join(profile.paths.root, "prepare_context.json");
  let raw;
  try {
    raw = deps.readFile(contextPath);
  } catch (err) {
    stderr(
      `warn: prepare_context.json unreadable (${err.code || err.message}) — ` +
        `Notion pages will omit city/state/workFormat/schedule/requirements`
    );
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    stderr(`warn: prepare_context.json malformed: ${err.message}`);
    return {};
  }
  const batch = Array.isArray(parsed && parsed.batch) ? parsed.batch : [];
  const byKey = {};
  for (const entry of batch) {
    if (entry && entry.key) byKey[entry.key] = entry;
  }
  return byKey;
}

// Assembles the flat field payload for one Notion job page. Pure: takes app
// (TSV row), r (results.json entry), prepareCtxEntry (from prepare_context),
// now (ISO timestamp), and a formatSalaryDisplay function; returns the
// object buildProperties consumes via the property map.
//
// Field origins (RFC 022 §4):
//   - companyName: app.companyName  (resolver hydrates into companyRelation)
//   - title / url / source / jobId / key: TSV
//   - status: constant "To Apply"
//   - fitScore / notes / resumeVersion / salaryMin / salaryMax: results.json
//   - coverLetter: derived from r.clKey
//   - dateAdded: now (YYYY-MM-DD)
//   - city / state / workFormat: results.json (SKILL extracts), fallback to
//     prepareCtxEntry, fallback to TSV.location best-effort, else omitted
//   - schedule / requirements: prepareCtxEntry (engine extracted in pre)
//   - salaryExpectations: formatSalaryDisplay(min, max)
function buildJobFieldsForNotion({ app, r, prepareCtxEntry, now, formatSalaryDisplay }) {
  const ctx = prepareCtxEntry || {};
  const fields = {
    key: app.key,
    title: app.title,
    companyName: app.companyName,
    source: app.source,
    jobId: app.jobId,
    url: app.url,
    status: "To Apply",
    dateAdded: String(now).slice(0, 10),
  };
  if (r.fitScore) fields.fitScore = r.fitScore;
  if (r.fitRationale) fields.notes = r.fitRationale;
  if (r.resumeVer) fields.resumeVersion = r.resumeVer;
  if (r.salaryMin !== undefined && r.salaryMin !== null && r.salaryMin !== "") {
    fields.salaryMin = r.salaryMin;
  }
  if (r.salaryMax !== undefined && r.salaryMax !== null && r.salaryMax !== "") {
    fields.salaryMax = r.salaryMax;
  }
  const display = formatSalaryDisplay ? formatSalaryDisplay(r.salaryMin, r.salaryMax) : "";
  if (display) fields.salaryExpectations = display;
  if (r.clKey) fields.coverLetter = `${r.clKey}.pdf`;

  // city / state / workFormat — SKILL is authoritative (it sees the JD), so
  // prefer results.json. prepare_context.json doesn't pre-extract these
  // (only schedule/requirements), so the second fallback is just for
  // future-proofing if extractFromJd grows those fields.
  if (r.city) fields.city = r.city;
  else if (ctx.city) fields.city = ctx.city;
  if (r.state) fields.state = r.state;
  else if (ctx.state) fields.state = ctx.state;
  if (r.workFormat) fields.workFormat = r.workFormat;
  else if (ctx.workFormat) fields.workFormat = ctx.workFormat;

  // schedule / requirements — engine extracted these in pre-phase, lives on
  // prepare_context entry. SKILL may also send them; SKILL wins if both.
  if (r.schedule) fields.schedule = r.schedule;
  else if (ctx.schedule) fields.schedule = ctx.schedule;
  if (r.requirements) fields.requirements = r.requirements;
  else if (ctx.requirements) fields.requirements = ctx.requirements;

  return fields;
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
    const existing = profile.company_tiers || {};
    for (const [name, tier] of Object.entries(parsedTiers)) {
      const t = String(tier || "").toUpperCase();
      if (!name || !VALID_TIERS.has(t)) {
        tierStats.invalid++;
        stderr(`warn: invalid tier "${tier}" for company "${name}" — must be one of S/A/B/C`);
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
        `tiers: persisted ${tierStats.added} new tier(s) → profile.json (${Object.entries(
          tierUpdates
        )
          .map(([n, t]) => `${n}=${t}`)
          .join(", ")})`
      );
    } catch (err) {
      stderr(`warn: failed to persist company_tiers: ${err.message}`);
    }
  } else if (tierStats.added > 0 && flags.dryRun) {
    stdout(
      `(dry-run) would persist ${tierStats.added} new tier(s): ${Object.entries(tierUpdates)
        .map(([n, t]) => `${n}=${t}`)
        .join(", ")}`
    );
  }

  // Canonical archetype gate (G-18 backstop): block to_apply rows whose
  // resumeVer isn't a real key in resume_versions.json. Without this, a typo
  // from the SKILL would silently land in TSV → propagate to Notion's select
  // dropdown when the SKILL creates the page and pollute the canonical set.
  // Empty profile set → no gate (early profiles before resume_versions.json
  // exists).
  const validArchetypes = new Set(
    Object.keys((profile.resumeVersions && profile.resumeVersions.versions) || {})
  );

  const VALID_DECISIONS = new Set(["to_apply", "archive", "skip"]);
  // BL-9 (TSV v4): persist Claude's fit verdict on every result so future
  // prepare runs can short-circuit already-evaluated rows. Validators reject
  // typos rather than silently corrupting the column; the rest of the row
  // still gets the decision-specific updates below.
  const VALID_FIT_SCORES = new Set(["Strong", "Medium", "Weak"]);
  const VALID_SKIP_REASONS = new Set(["weak_fit", "duplicate"]);

  // BL-9: applies fit_score / fit_rationale / fit_evaluated_at / skip_reason
  // from a SKILL result onto a TSV row. Mutates `app` in place. Stamps
  // fit_evaluated_at = now whenever a fit_score is written, so the engine has
  // a definitive "this row was judged on date X" signal independent of
  // updatedAt (which moves for any reason).
  function applyFitFields(app, r) {
    if (r.fitScore !== undefined && r.fitScore !== "" && r.fitScore !== null) {
      if (VALID_FIT_SCORES.has(r.fitScore)) {
        app.fit_score = r.fitScore;
        app.fit_evaluated_at = now;
      } else {
        stderr(
          `warn: invalid fitScore "${r.fitScore}" for key ${r.key} — must be one of ` +
            `${[...VALID_FIT_SCORES].join("/")}; not persisted`
        );
        updates.invalidFitScore++;
      }
    }
    if (r.fitRationale !== undefined && r.fitRationale !== null) {
      app.fit_rationale = String(r.fitRationale);
    }
    if (r.skipReason !== undefined && r.skipReason !== "" && r.skipReason !== null) {
      if (VALID_SKIP_REASONS.has(r.skipReason)) {
        app.skip_reason = r.skipReason;
      } else {
        stderr(
          `warn: invalid skipReason "${r.skipReason}" for key ${r.key} — must be one of ` +
            `${[...VALID_SKIP_REASONS].join("/")}; not persisted`
        );
        updates.invalidSkipReason++;
      }
    }
  }

  const updates = {
    toApply: 0,
    archive: 0,
    skip: 0,
    notFound: 0,
    invalidDecision: 0,
    invalidArchetype: 0,
    invalidFitScore: 0,
    invalidSkipReason: 0,
    fitWritten: 0,
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

    // BL-9: write fit verdict regardless of decision (to_apply / skip /
    // archive). Only invalid-archetype to_apply rows are downgraded to skip
    // BEFORE this point; for them we still want the verdict captured so the
    // user doesn't see the row re-evaluated next run.
    const fitBeforeWrite = app.fit_score;

    if (r.decision === "to_apply") {
      if (r.resumeVer && validArchetypes.size > 0 && !validArchetypes.has(r.resumeVer)) {
        updates.invalidArchetype++;
        stderr(
          `warn: unknown resumeVer "${r.resumeVer}" for key ${r.key} — treating as skip ` +
            `(valid keys: ${[...validArchetypes].join(", ")})`
        );
        // Capture the verdict even on the downgraded path.
        applyFitFields(app, r);
        if (app.fit_score && app.fit_score !== fitBeforeWrite) updates.fitWritten++;
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
      applyFitFields(app, r);
      if (app.fit_score && app.fit_score !== fitBeforeWrite) updates.fitWritten++;
      updates.toApply++;
    } else if (r.decision === "archive") {
      app.status = "Archived";
      app.updatedAt = now;
      applyFitFields(app, r);
      if (app.fit_score && app.fit_score !== fitBeforeWrite) updates.fitWritten++;
      updates.archive++;
    } else {
      // "skip" — no status change, but persist the verdict so the row gets
      // filtered out on next prepare run (filterAlreadyEvaluated, Step 2).
      applyFitFields(app, r);
      if (app.fit_score && app.fit_score !== fitBeforeWrite) updates.fitWritten++;
      updates.skip++;
    }
  }

  // BL-14 / RFC 019 — engine-owned CL file writes.
  //
  // For every `to_apply` result that includes `clParagraphs: string[]`, write
  // the cover letter into both layouts:
  //   - MD:  profiles/<id>/cover_letters_md/<CompanySlug>/<clKey>.md
  //   - PDF: profiles/<id>/cover_letters/<CompanySlug>/<clKey>.pdf
  // and override `app.cl_path` with the canonical relative PDF path. The
  // SKILL no longer writes the .md file itself (Step 8e change). PDF writes
  // are idempotent: if the file already exists we keep it (manual edits, or
  // re-runs against unchanged content). MD is overwritten — fresh prepare
  // run = fresh content. Failures are warned and skipped per row, never abort
  // the whole commit; TSV save still runs so the rest of the batch lands.
  const clResults = results.filter(
    (r) =>
      r.decision === "to_apply" &&
      Array.isArray(r.clParagraphs) &&
      r.clParagraphs.length > 0 &&
      byKey[r.key] // already warned above for missing keys
  );
  const clStats = {
    mdWritten: 0,
    pdfWritten: 0,
    pdfSkipped: 0,
    skipped: 0,
    failed: 0,
  };
  // RFC 022: rows whose PDF is guaranteed on-disk after this pass. The
  // Notion-push pass uses this set (not fileExists()) to decide whether
  // it's safe to write the PDF filename into Notion's "Cover Letter" field.
  // Includes successful new writes AND existing-PDF "skipped" rows.
  const pdfReadyKeys = new Set();
  if (clResults.length > 0) {
    const profileRoot = profile.paths.root;
    for (const r of clResults) {
      const app = byKey[r.key];
      if (!r.clKey) {
        stderr(
          `warn: clParagraphs present but clKey missing for key ${r.key} — skipping CL file write`
        );
        clStats.skipped++;
        continue;
      }
      const slug = deps.slugifyCompany(app.companyName);
      const mdRel = `cover_letters_md/${slug}/${r.clKey}.md`;
      const pdfRel = `cover_letters/${slug}/${r.clKey}.pdf`;
      const mdAbs = path.join(profileRoot, mdRel);
      const pdfAbs = path.join(profileRoot, pdfRel);

      if (flags.dryRun) {
        stdout(`(dry-run) would write ${mdRel} + ${pdfRel}`);
        app.cl_path = pdfRel;
        pdfReadyKeys.add(r.key);
        continue;
      }

      // MD: overwrite with fresh paragraphs (engine writes deterministic
      // content; previous run's MD is stale by definition).
      try {
        deps.writeFile(mdAbs, r.clParagraphs.join("\n\n") + "\n");
        clStats.mdWritten++;
      } catch (err) {
        stderr(`warn: failed to write MD for ${r.key} (${mdRel}): ${err.message}`);
        clStats.failed++;
        continue;
      }

      // PDF: idempotent. Existing PDF wins so manual edits / hand-tuned
      // versions survive a re-run.
      if (deps.fileExists(pdfAbs)) {
        clStats.pdfSkipped++;
        pdfReadyKeys.add(r.key);
      } else {
        try {
          deps.mkdirp(path.dirname(pdfAbs));
          await deps.generateCoverLetterPdf({ paragraphs: r.clParagraphs }, pdfAbs);
          clStats.pdfWritten++;
          pdfReadyKeys.add(r.key);
        } catch (err) {
          stderr(`warn: failed to write PDF for ${r.key} (${pdfRel}): ${err.message}`);
          clStats.failed++;
          continue;
        }
      }

      // Canonical relative PDF path — overrides any `r.clPath` from older
      // SKILL versions (they may still send the legacy filename).
      app.cl_path = pdfRel;
    }

    const clMsg =
      `cover letters: ${clStats.mdWritten} MD written, ` +
      `${clStats.pdfWritten} PDF written, ${clStats.pdfSkipped} PDF skipped` +
      (clStats.skipped > 0 ? `, ${clStats.skipped} skipped` : "") +
      (clStats.failed > 0 ? `, ${clStats.failed} failed` : "");
    stdout(clMsg);
  } else {
    // Engine warns when SKILL forgot the new field on a to_apply row, so a
    // silent regression to "no PDF written" gets caught immediately.
    const toApplyMissingParagraphs = results.filter(
      (r) =>
        r.decision === "to_apply" &&
        byKey[r.key] &&
        (!Array.isArray(r.clParagraphs) || r.clParagraphs.length === 0)
    );
    if (toApplyMissingParagraphs.length > 0) {
      stderr(
        `warn: ${toApplyMissingParagraphs.length} to_apply row(s) missing clParagraphs — ` +
          `engine cannot generate MD/PDF (likely an old SKILL version; see RFC 019)`
      );
    }
  }

  // RFC 022 — atomic per-row Notion push.
  //
  // Runs AFTER PDF/MD writes (so the Cover Letter field always points at an
  // existing file) and BEFORE saveApplications (so a Notion failure can
  // revert the row's in-memory state and the TSV never records a "To Apply"
  // without a matching Notion page).
  //
  // Behaviour:
  //   - Skip rows where notion_page_id is already set (legacy SKILL passed
  //     it, or a prior failed run left it). Idempotent.
  //   - Dedup-by-`key` query inside pushJobPage closes the "engine crashed
  //     after Notion-create, before saveApplications" window.
  //   - Per-row failure (PDF missing, Notion 5xx, resolver throw) reverts
  //     in-memory app: status → "Inbox", clear cl_key / resume_ver / cl_path,
  //     drop notion_page_id. Other rows in the batch continue (option A,
  //     RFC 022). Next prepare run picks up the row again.
  //   - Missing NOTION_TOKEN logs once + reverts all to_apply rows (they
  //     stay Inbox; user fixes env and re-runs).
  //   - --dry-run: prints would-push count, no API calls, no reverts.
  const notionStats = {
    pushed: 0,
    dedupHit: 0,
    skippedExistingId: 0,
    pdfMissing: 0,
    notionFailed: 0,
    dryRunWouldPush: 0,
  };

  const toApplyResults = results.filter(
    (r) => r.decision === "to_apply" && byKey[r.key] && byKey[r.key].status === "To Apply"
  );

  function revertToInbox(app, reason) {
    app.status = "Inbox";
    app.cl_key = "";
    app.resume_ver = "";
    app.cl_path = "";
    app.notion_page_id = "";
    // updatedAt stays — the row was touched this run even if reverted, so
    // future runs see fresh activity. fit_score / fit_rationale persist
    // (verdict still valid; only the action couldn't complete).
    updates.toApply--;
    if (reason === "pdf_missing") notionStats.pdfMissing++;
    else if (reason === "notion_failed") notionStats.notionFailed++;
  }

  // Partition: rows that need a Notion create vs rows that already carry a
  // page id (legacy SKILL passed `notionPageId` or prior failed run). The
  // "needs push" partition is what gates whether we even load secrets /
  // construct a client. If everything's already pushed, do nothing.
  //
  // Dedup by key: a malformed results.json with two entries for the same
  // key would otherwise let the second iteration revert the first's page id
  // (data loss). Real SKILL never emits duplicate keys, but the defense is
  // cheap and reviewer P2.2 flagged it.
  const _seenKeys = new Set();
  const toApplyNeedingPush = toApplyResults.filter((r) => {
    if (byKey[r.key].notion_page_id) return false;
    if (_seenKeys.has(r.key)) return false;
    _seenKeys.add(r.key);
    return true;
  });
  const toApplyAlreadyPushed = toApplyResults.filter((r) => byKey[r.key].notion_page_id).length;
  if (toApplyAlreadyPushed > 0) {
    notionStats.skippedExistingId = toApplyAlreadyPushed;
  }

  if (toApplyNeedingPush.length > 0) {
    if (flags.dryRun) {
      notionStats.dryRunWouldPush = toApplyNeedingPush.length;
      stdout(
        `(dry-run) would create ${toApplyNeedingPush.length} Notion page(s)` +
          (toApplyAlreadyPushed > 0
            ? ` (skipping ${toApplyAlreadyPushed} with existing notion_page_id)`
            : "")
      );
    } else {
      const secrets =
        (deps.loadSecrets && deps.loadSecrets(profileId, ctx.env || process.env)) || {};
      const token = secrets.NOTION_TOKEN || null;
      const jobsDbId = profile.notion && profile.notion.jobs_pipeline_db_id;
      const companiesDbId = profile.notion && profile.notion.companies_db_id;
      const propertyMap =
        (profile.notion && profile.notion.property_map) || notionSync.DEFAULT_PROPERTY_MAP;

      if (!token) {
        stderr(
          `warn: ${profileId.toUpperCase()}_NOTION_TOKEN missing — Notion push skipped; ` +
            `${toApplyNeedingPush.length} row(s) reverted to Inbox. Fix .env and re-run prepare.`
        );
        for (const r of toApplyNeedingPush) revertToInbox(byKey[r.key], "notion_failed");
      } else if (!jobsDbId) {
        stderr(
          `warn: profile.notion.jobs_pipeline_db_id missing — Notion push skipped; ` +
            `${toApplyNeedingPush.length} row(s) reverted to Inbox.`
        );
        for (const r of toApplyNeedingPush) revertToInbox(byKey[r.key], "notion_failed");
      } else if (!companiesDbId) {
        stderr(
          `warn: profile.notion.companies_db_id missing — Notion push skipped; ` +
            `${toApplyNeedingPush.length} row(s) reverted to Inbox.`
        );
        for (const r of toApplyNeedingPush) revertToInbox(byKey[r.key], "notion_failed");
      } else {
        // Load prepare_context.json for city/state/workFormat/schedule/requirements.
        // It lives next to the TSV; missing or out-of-sync → degrade gracefully
        // (push base fields only, log warning).
        const ctxByKey = await loadPrepareContextByKey(profile, deps, stderr);

        // Build client + resolvers ONCE per commit run.
        const client = deps.makeNotionClient(token);
        let jobsDataSourceId;
        let companiesDataSourceId;
        try {
          [jobsDataSourceId, companiesDataSourceId] = await Promise.all([
            deps.resolveDataSourceId(client, jobsDbId),
            deps.resolveDataSourceId(client, companiesDbId),
          ]);
        } catch (err) {
          stderr(
            `warn: cannot resolve Notion data_source_ids: ${err.message}; ` +
              `${toApplyNeedingPush.length} row(s) reverted to Inbox.`
          );
          for (const r of toApplyNeedingPush) revertToInbox(byKey[r.key], "notion_failed");
          jobsDataSourceId = null;
        }

        if (jobsDataSourceId && companiesDataSourceId) {
          const mergedTiers = {
            ...(profile.company_tiers || {}),
            ...tierUpdates,
          };
          const resolver = deps.makeCompanyResolver({
            client,
            companiesDbId,
            companiesDataSourceId,
            companyTiers: mergedTiers,
            log: (msg) => stdout(msg),
          });

          for (const r of toApplyNeedingPush) {
            const app = byKey[r.key];
            // PDF guard: Cover Letter field MUST point to a file that exists.
            // The CL-write pass populated pdfReadyKeys with row keys whose PDF
            // is on disk after this run (either freshly written or pre-existing).
            // If clKey is set but the row isn't in the ready set, the CL write
            // failed — refuse to push (Notion would show a dangling filename).
            if (r.clKey && !pdfReadyKeys.has(r.key)) {
              const slug = deps.slugifyCompany(app.companyName);
              const pdfRel = `cover_letters/${slug}/${r.clKey}.pdf`;
              stderr(
                `warn: PDF not written for ${r.key} (${pdfRel}) — Notion push skipped, row reverted to Inbox`
              );
              revertToInbox(app, "pdf_missing");
              continue;
            }

            const jobFields = buildJobFieldsForNotion({
              app,
              r,
              prepareCtxEntry: ctxByKey[r.key] || null,
              now,
              formatSalaryDisplay: deps.formatSalaryDisplay,
            });

            try {
              const { pageId, dedup } = await deps.pushJobPage({
                client,
                jobsDbId,
                jobsDataSourceId,
                propertyMap,
                companyResolver: resolver,
                jobFields,
              });
              app.notion_page_id = pageId;
              if (dedup) notionStats.dedupHit++;
              else notionStats.pushed++;
            } catch (err) {
              stderr(
                `warn: Notion push failed for ${r.key} (${app.companyName} / ${app.title}): ${err.message} — row reverted to Inbox`
              );
              revertToInbox(app, "notion_failed");
            }
          }
        }
      }
    }

    const notionParts = [];
    if (notionStats.pushed > 0) notionParts.push(`${notionStats.pushed} created`);
    if (notionStats.dedupHit > 0) notionParts.push(`${notionStats.dedupHit} dedup-hit`);
    if (notionStats.skippedExistingId > 0)
      notionParts.push(`${notionStats.skippedExistingId} already had page id`);
    if (notionStats.pdfMissing > 0) notionParts.push(`${notionStats.pdfMissing} PDF missing`);
    if (notionStats.notionFailed > 0) notionParts.push(`${notionStats.notionFailed} Notion failed`);
    if (notionStats.dryRunWouldPush > 0) notionParts.push(`${notionStats.dryRunWouldPush} dry-run`);
    if (notionParts.length > 0) {
      stdout(`notion: ${notionParts.join(", ")}`);
    }
  }

  const extras = [];
  if (updates.invalidDecision > 0) extras.push(`${updates.invalidDecision} invalid decision`);
  if (updates.invalidArchetype > 0) extras.push(`${updates.invalidArchetype} invalid archetype`);
  if (updates.invalidFitScore > 0) extras.push(`${updates.invalidFitScore} invalid fit_score`);
  if (updates.invalidSkipReason > 0)
    extras.push(`${updates.invalidSkipReason} invalid skip_reason`);
  if (tierStats.invalid > 0) extras.push(`${tierStats.invalid} invalid tier`);
  if (notionStats.pdfMissing + notionStats.notionFailed > 0) {
    extras.push(
      `${notionStats.pdfMissing + notionStats.notionFailed} reverted to Inbox (Notion/PDF failure)`
    );
  }
  const extraStr = extras.length > 0 ? `, ${extras.join(", ")}` : "";

  stdout(
    `commit: ${updates.toApply} → To Apply, ${updates.archive} archived, ` +
      `${updates.skip} skipped, ${updates.notFound} not found${extraStr}`
  );
  if (updates.fitWritten > 0) {
    stdout(
      `fit verdicts: ${updates.fitWritten} new fit_score values persisted to TSV ` +
        `(future prepare runs will skip these rows)`
    );
  }

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
    const mode = (ctx.flags && ctx.flags.mode) || "fresh";

    if (phase === "pre") {
      if (mode === "topup") return runPreTopup(ctx, deps);
      if (mode === "weak-fallback") return runPreWeakFallback(ctx, deps);
      if (mode === "fresh" || mode === "") return runPre(ctx, deps);
      ctx.stderr(`error: unknown --mode "${mode}" (valid: fresh, topup, weak-fallback)`);
      return 1;
    }
    if (phase === "commit") return runCommit(ctx, deps);

    ctx.stderr(`error: --phase <pre|commit> is required for the prepare command`);
    return 1;
  };
}

module.exports = makePrepareCommand();
module.exports.makePrepareCommand = makePrepareCommand;
module.exports.applyPrepareFilter = applyPrepareFilter;
module.exports.filterAlreadyEvaluated = filterAlreadyEvaluated;
module.exports.buildActiveCounts = buildActiveCounts;
module.exports.fillUpAliveBatch = fillUpAliveBatch;
module.exports.computeInboxExhausted = computeInboxExhausted;
module.exports.computeInboxHealth = computeInboxHealth;
module.exports.isFreshInboxApp = isFreshInboxApp;
module.exports.runAutoDedup = runAutoDedup;
