const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  companyTokens,
  findCompany,
  findRole,
  matchEmailToApp,
  parseLevel,
  archetype,
} = require("./email_matcher.js");

test("companyTokens: strips LLC/Inc and short words", () => {
  assert.deepEqual(companyTokens("Affirm Inc."), ["affirm"]);
  assert.deepEqual(companyTokens("Block LLC"), ["block"]);
  assert.deepEqual(companyTokens("Acme Corp"), ["acme"]);
  assert.deepEqual(companyTokens("Checkpoint Software (WD)"), ["checkpoint", "software"]);
});

test("companyTokens: filters stop words and short tokens", () => {
  assert.deepEqual(companyTokens("The Home Depot").sort(), ["depot", "home"]);
  assert.deepEqual(companyTokens("And For The Inc"), []); // all stop words
});

test("findCompany: matches by from domain", () => {
  const email = { from: "recruiter@affirm.com", subject: "Update", body: "" };
  const map = { Affirm: [{ role: "PM", notion_id: "p1" }] };
  const r = findCompany(email, map);
  assert.equal(r.company, "Affirm");
});

test("findCompany: matches by subject", () => {
  const email = { from: "noreply@greenhouse.io", subject: "Your Stripe application", body: "" };
  const map = { Stripe: [{ role: "PM", notion_id: "p1" }] };
  const r = findCompany(email, map);
  assert.equal(r.company, "Stripe");
});

test("findCompany: matches body with word boundary (no false positive on 'next steps')", () => {
  const email = { from: "no@match.io", subject: "Update", body: "About your application to Affirm." };
  const map = { Affirm: [{ role: "PM", notion_id: "p1" }] };
  const r = findCompany(email, map);
  assert.equal(r.company, "Affirm");
});

test("findCompany: returns null when no company matches", () => {
  const email = { from: "x@y.com", subject: "Hello", body: "random body" };
  const map = { Affirm: [{ role: "PM", notion_id: "p1" }] };
  assert.equal(findCompany(email, map), null);
});

test("findRole: single job → HIGH", () => {
  const jobs = [{ role: "PM, Growth", notion_id: "p1" }];
  const r = findRole({ subject: "Update", body: "" }, jobs);
  assert.equal(r.confidence, "HIGH");
  assert.equal(r.job.notion_id, "p1");
});

test("findRole: multi-job → disambiguates on exact title", () => {
  const jobs = [
    { role: "Product Manager, Growth", notion_id: "p1" },
    { role: "Product Manager, Risk", notion_id: "p2" },
  ];
  const r = findRole({ subject: "Re: Product Manager, Risk", body: "" }, jobs);
  assert.equal(r.confidence, "HIGH");
  assert.equal(r.job.notion_id, "p2");
});

test("findRole: multi-job → keyword disambiguation", () => {
  const jobs = [
    { role: "Product Manager, Growth", notion_id: "p1" },
    { role: "Product Manager, Credit Risk", notion_id: "p2" },
  ];
  const r = findRole({ subject: "Credit opening", body: "" }, jobs);
  assert.equal(r.confidence, "HIGH");
  assert.equal(r.job.notion_id, "p2");
});

test("findRole: multi-job with no differentiating signal → LOW, first job", () => {
  const jobs = [
    { role: "Senior Product Manager", notion_id: "p1" },
    { role: "Staff Product Manager", notion_id: "p2" },
  ];
  const r = findRole({ subject: "Hello", body: "Generic body." }, jobs);
  assert.equal(r.confidence, "LOW");
  assert.equal(r.job.notion_id, "p1");
});

test("matchEmailToApp: composes company + role", () => {
  const map = { Affirm: [{ role: "PM, Risk", notion_id: "p1" }] };
  const r = matchEmailToApp({ from: "r@affirm.com", subject: "Update", body: "" }, map);
  assert.equal(r.company, "Affirm");
  assert.equal(r.confidence, "HIGH");
  assert.equal(r.job.notion_id, "p1");
});

test("matchEmailToApp: returns null when company not found", () => {
  const r = matchEmailToApp({ from: "x@y.com", subject: "", body: "" }, { Affirm: [] });
  assert.equal(r, null);
});

test("parseLevel: title patterns", () => {
  assert.equal(parseLevel("Principal PM"), "Principal");
  assert.equal(parseLevel("Staff Engineer"), "Staff");
  assert.equal(parseLevel("Director of Product"), "Director");
  assert.equal(parseLevel("Product Lead"), "Lead");
  assert.equal(parseLevel("Senior PM"), "Senior");
  assert.equal(parseLevel("Sr. PM"), "Senior");
  assert.equal(parseLevel("PM"), "Mid");
  assert.equal(parseLevel(""), "Mid");
});

test("archetype: strips CV_Jared_Moore_ prefix", () => {
  assert.equal(archetype("CV_Jared_Moore_Risk_Fraud"), "Risk_Fraud");
  assert.equal(archetype(""), "—");
  assert.equal(archetype(undefined), "—");
});
