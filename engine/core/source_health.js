// Source health (RFC 068 §8, board tab «Источники и сайты подачи»).
//
// Pure. Two tables, each row with a plain-Russian status:
//   a) job sources — from scan_runs.jsonl entries (engine/core/scan_health_log.js)
//      plus the profile's enabled `modules`, so a configured source with no
//      runs still shows up;
//   b) application sites — derived from applications.tsv v8 rows
//      (`apply_state`, `apply_note`, host of `url`). No separate log.
//
// `now` is injected (Date or ISO string) so every branch is testable.

const {
  parseReason,
  isTechnicalReason,
  hostOf,
  atsFromUrl,
  isApplied,
} = require("./registry_view.js");

const DAY_MS = 24 * 60 * 60 * 1000;

// --- job sources -----------------------------------------------------------

const SOURCE_NAMES = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  workday: "Workday",
  smartrecruiters: "SmartRecruiters",
  icims: "iCIMS",
  oracle_cloud: "Oracle Cloud",
  taleo: "Taleo",
  workable: "Workable",
  ultipro: "UltiPro",
  adzuna: "Adzuna",
  the_muse: "The Muse",
  remoteok: "RemoteOK",
  usajobs: "USAJOBS",
  calcareers: "CalCareers",
  indeed: "Indeed",
  jobsyn: "Jobsyn",
};

const SOURCE_STATUS = {
  broken: "Не работает",
  flaky: "Сбоит",
  stale: "Давно не запускался",
  empty: "Работает, но вакансий нет",
  never: "Ещё не запускался",
  ok: "Работает",
};

// Worst first — the owner reads the top of the table.
const SOURCE_ORDER = ["broken", "flaky", "stale", "empty", "never", "ok"];

const STALE_DAYS = 3;
const WINDOW_DAYS = 7;
const MAX_ERROR_SHOWN = 120;

function toMs(now) {
  if (now instanceof Date) return now.getTime();
  const ms = Date.parse(now);
  if (Number.isNaN(ms)) throw new Error(`invalid "now": ${now}`);
  return ms;
}

function sourceName(key) {
  return SOURCE_NAMES[key] || key;
}

function modulesToSourceKeys(modules) {
  const out = [];
  if (!Array.isArray(modules)) return out;
  for (const m of modules) {
    if (typeof m !== "string") continue;
    const [kind, name] = m.split(":");
    if (kind === "discovery" && name) out.push(name.toLowerCase());
  }
  return out;
}

function shortError(msg) {
  const s = String(msg || "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > MAX_ERROR_SHOWN ? `${s.slice(0, MAX_ERROR_SHOWN - 1)}…` : s;
}

// runs: newest first.
function sourceStatus(runs, nowMs) {
  if (runs.length === 0) return "never";
  const latest = runs[0];
  if (nowMs - Date.parse(latest.ts) > STALE_DAYS * DAY_MS) return "stale";
  const last3 = runs.slice(0, 3);
  const errors = last3.filter((r) => r.error).length;
  if (errors === last3.length) return "broken";
  if (errors > 0) return "flaky";
  const recent = runs.filter((r) => nowMs - Date.parse(r.ts) <= WINDOW_DAYS * DAY_MS);
  if (recent.length > 0 && recent.every((r) => !r.error && r.found === 0)) return "empty";
  return "ok";
}

function buildSourceRows(runs, modules, nowMs) {
  const bySource = new Map();
  for (const key of modulesToSourceKeys(modules)) bySource.set(key, []);
  for (const r of runs || []) {
    if (!r || typeof r.source !== "string" || Number.isNaN(Date.parse(r.ts))) continue;
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source).push(r);
  }
  const rows = [];
  for (const [key, list] of bySource) {
    list.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    const status = sourceStatus(list, nowMs);
    const recent = list.filter((r) => nowMs - Date.parse(r.ts) <= WINDOW_DAYS * DAY_MS);
    const lastError = list.slice(0, 3).find((r) => r.error);
    rows.push({
      key,
      name: sourceName(key),
      status,
      status_label: SOURCE_STATUS[status],
      last_run: list.length ? list[0].ts.slice(0, 10) : "",
      found_7d: recent.reduce((sum, r) => sum + (Number.isFinite(r.found) ? r.found : 0), 0),
      last_error: lastError ? shortError(lastError.error) : "",
    });
  }
  rows.sort(
    (a, b) =>
      SOURCE_ORDER.indexOf(a.status) - SOURCE_ORDER.indexOf(b.status) ||
      a.name.localeCompare(b.name)
  );
  return rows;
}

// --- application sites -----------------------------------------------------

const SUPPORTED_SITES = ["Greenhouse", "Lever", "Ashby"];

const SITE_STATUS = {
  broken: "Не работает",
  flaky: "Сбоит",
  ok: "Работает",
  idle: "Давно не подавал",
  none: "Пока не подавал",
  unsupported: "Не поддерживается — подаёшь руками",
};

const ATTEMPT_STATES = new Set(["submitted", "failed", "manual"]);
const LAST_N = 20;
const BROKEN_N = 5;
const FLAKY_SHARE = 0.2;

function str(v) {
  return v === undefined || v === null ? "" : String(v);
}

