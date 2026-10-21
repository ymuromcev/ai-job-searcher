/* global document, CSS -- page.evaluate callbacks run in the browser */
// Greenhouse application-form adapter (RFC 068 §2).
//
// Targets the current job-boards UI (job-boards.greenhouse.io, Remix +
// react-select). Legacy boards.greenhouse.io/<slug>/jobs/<id> links redirect
// there; the embed form (`/embed/job_app?for=<slug>&token=<id>`) renders the
// same markup.
//
// Structure learned from public forms (2026-10):
//   - <form id="application-form">; text inputs carry ids (first_name,
//     last_name, email, phone, question_<n>) and a `<id>-label` <label>.
//   - Dropdowns are react-select: <input class="select__input"
//     role="combobox" id=…>; options render in `.select__menu [role=option]`
//     only after the control is opened; the choice shows as
//     `.select__single-value`. `candidate-location` is an async
//     place-search combobox (options appear after typing).
//   - Files: <div role="group" class="file-upload"
//     aria-labelledby="upload-label-resume"> + <input type=file id=resume>.
//   - EEO: gender / hispanic_ethnicity / veteran_status / disability_status
//     react-selects with a "Decline To Self Identify" style option.
//   - An invisible reCAPTCHA Enterprise is always present (not a stop).
//   - After submit: redirect to …/jobs/<id>/confirmation ("Thank you for
//     applying"), or an email security-code screen (→ manual).

const {
  STOP_REASONS,
  waitForForm,
  bodyText,
  waitForOutcome,
  attrSel,
  exactTextRe,
  cacheSchema,
  cachedSchema,
  publicField,
  cleanLabel,
  sleep,
  FillError,
} = require("./_dom.js");

const { pickOption } = require("./question_match.js");

const NAME = "greenhouse";
const FORM_SEL = "form#application-form, form#application_form, form.application--form";
const MENU_OPTION_SEL = ".select__menu [role=option], .select__menu .select__option";

function parse(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^(job-boards|boards)\.greenhouse\.io$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/([A-Za-z0-9_-]+)\/jobs\/(\d+)/);
  if (m) return { slug: m[1], jobId: m[2] };
  if (/^\/embed\/job_app\/?$/i.test(u.pathname)) {
    const slug = u.searchParams.get("for");
    const token = u.searchParams.get("token");
    if (slug && token) return { slug, jobId: token, embed: true };
  }
  return null;
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
  if (!p || p.embed) return url;
  return `https://job-boards.greenhouse.io/${p.slug}/jobs/${p.jobId}`;
}

const CLOSED_RE =
  /no longer (accepting|available|open)|job (was )?not found|position has been filled/i;

