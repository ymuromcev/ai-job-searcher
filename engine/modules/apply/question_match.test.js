const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  matchQuestion,
  pickOption,
  pickDeclineOption,
  normalizeLabel,
  splitName,
} = require("./question_match.js");

const CTX = {
  identity: {
    name: "Test Candidate Example",
    email: "candidate@example.com",
    phone: "+1 555 010 0000",
    location: "Springfield, IL",
    linkedin: "linkedin.com/in/example",
  },
  applyDefaults: {
    work_authorization: {
      authorized_us: true,
      requires_sponsorship: false,
      status_text: "US Permanent Resident",
    },
    relocation: { willing: false },
    eeo: { policy: "decline" },
    salary: { floor: 120000, default: 180000 },
    how_did_you_hear_default: "Company careers page",
  },
  salary: { value: 180000, low: 150000, high: 180000 },
};

const text = (label, extra = {}) => ({
  id: "x",
  label,
  type: "text",
  required: true,
  options: [],
  ...extra,
});
const select = (label, options) => ({ id: "x", label, type: "select", required: true, options });
const m = (field) => matchQuestion(field, CTX);

test("normalizeLabel strips required markers and punctuation", () => {
  assert.equal(normalizeLabel("First Name*"), "first name");
  assert.equal(normalizeLabel("Resume/CV ✱"), "resume/cv");
  assert.equal(normalizeLabel("Location (City)"), "location city");
});

test("splitName: first token / rest", () => {
  assert.deepEqual(splitName("Test Candidate Example"), {
    first: "Test",
    last: "Candidate Example",
  });
  assert.deepEqual(splitName(""), { first: "", last: "" });
});

test("identity fields", () => {
  assert.deepEqual(m(text("First Name")), { source: "identity", value: "Test" });
  assert.deepEqual(m(text("Preferred First Name")), { source: "identity", value: "Test" });
  assert.deepEqual(m(text("Last Name")), { source: "identity", value: "Candidate Example" });
  assert.deepEqual(m(text("Preferred Last Name")), {
    source: "identity",
    value: "Candidate Example",
  });
  assert.deepEqual(m(text("Full name")), { source: "identity", value: "Test Candidate Example" });
  assert.deepEqual(m(text("Legal Name")), { source: "identity", value: "Test Candidate Example" });
  assert.deepEqual(m(text("Email")), { source: "identity", value: "candidate@example.com" });
  assert.deepEqual(m(text("Phone")), { source: "identity", value: "+1 555 010 0000" });
  assert.deepEqual(m(text("LinkedIn Profile")), {
    source: "identity",
    value: "https://linkedin.com/in/example",
  });
  assert.deepEqual(m(text("Location (City)")), { source: "identity", value: "Springfield, IL" });
  assert.deepEqual(m(text("From where do you intend to work?")), {
    source: "identity",
    value: "Springfield, IL",
  });
  assert.deepEqual(m(text("Where do you plan on working from (for payroll tax purposes)?")), {
    source: "identity",
    value: "Springfield, IL",
  });
});

test("missing identity value → null (not a guess)", () => {
  assert.equal(m(text("Website")), null);
});

test("country select picks the US option with a dial-code suffix", () => {
  assert.deepEqual(m(select("Country", ["Canada +1", "United States +1"])), {
    source: "defaults",
    value: "United States +1",
  });
});

test("work authorization and sponsorship (yes/no + verbose options)", () => {
  assert.deepEqual(
    m(select("Are you legally authorized to work in the United States?", ["Yes", "No"])),
    {
      source: "defaults",
      value: "Yes",
    }
  );
  assert.deepEqual(
    m(
      select(
        "Will you now or in the future require sponsorship for employment visa status (e.g., H-1B)?",
        ["Yes", "No"]
      )
    ),
    { source: "defaults", value: "No" }
  );
  assert.deepEqual(
    m(
      select("Do you require visa sponsorship?", [
        "Yes, I will require sponsorship",
        "No, I will not require sponsorship",
      ])
    ),
    { source: "defaults", value: "No, I will not require sponsorship" }
  );
  assert.deepEqual(m(text("What is your current work authorization status?", { type: "text" })), {
    source: "defaults",
    value: "US Permanent Resident",
  });
  // Authorization for another country is not covered by the defaults.
  assert.equal(m(select("Are you authorized to work in Canada?", ["Yes", "No"])), null);
});

