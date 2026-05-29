// `retro-tailor` command — re-tailor Strong rows that landed in Notion as
// `To Apply` before the RFC-044 Strong-fit tailoring loop existed.
//
// See `rfc/047-retro-tailor.md` for the full design. Short version:
//
//   Phase recon (default, or with --dry-run):
//     1. Load TSV. Filter rows where status="To Apply" AND
//        fit_score="Strong" AND resume_ver doesn't start with
//        "resumes/tailored/".
//     2. Optional --since YYYY-MM-DD cap (filter on updatedAt/createdAt).
//     3. Optional --batch <N> cap (default 30).
//     4. Fetch the JD for each survivor (cache-aware via fetchAllJds).
//     5. Write profiles/<id>/retro_tailor_context.json with per-row JD
//        payloads — shape mirrors prepare_context.json.batch[] so the
//        SKILL can drive the same Step 6.5 tailoring loop.
//
//   Phase commit (--apply --results-file <path>):
//     1. Read SKILL-produced results.json (same 5 RFC-044 tailor fields
//        per row, plus notionPageId carried through from context).
//     2. For each tailored row: generate DOCX+PDF, update TSV
//        resume_ver, update Notion page Resume Version field via
//        notion_sync.updateJobPage. Cover letter NOT touched.
//     3. For each escalated row: append to retro-escalations MD,
//        do NOT mutate TSV or Notion.
//
// LLM orchestration lives in the SKILL session (RFC 044 §"fork #1
// revised"). Engine stays PII-free / LLM-free.

const path = require("path");
const fs = require("fs");

const profileLoader = require("../core/profile_loader.js");
const applicationsTsv = require("../core/applications_tsv.js");
const { fetchAll: fetchAllJds } = require("../core/jd_cache.js");
const { extractJDStructure } = require("../core/jd_extract.js");
const { defaultFetch } = require("../modules/discovery/_http.js");
const { resolveProfilesDir } = require("../core/paths.js");
const { slugifyCompany } = require("../core/company_slug.js");
const { slugifyRole } = require("../core/role_slug.js");
const { generateResumeDocx } = require("../modules/generators/resume_docx.js");
const { generateResumePdf } = require("../modules/generators/resume_pdf_chrome.js");
const {
  tailoredResumePath,
  tailoredResumePathPdf,
  buildEscalationRecord,
} = require("../modules/tailor/dispatcher.js");
const {
  renderEscalationReport,
  renderEscalationStdout,
} = require("../modules/tailor/escalation_report.js");
const notionSync = require("../core/notion_sync.js");

const DEFAULT_BATCH = 30;
const TAILORED_PREFIX = "resumes/tailored/";

