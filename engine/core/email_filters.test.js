const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  isATS,
  matchesRecruiterSubject,
  isLevelBlocked,
  isLocationBlocked,
  isTSVDup,
} = require("./email_filters.js");

test("isATS: detects known ATS domains", () => {
  assert.ok(isATS("noreply@greenhouse-mail.io"));
  assert.ok(isATS("hire@hire.lever.co"));
  assert.ok(isATS("jobs@affirm.ashbyhq.com"));
  assert.ok(!isATS("recruiter@acme.com"));
  assert.ok(!isATS(""));
});

test("matchesRecruiterSubject: recruiter outreach patterns", () => {
  assert.ok(matchesRecruiterSubject("Requirement for Senior PM"));
  assert.ok(matchesRecruiterSubject("Immediate need for a Product Manager"));
  assert.ok(matchesRecruiterSubject("Exciting job opportunity"));
  assert.ok(matchesRecruiterSubject("Great fit for your background"));
  assert.ok(matchesRecruiterSubject("I'm reaching out about a role"));
  assert.ok(!matchesRecruiterSubject("Thanks for applying"));
  assert.ok(!matchesRecruiterSubject(""));
});

test("isLevelBlocked: substring match", () => {
  // Flat engine shape (post-normalization by profile_loader).
  const rules = { title_blocklist: [{ pattern: "intern" }, { pattern: "junior" }] };
  assert.ok(isLevelBlocked("Product Management Intern", rules));
  assert.ok(isLevelBlocked("Junior PM", rules));
  assert.ok(!isLevelBlocked("Senior PM", rules));
});

test("isLevelBlocked: no rules → false", () => {
  assert.ok(!isLevelBlocked("Any Title", {}));
  assert.ok(!isLevelBlocked("Any Title", null));
});

test("isLocationBlocked: substring match", () => {
  const rules = { location_blocklist: ["new york", "boston"] };
  assert.ok(isLocationBlocked("PM в компании X: New York, NY", rules));
  assert.ok(isLocationBlocked("Remote (Boston HQ)", rules));
  assert.ok(!isLocationBlocked("San Francisco", rules));
});

test("isTSVDup: matches by (company, role) composite", () => {
  const rows = [
    { companyName: "Affirm", title: "Product Manager, Risk" },
    { companyName: "Stripe", title: "PM, Growth" },
  ];
  assert.ok(isTSVDup("Affirm", "Product Manager, Risk", rows));
  assert.ok(isTSVDup("AFFIRM", "product manager, risk", rows)); // case-insensitive
  assert.ok(!isTSVDup("Affirm", "Different Role", rows));
  assert.ok(!isTSVDup("New Co", "PM", rows));
});

test("isTSVDup: supports legacy {company, role} shape", () => {
  const rows = [{ company: "Affirm", role: "PM" }];
  assert.ok(isTSVDup("Affirm", "PM", rows));
});
