#!/usr/bin/env node
// Parse email_check_log.md → extract one run's table rows as JSON.
//
// Usage:
//   node scripts/parse_check_log.js \
//     --log profiles/jared/email_check_log.md \
//     --header "## Check: 2026-04-30 09:36" \
//     --out /tmp/replay_baseline.json

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--log") args.log = argv[++i];
    else if (a === "--header") args.header = argv[++i];
    else if (a === "--out") args.out = argv[++i];
  }
  if (!args.log || !args.header) {
    console.error(
      'usage: node scripts/parse_check_log.js --log <md> --header "## Check: YYYY-MM-DD HH:MM" [--out <path>]'
    );
    process.exit(1);
  }
  args.out = args.out || "/tmp/replay_baseline.json";
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const txt = fs.readFileSync(path.resolve(args.log), "utf8");
  const idx = txt.indexOf(args.header);
  if (idx < 0) {
    console.error(`error: header not found: ${args.header}`);
    process.exit(1);
  }
  // Slice from this header to the next "## Check: " or EOF.
  const after = txt.slice(idx + args.header.length);
  const nextHeaderIdx = after.indexOf("\n## Check:");
  const section =
    nextHeaderIdx >= 0 ? after.slice(0, nextHeaderIdx) : after;

  // Extract summary numbers from line like:
  //   **Emails found**: 58 | **Matched**: 53 | **Actions**: 15
  const summaryRe =
    /\*\*Emails found\*\*:\s*(\d+)\s*\|\s*\*\*Matched\*\*:\s*(\d+)\s*\|\s*\*\*Actions\*\*:\s*(\d+)/;
  const sm = section.match(summaryRe);
  const summary = sm
    ? {
        emailsFound: Number(sm[1]),
        matched: Number(sm[2]),
        actions: Number(sm[3]),
      }
    : null;

  // Parse table rows: lines starting with "| " and not the header / separator.
  const rows = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("| ")) continue;
    if (line.startsWith("| Gmail ID")) continue;
    if (line.startsWith("|---") || line.startsWith("| ---")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((s) => s.trim());
    if (cells.length < 7) continue;
    // Skip rows that aren't actually data (e.g., separators that slipped through).
    if (!/^[0-9a-f]+$/i.test(cells[0])) continue;
    rows.push({
      id: cells[0],
      company: cells[1],
      role: cells[2],
      match: cells[3],
      type: cells[4],
      action: cells[5],
      comment: cells[6],
    });
  }

  const result = {
    meta: { log: args.log, header: args.header },
    summary,
    rows,
  };
  fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
  console.log(`✓ wrote ${args.out}`);
  console.log(
    `  rows=${rows.length} summary=${JSON.stringify(summary)}`
  );
}

main();
