const test = require("node:test");
const assert = require("node:assert");

const {
  slugify,
  makeManualKey,
  parseSalaryRange,
  validateStatus,
  validateDate,
  validateTier,
  validateFit,
  parseLocations,
  buildManualRow,
  buildJobFields,
  normalizeTitle,
  normalizeCompany,
  findDuplicates,
} = require("./manual_job.js");

const { HEADER } = require("./applications_tsv.js");

const NOW = "2026-07-16T12:00:00.000Z";

function baseInput(over = {}) {
  return {
    company: "LawnStarter",
    title: "Senior Product Manager, Pricing & Monetization",
    status: "Interview",
    ...over,
  };
}

// ---------- slugify / makeManualKey ----------

test("slugify: lowercases, strips punctuation, collapses separators", () => {
  assert.equal(
    slugify("Senior Product Manager, Pricing & Monetization"),
    "senior-product-manager-pricing-monetization"
  );
  assert.equal(slugify("  Spaces  "), "spaces");
  assert.equal(slugify("A/B Testing"), "a-b-testing");
});

test("slugify: strips diacritics rather than dropping the letter", () => {
  assert.equal(slugify("Café München"), "cafe-munchen");
});

test("makeManualKey: manual:<company>_<title>_<date>", () => {
  assert.equal(
    makeManualKey({ company: "LawnStarter", title: "Senior PM", date: "2026-07-16" }),
    "manual:lawnstarter_senior-pm_2026-07-16"
  );
});

test("makeManualKey: rejects a bad date and empty parts", () => {
  assert.throws(
    () => makeManualKey({ company: "X", title: "Y", date: "16-07-2026" }),
    /YYYY-MM-DD/
  );
  assert.throws(
    () => makeManualKey({ company: "", title: "Y", date: "2026-07-16" }),
    /company is required/
  );
  assert.throws(
    () => makeManualKey({ company: "X", title: "", date: "2026-07-16" }),
    /title is required/
  );
});

// ---------- parseSalaryRange ----------

test("parseSalaryRange: range, single bound, empty", () => {
  assert.deepEqual(parseSalaryRange("140000-185000"), { min: 140000, max: 185000 });
  assert.deepEqual(parseSalaryRange("140000 - 185000"), { min: 140000, max: 185000 });
  assert.deepEqual(parseSalaryRange("150000"), { min: 150000, max: null });
  assert.deepEqual(parseSalaryRange(""), { min: null, max: null });
  assert.deepEqual(parseSalaryRange(undefined), { min: null, max: null });
});

test("parseSalaryRange: rejects garbage and inverted ranges", () => {
  assert.throws(() => parseSalaryRange("$140k-185k"), /whole dollars/);
  assert.throws(() => parseSalaryRange("140000-"), /whole dollars/);
  assert.throws(() => parseSalaryRange("185000-140000"), /below min/);
});

// ---------- validateStatus ----------

test("validateStatus: accepts the Notion status set", () => {
  for (const s of [
    "To Apply",
    "Applied",
    "Interview",
    "Offer",
    "Rejected",
    "No Response",
    "Closed",
    "Archived",
  ]) {
    assert.equal(validateStatus(s), s);
  }
});

test("validateStatus: rejects Inbox by name, citing RFC 014", () => {
  assert.throws(() => validateStatus("Inbox"), /TSV-only/);
});

test("validateStatus: rejects unknown and empty", () => {
  assert.throws(() => validateStatus("Submitted"), /unknown status/);
  assert.throws(() => validateStatus(""), /required/);
});

// ---------- small validators ----------

test("validateDate: passes YYYY-MM-DD, empty is allowed, garbage throws", () => {
  assert.equal(validateDate("2026-07-16", "--applied-date"), "2026-07-16");
  assert.equal(validateDate("", "--applied-date"), "");
  assert.throws(
    () => validateDate("16/07/2026", "--applied-date"),
    /--applied-date must be YYYY-MM-DD/
  );
});

test("validateTier / validateFit: known values, empty allowed, junk throws", () => {
  assert.equal(validateTier("B"), "B");
  assert.equal(validateTier(""), "");
  assert.throws(() => validateTier("Z"), /--tier/);
  assert.equal(validateFit("Strong"), "Strong");
  assert.equal(validateFit(""), "");
  assert.throws(() => validateFit("Great"), /--fit/);
});

test("parseLocations: splits, trims, drops empties", () => {
  assert.deepEqual(parseLocations("Remote,United States"), ["Remote", "United States"]);
  assert.deepEqual(parseLocations(" Remote , , US "), ["Remote", "US"]);
  assert.deepEqual(parseLocations(""), []);
});

// ---------- buildManualRow ----------

test("buildManualRow: row carries exactly the TSV v7 columns", () => {
  const row = buildManualRow(baseInput(), NOW);
  assert.deepEqual(Object.keys(row).sort(), [...HEADER].sort());
});

test("buildManualRow: source Manual, empty notion_page_id, key from company+title+date", () => {
  const row = buildManualRow(baseInput(), NOW);
  assert.equal(row.source, "Manual");
  assert.equal(row.notion_page_id, "");
  assert.equal(
    row.key,
    "manual:lawnstarter_senior-product-manager-pricing-monetization_2026-07-16"
  );
  assert.equal(row.jobId, "lawnstarter_senior-product-manager-pricing-monetization_2026-07-16");
  assert.equal(row.status, "Interview");
  assert.equal(row.hm_outreach_status, "To do");
});

