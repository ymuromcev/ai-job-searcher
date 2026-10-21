/* global document, CSS -- page.evaluate callbacks run in the browser */
// Lever application-form adapter (RFC 068 §2).
//
// Structure learned from public forms (2026-10), jobs.lever.co/<slug>/<uuid>/apply:
//   - <form id="application-form"> of <li class="application-question">
//     rows: <div class="application-label">Label<span class="required">✱</span>
//     + <div class="application-field"> with native inputs addressed by
//     `name` (name, email, phone, location, org, urls[LinkedIn], resume,
//     cards[<uuid>][fieldN], eeo[gender|race|veteran|disability], comments).
//   - Custom questions ("cards") are native radios / checkboxes / selects /
//     textareas; radio `value` equals the visible option text.
//   - `#location-input` is an autocomplete (suggestions under
//     `.dropdown-location`); the typed text is kept if nothing is offered.
//   - Submit is `#btn-submit` (type=button) which runs an invisible hCaptcha
//     and then posts; success lands on …/<uuid>/thanks ("Application
//     submitted!"). A visible hCaptcha challenge → manual.

const {
  STOP_REASONS,
  waitForForm,
  bodyText,
  waitForOutcome,
  attrSel,
  cacheSchema,
  cachedSchema,
  publicField,
  cleanLabel,
  sleep,
  FillError,
  pickLocationOption,
} = require("./_dom.js");

const NAME = "lever";
const FORM_SEL = "form#application-form, form[data-qa='application-form']";

function parse(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^jobs\.(eu\.)?lever\.co$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([0-9a-f-]{36})(\/apply|\/)?$/i);
  return m ? { slug: m[1], jobId: m[2], host: u.hostname } : null;
}

function detect(url) {
  return Boolean(parse(url));
}

function tenantKey(url) {
  const p = parse(url);
  return p ? `${NAME}:${p.slug.toLowerCase()}` : `${NAME}:unknown`;
}

function jobRef(url) {
  return parse(url);
}

function normalizeUrl(url) {
  const p = parse(url);
  if (!p) return url;
  return `https://${p.host}/${p.slug}/${p.jobId}/apply`;
}

