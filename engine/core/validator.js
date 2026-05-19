// Pure validators: shape checks for jobs and profile objects.
//
// Two-tier API:
//
//   validateJob(job)         -> { valid, errors: string[] }
//     Per-row TSV shape check. Unchanged from BL pre-99.
//
//   validateProfile(profile) -> { valid, errors: string[] }
//     Minimal profile-object shape (id / identity / modules). Unchanged
//     from BL pre-99 — kept for back-compat callers.
//
//   validateProfileDeep(profile, options) -> { valid, issues, errors }
//     Full multi-category check (schema + semantic + referential) per
//     RFC 037. Used by `engine/commands/validate.js`. `errors` is a
//     stringified projection of `issues` for back-compat.
//
// Each `issue` has shape:
//   { severity: "error"|"warn", category, field, message }

const { ID_REGEX } = require("./profile_loader.js");
const { runSchemaChecks } = require("./validator/checks/schema.js");
const { runSemanticChecks } = require("./validator/checks/semantic.js");
const { runReferentialChecks } = require("./validator/checks/referential.js");

const JOB_REQUIRED_FIELDS = ["source", "jobId", "company", "role", "jobUrl"];
const PROFILE_REQUIRED_FIELDS = ["id", "identity", "modules"];
const IDENTITY_REQUIRED_FIELDS = ["name", "email"];

function requireField(obj, field, errors, prefix = "") {
  const v = obj ? obj[field] : undefined;
  if (v === undefined || v === null || v === "") {
    errors.push(`missing required field: ${prefix}${field}`);
  }
}

function validateJob(job) {
  const errors = [];
  if (!job || typeof job !== "object") {
    errors.push("job is not an object");
    return { valid: false, errors };
  }
  for (const f of JOB_REQUIRED_FIELDS) requireField(job, f, errors);
  return { valid: errors.length === 0, errors };
}

function validateProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== "object") {
    errors.push("profile is not an object");
    return { valid: false, errors };
  }
  for (const f of PROFILE_REQUIRED_FIELDS) requireField(profile, f, errors);

  if (profile.id && !ID_REGEX.test(profile.id)) {
    errors.push(`profile.id does not match ${ID_REGEX}: ${profile.id}`);
  }

  if (profile.identity && typeof profile.identity === "object") {
    for (const f of IDENTITY_REQUIRED_FIELDS) {
      requireField(profile.identity, f, errors, "identity.");
    }
  }

  if (profile.modules !== undefined && !Array.isArray(profile.modules)) {
    errors.push("modules must be an array");
  }

  return { valid: errors.length === 0, errors };
}

// Format issue for human stderr (single line). Tagged for grep:
//   `[schema/error] field: message`
function formatIssue(iss) {
  return `[${iss.category}/${iss.severity}] ${iss.field}: ${iss.message}`;
}

function validateProfileDeep(profile, options = {}, depsOverrides = {}) {
  const issues = [];

  // Layer 1: minimal shape (back-compat). Promote any failing string into an
  // "error" issue so the report is uniform.
  const minimal = validateProfile(profile);
  if (!minimal.valid) {
    for (const msg of minimal.errors) {
      issues.push({
        severity: "error",
        category: "schema",
        field: "profile",
        message: msg,
      });
    }
  }

  // Layer 2: the three category checks.
  issues.push(...runSchemaChecks(profile));
  issues.push(...runSemanticChecks(profile));
  issues.push(...runReferentialChecks(profile, options, depsOverrides));

  const errorIssues = issues.filter((i) => i.severity === "error");
  return {
    valid: errorIssues.length === 0,
    issues,
    // Stringified projection — keeps back-compat with callers that read
    // `result.errors[]`.
    errors: errorIssues.map(formatIssue),
  };
}

module.exports = {
  validateJob,
  validateProfile,
  validateProfileDeep,
  formatIssue,
};