test("buildManualRow: salary and locations parsed; applied_date passed through", () => {
  const row = buildManualRow(
    baseInput({
      salary: "140000-185000",
      locations: "Remote,United States",
      appliedDate: "2026-07-01",
    }),
    NOW
  );
  assert.equal(row.salary_min, 140000);
  assert.equal(row.salary_max, 185000);
  assert.deepEqual(row.locations, ["Remote", "United States"]);
  assert.equal(row.applied_date, "2026-07-01");
});

test("buildManualRow: fit_evaluated_at set only when a fit is given", () => {
  assert.equal(buildManualRow(baseInput(), NOW).fit_evaluated_at, "");
  assert.equal(buildManualRow(baseInput({ fit: "Strong" }), NOW).fit_evaluated_at, NOW);
});

test("buildManualRow: propagates validation errors", () => {
  assert.throws(() => buildManualRow(baseInput({ status: "Inbox" }), NOW), /TSV-only/);
  assert.throws(() => buildManualRow(baseInput({ company: "" }), NOW), /--company is required/);
  assert.throws(() => buildManualRow(baseInput({ title: "  " }), NOW), /--title is required/);
});

// ---------- buildJobFields ----------

test("buildJobFields: keeps companyName for the resolver, formats salary via the shared helper", () => {
  const row = buildManualRow(
    baseInput({ salary: "140000-185000", locations: "Remote,United States" }),
    NOW
  );
  const fields = buildJobFields(row);
  assert.equal(fields.companyName, "LawnStarter");
  assert.equal(fields.key, row.key);
  assert.equal(fields.status, "Interview");
  assert.equal(fields.city, "Remote, United States");
  assert.equal(fields.state, "Any");
  assert.equal(fields.dateAdded, "2026-07-16");
  assert.equal(fields.salaryExpectations, "$140-185K ($165K mid)");
  assert.equal(fields.salaryMin, 140000);
});

test("buildJobFields: no salary → empty display string (buildProperties drops it)", () => {
  const fields = buildJobFields(buildManualRow(baseInput(), NOW));
  assert.equal(fields.salaryExpectations, "");
});

// ---------- normalization ----------

test("normalizeTitle: strips one seniority prefix, punctuation, extra space", () => {
  assert.equal(
    normalizeTitle("Senior Product Manager, Pricing & Monetization"),
    "product manager pricing monetization"
  );
  assert.equal(normalizeTitle("Sr.  Product   Manager"), "product manager");
  assert.equal(normalizeTitle("Product Manager"), "product manager");
});

test("normalizeTitle: only a leading prefix is stripped, not a mid-title word", () => {
  assert.equal(normalizeTitle("Product Manager, Senior Living"), "product manager senior living");
});

test("normalizeCompany: case and punctuation insensitive", () => {
  assert.equal(normalizeCompany("LawnStarter"), normalizeCompany("lawn starter"));
  assert.equal(normalizeCompany("Capital One (WD)"), "capitalonewd");
});

// ---------- findDuplicates ----------

const EXISTING = [
  {
    key: "manual:lawnstarter_senior-pm_2026-07-16",
    companyName: "LawnStarter",
    title: "Senior PM",
    status: "Interview",
  },
  { key: "greenhouse:gh:1", companyName: "Acme", title: "Product Manager", status: "To Apply" },
  { key: "greenhouse:gh:2", companyName: "LawnStarter", title: "Data Analyst", status: "Applied" },
  { key: "greenhouse:gh:3", companyName: "Oldco", title: "Product Manager", status: "Archived" },
];

test("findDuplicates: exact key match is reported", () => {
  const row = {
    key: "manual:lawnstarter_senior-pm_2026-07-16",
    companyName: "LawnStarter",
    title: "Senior PM",
  };
  const dupes = findDuplicates(EXISTING, row);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].reason, "exact key");
});

test("findDuplicates: same company + title on a different day is caught despite a different key", () => {
  const row = {
    key: "manual:lawnstarter_senior-pm_2026-07-20",
    companyName: "LawnStarter",
    title: "PM",
  };
  const dupes = findDuplicates(EXISTING, row);
  assert.equal(dupes.length, 1);
  assert.match(dupes[0].reason, /same company \+ title/);
  assert.match(dupes[0].reason, /status=Interview/);
});

test("findDuplicates: a genuinely different title at the same company is not a duplicate", () => {
  const row = {
    key: "manual:lawnstarter_x_2026-07-20",
    companyName: "LawnStarter",
    title: "Engineering Manager",
  };
  assert.deepEqual(findDuplicates(EXISTING, row), []);
});

test("findDuplicates: same title at a different company is not a duplicate", () => {
  const row = {
    key: "manual:other_pm_2026-07-20",
    companyName: "Other Co",
    title: "Product Manager",
  };
  assert.deepEqual(findDuplicates(EXISTING, row), []);
});

test("findDuplicates: archived rows are ignored — re-adding an old job is legitimate", () => {
  const row = { key: "manual:oldco_pm_2026-07-20", companyName: "Oldco", title: "Product Manager" };
  assert.deepEqual(findDuplicates(EXISTING, row), []);
});

test("findDuplicates: empty pool is safe", () => {
  assert.deepEqual(findDuplicates([], { key: "k", companyName: "C", title: "T" }), []);
  assert.deepEqual(findDuplicates(undefined, { key: "k", companyName: "C", title: "T" }), []);
});
