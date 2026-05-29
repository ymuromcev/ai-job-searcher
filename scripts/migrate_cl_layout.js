#!/usr/bin/env node
//
// scripts/migrate_cl_layout.js — BL-14 / RFC 019 one-shot migration
//
// Brings legacy cover-letter layouts onto the canonical layout the engine
// uses going forward:
//
//   profiles/<id>/
//     cover_letters/<CompanySlug>/<clKey>.pdf       <- ATS-ready PDF
//     cover_letters_md/<CompanySlug>/<clKey>.md     <- editable source
//
// `<CompanySlug>` is `slugifyCompany(applications.tsv.companyName)` — same
// helper the engine uses, so a re-run after a TSV edit converges.
//
// Source layouts seen in the wild:
//   - Jared: PDFs already in cover_letters/<Company>/ (mostly), some flat,
//     MDs scattered, TSV cl_path = MD basename or "<Company>/file.md".
//   - secondary profile: PDFs flat in cover_letters/, TSV cl_path =
//     "cover_letters/CL_<name>_<role>_<location>.pdf" (already with prefix).
//
// Defaults to `--dry-run`. Pass `--apply` to mutate the filesystem and TSV.
// Always backs up the TSV first to applications.tsv.pre-cl-migrate-<ISO>.
//
// Idempotent: repeat invocations are no-ops once every row has been
// canonicalised.
//
// Usage:
//   node scripts/migrate_cl_layout.js --profile jared            # dry-run
//   node scripts/migrate_cl_layout.js --profile jared --apply    # write

const fs = require("fs");
const path = require("path");

const { loadProfile } = require("../engine/core/profile_loader.js");
const applicationsTsv = require("../engine/core/applications_tsv.js");
const { slugifyCompany } = require("../engine/core/company_slug.js");
const { generateCoverLetterPdf } = require("../engine/modules/generators/cover_letter_pdf.js");
const { resolveProfilesDir } = require("../engine/core/paths.js");

// --- Pure planner -----------------------------------------------------------

