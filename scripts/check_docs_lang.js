#!/usr/bin/env node
/**
 * RFC 018 §15 rule 1 — language policy enforcement.
 *
 * Public docs are EN-only. Walks all tracked Markdown files (excluding
 * node_modules / private / profile data) and flags any line containing
 * Cyrillic characters.
 *
 * Allowed surfaces (skipped):
 *   - private/**           — maintainer scratch (RU OK)
 *   - profiles/**          — gitignored anyway
 *   - data/**              — gitignored anyway
 *   - test fixtures        — *.test.js side files; here we only scan *.md
 *
 * Exit codes:
 *   0 — no Cyrillic in public docs
 *   1 — Cyrillic found
 *
 * Usage: node scripts/check_docs_lang.js [--quiet] [--list]
 *   --list   print a summary line per file (count) instead of full report
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const QUIET = process.argv.includes('--quiet');
const LIST = process.argv.includes('--list');

const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.stage',
  'private',
  'profiles',
  'data',
  'coverage',
  '.gmail-state',
  '.gmail-tokens',
  '.indeed-state',
  'jd_cache',
]);

function shouldSkipDir(name) {
  if (EXCLUDE_DIRS.has(name)) return true;
  if (name.startsWith('.stage')) return true;
  if (name.startsWith('.') && name !== '.github') return true;
  return false;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const CYRILLIC_RE = /[А-Яа-яЁё]/;
const CYRILLIC_RUN_RE = /[А-Яа-яЁё][А-Яа-яЁё\s.,;:'"!?\-—–«»]*/g;

function checkFile(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((line, idx) => {
    if (!CYRILLIC_RE.test(line)) return;
    const samples = [];
    let m;
    CYRILLIC_RUN_RE.lastIndex = 0;
    while ((m = CYRILLIC_RUN_RE.exec(line)) !== null) {
      const s = m[0].trim();
      if (s.length >= 2) samples.push(s);
      if (samples.length >= 3) break;
    }
    hits.push({ line: idx + 1, samples });
  });
  return hits;
}

function main() {
  const files = walk(ROOT);
  let totalHits = 0;
  let filesWithHits = 0;

  for (const f of files) {
    const hits = checkFile(f);
    if (hits.length === 0) continue;
    filesWithHits += 1;
    totalHits += hits.length;
    const rel = path.relative(ROOT, f);
    if (LIST) {
      console.error(`${rel}: ${hits.length} line(s) with Cyrillic`);
      continue;
    }
    console.error(`\n${rel}:`);
    for (const h of hits) {
      const sample = h.samples.length
        ? h.samples.map(s => s.length > 40 ? s.slice(0, 37) + '…' : s).join(' | ')
        : '(no extractable sample)';
      console.error(`  L${h.line}  ${sample}`);
    }
  }

  if (totalHits === 0) {
    if (!QUIET) console.log(`docs:lang   ${files.length} files scanned, 0 Cyrillic hits in public docs`);
    process.exit(0);
  }

  console.error(`\ndocs:lang   FAILED  ${totalHits} line(s) with Cyrillic in ${filesWithHits} public file(s)`);
  console.error(`(public docs must be EN-only per RFC 018 §15; private/ is exempt)`);
  process.exit(1);
}

main();
