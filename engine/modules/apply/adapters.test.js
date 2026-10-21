/* global document -- page.evaluate callbacks run in the browser */
// Browser tests for the apply adapters against synthetic HTML fixtures
// (file:// — no network). Skips with a clear message when Playwright's
// Chromium is not installed (`npx playwright install chromium`).

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const { browserStatus, launchBrowser } = require("./browser.js");
const greenhouse = require("./greenhouse.js");
const lever = require("./lever.js");
const ashby = require("./ashby.js");
const { matchQuestion } = require("./question_match.js");

const status = browserStatus();
const SKIP = status.ok ? false : `Playwright Chromium unavailable: ${status.reason}`;
if (SKIP) {
  console.log(`# skipping adapter browser tests — ${SKIP}`);
}

const FIX = path.join(__dirname, "fixtures");
const fixtureUrl = (name, variant) => {
  const u = pathToFileURL(path.join(FIX, name)).href;
  return variant ? `${u}?variant=${variant}` : u;
};

const IDENTITY = {
  name: "Test Candidate",
  email: "candidate@example.com",
  phone: "+1 555 010 0000",
  location: "Springfield, IL",
  linkedin: "linkedin.com/in/example",
};
const DEFAULTS = {
  work_authorization: {
    authorized_us: true,
    requires_sponsorship: false,
    status_text: "Permanent resident",
  },
  relocation: { willing: false },
  eeo: { policy: "decline" },
  salary: { floor: 120000, default: 180000, currency: "USD" },
  how_did_you_hear_default: "Company careers page",
};
const SALARY = { value: 190000, low: 150000, high: 190000, source: "published_range" };

let browser;
let tmp;
let resumePdf;
let clPdf;

// Answer every field the deterministic matcher can, plus the custom
// questions a test supplies. Files map to the synthetic PDFs.
function planValues(fields, custom = {}) {
  const values = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(custom, f.label)) {
      values[f.id] = custom[f.label];
      continue;
    }
    const m = matchQuestion(f, { identity: IDENTITY, applyDefaults: DEFAULTS, salary: SALARY });
    if (!m) continue;
    if (m.source === "file") values[f.id] = m.value === "resume" ? resumePdf : clPdf;
    else values[f.id] = m.value;
  }
  return values;
}

async function withPage(fn) {
  const { page, close } = await browser.newPage();
  try {
    return await fn(page);
  } finally {
    await close();
  }
}