// Compute what should happen for one TSV row. Returns a Plan object the
// caller (CLI or test) can execute or pretty-print. No filesystem writes
// here — keeps planning testable in isolation.
//
// Inputs:
//   - app: TSV row (must have companyName, cl_path)
//   - profileRoot: absolute path to the profile dir
//   - fileExists(absPath): boolean — pluggable for tests
//   - readMd(absPath): string — only invoked when planning a PDF backfill
//
// Output Plan:
//   {
//     skip: bool,                 // already canonical, no-op
//     reason: "...",              // why skipped (or why action chosen)
//     newClPath: "cover_letters/<slug>/<key>.pdf",
//     pdfMove?: { from, to },     // move existing PDF
//     pdfGenerate?: { to, from },  // generate PDF from MD `from`
//     mdMove?: { from, to },      // move existing MD
//     warnings: string[],         // non-fatal issues
//   }
function planRow(app, profileRoot, { fileExists, listKnownFiles = () => [] } = {}) {
  const out = { warnings: [] };
  const cl = String(app.cl_path || "").trim();
  if (cl === "") {
    out.skip = true;
    out.reason = "empty cl_path";
    return out;
  }

  // BL-152 guard: CLs already under cover_letters/tailored/ (the
  // archive-eligible layout) or cover_letters/archive/ must NOT be pulled
  // back to the flat cover_letters/<slug>/ layout this BL-14 migration
  // targets — doing so would silently re-break archive-eligibility. Leave
  // them untouched.
  const clNorm = cl.replace(/\\/g, "/");
  if (clNorm.startsWith("cover_letters/tailored/") || clNorm.startsWith("cover_letters/archive/")) {
    out.skip = true;
    out.reason = "already tailored/archived (BL-152)";
    out.newClPath = cl;
    return out;
  }

  const baseName = path.basename(cl);
  const stem = baseName.replace(/\.(md|pdf)$/i, "");
  const slug = slugifyCompany(app.companyName);

  const targetPdfRel = `cover_letters/${slug}/${stem}.pdf`;
  const targetMdRel = `cover_letters_md/${slug}/${stem}.md`;
  out.newClPath = targetPdfRel;

  const targetPdfAbs = path.join(profileRoot, targetPdfRel);
  const targetMdAbs = path.join(profileRoot, targetMdRel);

  // Probe several historical layouts. For each candidate we keep only
  // entries with the correct extension — otherwise a `.pdf` cl_path could be
  // mis-detected as an MD source (and vice-versa).
  //
  // Resolution of the cl_path itself:
  //   - absolute: take as-is
  //   - starts with `cover_letters/` or `cover_letters_md/`: relative to root
  //   - otherwise (bare basename, or `<Company>/<file>`): prepend
  //     `cover_letters/` because that's where Jared's older format lived
  const clAbs = path.isAbsolute(cl)
    ? cl
    : cl.startsWith("cover_letters/") || cl.startsWith("cover_letters_md/")
      ? path.join(profileRoot, cl)
      : path.join(profileRoot, "cover_letters", cl);

  // Stem-based probes (extension-agnostic): every reasonable spot a file
  // with this stem might live.
  const stemPdfPaths = [
    targetPdfAbs,
    path.join(profileRoot, "cover_letters", `${stem}.pdf`),
    path.join(profileRoot, "cover_letters", slug, `${stem}.pdf`),
    clAbs.replace(/\.(md|pdf)$/i, ".pdf"),
  ];
  const stemMdPaths = [
    targetMdAbs,
    path.join(profileRoot, "cover_letters_md", `${stem}.md`),
    path.join(profileRoot, "cover_letters", `${stem}.md`),
    path.join(profileRoot, "cover_letters", slug, `${stem}.md`),
    path.join(profileRoot, "cover_letters_md", slug, `${stem}.md`),
    clAbs.replace(/\.(md|pdf)$/i, ".md"),
  ];

  const dedup = (arr) => Array.from(new Set(arr));
  const pdfSrc = dedup(stemPdfPaths).find(fileExists);
  const mdSrc = dedup(stemMdPaths).find(fileExists);

  // Idempotency check: cl_path already canonical AND PDF already at target.
  // We may still need to move an MD if it's outside cover_letters_md/<slug>/.
  const clAlreadyCanonical = cl === targetPdfRel;
  const pdfAtTarget = pdfSrc === targetPdfAbs;
  const mdAtTarget = mdSrc === targetMdAbs;

  if (clAlreadyCanonical && pdfAtTarget && (!mdSrc || mdAtTarget)) {
    out.skip = true;
    out.reason = "already canonical";
    return out;
  }

  // PDF action.
  if (pdfSrc && !pdfAtTarget) {
    out.pdfMove = { from: pdfSrc, to: targetPdfAbs };
  } else if (!pdfSrc && mdSrc) {
    // No PDF anywhere — backfill from MD.
    out.pdfGenerate = { from: mdSrc, to: targetPdfAbs };
  } else if (!pdfSrc && !mdSrc) {
    // No file anywhere on disk. Could be:
    //   (a) a true orphan TSV row whose file got deleted — keep the
    //       canonical pointer so any future regen lands at the right place.
    //   (b) a sentinel like "indeed_generic" the operator uses to mark "no
    //       per-job CL" for Indeed apps — must NOT be rewritten to
    //       "cover_letters/<slug>/indeed_generic.pdf" (that would point at
    //       a file that never existed and break the operator's convention).
    // Heuristic: a real cl_path ends in `.md` or `.pdf`. Anything without
    // an extension is treated as a sentinel and left untouched.
    const looksLikeFile = /\.(md|pdf)$/i.test(cl);
    if (looksLikeFile) {
      out.warnings.push(
        `no source file found for cl_path "${cl}" (looked in cover_letters/, cover_letters_md/, and as written) — TSV pointer will still be canonicalised`
      );
    } else {
      out.warnings.push(
        `cl_path "${cl}" looks like a sentinel (no .md/.pdf extension) — leaving TSV pointer unchanged`
      );
      out.skip = true;
      out.reason = "sentinel cl_path";
      return out;
    }
  }

  // MD action — only when MD exists and not at target. Generate-from-PDF is
  // out of scope (no reliable text extractor wired up; PDF-only rows just
  // stay PDF-only, the engine can recreate the MD on next prepare run).
  if (mdSrc && !mdAtTarget) {
    out.mdMove = { from: mdSrc, to: targetMdAbs };
  }

  return out;
}

// --- Side-effect helpers (real fs) ------------------------------------------

