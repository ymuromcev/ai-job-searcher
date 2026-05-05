#!/usr/bin/env node
// scripts/migrate_backlog_to_files.js
//
// One-shot migration of BACKLOG.md → per-item files under private/backlog/.
// Default: dry-run. Pass --apply to write files. Idempotent — never overwrites
// without warning.
//
// Usage:
//   node scripts/migrate_backlog_to_files.js [--apply] [--source <path>] [--dest <dir>]

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SOURCE = 'BACKLOG.md';
const DEFAULT_DEST = 'private/backlog/';
const DEFAULT_CREATED = '2026-05-05';

function parseArgs(argv) {
  const args = { apply: false, source: DEFAULT_SOURCE, dest: DEFAULT_DEST };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--dest') args.dest = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/migrate_backlog_to_files.js [--apply] [--source <path>] [--dest <dir>]');
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

// --- ID + title extraction ---

// Match an id token in a heading. Forms recognised:
//   BL-6, BL-6.1, BL #8, BL#8, BL 8, G-29, RFC-012, #1, #8.1
const ID_PATTERNS = [
  /\bBL[-\s#]*(\d+(?:\.\d+)?)\b/i,  // BL-6, BL #8, BL 8, BL-6.1
  /\bG[-\s]*(\d+)\b/,                // G-29
  /\bRFC[-\s]*(\d{1,3})\b/i,         // RFC-012
];

// Standalone #N — only when whole heading is "#N — Title"
const HASH_ID = /^#(\d+(?:\.\d+)?)\b/;

function extractId(headingText) {
  // Strip leading markdown #s already done by caller
  const txt = headingText.trim();

  // Try BL / G / RFC patterns
  for (const re of ID_PATTERNS) {
    const m = txt.match(re);
    if (m) {
      const num = m[1];
      const prefix = re.source.startsWith('\\bBL') ? 'BL'
        : re.source.startsWith('\\bG') ? 'G'
        : 'RFC';
      // Normalize RFC to 3-digit zero-pad
      if (prefix === 'RFC') return `RFC-${num.padStart(3, '0')}`;
      return `${prefix}-${num}`;
    }
  }
  // Fallback: heading starts with #N
  const hm = txt.match(HASH_ID);
  if (hm) return `BL-${hm[1]}`;

  return null;
}

function extractTitle(headingText) {
  // Drop id token + emojis + dash separators, leave human title.
  let t = headingText.trim();

  // Remove leading id phrase up to em-dash / colon / hyphen separator
  // Common forms:
  //   "BL-6: Documentation pass" → "Documentation pass"
  //   "BL #8 (Lilia healthcare ATS research)" → "Lilia healthcare ATS research"
  //   "G-29 — fly.io cron deploy" → "fly.io cron deploy"
  //   "#1 (next) — RFC 012: Relational data model" → "RFC 012: Relational data model"
  //   "RFC 012: Relational data model" → "Relational data model"

  // Drop leading id token(s)
  t = t.replace(/^#?\d+(?:\.\d+)?\s*/, '');             // leading #N
  t = t.replace(/^BL[-\s#]*\d+(?:\.\d+)?\s*/i, '');     // BL-N / BL #N
  t = t.replace(/^G[-\s]*\d+\s*/, '');                  // G-N
  t = t.replace(/^RFC[-\s]*\d{1,3}[:\s]*/i, '');        // RFC-NNN

  // Drop emojis (basic stripping for the icons used in this file)
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu, '').trim();

  // Drop parenthetical priority/state markers that are id-adjacent
  t = t.replace(/^\((?:next|now|later|done|archive|архив)\)\s*/i, '');

  // Drop leading separator chars
  t = t.replace(/^[—–\-:·\s]+/, '').trim();

  // If a colon remained ("RFC 012: Relational data model" path), keep the rhs
  // only when it's not a one-word noun like "DONE".
  return t;
}

// Crude Cyrillic → Latin transliteration so RU-titled clusters get readable slugs.
const CYR_MAP = {
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',
  м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',
  щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
};

function translitCyrillic(s) {
  return s.replace(/[а-яё]/gi, (ch) => {
    const lower = ch.toLowerCase();
    return CYR_MAP[lower] || '';
  });
}

function slugify(title) {
  if (!title) return 'untitled';
  return translitCyrillic(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')           // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60) || 'untitled';
}

// --- Heading scan ---

function isHandoff(headingText) {
  const t = headingText.toLowerCase();
  return /handoff/.test(t)
    || /next session/i.test(headingText)
    || /старый handoff/i.test(headingText)
    || /🚀/.test(headingText);
}

function isArchiveHeader(headingText) {
  // Top-level archive section header (its children are archived items, not item itself)
  const t = headingText.toLowerCase().trim();
  // Note: \b doesn't match Cyrillic word boundaries in JS regex, so use plain anchors
  return /^закрыто(\s|$|\W)/.test(t) || /^archive(\s|$|\W)/.test(t);
}

function isQueueHeader(headingText) {
  // "Активная очередь" / "Active queue" — parent of #1, #2, … items.
  // Body before first child should NOT be emitted as own item (it's a TOC).
  const t = headingText.toLowerCase();
  return /активн(ая|ой|ую)\s+очеред/.test(t) || /^active\s+queue/.test(t);
}

function looksArchived(headingText, body) {
  const blob = (headingText + '\n' + body).toLowerCase();
  if (/\bdone\b/.test(blob)) return true;
  if (/✅/.test(blob)) return true;
  if (/recently closed/i.test(blob)) return true;
  if (/closed\s+\d{4}-\d{2}-\d{2}/i.test(blob)) return true;
  if (/^\s*~~/.test(headingText)) return true; // strikethrough heading
  if (/\barchived\b/.test(blob) && !/\barchived\b.*\bnot\b/.test(blob)) return true;
  return false;
}

function extractCreated(body) {
  // Look for first ISO date in body
  const m = body.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return m ? m[1] : DEFAULT_CREATED;
}

function extractPriority(body) {
  const m = body.match(/\b(P[0-3])\b/);
  return m ? m[1] : 'P2';
}

function extractTier(body) {
  // Match "Тир: M" / "Tier: L" / "tier M-L" — take first letter of L/M/S/XS
  const m = body.match(/\b(?:тир|tier)\s*[:=\-—]?\s*(XS|S|M|L)\b/i);
  return m ? m[1].toUpperCase() : 'M';
}

// --- Main parse loop ---

function parseBacklog(text) {
  const lines = text.split(/\r?\n/);
  const items = [];        // collected items
  const skipped = [];      // {reason, heading}

  // Find heading lines (## or ###)
  const headings = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,4})\s+(.*\S)\s*$/);
    if (m) headings.push({ line: i, level: m[1].length, text: m[2] });
  }

  // Skip preamble: anything before first heading is dropped automatically
  // (no item created without a heading anchor).

  // For each heading, body = lines until next heading of equal-or-higher level.
  // Track ranges already absorbed into a parent so we don't re-emit children.
  let absorbUntilLine = -1;
  for (let h = 0; h < headings.length; h++) {
    const cur = headings[h];
    if (cur.line < absorbUntilLine) continue; // inside a parent's inline body
    let endLine = lines.length;
    let firstIdChildLine = lines.length;
    let firstChildLine = lines.length;
    for (let h2 = h + 1; h2 < headings.length; h2++) {
      if (headings[h2].level <= cur.level) {
        endLine = headings[h2].line;
        break;
      }
      if (firstChildLine === lines.length) firstChildLine = headings[h2].line;
      // Only children with an extractable id (or top-level queue siblings) are
      // treated as separate items — id-less sub-headings (`#### Recommendation`)
      // stay inline as part of parent body.
      if (firstIdChildLine === lines.length && extractId(headings[h2].text)) {
        firstIdChildLine = headings[h2].line;
      }
    }
    // Body: cut at the first id-bearing child (siblings get their own files).
    // Id-less sub-headings are kept inline.
    const bodyEnd = Math.min(firstIdChildLine, endLine);
    const body = lines.slice(cur.line + 1, bodyEnd).join('\n').trim();
    const hasChildren = firstChildLine < endLine;
    const hasIdChildren = firstIdChildLine < endLine;

    // Skip handoffs entirely (and all their sub-headings, which we still
    // see in the heading list — filter by walking forward and skipping any
    // child headings inside this range).
    if (cur.level === 2 && isHandoff(cur.text)) {
      skipped.push({ reason: 'handoff', heading: cur.text });
      // Walk forward, skip every heading until next ## of equal level
      while (h + 1 < headings.length && headings[h + 1].line < endLine) h++;
      continue;
    }

    // Skip archive section header itself; treat its children as archived items
    if (cur.level === 2 && isArchiveHeader(cur.text)) {
      skipped.push({ reason: 'archive-header', heading: cur.text });
      continue;
    }

    // Skip queue parent header (its #N children are the actual items)
    if (cur.level === 2 && isQueueHeader(cur.text) && hasIdChildren) {
      skipped.push({ reason: 'queue-parent', heading: cur.text });
      continue;
    }

    // Skip parents whose body is empty AND have id-bearing children — pure container.
    if (!body && hasIdChildren) {
      skipped.push({ reason: 'container-no-body', heading: cur.text });
      continue;
    }

    // Skip empty bodies (purely organizational headers, no children)
    if (!body) {
      skipped.push({ reason: 'empty-body', heading: cur.text });
      continue;
    }

    // Skip headings that are sub-children of handoffs (handled above) —
    // we already advanced h past them.

    // Skip top-level "category" headings whose body is just bullet lists of
    // independent items (e.g. "## Архитектура"). These are wall-of-text
    // sections; they would yield giant single files. Detect: level 2, body
    // starts with "- **YYYY-MM-DD**" pattern → mark as cluster, still emit
    // (one file per cluster), but flag it.
    let isCluster = false;
    if (cur.level === 2 && /^\s*-\s+\*\*\d{4}-\d{2}-\d{2}\*\*/m.test(body)) {
      isCluster = true;
    }

    // Determine id
    let id = extractId(cur.text);
    let isMalformed = false;
    if (!id) {
      // For cluster-style topic sections without an id, synthesize one from slug
      if (cur.level === 2) {
        id = `BL-topic-${slugify(extractTitle(cur.text))}`;
      } else {
        skipped.push({ reason: 'no-id', heading: cur.text });
        isMalformed = true;
        continue;
      }
    }
    if (isMalformed) continue;

    const title = extractTitle(cur.text) || cur.text;
    const status = looksArchived(cur.text, body) ? 'archived' : 'planned';
    const created = extractCreated(body);
    const priority = extractPriority(body);
    const tier = extractTier(body);

    items.push({
      id,
      title,
      slug: slugify(title),
      status,
      priority,
      tier,
      created,
      body,
      headingLevel: cur.level,
      cluster: isCluster,
    });
    // Mark sub-headings between parent and first id-bearing child as absorbed.
    if (firstChildLine < firstIdChildLine) {
      absorbUntilLine = bodyEnd;
    }
  }

  // Dedup id+slug collisions by appending -2, -3, …
  const seen = new Map();
  for (const it of items) {
    const key = `${it.id}-${it.slug}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1) {
      it.id = `${it.id}-${n}`;
    }
  }

  return { items, skipped };
}

function renderFile(item) {
  const fm = [
    '---',
    `id: ${item.id}`,
    `title: ${item.title.replace(/"/g, '\\"')}`,
    `status: ${item.status}`,
    `priority: ${item.priority}`,
    `tier: ${item.tier}`,
    `created: ${item.created}`,
    'refs: []',
    'tags: []',
    '---',
    '',
    item.body,
    '',
  ].join('\n');
  return fm;
}

function targetPath(destDir, item) {
  // For synthetic topic ids the id already encodes the slug; avoid duplicating.
  const base = item.id.startsWith('BL-topic-') ? item.id : `${item.id}-${item.slug}`;
  return path.join(destDir, `${base}.md`);
}

// --- Main ---

function main() {
  const args = parseArgs(process.argv);
  const root = process.cwd();
  const sourcePath = path.resolve(root, args.source);
  const destDir = path.resolve(root, args.dest);

  if (!fs.existsSync(sourcePath)) {
    console.error(`Source not found: ${sourcePath}`);
    process.exit(1);
  }
  const text = fs.readFileSync(sourcePath, 'utf8');
  const { items, skipped } = parseBacklog(text);

  // Tally + plan
  const existing = [];
  const toWrite = [];
  for (const it of items) {
    const p = targetPath(destDir, it);
    const content = renderFile(it);
    const exists = fs.existsSync(p);
    if (exists) {
      const cur = fs.readFileSync(p, 'utf8');
      if (cur !== content) existing.push({ item: it, path: p, differs: true, content });
      else existing.push({ item: it, path: p, differs: false });
    } else {
      toWrite.push({ item: it, path: p, content });
    }
  }

  const archived = items.filter((i) => i.status === 'archived').length;

  // Plan output
  console.log('=== migrate_backlog_to_files — plan ===');
  console.log(`source: ${path.relative(root, sourcePath)}`);
  console.log(`dest:   ${path.relative(root, destDir)}/`);
  console.log(`mode:   ${args.apply ? 'APPLY' : 'dry-run'}`);
  console.log('');
  console.log(`Detected items:           ${items.length}`);
  console.log(`  archived:               ${archived}`);
  console.log(`  planned:                ${items.length - archived}`);
  console.log(`Skipped:                  ${skipped.length}`);
  for (const s of skipped) console.log(`  - [${s.reason}] ${s.heading}`);
  console.log('');
  console.log(`Targets new (will write): ${toWrite.length}`);
  console.log(`Targets already exist:    ${existing.length}`);
  console.log(`  identical content:      ${existing.filter((e) => !e.differs).length}`);
  console.log(`  differing content:      ${existing.filter((e) => e.differs).length}`);
  console.log('');
  console.log('--- Items ---');
  for (const it of items) {
    const p = targetPath(destDir, it);
    const rel = path.relative(root, p);
    const bytes = renderFile(it).length;
    const flag = it.cluster ? ' [CLUSTER]' : '';
    const stat = it.status === 'archived' ? '[archived]' : '[planned ]';
    console.log(`  ${stat} ${it.id.padEnd(26)} ${it.title.slice(0, 60).padEnd(60)} → ${rel} (${bytes}B)${flag}`);
  }

  if (existing.some((e) => e.differs)) {
    console.log('');
    console.log('!!! WARNING: targets already exist with differing content:');
    for (const e of existing.filter((e) => e.differs)) {
      console.log(`  ${path.relative(root, e.path)}`);
    }
  }

  if (!args.apply) {
    console.log('');
    console.log('(dry-run; rerun with --apply to write files)');
    return;
  }

  // Apply
  fs.mkdirSync(destDir, { recursive: true });
  let written = 0;
  let skippedExisting = 0;
  for (const w of toWrite) {
    fs.writeFileSync(w.path, w.content, 'utf8');
    written++;
  }
  for (const e of existing) {
    if (e.differs) {
      console.warn(`SKIP (exists, content differs): ${path.relative(root, e.path)}`);
      skippedExisting++;
    } else {
      skippedExisting++;
    }
  }
  console.log('');
  console.log(`Wrote: ${written}, skipped (existing): ${skippedExisting}`);
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error(e.stack || e.message);
    process.exit(1);
  }
}

module.exports = { parseBacklog, extractId, extractTitle, slugify, renderFile };
