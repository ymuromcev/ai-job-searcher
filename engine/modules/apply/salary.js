// Desired-salary rule for application forms (RFC 068 §4a). Pure.
//
//   - Published range → the top of the range, never below the floor.
//   - Form asks for a range → the published range, low bound raised to the
//     floor (high bound too, if the whole range sits under the floor).
//   - No published range → the profile default.
//   - Published top below the floor → the job should not be applied to at
//     all; `computeDesiredSalary` reports `belowFloor: true` so the caller
//     can skip it (prepare enforces the same gate earlier).
//
// Channel (BL-243, RFC 072): `salary.by_channel[channel] = { floor, default }`
// overrides the general floor / default for a company of that channel (the
// RU-friendly LatAm pool: floor and default 80000). Amounts quoted in another
// currency or per month ("$45,000 - $60,000 MXN mensuales") are not annual USD
// ranges and are dropped: no range -> the channel default.
//
// Amounts are returned as plain digit strings ("180000") because many ATS
// salary inputs validate as numbers; ranges as "120000-150000".

const { isNonUsdOrMonthlyContext } = require("../../core/salary_context.js");

const DEFAULT_FLOOR = 120000;
const DEFAULT_SALARY = 180000;

// Plausible annual amounts only — hourly rates and equity percentages would
// otherwise parse as tiny "ranges".
const MIN_ANNUAL = 20000;
const MAX_ANNUAL = 2000000;

const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?\s?[kK]|\d{5,7})`;
const RANGE_RE = new RegExp(
  String.raw`\$\s?${AMOUNT}\s*(?:USD)?\s*(?:[-–—]|to)\s*(?:USD\s*)?\$?\s?${AMOUNT}`,
  "g"
);
const HOURLY_RE = /^\s*(?:\/|per\s+)\s*(?:hr|hour)\b|^\s*hourly\b/i;

function parseAmount(raw) {
  const s = String(raw || "")
    .replace(/,/g, "")
    .trim();
  if (!s) return null;
  const k = /k$/i.test(s);
  const n = parseFloat(s.replace(/k$/i, "").trim());
  if (!Number.isFinite(n)) return null;
  return Math.round(k ? n * 1000 : n);
}

// Find the first annual salary range in free text ("$150,000 - $200,000",
// "$150K–$200K", "$150,000 USD to $200,000 USD"). Returns {min, max} or null.
function parsePublishedRange(text) {
  const s = String(text || "");
  RANGE_RE.lastIndex = 0;
  let m;
  while ((m = RANGE_RE.exec(s))) {
    const tail = s.slice(m.index + m[0].length, m.index + m[0].length + 12);
    if (HOURLY_RE.test(tail)) continue;
    if (isNonUsdOrMonthlyContext(s, m.index, m.index + m[0].length)) continue;
    const a = parseAmount(m[1]);
    const b = parseAmount(m[2]);
    if (a == null || b == null) continue;
    const min = Math.min(a, b);
    const max = Math.max(a, b);
    if (min < MIN_ANNUAL || max > MAX_ANNUAL) continue;
    return { min, max };
  }
  return null;
}

function positive(v) {
  return Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
}

// `channel` (optional): overlay `salaryCfg.by_channel[channel]` — each present
// key (floor / default) replaces the general one; the rest stays general.
function normalizeConfig(salaryCfg, channel) {
  const cfg = salaryCfg || {};
  const byChannel =
    channel &&
    cfg.by_channel &&
    typeof cfg.by_channel === "object" &&
    Object.prototype.hasOwnProperty.call(cfg.by_channel, channel) &&
    cfg.by_channel[channel] &&
    typeof cfg.by_channel[channel] === "object"
      ? cfg.by_channel[channel]
      : {};
  const floor = positive(byChannel.floor) || positive(cfg.floor) || DEFAULT_FLOOR;
  const def = positive(byChannel.default) || positive(cfg.default) || DEFAULT_SALARY;
  return { floor, default: def, currency: cfg.currency || "USD" };
}

// range: {min, max} | null (published). salaryCfg: applyDefaults.salary.
// channel: company channel ("" / undefined = none) -> salary.by_channel overlay.
// Returns { value, low, high, source, belowFloor }.
//   value — single desired amount (number)
//   low/high — range answer (numbers)
//   source — "published_range" | "default"
function computeDesiredSalary({ range, salaryCfg, channel } = {}) {
  const cfg = normalizeConfig(salaryCfg, channel);
  if (range && Number.isFinite(range.max) && range.max > 0) {
    const max = range.max;
    const min = Number.isFinite(range.min) && range.min > 0 ? range.min : max;
    const high = Math.max(max, cfg.floor);
    const low = Math.min(Math.max(min, cfg.floor), high);
    return {
      value: high,
      low,
      high,
      source: "published_range",
      belowFloor: max < cfg.floor,
    };
  }
  return {
    value: cfg.default,
    low: cfg.default,
    high: cfg.default,
    source: "default",
    belowFloor: false,
  };
}

// Text answer for a salary question. `wantsRange` when the label asks for a
// range ("salary range", "min and max").
function salaryAnswer(desired, { wantsRange = false } = {}) {
  if (!desired) return "";
  if (wantsRange && desired.low !== desired.high) return `${desired.low}-${desired.high}`;
  return String(desired.value);
}

module.exports = {
  parsePublishedRange,
  computeDesiredSalary,
  salaryAnswer,
  parseAmount,
  normalizeConfig,
  DEFAULT_FLOOR,
  DEFAULT_SALARY,
};
