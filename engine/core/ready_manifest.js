// Ready manifests + submit window (RFC 069 §1 / §2, BL-225). Pure.
//
// The night prepares (scan, fit, tailoring, answers, truth review) and ends
// each apply round with `night --phase ready`, which writes one manifest:
//
//   profiles/<id>/.apply-state/ready/<stamp>.json
//   { "stamp": "...", "answers_dir": "...", "deadline": "ISO",
//     "rows": ["<key>", ...], "created_at": "ISO" }
//
// `submit-ready` (started by launchd every 15 min) picks manifests up in
// stamp order and submits their rows — inside the submit window only
// (`apply_window`, default 02:00-11:00 local) and never past the manifest's
// deadline. Nothing here touches the filesystem or the clock.
//
//   buildManifest(fields)          → manifest object (the contract above)
//   parseManifest(raw)             → { manifest, problems[] }
//   isManifestName(name)           → true for "<stamp>.json" (not tmp / hidden)
//   orderManifestNames(names)      → manifest file names in submit order
//   parseWindow(text)              → { start, end, text } (minutes of the day)
//   windowState(now, window)       → { open, closesAt, lastClose, lastCloseDate }
//   localDate(d)                   → "YYYY-MM-DD" in local time

const DEFAULT_WINDOW = "02:00-11:00";

function str(v) {
  return v === undefined || v === null ? "" : String(v);
}

function buildManifest({ stamp, answersDir, deadline, rows, createdAt }) {
  const keys = [];
  const seen = new Set();
  for (const k of rows || []) {
    const key = str(k).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return {
    stamp: str(stamp),
    answers_dir: str(answersDir),
    deadline: str(deadline),
    rows: keys,
    created_at: str(createdAt),
  };
}

function parseManifest(raw) {
  const problems = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { manifest: null, problems: ["not a JSON object"] };
  }
  if (!str(raw.stamp).trim()) problems.push("stamp missing");
  if (!str(raw.answers_dir).trim()) problems.push("answers_dir missing");
  if (!Number.isFinite(Date.parse(str(raw.deadline)))) problems.push("deadline is not ISO");
  if (!Array.isArray(raw.rows)) problems.push("rows must be an array");
  if (problems.length) return { manifest: null, problems };
  return {
    manifest: buildManifest({
      stamp: raw.stamp,
      answersDir: raw.answers_dir,
      deadline: raw.deadline,
      rows: raw.rows,
      createdAt: raw.created_at,
    }),
    problems,
  };
}

// "<stamp>.json" only: the atomic writer's "<name>.tmp.<pid>.<ts>" and
// hidden files never count as manifests.
function isManifestName(name) {
  const n = str(name);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(n) && !n.includes(".tmp.");
}

// Stamps are ISO-derived ("2026-11-10T03-15-00-000Z"), so name order is
// creation order.
function orderManifestNames(names) {
  return (names || []).filter(isManifestName).sort();
}

function parseClockMinutes(text) {
  const m = str(text)
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// "02:00-11:00" → { start: 120, end: 660 }. A window may wrap midnight
// ("22:00-06:00"). Start and end must differ.
function parseWindow(text) {
  const raw = str(text).trim() || DEFAULT_WINDOW;
  const parts = raw.split("-");
  const start = parts.length === 2 ? parseClockMinutes(parts[0]) : null;
  const end = parts.length === 2 ? parseClockMinutes(parts[1]) : null;
  if (start === null || end === null || start === end) {
    throw new Error(`invalid apply_window "${raw}" — expected HH:MM-HH:MM (local time)`);
  }
  return { start, end, text: raw };
}

function atMinute(day, minute, addDays = 0) {
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate() + addDays,
    Math.floor(minute / 60),
    minute % 60,
    0,
    0
  );
}

// open:          now is inside the window
// closesAt:      the next close strictly after now (end of the current window)
// lastClose:     the most recent close at or before now
// lastCloseDate: local date of lastClose — the "morning" it belongs to
function windowState(now, window) {
  const w = typeof window === "string" || !window ? parseWindow(window) : window;
  const d = now instanceof Date ? now : new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  const open = w.start < w.end ? m >= w.start && m < w.end : m >= w.start || m < w.end;
  const closesAt = m < w.end ? atMinute(d, w.end) : atMinute(d, w.end, 1);
  const lastClose = m >= w.end ? atMinute(d, w.end) : atMinute(d, w.end, -1);
  return { open, closesAt, lastClose, lastCloseDate: localDate(lastClose), minutesOfDay: m };
}

function localDate(d) {
  const x = d instanceof Date ? d : new Date(d);
  const pad = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

// The earliest of the manifest deadline and the window close: the ISO the
// submit run gets as --deadline.
function effectiveDeadline(manifest, state) {
  const d = Date.parse(str(manifest && manifest.deadline));
  const close = state.closesAt.getTime();
  return new Date(Number.isFinite(d) ? Math.min(d, close) : close);
}

module.exports = {
  buildManifest,
  parseManifest,
  isManifestName,
  orderManifestNames,
  parseWindow,
  windowState,
  localDate,
  effectiveDeadline,
  DEFAULT_WINDOW,
};