describe("apply adapters on synthetic fixtures", { skip: SKIP }, () => {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "apply-adapters-"));
    resumePdf = path.join(tmp, "resume.pdf");
    clPdf = path.join(tmp, "cover_letter.pdf");
    const pdf = "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n";
    fs.writeFileSync(resumePdf, pdf);
    fs.writeFileSync(clPdf, pdf);
    browser = await launchBrowser({ headless: true });
  });
  after(async () => {
    if (browser) await browser.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---- Greenhouse ----------------------------------------------------------

  const GH_CUSTOM = {
    "Why do you want to join Acme Synthetic?": "Synthetic motivation answer.",
    "Have you ever worked for Acme Synthetic before?": "No",
  };

  test("greenhouse: readSchema finds standard, custom, file and EEO fields", async () => {
    await withPage(async (page) => {
      const opened = await greenhouse.open(page, fixtureUrl("greenhouse_form.html"));
      assert.deepEqual(opened, { ok: true }); // invisible reCAPTCHA is not a stop
      const fields = await greenhouse.readSchema(page);
      const byId = Object.fromEntries(fields.map((f) => [f.id, f]));
      assert.equal(byId.first_name.label, "First Name");
      assert.equal(byId.first_name.required, true);
      assert.equal(byId.email.type, "email");
      assert.equal(byId.phone.type, "phone");
      assert.equal(byId.resume.type, "file");
      assert.equal(byId.resume.label, "Resume/CV");
      assert.equal(byId.resume.required, true);
      assert.equal(byId.cover_letter.required, false);
      assert.equal(byId["candidate-location"].type, "text");
      assert.deepEqual(byId.question_1003.options, ["Yes", "No"]);
      assert.equal(byId.question_1002.type, "textarea");
      assert.equal(byId.question_1002.required, true);
      assert.deepEqual(byId.gender.options, ["Male", "Female", "Decline To Self Identify"]);
      assert.equal(byId["question_1007[]"].type, "checkbox");
      assert.deepEqual(byId["question_1007[]"].options, [
        "Spreadsheets",
        "SQL",
        "Experimentation platforms",
      ]);
      // contract shape only
      assert.deepEqual(Object.keys(byId.gender).sort(), [
        "id",
        "label",
        "options",
        "required",
        "type",
      ]);
    });
  });

  test("greenhouse: fill + pre-submit check + submit reaches the confirmation page", async () => {
    await withPage(async (page) => {
      await greenhouse.open(page, fixtureUrl("greenhouse_form.html"));
      const fields = await greenhouse.readSchema(page);
      const values = planValues(fields, GH_CUSTOM);
      assert.equal(values.country, "United States +1");
      assert.equal(values.question_1004, "No");
      assert.equal(values.gender, "Decline To Self Identify");
      assert.equal(values.veteran_status, "I don't wish to answer");
      assert.equal(values.disability_status, "I do not want to answer");
      assert.equal(values.question_1006, "Company website");
      assert.equal(values.question_1005, "190000");
      values["question_1007[]"] = ["SQL"];
      const res = await greenhouse.fill(page, values);
      assert.deepEqual(res.errors, []);
      const check = await greenhouse.checkFilled(page);
      assert.deepEqual(check.missing, []);
      assert.equal(await page.inputValue("#question_1001"), "https://linkedin.com/in/example");
      const out = await greenhouse.submit(page, { timeoutMs: 8000 });
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.match(out.evidence.url, /greenhouse_confirmation\.html/);
      assert.match(out.evidence.text, /Thank you for applying/);
    });
  });

  test("greenhouse: an uploaded file still counts after the input becomes a filename chip", async () => {
    await withPage(async (page) => {
      await greenhouse.open(page, fixtureUrl("greenhouse_form.html"));
      const fields = await greenhouse.readSchema(page);
      await greenhouse.fill(page, planValues(fields, GH_CUSTOM));
      // Live Greenhouse replaces <input id="resume"> with the file name once uploaded.
      await page.evaluate(() => {
        const input = document.getElementById("resume");
        const chip = document.createElement("span");
        chip.textContent = "CV_Example.pdf";
        input.replaceWith(chip);
      });
      const check = await greenhouse.checkFilled(page);
      assert.equal(check.missing.includes("resume"), false);
    });
  });

  test("greenhouse: pre-submit check reports an unanswered required question", async () => {
    await withPage(async (page) => {
      await greenhouse.open(page, fixtureUrl("greenhouse_form.html"));
      const fields = await greenhouse.readSchema(page);
      const values = planValues(fields, {}); // custom questions left empty
      await greenhouse.fill(page, values);
      const check = await greenhouse.checkFilled(page);
      assert.deepEqual(check.missing.sort(), ["question_1002", "question_1008"]);
    });
  });

  test("greenhouse: visible captcha after Submit stops as captcha", async () => {
    await withPage(async (page) => {
      await greenhouse.open(page, fixtureUrl("greenhouse_form.html", "captcha"));
      const fields = await greenhouse.readSchema(page);
      await greenhouse.fill(page, planValues(fields, GH_CUSTOM));
      const out = await greenhouse.submit(page, { timeoutMs: 6000 });
      assert.equal(out.ok, false);
      assert.equal(out.reason, "captcha");
    });
  });

  test("greenhouse: email security-code screen stops as email_verification", async () => {
    await withPage(async (page) => {
      await greenhouse.open(page, fixtureUrl("greenhouse_form.html", "verify"));
      const fields = await greenhouse.readSchema(page);
      await greenhouse.fill(page, planValues(fields, GH_CUSTOM));
      const out = await greenhouse.submit(page, { timeoutMs: 6000 });
      assert.equal(out.ok, false);
      assert.equal(out.reason, "email_verification");
    });
  });

  test("greenhouse: server-side rejection is a validation_error (no confirmation)", async () => {
    await withPage(async (page) => {
      await greenhouse.open(page, fixtureUrl("greenhouse_form.html", "reject"));
      const fields = await greenhouse.readSchema(page);
      await greenhouse.fill(page, planValues(fields, GH_CUSTOM));
      const out = await greenhouse.submit(page, { timeoutMs: 6000 });
      assert.equal(out.ok, false);
      assert.equal(out.reason, "validation_error");
    });
  });

  test("open: login wall and closed posting are typed stops", async () => {
    await withPage(async (page) => {
      assert.deepEqual(await greenhouse.open(page, fixtureUrl("login_wall.html")), {
        ok: false,
        reason: "login_required",
      });
      assert.deepEqual(await lever.open(page, fixtureUrl("job_closed.html")), {
        ok: false,
        reason: "job_closed",
      });
    });
  });

  // ---- Lever ---------------------------------------------------------------

  const LEVER_CUSTOM = { "What draws you to Acme Synthetic?": "Synthetic motivation answer." };

  test("lever: readSchema reads rows, cards and EEO selects by name", async () => {
    await withPage(async (page) => {
      assert.deepEqual(await lever.open(page, fixtureUrl("lever_apply.html")), { ok: true });
      const fields = await lever.readSchema(page);
      const byId = Object.fromEntries(fields.map((f) => [f.id, f]));
      assert.equal(byId.resume.type, "file");
      assert.equal(byId.resume.label, "Resume/CV");
      assert.equal(byId.name.label, "Full name");
      assert.equal(byId.name.required, true);
      assert.equal(byId.phone.required, false);
      assert.equal(byId["urls[LinkedIn]"].type, "url");
      const auth = byId["cards[11111111-1111-4111-8111-111111111111][field0]"];
      assert.equal(auth.type, "radio");
      assert.deepEqual(auth.options, ["Yes", "No"]);
      assert.equal(auth.required, true);
      assert.equal(byId["cards[22222222-2222-4222-8222-222222222222][field0]"].type, "select");
      assert.deepEqual(byId["eeo[gender]"].options, ["Male", "Female", "Decline to self-identify"]);
      assert.equal(byId["eeo[gender]"].label, "Gender");
      assert.equal(byId.comments.type, "textarea");
      assert.ok(!byId["h-captcha-response"], "hidden captcha token is not a field");
    });
  });

  test("lever: fill + submit lands on the thanks page", async () => {
    await withPage(async (page) => {
      await lever.open(page, fixtureUrl("lever_apply.html"));
      const fields = await lever.readSchema(page);
      const values = planValues(fields, LEVER_CUSTOM);
      assert.equal(values["cards[11111111-1111-4111-8111-111111111111][field1]"], "No");
      assert.equal(
        values["cards[22222222-2222-4222-8222-222222222222][field0]"],
        "Company careers page"
      );
      assert.equal(values["eeo[race]"], "Decline to self-identify");
      const res = await lever.fill(page, values);
      assert.deepEqual(res.errors, []);
      assert.deepEqual((await lever.checkFilled(page)).missing, []);
      assert.equal(await page.inputValue("#location-input"), "Springfield, IL, United States");
      const out = await lever.submit(page, { timeoutMs: 8000 });
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.match(out.evidence.url, /lever_thanks\.html/);
    });
  });

  test("lever: visible hCaptcha challenge stops as captcha", async () => {
    await withPage(async (page) => {
      await lever.open(page, fixtureUrl("lever_apply.html", "captcha"));
      const fields = await lever.readSchema(page);
      await lever.fill(page, planValues(fields, LEVER_CUSTOM));
      const out = await lever.submit(page, { timeoutMs: 6000 });
      assert.equal(out.ok, false);
      assert.equal(out.reason, "captcha");
    });
  });

  test("lever: missing required answer → validation error, no submission", async () => {
    await withPage(async (page) => {
      await lever.open(page, fixtureUrl("lever_apply.html"));
      const fields = await lever.readSchema(page);
      await lever.fill(page, planValues(fields, {}));
      assert.deepEqual((await lever.checkFilled(page)).missing, [
        "cards[33333333-3333-4333-8333-333333333333][field0]",
      ]);
      const out = await lever.submit(page, { timeoutMs: 6000 });
      assert.equal(out.ok, false);
      assert.equal(out.reason, "validation_error");
    });
  });

  // ---- Ashby ---------------------------------------------------------------

  const ASHBY_CUSTOM = { "Describe a product you shipped end to end.": "Synthetic story." };

  test("ashby: readSchema maps field entries, yes/no, combobox and files", async () => {
    await withPage(async (page) => {
      assert.deepEqual(await ashby.open(page, fixtureUrl("ashby_application.html")), { ok: true });
      const fields = await ashby.readSchema(page);
      const byId = Object.fromEntries(fields.map((f) => [f.id, f]));
      assert.equal(byId._systemfield_name.label, "Legal Name");
      assert.equal(byId._systemfield_name.required, true);
      assert.equal(byId._systemfield_email.type, "email");
      assert.equal(byId["5a5a5a5a-0000-4000-8000-000000000001"].type, "phone");
      assert.equal(byId._systemfield_location.type, "text");
      assert.equal(byId._systemfield_resume.type, "file");
      assert.equal(byId["5a5a5a5a-0000-4000-8000-000000000002"].required, false);
      assert.deepEqual(byId["5a5a5a5a-0000-4000-8000-000000000004"].options, ["Yes", "No"]);
      assert.equal(byId["5a5a5a5a-0000-4000-8000-000000000006"].type, "textarea");
      assert.deepEqual(byId._systemfield_eeoc_gender.options, [
        "Male",
        "Female",
        "Decline to self-identify",
      ]);
    });
  });

  test("ashby: fill + submit shows the in-page success message", async () => {
    await withPage(async (page) => {
      await ashby.open(page, fixtureUrl("ashby_application.html"));
      const fields = await ashby.readSchema(page);
      const values = planValues(fields, ASHBY_CUSTOM);
      assert.equal(values["5a5a5a5a-0000-4000-8000-000000000005"], "No");
      assert.equal(values["5a5a5a5a-0000-4000-8000-000000000007"], "Company careers page");
      assert.equal(values._systemfield_eeoc_veteran_status, "I don't wish to answer");
      const res = await ashby.fill(page, values);
      assert.deepEqual(res.errors, []);
      assert.deepEqual((await ashby.checkFilled(page)).missing, []);
      const out = await ashby.submit(page, { timeoutMs: 8000 });
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.match(out.evidence.text, /successfully submitted/);
    });
  });

  test("ashby: visible captcha stops as captcha", async () => {
    await withPage(async (page) => {
      await ashby.open(page, fixtureUrl("ashby_application.html", "captcha"));
      const fields = await ashby.readSchema(page);
      await ashby.fill(page, planValues(fields, ASHBY_CUSTOM));
      const out = await ashby.submit(page, { timeoutMs: 6000 });
      assert.equal(out.ok, false);
      assert.equal(out.reason, "captcha");
    });
  });
});

test("pickLocationOption: same city + state in the US wins (Greenhouse and Lever formats)", () => {
  const { pickLocationOption } = require("./_dom.js");
  assert.equal(
    pickLocationOption(
      ["Sacramento, Minas Gerais, BRA", "Sacramento, IL, USA", "Sacramento, CA, USA"],
      "Sacramento, CA"
    ),
    2
  );
  const opts = [
    "West Sacramento, California, United States",
    "Colonia del Sacramento, Colonia, Uruguay",
    "Sacramento, California, United States",
    "Sacramento, Minas Gerais, Brazil",
  ];
  assert.equal(pickLocationOption(opts, "Sacramento, CA"), 2);
  assert.equal(pickLocationOption(["Paris, France", "Paris, Texas, United States"], "Paris"), 1);
  assert.equal(pickLocationOption(["Somewhere, Spain"], "Sacramento, CA"), 0);
});

test("lever filesFirst: the resume is uploaded before any typed field", () => {
  const { filesFirst } = require("./lever.js");
  const order = filesFirst([
    { id: "name", kind: "text" },
    { id: "location", kind: "location" },
    { id: "resume", kind: "file" },
  ]).map((f) => f.id);
  assert.deepEqual(order, ["resume", "name", "location"]);
});
