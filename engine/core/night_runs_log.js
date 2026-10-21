// Night run log (RFC 068 §9 / §10, BL-225).
//
// Every nightly run appends ONE JSON line to
// profiles/<id>/.health/apply_runs.jsonl when it finishes (`night --phase
// finish`), or when the next night finds it abandoned:
//
//   {"started_at": ISO, "finished_at": ISO, "target": 100,
//    "scanned": n, "prepared": n, "strong": n, "medium": n, "weak": n,
//    "queued": n, "submitted": n, "manual": n, "failed": n, "deferred": n,
//    "apply_rounds": n, "stop_reason": "deadline" | "target_reached" | …}
//
// Same shape of module as scan_health_log.js (scan_runs.jsonl): pure
// build / parse / prune + small read / append. The file is bounded (lines
// older than MAX_AGE_DAYS are dropped on write); a torn line is skipped by
// the reader, never fatal. The weekly report and the board "Неделя" tab read
// it through `readNightRuns`.

const fs = require("fs");
const path = require("path");

const HEALTH_DIR = ".health";
const NIGHT_RUNS_FILE = "apply_runs.jsonl";
const MAX_AGE_DAYS = 180;
const MAX_REASON_LEN = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

const COUNT_FIELDS = [
  "target",
  "scanned",
  "prepared",
  "strong",
  "medium",
  "weak",
  "queued",
  "submitted",
  "manual",
  "failed",
  "deferred",
  "apply_rounds",
];

function nightRunsPath(profileRoot) {
  return path.join(profileRoot, HEALTH_DIR, NIGHT_RUNS_FILE);
}

function count(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function reason(v) {
  const s = String(v || "unknown")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return s.length > MAX_REASON_LEN ? `${s.slice(0, MAX_REASON_LEN - 1)}…` : s || "unknown";
}

// tsv: countTsvSince(...) result; apply: summarizeApplyFiles(...) result.
function buildNightEntry({ startedAt, finishedAt, target, tsv, apply, stopReason }) {
  const t = tsv || { scanned: 0, prepared: {} };
  const p = t.prepared || {};
  const a = apply || {};
  return {
    started_at: String(startedAt),
    finished_at: String(finishedAt),
    target: count(target),
    scanned: count(t.scanned),
    prepared: count(p.total),
    strong: count(p.strong),
    medium: count(p.medium),
    weak: count(p.weak),
    queued: count(a.queued),
    submitted: count(a.submitted),
    manual: count(a.manual),
    failed: count(a.failed),
    deferred: count(a.deferred),
    apply_rounds: count(a.applyRounds),
    stop_reason: reason(stopReason),
  };
}

function isValidEntry(e) {
  return (
    e &&
    typeof e === "object" &&
    typeof e.started_at === "string" &&
    !Number.isNaN(Date.parse(e.started_at))
  );
}

function parseNightLines(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!isValidEntry(e)) continue;
      const clean = {
        started_at: e.started_at,
        finished_at: typeof e.finished_at === "string" ? e.finished_at : "",
        stop_reason: reason(e.stop_reason),
      };
      for (const f of COUNT_FIELDS) clean[f] = count(e[f]);
      out.push(clean);
    } catch {
      // Skip a torn / hand-edited line.
    }
  }
  return out;
}

function pruneEntries(entries, nowMs, maxAgeDays = MAX_AGE_DAYS) {
  const cutoff = nowMs - maxAgeDays * DAY_MS;
  return entries.filter((e) => Date.parse(e.started_at) >= cutoff);
}

function readNightRuns(filePath) {
  try {
    return parseNightLines(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

function appendNightRun(filePath, entry, { now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const kept = pruneEntries(readNightRuns(filePath), nowMs);
  const all = kept.concat([entry]);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, all.map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.renameSync(tmp, filePath);
  return { path: filePath, kept: kept.length };
}

module.exports = {
  nightRunsPath,
  buildNightEntry,
  parseNightLines,
  pruneEntries,
  readNightRuns,
  appendNightRun,
  COUNT_FIELDS,
  MAX_AGE_DAYS,
  NIGHT_RUNS_FILE,
};