const CLOSED_RE =
  /couldn('|’)t find anything here|no longer (accepting|available|open)|posting (has been )?closed|not found/i;

async function open(page, url, { timeoutMs = 45000, formTimeoutMs = 20000 } = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  const r = await waitForForm(page, {
    formSel: FORM_SEL,
    closedRe: CLOSED_RE,
    timeoutMs: formTimeoutMs,
  });
  if (r.state === "form") return { ok: true };
  if (r.state === "blocked") return { ok: false, reason: r.reason };
  if (r.state === "closed") return { ok: false, reason: STOP_REASONS.JOB_CLOSED };
  return { ok: false, reason: STOP_REASONS.UNKNOWN_PAGE };
}

/* Runs in the page. */
function scanFormInPage(formSel) {
  const form = document.querySelector(formSel);
  if (!form) return null;
  const txt = (el) => (el ? el.innerText || el.textContent || "" : "");
  const skipType = (t) => ["hidden", "submit", "button", "reset", "image", "search"].includes(t);
  const out = [];
  const seen = new Set();

  const optionText = (input) => {
    const l = input.closest("label");
    const alt = l && l.querySelector(".application-answer-alternative");
    return (txt(alt) || txt(l) || input.value || "").trim();
  };

  const pushGroup = (els, label, required) => {
    const el = els[0];
    const name = el.getAttribute("name");
    const tag = el.tagName;
    const type = String(el.getAttribute("type") || "").toLowerCase();
    let field;
    if (type === "radio" || type === "checkbox") {
      const single = type === "checkbox" && els.length === 1;
      field = {
        type,
        kind: single ? "checkbox-single" : type === "radio" ? "radio-group" : "checkbox-group",
        options: single ? [] : els.map(optionText),
        label: single && !label ? optionText(el) : label,
      };
    } else if (tag === "SELECT") {
      field = {
        type: "select",
        kind: "select",
        options: Array.from(el.options)
          .filter((o) => o.value !== "")
          .map((o) => o.text.trim()),
        label,
      };
    } else if (tag === "TEXTAREA") {
      field = { type: "textarea", kind: "text", options: [], label };
    } else if (type === "file") {
      field = { type: "file", kind: "file", options: [], label };
    } else {
      let ft = "text";
      if (type === "email" || name === "email") ft = "email";
      else if (type === "tel" || name === "phone") ft = "phone";
      else if (type === "url" || /^urls\[/.test(name)) ft = "url";
      field = {
        type: ft,
        kind: name === "location" || el.id === "location-input" ? "location" : "text",
        options: [],
        label,
      };
    }
    out.push({
      id: name,
      required:
        required || els.some((e) => e.required || e.getAttribute("aria-required") === "true"),
      ...field,
    });
  };

  const collect = (scope) => {
    const byName = new Map();
    for (const el of scope.querySelectorAll("input, select, textarea")) {
      const name = el.getAttribute("name");
      const type = String(el.getAttribute("type") || "").toLowerCase();
      if (!name || skipType(type) || seen.has(name)) continue;
      if (/captcha/i.test(name)) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(el);
    }
    return byName;
  };

  for (const li of form.querySelectorAll("li.application-question")) {
    const labelEl =
      li.querySelector(".application-label .text") || li.querySelector(".application-label");
    let label = txt(labelEl);
    const required = Boolean(li.querySelector(".application-label .required, .required-field"));
    const groups = collect(li);
    let i = 0;
    for (const [name, els] of groups) {
      seen.add(name);
      // A row with several controls (e.g. checkboxes + an "Other" box):
      // later controls get a suffixed label so they stay distinguishable.
      const l =
        i === 0 ? label : `${label} (${els[0].getAttribute("placeholder") || `part ${i + 1}`})`;
      pushGroup(els, l, i === 0 ? required : false);
      i += 1;
    }
  }
  // Controls outside the question rows (Additional information, EEO blocks
  // on some templates).
  for (const [name, els] of collect(form)) {
    seen.add(name);
    const el = els[0];
    const section = el.closest(".application-additional, .section, .eeo-section");
    const heading = section && section.querySelector("h4, h3, .application-label");
    const label =
      el.getAttribute("aria-label") || txt(heading) || el.getAttribute("placeholder") || name;
    pushGroup(els, label, false);
  }
  return out;
}

async function readSchema(page) {
  const raw = await page.evaluate(scanFormInPage, FORM_SEL);
  if (!raw) throw new Error("lever: application form not found");
  for (const f of raw) f.label = cleanLabel(f.label);
  cacheSchema(page, raw);
  return raw.map(publicField);
}

async function schemaFor(page) {
  if (!cachedSchema(page)) await readSchema(page);
  return cachedSchema(page);
}

async function checkOption(page, field, wanted) {
  const name = attrSel("name", field.id);
  const byValue = page.locator(`input${name}${attrSel("value", wanted)}`);
  if ((await byValue.count()) > 0) {
    await byValue.first().check();
    return;
  }
  const all = page.locator(`input${name}`);
  const n = await all.count();
  for (let i = 0; i < n; i += 1) {
    const text = await all.nth(i).evaluate((el) => {
      const l = el.closest("label");
      return (l ? l.innerText : el.value || "").trim();
    });
    if (text.toLowerCase() === String(wanted).trim().toLowerCase()) {
      await all.nth(i).check();
      return;
    }
  }
  throw new FillError("option_not_found", field.id);
}

async function fillOne(page, field, value) {
  const sel = attrSel("name", field.id);
  switch (field.kind) {
    case "text":
      await page.locator(sel).first().fill(String(value));
      return;
    case "location": {
      // The location search reacts only to real keystrokes; a value not picked
      // from the list is dropped on submit. Try "City, ST", then the city alone.
      const input = page.locator(sel).first();
      const sugg = page.locator(
        ".dropdown-location, .location-dropdown [role=option], .dropdown-results li"
      );
      const tries = [String(value), String(value).split(",")[0].trim()].filter(
        (t, i, all) => t && all.indexOf(t) === i
      );
      for (const text of tries) {
        await input.fill("");
        await input.pressSequentially(text, { delay: 40 });
        try {
          await sugg.first().waitFor({ state: "visible", timeout: 5000 });
        } catch {
          continue;
        }
        await sleep(600);
        const texts = await sugg.allInnerTexts();
        await sugg.nth(pickLocationOption(texts, String(value))).click();
        return;
      }
      throw new FillError("location_no_suggestion", field.id);
    }
    case "select":
      await page
        .locator(sel)
        .first()
        .selectOption({ label: String(value) });
      return;
    case "file":
      await page.locator(`input[type=file]${sel}`).first().setInputFiles(String(value));
      await sleep(300);
      return;
    case "checkbox-single":
      if (value === true || /^(yes|true|checked|1)$/i.test(String(value))) {
        await page.locator(`input${sel}`).first().check();
      }
      return;
    case "radio-group":
      await checkOption(page, field, Array.isArray(value) ? value[0] : value);
      return;
    case "checkbox-group":
      for (const w of Array.isArray(value) ? value : [value]) await checkOption(page, field, w);
      return;
    default:
      throw new FillError("unsupported_field", field.id);
  }
}

// Lever parses an uploaded resume ("Analyzing resume…") and then rewrites
// name / email / phone / location from it — clearing what was typed before.
// Upload files first, wait for the parser, then fill everything else.
async function waitResumeParsed(page) {
  try {
    await page.waitForFunction(
      () => !/Analyzing resume/i.test(document.body.innerText || ""),
      null,
      {
        timeout: 25000,
      }
    );
  } catch {
    // Parser hung — fill anyway; the pre-submit check catches a cleared field.
  }
}

function filesFirst(schema) {
  return [...schema.filter((f) => f.kind === "file"), ...schema.filter((f) => f.kind !== "file")];
}

async function fill(page, values) {
  const schema = filesFirst(await schemaFor(page));
  const filled = [];
  const errors = [];
  let parsedWaited = false;
  for (const field of schema) {
    if (!parsedWaited && field.kind !== "file") {
      parsedWaited = true;
      if (filled.length) await waitResumeParsed(page);
    }
    if (!Object.prototype.hasOwnProperty.call(values, field.id)) continue;
    const v = values[field.id];
    if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    try {
      await fillOne(page, field, v);
      filled.push(field.id);
    } catch (err) {
      errors.push({ id: field.id, error: err.code || err.message });
    }
  }
  return { filled, errors };
}

/* Runs in the page. */
function filledStateInPage(fields) {
  const res = {};
  for (const f of fields) {
    const els = Array.from(document.querySelectorAll(`[name="${CSS.escape(f.id)}"]`));
    let ok = false;
    if (f.type === "radio" || f.type === "checkbox") ok = els.some((e) => e.checked);
    else if (f.type === "file") ok = els.some((e) => e.files && e.files.length > 0);
    else ok = els.some((e) => String(e.value || "").trim().length > 0);
    res[f.id] = ok;
  }
  return res;
}

async function checkFilled(page) {
  const schema = await schemaFor(page);
  const state = await page.evaluate(filledStateInPage, schema);
  const missing = schema.filter((f) => f.required && !state[f.id]).map((f) => f.id);
  return { missing, state };
}

async function isSuccess(page) {
  const url = page.url();
  const text = await bodyText(page, 3000);
  const byUrl = /\/thanks(\b|\/|\?|\.html|$)/i.test(url);
  const byText = /application submitted|thanks for applying|thank you for applying/i.test(text);
  if (byUrl || (byText && !(await page.$(FORM_SEL)))) return { url, text: text.slice(0, 400) };
  return null;
}

async function hasValidationError(page) {
  return page.evaluate(() => {
    const vis = (e) => e && e.offsetParent !== null;
    return (
      Array.from(
        document.querySelectorAll(".error-message, .application-error, .has-error .error")
      ).some((e) => vis(e) && (e.innerText || "").trim()) ||
      Array.from(
        document.querySelectorAll(".application-question.error, .application-question.has-error")
      ).length > 0
    );
  });
}

async function submit(page, { timeoutMs = 30000 } = {}) {
  let btn = page.locator("#btn-submit");
  if ((await btn.count()) === 0) btn = page.locator('button:has-text("Submit application")');
  if ((await btn.count()) === 0)
    return { ok: false, reason: STOP_REASONS.UNKNOWN_PAGE, evidence: null };
  await btn.first().click();
  return waitForOutcome(page, { isSuccess, hasValidationError, timeoutMs });
}

module.exports = {
  filesFirst,
  name: NAME,
  detect,
  tenantKey,
  jobRef,
  normalizeUrl,
  open,
  readSchema,
  fill,
  checkFilled,
  submit,
  isSuccess,
};