// JD slug parser is duplicated from prepare.js intentionally: the two
// commands evolve independently, and the parser is a tiny pure function.
// If a third caller appears we can extract it; until then, two copies of
// 12 lines costs less than the indirection of a shared module.
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
  if (source === "ashby") {
    const m = u.match(/jobs\.ashbyhq\.com\/([^/?#]+)\//i);
    return m ? m[1] : "";
  }
  return "";
}

// --- Candidate identification ----------------------------------------------

/**
 * Pure: given an applications.tsv row, decide whether retro-tailor should
 * include it in this run's candidate set.
 *
 * A row qualifies iff:
 *   - status === "To Apply"        (operator has committed to apply)
 *   - fit_score === "Strong"       (we only re-tailor Strong rows per BL-133)
 *   - resume_ver does NOT start with "resumes/tailored/"
 *                                   (pre-RFC-044 archetype-pick value)
 *   - if --since given, updatedAt (or createdAt fallback) >= sinceISO
 *
 * Notion-side concerns (page must exist) are checked in the commit phase
 * via notion_page_id presence — recon trusts the TSV to be sync'd.
 *
 * @param {object} app — TSV row
 * @param {string} sinceISO — "YYYY-MM-DD" or "" for no filter
 * @returns {boolean}
 */
function isRetroTailorCandidate(app, sinceISO) {
  if (!app) return false;
  if (app.status !== "To Apply") return false;
  if (app.fit_score !== "Strong") return false;
  // Empty resume_ver also counts as "not tailored" — defensive against
  // pre-RFC-044 rows that may have empty values.
  const rv = String(app.resume_ver || "");
  if (rv.startsWith(TAILORED_PREFIX)) return false;
  if (sinceISO) {
    const ts = app.updatedAt || app.createdAt || "";
    // String compare works for ISO timestamps; sinceISO is "YYYY-MM-DD"
    // and any ISO timestamp starts with that lexical prefix.
    if (ts && ts < sinceISO) return false;
    if (!ts) return false; // no timestamp → conservative skip
  }
  return true;
}

// --- Phase: recon ----------------------------------------------------------

async function runRecon(ctx, deps) {
  const { profileId, flags, stdout, stderr } = ctx;
  const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);
  const profile = deps.loadProfile(profileId, { profilesDir });
  const applicationsPath = profile.paths.applicationsTsv;
  const { apps } = deps.loadApplications(applicationsPath);

  const batchSize = Number.isFinite(flags.batch) && flags.batch > 0 ? flags.batch : DEFAULT_BATCH;
  const sinceISO = flags.since || "";

  // Count Strong+To Apply rows for the diagnostic line, independent of the
  // tailored-prefix check — operator wants to see "X of Y Strong already
  // tailored" so they know retro-tailor is converging over time.
  const strongToApply = apps.filter((a) => a.status === "To Apply" && a.fit_score === "Strong");
  const alreadyTailored = strongToApply.filter((a) =>
    String(a.resume_ver || "").startsWith(TAILORED_PREFIX)
  );

  let candidates = strongToApply.filter((a) => isRetroTailorCandidate(a, sinceISO));

  // Cap. Operators with a backlog of 50+ rows would otherwise blow the
  // token budget in one SKILL session. --batch overrides; default 30
  // mirrors prepare's DEFAULT_BATCH_SIZE.
  const deferred = Math.max(0, candidates.length - batchSize);
  if (candidates.length > batchSize) {
    candidates = candidates.slice(0, batchSize);
  }

  stdout(
    `retro-tailor: scanned ${apps.length} rows, ${strongToApply.length} Strong in To Apply, ` +
      `${alreadyTailored.length} already tailored, ${candidates.length} candidates`
  );
  if (sinceISO) {
    stdout(`  --since ${sinceISO} applied`);
  }
  if (deferred > 0) {
    stdout(`  deferred: ${deferred} candidates beyond --batch ${batchSize}`);
  }

  if (candidates.length === 0) {
    stdout("nothing to do — every Strong+To Apply row is already tailored");
    return 0;
  }

  // JD pre-fetch. Reuses the shared cache, so a row whose JD was already
  // fetched in a recent prepare run costs zero network.
  const jdInputs = candidates.map((a) => ({
    ...a,
    slug: parseSlugFromUrl(a.source, a.url),
  }));
  const jdCacheDir = profile.paths.jdCacheDir;
  const jdResults =
    jdInputs.length > 0
      ? await deps.fetchJds(jdInputs, jdCacheDir, { fetchFn: deps.fetchFn }, { concurrency: 8 })
      : [];

  let jdOk = 0;
  let jdFailed = 0;
  const batchOut = [];
  for (let i = 0; i < candidates.length; i++) {
    const app = candidates[i];
    const jd = jdResults[i];
    const jdText = jd && jd.text ? jd.text : "";
    if (!jdText) {
      jdFailed++;
      stderr(
        `warn: JD fetch failed for ${app.key} (${app.companyName} / ${app.title}) — ` +
          `excluded from retro_tailor_context.json. Re-run after addressing the JD source.`
      );
      continue;
    }
    jdOk++;
    const entry = {
      key: app.key,
      source: app.source,
      jobId: app.jobId,
      companyName: app.companyName,
      title: app.title,
      url: app.url,
      notion_page_id: app.notion_page_id || "",
      current_resume_ver: app.resume_ver || "",
      fit_score: app.fit_score,
      fit_rationale: app.fit_rationale || "",
      jdText,
      jdStructure: extractJDStructure(jdText),
    };
    batchOut.push(entry);
  }

  stdout(`JD-fetch: ${jdOk} ok, ${jdFailed} failed`);

  const context = {
    version: 1,
    profileId,
    generatedAt: deps.now(),
    mode: "retro",
    batch: batchOut,
    stats: {
      scannedTotal: apps.length,
      strongToApply: strongToApply.length,
      alreadyTailored: alreadyTailored.length,
      candidatesTotal: candidates.length,
      jdFetchedOk: jdOk,
      jdFetchFailed: jdFailed,
      deferred,
    },
  };

  if (flags.dryRun) {
    stdout(`(dry-run) would write retro_tailor_context.json with ${batchOut.length} rows`);
    return 0;
  }

  const contextPath = path.join(profile.paths.root, "retro_tailor_context.json");
  deps.writeFile(contextPath, JSON.stringify(context, null, 2));
  stdout(`wrote retro_tailor_context.json (${batchOut.length} rows → ${contextPath})`);
  stdout(
    `next: run the SKILL retro-tailor mode to drive the loop, then commit with ` +
      `\`node engine/cli.js retro-tailor --profile ${profileId} --apply --results-file <path>\``
  );
  return 0;
}

// --- Phase: commit ---------------------------------------------------------

async function runCommit(ctx, deps) {
  const { profileId, flags, stdout, stderr } = ctx;
  const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);

  if (!flags.resultsFile) {
    stderr("error: --results-file <path> is required for --apply");
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

  const stats = {
    rowsTotal: results.length,
    tailored: 0,
    escalated: 0,
    skipped: 0,
    notionUpdated: 0,
    notionFailed: 0,
    docxFailed: 0,
    dryRun: 0,
  };
  const escalations = [];

  // Decide upfront whether we need a Notion client. We only build it once
  // (lazy: skip entirely on --dry-run or when no row needs an update). The
  // commit path will refuse to proceed on missing token / db ids when at
  // least one tailored row needs Notion.
  const tailoredRows = []; // [{ rowKey, app, r, docxRel, pdfRel }]

  // First pass: validate + classify + generate DOCX/PDF.
  // We defer all Notion calls to a second pass so we can build the client
  // once, after we know at least one row needs it.
  const dateStr = String(now).slice(0, 10);
  const dateStamp = dateStr.replace(/-/g, "");

  for (const r of results) {
    if (!r || !r.key) {
      stats.skipped++;
      stderr(`warn: results entry missing key — skipped`);
      continue;
    }
    const app = byKey[r.key];
    if (!app) {
      stats.skipped++;
      stderr(`warn: key not found in applications.tsv: ${r.key} — skipped`);
      continue;
    }
    if (app.status !== "To Apply") {
      stats.skipped++;
      stderr(
        `warn: ${r.key} status is "${app.status}" (not "To Apply") — ` +
          `skipped. Did you sync since recon?`
      );
      continue;
    }

    // Escalation branch: stash for the MD report, do not mutate TSV or
    // Notion. Mirrors RFC 044 commit semantics exactly.
    if (r.tailorEscalated === true) {
      escalations.push(buildEscalationRecord(r));
      stats.escalated++;
      continue;
    }

    // Auto-ship branch: must have a tailoredResume object.
    if (!r.tailoredResume || typeof r.tailoredResume !== "object") {
      stats.skipped++;
      stderr(`warn: ${r.key} is neither escalated nor has tailoredResume — skipped`);
      continue;
    }

    if (!app.notion_page_id) {
      // Defensive — a Strong+To Apply row without a Notion page id is a
      // schema violation. We refuse to silently create a new page (that
      // would duplicate the row in Notion).
      stats.skipped++;
      stderr(
        `warn: ${r.key} has no notion_page_id — cannot update Notion. ` +
          `Skipped. Did you sync first?`
      );
      continue;
    }

    const slug = deps.slugifyCompany(app.companyName);
    const roleSlug = deps.slugifyRole(app.title);
    const docxRel = tailoredResumePath(profileId, slug, roleSlug, dateStamp);
    const pdfRel = tailoredResumePathPdf(profileId, slug, roleSlug, dateStamp);
    const docxAbs = path.join(profile.paths.root, docxRel);
    const pdfAbs = path.join(profile.paths.root, pdfRel);

    if (flags.dryRun) {
      stdout(`(dry-run) would write tailored resume ${docxRel} + ${pdfRel}`);
      stdout(`(dry-run) would update Notion page ${app.notion_page_id} → ${pdfRel}`);
      stats.dryRun++;
      continue;
    }

    try {
      deps.mkdirp(path.dirname(docxAbs));
      await deps.generateResumeDocx(r.tailoredResume, docxAbs);
      // BL-126 Block A — PDF is the canonical resume_ver. Pass the
      // profile's layout preset (same as RFC 044 commit path).
      const pdfResult = await deps.generateResumePdf(r.tailoredResume, pdfAbs, {
        layout: (profile.resume && profile.resume.layout) || "one_page",
      });
      const pageCount =
        pdfResult && typeof pdfResult === "object" && typeof pdfResult.pageCount === "number"
          ? pdfResult.pageCount
          : null;
      if (pageCount !== null && pageCount > 1) {
        stderr(
          `warn: tailored PDF for ${slug} is ${pageCount} pages (expected 1) — ` +
            `consider compression hints: shorter summary, condense earlier roles, ` +
            `drop low-impact bullets`
        );
      }
      tailoredRows.push({
        rowKey: r.key,
        app,
        r,
        docxRel,
        pdfRel,
        previousResumeVer: app.resume_ver,
      });
    } catch (err) {
      stats.docxFailed++;
      stderr(`warn: failed to generate tailored resume for ${r.key} (${pdfRel}): ${err.message}`);
    }
  }

  // Second pass: Notion updates. We do this AFTER all DOCX/PDF writes
  // succeed so the operator can re-run safely on a partial Notion
  // failure (files on disk are idempotent; the missing Notion update is
  // surfaced via the rollback).
  if (tailoredRows.length > 0) {
    const secrets = (deps.loadSecrets && deps.loadSecrets(profileId, ctx.env || process.env)) || {};
    const token = secrets.NOTION_TOKEN || null;
    const jobsDbId = profile.notion && profile.notion.jobs_pipeline_db_id;
    const propertyMap =
      (profile.notion && profile.notion.property_map) || notionSync.DEFAULT_PROPERTY_MAP;

    if (!token) {
      stderr(
        `warn: ${profileId.toUpperCase()}_NOTION_TOKEN missing — Notion updates skipped; ` +
          `${tailoredRows.length} row(s) left in pre-commit state. Fix .env and re-run.`
      );
    } else if (!jobsDbId) {
      stderr(
        `warn: profile.notion.jobs_pipeline_db_id missing — Notion updates skipped; ` +
          `${tailoredRows.length} row(s) left in pre-commit state.`
      );
    } else {
      const client = deps.makeNotionClient(token);
      for (const entry of tailoredRows) {
        try {
          await deps.updateJobPage(
            client,
            entry.app.notion_page_id,
            { resumeVersion: entry.pdfRel },
            propertyMap
          );
          // Mutate TSV in-memory ONLY after Notion succeeds. Files on
          // disk are already written — if Notion fails, the next
          // retro-tailor recon still sees the row as needing tailoring
          // (TSV resume_ver unchanged), and the DOCX/PDF on disk are
          // simply orphans the operator can clean up.
          entry.app.resume_ver = entry.pdfRel;
          entry.app.updatedAt = now;
          stats.tailored++;
          stats.notionUpdated++;
        } catch (err) {
          stats.notionFailed++;
          stderr(
            `warn: Notion update failed for ${entry.rowKey} (${entry.app.companyName} / ` +
              `${entry.app.title}): ${err.message} — TSV resume_ver unchanged, files on disk kept`
          );
        }
      }
    }

    // Persist TSV mutations. saveApplications is a no-op if nothing
    // changed; we always call so a partial run still saves whichever
    // rows succeeded.
    if (!flags.dryRun) {
      deps.saveApplications(applicationsPath, apps);
    }
  }

  // Escalation MD report. Separate filename prefix from regular
  // prepare-commit escalations so the audit trail stays clean.
  if (escalations.length > 0) {
    const stdoutReport = renderEscalationStdout(escalations);
    if (stdoutReport) stdout(stdoutReport);

    if (!flags.dryRun) {
      try {
        const md = renderEscalationReport(escalations, { timestamp: new Date(now) });
        const stateDir = path.join(profile.paths.root, ".tailor-state");
        const reportPath = path.join(
          stateDir,
          `retro-escalations-${Math.floor(new Date(now).getTime() / 1000)}.md`
        );
        deps.mkdirp(stateDir);
        deps.writeFile(reportPath, md);
        stdout(`retro-tailor escalations: wrote ${reportPath}`);
      } catch (err) {
        stderr(`warn: failed to write retro-tailor escalation report: ${err.message}`);
      }
    } else {
      stdout(
        `(dry-run) would write retro-tailor escalation report (${escalations.length} record(s))`
      );
    }
  }

  // Summary
  const parts = [];
  if (stats.tailored > 0) parts.push(`${stats.tailored} tailored`);
  if (stats.dryRun > 0) parts.push(`${stats.dryRun} dry-run`);
  if (stats.escalated > 0) parts.push(`${stats.escalated} escalated`);
  if (stats.notionUpdated > 0) parts.push(`${stats.notionUpdated} Notion updated`);
  if (stats.notionFailed > 0) parts.push(`${stats.notionFailed} Notion failed`);
  if (stats.docxFailed > 0) parts.push(`${stats.docxFailed} DOCX/PDF failed`);
  if (stats.skipped > 0) parts.push(`${stats.skipped} skipped`);
  stdout(`retro-tailor commit: ${parts.join(", ") || "no changes"}`);
  return 0;
}

// --- Deps & defaults --------------------------------------------------------

function makeDefaultDeps() {
  return {
    loadProfile: profileLoader.loadProfile,
    loadSecrets: profileLoader.loadSecrets,
    loadApplications: applicationsTsv.load,
    saveApplications: applicationsTsv.save,
    fetchJds: fetchAllJds,
    fetchFn: defaultFetch,
    readFile: (p) => fs.readFileSync(p, "utf8"),
    writeFile: (p, data) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, p);
    },
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
    slugifyCompany,
    slugifyRole,
    generateResumeDocx,
    generateResumePdf,
    makeNotionClient: notionSync.makeClient,
    updateJobPage: notionSync.updateJobPage,
    now: () => new Date().toISOString(),
  };
}

// --- Command factory --------------------------------------------------------

function makeRetroTailorCommand(deps = {}) {
  const merged = { ...makeDefaultDeps(), ...deps };
  return async function retroTailor(ctx) {
    const { flags } = ctx;
    if (flags.apply) {
      return runCommit(ctx, merged);
    }
    return runRecon(ctx, merged);
  };
}

// Default export is the bound command so cli.js can plug it into
// defaultCommands without extra wiring.
const command = makeRetroTailorCommand();
command.makeRetroTailorCommand = makeRetroTailorCommand;
command.isRetroTailorCandidate = isRetroTailorCandidate;
command.TAILORED_PREFIX = TAILORED_PREFIX;

module.exports = command;
