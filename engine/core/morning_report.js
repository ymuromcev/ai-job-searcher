// Morning report (RFC 069 §7, BL-225). Pure.
//
// One file per morning: profiles/<id>/.health/morning-<YYYY-MM-DD>.json,
// written by `night --phase finish` and refreshed by `submit-ready` on its
// first run after the submit window closes (which also sends the one macOS
// notification). The board shows it at the top of its first tab. Results
// only — no questions for the owner.
//
//   {
//     "date": "2026-11-10", "since": ISO, "generated_at": ISO, "target": 30,
//     "submitted": { "total": n, "strong": n, "medium": n, "weak": n, "other": n },
//     "applications": [{ "key", "company", "title", "fit", "at": ISO,
//                        "confirmation": "email" | "page" }],
//     "skips": [{ "reason": "captcha", "count": 4 }, …],
//     "skip_line": "captcha 4 · required_empty 3",
//     "stop_reason": "deadline" | … | null, "night_running": bool,
//     "below_target": bool, "why_below_target": code | null, "why_text": "…" | null,
//     "warnings": ["submitter_not_running"], "warning_line": "отправка не запускалась",
//     "answers": { "resubmitted": n, "waiting": n, "view_url": "…" | null },  // RFC 070
//     "answers_line": "подано заново по твоим ответам: 2 · ждут твоего ответа: 3"
//   }
//
//   buildMorningReport(input)   → the object above
//   morningPath(root, date)     → profiles/<id>/.health/morning-<date>.json
//   notificationText(report)    → one line for the macOS notification
//   pickLatestMorning(names)    → newest "morning-<date>.json" name or null

const path = require("path");

const HEALTH_DIR = ".health";
const FIT_FIELD = { Strong: "strong", Medium: "medium", Weak: "weak" };
// Guard skips (deadline, target reached, already applied, an interrupted
// submit, a status change, the same job through another row) leave the row
// as it is — they are not skip reasons worth reporting.
const { isGuardSkip } = require("../modules/apply/skip_reasons.js");

// Warnings `night check` records for the night (.health/night_warnings.json).
const WARNING_TEXT = {
  submitter_not_running: "отправка не запускалась",
};

const WHY_TEXT = {
  deadline: "наступило время остановки",
  usage_budget: "закончился лимит Claude (90 %)",
  prepare_failed: "сломалась подготовка вакансий",
  apply_failed: "сломалось чтение форм",
  scan_failed: "сломался скан",
  abandoned: "ночная сессия оборвалась",
  target_reached: "цель достигнута",
  night_running: "ночь ещё идёт",
  no_night: "ночного запуска не было",
};

function str(v) {
  return v === undefined || v === null ? "" : String(v);
}

function morningPath(profileRoot, date) {
  return path.join(profileRoot, HEALTH_DIR, `morning-${date}.json`);
}

