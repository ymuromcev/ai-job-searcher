const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseLevel,
  parseLevelPm,
  parseLevelHealthcare,
  parseLevelDefault,
  calcSalary,
  DEFAULT_SALARY_MATRIX,
  DEFAULT_COL_ADJUSTMENT,
  PARSERS,
} = require("./salary_calc.js");

const TIERS = {
  Stripe: "S",
  Ramp: "A",
  Sardine: "B",
  Earnin: "C",
};

// --- parseLevel --------------------------------------------------------------

test("parseLevel: Lead title", () => {
  assert.equal(parseLevel("Product Lead"), "Lead");
  assert.equal(parseLevel("Lead Product Manager"), "Lead");
});

test("parseLevel: Senior variations", () => {
  assert.equal(parseLevel("Senior Product Manager"), "Senior");
  assert.equal(parseLevel("Sr. Product Manager"), "Senior");
  assert.equal(parseLevel("Sr Product Manager"), "Senior");
});

test("parseLevel: Capital One Manager style", () => {
  assert.equal(parseLevel("Manager, Product Management"), "Senior");
  assert.equal(parseLevel("Manager Product Management"), "Senior");
});

test("parseLevel: default PM", () => {
  assert.equal(parseLevel("Product Manager"), "PM");
  assert.equal(parseLevel("Product Manager II"), "PM");
  assert.equal(parseLevel(""), "PM");
});

// --- calcSalary: basic -------------------------------------------------------

test("calcSalary: Tier S Senior → correct range", () => {
  const r = calcSalary("Stripe", "Senior Product Manager", { companyTiers: TIERS });
  assert.ok(r, "should return a result");
  assert.equal(r.tier, "S");
  assert.equal(r.level, "Senior");
  assert.equal(r.min, DEFAULT_SALARY_MATRIX.S.Senior.min);
  assert.equal(r.max, DEFAULT_SALARY_MATRIX.S.Senior.max);
  assert.equal(r.mid, DEFAULT_SALARY_MATRIX.S.Senior.mid);
  assert.match(r.expectation, /\$220-300K/);
});

test("calcSalary: Tier A PM → correct range", () => {
  const r = calcSalary("Ramp", "Product Manager", { companyTiers: TIERS });
  assert.equal(r.tier, "A");
  assert.equal(r.level, "PM");
  assert.equal(r.min, 160000);
  assert.equal(r.max, 200000);
  assert.equal(r.mid, 180000);
});

test("calcSalary: Tier B Lead → correct range", () => {
  const r = calcSalary("Sardine", "Lead Product Manager", { companyTiers: TIERS });
  assert.equal(r.tier, "B");
  assert.equal(r.level, "Lead");
  assert.equal(r.min, 190000);
  assert.equal(r.max, 250000);
});

test("calcSalary: Tier C Senior → correct range", () => {
  const r = calcSalary("Earnin", "Senior PM", { companyTiers: TIERS });
  assert.equal(r.tier, "C");
  assert.equal(r.level, "Senior");
  assert.equal(r.min, 150000);
  assert.equal(r.max, 190000);
});

// --- calcSalary: unknown company ---------------------------------------------

test("calcSalary: unknown company → null", () => {
  assert.equal(calcSalary("UnknownCo", "Senior PM", { companyTiers: TIERS }), null);
});

test("calcSalary: empty companyTiers → null", () => {
  assert.equal(calcSalary("Stripe", "Senior PM"), null);
});

// --- calcSalary: COL adjustment ----------------------------------------------

test("calcSalary: SF hybrid → +7.5%", () => {
  const remote = calcSalary("Stripe", "Senior PM", {
    companyTiers: TIERS,
    workFormat: "Remote",
    city: "San Francisco",
  });
  const hybrid = calcSalary("Stripe", "Senior PM", {
    companyTiers: TIERS,
    workFormat: "Hybrid",
    city: "San Francisco",
  });
  assert.ok(hybrid.min > remote.min, "hybrid SF should have higher min");
  assert.equal(hybrid.min, Math.round((remote.min * 1.075) / 1000) * 1000);
});

test("calcSalary: NYC onsite → +7.5%", () => {
  const base = calcSalary("Stripe", "Senior PM", { companyTiers: TIERS });
  const nyc = calcSalary("Stripe", "Senior PM", {
    companyTiers: TIERS,
    workFormat: "Onsite",
    city: "New York City",
  });
  assert.ok(nyc.min > base.min);
});

