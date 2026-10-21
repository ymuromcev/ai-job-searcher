// Weekly report (RFC 068 §10): applications.tsv rows + a reference date →
// stats for the last 7 days and cumulative, with breakdowns.
//
// Pure. Three layers, each usable on its own:
//   buildWeeklyReport(rows, refDate)  → numbers (JSON, used by tests + API)
//   weeklyTables(report)              → the same numbers as titled tables of
//                                       display strings (Russian labels) —
//                                       the one place the wording lives, shared
//                                       by the board tab and the HTML page
//   renderWeeklyHtml(report, opts)    → a self-contained, plain HTML page
//
// "Week" = the 7 calendar days ending on `refDate` inclusive. A row belongs to
// the week when its `applied_date` falls in that window; its outcome is its
// status today (a cohort view: "what happened to what we sent this week").

const { isApplied, parseReason, atsFromUrl, APPLIED_BY_LABELS } = require("./registry_view.js");
const { isRemoteLoc } = require("./geo_enforcer.js");
const { botBankStats } = require("./answer_bank.js");

const RESPONSE_STATUSES = new Set(["Rejected", "Interview", "Offer"]);
const INTERVIEW_STATUSES = new Set(["Interview", "Offer"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const UNKNOWN = "неизвестно";

function str(v) {
  return v === undefined || v === null ? "" : String(v);
}

// "YYYY-MM-DD" (or a longer ISO string) → UTC day number; NaN when invalid.
function dayNumber(value) {
  const m = str(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return NaN;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

function isoFromDayNumber(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function normalizeRefDate(refDate) {
  if (refDate instanceof Date) {
    const y = refDate.getFullYear();
    const m = String(refDate.getMonth() + 1).padStart(2, "0");
    const d = String(refDate.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = str(refDate).slice(0, 10);
  if (Number.isNaN(dayNumber(s))) throw new Error(`invalid reference date: ${refDate}`);
  return s;
}

// --- buckets ---------------------------------------------------------------

const CA_CITIES = [
  "san francisco",
  "los angeles",
  "san diego",
  "san jose",
  "sacramento",
  "oakland",
  "palo alto",
  "mountain view",
  "sunnyvale",
  "santa clara",
  "menlo park",
  "redwood city",
  "irvine",
  "santa monica",
  "berkeley",
  "cupertino",
  "pasadena",
  "fremont",
  "roseville",
  "bay area",
];

function isCaLocation(loc) {
  const raw = str(loc);
  if (/\bCA\b/.test(raw)) return true;
  const lower = raw.toLowerCase();
  if (lower.includes("california")) return true;
  return CA_CITIES.some((c) => lower.includes(c));
}

// CA wins over remote ("San Francisco, CA or Remote" is a CA job for us).
function geoBucket(locations) {
  const list = Array.isArray(locations) ? locations : locations ? [locations] : [];
  if (list.some(isCaLocation)) return "ca";
  if (list.some((l) => isRemoteLoc(str(l).toLowerCase()))) return "remote";
  return "other";
}

const GEO_ORDER = ["ca", "remote", "other"];
const GEO_LABELS = { ca: "Калифорния", remote: "удалённо", other: "другое" };

const AGE_ORDER = ["0-3", "4-14", "15-30", "31+", "unknown"];
const AGE_LABELS = {
  "0-3": "0–3 дня",
  "4-14": "4–14 дней",
  "15-30": "15–30 дней",
  "31+": "31+ день",
  unknown: UNKNOWN,
};

// Days between discovery (`createdAt`) and application (`applied_date`).
function ageBucket(row) {
  const applied = dayNumber(row.applied_date);
  const created = dayNumber(row.createdAt);
  if (Number.isNaN(applied) || Number.isNaN(created)) return "unknown";
  const days = applied - created;
  if (days < 0) return "unknown";
  if (days <= 3) return "0-3";
  if (days <= 14) return "4-14";
  if (days <= 30) return "15-30";
  return "31+";
}

const FIT_ORDER = ["Strong", "Medium", "Weak", ""];
const APPLIED_BY_ORDER = ["bot", "manual", "legacy_bot", ""];

function resumeBucket(row) {
  const v = str(row.resume_ver).trim();
  if (!v) return "";
  if (v.startsWith("resumes/tailored/") || v.includes("/tailored/")) return "tailored";
  return v;
}

const DIMENSIONS = [
  {
    id: "fit_score",
    title: "По оценке",
    keyOf: (r) => str(r.fit_score),
    label: (k) => k || "без оценки",
    order: FIT_ORDER,
  },
  {
    id: "resume",
    title: "По резюме (архетип)",
    keyOf: resumeBucket,
    label: (k) => (k === "tailored" ? "тейлоренное" : k || "не указано"),
  },
  {
    id: "source",
    title: "По источнику",
    keyOf: (r) => str(r.source),
    label: (k) => k || UNKNOWN,
  },
  {
    id: "ats",
    title: "По сайту подачи (ATS)",
    keyOf: (r) => atsFromUrl(r.url),
    label: (k) => k || UNKNOWN,
  },
  {
    id: "geo",
    title: "По географии",
    keyOf: (r) => geoBucket(r.locations),
    label: (k) => GEO_LABELS[k] || k,
    order: GEO_ORDER,
  },
  {
    id: "age",
    title: "По возрасту вакансии на момент подачи",
    keyOf: ageBucket,
    label: (k) => AGE_LABELS[k] || k,
    order: AGE_ORDER,
  },
  {
    id: "applied_by",
    title: "Кто подал",
    keyOf: (r) => str(r.applied_by),
    label: (k) => APPLIED_BY_LABELS[k] || "не отмечено",
    order: APPLIED_BY_ORDER,
  },
];

// --- stats -----------------------------------------------------------------

function rate(num, den) {
  return den > 0 ? num / den : null;
}

function counts(rows) {
  let responses = 0;
  let interviews = 0;
  let offers = 0;
  let rejections = 0;
  for (const r of rows) {
    const s = str(r.status);
    if (RESPONSE_STATUSES.has(s)) responses++;
    if (INTERVIEW_STATUSES.has(s)) interviews++;
    if (s === "Offer") offers++;
    if (s === "Rejected") rejections++;
  }
  return {
    applied: rows.length,
    responses,
    interviews,
    offers,
    rejections,
    waiting: rows.length - responses,
    responseRate: rate(responses, rows.length),
  };
}

function breakdown(rows, dim) {
  const groups = new Map();
  for (const r of rows) {
    const k = dim.keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [...groups.entries()].map(([key, list]) => ({
    key,
    label: dim.label(key),
    ...counts(list),
  }));
  if (dim.order) {
    const pos = (k) => {
      const i = dim.order.indexOf(k);
      return i === -1 ? dim.order.length : i;
    };
    out.sort((a, b) => pos(a.key) - pos(b.key) || a.label.localeCompare(b.label));
  } else {
    out.sort((a, b) => b.applied - a.applied || a.label.localeCompare(b.label));
  }
  return out;
}

function periodStats(rows) {
  const by = {};
  for (const dim of DIMENSIONS) by[dim.id] = breakdown(rows, dim);
  return { ...counts(rows), by };
}

function reasonKey(note) {
  const r = parseReason(note);
  if (!r.label) return { key: "", label: "причина не указана" };
  if (r.code === "unsupported_ats") return { key: `unsupported_ats:${r.detail}`, label: r.label };
  if (r.code && r.detail) {
    // Group "no_confirmation: x" and "no_confirmation: y" together.
    const base = parseReason(r.code).label;
    return { key: r.code, label: base };
  }
  return { key: r.code || r.label, label: r.label };
}

function topReasons(rows, limit = 10) {
  const groups = new Map();
  for (const r of rows) {
    const { key, label } = reasonKey(r.apply_note);
    const g = groups.get(key) || { key, label, count: 0 };
    g.count++;
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

// --- nightly runs (BL-225) -------------------------------------------------

const STOP_REASON_LABELS = {
  deadline: "время вышло",
  target_reached: "цель достигнута",
  queue_empty: "подавать больше нечего",
  usage_budget: "лимит подписки",
  abandoned: "оборвалась",
  scan_failed: "скан упал",
  prepare_failed: "подготовка упала",
  apply_failed: "подача упала",
  locked: "уже шла другая ночь",
};

function localDayIso(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return normalizeRefDate(d);
}

function localClock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Night entries (night_runs_log.parseNightLines) whose start falls in the
// week, by the local calendar day the night started on.
function nightsInWindow(nights, start, end) {
  return (Array.isArray(nights) ? nights : [])
    .filter((n) => {
      const day = dayNumber(localDayIso(n.started_at));
      return !Number.isNaN(day) && day >= start && day <= end;
    })
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
}

function sumNights(list) {
  const keys = ["scanned", "prepared", "strong", "medium", "queued", "submitted"];
  const more = ["manual", "failed", "deferred"];
  const out = { nights: list.length };
  for (const k of keys.concat(more)) out[k] = list.reduce((s, n) => s + (Number(n[k]) || 0), 0);
  return out;
}

// Local calendar day of a bank answer: a bare "YYYY-MM-DD" (local backups)
// as is, an ISO timestamp (Notion created_time) in local time.
function bankDay(value) {
  const s = str(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return localDayIso(s);
}

// opts.nights: parsed apply_runs.jsonl entries. Absent → the report has no
// `nights` block (callers that do not read the log, older tests).
// opts.bank: { entries, ratings } — the answer bank and the owner's ratings.
// Absent → no `bank` block.
function buildWeeklyReport(rows, refDate, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const ref = normalizeRefDate(refDate);
  const end = dayNumber(ref);
  const start = end - 6;
  const inWeek = (value) => {
    const n = dayNumber(value);
    return !Number.isNaN(n) && n >= start && n <= end;
  };

  const applied = list.filter(isApplied);
  const appliedThisWeek = applied.filter((r) => inWeek(r.applied_date));

  const todo = list.filter((r) => {
    const s = str(r.apply_state);
    return s === "manual" || s === "failed";
  });

  const report = {
    refDate: ref,
    weekStart: isoFromDayNumber(start),
    week: periodStats(appliedThisWeek),
    total: periodStats(applied),
    reasons: {
      open: topReasons(todo),
      week: topReasons(todo.filter((r) => inWeek(r.updatedAt))),
    },
  };
  if (opts && opts.nights !== undefined) {
    const week = nightsInWindow(opts.nights, start, end);
    report.nights = { list: week, sum: sumNights(week) };
  }
  if (opts && opts.bank) {
    const { entries, ratings } = opts.bank;
    report.bank = {
      week: botBankStats(entries, ratings, (e) => inWeek(bankDay(e.createdAt))),
      total: botBankStats(entries, ratings),
    };
  }
  return report;
}

function nightsTable(nights) {
  const rows = nights.list.map((n) => [
    ruDate(localDayIso(n.started_at)),
    `${localClock(n.started_at)}–${n.finished_at ? localClock(n.finished_at) : "—"}`,
    String(n.scanned),
    `${n.prepared} (${n.strong} / ${n.medium})`,
    String(n.queued),
    `${n.submitted} из ${n.target}`,
    String(n.manual),
    String(n.failed),
    String(n.deferred),
    STOP_REASON_LABELS[n.stop_reason] || n.stop_reason,
  ]);
  const s = nights.sum;
  if (nights.list.length > 1) {
    rows.push([
      "Итого",
      `${s.nights} ноч.`,
      String(s.scanned),
      `${s.prepared} (${s.strong} / ${s.medium})`,
      String(s.queued),
      String(s.submitted),
      String(s.manual),
      String(s.failed),
      String(s.deferred),
      "",
    ]);
  }
  return {
    title: "Ночные запуски",
    note:
      "Одна строка — одна ночь. Подготовлено: все оценённые (из них Strong / Medium). " +
      "В очереди — сколько анкет бот открыл; перенесено — не успел до утра, подаст следующей ночью.",
    columns: [
      "Ночь",
      "Время",
      "Найдено",
      "Подготовлено",
      "В очереди",
      "Подано",
      "Руками",
      "Ошибки",
      "Перенесено",
      "Остановилась",
    ],
    rows,
    empty: "За неделю ночных запусков не было",
  };
}

// --- presentation ----------------------------------------------------------

function pct(value) {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

function ruDate(iso) {
  const m = str(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : str(iso);
}

function bankCell(b) {
  if (!b.added) return "0";
  const avg = b.average === null ? "—" : String(b.average).replace(".", ",");
  return `${b.added} (с оценкой ${b.rated}, без оценки ${b.unrated}, средняя ${avg})`;
}

function weeklyTables(report) {
  const w = report.week;
  const t = report.total;
  const weekCaption = `${ruDate(report.weekStart)} – ${ruDate(report.refDate)}`;
  const tables = [];

  tables.push({
    title: "Итоги",
    note: "Неделя — заявки, поданные за эти 7 дней, и что с ними сейчас.",
    columns: ["", `За неделю (${weekCaption})`, "Всего"],
    rows: [
      ["Подано", String(w.applied), String(t.applied)],
      ["Ответили (отказ, интервью, оффер)", String(w.responses), String(t.responses)],
      ["Интервью (вместе с офферами)", String(w.interviews), String(t.interviews)],
      ["Офферы", String(w.offers), String(t.offers)],
      ["Отказы", String(w.rejections), String(t.rejections)],
      ["Пока без ответа", String(w.waiting), String(t.waiting)],
      ["Доля ответов", pct(w.responseRate), pct(t.responseRate)],
      ...(report.bank
        ? [
            [
              "Ответы бота, сохранённые в банк",
              bankCell(report.bank.week),
              bankCell(report.bank.total),
            ],
          ]
        : []),
    ],
    empty: "",
  });

  if (report.nights) tables.push(nightsTable(report.nights));

  for (const dim of DIMENSIONS) {
    const weekBy = new Map(w.by[dim.id].map((e) => [e.key, e]));
    const rows = t.by[dim.id].map((e) => {
      const we = weekBy.get(e.key);
      return [
        e.label,
        String(we ? we.applied : 0),
        String(we ? we.responses : 0),
        String(e.applied),
        String(e.responses),
        String(e.interviews),
        pct(e.responseRate),
      ];
    });
    tables.push({
      title: dim.title,
      columns: [
        "",
        "Неделя: подано",
        "Неделя: ответы",
        "Всего: подано",
        "Всего: ответы",
        "Всего: интервью",
        "Доля ответов (всего)",
      ],
      rows,
      empty: "Пока ни одного отклика",
    });
  }

  const weekReasons = new Map(report.reasons.week.map((r) => [r.key, r.count]));
  tables.push({
    title: "Частые причины «доделать руками»",
    columns: ["Причина", "Ждут сейчас", "Из них за неделю"],
    rows: report.reasons.open.map((r) => [
      r.label,
      String(r.count),
      String(weekReasons.get(r.key) || 0),
    ]),
    empty: "Ничего не ждёт ручной подачи",
  });

  return tables;
}

function escapeHtml(s) {
  return str(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Plain wireframe styling — same look as the board (engine/ui/board/style.css).
const REPORT_CSS = `
body { background: #fff; color: #000; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 14px; margin: 16px; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 24px; }
table { border-collapse: collapse; margin: 8px 0; }
th, td { border: 1px solid #000; padding: 4px 8px; text-align: left; vertical-align: top; }
p.note { margin: 4px 0; }
`;

function renderWeeklyHtml(report, { profileId = "", generatedAt = "" } = {}) {
  const parts = [];
  parts.push("<!doctype html>");
  parts.push('<html lang="ru"><head><meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  parts.push(`<title>Неделя — ${escapeHtml(profileId)} — ${escapeHtml(report.refDate)}</title>`);
  parts.push(`<style>${REPORT_CSS}</style></head><body>`);
  parts.push(
    `<h1>Отклики за неделю — ${escapeHtml(profileId)}, ${escapeHtml(ruDate(report.weekStart))} – ${escapeHtml(ruDate(report.refDate))}</h1>`
  );
  if (generatedAt) parts.push(`<p class="note">Собрано: ${escapeHtml(generatedAt)}</p>`);
  for (const table of weeklyTables(report)) {
    parts.push(`<h2>${escapeHtml(table.title)}</h2>`);
    if (table.note) parts.push(`<p class="note">${escapeHtml(table.note)}</p>`);
    if (table.rows.length === 0) {
      parts.push(`<p>${escapeHtml(table.empty)}</p>`);
      continue;
    }
    parts.push("<table><thead><tr>");
    for (const c of table.columns) parts.push(`<th>${escapeHtml(c)}</th>`);
    parts.push("</tr></thead><tbody>");
    for (const row of table.rows) {
      parts.push("<tr>");
      for (const cell of row) parts.push(`<td>${escapeHtml(cell)}</td>`);
      parts.push("</tr>");
    }
    parts.push("</tbody></table>");
  }
  parts.push("</body></html>");
  return parts.join("\n") + "\n";
}

module.exports = {
  buildWeeklyReport,
  weeklyTables,
  renderWeeklyHtml,
  geoBucket,
  ageBucket,
  dayNumber,
  escapeHtml,
  DIMENSIONS,
};
