const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  parsePublishedRange,
  computeDesiredSalary,
  salaryAnswer,
  parseAmount,
} = require("./salary.js");

const CFG = { floor: 120000, default: 180000, currency: "USD" };

test("parseAmount handles commas and k suffix", () => {
  assert.equal(parseAmount("150,000"), 150000);
  assert.equal(parseAmount("150K"), 150000);
  assert.equal(parseAmount("162.5k"), 162500);
  assert.equal(parseAmount(""), null);
});

test("parsePublishedRange: common JD formats", () => {
  assert.deepEqual(parsePublishedRange("Base pay: $150,000 — $190,000 USD"), {
    min: 150000,
    max: 190000,
  });
  assert.deepEqual(parsePublishedRange("$150K-$200K + equity"), { min: 150000, max: 200000 });
  assert.deepEqual(parsePublishedRange("$140,000 USD to $175,000 USD"), {
    min: 140000,
    max: 175000,
  });
  assert.deepEqual(parsePublishedRange("range is $180000 - $220000"), { min: 180000, max: 220000 });
});

test("parsePublishedRange: ignores hourly rates and non-ranges", () => {
  assert.equal(parsePublishedRange("$45 - $60 per hour"), null);
  assert.equal(parsePublishedRange("$50,000 - $60,000/hr"), null);
  assert.equal(parsePublishedRange("Competitive salary and $5,000 learning budget"), null);
  assert.equal(parsePublishedRange(""), null);
});

test("parsePublishedRange: first annual range wins", () => {
  const text = "SF/NYC: $170,000 - $210,000. Other US: $150,000 - $190,000.";
  assert.deepEqual(parsePublishedRange(text), { min: 170000, max: 210000 });
});

test("computeDesiredSalary: published range → top of range", () => {
  const d = computeDesiredSalary({ range: { min: 150000, max: 190000 }, salaryCfg: CFG });
  assert.equal(d.value, 190000);
  assert.equal(d.low, 150000);
  assert.equal(d.high, 190000);
  assert.equal(d.source, "published_range");
  assert.equal(d.belowFloor, false);
});

test("computeDesiredSalary: low bound raised to the floor", () => {
  const d = computeDesiredSalary({ range: { min: 100000, max: 140000 }, salaryCfg: CFG });
  assert.equal(d.value, 140000);
  assert.equal(d.low, 120000);
  assert.equal(d.high, 140000);
});

test("computeDesiredSalary: whole range under floor → floor + belowFloor flag", () => {
  const d = computeDesiredSalary({ range: { min: 80000, max: 110000 }, salaryCfg: CFG });
  assert.equal(d.belowFloor, true);
  assert.equal(d.value, 120000);
  assert.equal(d.low, 120000);
});

test("computeDesiredSalary: no published range → default", () => {
  const d = computeDesiredSalary({ range: null, salaryCfg: CFG });
  assert.equal(d.value, 180000);
  assert.equal(d.source, "default");
  assert.equal(d.belowFloor, false);
});

test("computeDesiredSalary: missing config falls back to RFC defaults", () => {
  assert.equal(computeDesiredSalary({}).value, 180000);
  assert.equal(computeDesiredSalary({ range: { min: 90000, max: 100000 } }).value, 120000);
});

test("salaryAnswer: single vs range", () => {
  const d = computeDesiredSalary({ range: { min: 100000, max: 140000 }, salaryCfg: CFG });
  assert.equal(salaryAnswer(d), "140000");
  assert.equal(salaryAnswer(d, { wantsRange: true }), "120000-140000");
  const def = computeDesiredSalary({ salaryCfg: CFG });
  assert.equal(salaryAnswer(def, { wantsRange: true }), "180000");
});