// When the attempt happened: the application date for a submission, else the
// last update of the row (the apply step stamps it when it writes the state).
function attemptMs(row) {
  const s = str(row.apply_state);
  const v = s === "submitted" && row.applied_date ? row.applied_date : row.updatedAt;
  const ms = Date.parse(str(v));
  return Number.isNaN(ms) ? 0 : ms;
}

function topReasonLabel(attempts) {
  const counts = new Map();
  for (const a of attempts) {
    if (a.apply_state === "submitted") continue;
    const r = parseReason(a.apply_note);
    const label = r.code && r.code !== "unsupported_ats" ? parseReason(r.code).label : r.label;
    const key = label || "причина не указана";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [label, n] of counts) {
    if (n > bestN || (n === bestN && label.localeCompare(best) < 0)) {
      best = label;
      bestN = n;
    }
  }
  return best;
}

function siteStatus(attempts, nowMs) {
  if (attempts.length === 0) return "none";
  const lastN = attempts.slice(0, LAST_N);
  const lastBroken = attempts.slice(0, BROKEN_N);
  const technicalFailure = (a) =>
    a.apply_state === "failed" ||
    (a.apply_state === "manual" && isTechnicalReason(parseReason(a.apply_note).code));
  if (lastBroken.every(technicalFailure)) return "broken";
  const failed = lastN.filter((a) => a.apply_state === "failed").length;
  if (failed / lastN.length >= FLAKY_SHARE) return "flaky";
  const submittedRecently = attempts.some(
    (a) => a.apply_state === "submitted" && nowMs - attemptMs(a) <= WINDOW_DAYS * DAY_MS
  );
  return submittedRecently ? "ok" : "idle";
}

function buildSiteRows(rows, nowMs) {
  const sites = new Map(); // name -> attempts[]
  for (const name of SUPPORTED_SITES) sites.set(name, []);
  const unsupported = new Map(); // host -> { waiting, applied7d }

  for (const row of rows || []) {
    const state = str(row.apply_state);
    const reason = parseReason(row.apply_note);
    if (reason.code === "unsupported_ats") {
      const host = reason.detail || hostOf(row.url) || "неизвестный сайт";
      const u = unsupported.get(host) || { waiting: 0, applied7d: 0 };
      if (state === "manual" && !isApplied(row)) u.waiting++;
      unsupported.set(host, u);
      continue;
    }
    if (!ATTEMPT_STATES.has(state)) continue;
    const site = atsFromUrl(row.url) || "неизвестный сайт";
    if (!sites.has(site)) sites.set(site, []);
    sites.get(site).push({ ...row, apply_state: state });
  }

  // Count hand-made applications on unsupported hosts (any row on that host
  // applied in the last 7 days).
  if (unsupported.size) {
    for (const row of rows || []) {
      const host = hostOf(row.url);
      if (!unsupported.has(host)) continue;
      const ms = Date.parse(str(row.applied_date));
      if (!Number.isNaN(ms) && nowMs - ms <= WINDOW_DAYS * DAY_MS && nowMs - ms >= -DAY_MS) {
        unsupported.get(host).applied7d++;
      }
    }
  }

  const out = [];
  for (const [name, list] of sites) {
    list.sort((a, b) => attemptMs(b) - attemptMs(a));
    const status = siteStatus(list, nowMs);
    const lastN = list.slice(0, LAST_N);
    out.push({
      name,
      supported: SUPPORTED_SITES.includes(name),
      status,
      status_label: SITE_STATUS[status],
      submitted_7d: list.filter(
        (a) => a.apply_state === "submitted" && nowMs - attemptMs(a) <= WINDOW_DAYS * DAY_MS
      ).length,
      errors_last20: lastN.filter((a) => a.apply_state === "failed").length,
      attempts_last20: lastN.length,
      top_reason: topReasonLabel(lastN),
      waiting: 0,
    });
  }
  const unsupportedRows = [...unsupported.entries()]
    .map(([host, u]) => ({
      name: host,
      supported: false,
      status: "unsupported",
      status_label: `${SITE_STATUS.unsupported} (ждут: ${u.waiting})`,
      submitted_7d: u.applied7d,
      errors_last20: 0,
      attempts_last20: 0,
      top_reason: "",
      waiting: u.waiting,
    }))
    .sort((a, b) => b.waiting - a.waiting || a.name.localeCompare(b.name));

  // Supported sites in fixed order, then other hosts the bot met, then the
  // unsupported ones.
  const supported = SUPPORTED_SITES.map((n) => out.find((r) => r.name === n));
  const others = out
    .filter((r) => !r.supported)
    .sort((a, b) => b.attempts_last20 - a.attempts_last20 || a.name.localeCompare(b.name));
  return supported.concat(others, unsupportedRows);
}

function buildSourceHealth({ runs = [], modules = [], rows = [], now = new Date() } = {}) {
  const nowMs = toMs(now);
  return {
    sources: buildSourceRows(runs, modules, nowMs),
    sites: buildSiteRows(rows, nowMs),
  };
}

module.exports = {
  buildSourceHealth,
  sourceName,
  SOURCE_NAMES,
  SOURCE_STATUS,
  SITE_STATUS,
  SUPPORTED_SITES,
};
