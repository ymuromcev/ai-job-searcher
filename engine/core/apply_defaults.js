// RFC 068 §4 — per-profile standard answers for application forms.
//
// `profiles/<id>/apply_defaults.json` holds the answers the apply bot gives
// to typical form questions without generating text: work authorization,
// sponsorship, relocation, EEO, desired salary, "how did you hear about us".
// `profile_loader.loadProfile` reads it onto `profile.applyDefaults` (null
// when the file is absent). This module is pure: the shape contract, a
// validator used by `validate`, and the salary-floor accessor used by the
// prepare filter.
//
// Contract (all keys required when the file exists):
//   {
//     "work_authorization": {
//       "authorized_us": true,             // boolean
//       "requires_sponsorship": false,     // boolean
//       "status_text": "US Permanent Resident (Green Card)"  // non-empty string
//     },
//     "relocation": { "willing": false,    // boolean — outside within_states
//                     "within_states": ["CA"] },  // optional: willing for offices there
//     "eeo": { "policy": "decline" },      // one of VALID_EEO_POLICIES
//     "salary": {
//       "floor": 120000,                   // number >= 0 — published range top below this → skip
//       "default": 180000,                 // number >= floor — used when no range is published
//       "currency": "USD"                  // ISO 4217 code
//     },
//     "how_did_you_hear_default": "Company careers page"  // non-empty string
//   }
//
// Optional keys (owner decisions, 2026-10-21):
//   "address": { "street", "unit", "city", "state", "state_name", "zip", "country" }  // strings
//   "citizenship": { "countries": ["..."], "us_permanent_resident": true }
//   "legal_acknowledgements": "accept"   // tick truthfulness / arbitration / AI-policy / privacy consents
//   "tailor_ship_min_coverage": 75       // Strong rows whose tailoring stalled on JD-phrase gaps
//                                        // still go to To Apply at/above this coverage (0–100)
//   "relatives_at_company": false        // "Do you have relatives working at X?" → No
//   "start_weeks_after_offer": 2         // "When can you start?" → "2 weeks after an offer"
//   "choice_policy": {                   // RFC 069 §4; engine defaults in question_match.js
//     "eeo": "decline" | "blank",        //   decline option when offered / leave optional EEO empty
//     "how_did_you_hear": ["company website", "job board", "other"]  // option preference order
//   }
//   "standing_answers": [                // owner's answers to recurring questions (2026-11-09):
//     { "question": "Do you have a valid US driver's license?", "answer": "Yes" }
//   ]                                    // read by the drafter and the truth review as a source;
//                                        // `apply --phase pre` fills an exact match itself
//   "skip_questions": [                  // RFC 070: "skip such jobs" — a form asking one of
//     { "question": "..." }              // these is skipped (no_honest_answer: owner_skip: …)
//   ]
//   Entries in both lists that carry "notion_page_id" (and "question_key")
//   are written by `questions --phase pull` from the Notion Q&A database
//   (RFC 070) and are replaced on every pull; entries without it are the
//   owner's own.

const APPLY_DEFAULTS_FILE = "apply_defaults.json";

// "decline" = answer EEO questions with "Decline to self-identify" or the
// closest option. Extend this set (and the apply adapters) to add policies.
const VALID_EEO_POLICIES = Object.freeze(["decline"]);

const TOP_LEVEL_KEYS = Object.freeze([
  "work_authorization",
  "relocation",
  "eeo",
  "salary",
  "how_did_you_hear_default",
  "address",
  "citizenship",
  "legal_acknowledgements",
  "tailor_ship_min_coverage",
  "relatives_at_company",
  "start_weeks_after_offer",
  "choice_policy",
  "standing_answers",
  "skip_questions",
]);

const VALID_CHOICE_EEO = Object.freeze(["decline", "blank"]);

const ADDRESS_KEYS = Object.freeze([
  "street",
  "unit",
  "city",
  "state",
  "state_name",
  "zip",
  "country",
]);
const VALID_LEGAL_POLICIES = Object.freeze(["accept", "manual"]);

const CURRENCY_RE = /^[A-Z]{3}$/;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isNonNegativeNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Validate an apply_defaults object against the RFC 068 contract.
 *
 * @param {unknown} raw  Parsed apply_defaults.json content.
 * @returns {Array<{severity: "error"|"warn", field: string, message: string}>}
 *   Empty array when the shape is valid. Never throws.
 */
