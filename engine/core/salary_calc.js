// Pure salary calculator — no I/O.
//
// Computes total-compensation expectations from Company Tier × Role Level.
// Company tiers are per-profile (pass via opts.companyTiers). The salary matrix
// defaults to the ranges in DEFAULT_SALARY_MATRIX but can be overridden.
//
// Exports:
//   parseLevel(title)           → 'PM' | 'Senior' | 'Lead'
//   calcSalary(company, title, opts) → SalaryResult | null
//   DEFAULT_SALARY_MATRIX

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

function parseLevel(title) {
  const t = String(title || "").toLowerCase().trim();
  if (/\blead\b/.test(t)) return "Lead";
  if (/\bsenior\b/.test(t) || /\bsr[\.\s]/.test(t)) return "Senior";
  // Capital One-style "Manager, Product Management" → Senior
  if (/^manager,?\s+product/i.test(String(title || ""))) return "Senior";
  return "PM";
}

function adjustedSalary(base, workFormat, city) {
  const c = String(city || "").toLowerCase();
  const isHighCOL =
    c.includes("san francisco") || c.includes("new york") || c.includes("nyc");
  const multiplier =
    isHighCOL && String(workFormat || "") !== "Remote" ? 1.075 : 1.0;
  return {
    min: Math.round((base.min * multiplier) / 1000) * 1000,
    max: Math.round((base.max * multiplier) / 1000) * 1000,
    mid: Math.round((base.mid * multiplier) / 1000) * 1000,
  };
}

// Returns SalaryResult or null when tier is unknown.
// SalaryResult: { tier, level, min, max, mid, expectation }
function calcSalary(companyName, title, opts = {}) {
  const {
    companyTiers = {},
    salaryMatrix = DEFAULT_SALARY_MATRIX,
    workFormat = "",
    city = "",
  } = opts;

  const tier = companyTiers[String(companyName || "")];
  if (!tier) return null;
  const tierRow = salaryMatrix[tier];
  if (!tierRow) return null;

  const level = parseLevel(title);
  const base = tierRow[level];
  if (!base) return null;

  const { min, max, mid } = adjustedSalary(base, workFormat, city);
  return {
    tier,
    level,
    min,
    max,
    mid,
    expectation: `$${min / 1000}-${max / 1000}K TC (midpoint $${mid / 1000}K)`,
  };
}

module.exports = { parseLevel, calcSalary, DEFAULT_SALARY_MATRIX };
