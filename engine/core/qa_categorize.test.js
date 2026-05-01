const { test } = require("node:test");
const assert = require("node:assert/strict");

const { categorize, isValidCategory, CATEGORIES } = require("./qa_categorize.js");

test("CATEGORIES list matches Notion DB option set", () => {
  assert.deepEqual(
    CATEGORIES.sort(),
    ["Behavioral", "Culture Fit", "Experience", "Logistics", "Motivation", "Other", "Salary", "Technical"].sort()
  );
});

test("Motivation: classic 'Why do you want to join X' phrasings", () => {
  assert.equal(categorize("Why do you want to join Figma?"), "Motivation");
  assert.equal(categorize("Why are you interested in Linear?"), "Motivation");
  assert.equal(categorize("Why this role?"), "Motivation");
  assert.equal(categorize("Why us?"), "Motivation");
});

test("Motivation: what motivates / excites / look forward to", () => {
  assert.equal(categorize("What motivates you professionally?"), "Motivation");
  assert.equal(categorize("What excites you about this work?"), "Motivation");
  assert.equal(categorize("What do you look forward to about work every day?"), "Motivation");
  assert.equal(categorize("What drew you to product management?"), "Motivation");
});

test("Behavioral: influences / mentors / introspective questions", () => {
  assert.equal(categorize("Who are your biggest professional influences?"), "Behavioral");
  assert.equal(categorize("Who do you admire most in tech?"), "Behavioral");
  assert.equal(categorize("Tell me about a time you handled a conflict."), "Behavioral");
  assert.equal(categorize("Describe a situation where you disagreed with a manager."), "Behavioral");
  assert.equal(categorize("What's your biggest professional failure?"), "Behavioral");
});

test("Salary: comp / salary / pay / expectations", () => {
  assert.equal(categorize("What are your salary expectations?"), "Salary");
  assert.equal(categorize("What is your desired compensation?"), "Salary");
  assert.equal(categorize("Pay range expectations?"), "Salary");
  assert.equal(categorize("How much are you looking for?"), "Salary");
});

test("Logistics: visa / start date / work auth", () => {
  assert.equal(categorize("Do you require visa sponsorship?"), "Logistics");
  assert.equal(categorize("Are you legally authorized to work in the US?"), "Logistics");
  assert.equal(categorize("When can you start?"), "Logistics");
  assert.equal(categorize("What is your notice period?"), "Logistics");
  assert.equal(categorize("Are you willing to relocate to SF?"), "Logistics");
});

test("Technical: tools, stack, AI tools", () => {
  assert.equal(categorize("Tell me about your experience with SQL."), "Technical");
  assert.equal(categorize("What AI tools do you use daily?"), "Technical");
  assert.equal(categorize("Describe your technical background."), "Technical");
  assert.equal(categorize("Have you worked with Claude Code?"), "Technical");
});

test("Culture Fit: values / ideal team", () => {
  assert.equal(categorize("How do you like to work?"), "Culture Fit");
  assert.equal(categorize("Describe your ideal team environment."), "Culture Fit");
  assert.equal(categorize("What values matter most to you?"), "Culture Fit");
});

test("Experience: years, achievements, past roles", () => {
  assert.equal(categorize("How many years of experience do you have in product management?"), "Experience");
  assert.equal(categorize("What is your proudest professional achievement?"), "Experience");
  assert.equal(categorize("Tell me about your background."), "Experience");
});

test("Other: unrecognized prompts fall through", () => {
  assert.equal(categorize("Hello there."), "Other");
  assert.equal(categorize(""), "Other");
  assert.equal(categorize(null), "Other");
});

test("Salary takes priority over Motivation when both keywords present", () => {
  assert.equal(
    categorize("What are your salary expectations and why are you looking?"),
    "Salary"
  );
});

test("Logistics takes priority over Motivation for visa questions", () => {
  assert.equal(
    categorize("Why do you need visa sponsorship?"),
    "Logistics"
  );
});

test("isValidCategory accepts canonical names only", () => {
  assert.equal(isValidCategory("Motivation"), true);
  assert.equal(isValidCategory("motivation"), false);
  assert.equal(isValidCategory("Random"), false);
  assert.equal(isValidCategory(""), false);
});

// --- regression cases from RFC 009 code review --------------------------------

test("Motivation: 'Why <Company>?' for any company name", () => {
  // Fixed in review: hardcoded company list was too narrow.
  assert.equal(categorize("Why Notion?"), "Motivation");
  assert.equal(categorize("Why Anthropic?"), "Motivation");
  assert.equal(categorize("Why Vercel?"), "Motivation");
  assert.equal(categorize("Why join?"), "Motivation");
  assert.equal(categorize("Why apply?"), "Motivation");
});

test("Behavioral wins over Technical for 'experience with conflict'", () => {
  // Behavioral patterns run before Technical so STAR-style introspection
  // doesn't get pulled into Technical by the bare 'experience with' anchor.
  assert.equal(categorize("What's your experience with conflict resolution?"), "Behavioral");
  assert.equal(categorize("Describe your experience with disagreement on a team."), "Behavioral");
});

test("'code of conduct' / 'dress code' are not Technical", () => {
  // Bare \bcode\b was too noisy. Now scoped to 'source code' / 'code review' / 'writing code'.
  assert.equal(categorize("What's your code of conduct?"), "Other");
  assert.equal(categorize("Tell me about your dress code."), "Other");
});

test("Technical scoped 'code' patterns still match correctly", () => {
  assert.equal(categorize("How often do you do code review?"), "Technical");
  assert.equal(categorize("Have you written code in production?"), "Technical");
  assert.equal(categorize("How comfortable are you with source code reading?"), "Technical");
});

