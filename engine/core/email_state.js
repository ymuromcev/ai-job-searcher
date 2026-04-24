// State persistence for check command:
// - processed_messages.json  — seen Gmail message ids (pruned > MAX_DAYS).
// - check_context.json       — handoff file between --prepare and --apply.
// - raw_emails.json          — written by Claude (MCP) between phases.
//
// Ported from ../../Job Search/check_emails.js:289-302, 726-745 (prototype).

const fs = require("fs");
const path = require("path");

const MAX_DAYS = 30;

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadProcessed(filePath) {
  if (!fs.existsSync(filePath)) return { processed: [], last_check: null };
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return { processed: [], last_check: null };
  return JSON.parse(raw);
}

// Adds new ids (dedup by id), bumps last_check, prunes > MAX_DAYS.
function saveProcessed(filePath, existing, newEntries, now = new Date()) {
  const data = {
    processed: Array.isArray(existing?.processed) ? [...existing.processed] : [],
    last_check: existing?.last_check || null,
  };
  const seen = new Set(data.processed.map((e) => e.id));
  for (const e of newEntries || []) {
    if (!seen.has(e.id)) {
      data.processed.push(e);
      seen.add(e.id);
    }
  }
  const cutoff = new Date(now.getTime() - MAX_DAYS * 86400 * 1000);
  data.processed = data.processed.filter(
    (e) => new Date(e.date || 0) >= cutoff
  );
  data.last_check = now.toISOString();
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return data;
}

// Computes the cursor epoch (in seconds) for Gmail queries.
// Default: max(last_check, now - MAX_DAYS).
// With `sinceIso` override, clamp also to MAX_DAYS lower bound.
function computeCursorEpoch({ lastCheck, sinceIso, now = new Date() }) {
  const maxDaysAgo = Math.floor(now.getTime() / 1000) - MAX_DAYS * 86400;
  if (sinceIso) {
    const ep = Math.floor(new Date(sinceIso).getTime() / 1000);
    return Math.max(ep, maxDaysAgo);
  }
  if (lastCheck) {
    const ep = Math.floor(new Date(lastCheck).getTime() / 1000);
    return Math.max(ep, maxDaysAgo);
  }
  return maxDaysAgo;
}

function loadContext(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveContext(filePath, context) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(context, null, 2));
}

function loadRawEmails(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return [];
  return JSON.parse(raw);
}

module.exports = {
  MAX_DAYS,
  loadProcessed,
  saveProcessed,
  computeCursorEpoch,
  loadContext,
  saveContext,
  loadRawEmails,
};
