/* global document, CSS -- page.evaluate callbacks run in the browser */
// Ashby application-form adapter (RFC 068 §2, RFC 069 §4).
//
// Structure learned from public forms (2026-10 / 2026-11),
// jobs.ashbyhq.com/<org>/<uuid>/application:
//   - A client-rendered form: `.ashby-application-form-container` holding one
//     element per question with `data-field-path`. System fields use paths
//     `_systemfield_name|email|location|resume|…`; custom questions use UUID
//     paths. Two row shapes:
//       a. `<div class="… ashby-application-form-field-entry" data-field-path>`
//          — text, textarea, file, yes/no, combobox questions;
//       b. `<div data-field-path><fieldset class="_fieldEntry_… ashby-
//          application-form-input-radio-group | …-checkbox-group">` — radio
//          groups, checkbox groups, select comboboxes. The outer div has NO
//          `field-entry` class: reading only `.ashby-application-form-field-
//          entry` missed every one of them, so required radio groups stayed
//          empty while Submit was clicked (the October 2026 failure).
//   - The EEO survey is a second `.ashby-survey-form-container` with the same
//     `div[data-field-path] > fieldset` rows (optional questions).
//   - Each row has `<label class="… ashby-application-form-question-title">`;
//     a `_required_*` CSS-module class marks required questions.
//   - Radio / checkbox options: `<input id="…-labeled-radio-N">` inside a
//     styled span (opacity 0) + a sibling `<label for=…>` with the text.
//   - Yes/No questions are two <button data-option="yes|no"> plus a hidden
//     checkbox; location and single-select questions are comboboxes
//     (`role=combobox`, options as `[role=option]`); files are hidden
//     <input type=file> in a dropzone.
//   - A phone row may carry SMS / WhatsApp consent radio groups (inside a
//     `…texting-consent…` block): read as separate radio fields
//     (`<path>#<radio name>`), answered by the marketing-consent rule (No).
//   - An invisible reCAPTCHA Enterprise is always loaded (not a stop).
//   - Success replaces the form in place (no URL change) with a
//     "successfully submitted" / "Thank you for applying" message.
//
// The browser window for Ashby is visible (browser.headlessFor): its
// invisible bot check rejects the headless browser.

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
  SUBMIT_TIMEOUT_MS,
} = require("./_dom.js");
const { pickOption } = require("./question_match.js");

const NAME = "ashby";
const ENTRY_SEL = ".ashby-application-form-field-entry";
const ROW_SEL = "[data-field-path]";
const OPTION_SEL = '[role="listbox"] [role="option"], [role="option"]';

function parse(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^jobs\.ashbyhq\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})(\/application)?\/?$/i);
  return m ? { slug: decodeURIComponent(m[1]), jobId: m[2] } : null;
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
  return `https://jobs.ashbyhq.com/${encodeURIComponent(p.slug)}/${p.jobId}/application`;
}

const CLOSED_RE =
  /job not found|no longer (accepting|available|open)|position (has been )?(filled|closed)/i;

async function open(page, url, { timeoutMs = 45000, formTimeoutMs = 20000 } = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  const r = await waitForForm(page, {
    formSel: ENTRY_SEL,
    closedRe: CLOSED_RE,
    timeoutMs: formTimeoutMs,
  });
  if (r.state === "form") return { ok: true };
  if (r.state === "blocked") return { ok: false, reason: r.reason };
  if (r.state === "closed") return { ok: false, reason: STOP_REASONS.JOB_CLOSED };
  return { ok: false, reason: STOP_REASONS.UNKNOWN_PAGE };
}

/* Runs in the page. Raw field inventory, internal `kind` included. Option
   inputs of radio / checkbox groups are tagged `data-ajs-opt="<id>|<n>"` so
   `fill` / `checkFilled` find them again without re-deriving labels. */
