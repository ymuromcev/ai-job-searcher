#!/usr/bin/env node
/**
 * RFC 018 §8 rule 3 — cross-link audit.
 *
 * Walks all tracked Markdown files (excluding node_modules / private / profile
 * data) and verifies that every relative Markdown link resolves to an existing
 * file. External (http/https) and anchor-only (#frag) links are skipped.
 *
 * Exit codes:
 *   0 — all links resolve
 *   1 — at least one broken link
 *   2 — usage error
 *
 * Usage: node scripts/check_docs_links.js [--quiet]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const QUIET = process.argv.includes('--quiet');

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

// Markdown link regex — matches [text](url) but not images ![alt](url).
// Captures the URL (group 1).
const LINK_RE = /(?<!\!)\[[^\]]*\]\(([^)]+)\)/g;

function checkFile(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  const lines = text.split('\n');
  const errors = [];

  // Skip code fences — links inside ``` blocks are illustrative, not real.
  let inFence = false;
  lines.forEach((line, idx) => {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    // Strip inline code spans (`...`) so example links inside them are ignored.
    const stripped = line.replace(/`[^`]*`/g, m => ' '.repeat(m.length));

    let match;
    LINK_RE.lastIndex = 0;
    while ((match = LINK_RE.exec(stripped)) !== null) {
      const raw = match[1].trim();
      // Skip external + mailto + anchor-only + absolute (we only check relative).
      if (/^(https?:|mailto:|tel:|#)/i.test(raw)) continue;
      if (raw.startsWith('/')) continue; // absolute paths — Obsidian-style root, skip
      // Strip anchor and query.
      const cleaned = raw.split('#')[0].split('?')[0];
      if (!cleaned) continue;
      const target = path.resolve(path.dirname(absPath), cleaned);
      if (!fs.existsSync(target)) {
        errors.push({
          line: idx + 1,
          col: match.index + 1,
          link: raw,
          resolved: target,
        });
      }
    }
  });

  return errors;
}

function main() {
  const files = walk(ROOT);
  let totalErrors = 0;
  let filesWithErrors = 0;

  for (const f of files) {
    const errs = checkFile(f);
    if (errs.length === 0) continue;
    filesWithErrors += 1;
    totalErrors += errs.length;
    const rel = path.relative(ROOT, f);
    console.error(`\n${rel}:`);
    for (const e of errs) {
      console.error(`  L${e.line}:C${e.col}  ${e.link}`);
      if (!QUIET) console.error(`             → ${path.relative(ROOT, e.resolved)} (missing)`);
    }
  }

  if (totalErrors === 0) {
    if (!QUIET) console.log(`docs:check  ${files.length} files scanned, 0 broken links`);
    process.exit(0);
  }

  console.error(`\ndocs:check  FAILED  ${totalErrors} broken link(s) in ${filesWithErrors} file(s)`);
  process.exit(1);
}

main();
