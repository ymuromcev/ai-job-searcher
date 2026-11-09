// Skip-reason vocabulary for the autonomous apply run (RFC 069 §4). Pure.
//
// The bot never hands a row to a human. A row it cannot submit honestly is
// skipped (`apply_state = "skipped"`, `apply_note = "<reason>[: <detail>]"`)
// and counted in the morning report under ONE of these reasons:
//
//   required_empty   a required field is still empty after filling (or could
//                    not be filled) — Submit is never clicked
//   no_honest_answer a required question has no truthful answer
//   captcha          a visible captcha challenge (never solved)
//   account_required the site wants a login / password / new account
//                    (never entered, never created)
//   form_broken      the form did not load, changed shape, or behaved
//                    unexpectedly
//   bot_check        a human / bot check the bot does not pass (email
//                    verification code that never came or was refused, "prove
//                    you are not a bot")
//   closed           the posting is closed
//   no_company_form  no application form on a supported ATS (aggregator link
//                    without a company form, unsupported ATS, no URL)
//
// The detailed adapter / command stop code (e.g. `login_required`,
// `unsupported_ats:<host>`, `fill_error:option_not_found`) travels as the
// detail, never as the reason. Outcomes that are not skips stay as they are:
// `failed` (Submit was clicked, no confirmation — never retried) and the
// guard skips that leave the row untouched (`deadline`, `already_applied`,
// `interrupted_submit`, `status_*`, `row_missing`).

const SKIP_REASONS = Object.freeze([
  "required_empty",
  "no_honest_answer",
  "captcha",
  "account_required",
  "form_broken",
  "bot_check",
  "closed",
  "no_company_form",
]);

const SKIP_SET = new Set(SKIP_REASONS);

// Detailed stop code → vocabulary reason. Prefix match on the part before
// the first ":" (`unsupported_ats:jobs.example` → no_company_form).
const CODE_TO_REASON = Object.freeze({
  captcha: "captcha",
  login_required: "account_required",
  account_required: "account_required",
  email_verification: "bot_check",
  email_code_missing: "bot_check",
  email_code_field_missing: "bot_check",
  email_code_rejected: "bot_check",
  bot_check: "bot_check",
  unknown_page: "form_broken",
  unsupported_field: "form_broken",
  form_broken: "form_broken",
  job_closed: "closed",
  closed: "closed",
  unsupported_ats: "no_company_form",
  unresolved_url: "no_company_form",
  no_application_url: "no_company_form",
  no_company_form: "no_company_form",
  presubmit_check: "required_empty",
  fill_error: "required_empty",
  required_empty: "required_empty",
  resume_missing: "required_empty",
  cover_letter_missing: "required_empty",
  unsupported_required_file: "required_empty",
  no_honest_answer: "no_honest_answer",
  schema_changed: "no_honest_answer",
  // The form asks a question the owner marked "skip such jobs" (RFC 070).
  owner_skip: "no_honest_answer",
});

// Guard skips: the per-row guards that leave the row as it is (the job was
// already handled, or is left for a later run). Never counted as skips.
const GUARD_SKIPS = new Set([
  "deadline",
  "already_applied",
  "interrupted_submit",
  "row_missing",
  "duplicate_job",
]);

function isGuardSkip(reason) {
  const r = String(reason || "");
  return GUARD_SKIPS.has(r) || r.startsWith("status_");
}

function isSkipReason(reason) {
  return SKIP_SET.has(String(reason || ""));
}

// Map a detailed stop code onto the vocabulary. Unknown codes are a form
// the adapter did not understand → form_broken.
function skipReasonFor(code) {
  const raw = String(code || "").trim();
  if (!raw) return "form_broken";
  const head = raw.split(":")[0];
  return CODE_TO_REASON[head] || "form_broken";
}

// The `apply_note` text for a skipped row: "<reason>" or "<reason>: <detail>".
// The registry board parses this shape (registry_view.parseReason).
function skipNote(reason, detail) {
  const d = Array.isArray(detail) ? detail.join("; ") : String(detail || "").trim();
  return d && d !== reason ? `${reason}: ${d}` : reason;
}

module.exports = { SKIP_REASONS, isSkipReason, isGuardSkip, skipReasonFor, skipNote };