function defaultBackupTsv(applicationsPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${applicationsPath}.pre-cl-migrate-${stamp}`;
  fs.copyFileSync(applicationsPath, dest);
  return dest;
}

function moveFile(from, to) {
  if (from === to) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

async function generatePdfFromMd(mdPath, pdfPath) {
  const text = fs.readFileSync(mdPath, "utf8");
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n+/g, " ").trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) {
    throw new Error(`MD source "${mdPath}" has no paragraphs after parsing`);
  }
  fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
  await generateCoverLetterPdf({ paragraphs }, pdfPath);
}

// --- Orchestration ----------------------------------------------------------

async function migrate({
  profileId,
  apply = false,
  profilesDir,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  if (!profileId) {
    stderr("error: --profile <id> is required");
    return 1;
  }

  const dirs = profilesDir || resolveProfilesDir({}, process.env);
  const profile = loadProfile(profileId, { profilesDir: dirs });
  const root = profile.paths.root;
  const applicationsPath = profile.paths.applicationsTsv;

  if (!fs.existsSync(applicationsPath)) {
    stderr(`error: ${applicationsPath} not found`);
    return 1;
  }

  const { apps } = applicationsTsv.load(applicationsPath);

  const stats = {
    total: apps.length,
    rowsWithCl: 0,
    skippedCanonical: 0,
    skippedSentinel: 0,
    pdfMoved: 0,
    pdfGenerated: 0,
    mdMoved: 0,
    tsvUpdated: 0,
    warnings: 0,
    errors: 0,
  };

  const rowsToUpdate = []; // [{ app, plan }]

  for (const app of apps) {
    if (!app.cl_path || String(app.cl_path).trim() === "") continue;
    stats.rowsWithCl++;
    const plan = planRow(app, root, { fileExists: fs.existsSync });
    if (plan.warnings.length > 0) {
      for (const w of plan.warnings) {
        stderr(`warn: [${app.key}] ${w}`);
        stats.warnings++;
      }
    }
    if (plan.skip) {
      if (plan.reason === "sentinel cl_path") stats.skippedSentinel++;
      else stats.skippedCanonical++;
      continue;
    }
    rowsToUpdate.push({ app, plan });
  }

  const skipSummary = (() => {
    const parts = [];
    if (stats.skippedCanonical > 0) parts.push(`${stats.skippedCanonical} already canonical`);
    if (stats.skippedSentinel > 0)
      parts.push(`${stats.skippedSentinel} sentinel(s) left untouched`);
    return parts.length > 0 ? parts.join(", ") : "0 skipped";
  })();

  if (rowsToUpdate.length === 0) {
    stdout(
      `nothing to do — ${stats.rowsWithCl}/${stats.total} rows have cl_path, ` +
        `${skipSummary} (${stats.warnings} warning(s))`
    );
    return 0;
  }

  // Print plan first (always — dry-run readers and apply mode both want it).
  stdout(
    `plan: ${rowsToUpdate.length} row(s) need migration ` +
      `(of ${stats.rowsWithCl} cl_path rows; ${skipSummary})`
  );
  let planMoves = 0;
  let planGens = 0;
  let planMdMoves = 0;
  for (const { plan } of rowsToUpdate) {
    if (plan.pdfMove) planMoves++;
    if (plan.pdfGenerate) planGens++;
    if (plan.mdMove) planMdMoves++;
  }
  stdout(
    `  ${planMoves} PDF move(s), ${planGens} PDF generate(s) from MD, ` +
      `${planMdMoves} MD move(s), ${rowsToUpdate.length} TSV pointer update(s)`
  );

  if (!apply) {
    stdout("(dry-run — pass --apply to mutate filesystem and TSV)");
    return 0;
  }

  // --apply path: backup TSV first.
  const backupPath = defaultBackupTsv(applicationsPath);
  stdout(`backed up TSV → ${backupPath}`);

  // Execute plan. Per-row failures are warned and skipped (don't abort the
  // whole migration); TSV save still runs at the end so partial progress
  // sticks. (Backup is the safety net for anything that goes wrong.)
  for (const { app, plan } of rowsToUpdate) {
    try {
      if (plan.pdfMove) {
        moveFile(plan.pdfMove.from, plan.pdfMove.to);
        stats.pdfMoved++;
      } else if (plan.pdfGenerate) {
        await generatePdfFromMd(plan.pdfGenerate.from, plan.pdfGenerate.to);
        stats.pdfGenerated++;
      }
      if (plan.mdMove) {
        moveFile(plan.mdMove.from, plan.mdMove.to);
        stats.mdMoved++;
      }
      app.cl_path = plan.newClPath;
      stats.tsvUpdated++;
    } catch (err) {
      stats.errors++;
      stderr(`error: [${app.key}] ${err.message}`);
    }
  }

  applicationsTsv.save(applicationsPath, apps);
  stdout(
    `applied: ${stats.pdfMoved} PDF moved, ${stats.pdfGenerated} PDF generated, ` +
      `${stats.mdMoved} MD moved, ${stats.tsvUpdated} TSV pointer(s) updated, ` +
      `${stats.warnings} warning(s), ${stats.errors} error(s)`
  );
  return stats.errors === 0 ? 0 : 1;
}

// --- CLI entry --------------------------------------------------------------

function parseCliArgs(argv) {
  const args = { profile: "", apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false;
    else if (a === "--profile") {
      args.profile = argv[i + 1] || "";
      i++;
    }
  }
  return args;
}

if (require.main === module) {
  (async () => {
    const args = parseCliArgs(process.argv.slice(2));
    if (!args.profile) {
      console.error("usage: migrate_cl_layout.js --profile <id> [--apply]");
      process.exit(1);
    }
    try {
      require("dotenv").config();
    } catch (_err) {
      // dotenv optional — only matters for non-CL operations
    }
    const code = await migrate({
      profileId: args.profile,
      apply: args.apply,
    });
    process.exit(code);
  })();
}

module.exports = { migrate, planRow, parseCliArgs };