function validateApplyDefaults(raw) {
  const issues = [];
  const err = (field, message) => issues.push({ severity: "error", field, message });
  const warn = (field, message) => issues.push({ severity: "warn", field, message });
  const base = "apply_defaults";

  if (!isPlainObject(raw)) {
    err(base, "must be a JSON object");
    return issues;
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.includes(key)) warn(`${base}.${key}`, "unknown key (ignored)");
  }

  const wa = raw.work_authorization;
  if (!isPlainObject(wa)) {
    err(`${base}.work_authorization`, "must be an object");
  } else {
    if (typeof wa.authorized_us !== "boolean") {
      err(`${base}.work_authorization.authorized_us`, "must be a boolean");
    }
    if (typeof wa.requires_sponsorship !== "boolean") {
      err(`${base}.work_authorization.requires_sponsorship`, "must be a boolean");
    }
    if (!isNonEmptyString(wa.status_text)) {
      err(`${base}.work_authorization.status_text`, "must be a non-empty string");
    }
  }

  const rel = raw.relocation;
  if (!isPlainObject(rel)) {
    err(`${base}.relocation`, "must be an object");
  } else if (typeof rel.willing !== "boolean") {
    err(`${base}.relocation.willing`, "must be a boolean");
  } else if (
    rel.within_states !== undefined &&
    !(Array.isArray(rel.within_states) && rel.within_states.every(isNonEmptyString))
  ) {
    err(`${base}.relocation.within_states`, "must be an array of state codes");
  }

  const eeo = raw.eeo;
  if (!isPlainObject(eeo)) {
    err(`${base}.eeo`, "must be an object");
  } else if (!VALID_EEO_POLICIES.includes(eeo.policy)) {
    err(
      `${base}.eeo.policy`,
      `must be one of [${VALID_EEO_POLICIES.join(", ")}], got ${JSON.stringify(eeo.policy)}`
    );
  }

  const sal = raw.salary;
  if (!isPlainObject(sal)) {
    err(`${base}.salary`, "must be an object");
  } else {
    const floorOk = isNonNegativeNumber(sal.floor);
    const defaultOk = isNonNegativeNumber(sal.default);
    if (!floorOk) err(`${base}.salary.floor`, "must be a number >= 0");
    if (!defaultOk) err(`${base}.salary.default`, "must be a number >= 0");
    if (floorOk && defaultOk && sal.default < sal.floor) {
      err(`${base}.salary.default`, `must be >= salary.floor (${sal.floor}), got ${sal.default}`);
    }
    if (typeof sal.currency !== "string" || !CURRENCY_RE.test(sal.currency)) {
      err(`${base}.salary.currency`, `must be a 3-letter ISO code (e.g. "USD")`);
    }
  }

  if (!isNonEmptyString(raw.how_did_you_hear_default)) {
    err(`${base}.how_did_you_hear_default`, "must be a non-empty string");
  }

  if (raw.address !== undefined) {
    if (!isPlainObject(raw.address)) err(`${base}.address`, "must be an object");
    else {
      for (const [k, v] of Object.entries(raw.address)) {
        if (!ADDRESS_KEYS.includes(k)) warn(`${base}.address.${k}`, "unknown key (ignored)");
        else if (typeof v !== "string") err(`${base}.address.${k}`, "must be a string");
      }
    }
  }

  if (raw.citizenship !== undefined) {
    const c = raw.citizenship;
    if (!isPlainObject(c)) err(`${base}.citizenship`, "must be an object");
    else {
      if (!Array.isArray(c.countries) || !c.countries.every(isNonEmptyString)) {
        err(`${base}.citizenship.countries`, "must be an array of non-empty strings");
      }
      if (c.us_permanent_resident !== undefined && typeof c.us_permanent_resident !== "boolean") {
        err(`${base}.citizenship.us_permanent_resident`, "must be a boolean");
      }
    }
  }

  if (
    raw.tailor_ship_min_coverage !== undefined &&
    !(
      typeof raw.tailor_ship_min_coverage === "number" &&
      raw.tailor_ship_min_coverage >= 0 &&
      raw.tailor_ship_min_coverage <= 100
    )
  ) {
    err(`${base}.tailor_ship_min_coverage`, "must be a number between 0 and 100");
  }

  if (raw.standing_answers !== undefined) {
    if (!Array.isArray(raw.standing_answers)) {
      err(`${base}.standing_answers`, "must be an array of { question, answer }");
    } else {
      raw.standing_answers.forEach((sa, i) => {
        const ok =
          isPlainObject(sa) &&
          typeof sa.question === "string" &&
          sa.question.trim() !== "" &&
          typeof sa.answer === "string" &&
          sa.answer.trim() !== "";
        if (!ok)
          err(`${base}.standing_answers[${i}]`, "needs non-empty string question and answer");
        else if (sa.notion_page_id !== undefined && !isNonEmptyString(sa.notion_page_id))
          err(`${base}.standing_answers[${i}].notion_page_id`, "must be a non-empty string");
      });
    }
  }
  if (raw.skip_questions !== undefined) {
    if (!Array.isArray(raw.skip_questions)) {
      err(`${base}.skip_questions`, "must be an array of { question }");
    } else {
      raw.skip_questions.forEach((sq, i) => {
        if (!isPlainObject(sq) || !isNonEmptyString(sq.question)) {
          err(`${base}.skip_questions[${i}]`, "needs a non-empty string question");
        } else if (sq.notion_page_id !== undefined && !isNonEmptyString(sq.notion_page_id)) {
          err(`${base}.skip_questions[${i}].notion_page_id`, "must be a non-empty string");
        }
      });
    }
  }
  if (raw.relatives_at_company !== undefined && typeof raw.relatives_at_company !== "boolean") {
    err(`${base}.relatives_at_company`, "must be a boolean");
  }
  if (
    raw.start_weeks_after_offer !== undefined &&
    !(
      Number.isInteger(raw.start_weeks_after_offer) &&
      raw.start_weeks_after_offer >= 0 &&
      raw.start_weeks_after_offer <= 26
    )
  ) {
    err(`${base}.start_weeks_after_offer`, "must be an integer number of weeks, 0..26");
  }

  if (raw.choice_policy !== undefined) {
    const cp = raw.choice_policy;
    if (!isPlainObject(cp)) err(`${base}.choice_policy`, "must be an object");
    else {
      for (const k of Object.keys(cp)) {
        if (k !== "eeo" && k !== "how_did_you_hear") {
          warn(`${base}.choice_policy.${k}`, "unknown key (ignored)");
        }
      }
      if (cp.eeo !== undefined && !VALID_CHOICE_EEO.includes(cp.eeo)) {
        err(
          `${base}.choice_policy.eeo`,
          `must be one of [${VALID_CHOICE_EEO.join(", ")}], got ${JSON.stringify(cp.eeo)}`
        );
      }
      if (
        cp.how_did_you_hear !== undefined &&
        !(Array.isArray(cp.how_did_you_hear) && cp.how_did_you_hear.every(isNonEmptyString))
      ) {
        err(`${base}.choice_policy.how_did_you_hear`, "must be an array of non-empty strings");
      }
    }
  }

  if (
    raw.legal_acknowledgements !== undefined &&
    !VALID_LEGAL_POLICIES.includes(raw.legal_acknowledgements)
  ) {
    err(
      `${base}.legal_acknowledgements`,
      `must be one of [${VALID_LEGAL_POLICIES.join(", ")}], got ${JSON.stringify(raw.legal_acknowledgements)}`
    );
  }

  return issues;
}

/**
 * Salary floor from a loaded `profile.applyDefaults`, or null when the
 * profile has no apply_defaults (or the floor is not a usable number).
 *
 * @param {object|null|undefined} applyDefaults
 * @returns {number|null}
 */
function getSalaryFloor(applyDefaults) {
  if (!isPlainObject(applyDefaults) || !isPlainObject(applyDefaults.salary)) return null;
  const floor = applyDefaults.salary.floor;
  return isNonNegativeNumber(floor) ? floor : null;
}

module.exports = {
  APPLY_DEFAULTS_FILE,
  VALID_EEO_POLICIES,
  validateApplyDefaults,
  getSalaryFloor,
};
