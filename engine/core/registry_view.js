// Registry view (RFC 068 §8): applications.tsv rows → view models for the
// local read-only board.
//
// Pure: takes the row objects `applications_tsv.load()` returns and builds
// plain JSON for the page. TSV v8 fields (`applied_by`, `apply_state`,
// `apply_note`) may be absent on older files — every read treats a missing
// field as "".
//
// Labels are Russian because the board's reader is the candidate; code and
// keys stay English.

// Statuses that mean "the application went out" (plus the outcomes that can
// only follow an application).
const POST_APPLY_STATUSES = ["Applied", "Interview", "Offer", "Rejected", "No Response", "Closed"];

const STATUS_LABELS = {
  Inbox: "входящие",
  "To Apply": "к подаче",
  Applied: "подано",
  Interview: "интервью",
  Offer: "оффер",
  Rejected: "отказ",
  "No Response": "нет ответа",
  Closed: "вакансия закрыта",
  Archived: "в архиве",
};

const APPLIED_BY_LABELS = {
  bot: "бот",
  manual: "сам",
  legacy_bot: "старый бот",
};
const APPLIED_BY_NONE = "—";

const APPLY_STATE_LABELS = {
  queued: "в очереди",
  manual: "руками",
  failed: "ошибка",
  submitted: "подано",
};

// Reason codes written to `apply_note` by the apply step (RFC 068 §1).
// Unknown codes are shown raw — never hidden.
const REASON_LABELS = {
  captcha: "капча",
  login_required: "нужен вход в аккаунт",
  account_required: "нужно завести аккаунт",
  no_honest_answer: "нет честного ответа на вопрос формы",
  no_confirmation: "после отправки нет подтверждения",
  unexpected_screen: "непредвиденный экран",
  required_field_missing: "не заполнилось обязательное поле",
  form_changed: "форма изменилась",
  url_dead: "вакансия больше не открывается",
  timeout: "форма не загрузилась",
};

// Reasons that are about the candidate's side (an account, a human check, an
// honest-answer gate), not about the site adapter misbehaving.
const NON_TECHNICAL_REASONS = new Set([
  "captcha",
  "login_required",
  "account_required",
  "no_honest_answer",
  "unsupported_ats",
]);

function str(v) {
  return v === undefined || v === null ? "" : String(v);
}

// Parse an `apply_note` into { code, detail, label }.
//   "captcha"                       → code=captcha
//   "unsupported_ats:jobs.example"  → code=unsupported_ats, detail=host
//   "no_confirmation: page stayed"  → code=no_confirmation, detail=…
//   "something else"                → code="", label = raw text
function parseReason(note) {
  const raw = str(note).trim();
  if (!raw) return { code: "", detail: "", label: "" };
  const unsupported = raw.match(/^unsupported_ats:\s*(\S+)/);
  if (unsupported) {
    const host = unsupported[1];
    return {
      code: "unsupported_ats",
      detail: host,
      label: `сайт подачи не поддерживается: ${host}`,
    };
  }
  const m = raw.match(/^([a-z][a-z0-9_]*)(?:\s*[:—-]\s*(.*))?$/);
  if (m && Object.prototype.hasOwnProperty.call(REASON_LABELS, m[1])) {
    const detail = str(m[2]).trim();
    const base = REASON_LABELS[m[1]];
    return { code: m[1], detail, label: detail ? `${base} (${detail})` : base };
  }
  return { code: m ? m[1] : "", detail: "", label: raw };
}

function isTechnicalReason(code) {
  return !NON_TECHNICAL_REASONS.has(code);
}

