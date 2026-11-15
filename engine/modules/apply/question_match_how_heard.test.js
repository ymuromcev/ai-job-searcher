// BL-241: "how did you hear about this role" — the owner's AI job search
// assistant found it. Pick an "AI assistant" option when the form offers one,
// otherwise the old order (company site, job board, Other); free text gets
// the owner's sentence.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { matchQuestion, choicePolicy } = require("./question_match.js");

const OWNER = {
  how_did_you_hear_default: "My AI job search assistant found this role for me.",
  choice_policy: {
    how_did_you_hear: [
      "ai assistant",
      "ai tool",
      "company website",
      "website",
      "job board",
      "other",
    ],
  },
};
const ask = (
  type,
  options = [],
  applyDefaults = OWNER,
  label = "How did you hear about this role?"
) => matchQuestion({ label, type, options, required: true }, { applyDefaults, identity: {} });

const ALCHEMY = [
  "LinkedIn - job post",
  "Twitter/X",
  "Alchemy Website",
  "BuiltIn",
  "AI assistant (ChatGPT, Gemini, Claude, etc)",
  "Recruiter Reached Out to Me",
  "Other",
];

test("how-heard: an AI assistant option is picked first", () => {
  for (const type of ["select", "radio"]) {
    assert.equal(ask(type, ALCHEMY).value, "AI assistant (ChatGPT, Gemini, Claude, etc)", type);
  }
});

test("how-heard: no AI option → company website, then Other", () => {
  assert.equal(ask("select", ["LinkedIn", "Acme Website", "Other"]).value, "Acme Website");
  assert.equal(ask("select", ["LinkedIn", "Referral", "Other"]).value, "Other");
});

test("how-heard: free text gets the owner's sentence", () => {
  const r = ask("text");
  assert.equal(r.value, "My AI job search assistant found this role for me.");
  assert.doesNotMatch(r.value, /\b(bot|automat|script|submitted|applied for me)\b/i);
});

test("how-heard: 'ai' never matches inside another word (Email, Retail)", () => {
  assert.equal(ask("select", ["Email", "Retail store", "Other"]).value, "Other");
});

test("how-heard: without the profile policy the engine order stays (no AI first)", () => {
  assert.equal(ask("select", ALCHEMY, {}).value, "Alchemy Website");
});

test("how-heard: choicePolicy hands the adapter the profile's list", () => {
  assert.deepEqual(
    choicePolicy({ applyDefaults: OWNER }).how_did_you_hear,
    OWNER.choice_policy.how_did_you_hear
  );
});
