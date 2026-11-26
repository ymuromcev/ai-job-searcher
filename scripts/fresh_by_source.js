#!/usr/bin/env node
// RFC 073 — list fresh Inbox rows from one discovery source.
//
// Rows the night bot cannot submit (e.g. `walmart`: apply needs a Walmart
// account) are held out of the night's prepare batch and stay in Inbox, which
// is TSV-only, so the owner never sees them. The night's morning message calls
// this script to name them: title, city, link — one line each.
//
// Read-only: never writes the TSV, never touches the network.
//
// Usage:
//   node scripts/fresh_by_source.js --profile <id> --source walmart [--hours 24]
//
// Output: one line per row, newest first, "title — locations — url".
// No rows → prints nothing (exit 0).

const DEFAULT_HOURS = 24;

// Pure. `apps` — rows from applications_tsv.load; `now` — Date.
function pickFresh(apps, { source, hours = DEFAULT_HOURS, now = new Date() } = {}) {
  const src = String(source || "").toLowerCase();
  if (!src) return [];
  const since = now.getTime() - hours * 60 * 60 * 1000;
  return (apps || [])
    .filter((a) => String(a.source || "").toLowerCase() === src)
    .filter((a) => a.status === "Inbox")
    .filter((a) => {
      const t = Date.parse(a.createdAt || "");
      return Number.isFinite(t) && t >= since;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function formatLine(app) {
  const locs = Array.isArray(app.locations)
    ? app.locations.join("; ")
    : String(app.locations || "");
  return [app.title, locs, app.url].filter(Boolean).join(" — ");
}

function parseArgs(argv) {
  const out = { hours: DEFAULT_HOURS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--source") out.source = argv[++i];
    else if (a === "--hours") out.hours = Number(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.profile) throw new Error("--profile is required");
  if (!out.source) throw new Error("--source is required");
  if (!Number.isFinite(out.hours) || out.hours <= 0) throw new Error("--hours must be > 0");
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { loadProfile } = require("../engine/core/profile_loader.js");
  const applicationsTsv = require("../engine/core/applications_tsv.js");
  const { resolveProfilesDir } = require("../engine/core/paths.js");
  // Same resolution as the CLI (honours AI_JOB_SEARCHER_DATA_DIR).
  const profile = loadProfile(args.profile, {
    profilesDir: resolveProfilesDir({}, process.env),
  });
  const { apps } = applicationsTsv.load(profile.paths.applicationsTsv);
  for (const app of pickFresh(apps, args)) console.log(formatLine(app));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { pickFresh, formatLine, parseArgs };
