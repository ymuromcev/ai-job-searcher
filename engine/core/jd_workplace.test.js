const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyJdWorkplace,
  jdWorkplaceVerdict,
  needsJdWorkplaceCheck,
  extractPlaces,
  htmlToText,
} = require("./jd_workplace.js");

function verdict(jd, home = "CA") {
  return jdWorkplaceVerdict(classifyJdWorkplace(jd), home);
}

// --- needsJdWorkplaceCheck ---------------------------------------------------

test("needsJdWorkplaceCheck: only non-home-state geo passes are checked", () => {
  assert.equal(needsJdWorkplaceCheck("us_unspecified"), true);
  assert.equal(needsJdWorkplaceCheck("remote:location"), true);
  assert.equal(needsJdWorkplaceCheck("remote:title"), true);
  assert.equal(needsJdWorkplaceCheck("home_state:CA"), false);
  assert.equal(needsJdWorkplaceCheck("remote:structured"), false);
  assert.equal(needsJdWorkplaceCheck(null), false);
  assert.equal(needsJdWorkplaceCheck(undefined), false);
});

// --- Remote → keep -------------------------------------------------------------

test("remote: 'Remote (US) — candidates in CA, WA, NY' → remote, keep", () => {
  const jd = "About the role\nRemote (US) — candidates in CA, WA, NY.\nYou will own pricing.";
  const c = classifyJdWorkplace(jd);
  assert.equal(c.workplace, "remote");
  assert.equal(verdict(jd).drop, false);
});

test("remote: fully remote / remote-first / role is remote", () => {
  for (const jd of [
    "This is a fully remote role reporting to the Head of Product.",
    "We are a remote-first company with teammates in 20 states.",
    "This role is remote, based in the US.",
    "This position can be worked remotely from anywhere in the United States.",
    "#LI-Remote",
  ]) {
    assert.equal(classifyJdWorkplace(jd).workplace, "remote", jd);
    assert.equal(verdict(jd).drop, false, jd);
  }
});

test("remote: structured SCHEDULE header wins", () => {
  const jd =
    "TITLE: Senior PM\nLOCATION: United States\nSCHEDULE: Full-time · Remote\n\nWe have offices in New York.";
  assert.equal(classifyJdWorkplace(jd).workplace, "remote");
  assert.equal(verdict(jd).drop, false);
});

test("remote: a remote option beats a hybrid mention ('San Francisco, CA or Remote (U.S.)')", () => {
  const jd =
    "LOCATION: Chicago, IL or Remote, USA\n\nOur Chicago team works a hybrid schedule in our River North office.";
  assert.equal(classifyJdWorkplace(jd).workplace, "remote");
  assert.equal(verdict(jd).drop, false);
});

// --- Hybrid / onsite in the home state → keep ---------------------------------

test("hybrid in CA: 'Hybrid, 3 days/week in our San Francisco office' → keep", () => {
  const jd = "Hybrid, 3 days/week in our San Francisco office.";
  const c = classifyJdWorkplace(jd);
  assert.equal(c.workplace, "hybrid");
  assert.deepEqual(c.offices, ["CA"]);
  assert.equal(verdict(jd).drop, false);
});

test("hybrid in CA: 'based in San Francisco, CA … hybrid work model of three days' → keep", () => {
  const jd =
    "This role is based in San Francisco, CA. We use a hybrid work model of three days in the office per week and offer relocation assistance.";
  const c = classifyJdWorkplace(jd);
  assert.equal(c.workplace, "hybrid");
  assert.deepEqual(c.offices, ["CA"]);
  assert.equal(verdict(jd).drop, false);
});

test("hybrid with several offices including CA → keep", () => {
  const jd =
    "This role is based in our Menlo Park, CA or New York City, NY office, with in-person attendance expected at least 3 days per week.";
  const c = classifyJdWorkplace(jd);
  assert.equal(c.workplace, "hybrid");
  assert.deepEqual(c.offices, ["CA", "NY"]);
  assert.equal(verdict(jd).drop, false);
});

test("onsite in CA: 'Location: Mountain View, CA. Onsite.' → keep", () => {
  const jd = "<p><strong>Location: </strong>Mountain View, CA. Onsite. 15 minutes from campus.</p>";
  const c = classifyJdWorkplace(jd);
  assert.equal(c.workplace, "onsite");
  assert.deepEqual(c.offices, ["CA"]);
  assert.equal(verdict(jd).drop, false);
});

// --- Hybrid / onsite outside the home state → drop -----------------------------

test("hybrid out of state: 'Hybrid in Austin, TX' → drop geo_jd_not_remote", () => {
  const jd = "Senior Product Manager\nHybrid in Austin, TX.\nYou will own onboarding.";
  const c = classifyJdWorkplace(jd);
  assert.equal(c.workplace, "hybrid");
  assert.deepEqual(c.offices, ["TX"]);
  assert.deepEqual(verdict(jd), { drop: true, reason: "geo_jd_not_remote" });
});

test("hybrid out of state: SF-style office sentence for New York → drop", () => {
  const jd =
    "<p><strong>This role is hybrid, which requires being in our New York office 3 days a week: Monday, Tuesday and Thursday.</strong></p>";
  const c = classifyJdWorkplace(jd);
  assert.equal(c.workplace, "hybrid");
  assert.deepEqual(c.offices, ["NY"]);
  assert.equal(verdict(jd).drop, true);
});

test("hybrid out of state: structured SCHEDULE + LOCATION header → drop", () => {
  const jd = "TITLE: PM\nLOCATION: New York\nSCHEDULE: Full-time · Hybrid\n\nAbout us.";
  assert.equal(classifyJdWorkplace(jd).workplace, "hybrid");
  assert.equal(verdict(jd).drop, true);
});

