// Pure validators: shape checks for jobs and profile objects.
// Returns { valid: bool, errors: string[] }; never throws.

const { ID_REGEX } = require("./profile_loader.js");

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

module.exports = { validateJob, validateProfile };