function pickLatestMorning(names) {
  const list = (names || []).filter((n) => /^morning-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  return list.length ? list[list.length - 1] : null;
}

function atOrAfter(iso, sinceMs) {
  const t = Date.parse(str(iso));
  return Number.isFinite(t) && (!Number.isFinite(sinceMs) || t >= sinceMs);
}

// input: {
//   date, since (ISO), now (Date), target,
//   apps: TSV rows (fit / company / title by key),
//   applyFiles: [{ kind: "pre" | "results", data }] — parsed .apply-state files,
//   night: { stop_reason, running } | null — tonight's night run, if any
//   questions: .apply-state/questions.json (RFC 070) | null — rows requeued
//     thanks to the owner's answers, questions still waiting for one
// }
function buildMorningReport(input) {
  const {
    date,
    since,
    now,
    target,
    apps = [],
    applyFiles = [],
    night = null,
    warnings: rawWarnings = [],
    questions = null,
  } = input;
  const warnings = [...new Set((rawWarnings || []).map(str).filter(Boolean))];
  const sinceMs = Date.parse(str(since));
  const byKey = new Map(apps.map((a) => [a.key, a]));

  // Files in time order, so the last word about a job wins.
  const files = applyFiles
    .filter((f) => f && f.data && !f.data.dry_run && atOrAfter(f.data.generated_at, sinceMs))
    .sort((a, b) => Date.parse(a.data.generated_at) - Date.parse(b.data.generated_at));

  const submitted = new Map();
  const lastReason = new Map();
  for (const f of files) {
    const d = f.data;
    if (f.kind === "pre") {
      for (const x of [].concat(d.manual || [], d.skipped || [])) {
        if (x && x.key && x.reason) lastReason.set(x.key, String(x.reason));
      }
      continue;
    }
    for (const r of Array.isArray(d.results) ? d.results : []) {
      if (!r || !r.key) continue;
      if (r.outcome === "submitted") {
        if (!submitted.has(r.key)) {
          submitted.set(r.key, {
            at: d.generated_at,
            confirmation: r.evidence && r.evidence.email ? "email" : "page",
            result: r,
          });
        }
        continue;
      }
      if (r.outcome === "dry_run") continue;
      lastReason.set(r.key, str(r.reason || r.outcome));
    }
  }

  const counts = { total: 0, strong: 0, medium: 0, weak: 0, other: 0 };
  const applications = [];
  for (const [key, s] of submitted) {
    const app = byKey.get(key) || {};
    const fit = str(app.fit_score);
    counts.total++;
    counts[FIT_FIELD[fit] || "other"]++;
    applications.push({
      key,
      company: str(app.companyName || s.result.company),
      title: str(app.title || s.result.title),
      fit: fit || null,
      at: s.at,
      confirmation: s.confirmation,
    });
  }
  applications.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const reasonCounts = new Map();
  for (const [key, reason] of lastReason) {
    if (submitted.has(key) || isGuardSkip(reason)) continue;
    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  }
  const skips = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const goal = Number.isFinite(Number(target)) && Number(target) > 0 ? Number(target) : 0;
  const stopReason = night && night.stop_reason ? str(night.stop_reason) : null;
  const running = Boolean(night && night.running);
  const below = goal > 0 && counts.total < goal;
  let why = null;
  if (below) why = running ? "night_running" : stopReason || (night ? "unknown" : "no_night");
  const answers = answersSummary(questions, submitted);
  return {
    date: str(date),
    since: str(since),
    generated_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    target: goal,
    submitted: counts,
    applications,
    skips,
    skip_line: skips.map((s) => `${s.reason} ${s.count}`).join(" · "),
    stop_reason: stopReason,
    night_running: running,
    below_target: below,
    why_below_target: why,
    why_text: why ? WHY_TEXT[why] || why : null,
    warnings,
    warning_line: warnings.map((w) => WARNING_TEXT[w] || w).join(" · "),
    answers,
    answers_line: answersLine(answers),
  };
}

// RFC 070: jobs submitted tonight that the owner's answers put back in the
// queue, and questions still waiting for his answer.
function answersSummary(questions, submitted) {
  const q = questions && typeof questions === "object" ? questions : {};
  const requeued = new Set(
    (Array.isArray(q.requeued) ? q.requeued : []).map((r) => r && str(r.key)).filter(Boolean)
  );
  let resubmitted = 0;
  for (const key of submitted.keys()) if (requeued.has(key)) resubmitted++;
  const waiting = Number.isInteger(q.waiting) && q.waiting > 0 ? q.waiting : 0;
  return { resubmitted, waiting, view_url: q.view_url ? str(q.view_url) : null };
}

function answersLine(a) {
  const parts = [];
  if (a.resubmitted) parts.push(`подано заново по твоим ответам: ${a.resubmitted}`);
  if (a.waiting) parts.push(`ждут твоего ответа: ${a.waiting}`);
  return parts.join(" · ");
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function notificationText(report) {
  const s = report.submitted || {};
  let text =
    `Подано ${s.total || 0} из ${report.target || 0} ` +
    `(Strong ${s.strong || 0} · Medium ${s.medium || 0} · Weak ${s.weak || 0})`;
  if (report.why_text) text += `. Меньше цели: ${report.why_text}`;
  if (report.skip_line) text += `. Пропуски: ${report.skip_line}`;
  if (report.answers_line) text += `. ${capitalize(report.answers_line)}`;
  if (report.warning_line) text += `. Внимание: ${report.warning_line}`;
  return text;
}

module.exports = {
  buildMorningReport,
  morningPath,
  notificationText,
  pickLatestMorning,
  WHY_TEXT,
  WARNING_TEXT,
  HEALTH_DIR,
};
