// Pure salary calculator — no I/O.
//
// Computes total-compensation expectations from Company Tier × Role Level.
//
// Per-profile config (L-1, 2026-05-04):
//   profile.salary.level_parser  ─ "pm" | "healthcare" | "default" or a custom fn
//   profile.salary.matrix        ─ { TIER: { LEVEL: {min,max,mid} } }
//   profile.salary.col_adjustment─ { multiplier, high_col_cities, exclude_format }
//
// When `salary` block is absent, defaults reproduce the previous behaviour
// (PM-tier Jared matrix + SF/NYC +7.5% unless Remote) so existing callers
// stay byte-identical.
//
// Exports:
//   parseLevel(title, parser?)         → string level
//   calcSalary(company, title, opts)   → SalaryResult | null
//   DEFAULT_SALARY_MATRIX
//   PARSERS

// --- PM (Jared, fintech) — default for back-compat --------------------------
function parseLevelPm(title) {
  const raw = String(title || "");
  const t = raw.toLowerCase().trim();
  if (/\blead\b/.test(t)) return "Lead";
  if (/\bsenior\b/.test(t) || /\bsr[\.\s]/.test(t)) return "Senior";
  // Capital One-style "Manager, Product Management" → Senior
  if (/^manager,?\s+product/i.test(raw)) return "Senior";
  return "PM";
}

// --- Healthcare (Lilia) — receptionist / coordinator ------------------------
function parseLevelHealthcare(title) {
  const t = String(title || "").toLowerCase().trim();
  // "Lead", "Supervisor", "Senior" → senior tier (rare for Lilia: blocklist
  // catches most managerial titles, but the level still exists in the matrix
  // for edge cases like "Senior Patient Services Rep").
  if (/\b(lead|supervisor|senior|sr\.?)\b/.test(t)) return "Senior";
  // "Coordinator" / "Specialist" — middle tier; Lilia targets several
  // (Authorization Coordinator, Care Management Coordinator, etc.)
  if (/\b(coordinator|specialist)\b/.test(t)) return "Coordinator";
  return "MedAdmin";
}

// --- Default — single row, useful for one-off profiles ---------------------
function parseLevelDefault(/* title */) {
  return "default";
}

const PARSERS = {
  pm: parseLevelPm,
  healthcare: parseLevelHealthcare,
  default: parseLevelDefault,
};

function resolveParser(parser) {
  if (typeof parser === "function") return parser;
  if (typeof parser === "string" && PARSERS[parser]) return PARSERS[parser];
  return PARSERS.pm; // back-compat default
}

function parseLevel(title, parser) {
  return resolveParser(parser)(title);
}

// --- Default matrix (Jared / fintech PM) ------------------------------------
const DEFAULT_SALARY_MATRIX = {
  // Tier S — public big-tech / top fintech, $10B+ market cap
  S: {
    PM:     { min: 180000, max: 230000, mid: 205000 },
    Senior: { min: 220000, max: 300000, mid: 260000 },
    Lead:   { min: 250000, max: 330000, mid: 290000 },
  },
  // Tier A — late-stage / public mid-cap, strong funding
  A: {
    PM:     { min: 160000, max: 200000, mid: 180000 },
    Senior: { min: 190000, max: 260000, mid: 225000 },
    Lead:   { min: 220000, max: 290000, mid: 255000 },
  },
  // Tier B — growth-stage, Series C-E, $1-5B valuation
  B: {
    PM:     { min: 140000, max: 180000, mid: 160000 },
    Senior: { min: 170000, max: 220000, mid: 195000 },
    Lead:   { min: 190000, max: 250000, mid: 220000 },
  },
  // Tier C — early/mid-stage, Series A-B, <$1B
  C: {
    PM:     { min: 120000, max: 160000, mid: 140000 },
    Senior: { min: 150000, max: 190000, mid: 170000 },
    Lead:   { min: 170000, max: 220000, mid: 195000 },
  },
};

const DEFAULT_COL_ADJUSTMENT = {
  multiplier: 1.075,
  high_col_cities: ["san francisco", "new york", "nyc"],
  exclude_format: ["Remote"],
};

function adjustedSalary(base, workFormat, city, colCfg) {
  const cfg = colCfg || DEFAULT_COL_ADJUSTMENT;
  const cities = Array.isArray(cfg.high_col_cities) ? cfg.high_col_cities : [];
  const excludeFmt = Array.isArray(cfg.exclude_format) ? cfg.exclude_format : [];
  const multiplier = typeof cfg.multiplier === "number" ? cfg.multiplier : 1.0;

  const c = String(city || "").toLowerCase();
  const isHighCOL = cities.some((needle) => c.includes(String(needle).toLowerCase()));
  const fmt = String(workFormat || "");
  const isExcluded = excludeFmt.includes(fmt);
  const m = isHighCOL && !isExcluded ? multiplier : 1.0;
  return {
    min: Math.round((base.min * m) / 1000) * 1000,
    max: Math.round((base.max * m) / 1000) * 1000,
    mid: Math.round((base.mid * m) / 1000) * 1000,
  };
}

// Returns SalaryResult or null when tier is unknown.
// SalaryResult: { tier, level, min, max, mid, expectation }
//
// opts:
//   companyTiers   — { [companyName]: "S"|"A"|"B"|"C" }
//   salaryMatrix   — overrides DEFAULT_SALARY_MATRIX (per-profile)
//   levelParser    — "pm" | "healthcare" | "default" | fn(title)
//   colAdjustment  — { multiplier, high_col_cities, exclude_format }
//   currency       — "USD" by default; passed through to expectation suffix
//   workFormat     — "Remote" | "Hybrid" | "Onsite"
//   city           — used by COL adjustment
function calcSalary(companyName, title, opts = {}) {
  const {
    companyTiers = {},
    salaryMatrix = DEFAULT_SALARY_MATRIX,
    levelParser = "pm",
    colAdjustment = DEFAULT_COL_ADJUSTMENT,
    currency = "USD",
    workFormat = "",
    city = "",
  } = opts;

  const tier = companyTiers[String(companyName || "")];
  if (!tier) return null;
  const tierRow = salaryMatrix[tier];
  if (!tierRow) return null;

  const level = parseLevel(title, levelParser);
  const base = tierRow[level];
  if (!base) return null;

  const { min, max, mid } = adjustedSalary(base, workFormat, city, colAdjustment);
  const symbol = currency === "USD" ? "$" : "";
  return {
    tier,
    level,
    min,
    max,
    mid,
    expectation: `${symbol}${min / 1000}-${max / 1000}K TC (midpoint ${symbol}${mid / 1000}K)`,
  };
}

module.exports = {
  parseLevel,
  parseLevelPm,
  parseLevelHealthcare,
  parseLevelDefault,
  calcSalary,
  DEFAULT_SALARY_MATRIX,
  DEFAULT_COL_ADJUSTMENT,
  PARSERS,
};