async function open(page, url, { timeoutMs = 45000, formTimeoutMs = 20000 } = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  if (/[?&]error=true/.test(page.url())) return { ok: false, reason: STOP_REASONS.JOB_CLOSED };
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

/* Runs in the page: raw field inventory, internal `kind` included. */
function scanFormInPage(formSel) {
  const form = document.querySelector(formSel);
  if (!form) return null;
  const txt = (el) => (el ? el.innerText || el.textContent || "" : "");
  const labelOf = (el) => {
    const id = el.id;
    if (id) {
      const byId = document.getElementById(`${id}-label`);
      if (byId) return txt(byId);
      const lf = form.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lf && !/visually-hidden/.test(lf.className)) return txt(lf);
    }
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb
        .split(/\s+/)
        .map((x) => txt(document.getElementById(x)))
        .join(" ");
      if (t.trim()) return t;
    }
    return el.getAttribute("aria-label") || "";
  };
  const reqOf = (el, label) =>
    el.getAttribute("aria-required") === "true" || el.required || /\*\s*$/.test(label.trim());
  const out = [];
  const groups = new Set();
  for (const el of form.querySelectorAll("input, textarea, select")) {
    const type = String(el.getAttribute("type") || "").toLowerCase();
    if (["hidden", "submit", "button", "search", "reset", "image"].includes(type)) continue;
    if (el.name === "g-recaptcha-response" || /recaptcha/i.test(el.id)) continue;
    if (el.closest(".iti__dropdown-content, .iti__country-container")) continue;

    if (type === "checkbox" || type === "radio") {
      const fs = el.closest("fieldset") || el.closest('[role="group"]');
      const key = el.name || (fs && fs.id) || el.id;
      if (!key || groups.has(key)) continue;
      groups.add(key);
      const scope = fs || form;
      const inputs = Array.from(scope.querySelectorAll(`input[type="${type}"]`)).filter(
        (i) => (i.name || key) === key || !el.name
      );
      const options = inputs.map((i) => {
        const l =
          (i.id && scope.querySelector(`label[for="${CSS.escape(i.id)}"]`)) || i.closest("label");
        return txt(l).trim() || i.value;
      });
      const legend = fs && fs.querySelector("legend");
      const label = txt(legend) || labelOf(el);
      const single = inputs.length === 1 && !legend;
      out.push({
        id: key,
        label: single ? options[0] : label,
        type,
        required:
          inputs.some((i) => i.required || i.getAttribute("aria-required") === "true") ||
          /\*\s*$/.test(label.trim()),
        options: single ? [] : options,
        kind: type === "checkbox" ? (single ? "checkbox-single" : "checkbox-group") : "radio-group",
        nameAttr: el.name || "",
      });
      continue;
    }
    if (!el.id) continue; // react-select's hidden "requiredInput" twins
    if (type === "file") {
      const group = el.closest(".file-upload") || el.closest('[role="group"]');
      const lblId = group && group.getAttribute("aria-labelledby");
      const label = (lblId && txt(document.getElementById(lblId))) || labelOf(el) || el.id;
      out.push({
        id: el.id,
        label,
        type: "file",
        required:
          (group && group.getAttribute("aria-required") === "true") ||
          el.required ||
          /\*\s*$/.test(label.trim()),
        options: [],
        kind: "file",
      });
      continue;
    }
    const label = labelOf(el);
    if (el.tagName === "SELECT") {
      out.push({
        id: el.id,
        label,
        type: "select",
        required: reqOf(el, label),
        options: Array.from(el.options)
          .filter((o) => o.value !== "")
          .map((o) => o.text.trim()),
        kind: "native-select",
      });
      continue;
    }
    if (el.tagName === "TEXTAREA") {
      out.push({
        id: el.id,
        label,
        type: "textarea",
        required: reqOf(el, label),
        options: [],
        kind: "text",
      });
      continue;
    }
    if (el.getAttribute("role") === "combobox" || /select__input/.test(el.className)) {
      out.push({
        id: el.id,
        label,
        type: el.id === "candidate-location" ? "text" : "select",
        required: reqOf(el, label),
        options: [],
        kind: el.id === "candidate-location" ? "async-select" : "react-select",
      });
      continue;
    }
    let ftype = "text";
    if (type === "email" || el.id === "email") ftype = "email";
    else if (type === "tel" || el.id === "phone") ftype = "phone";
    else if (type === "url") ftype = "url";
    out.push({
      id: el.id,
      label,
      type: ftype,
      required: reqOf(el, label),
      options: [],
      kind: "text",
    });
  }
  return out;
}

async function readMenuOptions(page, id) {
  const input = page.locator(attrSel("id", id));
  let opts = [];
  for (let attempt = 0; attempt < 2 && opts.length === 0; attempt += 1) {
    try {
      await input.click({ timeout: 4000 });
    } catch {
      return [];
    }
    opts = await visibleMenuTexts(page);
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(150);
  }
  return opts.filter(Boolean).slice(0, 300);
}

async function readSchema(page) {
  const raw = await page.evaluate(scanFormInPage, FORM_SEL);
  if (!raw) throw new Error("greenhouse: application form not found");
  for (const f of raw) {
    f.label = cleanLabel(f.label);
    if (f.kind === "react-select") f.options = await readMenuOptions(page, f.id);
  }
  cacheSchema(page, raw);
  return raw.map(publicField);
}

async function schemaFor(page) {
  if (!cachedSchema(page)) await readSchema(page);
  return cachedSchema(page);
}

async function visibleMenuTexts(page) {
  try {
    await page.locator(MENU_OPTION_SEL).first().waitFor({ state: "visible", timeout: 2500 });
  } catch {
    return [];
  }
  return page.$$eval(MENU_OPTION_SEL, (els) =>
    els.map((e) => (e.innerText || e.textContent || "").trim())
  );
}

// Open the react-select, pick the option that best matches `value`
// (exact, then prefix — "United States" → "United States +1"), click it.
async function chooseMenuOption(page, field, value) {
  const input = page.locator(attrSel("id", field.id));
  await input.click({ timeout: 5000 });
  let texts = await visibleMenuTexts(page);
  let pick = pickOption(texts, value);
  if (!pick) {
    // Long lists (countries) are virtualized — type to filter, then retry.
    await input.fill(String(value));
    texts = await visibleMenuTexts(page);
    pick = pickOption(texts, value);
  }
  if (!pick) {
    await page.keyboard.press("Escape").catch(() => {});
    throw new FillError("option_not_found", field.id);
  }
  await page.locator(MENU_OPTION_SEL).nth(texts.indexOf(pick)).click();
}

