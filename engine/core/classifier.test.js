const { test } = require("node:test");
const assert = require("node:assert/strict");

const { classify } = require("./classifier.js");

test("classify: rejection phrases → REJECTION", () => {
  const cases = [
    "Unfortunately, we have decided to move forward with other candidates.",
    "We won't be moving forward with your application at this time.",
    "After careful consideration, we have chosen another candidate.",
    "The position has been filled.",
    "We're not proceeding with your application.",
  ];
  for (const body of cases) {
    const r = classify({ subject: "Application update", body });
    assert.equal(r.type, "REJECTION", `failed: ${body}`);
    assert.ok(r.evidence, "evidence missing");
  }
});

test("classify: interview invites → INTERVIEW_INVITE", () => {
  const cases = [
    "We'd like to schedule a phone screen with you next week.",
    "Could you share your availability for an interview?",
    "Please book a time on my Calendly.",
    "Next steps in the process: a 30-minute chat.",
  ];
  for (const body of cases) {
    const r = classify({ subject: "Next steps", body });
    assert.equal(r.type, "INTERVIEW_INVITE", `failed: ${body}`);
  }
});

test("classify: assessments / challenges → INFO_REQUEST", () => {
  const r1 = classify({ subject: "Assessment link", body: "Please complete the following assessment." });
  assert.equal(r1.type, "INFO_REQUEST");
  const r2 = classify({ subject: "Take-home", body: "Here is your take-home coding challenge." });
  assert.equal(r2.type, "INFO_REQUEST");
});

test("classify: application acknowledgments → ACKNOWLEDGMENT", () => {
  const r = classify({
    subject: "Thank you for applying",
    body: "We have received your application and it's under review.",
  });
  assert.equal(r.type, "ACKNOWLEDGMENT");
});

test("classify: empty/unknown → OTHER", () => {
  assert.equal(classify({ subject: "", body: "" }).type, "OTHER");
  assert.equal(classify({}).type, "OTHER");
  assert.equal(classify({ subject: "Hello", body: "Just checking in." }).type, "OTHER");
});

test("classify: rejection beats interview when both present (first-match wins)", () => {
  const r = classify({
    subject: "Interview update",
    body: "Unfortunately we will not be scheduling an interview.",
  });
  assert.equal(r.type, "REJECTION");
});

test("classify: evidence contains matched phrase", () => {
  const r = classify({ subject: "Update", body: "Unfortunately, not a match." });
  assert.equal(r.type, "REJECTION");
  assert.match(r.evidence, /unfortunately/i);
});

// Regression: 2026-04-30. Headway rejection ("we've decided not to move
// forward with your application") was classified as OTHER because none of the
// patterns covered "decided not to move forward" / "not to move forward".
test("classify: 'decided not to move forward' → REJECTION (Headway pattern)", () => {
  const r = classify({
    subject: "Thank you from Headway",
    body:
      "While we appreciate your interest, after careful review we've decided " +
      "not to move forward with your application at this time.",
  });
  assert.equal(r.type, "REJECTION");
});

test("classify: 'will not be moving forward' → REJECTION", () => {
  const r = classify({
    subject: "Update",
    body: "We will not be moving forward with your candidacy.",
  });
  assert.equal(r.type, "REJECTION");
});

test("classify: 'application was not selected' → REJECTION", () => {
  const r = classify({
    subject: "In regards to your application",
    body: "After review by our team, your application was not selected for further consideration.",
  });
  assert.equal(r.type, "REJECTION");
});

// Regression: 2026-04-30 incident. ATS confirmation emails (Greenhouse, Ashby,
// Figma, Lever) all contain the boilerplate "If you are not selected for this
// position, keep an eye on our jobs page". The bare /not selected/i pattern
// caught this conditional and incorrectly produced REJECTION. After fix:
// /not selected/i removed; the more specific /your application was not
// selected/i kept. These 5 fixtures are real production emails from the
// 2026-04-30 mis-classification incident. See incidents.md.
test("classify: ATS confirmation 'if you are not selected' → ACKNOWLEDGMENT (incident 2026-04-30)", () => {
  const fixtures = [
    {
      label: "Headway (Greenhouse)",
      subject: "Thank you for applying to Headway",
      body:
        "Thank you for your interest in Headway! We have received your application " +
        "for Senior Product Manager, Client Engagement and are delighted that you " +
        "would consider joining our team.\n\n" +
        "The Recruiting team will review your application and will be in touch if " +
        "your qualifications match our needs at this time. If you are not selected " +
        "for this position, keep an eye on our careers page.",
    },
    {
      label: "Hopper (Ashby)",
      subject: "Jared, thanks for applying to Hopper!",
      body:
        "Thank you for your interest in joining the team at Hopper! We truly " +
        "appreciate the time and effort you put into submitting your application. " +
        "We will be in touch if your qualifications match our needs for the role. " +
        "If you are not selected for this position, keep an eye on our careers page.",
    },
    {
      label: "Figma (Greenhouse) — AI Platform",
      subject: "Thank you for your application to Figma",
      body:
        "Thank you for your interest in Figma! We wanted to let you know we received " +
        "your application for Product Manager, AI Platform, and we are delighted " +
        "that you would consider joining our team. While we're not able to respond " +
        "to every applicant, our recruiting team will contact you if your skills and " +
        "experience are a strong match for the role. If you are not selected for " +
        "this position, keep an eye on our jobs page.",
    },
    {
      label: "Figma (Greenhouse) — Figma Weave",
      subject: "Thank you for your application to Figma",
      body:
        "Thank you for your interest in Figma! We wanted to let you know we received " +
        "your application for Product Manager, Figma Weave (New York, United States). " +
        "If you are not selected for this position, keep an eye on our jobs page.",
    },
    {
      label: "WHOOP (Lever)",
      subject: "Thank you for your application to WHOOP",
      body:
        "Thank you for your interest in WHOOP! We wanted to let you know we received " +
        "your application for our Senior Product Manager, AI role. We will review " +
        "your application and get in touch if your qualifications match our needs " +
        "for the role. If you are not selected for this position, keep an eye on our " +
        "jobs page.",
    },
  ];
  for (const f of fixtures) {
    const r = classify({ subject: f.subject, body: f.body });
    assert.equal(
      r.type,
      "ACKNOWLEDGMENT",
      `${f.label}: expected ACKNOWLEDGMENT, got ${r.type} (evidence: "${r.evidence}")`
    );
  }
});

test("classify: specific 'your application was not selected' still caught (no regression)", () => {
  const r = classify({
    subject: "Update on your application",
    body: "After careful consideration, your application was not selected at this time.",
  });
  assert.equal(r.type, "REJECTION");
});
