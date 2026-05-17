const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  ATS_DOMAINS,
  isATS,
  atsFromInclusions,
  atsFromExclusions,
  isJobAlert,
  isNonPipelineSender,
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

// RFC 029 — ATS sender coverage. dentemploy and other small-business ATS
// senders must be detected so check.js fetches them via the dedicated batch.
test("isATS: dentemploy and other ATS additions (RFC 029)", () => {
  assert.ok(isATS("interview@dentemploy.com"));
  assert.ok(isATS("hello@send.applicantemails.com"));
  assert.ok(isATS("notify@paycomonline.com"));
  assert.ok(isATS("hr@breezy.hr"));
  assert.ok(isATS("noreply@gem.com"));
  assert.ok(isATS("ats@paradox.ai"));
  assert.ok(isATS("hire@eightfold.ai"));
  assert.ok(isATS("workday@myworkday.com"));
});

test("atsFromInclusions: returns from:() with all ATS_DOMAINS joined", () => {
  const out = atsFromInclusions();
  assert.ok(out.startsWith("from:("));
  assert.ok(out.endsWith(")"));
  // Parse OR-joined inner list — should round-trip back to ATS_DOMAINS exactly.
  const inner = out.slice("from:(".length, -1);
  const parsed = inner.split(" OR ");
  assert.deepEqual(parsed, ATS_DOMAINS);
});

test("atsFromExclusions: returns -from:<each> for all ATS_DOMAINS", () => {
  const out = atsFromExclusions();
  for (const d of ATS_DOMAINS) {
    assert.ok(out.includes(`-from:${d}`), `${d} should be excluded`);
  }
  // No bare "-from:greenhouse" — every entry must have the full domain.
  assert.ok(!/-from:greenhouse(\s|$)/.test(out));
  assert.ok(!/-from:lever(\s|$)/.test(out));
});

test("ATS_DOMAINS: no duplicates", () => {
  const set = new Set(ATS_DOMAINS);
  assert.equal(set.size, ATS_DOMAINS.length, "ATS_DOMAINS must be deduped");
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

// Regression: Lilia incident 2026-05-02. Indeed match-alert digests
// embed JD body text and got falsely classified. They must skip the
// pipeline entirely.
test("isJobAlert: Indeed match-alert digests by sender domain", () => {
  assert.ok(isJobAlert("donotreply@match.indeed.com", "5 more new jobs for you"));
  assert.ok(isJobAlert("noreply@match.indeed.com", "Front desk receptionist - new jobs"));
  assert.ok(isJobAlert("alert@indeed.com", "Jobs matching your search"));
});

test("isJobAlert: LinkedIn job-alerts (consolidated source-of-truth)", () => {
  assert.ok(isJobAlert("jobalerts-noreply@linkedin.com", "New PM jobs in Sacramento"));
});

// Regression 2026-05-12: Jared 30-day probe surfaced 3 Jobot Alerts
// digests on alerts.jobot.com — must be filtered upstream, not classified.
// Real recruiter outreach on @jobot.com (no `alerts.`) still flows through.
test("isJobAlert: Jobot Alerts proactive digests on alerts.jobot.com", () => {
  assert.ok(
    isJobAlert('"Jobot Alerts" <jobs@alerts.jobot.com>', "New opportunity as a Product Manager")
  );
  assert.ok(
    isJobAlert("jobs@alerts.jobot.com", "Keep Going With More Jobs Like Account Executive")
  );
  assert.ok(
    isJobAlert(
      "jobs@alerts.jobot.com",
      "Head of Enterprise Business Development opportunities need to be filled"
    )
  );
  // Genuine recruiter on bare jobot.com → NOT a job alert
  assert.ok(!isJobAlert("recruiter@jobot.com", "Reaching out about a PM role"));
});

test("isJobAlert: subject-only patterns (any sender)", () => {
  assert.ok(isJobAlert("anyone@example.com", "Medical Assistant + 12 more new jobs"));
  assert.ok(isJobAlert("anyone@example.com", "5 new jobs matching your search"));
  assert.ok(isJobAlert("anyone@example.com", "New jobs for you this week"));
});

test("isJobAlert: regular emails are NOT job alerts", () => {
  assert.ok(!isJobAlert("recruiter@kaiser.org", "Phone screen invitation"));
  assert.ok(!isJobAlert("noreply@greenhouse-mail.io", "Thank you for applying"));
  assert.ok(!isJobAlert("", ""));
  // ZipRecruiter sender but a real recruiter outreach (no alert keywords) →
  // not classified as alert. Subject is a prereq for ZR rule.
  assert.ok(!isJobAlert("recruiter@ziprecruiter.com", "Following up on your application"));
});

// Regression: Lilia incident 2026-05-02. Wells Fargo "We received your
// claim inquiry" reply was misread because the body language overlaps
// with ACKNOWLEDGMENT patterns.
test("isNonPipelineSender: banks/utilities/insurance must be skipped", () => {
  assert.ok(isNonPipelineSender("wellsfargo@notify.wellsfargo.com"));
  assert.ok(isNonPipelineSender("alerts@chase.com"));
  assert.ok(isNonPipelineSender("statements@bankofamerica.com"));
  assert.ok(isNonPipelineSender("noreply@geico.com"));
  assert.ok(isNonPipelineSender("billing@xfinity.com"));
});

// Regression 2026-05-12: bot's own Notion comments cause feedback loop —
// Notion mails the user about new comments, body quotes our "Subject:
// ...First Round Interview..." line, classifier re-fires INTERVIEW_INVITE,
// matcher cross-binds to a different pipeline row. Must skip upstream.
test("isNonPipelineSender: Notion notification echoes must be skipped", () => {
  assert.ok(isNonPipelineSender('"Notion Team" <notify@mail.notion.so>'));
  assert.ok(isNonPipelineSender("notify@mail.notion.so"));
  assert.ok(isNonPipelineSender("anyone@mail.notion.so"));
});

test("isNonPipelineSender: real recruiter / ATS senders are NOT skipped", () => {
  assert.ok(!isNonPipelineSender("recruiter@kaiser.org"));
  assert.ok(!isNonPipelineSender("noreply@greenhouse-mail.io"));
  assert.ok(!isNonPipelineSender("hire@lever.co"));
  assert.ok(!isNonPipelineSender(""));
});
