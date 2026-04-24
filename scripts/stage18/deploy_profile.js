// deploy_profile.js — Stage 18 onboarding orchestrator.
//
// Runs the full pipeline for a new profile, driven by the parsed intake
// (profiles/<id>/.stage18/intake.json, produced by parse_intake.js --apply).
//
// Steps:
//   0. Validate intake and profile id.
//   1. Generate local files: profile.json, filter_rules.json,
//      resume_versions.json, cover_letter_template.md, cover_letter_versions.json.
//   2. Provision Notion: Companies DB → Jobs DB (Company relation points at
//      Companies DB).
//   3. Seed Companies DB from intake.companies.tier_* (skipped when
//      flags.include_companies_seed=false).
//   4. Optional: import_prototype (opt-in per flag in intake.prototype).
//   5. Print follow-up steps: auxiliary DBs (Application Q&A, Job Platforms)
//      and hub layout are profile-titled and deferred to a one-time setup
//      the user confirms — see scripts/stage18/README.md §follow-ups.
//
// Default mode: --dry-run. Pass --apply to write.
// Per-step idempotency is handled by each sub-script (state.json +
// adopt-by-title for Notion DBs). Re-running deploy_profile.js is safe.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  loadEnv,
  parseArgs,
  banner,
  done,
  fatal,
  loadIntake,
  loadState,
  saveState,
  profileDir,
  ensureStage18Dir,
  validateProfileId,
} = require("./_common.js");

const { validateIntake } = require("./parse_intake.js");
const { buildProfileJson } = require("./generators/profile_json.js");
const { buildFilterRules } = require("./generators/filter_rules.js");
const { buildResumeVersions } = require("./generators/resume_versions.js");
const {
  buildCoverLetterTemplate,
  buildCoverLetterVersions,
} = require("./generators/cover_letter.js");