test("relocation", () => {
  assert.deepEqual(m(select("Are you willing to relocate?", ["Yes", "No"])), {
    source: "defaults",
    value: "No",
  });
});

test("EEO questions → decline option, whatever its wording", () => {
  assert.deepEqual(m(select("Gender", ["Male", "Female", "Decline To Self Identify"])), {
    source: "defaults",
    value: "Decline To Self Identify",
  });
  assert.deepEqual(
    m(select("Are you Hispanic/Latino?", ["Yes", "No", "Decline To Self Identify"])),
    {
      source: "defaults",
      value: "Decline To Self Identify",
    }
  );
  assert.deepEqual(
    m(select("Veteran Status", ["I am not a protected veteran", "I don't wish to answer"])),
    { source: "defaults", value: "I don't wish to answer" }
  );
  assert.deepEqual(
    m(
      select("Disability Status", [
        "Yes, I have a disability",
        "No, I do not have a disability",
        "I do not want to answer",
      ])
    ),
    { source: "defaults", value: "I do not want to answer" }
  );
  assert.deepEqual(m(select("Race", ["White", "Asian", "Prefer not to say"])), {
    source: "defaults",
    value: "Prefer not to say",
  });
  // No decline option → no answer rather than a wrong self-identification.
  assert.equal(m(select("Gender", ["Male", "Female"])), null);
});

test("how did you hear: default text, exact option, or nearest bucket", () => {
  assert.deepEqual(m(text("How did you hear about us?")), {
    source: "defaults",
    value: "Company careers page",
  });
  assert.deepEqual(
    m(select("How did you hear about this job?", ["LinkedIn", "Company careers page"])),
    {
      source: "defaults",
      value: "Company careers page",
    }
  );
  assert.deepEqual(
    m(select("How did you hear about this job?", ["LinkedIn", "Company website", "Other"])),
    {
      source: "defaults",
      value: "Company website",
    }
  );
  // Samsara's wording (live form, 2026-10).
  assert.deepEqual(
    m(select("Where have you learned about Acme? Select all that apply.", ["LinkedIn", "Other"])),
    { source: "defaults", value: "Other" }
  );
  assert.deepEqual(m(select("How did you find this role?", ["Referral", "Other"])), {
    source: "defaults",
    value: "Other",
  });
});

test("salary: single number or range", () => {
  assert.deepEqual(m(text("What are your salary expectations?")), {
    source: "salary",
    value: "180000",
  });
  assert.deepEqual(m(text("Desired salary range")), { source: "salary", value: "150000-180000" });
  // Bucketed salary selects are left to the LLM step.
  assert.equal(m(select("Expected compensation", ["<100k", "100-150k", "150k+"])), null);
});

test("file fields", () => {
  assert.deepEqual(m({ id: "r", label: "Resume/CV", type: "file", options: [] }), {
    source: "file",
    value: "resume",
  });
  assert.deepEqual(m({ id: "c", label: "Cover Letter", type: "file", options: [] }), {
    source: "file",
    value: "cover_letter",
  });
  assert.equal(m({ id: "p", label: "Portfolio sample", type: "file", options: [] }), null);
});

test("custom questions are not matched", () => {
  assert.equal(m(text("Why do you want to join Acme Synthetic?", { type: "textarea" })), null);
  assert.equal(m(select("Have you ever worked for Acme Synthetic before?", ["Yes", "No"])), null);
});

test("no apply defaults → standard questions stay unanswered", () => {
  const ctx = { identity: CTX.identity, applyDefaults: null, salary: null };
  assert.equal(
    matchQuestion(select("Gender", ["Male", "Decline to self-identify"]), ctx)?.value,
    "Decline to self-identify"
  );
  assert.equal(
    matchQuestion(select("Are you legally authorized to work in the US?", ["Yes", "No"]), ctx),
    null
  );
  assert.equal(matchQuestion(text("Desired salary"), ctx), null);
});

