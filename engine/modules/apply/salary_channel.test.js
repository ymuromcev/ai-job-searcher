// BL-243 / RFC 072 — desired salary by channel and non-USD / monthly guard.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  parsePublishedRange,
  computeDesiredSalary,
  salaryAnswer,
  normalizeConfig,
} = require("./salary.js");
const {
  parsePublishedSalaryRange,
  publishedSalaryFromJd,
} = require("../../core/published_salary.js");
const { getSalaryFloor, validateApplyDefaults } = require("../../core/apply_defaults.js");

const CFG = {
  floor: 95000,
  default: 180000,
  currency: "USD",
  by_channel: { ru_latam: { floor: 80000, default: 80000 } },
};
const LATAM = "ru_latam";

// case 31
test("ru_latam without a published range → 80000 (channel default, not only the floor)", () => {
  const d = computeDesiredSalary({ range: null, salaryCfg: CFG, channel: LATAM });
  assert.equal(d.value, 80000);
  assert.equal(d.source, "default");
  assert.equal(d.belowFloor, false);
  assert.equal(salaryAnswer(d), "80000");
  // the general profile is untouched
  assert.equal(computeDesiredSalary({ range: null, salaryCfg: CFG }).value, 180000);
  assert.equal(computeDesiredSalary({ range: null, salaryCfg: CFG, channel: "" }).value, 180000);
});

// case 32
test("ru_latam 85–90k is not below the floor; forms 90000 and 85000-90000", () => {
  const d = computeDesiredSalary({
    range: { min: 85000, max: 90000 },
    salaryCfg: CFG,
    channel: LATAM,
  });
  assert.equal(d.belowFloor, false);
  assert.equal(d.value, 90000);
  assert.equal(salaryAnswer(d), "90000");
  assert.equal(salaryAnswer(d, { wantsRange: true }), "85000-90000");
});

// case 33
test("ru_latam 60–75k → below the floor", () => {
  const d = computeDesiredSalary({
    range: { min: 60000, max: 75000 },
    salaryCfg: CFG,
    channel: LATAM,
  });
  assert.equal(d.belowFloor, true);
});

// case 34
test("ru_latam 120–150k → 150000", () => {
  const d = computeDesiredSalary({
    range: { min: 120000, max: 150000 },
    salaryCfg: CFG,
    channel: LATAM,
  });
  assert.equal(d.value, 150000);
  assert.equal(d.belowFloor, false);
  assert.equal(salaryAnswer(d, { wantsRange: true }), "120000-150000");
});

// case 35
test("ru_latam 70–90k passes; the range is raised to the floor: 80000-90000", () => {
  const d = computeDesiredSalary({
    range: { min: 70000, max: 90000 },
    salaryCfg: CFG,
    channel: LATAM,
  });
  assert.equal(d.belowFloor, false);
  assert.equal(d.low, 80000);
  assert.equal(d.high, 90000);
  assert.equal(salaryAnswer(d, { wantsRange: true }), "80000-90000");
});

// case 37
test("a company without the channel with 85k top is below the general floor 95000", () => {
  const d = computeDesiredSalary({ range: { min: 70000, max: 85000 }, salaryCfg: CFG });
  assert.equal(d.belowFloor, true);
  // an unknown channel behaves like none
  assert.equal(
    computeDesiredSalary({ range: { min: 70000, max: 85000 }, salaryCfg: CFG, channel: "other" })
      .belowFloor,
    true
  );
});

// case 38 (rollback)
test("rollback: no by_channel → the channel company uses the general numbers", () => {
  const plain = { floor: 95000, default: 180000, currency: "USD" };
  assert.equal(
    computeDesiredSalary({ range: null, salaryCfg: plain, channel: LATAM }).value,
    180000
  );
  assert.equal(
    computeDesiredSalary({ range: { min: 85000, max: 90000 }, salaryCfg: plain, channel: LATAM })
      .belowFloor,
    true
  );
});

