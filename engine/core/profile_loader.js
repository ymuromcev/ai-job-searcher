// Single entry point for reading profile data from disk.
// All other engine modules receive profile data as arguments — they do NOT
// read profiles/ themselves. See RFC 001 "Engine isolation" for rationale.
//
// Contract:
//   loadProfile(id, { profilesDir? }) -> normalized profile object
//   loadSecrets(id, env?)             -> { [KEY_WITHOUT_PREFIX]: value }

const fs = require("fs");
const path = require("path");

const ID_REGEX = /^[a-z][a-z0-9_-]*$/;

function validateId(id) {
  if (typeof id !== "string" || !ID_REGEX.test(id)) {
    throw new Error(`invalid profile id: ${JSON.stringify(id)}`);
  }
}

function resolveProfileRoot(id, profilesDir) {
  const base = path.resolve(profilesDir);
  const root = path.resolve(base, id);
  // Boundary check: resolved path must be strictly inside base.
  if (root !== base && !root.startsWith(base + path.sep)) {
    throw new Error(`profile path escape detected: ${root}`);
  }
  return { base, root };
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readFileIfExists(file) {
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, "utf8");
}

function loadProfile(id, options = {}) {
  validateId(id);
  const profilesDir = options.profilesDir || "profiles";
  const { root } = resolveProfileRoot(id, profilesDir);

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`profile not found: ${root}`);
  }

  const profileJsonPath = path.join(root, "profile.json");
  const profile = readJsonIfExists(profileJsonPath);
  if (!profile) {
    throw new Error(`profile.json missing at ${profileJsonPath}`);
  }
  if (profile.id && profile.id !== id) {
    throw new Error(`profile.id "${profile.id}" does not match requested id "${id}"`);
  }

  const result = {
    ...profile,
    id,
    paths: {
      root,
      applicationsTsv: path.join(root, "applications.tsv"),
      resumesDir: path.join(root, (profile.resume && profile.resume.output_dir) || "resumes"),
      coverLettersDir: path.join(
        root,
        (profile.cover_letter && profile.cover_letter.output_dir) || "cover_letters"
      ),
      jdCacheDir: path.join(root, "jd_cache"),
    },
  };

  if (profile.filter_rules_file) {
    const raw = readJsonIfExists(path.join(root, profile.filter_rules_file));
    result.filterRules = raw ? normalizeFilterRules(raw) : raw;
  }
  if (profile.resume && profile.resume.versions_file) {
    result.resumeVersions = readJsonIfExists(path.join(root, profile.resume.versions_file));
  }
  if (profile.cover_letter && profile.cover_letter.config_file) {
    result.coverLetterConfig = readJsonIfExists(
      path.join(root, profile.cover_letter.config_file)
    );
  }
  if (profile.cover_letter && profile.cover_letter.template_file) {
    result.coverLetterTemplate = readFileIfExists(
      path.join(root, profile.cover_letter.template_file)
    );
  }

  return result;
}

// Accepts both the prototype / _example shape (nested object with
// .companies / .patterns sub-arrays) and the flat engine shape that
// core/filter.js consumes. Returns the flat shape.
//
// Shape mapping:
//   company_blocklist: { companies: [{name}] } | [names]   → [names]
//   title_blocklist:   { patterns: [{pattern,reason}] } | [{...}] → [{pattern,reason}]
//   location_blocklist:{ patterns: [strings] } | [strings] | location_rules.* → [strings]
//   company_cap:       pass-through
// Everything else (domain_weak_fit, early_startup_modifier, priority_order)
// is preserved verbatim for downstream consumers (e.g. fit_prompt).
function normalizeFilterRules(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const out = { ...raw };

  const cb = raw.company_blocklist;
  if (Array.isArray(cb)) {
    out.company_blocklist = cb.map((x) => (typeof x === "string" ? x : x && x.name)).filter(Boolean);
  } else if (cb && Array.isArray(cb.companies)) {
    out.company_blocklist = cb.companies.map((c) => c && c.name).filter(Boolean);
  } else {
    out.company_blocklist = [];
  }

  const tb = raw.title_blocklist;
  if (Array.isArray(tb)) {
    out.title_blocklist = tb.filter((p) => p && p.pattern);
  } else if (tb && Array.isArray(tb.patterns)) {
    out.title_blocklist = tb.patterns.filter((p) => p && p.pattern);
  } else {
    out.title_blocklist = [];
  }

  const lb = raw.location_blocklist;
  if (Array.isArray(lb)) {
    out.location_blocklist = lb.map(String).filter(Boolean);
  } else if (lb && Array.isArray(lb.patterns)) {
    out.location_blocklist = lb.patterns.map(String).filter(Boolean);
  } else {
    out.location_blocklist = [];
  }

  return out;
}

function secretPrefix(id) {
  validateId(id);
  return id.toUpperCase().replace(/-/g, "_") + "_";
}

function secretEnvName(id, key) {
  return secretPrefix(id) + String(key);
}

function loadSecrets(id, env = process.env) {
  const prefix = secretPrefix(id);
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(prefix)) {
      out[key.slice(prefix.length)] = value;
    }
  }
  return out;
}

module.exports = { loadProfile, loadSecrets, secretEnvName, secretPrefix, normalizeFilterRules, ID_REGEX };