// Run a stage18 sub-script as a child process. Inherits stdio so the user
// sees the banners + logs in order. Returns { code, ok }.
function runStep(scriptRel, args, profile, apply) {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const scriptAbs = path.join(__dirname, scriptRel);
  const flags = ["--profile", profile, ...args];
  if (apply) flags.push("--apply");
  console.log(`\n  > node ${path.relative(repoRoot, scriptAbs)} ${flags.join(" ")}`);
  const res = spawnSync(process.execPath, [scriptAbs, ...flags], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  return { code: res.status, ok: res.status === 0 };
}

// Write a file only if content differs. Returns "wrote" | "unchanged".
function writeIfChanged(absPath, content) {
  if (fs.existsSync(absPath)) {
    const prev = fs.readFileSync(absPath, "utf8");
    if (prev === content) return "unchanged";
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
  return "wrote";
}

function generateFiles(intake, id, apply) {
  const dstRoot = profileDir(id);
  const artifacts = [];

  const profile = buildProfileJson(intake);
  const profileJson = JSON.stringify(profile, null, 2) + "\n";
  artifacts.push({
    rel: "profile.json",
    content: profileJson,
    notes: `${Object.keys(profile.notion.property_map).length} property_map fields`,
  });

  const filterRules = buildFilterRules(intake);
  artifacts.push({
    rel: "filter_rules.json",
    content: JSON.stringify(filterRules, null, 2) + "\n",
    notes: `company_blocklist=${filterRules.company_blocklist.length}, title_blocklist=${filterRules.title_blocklist.length}, location_blocklist=${filterRules.location_blocklist.length}`,
  });

  const resumeVersions = buildResumeVersions(intake);
  const versionCount = Object.keys(resumeVersions.versions).length;
  artifacts.push({
    rel: "resume_versions.json",
    content: JSON.stringify(resumeVersions, null, 2) + "\n",
    notes: `${versionCount} archetype(s)`,
  });

  artifacts.push({
    rel: "cover_letter_template.md",
    content: buildCoverLetterTemplate(intake),
    notes: "voice template with {{placeholders}}",
  });

  const clVersions = buildCoverLetterVersions(intake);
  artifacts.push({
    rel: "cover_letter_versions.json",
    content: JSON.stringify(clVersions, null, 2) + "\n",
    notes: `${Object.keys(clVersions.versions).length} archetype override slot(s)`,
  });

  const summary = [];
  for (const a of artifacts) {
    const abs = path.join(dstRoot, a.rel);
    if (!apply) {
      console.log(`  [${a.rel}] plan (${a.notes})`);
      summary.push({ path: a.rel, status: "planned" });
      continue;
    }
    const outcome = writeIfChanged(abs, a.content);
    console.log(`  [${a.rel}] ${outcome} (${a.notes})`);
    summary.push({ path: a.rel, status: outcome });
  }
  return summary;
}

async function main() {
  loadEnv();
  const args = parseArgs();
  banner("deploy_profile", args);

  const { data: intake } = loadIntake(args.profile);
  const id = validateProfileId(intake.identity.profile_id);
  if (args.profile !== id) {
    console.log(
      `  note: --profile=${args.profile} but intake.identity.profile_id=${id} — using intake value`
    );
  }

  const { ok, errors } = validateIntake(intake);
  if (!ok) {
    console.error("  intake validation failed:");
    for (const e of errors) console.error("    - " + e);
    fatal(new Error("intake has required-field errors. Fix intake.md + re-run parse_intake.js --apply."));
  }

  ensureStage18Dir(id);
  const { data: state } = loadState(id);

  // ── Step 1: generate files ────────────────────────────────────────────
  console.log("\n--- Step 1: generate local files ---");
  const generated = generateFiles(intake, id, args.apply);
  if (args.apply) {
    state.deploy_profile = state.deploy_profile || {};
    state.deploy_profile.generated = {
      done: true,
      files: generated,
      at: new Date().toISOString(),
    };
    saveState(id, state);
  }

  // ── Step 2: provision Notion DBs ──────────────────────────────────────
  // Order matters: Companies first (Jobs relation points at Companies).
  console.log("\n--- Step 2: provision Notion DBs ---");
  const companies = runStep("create_companies_db.js", [], id, args.apply);
  if (!companies.ok) {
    fatal(new Error("create_companies_db failed — halting pipeline"));
  }
  const jobs = runStep("create_jobs_db.js", [], id, args.apply);
  if (!jobs.ok) {
    fatal(new Error("create_jobs_db failed — halting pipeline"));
  }

  // ── Step 3: seed companies ────────────────────────────────────────────
  console.log("\n--- Step 3: seed Companies DB ---");
  const includeSeed =
    intake.flags && intake.flags.include_companies_seed === false
      ? false
      : true;
  if (!includeSeed) {
    console.log("  intake.flags.include_companies_seed=false — skipping");
  } else {
    const seed = runStep("seed_companies.js", [], id, args.apply);
    if (!seed.ok) {
      fatal(new Error("seed_companies failed — halting pipeline"));
    }
  }

  // ── Step 4: optional prototype import ─────────────────────────────────
  console.log("\n--- Step 4: import from prior prototype (optional) ---");
  if (intake.prototype && intake.prototype.has_prototype === true) {
    const imp = runStep("import_prototype.js", [], id, args.apply);
    if (!imp.ok) {
      console.warn("  import_prototype exited non-zero — not fatal; review output");
    }
  } else {
    console.log("  intake.prototype.has_prototype is not yes — skipping");
  }

  // ── Step 5: print follow-ups ──────────────────────────────────────────
  console.log("\n--- Step 5: follow-ups (manual) ---");
  console.log("  The following steps are profile-titled and not wired into");
  console.log("  deploy_profile (see scripts/stage18/README.md §follow-ups):");
  console.log("    1) Application Q&A DB + Job Platforms DB (stage16 has a");
  console.log(`       Jared-titled version — adapt or create manually).`);
  console.log("    2) Hub layout page (3-col body + subpages + DB embeds).");
  console.log("    3) Fill INTEGRATION_* secrets in .env if the profile uses");
  console.log("       check / discovery:usajobs.");
  console.log("    4) Smoke test: node engine/cli.js scan --profile " + id);

  if (args.apply) {
    state.deploy_profile = state.deploy_profile || {};
    state.deploy_profile.done = true;
    state.deploy_profile.at = new Date().toISOString();
    saveState(id, state);
  }

  done("deploy_profile", {
    profile_id: id,
    mode: args.apply ? "APPLY" : "DRY-RUN",
  });
}

if (require.main === module) {
  main().catch(fatal);
}

module.exports = { generateFiles, runStep, writeIfChanged };
