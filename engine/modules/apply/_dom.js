/* global document, window -- page.evaluate callbacks run in the browser */
// Shared browser-side helpers for the apply adapters (RFC 068 §2).
//
// Everything here takes a Playwright `page`. Selectors that are specific to
// one ATS live in that adapter; this file only knows about things every
// form shares: captcha challenges, login walls, email verification screens,
// and the "wait for confirmation" loop.

// Typed stop reasons. The command maps them onto apply_state:
//   captcha / login_required / email_verification / unknown_page /
//   job_closed → manual;  validation_error / no_confirmation → failed.
const STOP_REASONS = Object.freeze({
  CAPTCHA: "captcha",
  LOGIN: "login_required",
  EMAIL_VERIFICATION: "email_verification",
  UNKNOWN_PAGE: "unknown_page",
  JOB_CLOSED: "job_closed",
  VALIDATION: "validation_error",
  NO_CONFIRMATION: "no_confirmation",
});

// Runs inside the page. Returns a STOP_REASONS value or null.
//
// Captcha: Greenhouse / Ashby load an *invisible* reCAPTCHA Enterprise on
// every form and Lever loads an invisible hCaptcha. Their presence is normal
// and not a stop. A stop is a *visible* challenge: the reCAPTCHA "bframe"
// image grid, a checkbox-style anchor (no `size=invisible`), the hCaptcha
// challenge frame, or a Cloudflare Turnstile widget.
/* istanbul ignore next -- executed in the browser */
function detectBlockerInPage() {
  const visible = (el, minSize = 30) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < minSize || r.height < minSize) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight * 4) return false;
    let n = el;
    while (n && n.nodeType === 1) {
      const cs = window.getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
      n = n.parentElement;
    }
    return true;
  };
  for (const f of document.querySelectorAll("iframe")) {
    const src = String(f.getAttribute("src") || "").toLowerCase();
    const title = String(f.getAttribute("title") || "").toLowerCase();
    const challenge =
      /recaptcha\/(api2|enterprise)\/bframe/.test(src) ||
      /recaptcha challenge/.test(title) ||
      (/hcaptcha/.test(src) && /challenge/.test(src)) ||
      /hcaptcha challenge|content of the hcaptcha challenge/.test(title) ||
      /challenges\.cloudflare\.com/.test(src);
    const checkbox =
      (/recaptcha\/(api2|enterprise)\/anchor/.test(src) && !/size=invisible/.test(src)) ||
      (/hcaptcha/.test(src) && /checkbox/.test(src + title)) ||
      /widget containing checkbox for hcaptcha/.test(title);
    if ((challenge || checkbox) && visible(f)) return "captcha";
  }
  const turnstile = document.querySelector(".cf-turnstile");
  if (turnstile && visible(turnstile)) return "captcha";

  const text = (document.body && document.body.innerText) || "";
  const pw = Array.from(document.querySelectorAll('input[type="password"]')).some((i) =>
    visible(i, 1)
  );
  if (pw) return "login_required";
  if (/\b(sign in|log in|login) to (apply|continue)\b|\bcreate an account to apply\b/i.test(text)) {
    return "login_required";
  }
  if (
    /\b(security code|verification code|verify your email|confirm your email)\b/i.test(text) &&
    Array.from(document.querySelectorAll("input")).some(
      (i) =>
        visible(i, 1) &&
        /code|security|verif|otp/i.test(
          `${i.id} ${i.name} ${i.getAttribute("aria-label") || ""} ${i.getAttribute("autocomplete") || ""}`
        )
    )
  ) {
    return "email_verification";
  }
  return null;
}

async function detectBlocker(page) {
  try {
    return await page.evaluate(detectBlockerInPage);
  } catch {
    return null;
  }
}

async function bodyText(page, max = 4000) {
  try {
    const t = await page.evaluate(() => (document.body ? document.body.innerText : ""));
    return String(t || "").slice(0, max);
  } catch {
    return "";
  }
}

