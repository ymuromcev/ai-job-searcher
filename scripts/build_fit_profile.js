// Builds profiles/<id>/fit_profile.md from the `## Storybank` section of
// profiles/<id>/interview-coach-state/coaching_state.md.
//
// Run: node scripts/build_fit_profile.js --profile <id>
//
// This is the achievement digest that drives fit scoring (RFC 060, BL-192). The
// storybank is the single place the candidate edits real achievements during mock
// interviews; this script keeps the fit basis in sync with it — add a story to
// the bank, regenerate, and fit/master-profile see it without any manual sync.
//
// The build is also run automatically before every `prepare` (engine/commands/
// prepare.js) and gated by `validate`; this CLI is the manual entry point. The
// actual lifecycle logic lives in engine/core/fit_profile.js so there is one
// definition of "fresh".
//
// Deterministic + idempotent: same storybank content → byte-identical output (no
// timestamps; freshness is tracked by the content hash in the header).

const fs = require("fs");
const path = require("path");

const { coachingStatePath, fitProfilePath, buildContent } = require("../engine/core/fit_profile");

// ---------- arg parsing ----------

function parseArgs(argv) {
  const args = { profile: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") args.profile = argv[++i];
    else if (argv[i] === "--root") args.root = argv[++i]; // override for tests
  }
  return args;
}

function profileDir(root, profile) {
  return path.join(root, "profiles", profile);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.profile) {
    console.error("Usage: node scripts/build_fit_profile.js --profile <id>");
    return 1;
  }

  const root = args.root || path.join(__dirname, "..");
  const dir = profileDir(root, args.profile);
  const csPath = coachingStatePath(dir);

  if (!fs.existsSync(csPath)) {
    console.error(`coaching_state.md not found at ${csPath}`);
    return 1;
  }

  const built = buildContent(dir, args.profile);
  if (!built) {
    console.error(
      `No storybank stories found in ${csPath} — fit has no achievement basis. ` +
        "Add a `## Storybank` table before generating the fit profile."
    );
    return 1;
  }

  const outPath = fitProfilePath(dir);
  fs.writeFileSync(outPath, built.content, "utf8");
  console.log(`Wrote ${outPath} (${built.content.length} bytes, ${built.stories.length} stories)`);
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main, parseArgs };
