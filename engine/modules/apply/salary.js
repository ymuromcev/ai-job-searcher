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
// Amounts are returned as plain digit strings ("180000") because many ATS
// salary inputs validate as numbers; ranges as "120000-150000".

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

function normalizeConfig(salaryCfg) {
  const cfg = salaryCfg || {};
  const floor =
    Number.isFinite(Number(cfg.floor)) && Number(cfg.floor) > 0 ? Number(cfg.floor) : DEFAULT_FLOOR;
  const def =
    Number.isFinite(Number(cfg.default)) && Number(cfg.default) > 0
      ? Number(cfg.default)
      : DEFAULT_SALARY;
  return { floor, default: def, currency: cfg.currency || "USD" };
}

// range: {min, max} | null (published). salaryCfg: applyDefaults.salary.
// Returns { value, low, high, source, belowFloor }.
//   value — single desired amount (number)
//   low/high — range answer (numbers)
//   source — "published_range" | "default"
function computeDesiredSalary({ range, salaryCfg } = {}) {
  const cfg = normalizeConfig(salaryCfg);
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
  DEFAULT_FLOOR,
  DEFAULT_SALARY,
};