test("onsite out of state: on-site four days a week in Chicago → drop", () => {
  const jd =
    "We are looking for a leader who is committed to joining our team on-site in Chicago four days a week.";
  const c = classifyJdWorkplace(jd);
  assert.equal(c.workplace, "hybrid");
  assert.deepEqual(c.offices, ["IL"]);
  assert.equal(verdict(jd).drop, true);
});

test("onsite out of state: office-first, no remote roles, Chicago office → drop", () => {
  const jd =
    "<p>This role is based out of our Chicago office. We are an office-first company; we do not offer remote-only roles.</p>";
  const c = classifyJdWorkplace(jd);
  assert.equal(c.workplace, "onsite");
  assert.deepEqual(c.offices, ["IL"]);
  assert.equal(verdict(jd).drop, true);
});

test("onsite out of state: 'This role is based in Boston, MA 5 days a week' → drop", () => {
  const jd = "This role is based in Boston, MA 5 days a week.";
  const c = classifyJdWorkplace(jd);
  assert.equal(c.workplace, "onsite");
  assert.deepEqual(c.offices, ["MA"]);
  assert.equal(verdict(jd).drop, true);
});

test("hybrid abroad: non-US office counts as outside the home state", () => {
  const jd = "This role is based in Warsaw with an office-centric hybrid schedule.";
  const c = classifyJdWorkplace(jd);
  assert.equal(c.workplace, "hybrid");
  assert.deepEqual(c.offices, ["INTL"]);
  assert.equal(verdict(jd).drop, true);
});

// --- Unknown / no named office → keep -------------------------------------------

test("unknown: JD with no workplace wording → keep", () => {
  const jd = "Senior PM\nRequirements:\n- 5+ years of product management\n- SQL";
  assert.equal(classifyJdWorkplace(jd).workplace, "unknown");
  assert.equal(verdict(jd).drop, false);
});

test("hybrid with no named office → keep (do not over-filter)", () => {
  const jd = "We are a hybrid company with a focus on in-person collaboration when necessary.";
  const c = classifyJdWorkplace(jd);
  assert.equal(c.workplace, "hybrid");
  assert.deepEqual(c.offices, []);
  assert.equal(verdict(jd).drop, false);
});

test("empty / null JD → unknown, keep", () => {
  assert.equal(classifyJdWorkplace("").workplace, "unknown");
  assert.equal(classifyJdWorkplace(null).workplace, "unknown");
  assert.equal(verdict(null).drop, false);
});

// --- Noise is ignored ----------------------------------------------------------

test("noise: perks, interviews, pay ranges and EEO lines do not set the workplace", () => {
  const jd = [
    "Virtual “Onsite” consisting of 3-4, 45 min video interviews",
    "Catered lunches & dinners for hybrid employees",
    "Commuter benefits for in-office employees (Chicago)",
    '<div class="title">New York, NY (Hybrid) Pay Range</div>',
    "We ensure all members of our team can contribute, whether they are working on-site, in a hybrid model, or fully remotely.",
    "Experience with hybrid environments (Azure, AWS, GCP).",
    "The product behaves like a hybrid of social and gaming platforms.",
  ].join("\n");
  const c = classifyJdWorkplace(jd);
  assert.equal(c.workplace, "unknown");
  assert.deepEqual(c.offices, []);
  assert.equal(verdict(jd).drop, false);
});

test("noise: a negated remote ('this role is not remote') is not remote", () => {
  const jd = "This role is not remote. You'll work from our Denver, CO office.";
  const c = classifyJdWorkplace(jd);
  assert.equal(c.workplace, "onsite");
  assert.deepEqual(c.offices, ["CO"]);
  assert.equal(verdict(jd).drop, true);
});

// --- Verdict ----------------------------------------------------------------------

test("jdWorkplaceVerdict: home state accepts code or full name; bad input keeps", () => {
  const c = { workplace: "hybrid", offices: ["CA"] };
  assert.equal(jdWorkplaceVerdict(c, "California").drop, false);
  assert.equal(jdWorkplaceVerdict({ workplace: "onsite", offices: ["TX"] }, "ca").drop, true);
  assert.equal(jdWorkplaceVerdict({ workplace: "onsite", offices: ["TX"] }, "").drop, false);
  assert.equal(jdWorkplaceVerdict(null, "CA").drop, false);
  assert.equal(jdWorkplaceVerdict({ workplace: "remote", offices: ["TX"] }, "CA").drop, false);
});

// --- Helpers ------------------------------------------------------------------------

test("extractPlaces: City, ST / city table / state names / DC / Canada", () => {
  assert.deepEqual([...extractPlaces("Austin, TX")], ["TX"]);
  assert.deepEqual([...extractPlaces("our San Francisco office")], ["CA"]);
  assert.deepEqual([...extractPlaces("Salt Lake City, Utah")].sort(), ["UT"]);
  assert.deepEqual([...extractPlaces("Washington, D.C. office")], ["DC"]);
  assert.deepEqual([...extractPlaces("West Virginia")], ["WV"]);
  assert.ok(extractPlaces("Toronto, ON, CA").has("INTL"));
  assert.ok(!extractPlaces("Toronto, ON, CA").has("CA"));
  // Ordinary capitalized words next to a comma are not state codes.
  assert.deepEqual([...extractPlaces("Hybrid, In office")], []);
});

test("htmlToText: strips tags and decodes common entities", () => {
  assert.equal(htmlToText("<p>A &amp; B&nbsp;C</p>").trim(), "A & B C");
});