// Host of a URL without "www.", or "" when the URL does not parse.
function hostOf(url) {
  const raw = str(url).trim();
  if (!raw) return "";
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ATS behind a URL: a friendly name for the known ones, else the bare host.
const ATS_HOST_RULES = [
  [/(^|\.)greenhouse\.io$/, "Greenhouse"],
  [/(^|\.)lever\.co$/, "Lever"],
  [/(^|\.)ashbyhq\.com$/, "Ashby"],
  [/(^|\.)myworkdayjobs\.com$/, "Workday"],
  [/(^|\.)myworkdaysite\.com$/, "Workday"],
  [/(^|\.)smartrecruiters\.com$/, "SmartRecruiters"],
  [/(^|\.)icims\.com$/, "iCIMS"],
  [/(^|\.)oraclecloud\.com$/, "Oracle Cloud"],
  [/(^|\.)taleo\.net$/, "Taleo"],
  [/(^|\.)workable\.com$/, "Workable"],
  [/(^|\.)ultipro\.com$/, "UltiPro"],
  [/(^|\.)ukg\.net$/, "UltiPro"],
  [/(^|\.)adzuna\.com$/, "Adzuna"],
  [/(^|\.)themuse\.com$/, "The Muse"],
  [/(^|\.)remoteok\.(com|io)$/, "RemoteOK"],
  [/(^|\.)usajobs\.gov$/, "USAJOBS"],
  [/(^|\.)calcareers\.ca\.gov$/, "CalCareers"],
  [/(^|\.)indeed\.com$/, "Indeed"],
  [/(^|\.)linkedin\.com$/, "LinkedIn"],
];

function atsFromUrl(url) {
  const host = hostOf(url);
  if (!host) return "";
  for (const [re, name] of ATS_HOST_RULES) {
    if (re.test(host)) return name;
  }
  return host;
}

function isApplied(row) {
  return POST_APPLY_STATUSES.includes(str(row.status)) || str(row.applied_date) !== "";
}

function appliedByLabel(value) {
  return APPLIED_BY_LABELS[str(value)] || APPLIED_BY_NONE;
}

function statusLabel(status) {
  return STATUS_LABELS[str(status)] || str(status);
}

function responseRow(row) {
  const appliedBy = str(row.applied_by);
  return {
    key: str(row.key),
    company: str(row.companyName),
    title: str(row.title),
    applied_date: str(row.applied_date),
    applied_by: appliedBy,
    applied_by_label: appliedByLabel(appliedBy),
    status: str(row.status),
    status_label: statusLabel(row.status),
    fit_score: str(row.fit_score),
    url: str(row.url),
    updatedAt: str(row.updatedAt),
  };
}

// Newest application first; rows without a date sink to the bottom, ties by
// last update then company name — deterministic for tests and for the page.
function compareResponses(a, b) {
  if (a.applied_date !== b.applied_date) {
    if (!a.applied_date) return 1;
    if (!b.applied_date) return -1;
    return a.applied_date < b.applied_date ? 1 : -1;
  }
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.company.localeCompare(b.company);
}

function todoRow(row) {
  const state = str(row.apply_state);
  const reason = parseReason(row.apply_note);
  return {
    key: str(row.key),
    company: str(row.companyName),
    title: str(row.title),
    apply_state: state,
    apply_state_label: APPLY_STATE_LABELS[state] || state,
    reason_code: reason.code,
    reason: reason.label || "причина не указана",
    url: str(row.url),
    updatedAt: str(row.updatedAt),
  };
}

function buildSummary(responses, rows) {
  const byAppliedBy = { bot: 0, manual: 0, legacy_bot: 0, unknown: 0 };
  const byStatus = {};
  for (const r of responses) {
    if (Object.prototype.hasOwnProperty.call(byAppliedBy, r.applied_by))
      byAppliedBy[r.applied_by]++;
    else byAppliedBy.unknown++;
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }
  let manual = 0;
  let failed = 0;
  let queued = 0;
  for (const row of rows) {
    const s = str(row.apply_state);
    if (s === "manual") manual++;
    else if (s === "failed") failed++;
    else if (s === "queued") queued++;
  }
  return {
    applied: responses.length,
    byAppliedBy,
    byStatus,
    interviews: (byStatus.Interview || 0) + (byStatus.Offer || 0),
    offers: byStatus.Offer || 0,
    rejected: byStatus.Rejected || 0,
    todo: manual + failed,
    manual,
    failed,
    queued,
  };
}

function buildRegistryView(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const responses = list.filter(isApplied).map(responseRow).sort(compareResponses);
  const todo = list
    .filter((r) => {
      const s = str(r.apply_state);
      return s === "manual" || s === "failed";
    })
    .map(todoRow)
    .sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
      return a.company.localeCompare(b.company);
    });
  return { responses, todo, summary: buildSummary(responses, list) };
}

module.exports = {
  buildRegistryView,
  parseReason,
  isTechnicalReason,
  isApplied,
  atsFromUrl,
  hostOf,
  appliedByLabel,
  statusLabel,
  POST_APPLY_STATUSES,
  STATUS_LABELS,
  APPLIED_BY_LABELS,
  APPLY_STATE_LABELS,
  REASON_LABELS,
};