async function fillOne(page, field, value) {
  const sel = attrSel("id", field.id);
  switch (field.kind) {
    case "text":
      await page.locator(sel).fill(String(value));
      return;
    case "react-select":
      await chooseMenuOption(page, field, value);
      return;
    case "async-select": {
      const input = page.locator(sel);
      await input.fill(String(value));
      try {
        await page.locator(MENU_OPTION_SEL).first().waitFor({ state: "visible", timeout: 6000 });
        await page.locator(MENU_OPTION_SEL).first().click();
      } catch {
        throw new FillError("location_no_suggestion", field.id);
      }
      return;
    }
    case "native-select":
      await page.locator(sel).selectOption({ label: String(value) });
      return;
    case "file":
      await page.locator(sel).setInputFiles(String(value));
      return;
    case "checkbox-single":
      if (value === true || /^(yes|true|checked|1)$/i.test(String(value))) {
        await page
          .locator(`input[type=checkbox]${field.nameAttr ? attrSel("name", field.nameAttr) : sel}`)
          .first()
          .check();
      }
      return;
    case "checkbox-group":
    case "radio-group": {
      const wanted = Array.isArray(value) ? value : [value];
      for (const w of wanted) {
        const loc = page
          .getByLabel(exactTextRe(w))
          .and(page.locator(`input[name=${JSON.stringify(field.nameAttr || field.id)}]`));
        if ((await loc.count()) === 0) throw new FillError("option_not_found", field.id);
        await loc.first().check();
      }
      return;
    }
    default:
      throw new FillError("unsupported_field", field.id);
  }
}

// values: { [fieldId]: string | string[] } (files: absolute path).
// Returns { filled: string[], errors: [{ id, error }] }.
async function fill(page, values) {
  const schema = await schemaFor(page);
  const filled = [];
  const errors = [];
  for (const field of schema) {
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
    const el = f.id ? document.getElementById(f.id) : null;
    let ok = false;
    if (f.kind === "react-select" || f.kind === "async-select") {
      const box =
        el && (el.closest(".select__control") || el.closest(".select-shell") || el.parentElement);
      const val = box && box.querySelector(".select__single-value, .select__multi-value");
      ok = Boolean(val && (val.innerText || val.textContent || "").trim());
    } else if (f.kind === "file") {
      const group = el && (el.closest(".file-upload") || el.closest('[role="group"]'));
      ok = Boolean(
        (el && el.files && el.files.length > 0) ||
        (group && /\.(pdf|docx?|txt|rtf)\b/i.test(group.innerText || ""))
      );
    } else if (
      f.kind === "checkbox-group" ||
      f.kind === "radio-group" ||
      f.kind === "checkbox-single"
    ) {
      const name = f.nameAttr || f.id;
      ok = Array.from(document.querySelectorAll(`input[name="${CSS.escape(name)}"]`)).some(
        (i) => i.checked
      );
    } else if (el) {
      ok = String(el.value || "").trim().length > 0;
    }
    res[f.id] = ok;
  }
  return res;
}

// Pre-submit check: which required fields are still empty.
async function checkFilled(page) {
  const schema = await schemaFor(page);
  const state = await page.evaluate(filledStateInPage, schema);
  const missing = schema.filter((f) => f.required && !state[f.id]).map((f) => f.id);
  return { missing, state };
}

async function isSuccess(page) {
  const url = page.url();
  const text = await bodyText(page, 3000);
  const byUrl = /\/confirmation(\b|$|\?|\.html)/i.test(url);
  const byText =
    /thank you for applying|application (has been )?(received|submitted)|we('|’)ve received your application/i.test(
      text
    );
  if (byUrl || (byText && !(await page.$(FORM_SEL)))) {
    return { url, text: text.slice(0, 400) };
  }
  return null;
}

async function hasValidationError(page) {
  return page.evaluate(() => {
    const vis = (e) => e && e.offsetParent !== null;
    const errs = Array.from(
      document.querySelectorAll(".helper-text--error, .error-text, [id$='-error']:not(:empty)")
    ).filter((e) => vis(e) && (e.innerText || "").trim());
    return errs.length > 0 || document.querySelectorAll('[aria-invalid="true"]').length > 0;
  });
}

async function submit(page, { timeoutMs = 30000 } = {}) {
  const btn = page
    .locator(
      `${FORM_SEL.split(",")[0]} button[type=submit], button[type=submit]:has-text("Submit")`
    )
    .first();
  if ((await btn.count()) === 0)
    return { ok: false, reason: STOP_REASONS.UNKNOWN_PAGE, evidence: null };
  await btn.click();
  return waitForOutcome(page, { isSuccess, hasValidationError, timeoutMs });
}

module.exports = {
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