test("normalizeConfig: partial by_channel overlays only the keys it has; junk is ignored", () => {
  const c = normalizeConfig({ ...CFG, by_channel: { ru_latam: { floor: 80000 } } }, LATAM);
  assert.equal(c.floor, 80000);
  assert.equal(c.default, 180000);
  for (const by_channel of [null, [], "x", { ru_latam: null }, { ru_latam: { floor: "x" } }]) {
    const n = normalizeConfig({ ...CFG, by_channel }, LATAM);
    assert.equal(n.floor, 95000);
    assert.equal(n.default, 180000);
  }
});

// case 36 — both parsers
const MONTHLY_MXN = [
  "$45,000 – $60,000 MXN mensuales",
  "Sueldo: $45,000 - $60,000 MXN",
  "$45,000 - $60,000 mensuales",
  "$45,000 - $60,000 / month",
  "$45,000 - $60,000 per month",
  "MXN $45,000 - $60,000",
  "$45,000 - $60,000 BRL",
  "$45,000 - $60,000 COP",
  "$45,000 - $60,000 ARS",
  "$45,000 - $60,000 CLP",
  "$45,000 - $60,000 PEN",
];

test("«$45,000 – $60,000 MXN mensuales» and kin are not an annual USD range (apply parser)", () => {
  for (const t of MONTHLY_MXN) assert.equal(parsePublishedRange(t), null, t);
  // the neighbours still parse
  assert.deepEqual(parsePublishedRange("$85,000 - $95,000 USD"), { min: 85000, max: 95000 });
  assert.deepEqual(parsePublishedRange("$150K-$200K + equity"), { min: 150000, max: 200000 });
});

test("the same guard in the prepare parser (core/published_salary.js)", () => {
  for (const t of MONTHLY_MXN) assert.equal(parsePublishedSalaryRange(t), null, t);
  assert.equal(parsePublishedSalaryRange("$45,000 MXN", { allowSingle: true }), null);
  assert.deepEqual(parsePublishedSalaryRange("$85,000 - $95,000 USD"), { min: 85000, max: 95000 });
  assert.equal(
    publishedSalaryFromJd("Salary: $45,000 - $60,000 MXN mensuales\nBenefits: ..."),
    null
  );
});

test("no range from a MXN text → the channel default, not an invented floor failure", () => {
  const range = parsePublishedRange("$45,000 – $60,000 MXN mensuales");
  const d = computeDesiredSalary({ range, salaryCfg: CFG, channel: LATAM });
  assert.equal(d.source, "default");
  assert.equal(d.value, 80000);
  assert.equal(d.belowFloor, false);
});

// getSalaryFloor / validator
test("getSalaryFloor: by_channel floor for the channel, general floor otherwise", () => {
  const ad = { salary: CFG };
  assert.equal(getSalaryFloor(ad, LATAM), 80000);
  assert.equal(getSalaryFloor(ad), 95000);
  assert.equal(getSalaryFloor(ad, "other"), 95000);
  assert.equal(getSalaryFloor(ad, "constructor"), 95000);
  assert.equal(
    getSalaryFloor({ salary: { ...CFG, by_channel: { ru_latam: { floor: -1 } } } }, LATAM),
    95000
  );
  assert.equal(getSalaryFloor(null, LATAM), null);
});

const BASE = {
  work_authorization: { authorized_us: true, requires_sponsorship: false, status_text: "GC" },
  relocation: { willing: false },
  eeo: { policy: "decline" },
  salary: CFG,
  how_did_you_hear_default: "x",
};

test("validateApplyDefaults accepts by_channel and rejects bad shapes", () => {
  assert.deepEqual(validateApplyDefaults(BASE, "demo"), []);
  const bad = (by_channel) =>
    validateApplyDefaults({ ...BASE, salary: { ...CFG, by_channel } }, "demo").map(
      (i) => i.message || String(i)
    );
  assert.ok(bad("x").length > 0);
  assert.ok(bad({ ru_latam: "x" }).length > 0);
  assert.ok(bad({ ru_latam: { floor: -5 } }).length > 0);
  assert.ok(bad({ ru_latam: { floor: 80000, default: 70000 } }).length > 0);
  assert.deepEqual(bad({ ru_latam: { floor: 80000 } }), []);
});

