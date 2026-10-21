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
//     "relocation": { "willing": false },  // boolean
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
]);

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
