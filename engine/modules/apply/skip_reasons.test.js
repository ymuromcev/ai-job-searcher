const { test } = require("node:test");
const assert = require("node:assert/strict");

const { SKIP_REASONS, isSkipReason, skipReasonFor, skipNote } = require("./skip_reasons.js");
const { headlessFor, launchOptions } = require("./browser.js");

test("skip vocabulary is the small documented set", () => {
  assert.deepEqual(
    [...SKIP_REASONS],
    [
      "required_empty",
      "no_honest_answer",
      "captcha",
      "account_required",
      "form_broken",
      "bot_check",
      "closed",
      "no_company_form",
    ]
  );
  assert.equal(isSkipReason("captcha"), true);
  assert.equal(isSkipReason("deadline"), false, "guard skips are not counted reasons");
  assert.equal(isSkipReason("manual"), false);
});

test("skipReasonFor maps every detailed stop code onto the vocabulary", () => {
  const cases = {
    captcha: "captcha",
    login_required: "account_required",
    email_verification: "bot_check",
    email_code_missing: "bot_check",
    email_code_rejected: "bot_check",
    unknown_page: "form_broken",
    job_closed: "closed",
    "unsupported_ats:jobs.example.com": "no_company_form",
    "unresolved_url:www.adzuna.com": "no_company_form",
    no_application_url: "no_company_form",
    presubmit_check: "required_empty",
    "fill_error:option_not_found": "required_empty",
    resume_missing: "required_empty",
    no_honest_answer: "no_honest_answer",
    schema_changed: "no_honest_answer",
    something_new: "form_broken",
    "": "form_broken",
  };
  for (const [code, want] of Object.entries(cases)) assert.equal(skipReasonFor(code), want, code);
  for (const r of SKIP_REASONS) assert.equal(skipReasonFor(r), r, "a reason maps to itself");
});

test("skipNote: reason alone, or reason with the detail / empty labels", () => {
  assert.equal(skipNote("captcha"), "captcha");
  assert.equal(skipNote("captcha", "captcha"), "captcha");
  assert.equal(skipNote("bot_check", "email_code_missing"), "bot_check: email_code_missing");
  assert.equal(
    skipNote("required_empty", ["Are you authorized?", "Years of experience"]),
    "required_empty: Are you authorized?; Years of experience"
  );
});

test("browser: Ashby opens a visible window, Greenhouse / Lever / unknown headless", () => {
  assert.equal(headlessFor("ashby"), false);
  assert.equal(headlessFor("greenhouse"), true);
  assert.equal(headlessFor("lever"), true);
  assert.equal(headlessFor(null), true, "aggregator pages are read headless");
  assert.equal(headlessFor("workday"), true);
  assert.equal(headlessFor("greenhouse", { greenhouse: false }), false, "overridable");
});

test("browser: launch options never point at the system Chrome", () => {
  for (const headless of [true, false]) {
    const o = launchOptions({ headless });
    assert.deepEqual(o, { headless });
    assert.equal("channel" in o, false);
    assert.equal("executablePath" in o, false);
  }
});