// --- BL-243 round 2 -------------------------------------------------------------

// point 1: a lone amount inside a dropped (MXN / monthly) range is not a dollar figure
test("allowSingle: figures of a MXN / monthly range are not re-read as single dollars", () => {
  assert.equal(publishedSalaryFromJd("Compensation\n$45,000 - $60,000 MXN\n"), null);
  assert.equal(publishedSalaryFromJd("Compensation\n$45,000 - $60,000 MXN mensuales\n"), null);
  assert.equal(parsePublishedSalaryRange("MXN $45,000 - $60,000", { allowSingle: true }), null);
  assert.equal(parsePublishedSalaryRange("$45,000 - $60,000 MXN", { allowSingle: true }), null);
  assert.equal(parsePublishedSalaryRange("$45,000 - $60,000 / month", { allowSingle: true }), null);
  // a real single amount elsewhere in the section is still read
  assert.deepEqual(parsePublishedSalaryRange("Pay: $150,000", { allowSingle: true }), {
    min: null,
    max: 150000,
  });
  assert.deepEqual(
    publishedSalaryFromJd("Compensation\n$150,000 base\n\nBonus tier $45,000 - $60,000 MXN"),
    { min: null, max: 150000 }
  );
  // a letter after "M" is not the million suffix
  assert.equal(parsePublishedSalaryRange("$60,000 MXN", { allowSingle: true }), null);
  assert.deepEqual(parsePublishedSalaryRange("$1.2M", { allowSingle: true }), {
    min: null,
    max: 1200000,
  });
});

// point 2: glued currency prefixes
test("glued prefixes MX$ / R$ / COP$ are not annual USD (both parsers)", () => {
  for (const t of [
    "MX$45,000 – $60,000",
    "MX$45,000 - MX$60,000",
    "R$45,000 - $60,000",
    "COP$45,000 - $60,000",
    "ARS$45,000 - $60,000",
    "CLP$45,000 - $60,000",
  ]) {
    assert.equal(parsePublishedRange(t), null, t);
    assert.equal(parsePublishedSalaryRange(t), null, t);
    assert.equal(parsePublishedSalaryRange(t, { allowSingle: true }), null, t);
  }
  assert.equal(publishedSalaryFromJd("Compensation\nMX$45,000 – $60,000\n"), null);
  // plain USD around is untouched
  assert.deepEqual(parsePublishedRange("US$85,000 - $95,000"), { min: 85000, max: 95000 });
});

// point 4: by_channel floor / default must be > 0
test("validateApplyDefaults: by_channel floor 0 / default 0 is an error; getSalaryFloor ignores 0", () => {
  const bad = (by_channel) =>
    validateApplyDefaults({ ...BASE, salary: { ...CFG, by_channel } }, "demo");
  assert.ok(bad({ ru_latam: { floor: 0 } }).length > 0);
  assert.ok(bad({ ru_latam: { default: 0 } }).length > 0);
  assert.deepEqual(bad({ ru_latam: { floor: 1, default: 1 } }), []);
  assert.equal(
    getSalaryFloor({ salary: { ...CFG, by_channel: { ru_latam: { floor: 0 } } } }, LATAM),
    95000
  );
  assert.equal(
    normalizeConfig({ ...CFG, by_channel: { ru_latam: { floor: 0 } } }, LATAM).floor,
    95000
  );
});

// --- BL-243 round 3 ---------------------------------------------------------------

