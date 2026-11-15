// BL-236: consent boxes the bot ticks (data processing, demographic survey)
// and the ones it must not (marketing opt-ins, conditions of the job).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { matchQuestion } = require("./question_match.js");

const OWNER = { legal_acknowledgements: "accept", relocation: { willing: false } };
const ask = (label, type = "checkbox", options = [], applyDefaults = OWNER) =>
  matchQuestion(
    { label, type, options, required: true },
    { applyDefaults, identity: { location: "Springfield, IL" } }
  );

test("consent: a marketing opt-in in the same sentence is never Yes", () => {
  for (const label of [
    "By checking this box, I agree to allow Acme to store and process my data and to send me SMS text messages about new roles.",
    "I consent to Acme storing my information and sending me a newsletter and job alerts.",
    "I agree to the Privacy Policy and to receive Acme's marketing emails.",
  ]) {
    const r = ask(label);
    assert.ok(!r || r.value !== "Yes", label);
  }
});

test("consent: a talent-community / future-contact opt-in is declined", () => {
  assert.equal(
    ask(
      "I consent to Acme retaining my data to contact me about future opportunities (talent community)"
    ).value,
    "No"
  );
});

test("consent: demographic survey consent is Yes, EEO questions stay on decline", () => {
  for (const label of [
    "By checking this box, I consent to Acme collecting, storing, and processing my responses to the self-identification questions about gender, race, veteran status and disability.",
    "By checking this box, I consent to D3 collecting, storing, and processing my responses to the demographic data surveys above.",
    "Storing and processing my demographic information",
    "I agree to Acme storing and processing my demographic information",
  ]) {
    assert.equal(ask(label).value, "Yes", label);
  }
  assert.equal(
    ask("Gender", "select", ["Male", "Female", "Decline To Self Identify"]).value,
    "Decline To Self Identify"
  );
  assert.equal(
    ask("Race", "select", ["Asian", "White", "I do not wish to answer"]).value,
    "I do not wish to answer"
  );
});

test("consent: the consent in the text of a radio option picks that option, not the SMS one", () => {
  const options = [
    "Yes, I consent to Acme processing and storing my personal data",
    "Yes, I consent to receive SMS text messages from Acme",
    "No, I do not consent",
  ];
  assert.equal(ask("Consent", "radio", options).value, options[0]);
  // Only marketing / negative options → nothing is picked.
  assert.equal(ask("Consent", "radio", [options[1], options[2]]), null);
});

test("consent: job conditions are not consent (office days, onsite, relocation)", () => {
  for (const label of [
    "I understand this role requires 3 days a week in office and I agree to store my commute details",
    "I am able to work onsite as described in the posting",
    "I agree to relocate to the Austin office",
  ]) {
    const r = ask(label);
    assert.ok(!r || r.value !== "Yes", label);
  }
});

test("consent: without the owner's policy nothing is ticked", () => {
  const r = ask("I consent to Acme storing and processing my data", "checkbox", [], {});
  assert.ok(!r || r.value !== "Yes");
});

// ---- round 2 of the review -------------------------------------------------

const DISABILITY_LABEL =
  "Disability status. By selecting an option you consent to the collection and processing of your self-identification responses";

test("consent: a disability / veteran radio never gets a Yes, I have ... option", () => {
  const dis = ask(DISABILITY_LABEL, "radio", [
    "Yes, I have a disability, or have had one in the past",
    "No, I do not have a disability",
    "I do not want to answer",
  ]);
  assert.equal(dis.value, "I do not want to answer");
  const vet = ask(
    "Protected veteran status. By selecting an option you consent to processing of your self-identification responses",
    "radio",
    ["Yes, I am a protected veteran", "No, I am not a protected veteran", "I don't wish to answer"]
  );
  assert.equal(vet.value, "I don't wish to answer");
  // Even with a bare Yes among the options, the disability radio is not ticked Yes.
  const bare = ask(DISABILITY_LABEL, "radio", ["Yes", "No", "Prefer not to say"]);
  assert.ok(!bare || bare.value !== "Yes");
});

test("consent: four future-roles phrasings are never Yes", () => {
  for (const label of [
    "I consent to Acme storing my information and emailing me about new roles",
    "I agree to Acme storing my data and sending me updates about future opportunities",
    "I agree to allow Acme to retain my data and notify me of future openings",
    "I agree to receive emails from Acme about future job openings and allow Acme to store my information",
  ]) {
    const r = ask(label);
    assert.ok(!r || r.value !== "Yes", label);
  }
});

test("consent: 'I do not consent to Acme storing my data' is never Yes", () => {
  for (const label of [
    "I do not consent to Acme storing my data",
    "I don't agree to Acme collecting and processing my information",
  ]) {
    const r = ask(label);
    assert.ok(!r || r.value !== "Yes", label);
  }
});

test("consent: a how-did-you-hear question mentioning email is not a marketing opt-in", () => {
  const r = ask("How did you hear about us? (email, LinkedIn, referral)", "select", [
    "Email",
    "LinkedIn",
    "Other",
  ]);
  // Unchanged from before: not answered by the legal matcher (no "No" pick).
  assert.equal(r, null);
});
