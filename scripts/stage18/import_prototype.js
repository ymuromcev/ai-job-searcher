// import_prototype.js — optional: copy assets from a user's prior prototype.
//
// Driven by intake.prototype.*. Each asset is opt-in via the corresponding
// `import_*` flag. Defaults are all false (nothing is imported unless user
// explicitly asked).
//
// Supports two prototype shapes:
//   - Partial (second profile): template + resume_versions + cover_letters/ + resumes/
//   - Full (Jared-like): additionally TSV + Notion workspace URL (delegates
//     to stage16 scripts via subprocess hint — we print the commands rather
//     than run them, since full migration deserves user-in-the-loop).
//
// Default mode: dry-run. --apply copies files.

const fs = require("fs");
const path = require("path");

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
} = require("./_common.js");

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function copyFile(src, dst, { overwrite }) {
  if (exists(dst) && !overwrite) return { action: "skip", reason: "target exists" };
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return { action: "copy" };
}

// Recursive directory copy. Skips dotfiles (.DS_Store, .git, etc.) and
// preserves subdirectory layout. Returns counts.
function copyDir(srcDir, dstDir, { overwrite }) {
  if (!exists(srcDir)) return { copied: 0, skipped: 0, missing: true };
  const stats = { copied: 0, skipped: 0, missing: false };
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const s = path.join(srcDir, entry.name);
    const d = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      const sub = copyDir(s, d, { overwrite });
      stats.copied += sub.copied;
      stats.skipped += sub.skipped;
      continue;
    }
    if (exists(d) && !overwrite) {
      stats.skipped += 1;
      continue;
    }
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(s, d);
    stats.copied += 1;
  }
  return stats;
}

const IMPORT_PLAN = [
  {
    key: "import_cover_letter_template",
    kind: "file",
    src: "cover_letter_template.md",
    dst: "cover_letter_template.md",
    overwrite: true, // wizard generated a fresh one; prototype overrides if user opted in
  },
  {
    key: "import_resume_versions",
    kind: "file",
    src: "resume_versions.json",
    dst: "resume_versions.json",
    overwrite: true,
  },
  {
    key: "import_cover_letter_versions",
    kind: "file",
    // Prototype file name differs: prototype used "cover_letter_config.json"
    src: "cover_letter_config.json",
    dst: "cover_letter_versions.json",
    overwrite: true,
  },
  {
    key: "import_generated_cover_letters",
    kind: "dir",
    src: "cover_letters",
    dst: "cover_letters",
    overwrite: false,
  },
  {
    key: "import_generated_resumes",
    kind: "dir",
    src: "resumes",
    dst: "resumes",
    overwrite: false,
  },
  {
    key: "import_tsv",
    kind: "file",
    // Prototype used job_registry.tsv; new engine uses applications.tsv.
    // We copy the prototype file so the user can run stage16 migration
    // against it later if they want. Not auto-converted here.
    src: "job_registry.tsv",
    dst: ".stage18/prototype_job_registry.tsv",
    overwrite: true,
  },
];

async function main() {
  loadEnv();
  const args = parseArgs();
  banner("import_prototype", args);

  const { data: intake } = loadIntake(args.profile);
  const id = intake.identity.profile_id;
  const proto = intake.prototype || {};

  if (proto.has_prototype !== true) {
    console.log("  intake.prototype.has_prototype is not yes — nothing to import.");
    done("import_prototype", { skipped: true });
    return;
  }
  if (!proto.prototype_path) {
    fatal(new Error("intake.prototype.prototype_path is required when has_prototype=yes"));
  }
  if (!exists(proto.prototype_path)) {
    fatal(new Error(`prototype path does not exist: ${proto.prototype_path}`));
  }

  const dstRoot = profileDir(id);

  let totalCopied = 0;
  let totalSkipped = 0;

  for (const item of IMPORT_PLAN) {
    if (proto[item.key] !== true) {
      console.log(`  [${item.key}] disabled — skip`);
      continue;
    }
    const srcAbs = path.join(proto.prototype_path, item.src);
    const dstAbs = path.join(dstRoot, item.dst);

    if (!exists(srcAbs)) {
      console.log(`  [${item.key}] source missing (${srcAbs}) — skip`);
      continue;
    }

    if (item.kind === "file") {
      console.log(`  [${item.key}] file: ${item.src} → ${item.dst}`);
      if (!args.apply) continue;
      const r = copyFile(srcAbs, dstAbs, { overwrite: item.overwrite });
      if (r.action === "copy") totalCopied += 1;
      else totalSkipped += 1;
      continue;
    }

    if (item.kind === "dir") {
      if (!args.apply) {
        const entries = fs.readdirSync(srcAbs, { withFileTypes: true }).filter(e => !e.name.startsWith("."));
        console.log(`  [${item.key}] dir: ${item.src}/ (~${entries.length} entries at top level) → ${item.dst}/`);
        continue;
      }
      const r = copyDir(srcAbs, dstAbs, { overwrite: item.overwrite });
      console.log(`  [${item.key}] dir: copied ${r.copied}, skipped ${r.skipped}`);
      totalCopied += r.copied;
      totalSkipped += r.skipped;
      continue;
    }
  }

  // Full prototype Notion snapshot is out of scope: we only print a hint.
  if (proto.import_notion_workspace_url) {
    console.log("");
    console.log("  Notion prototype snapshot requested. Run Stage 16 helper:");
    console.log(`    node scripts/stage16/fetch_prototype_notion_jobs.js --profile ${id} --apply`);
    console.log("  (requires prototype Jobs DB id configured; see scripts/stage16/README.md)");
  }

  if (args.apply) {
    const { data: state } = loadState(id);
    state.import_prototype = {
      done: true,
      copied: totalCopied,
      skipped: totalSkipped,
      at: new Date().toISOString(),
    };
    saveState(id, state);
  }

  done("import_prototype", { copied: totalCopied, skipped: totalSkipped });
}

if (require.main === module) {
  main().catch(fatal);
}

module.exports = { IMPORT_PLAN, copyFile, copyDir, exists };
