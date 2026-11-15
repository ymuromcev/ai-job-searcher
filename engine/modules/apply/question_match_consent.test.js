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