function scanFormInPage(rowSel) {
  const txt = (el) => (el ? el.innerText || el.textContent || "" : "");
  const optionText = (i) => {
    const byFor = i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`) : null;
    const t = txt(byFor || i.closest("label")).trim();
    return t || i.value || i.getAttribute("name") || "";
  };
  const inConsent = (el) => Boolean(el.closest('[class*="consent" i]'));
  const tag = (inputs, id) =>
    inputs.map((i, k) => {
      i.setAttribute("data-ajs-opt", `${id}|${k}`);
      return optionText(i).replace(/\s+/g, " ").trim();
    });
  const out = [];
  const seen = new Set();
  for (const row of document.querySelectorAll(rowSel)) {
    const path = row.getAttribute("data-field-path");
    if (!path || seen.has(path)) continue;
    if (row.parentElement && row.parentElement.closest(rowSel)) continue; // nested
    seen.add(path);
    const title =
      row.querySelector(".ashby-application-form-question-title") ||
      row.querySelector("label") ||
      row.querySelector("legend");
    let label = txt(title);
    if (!label.trim()) {
      // Consent rows ship an empty title and the question in the description.
      label = txt(row.querySelector(".ashby-application-form-question-description"));
    }
    const controls = Array.from(row.querySelectorAll("input, select, textarea")).filter(
      (c) => !inConsent(c)
    );
    const required =
      /(^|\s)_?required/i.test((title && title.className) || "") ||
      /\*\s*$/.test(label.trim()) ||
      controls.some(
        (c) =>
          c.type !== "hidden" &&
          c.type !== "checkbox" &&
          (c.required || c.getAttribute("aria-required") === "true")
      );
    const forId = title && title.getAttribute("for");
    const target = forId ? document.getElementById(forId) : null;
    const base = { id: path, label, required };

    // SMS / WhatsApp consent radio groups living inside a phone row.
    const consentNames = [];
    for (const r of row.querySelectorAll('input[type="radio"]')) {
      if (inConsent(r) && r.name && !consentNames.includes(r.name)) consentNames.push(r.name);
    }
    const pushConsent = () => {
      for (const name of consentNames) {
        const inputs = Array.from(row.querySelectorAll('input[type="radio"]')).filter(
          (r) => r.name === name
        );
        const item = inputs[0].closest("li");
        const channel = txt(item && item.querySelector('[class*="ItemLabel" i]')).trim();
        const id = `${path}#${name}`;
        out.push({
          id,
          label: `${channel ? `${channel} ` : ""}text message consent`,
          type: "radio",
          kind: "radio",
          // Ashby asks to "check Yes or No"; treat it as required so the
          // pre-submit guard never lets an empty consent through.
          required: true,
          options: tag(inputs, id),
        });
      }
    };

    const file = row.querySelector('input[type="file"]');
    if (file) {
      out.push({ ...base, type: "file", kind: "file", options: [] });
      continue;
    }
    const yesno = row.querySelectorAll(
      ".ashby-application-form-input-yesno-option, button[data-option]"
    );
    if (yesno.length >= 2) {
      out.push({
        ...base,
        type: "radio",
        kind: "yesno",
        options: Array.from(yesno).map((b) => txt(b).trim()),
      });
      continue;
    }
    const radios = controls.filter((c) => c.type === "radio");
    if (radios.length) {
      out.push({ ...base, type: "radio", kind: "radio", options: tag(radios, path) });
      continue;
    }
    const checks = controls.filter((c) => c.type === "checkbox");
    if (checks.length && !(target && target.tagName === "INPUT" && target.type !== "checkbox")) {
      const texts = tag(checks, path);
      // One box ("I understand", "I agree") is a yes/no acknowledgement: no
      // options, answered "Yes" (the legal rule) — like Greenhouse / Lever.
      const single = checks.length === 1;
      out.push({
        ...base,
        label: single && !label.trim() ? texts[0] : label,
        type: "checkbox",
        kind: single ? "checkbox-single" : "checkbox",
        options: single ? [] : texts,
      });
      continue;
    }
    if (target && target.tagName === "TEXTAREA") {
      out.push({ ...base, type: "textarea", kind: "text", options: [] });
      continue;
    }
    if (target && target.tagName === "SELECT") {
      out.push({
        ...base,
        type: "select",
        kind: "select",
        options: Array.from(target.options)
          .filter((o) => o.value !== "")
          .map((o) => o.text.trim()),
      });
      continue;
    }
    if (target && target.tagName === "INPUT" && target.getAttribute("role") !== "combobox") {
      const t = String(target.getAttribute("type") || "text").toLowerCase();
      const ft = t === "email" ? "email" : t === "tel" ? "phone" : t === "url" ? "url" : "text";
      out.push({ ...base, type: ft, kind: "text", options: [] });
      pushConsent();
      continue;
    }
    const combo = row.querySelector('input[role="combobox"]');
    if (combo) {
      // Location is a place search (any typed city); other comboboxes are
      // single-select pickers whose options are read when the schema is.
      const place = /location/i.test(path);
      out.push({
        ...base,
        type: place ? "text" : "select",
        kind: place ? "combo" : "combo-select",
        options: [],
      });
      continue;
    }
    const ta = row.querySelector("textarea");
    if (ta) {
      out.push({ ...base, type: "textarea", kind: "text", options: [] });
      continue;
    }
    const input = row.querySelector("input:not([type=hidden])");
    if (input) {
      out.push({ ...base, type: "text", kind: "text", options: [] });
      pushConsent();
      continue;
    }
    // A required question with a control we do not know: keep it in the
    // schema so the pre-submit guard sees it empty (never a silent submit).
    if (required && row.querySelector('select, [role], [contenteditable="true"], button')) {
      out.push({ ...base, type: "text", kind: "unknown", options: [] });
    }
  }
  return out;
}

