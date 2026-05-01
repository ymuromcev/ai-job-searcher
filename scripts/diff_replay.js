#!/usr/bin/env node
// Diff replay (new code) vs baseline (parsed Mac MCP log).
// Pairs by email id and reports per-row deltas in match/type/action.

const fs = require("fs");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--new") args.newPath = argv[++i];
    else if (a === "--baseline") args.basePath = argv[++i];
  }
  if (!args.newPath || !args.basePath) {
    console.error(
      "usage: node scripts/diff_replay.js --new <path> --baseline <path>"
    );
    process.exit(1);
  }
  return args;
}

function normalizeRole(s) {
  return (s || "").toLowerCase().slice(0, 30);
}

function main() {
  const args = parseArgs(process.argv);
  const neu = JSON.parse(fs.readFileSync(args.newPath, "utf8"));
  const base = JSON.parse(fs.readFileSync(args.basePath, "utf8"));

  const newById = new Map(neu.logRows.map((r) => [r.id, r]));
  const baseById = new Map(base.rows.map((r) => [r.id, r]));

  const allIds = new Set([...newById.keys(), ...baseById.keys()]);

  const deltas = [];
  for (const id of allIds) {
    const n = newById.get(id);
    const b = baseById.get(id);
    if (!n || !b) {
      deltas.push({
        id,
        diff: !n ? "missing-in-new" : "missing-in-baseline",
        baseline: b || null,
        replay: n || null,
      });
      continue;
    }
    const dMatch = n.match !== b.match;
    const dType = n.type !== b.type;
    // Action strings differ in whitespace/punctuation; compare key tokens.
    const nAct = (n.action || "").trim();
    const bAct = (b.action || "").trim();
    const dAction = nAct !== bAct;
    if (dMatch || dType || dAction) {
      deltas.push({
        id,
        company: b.company,
        role: b.role,
        baseline: { match: b.match, type: b.type, action: bAct },
        replay: { match: n.match, type: n.type, action: nAct },
      });
    }
  }

  const sumNew = neu.summary;
  const sumBase = base.summary;

  console.log("=== Summary ===");
  console.log(
    `baseline: emails=${sumBase.emailsFound} matched=${sumBase.matched} actions=${sumBase.actions}`
  );
  console.log(
    `replay:   emails=${sumNew.emailsProcessed} matched=${sumNew.matched} actions=${sumNew.actions}`
  );
  console.log(`deltas:   ${deltas.length} rows differ`);
  console.log();

  if (deltas.length === 0) {
    console.log("✓ identical");
    return;
  }

  // Group deltas by kind for readability.
  const byKind = {
    typeChange: [],
    matchChange: [],
    actionChange: [],
    missing: [],
  };
  for (const d of deltas) {
    if (d.diff) {
      byKind.missing.push(d);
      continue;
    }
    if (d.baseline.type !== d.replay.type) byKind.typeChange.push(d);
    else if (d.baseline.match !== d.replay.match) byKind.matchChange.push(d);
    else byKind.actionChange.push(d);
  }

  if (byKind.missing.length) {
    console.log(`--- missing rows (${byKind.missing.length}) ---`);
    for (const d of byKind.missing) {
      console.log(`  ${d.id}  ${d.diff}`);
    }
    console.log();
  }
  if (byKind.typeChange.length) {
    console.log(`--- TYPE changes (${byKind.typeChange.length}) ---`);
    for (const d of byKind.typeChange) {
      console.log(
        `  ${d.id}  ${d.company} | ${d.role}`
      );
      console.log(
        `    baseline: type=${d.baseline.type} match=${d.baseline.match} action="${d.baseline.action}"`
      );
      console.log(
        `    replay:   type=${d.replay.type} match=${d.replay.match} action="${d.replay.action}"`
      );
    }
    console.log();
  }
  if (byKind.matchChange.length) {
    console.log(`--- MATCH changes (${byKind.matchChange.length}) ---`);
    for (const d of byKind.matchChange) {
      console.log(
        `  ${d.id}  ${d.company} | ${d.role} | type=${d.baseline.type}`
      );
      console.log(
        `    baseline: match=${d.baseline.match} action="${d.baseline.action}"`
      );
      console.log(
        `    replay:   match=${d.replay.match} action="${d.replay.action}"`
      );
    }
    console.log();
  }
  if (byKind.actionChange.length) {
    console.log(`--- ACTION-only changes (${byKind.actionChange.length}) ---`);
    for (const d of byKind.actionChange) {
      console.log(
        `  ${d.id}  ${d.company} | ${d.role} | type=${d.baseline.type} match=${d.baseline.match}`
      );
      console.log(`    baseline: "${d.baseline.action}"`);
      console.log(`    replay:   "${d.replay.action}"`);
    }
    console.log();
  }
}

main();
