// Scan health log (RFC 068 §8, «Источники и сайты подачи» tab).
//
// `scan` appends one JSON line per discovery source to
// profiles/<id>/.health/scan_runs.jsonl:
//   {"ts": ISO, "source": "<adapter key>", "found": <n>, "error": "<msg>" | null}
//
// The file is bounded: on every write, lines older than MAX_AGE_DAYS are
// dropped. Readers are tolerant — a malformed line is skipped, never fatal.
//
// Pure helpers (buildRunEntries, pruneEntries, parseRunLines) + two small
// side-effectful functions (readScanRuns, appendScanRuns). The scan command
// wraps the append in try/catch: the log must never fail a scan.

const fs = require("fs");
const path = require("path");

const HEALTH_DIR = ".health";
const SCAN_RUNS_FILE = "scan_runs.jsonl";
const MAX_AGE_DAYS = 60;
const MAX_ERROR_LEN = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

function scanRunsPath(profileRoot) {
  return path.join(profileRoot, HEALTH_DIR, SCAN_RUNS_FILE);
}

// result.summary from engine/core/scan.js → log entries. `redact` masks
// secrets that an HTTP client may have echoed into an error message.
function buildRunEntries(summary, ts, redact = (s) => s) {
  const out = [];
  for (const [source, info] of Object.entries(summary || {})) {
    const total = info && Number.isFinite(info.total) ? info.total : 0;
    let error = info && info.error ? String(redact(String(info.error))) : null;
    if (error && error.length > MAX_ERROR_LEN) error = `${error.slice(0, MAX_ERROR_LEN - 1)}…`;
    out.push({ ts, source, found: total, error });
  }
  return out;
}

function isValidEntry(e) {
  return (
    e &&
    typeof e === "object" &&
    typeof e.ts === "string" &&
    !Number.isNaN(Date.parse(e.ts)) &&
    typeof e.source === "string" &&
    e.source.length > 0
  );
}

function parseRunLines(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (isValidEntry(e)) {
        out.push({
          ts: e.ts,
          source: e.source,
          found: Number.isFinite(e.found) ? e.found : 0,
          error: e.error ? String(e.error) : null,
        });
      }
    } catch {
      // Skip a torn / hand-edited line.
    }
  }
  return out;
}

function pruneEntries(entries, nowMs, maxAgeDays = MAX_AGE_DAYS) {
  const cutoff = nowMs - maxAgeDays * DAY_MS;
  return entries.filter((e) => Date.parse(e.ts) >= cutoff);
}

function readScanRuns(filePath) {
  try {
    return parseRunLines(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

// Read existing lines, drop the old ones, add the new ones, write atomically.
function appendScanRuns(filePath, newEntries, { now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const kept = pruneEntries(readScanRuns(filePath), nowMs);
  const all = kept.concat(newEntries || []);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, all.map((e) => JSON.stringify(e)).join("\n") + (all.length ? "\n" : ""));
  fs.renameSync(tmp, filePath);
  return { path: filePath, kept: kept.length, added: (newEntries || []).length };
}

module.exports = {
  scanRunsPath,
  buildRunEntries,
  parseRunLines,
  pruneEntries,
  readScanRuns,
  appendScanRuns,
  MAX_AGE_DAYS,
  HEALTH_DIR,
  SCAN_RUNS_FILE,
};
