const { test } = require("node:test");
const assert = require("node:assert/strict");

const { parseLevel, calcSalary, DEFAULT_SALARY_MATRIX } = require("./salary_calc.js");

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
