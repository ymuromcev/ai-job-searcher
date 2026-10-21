// RFC 068 §4a — published salary parsing + the evaluateJob salary-floor step.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { parsePublishedSalaryRange, publishedSalaryFromJd } = require("./published_salary.js");
const { evaluateJob, checkSalaryFloor } = require("./evaluate_job.js");

test("parsePublishedSalaryRange: common range formats", () => {
  const cases = [
    ["$140,000 - $190,000", { min: 140000, max: 190000 }],
    ["$140,000—$190,000 USD", { min: 140000, max: 190000 }],
    ["$140K–$190K", { min: 140000, max: 190000 }],
    ["$140-190k", { min: 140000, max: 190000 }],
    ["USD 140,000 to 190,000", { min: 140000, max: 190000 }],
    ["Base: $152,500.00 - $205,000.00", { min: 152500, max: 205000 }],
  ];
  for (const [text, want] of cases) {
    assert.deepEqual(parsePublishedSalaryRange(text), want, text);
  }
});

test("parsePublishedSalaryRange: multiple tiers collapse to overall span", () => {
  const text = "Zone A: $150,000 - $200,000. Zone B: $130,000 - $170,000.";
  assert.deepEqual(parsePublishedSalaryRange(text), { min: 130000, max: 200000 });
});

test("parsePublishedSalaryRange: hourly ranges are ignored", () => {
  assert.equal(parsePublishedSalaryRange("$45 - $60/hr"), null);
  assert.equal(parsePublishedSalaryRange("$45.00 - $60.00 per hour"), null);
});

test("parsePublishedSalaryRange: implausible amounts are ignored", () => {
  assert.equal(parsePublishedSalaryRange("We grew from $1M - $50M ARR"), null);
  assert.equal(parsePublishedSalaryRange("$500 - $1,000 learning stipend"), null);
});

test("parsePublishedSalaryRange: single amount only with allowSingle", () => {
  assert.equal(parsePublishedSalaryRange("Salary: $150,000"), null);
  assert.deepEqual(parsePublishedSalaryRange("Salary: $150,000", { allowSingle: true }), {
    min: null,
    max: 150000,
  });
});

test("parsePublishedSalaryRange: empty / no salary → null", () => {
  assert.equal(parsePublishedSalaryRange(""), null);
  assert.equal(parsePublishedSalaryRange(null), null);
  assert.equal(parsePublishedSalaryRange("Competitive pay and great benefits"), null);
});

test("publishedSalaryFromJd: Compensation section, then inline range", () => {
  assert.deepEqual(
    publishedSalaryFromJd("Senior PM\nCompensation\nBase salary of $175,000 plus equity.\n"),
    { min: null, max: 175000 }
  );
  assert.deepEqual(publishedSalaryFromJd("Senior PM\nWe pay $120,000 - $140,000 base.\n"), {
    min: 120000,
    max: 140000,
  });
  assert.equal(publishedSalaryFromJd("Senior PM\nRequirements:\n- SQL\n"), null);
});

test("publishedSalaryFromJd: later per-location tiers widen the span", () => {
  const jd =
    "Senior PM\nOur cash compensation is $68,085 - $83,972/year in Denver and " +
    "$85,105 - $104,963/year in San Francisco.\n";
  assert.deepEqual(publishedSalaryFromJd(jd), { min: 68085, max: 104963 });
});

test("checkSalaryFloor: top = max, else min; null floor or no amount → pass", () => {
  assert.deepEqual(checkSalaryFloor({ min: 90000, max: 110000 }, 120000), {
    below: true,
    top: 110000,
    floor: 120000,
  });
  assert.equal(checkSalaryFloor({ min: 90000, max: 130000 }, 120000).below, false);
  assert.equal(checkSalaryFloor({ min: 100000, max: null }, 120000).below, true);
  assert.equal(checkSalaryFloor({ min: "100,000", max: "" }, 120000).below, true);
  assert.equal(checkSalaryFloor({ min: 120000, max: 120000 }, 120000).below, false);
  assert.equal(checkSalaryFloor(null, 120000).below, false);
  assert.equal(checkSalaryFloor({ min: 50000, max: 60000 }, null).below, false);
});

function evalSalary(published, applyDefaults, context = "prepare") {
  return evaluateJob({
    job: { company: "Acme", title: "PM", locations: ["Remote"], published_salary: published },
    profile: { filter_rules: {}, applyDefaults },
    appState: { companyCounts: {} },
    context,
  });
}

const DEFAULTS = { salary: { floor: 120000, default: 180000, currency: "USD" } };

test("evaluateJob salary_below_floor: prepare × below → skip", () => {
  const r = evalSalary({ min: 90000, max: 110000 }, DEFAULTS);
  assert.equal(r.decision, "skip");
  assert.equal(r.skipReason, "salary_below_floor");
  assert.equal(r.matched.top, 110000);
});

test("evaluateJob salary_below_floor: above floor / no published salary → keep", () => {
  assert.equal(evalSalary({ min: 110000, max: 150000 }, DEFAULTS).decision, "keep");
  assert.equal(evalSalary(null, DEFAULTS).decision, "keep");
});

test("evaluateJob salary_below_floor: no apply_defaults → no-op", () => {
  assert.equal(evalSalary({ min: 50000, max: 60000 }, null).decision, "keep");
  assert.equal(evalSalary({ min: 50000, max: 60000 }, undefined).decision, "keep");
});

test("evaluateJob salary_below_floor: runs only in prepare context", () => {
  assert.equal(evalSalary({ min: 50000, max: 60000 }, DEFAULTS, "scan").decision, "keep");
  assert.equal(evalSalary({ min: 50000, max: 60000 }, DEFAULTS, "email").decision, "keep");
});
