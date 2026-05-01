#!/usr/bin/env node
// Read-only debug helper: pull raw email text from Gmail for given message IDs
// and run the classifier against each. Used for diagnosing classifier
// false-positives / false-negatives.
//
// Usage:
//   node scripts/dump_emails.js --profile jared --ids ID1,ID2,ID3
//
// Reads credentials from .env or profiles/<id>/.gmail-tokens/credentials.json
// (whichever is set). gmail.readonly scope only — never mutates.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const {
  loadCredentials,
  assertCredentials,
  makeGmailClient,
  fetchMessage,
  messageToRaw,
} = require("../engine/modules/tracking/gmail_oauth");
const { classify, PATTERNS } = require("../engine/core/classifier");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") args.profile = argv[++i];
    else if (a === "--ids") args.ids = argv[++i];
    else if (a === "--max-body") args.maxBody = Number(argv[++i]);
  }
  if (!args.profile || !args.ids) {
    console.error(
      "usage: node scripts/dump_emails.js --profile <id> --ids ID1,ID2,..."
    );
    process.exit(1);
  }
  args.maxBody = args.maxBody || 2000;
  args.idList = args.ids.split(",").map((s) => s.trim()).filter(Boolean);
  return args;
}

function findMatches(text) {
  const found = [];
  for (const [type, patterns] of Object.entries(PATTERNS)) {
    for (const p of patterns) {
      const m = text.match(p);
      if (m) found.push({ type, pattern: String(p), match: m[0] });
    }
  }
  return found;
}

async function main() {
  const args = parseArgs(process.argv);
  const profileRoot = path.join(__dirname, "..", "profiles", args.profile);
  const creds = loadCredentials(args.profile, { profileRoot });
  assertCredentials(creds, args.profile);
  console.log(`# creds loaded from: ${creds.source}`);

  const gmail = makeGmailClient(creds);

  for (const id of args.idList) {
    let raw;
    try {
      const full = await fetchMessage(gmail, id);
      raw = messageToRaw(full);
    } catch (err) {
      console.log(`\n=== ${id} ===`);
      console.log(`ERROR: ${err.message}`);
      continue;
    }
    if (!raw) {
      console.log(`\n=== ${id} ===`);
      console.log("(message not found)");
      continue;
    }
    const text = `${raw.subject} ${raw.body}`;
    const result = classify({ subject: raw.subject, body: raw.body });
    const allMatches = findMatches(text);
    console.log(`\n=== ${id} ===`);
    console.log(`From:      ${raw.from}`);
    console.log(`Subject:   ${raw.subject}`);
    console.log(`Date:      ${raw.date}`);
    console.log(`Classified-as: ${result.type}  (evidence: "${result.evidence}")`);
    console.log(`All-matches:`);
    for (const m of allMatches) {
      console.log(`  [${m.type}] ${m.pattern} -> "${m.match}"`);
    }
    console.log(`---- body (first ${args.maxBody} chars) ----`);
    console.log(raw.body.slice(0, args.maxBody));
    console.log(`---- end body ----`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