async function scan(page) {
  const raw = (await page.evaluate(scanFormInPage, ROW_SEL)) || [];
  for (const f of raw) f.label = cleanLabel(f.label);
  return raw;
}

// Visible option texts of the open combobox list.
async function visibleOptionTexts(page) {
  try {
    await page.locator(OPTION_SEL).first().waitFor({ state: "visible", timeout: 2500 });
  } catch {
    return [];
  }
  return page.$$eval(OPTION_SEL, (els) =>
    els.map((e) => (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim())
  );
}

async function readComboOptions(page, field) {
  const input = row(page, field.id).locator('input[role="combobox"]').first();
  try {
    await input.click({ timeout: 4000 });
  } catch {
    return [];
  }
  const texts = await visibleOptionTexts(page);
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(100);
  return texts.filter(Boolean).slice(0, 300);
}

async function readSchema(page) {
  const raw = await scan(page);
  if (!raw.length) throw new Error("ashby: application form not found");
  for (const f of raw) {
    if (f.kind === "combo-select") f.options = await readComboOptions(page, f);
  }
  cacheSchema(page, raw);
  return raw.map(publicField);
}

async function schemaFor(page) {
  if (!cachedSchema(page)) await readSchema(page);
  return cachedSchema(page);
}

function row(page, id) {
  const path = String(id).split("#")[0];
  return page.locator(attrSel("data-field-path", path)).first();
}

// Tick one tagged option. The real input sits under a styled circle, so a
// plain check() can be intercepted: fall back to its label, then to a DOM
// click (React listens to click for radios / checkboxes).
async function checkOption(page, field, wanted) {
  const pick = pickOption(field.options, wanted);
  if (!pick) throw new FillError("option_not_found", field.id);
  await tickTagged(page, field.id, field.options.indexOf(pick));
}

async function tickTagged(page, fieldId, k) {
  const input = page.locator(attrSel("data-ajs-opt", `${fieldId}|${k}`)).first();
  if ((await input.count()) === 0) throw new FillError("option_not_found", fieldId);
  const checked = () => input.isChecked().catch(() => false);
  if (await checked()) return;
  // Its own label first: visible and never covered by the circle.
  const forLabel = page.locator(
    `label[for=${JSON.stringify((await input.getAttribute("id")) || "\u0000")}]`
  );
  if ((await forLabel.count()) > 0) {
    try {
      await forLabel.first().click({ timeout: 2000 });
    } catch {
      // fall through to the input itself
    }
  }
  if (!(await checked())) {
    try {
      await input.check({ timeout: 1500 });
    } catch {
      // intercepted by the styled circle — DOM click below
    }
  }
  if (!(await checked())) await input.evaluate((el) => el.click());
  if (!(await checked())) throw new FillError("option_not_checked", fieldId);
}

async function chooseComboOption(page, field, value) {
  const input = row(page, field.id).locator('input[role="combobox"]').first();
  await input.click({ timeout: 5000 });
  let texts = await visibleOptionTexts(page);
  let pick = pickOption(texts, value);
  if (!pick) {
    await input.fill(String(value));
    texts = await visibleOptionTexts(page);
    pick = pickOption(texts, value);
  }
  if (!pick) {
    await page.keyboard.press("Escape").catch(() => {});
    throw new FillError("option_not_found", field.id);
  }
  await page.locator(OPTION_SEL).nth(texts.indexOf(pick)).click();
}

async function fillOne(page, field, value) {
  const scope = row(page, field.id);
  switch (field.kind) {
    case "text": {
      const ctl = scope
        .locator("textarea, input:not([type=hidden]):not([type=checkbox]):not([type=radio])")
        .first();
      await ctl.fill(String(value));
      return;
    }
    case "combo": {
      const input = scope.locator('input[role="combobox"]').first();
      await input.fill(String(value));
      const opt = page.locator(OPTION_SEL);
      try {
        await opt.first().waitFor({ state: "visible", timeout: 6000 });
        await opt.first().click();
      } catch {
        throw new FillError("location_no_suggestion", field.id);
      }
      return;
    }
    case "combo-select":
      await chooseComboOption(page, field, Array.isArray(value) ? value[0] : value);
      return;
    case "yesno": {
      const btn = scope.locator("button").filter({ hasText: exactTextRe(value) });
      if ((await btn.count()) === 0) throw new FillError("option_not_found", field.id);
      await btn.first().click();
      return;
    }
    case "radio":
      await checkOption(page, field, Array.isArray(value) ? value[0] : value);
      return;
    case "checkbox":
      for (const w of Array.isArray(value) ? value : [value]) await checkOption(page, field, w);
      return;
    case "checkbox-single":
      if (value === true || /^(yes|true|checked|1)$/i.test(String(value))) {
        await tickTagged(page, field.id, 0);
      }
      return;
    case "select":
      await scope
        .locator("select")
        .first()
        .selectOption({ label: String(value) });
      return;
    case "file":
      await scope.locator("input[type=file]").first().setInputFiles(String(value));
      await sleep(300);
      return;
    default:
      throw new FillError("unsupported_field", field.id);
  }
}

async function fill(page, values) {
  const schema = await schemaFor(page);
  // Re-tag the option inputs: React may have re-rendered rows since the read.
  await page.evaluate(scanFormInPage, ROW_SEL).catch(() => null);
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
    const path = String(f.id).split("#")[0];
    const scope = document.querySelector(`[data-field-path="${CSS.escape(path)}"]`);
    let ok = false;
    if (scope) {
      if (f.kind === "file") {
        const input = scope.querySelector('input[type="file"]');
        ok = Boolean(
          (input && input.files && input.files.length) ||
          /\.(pdf|docx?|txt|rtf)\b/i.test(scope.innerText || "")
        );
      } else if (f.kind === "yesno") {
        ok = Array.from(scope.querySelectorAll("button")).some(
          (b) =>
            b.getAttribute("aria-pressed") === "true" ||
            /(^|\s|_)(active|selected)/i.test(b.className)
        );
      } else if (f.kind === "radio" || f.kind === "checkbox" || f.kind === "checkbox-single") {
        const tagged = Array.from(document.querySelectorAll("[data-ajs-opt]")).filter((i) =>
          String(i.getAttribute("data-ajs-opt")).startsWith(`${f.id}|`)
        );
        ok = tagged.some((i) => i.checked);
      } else if (f.kind === "combo" || f.kind === "combo-select") {
        // The chosen value: an element whose class token IS a selected-value
        // marker (react-select "singleValue" / "single-value" — never a
        // substring match, which "unselected" would pass), or a non-option
        // element with aria-selected="true". The open listbox and its
        // options never count: they list choices, not the choice.
        const input = scope.querySelector('input[role="combobox"]');
        const MARKER = /(^|[-_])(singlevalue|single-value|selected-value|selectedvalue)$/i;
        const inList = (el) =>
          el.getAttribute("role") === "option" || Boolean(el.closest('[role="listbox"]'));
        const chosen = Array.from(scope.querySelectorAll("[class], [aria-selected]")).find(
          (el) =>
            !inList(el) &&
            (el.getAttribute("aria-selected") === "true" ||
              Array.from(el.classList || []).some((c) => MARKER.test(c))) &&
            (el.innerText || el.textContent || "").trim()
        );
        ok = Boolean((input && String(input.value || "").trim()) || chosen);
      } else if (f.kind === "unknown") {
        ok = false;
      } else {
        const ctl = scope.querySelector(
          "textarea, select, input:not([type=hidden]):not([type=checkbox]):not([type=radio])"
        );
        ok = Boolean(ctl && String(ctl.value || "").trim());
      }
    }
    res[f.id] = ok;
  }
  return res;
}