test("calcSalary: SF remote → no adjustment", () => {
  const base = calcSalary("Stripe", "Senior PM", { companyTiers: TIERS });
  const sfRemote = calcSalary("Stripe", "Senior PM", {
    companyTiers: TIERS,
    workFormat: "Remote",
    city: "San Francisco, CA",
  });
  assert.equal(sfRemote.min, base.min);
});

// --- calcSalary: expectation string format -----------------------------------

test("calcSalary: expectation string contains TC and midpoint", () => {
  const r = calcSalary("Ramp", "Product Manager", { companyTiers: TIERS });
  assert.match(r.expectation, /TC/);
  assert.match(r.expectation, /midpoint/);
  assert.match(r.expectation, /\$160-200K TC \(midpoint \$180K\)/);
});

// --- L-1: parseLevel dispatcher --------------------------------------------

test("parseLevel: dispatches to PM parser by default", () => {
  assert.equal(parseLevel("Senior Product Manager"), "Senior");
  assert.equal(parseLevel("Senior Product Manager", "pm"), "Senior");
  assert.equal(parseLevel("Senior Product Manager", undefined), "Senior");
});

test("parseLevel: healthcare parser catches receptionist / coordinator / senior", () => {
  assert.equal(parseLevel("Medical Receptionist", "healthcare"), "MedAdmin");
  assert.equal(parseLevel("Patient Services Representative", "healthcare"), "MedAdmin");
  assert.equal(parseLevel("Front Desk Coordinator", "healthcare"), "Coordinator");
  assert.equal(parseLevel("Authorization Coordinator", "healthcare"), "Coordinator");
  assert.equal(parseLevel("Care Management Specialist", "healthcare"), "Coordinator");
  assert.equal(parseLevel("Senior Patient Services Rep", "healthcare"), "Senior");
  assert.equal(parseLevel("Lead Receptionist", "healthcare"), "Senior");
  assert.equal(parseLevel("Supervisor, Front Desk", "healthcare"), "Senior");
  assert.equal(parseLevel("", "healthcare"), "MedAdmin");
});

test("parseLevel: default parser returns single 'default' level", () => {
  assert.equal(parseLevel("Anything", "default"), "default");
  assert.equal(parseLevel("", "default"), "default");
});

test("parseLevel: accepts a custom function", () => {
  const custom = (t) => (String(t).includes("Junior") ? "Junior" : "Senior");
  assert.equal(parseLevel("Junior PM", custom), "Junior");
  assert.equal(parseLevel("Staff Engineer", custom), "Senior");
});

test("parseLevel: unknown parser name falls back to PM (back-compat)", () => {
  assert.equal(parseLevel("Senior Product Manager", "nonsense"), "Senior");
});

test("PARSERS exposes pm/healthcare/default", () => {
  assert.equal(typeof PARSERS.pm, "function");
  assert.equal(typeof PARSERS.healthcare, "function");
  assert.equal(typeof PARSERS.default, "function");
  assert.equal(PARSERS.pm, parseLevelPm);
  assert.equal(PARSERS.healthcare, parseLevelHealthcare);
  assert.equal(PARSERS.default, parseLevelDefault);
});

// --- L-1: per-profile matrix + level parser --------------------------------

const LILIA_TIERS = {
  "Kaiser Permanente": "S",
  "UC Davis Health": "S",
  "Dignity Health": "A",
  "Sono Bello": "B",
  "Stonebrook Dental": "C",
};
const LILIA_MATRIX = {
  S: {
    MedAdmin:    { min: 48000, max: 58000, mid: 53000 },
    Coordinator: { min: 52000, max: 64000, mid: 58000 },
    Senior:      { min: 56000, max: 70000, mid: 63000 },
  },
  A: {
    MedAdmin:    { min: 44000, max: 52000, mid: 48000 },
    Coordinator: { min: 48000, max: 58000, mid: 53000 },
    Senior:      { min: 52000, max: 64000, mid: 58000 },
  },
  B: {
    MedAdmin:    { min: 40000, max: 48000, mid: 44000 },
    Coordinator: { min: 44000, max: 52000, mid: 48000 },
    Senior:      { min: 48000, max: 58000, mid: 53000 },
  },
  C: {
    MedAdmin:    { min: 36000, max: 44000, mid: 40000 },
    Coordinator: { min: 40000, max: 48000, mid: 44000 },
    Senior:      { min: 44000, max: 52000, mid: 48000 },
  },
};

