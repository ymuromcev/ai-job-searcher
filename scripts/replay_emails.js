#!/usr/bin/env node
// Pure replay harness — runs the NEW classifier+pipeline against a HISTORICAL
// raw_emails.json snapshot to verify parity with prior runs (or detect the
// classifier-fix delta).
//
// READ-ONLY: never writes to profiles/, Notion, processed_messages, TSV.
// Output goes to --out (default /tmp/replay_new.json) only.
//
// Usage:
//   node scripts/replay_emails.js \
//     --profile jared \
//     --raw-emails profiles/jared/.gmail-state/raw_emails.pre-recheck-2026-04-30.json \
//     --tsv profiles/jared/applications.tsv.pre-recheck-2026-04-30 \
//     --out /tmp/replay_new.json
//
// If --tsv is omitted, current applications.tsv is used (post-rollback state).

const path = require("path");
const fs = require("fs");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const profileLoader = require("../engine/core/profile_loader.js");
const applicationsTsv = require("../engine/core/applications_tsv.js");
const {
  buildActiveJobsMap,
  buildPipelineState,
  processEmailsLoop,
} = require("../engine/commands/check.js");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") args.profile = argv[++i];
    else if (a === "--raw-emails") args.rawEmails = argv[++i];
    else if (a === "--tsv") args.tsv = argv[++i];
    else if (a === "--out") args.out = argv[++i];
  }
  if (!args.profile || !args.rawEmails) {
    console.error(
      "usage: node scripts/replay_emails.js --profile <id> --raw-emails <path> [--tsv <path>] [--out <path>]"
    );
    process.exit(1);
  }
  args.out = args.out || "/tmp/replay_new.json";
  return args;
}

function main() {
  const args = parseArgs(process.argv);

  // Load profile (read-only).
  const profile = profileLoader.loadProfile(args.profile, {
    profilesDir: path.join(__dirname, "..", "profiles"),
  });

  // Load TSV — either custom snapshot or current.
  const tsvPath = args.tsv
    ? path.resolve(args.tsv)
    : profile.paths.applicationsTsv;
  if (!fs.existsSync(tsvPath)) {
    console.error(`error: TSV not found: ${tsvPath}`);
    process.exit(1);
  }
  const { apps } = applicationsTsv.load(tsvPath);

  // Load raw emails.
  const rawPath = path.resolve(args.rawEmails);
  if (!fs.existsSync(rawPath)) {
    console.error(`error: raw_emails not found: ${rawPath}`);
    process.exit(1);
  }
  const rawEmails = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  if (!Array.isArray(rawEmails)) {
    console.error("error: raw_emails.json must be an array");
    process.exit(1);
  }

  // Build state — same as runAuto, but no processedSet filter (we want every
  // historical email processed).
  const activeJobsMap = buildActiveJobsMap(apps);
  const tsvCache = [...apps];
  const state = buildPipelineState(profile, activeJobsMap, tsvCache);
  const procCtx = { nowIso: new Date().toISOString() };

  // Run the loop (pure).
  const { logRows, actions, rejections } = processEmailsLoop(
    rawEmails,
    state,
    procCtx
  );

  // Output.
  const result = {
    meta: {
      profile: args.profile,
      tsv: tsvPath,
      rawEmails: rawPath,
      emailsTotal: rawEmails.length,
      activeJobsCompanies: Object.keys(activeJobsMap).length,
      generatedAt: procCtx.nowIso,
    },
    summary: {
      emailsProcessed: rawEmails.length,
      matched: logRows.filter((r) => r.match !== "NONE").length,
      actions: actions.length,
      rejections: rejections.length,
      inboxAdded: state.newInboxRows.length,
      recruiterLeads: state.recruiterLeads.length,
    },
    logRows,
    actions: actions.map((a) => ({
      kind: a.kind,
      pageId: a.pageId,
      appKey: a.appKey,
      newStatus: a.newStatus || null,
    })),
  };

  fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
  console.log(`✓ wrote ${args.out}`);
  console.log(
    `  emails=${result.summary.emailsProcessed} matched=${result.summary.matched} actions=${result.summary.actions} rejections=${result.summary.rejections}`
  );
}

main();
