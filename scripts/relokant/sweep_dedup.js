#!/usr/bin/env node
// BL-200 / RFC 061 — dedup helper for the relokant-sweep skill.
//
// The sweep is LLM-driven web research. To guarantee — on code, not on the
// model's good behaviour — that a run never re-adds a company we already took
// (ru_friendly_targets.tsv) or already rejected (ru_friendly_rejects.tsv),
// the skill pipes its candidate names through this helper before appending.
//
// Pure functions over in-memory strings; a single I/O point (loadKnownNames)
// reads the two TSVs. No network.
//
// Usage:
//   node scripts/relokant/sweep_dedup.js --profile <id> <name1> <name2> ...
//   node scripts/relokant/sweep_dedup.js --profile jared "Virto Commerce" "New Co"
//
// Prints one line per input name: "FRESH\t<name>" or "DUP\t<name>".
// Exit code is always 0 — this is an advisory filter, not a gate.

const fs = require("fs");
const path = require("path");

// Legal-entity suffixes stripped before comparison so "Virto Commerce, Inc."
// matches "Virto Commerce". Order-independent; applied as a trailing-token set.
const LEGAL_SUFFIXES = new Set([
  "inc",
  "llc",
  "ltd",
  "limited",
  "gmbh",
  "corp",
  "co",
  "company",
  "plc",
  "ag",
  "sa",
  "bv",
  "oy",
  "ab",
]);

// Normalize a company name to a comparison key:
//   - strip diacritics (José -> jose)
//   - lowercase
//   - drop punctuation (keep alnum + spaces)
//   - collapse whitespace
//   - drop trailing legal-entity suffix tokens
function normalizeName(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.normalize("NFKD").replace(/[̀-ͯ]/g, ""); // strip Latin diacritics
  s = s.toLowerCase();
  // Drop punctuation but KEEP Unicode letters/digits — many CIS company
  // names are Cyrillic; stripping to ASCII would normalize "Яндекс" to ""
  // and the helper would then mislabel a genuinely new company as a dup.
  s = s.replace(/[^\p{L}\p{N}\s]/gu, " "); // punctuation -> space
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "";
  let tokens = s.split(" ");
  // Peel trailing legal suffixes (e.g. "... inc", "... co ltd").
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(" ");
}

// Partition candidate names into fresh (unknown) and dupes (already known).
// `knownNames` is a Set of *normalized* names. Preserves the original casing
// of the candidate in the output and dedups within the candidate list itself.
function partitionCandidates(candidateNames, knownNames) {
  const fresh = [];
  const dupes = [];
  const seenThisRun = new Set();
  for (const name of candidateNames) {
    const key = normalizeName(name);
    if (!key) continue; // empty / junk
    if (knownNames.has(key) || seenThisRun.has(key)) {
      dupes.push(name);
    } else {
      fresh.push(name);
      seenThisRun.add(key);
    }
  }
  return { fresh, dupes };
}

// Read the first (name) column of a TSV, skipping the header row.
// Missing file -> empty array (rejects.tsv may not exist on first run).
function readNameColumn(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length <= 1) return []; // header only or empty
  return lines.slice(1).map((line) => line.split("\t")[0]);
}

// Single I/O point: load both ledgers into one normalized Set.
function loadKnownNames(targetsPath, rejectsPath) {
  const known = new Set();
  for (const name of [...readNameColumn(targetsPath), ...readNameColumn(rejectsPath)]) {
    const key = normalizeName(name);
    if (key) known.add(key);
  }
  return known;
}

function profilePaths(profileId) {
  // Resolve relative to CWD (repo root), matching profile_loader's
  // `path.resolve("profiles")` convention — NOT __dirname. This decouples
  // the script's location from the data's location, so the same script
  // works from main checkout, a worktree, or the installed ~/.ai-job-searcher.
  const base = path.resolve("profiles", profileId);
  return {
    targets: path.join(base, "ru_friendly_targets.tsv"),
    rejects: path.join(base, "ru_friendly_rejects.tsv"),
  };
}

function main(argv) {
  const args = argv.slice(2);
  let profileId = null;
  const names = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--profile") {
      profileId = args[++i];
    } else {
      names.push(args[i]);
    }
  }
  if (!profileId) {
    console.error("usage: sweep_dedup.js --profile <id> <name> [<name> ...]");
    process.exit(2);
  }
  const { targets, rejects } = profilePaths(profileId);
  const known = loadKnownNames(targets, rejects);
  const { fresh, dupes } = partitionCandidates(names, known);
  const verdict = new Map();
  for (const n of fresh) verdict.set(n, "FRESH");
  for (const n of dupes) verdict.set(n, "DUP");
  for (const n of names) {
    const v = verdict.get(n) || "DUP"; // empty/junk treated as DUP (skip)
    console.log(`${v}\t${n}`);
  }
}

if (require.main === module) {
  main(process.argv);
}

module.exports = {
  normalizeName,
  partitionCandidates,
  readNameColumn,
  loadKnownNames,
  LEGAL_SUFFIXES,
};
