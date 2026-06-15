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
// Deterministic + idempotent: same storybank content → byte-identical output (no
// timestamps; freshness is tracked by the content hash in the header).
//
// Reads:
//   profiles/<id>/interview-coach-state/coaching_state.md
//
// Writes:
//   profiles/<id>/fit_profile.md  (overwritten — generated file, never hand-edited)

const fs = require("fs");
const path = require("path");

const { parseStorybank } = require("../engine/core/storybank");
const { buildFitDigest } = require("../engine/core/fit_digest");

// ---------- arg parsing ----------

function parseArgs(argv) {
  const args = { profile: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") args.profile = argv[++i];
    else if (argv[i] === "--root") args.root = argv[++i]; // override for tests
  }
  return args;
}

function coachingStatePath(root, profile) {
  return path.join(root, "profiles", profile, "interview-coach-state", "coaching_state.md");
}

function fitProfilePath(root, profile) {
  return path.join(root, "profiles", profile, "fit_profile.md");
}

function main(argv = process.argv.slice(2), opts = {}) {
  const args = parseArgs(argv);
  if (!args.profile) {
    console.error("Usage: node scripts/build_fit_profile.js --profile <id>");
    return 1;
  }

  const root = args.root || path.join(__dirname, "..");
  const csPath = coachingStatePath(root, args.profile);

  if (!fs.existsSync(csPath)) {
    console.error(`coaching_state.md not found at ${csPath}`);
    return 1;
  }

  const md = fs.readFileSync(csPath, "utf8");
  const stories = parseStorybank(md);

  if (stories.length === 0) {
    console.error(
      `No storybank stories found in ${csPath} — fit has no achievement basis. ` +
        "Add a `## Storybank` table before generating the fit profile."
    );
    return 1;
  }

  const digest = buildFitDigest(stories, {
    profileId: args.profile,
    source: "interview-coach-state/coaching_state.md (## Storybank)",
  });

  const outPath = fitProfilePath(root, args.profile);
  fs.writeFileSync(outPath, digest, "utf8");
  console.log(`Wrote ${outPath} (${digest.length} bytes, ${stories.length} stories)`);
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main, parseArgs, coachingStatePath, fitProfilePath };