test("calcSalary: Lilia healthcare — Tier S MedAdmin", () => {
  const r = calcSalary("Kaiser Permanente", "Medical Receptionist", {
    companyTiers: LILIA_TIERS,
    salaryMatrix: LILIA_MATRIX,
    levelParser: "healthcare",
  });
  assert.ok(r);
  assert.equal(r.tier, "S");
  assert.equal(r.level, "MedAdmin");
  assert.equal(r.min, 48000);
  assert.equal(r.max, 58000);
  assert.match(r.expectation, /\$48-58K TC \(midpoint \$53K\)/);
});

test("calcSalary: Lilia healthcare — Tier A Coordinator", () => {
  const r = calcSalary("Dignity Health", "Authorization Coordinator", {
    companyTiers: LILIA_TIERS,
    salaryMatrix: LILIA_MATRIX,
    levelParser: "healthcare",
  });
  assert.equal(r.tier, "A");
  assert.equal(r.level, "Coordinator");
  assert.equal(r.min, 48000);
  assert.equal(r.max, 58000);
});

test("calcSalary: Lilia healthcare — Tier C MedAdmin (small clinic)", () => {
  const r = calcSalary("Stonebrook Dental", "Dental Receptionist", {
    companyTiers: LILIA_TIERS,
    salaryMatrix: LILIA_MATRIX,
    levelParser: "healthcare",
  });
  assert.equal(r.tier, "C");
  assert.equal(r.level, "MedAdmin");
  assert.equal(r.min, 36000);
  assert.equal(r.max, 44000);
});

test("calcSalary: Lilia COL config disables SF adjustment", () => {
  const noColAdj = { multiplier: 1.0, high_col_cities: [], exclude_format: ["Remote"] };
  const sf = calcSalary("Kaiser Permanente", "Medical Receptionist", {
    companyTiers: LILIA_TIERS,
    salaryMatrix: LILIA_MATRIX,
    levelParser: "healthcare",
    colAdjustment: noColAdj,
    workFormat: "Onsite",
    city: "San Francisco",
  });
  // Lilia's COL config zeros the multiplier — no SF bump even onsite.
  assert.equal(sf.min, 48000);
  assert.equal(sf.max, 58000);
});

// --- Jared parity: omitting the new opts must reproduce existing numbers ----

test("calcSalary: Jared parity — omitting levelParser uses PM matrix", () => {
  const r = calcSalary("Stripe", "Senior Product Manager", { companyTiers: TIERS });
  assert.equal(r.tier, "S");
  assert.equal(r.level, "Senior");
  assert.equal(r.min, DEFAULT_SALARY_MATRIX.S.Senior.min);
  assert.equal(r.max, DEFAULT_SALARY_MATRIX.S.Senior.max);
});

test("calcSalary: Jared parity — SF onsite +7.5% with default COL config", () => {
  const base = calcSalary("Stripe", "Senior PM", { companyTiers: TIERS });
  const sf = calcSalary("Stripe", "Senior PM", {
    companyTiers: TIERS,
    workFormat: "Onsite",
    city: "San Francisco",
  });
  assert.equal(sf.min, Math.round((base.min * 1.075) / 1000) * 1000);
});

test("DEFAULT_COL_ADJUSTMENT: matches the prior hard-coded rules", () => {
  assert.equal(DEFAULT_COL_ADJUSTMENT.multiplier, 1.075);
  assert.deepEqual(DEFAULT_COL_ADJUSTMENT.exclude_format, ["Remote"]);
  assert.ok(DEFAULT_COL_ADJUSTMENT.high_col_cities.includes("san francisco"));
  assert.ok(DEFAULT_COL_ADJUSTMENT.high_col_cities.includes("new york"));
});

test("calcSalary: currency falls back to '$' for USD, blank otherwise", () => {
  const usd = calcSalary("Stripe", "Senior PM", { companyTiers: TIERS, currency: "USD" });
  assert.match(usd.expectation, /^\$/);
  const eur = calcSalary("Stripe", "Senior PM", { companyTiers: TIERS, currency: "EUR" });
  assert.equal(eur.expectation.startsWith("$"), false);
});
