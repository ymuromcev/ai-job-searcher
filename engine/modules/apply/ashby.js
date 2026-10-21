/* global document, CSS -- page.evaluate callbacks run in the browser */
// Ashby application-form adapter (RFC 068 §2).
//
// Structure learned from public forms (2026-10), jobs.ashbyhq.com/<org>/<uuid>/application:
//   - A client-rendered form: `.ashby-application-form-container` holding
//     `.ashby-application-form-field-entry[data-field-path]` rows. System
//     fields use paths `_systemfield_name|email|location|resume`; custom
//     questions use UUID paths.
//   - Each row has `<label class="… ashby-application-form-question-title">`;
//     a `_required_*` CSS-module class marks required questions. The label's
//     `for` points at the control when there is a single native control.
//   - Yes/No questions are two <button data-option="yes|no"> plus a hidden
//     checkbox; location is a combobox (`role=combobox`, options as
//     `[role=option]`); files are hidden <input type=file> in a dropzone.
//   - An invisible reCAPTCHA Enterprise is always loaded (not a stop).
//   - Success replaces the form in place (no URL change) with a
//     "successfully submitted" / "Thank you for applying" message.

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

const NAME = "ashby";
const ENTRY_SEL = ".ashby-application-form-field-entry";

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

/* Runs in the page. */
function scanFormInPage(entrySel) {
  const txt = (el) => (el ? el.innerText || el.textContent || "" : "");
  const out = [];
  for (const entry of document.querySelectorAll(entrySel)) {
    const path = entry.getAttribute("data-field-path");
    if (!path) continue;
    const title =
      entry.querySelector(".ashby-application-form-question-title") ||
      entry.querySelector("label") ||
      entry.querySelector("legend");
    const label = txt(title);
    const required =
      /(^|\s)_?required/i.test((title && title.className) || "") || /\*\s*$/.test(label.trim());
    const forId = title && title.getAttribute("for");
    const target = forId ? document.getElementById(forId) : null;
    const base = { id: path, label, required };

    const file = entry.querySelector('input[type="file"]');
    if (file) {
      out.push({ ...base, type: "file", kind: "file", options: [] });
      continue;
    }
    const yesno = entry.querySelectorAll(
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
      continue;
    }
    const combo = entry.querySelector('input[role="combobox"]');
    if (combo) {
      out.push({ ...base, type: "text", kind: "combo", options: [] });
      continue;
    }
    const radios = entry.querySelectorAll('input[type="radio"]');
    if (radios.length) {
      out.push({
        ...base,
        type: "radio",
        kind: "radio",
        options: Array.from(radios).map((r) => txt(r.closest("label")).trim() || r.value),
      });
      continue;
    }
    const checks = entry.querySelectorAll('input[type="checkbox"]');
    if (checks.length) {
      out.push({
        ...base,
        type: "checkbox",
        kind: checks.length === 1 ? "checkbox-single" : "checkbox",
        options:
          checks.length === 1
            ? []
            : Array.from(checks).map((r) => txt(r.closest("label")).trim() || r.value),
      });
      continue;
    }
    const ta = entry.querySelector("textarea");
    if (ta) {
      out.push({ ...base, type: "textarea", kind: "text", options: [] });
      continue;
    }
    const input = entry.querySelector("input:not([type=hidden])");
    if (input) out.push({ ...base, type: "text", kind: "text", options: [] });
  }
  return out;
}

async function readSchema(page) {
  const raw = await page.evaluate(scanFormInPage, ENTRY_SEL);
  if (!raw || raw.length === 0) throw new Error("ashby: application form not found");
  for (const f of raw) f.label = cleanLabel(f.label);
  cacheSchema(page, raw);
  return raw.map(publicField);
}

async function schemaFor(page) {
  if (!cachedSchema(page)) await readSchema(page);
  return cachedSchema(page);
}

function entry(page, id) {
  return page.locator(`${ENTRY_SEL}${attrSel("data-field-path", id)}`);
}

async function clickLabelled(scope, wanted, fieldId, inputType) {
  const label = scope.locator("label").filter({ hasText: exactTextRe(wanted) });
  if ((await label.count()) > 0) {
    const input = label.first().locator(`input[type=${inputType}]`);
    if ((await input.count()) > 0) await input.first().check();
    else await label.first().click();
    return;
  }
  throw new FillError("option_not_found", fieldId);
}

async function fillOne(page, field, value) {
  const scope = entry(page, field.id);
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
      const opt = page.locator('[role="listbox"] [role="option"], [role="option"]');
      try {
        await opt.first().waitFor({ state: "visible", timeout: 6000 });
        await opt.first().click();
      } catch {
        throw new FillError("location_no_suggestion", field.id);
      }
      return;
    }
    case "yesno": {
      const btn = scope.locator("button").filter({ hasText: exactTextRe(value) });
      if ((await btn.count()) === 0) throw new FillError("option_not_found", field.id);
      await btn.first().click();
      return;
    }
    case "radio":
      await clickLabelled(scope, Array.isArray(value) ? value[0] : value, field.id, "radio");
      return;
    case "checkbox":
      for (const w of Array.isArray(value) ? value : [value]) {
        await clickLabelled(scope, w, field.id, "checkbox");
      }
      return;
    case "checkbox-single":
      if (value === true || /^(yes|true|checked|1)$/i.test(String(value))) {
        await scope.locator("input[type=checkbox]").first().check();
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
function filledStateInPage({ fields, entrySel }) {
  const res = {};
  for (const f of fields) {
    const scope = document.querySelector(`${entrySel}[data-field-path="${CSS.escape(f.id)}"]`);
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
        ok = Array.from(scope.querySelectorAll("input")).some((i) => i.checked);
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

async function checkFilled(page) {
  const schema = await schemaFor(page);
  const state = await page.evaluate(filledStateInPage, { fields: schema, entrySel: ENTRY_SEL });
  const missing = schema.filter((f) => f.required && !state[f.id]).map((f) => f.id);
  return { missing, state };
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
};