// After navigation: poll until the application form shows up, a blocker
// appears, or the page reads as a closed posting. Returns
// { state: "form" } | { state: "blocked", reason } | { state: "closed" } |
// { state: "unknown" }.
async function waitForForm(page, { formSel, closedRe, timeoutMs = 15000, pollMs = 300 }) {
  const started = Date.now();
  for (;;) {
    let hasForm = false;
    try {
      hasForm = Boolean(await page.$(formSel));
    } catch {
      hasForm = false; // navigation in flight
    }
    if (hasForm) return { state: "form" };
    const blocker = await detectBlocker(page);
    if (blocker) return { state: "blocked", reason: blocker };
    const text = await bodyText(page, 3000);
    if (closedRe && closedRe.test(text)) return { state: "closed" };
    if (Date.now() - started >= timeoutMs) return { state: "unknown" };
    await sleep(pollMs);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Poll after the submit click until one of: success evidence, a blocker,
// a validation error (after `validationGraceMs`), or the timeout.
//
//   isSuccess(page)          → evidence object | null
//   hasValidationError(page) → boolean
//
// Returns { ok: true, evidence } | { ok: false, reason, evidence }.
async function waitForOutcome(page, opts) {
  const {
    isSuccess,
    hasValidationError = async () => false,
    timeoutMs = 30000,
    pollMs = 500,
    validationGraceMs = 2500,
  } = opts;
  const started = Date.now();
  for (;;) {
    let evidence = null;
    try {
      evidence = await isSuccess(page);
    } catch {
      evidence = null; // navigation in flight
    }
    if (evidence) return { ok: true, evidence };
    const blocker = await detectBlocker(page);
    if (blocker) {
      return { ok: false, reason: blocker, evidence: { url: safeUrl(page) } };
    }
    const elapsed = Date.now() - started;
    if (elapsed >= validationGraceMs) {
      let invalid = false;
      try {
        invalid = await hasValidationError(page);
      } catch {
        invalid = false;
      }
      if (invalid) {
        return {
          ok: false,
          reason: STOP_REASONS.VALIDATION,
          evidence: { url: safeUrl(page), text: await bodyText(page, 600) },
        };
      }
    }
    if (elapsed >= timeoutMs) {
      return {
        ok: false,
        reason: STOP_REASONS.NO_CONFIRMATION,
        evidence: { url: safeUrl(page), text: await bodyText(page, 600) },
      };
    }
    await sleep(pollMs);
  }
}

function safeUrl(page) {
  try {
    return page.url();
  } catch {
    return "";
  }
}

// CSS attribute selector for an exact id / name (ids may start with a digit,
// names may contain brackets — `#id` would not work for either).
function attrSel(attr, value) {
  return `[${attr}=${JSON.stringify(String(value))}]`;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactTextRe(text) {
  return new RegExp(`^\\s*${escapeRegex(String(text).trim())}\\s*$`, "i");
}

// Per-page schema cache so `fill` / `checkFilled` can reuse what
// `readSchema` learned (internal control kinds never leave the adapter).
const schemaCache = new WeakMap();

function cacheSchema(page, entries) {
  schemaCache.set(page, entries);
}

function cachedSchema(page) {
  return schemaCache.get(page) || null;
}

// Strip adapter-internal keys: the public field contract is
// { id, label, type, required, options }.
function publicField(f) {
  return {
    id: f.id,
    label: f.label,
    type: f.type,
    required: Boolean(f.required),
    options: Array.isArray(f.options) ? f.options : [],
  };
}

function cleanLabel(s) {
  return String(s || "")
    .replace(/[✱*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

class FillError extends Error {
  constructor(code, fieldId) {
    super(`${code}${fieldId ? `:${fieldId}` : ""}`);
    this.code = code;
    this.fieldId = fieldId || null;
  }
}

module.exports = {
  STOP_REASONS,
  detectBlocker,
  detectBlockerInPage,
  bodyText,
  waitForOutcome,
  waitForForm,
  attrSel,
  exactTextRe,
  escapeRegex,
  cacheSchema,
  cachedSchema,
  publicField,
  cleanLabel,
  sleep,
  FillError,
};
