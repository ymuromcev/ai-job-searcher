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