// point 1: «Million» / a glued USD code keep the multiplier; only a glued CURRENCY code does not
test("multiplier suffix: «$5 Million», «$1.2 million», «$150kUSD» read; «$60,000 MXN» does not become 60 million", () => {
  const single = (t) => parsePublishedSalaryRange(t, { allowSingle: true });
  assert.deepEqual(single("$5 Million"), { min: null, max: 5000000 });
  assert.deepEqual(single("$1.2 million"), { min: null, max: 1200000 });
  assert.deepEqual(single("$150kUSD"), { min: null, max: 150000 });
  assert.deepEqual(single("$150k"), { min: null, max: 150000 });
  assert.deepEqual(single("$1.2M"), { min: null, max: 1200000 });
  assert.deepEqual(single("$150K USD"), { min: null, max: 150000 });
  assert.deepEqual(parsePublishedSalaryRange("$140-190k"), { min: 140000, max: 190000 });
  assert.deepEqual(parsePublishedSalaryRange("$1 Million - $2 Million"), {
    min: 1000000,
    max: 2000000,
  });
  // a currency code starting with the letter is still not a suffix
  assert.equal(single("$60,000 MXN"), null);
  assert.equal(single("$60,000MXN"), null);
  assert.equal(parsePublishedSalaryRange("$45,000 - $60,000 MXN"), null);
});

// point 2: a lone amount is judged by the rest of its sentence, not only by the next word
test("«Between $45,000 and $60,000 MXN per month» / «$45,000 a $60,000 MXN mensuales» give no dollar figure (Compensation section)", () => {
  for (const line of [
    "Between $45,000 and $60,000 MXN per month",
    "$45,000 a $60,000 MXN mensuales",
    "$45,000 y $60,000 MXN al mes",
    "From $45,000 to MXN 60,000 per month",
  ]) {
    assert.equal(
      publishedSalaryFromJd(`Senior PM\nCompensation\n${line}\nBenefits\nx\n`),
      null,
      line
    );
    assert.equal(parsePublishedSalaryRange(line, { allowSingle: true }), null, line);
  }
  // the next sentence / line is a different statement: a USD figure before it is read
  assert.deepEqual(
    publishedSalaryFromJd("Senior PM\nCompensation\nBase salary $150,000. Bonus paid monthly.\n"),
    { min: null, max: 150000 }
  );
  assert.deepEqual(
    publishedSalaryFromJd("Senior PM\nCompensation\n$150,000 and $180,000 per year\n"),
    { min: null, max: 180000 }
  );
});

// point 3: «USD monthly» / «USD per month» / «/month» are per month
test("«USD monthly», «USD per month», «/month» are not annual (range and single, both parsers)", () => {
  const ranges = [
    "$11,000 - $14,000 USD monthly",
    "$11,000 - $14,000 USD per month",
    "$11,000 - $14,000/month",
    "$11,000 - $14,000 USD/month",
    "$11,000 - $14,000 / month",
  ];
  for (const t of ranges) {
    assert.equal(parsePublishedSalaryRange(t), null, t);
    assert.equal(parsePublishedRange(t.replace(/11,000/, "21,000")), null, t);
    assert.equal(parsePublishedSalaryRange(t, { allowSingle: true }), null, t);
  }
  for (const t of ["$12,000 USD monthly", "$12,000 USD per month", "$12,000/month"]) {
    assert.equal(parsePublishedSalaryRange(t, { allowSingle: true }), null, t);
    assert.equal(publishedSalaryFromJd(`Senior PM\nCompensation\n${t}\n`), null, t);
  }
  // control: an annual USD range with the USD code is untouched
  assert.deepEqual(parsePublishedSalaryRange("$110,000 - $140,000 USD per year"), {
    min: 110000,
    max: 140000,
  });
  assert.deepEqual(parsePublishedRange("$110,000 - $140,000 USD"), { min: 110000, max: 140000 });
});

test("an implausible range is dropped as a whole: its second figure is not read as a single", () => {
  // «$1,000 - $200,000»: the lower bound is noise, the pair is not a usable range
  assert.equal(parsePublishedSalaryRange("$1,000 - $200,000", { allowSingle: true }), null);
  // a lone amount elsewhere is still read
  assert.deepEqual(
    parsePublishedSalaryRange("$1,000 - $200,000. Pay: $150,000", { allowSingle: true }),
    { min: null, max: 150000 }
  );
});