// Pre-submit guard: re-read the live form (a follow-up question may have
// appeared after an answer) and report every required field still empty.
async function checkFilled(page) {
  const cached = (await schemaFor(page)) || [];
  const live = await scan(page);
  const kinds = new Map(cached.map((f) => [f.id, f]));
  const fields = live.length
    ? live.map((f) => (kinds.has(f.id) ? { ...f, kind: kinds.get(f.id).kind } : f))
    : cached;
  const state = await page.evaluate(filledStateInPage, fields);
  const empty = fields.filter((f) => f.required && !state[f.id]);
  return {
    missing: empty.map((f) => f.id),
    missingLabels: empty.map((f) => f.label || f.id),
    state,
  };
}

async function isSuccess(page) {
  const url = page.url();
  const success = await page.$(".ashby-application-form-success-container");
  const text = await bodyText(page, 3000);
  const byText =
    /application (was )?(successfully )?submitted|thank you for applying|thanks for applying/i.test(
      text
    );
  if (success || (byText && !(await page.$(ENTRY_SEL)))) return { url, text: text.slice(0, 400) };
  return null;
}

async function hasValidationError(page) {
  return page.evaluate(() => {
    const text = (document.body && document.body.innerText) || "";
    if (/needs corrections|missing entry for required field|please fill out/i.test(text))
      return true;
    return Array.from(document.querySelectorAll('[class*="error" i]')).some(
      (e) => e.offsetParent !== null && (e.innerText || "").trim()
    );
  });
}

async function submit(page, { timeoutMs = SUBMIT_TIMEOUT_MS, ignoreBlockers = [] } = {}) {
  let btn = page.locator(".ashby-application-form-submit-button");
  if ((await btn.count()) === 0) btn = page.locator('button:has-text("Submit Application")');
  if ((await btn.count()) === 0)
    return { ok: false, reason: STOP_REASONS.UNKNOWN_PAGE, evidence: null };
  await btn.first().click();
  return waitForOutcome(page, { isSuccess, hasValidationError, timeoutMs, ignoreBlockers });
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
  // Browser-side helper, exported for tests (page.evaluate).
  filledStateInPage,
};
