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

// Regression: 2026-04-30. "Match Group" emails were falsely matching to
// "IEX Group" because the prototype's tokens.some() picked the first entry
// whose token (just "group") appeared in the haystack. New score-based logic
// requires ALL tokens to match and prefers the entry with the highest token
// count.
test("findCompany: score-based match — Match Group beats IEX Group on shared 'Group' suffix", () => {
  const email = {
    from: "no-reply@hire.lever.co",
    subject: "Thank you for your application to Match Group",
    body: "",
  };
  const map = {
    "IEX Group": [{ role: "PM, Options", notion_id: "iex1" }],
    "Match Group": [{ role: "PM, Platform", notion_id: "match1" }],
  };
  const r = findCompany(email, map);
  assert.equal(r.company, "Match Group");
});

test("findCompany: short-form match — 'Veeva' email matches 'Veeva Systems' TSV row", () => {
  // Regression: when scoring required ALL tokens, this email was unmatched
  // because "Systems" wasn't present. Absolute-count scoring still wins
  // because it's the only entry with any token matched.
  const email = {
    from: "no-reply@hire.lever.co",
    subject: "Senior Product Manager - Vault Platform Access Control at Veeva",
    body: "",
  };
  const map = { "Veeva Systems": [{ role: "Senior PM, Vault", notion_id: "v1" }] };
  const r = findCompany(email, map);
  assert.equal(r.company, "Veeva Systems");
});

test("findCompany: count-based ranking — 2-token match beats 1-token match on shared suffix", () => {
  // Generic "Group" word in subject would tie both companies at score 1, but
  // when the email actually says "Match Group", Match Group scores 2 (both
  // tokens) and beats IEX Group's 1.
  const email = { from: "x@y.com", subject: "Update from Match Group", body: "" };
  const map = {
    "IEX Group": [{ role: "PM, Options", notion_id: "iex1" }],
    "Match Group": [{ role: "PM, Platform", notion_id: "match1" }],
  };
  const r = findCompany(email, map);
  assert.equal(r.company, "Match Group");
});

test("findCompany: company_aliases — Hinge email matches Match Group via alias", () => {
  const email = {
    from: "no-reply@hire.lever.co",
    subject: "Thank You from Hinge - Regarding your Application for Lead PM, Platform",
    body: "",
  };
  const map = {
    "Match Group": [{ role: "Lead PM, Platform", notion_id: "m1" }],
  };
  const aliases = { "Match Group": ["Hinge", "Tinder"] };
  const r = findCompany(email, map, aliases);
  assert.equal(r.company, "Match Group");
});

test("findCompany: alias-only match wins over no match", () => {
  // Only "Tinder" appears in the email, parent name "Match Group" doesn't.
  const email = { from: "ats@example.com", subject: "Update on your Tinder app", body: "" };
  const map = { "Match Group": [{ role: "PM", notion_id: "m1" }] };
  const aliases = { "Match Group": ["Hinge", "Tinder"] };
  const r = findCompany(email, map, aliases);
  assert.equal(r.company, "Match Group");
});

test("findCompany: aliases work via body word boundary too", () => {
  const email = {
    from: "ats@example.com",
    subject: "Update",
    body: "Thank you for applying at Hinge. After careful review.",
  };
  const map = { "Match Group": [{ role: "PM", notion_id: "m1" }] };
  const aliases = { "Match Group": ["Hinge"] };
  const r = findCompany(email, map, aliases);
  assert.equal(r.company, "Match Group");
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

// Regression: 2026-04-30. Hinge "Senior Lead PM, Matching" rejection email
// was falsely matched to "Lead PM, NUE" because the body said "candidates
// whose experience more closely matches" and "experience" was a keyword for
// the NUE role. Boilerplate words now in ROLE_MATCH_SKIP.
test("findRole: rejection-boilerplate words don't act as disambiguators", () => {
  const jobs = [
    { role: "Lead Product Manager, New User Experience", notion_id: "nue" },
    { role: "Lead Product Manager, Platform", notion_id: "plat" },
  ];
  const r = findRole(
    {
      subject: "Thank You from Hinge - Regarding your Application for Senior Lead Product Manager, Matching",
      body: "Hi Jared, after careful consideration we've decided to move forward with candidates whose experience more closely matches the role.",
    },
    jobs
  );
  // Neither "experience" (in NUE) nor "platform" (in Platform) should win;
  // body has "experience" only as boilerplate, not as a role signal.
  assert.equal(r.confidence, "LOW");
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