test("pickOption / pickDeclineOption", () => {
  assert.equal(pickOption(["Yes", "No"], "yes"), "Yes");
  assert.equal(pickOption(["No, but later", "No"], "No"), "No");
  assert.equal(pickOption(["Male", "Female"], "Decline"), null);
  assert.equal(pickOption([], "Yes"), null);
  assert.equal(pickDeclineOption(["A", "I choose not to disclose"]), "I choose not to disclose");
  assert.equal(pickDeclineOption(["A", "B"]), null);
});

// ---- address / citizenship / legal acknowledgements (owner decisions 2026-10-21)

const OWNER = {
  address: {
    street: "100 Example St",
    unit: "Apt 1",
    city: "Springfield",
    state: "IL",
    state_name: "Illinois",
    zip: "62701",
    country: "United States",
  },
  citizenship: { countries: ["Freedonia"], us_permanent_resident: true },
  legal_acknowledgements: "accept",
};
const ask = (label, type = "text", options = [], applyDefaults = OWNER) =>
  matchQuestion(
    { label, type, options },
    { applyDefaults, identity: { location: "Springfield, IL" } }
  );

test("address: zip, street, city and a state select come from apply_defaults.address", () => {
  assert.equal(ask("What is the zip code of your primary residence?").value, "62701");
  assert.equal(ask("Postal Code").value, "62701");
  assert.equal(ask("Street address").value, "100 Example St, Apt 1");
  assert.equal(ask("City").value, "Springfield");
  assert.equal(ask("State", "select", ["Idaho", "Illinois"]).value, "Illinois");
  assert.equal(ask("Zip code", "text", [], {}), null, "no address on file → no guess");
});

test("citizenship: export-control screen, US citizen vs permanent resident", () => {
  const exportQ =
    "Are you a citizen or legal permanent resident of Cuba, Iran, North Korea, Syria or Ukraine (Crimea region)?";
  assert.equal(ask(exportQ, "select", ["Yes", "No"]).value, "No");
  assert.equal(
    ask(exportQ, "select", ["Yes", "No"], { citizenship: { countries: ["Cuba"] } }).value,
    "Yes"
  );
  assert.equal(
    ask("Are you a U.S. citizen or permanent resident?", "select", ["Yes", "No"]).value,
    "Yes"
  );
  assert.equal(ask("Are you a US citizen?", "select", ["Yes", "No"]).value, "No");
  assert.equal(ask("Citizenship").value, "Freedonia");
});

test("legal: truthfulness, arbitration, AI policy, privacy → affirmative; marketing → no", () => {
  const yn = ["Yes", "No"];
  assert.equal(
    ask(
      "I confirm that all the information provided in my application is complete, true and correct",
      "select",
      yn
    ).value,
    "Yes"
  );
  assert.equal(ask("By agreeing here I accept binding arbitration", "select", yn).value, "Yes");
  assert.equal(ask("AI Policy for Interviewers", "select", yn).value, "Yes");
  assert.equal(
    ask("Processing of Personal Data", "select", ["Acknowledge/Confirm"]).value,
    "Acknowledge/Confirm"
  );
  assert.equal(ask("Send me SMS text messages about new roles", "select", yn).value, "No");
  // Job terms are not legal boilerplate — left for the LLM step / geo rule.
  assert.equal(
    ask("I acknowledge this role requires in-office work 3 days a week in Warsaw", "select", yn),
    null
  );
  // Without the owner's policy the legal questions are not auto-answered.
  assert.equal(ask("AI Policy for Interviewers", "select", yn, {}), null);
});

test("work authorization that mentions 'citizen' stays a work-auth question", () => {
  const r = matchQuestion(
    {
      label:
        "Are you currently legally authorized to work in the country in which this job is based (e.g. you are a citizen or permanent resident)?",
      type: "select",
      options: ["Yes", "No"],
    },
    { applyDefaults: { ...OWNER, work_authorization: { authorized_us: true } } }
  );
  assert.deepEqual(r, { source: "defaults", value: "Yes" });
});
