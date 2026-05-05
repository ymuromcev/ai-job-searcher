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
    // Common onboarding mistake: user copied profiles/_example/ directly,
    // so files still carry the `.example` suffix and CLI can't find them.
    // Detect that case and point at the wizard explicitly.
    const exampleJsonPath = path.join(root, "profile.example.json");
    if (fs.existsSync(exampleJsonPath)) {
      throw new Error(
        `profile.json missing at ${profileJsonPath}. ` +
          `Found profile.example.json — looks like you copied profiles/_example/ directly. ` +
          `Templates aren't runnable; generate a real profile via the onboarding wizard ` +
          `(scripts/stage18/README.md).`
      );
    }
    throw new Error(
      `profile.json missing at ${profileJsonPath}. ` +
        `Run the onboarding wizard to generate one: scripts/stage18/README.md`
    );
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

  // L-2 (2026-05-04): per-profile memory block. SKILL Step 1 / Humanizer Rules
  // consume `result.memory` instead of reading from disk directly.
  result.memory = loadMemory(root, profile.memory);

  // L-1 (2026-05-04): per-profile salary block. Engine reads
  // `result.salaryConfig` (normalised) and feeds it into calcSalary opts.
  result.salaryConfig = normalizeSalaryConfig(profile.salary);

  // L-4 (RFC 013): per-profile geo block. Canonical shape consumed by
  // filter.js / prepare.js / validate.js via geo_enforcer.
  result.geo = normalizeGeo(profile.geo);

  return result;
}

// --- Memory loading ---------------------------------------------------------
//
// Schema (profile.json):
//   "memory": {
//     "writing_style_file":     "memory/user_writing_style.md",
//     "resume_key_points_file": "memory/user_resume_key_points.md",
//     "feedback_dir":           "memory"   // optional; lists feedback_*.md
//   }
//
// Returns:
//   {
//     writingStyle: string | null,
//     resumeKeyPoints: string | null,
//     feedback: [{ file: relPath, content: string }]
//   }
//
// Missing files are tolerated — SKILL falls back to resume_versions.json /
// cover_letter_template.md when the corresponding memory entry is null.
function loadMemory(root, memoryConfig) {
  const cfg = memoryConfig || {};
  const out = { writingStyle: null, resumeKeyPoints: null, feedback: [] };

  if (cfg.writing_style_file) {
    const p = path.join(root, cfg.writing_style_file);
    const v = readFileIfExists(p);
    if (v !== undefined) out.writingStyle = v;
  }
  if (cfg.resume_key_points_file) {
    const p = path.join(root, cfg.resume_key_points_file);
    const v = readFileIfExists(p);
    if (v !== undefined) out.resumeKeyPoints = v;
  }
  if (cfg.feedback_dir) {
    const dir = path.join(root, cfg.feedback_dir);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      const files = fs
        .readdirSync(dir)
        .filter((name) => /^feedback_.*\.md$/.test(name))
        .sort();
      for (const name of files) {
        const full = path.join(dir, name);
        const rel = path.join(cfg.feedback_dir, name);
        out.feedback.push({ file: rel, content: fs.readFileSync(full, "utf8") });
      }
    }
  }
  return out;
}

// --- Salary block normalization --------------------------------------------
//
// Schema (profile.json):
//   "salary": {
//     "currency": "USD",
//     "level_parser": "pm" | "healthcare" | "default",
//     "matrix": { TIER: { LEVEL: {min,max,mid} } },
//     "col_adjustment": { multiplier, high_col_cities, exclude_format }
//   }
//
// Returns: a plain object the salary_calc module can spread directly into
// opts. Missing top-level block → null (back-compat: callers fall back to
// engine defaults, preserving Jared parity).
function normalizeSalaryConfig(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  if (raw.currency) out.currency = String(raw.currency);
  if (raw.level_parser) out.levelParser = String(raw.level_parser);
  if (raw.matrix && typeof raw.matrix === "object") out.salaryMatrix = raw.matrix;
  if (raw.col_adjustment && typeof raw.col_adjustment === "object") {
    out.colAdjustment = raw.col_adjustment;
  }
  return out;
}

// Accepts both the prototype / _example shape (nested object with
// .companies / .patterns sub-arrays) and the flat engine shape that
// core/filter.js consumes. Returns the flat shape.
//
// Shape mapping:
//   company_blocklist:  { companies: [{name}] } | [names]   → [names]
//   title_blocklist:    { patterns: [{pattern,reason}] } | [{...}] → [{pattern,reason}]
//   title_requirelist:  { patterns: [{pattern,reason}] } | [{...}] → [{pattern,reason}]
//   location_blocklist: { patterns: [strings] } | [strings] | location_rules.* → [strings]
//   company_cap:        pass-through
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

  const tr = raw.title_requirelist;
  if (Array.isArray(tr)) {
    out.title_requirelist = tr.filter((p) => p && p.pattern);
  } else if (tr && Array.isArray(tr.patterns)) {
    out.title_requirelist = tr.patterns.filter((p) => p && p.pattern);
  } else {
    out.title_requirelist = [];
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

// Atomic write-back of a partial patch into profile.json. Reads current file,
// shallow-merges top-level keys (deep-merge per known nested object, currently
// only `company_tiers`), and writes via tmp-rename. Used by prepare commit
// when SKILL auto-tiers new companies (G-11/G-15).
function saveProfile(id, patch, options = {}) {
  validateId(id);
  const profilesDir = options.profilesDir || "profiles";
  const { root } = resolveProfileRoot(id, profilesDir);
  const profileJsonPath = path.join(root, "profile.json");
  const current = readJsonIfExists(profileJsonPath);
  if (!current) {
    throw new Error(`profile.json missing at ${profileJsonPath}`);
  }
  const next = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === "company_tiers" && v && typeof v === "object" && !Array.isArray(v)) {
      next.company_tiers = { ...(current.company_tiers || {}), ...v };
    } else {
      next[k] = v;
    }
  }
  const data = JSON.stringify(next, null, 2) + "\n";
  const tmp = `${profileJsonPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, profileJsonPath);
  return next;
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

// --- Geo block (L-4 / RFC 013) ----------------------------------------------
//
// Schema (profile.json):
//   "geo": {
//     "mode": "metro" | "us-wide" | "remote-only" | "unrestricted",
//     "cities": [string],         // required when mode === "metro"
//     "states": [string],         // required when mode === "metro" (per §8.1)
//     "countries": [string],      // optional; ISO codes (informational in v1)
//     "remote_ok": bool,          // optional, default false
//     "blocklist": [string],      // optional; substring deny-list
//     "max_radius_miles": number  // reserved for future geocoding (v1: null)
//   }
//
// Returns canonical block. Missing/null/undefined input → defaults to
// `{ mode: "unrestricted", remote_ok: false, blocklist: [] }` (zero behavior
// change for profiles without a geo block — Jared default).
//
// Throws on invalid shape:
//   - unknown mode
//   - mode "metro" without cities[] (non-empty) — required
//   - mode "metro" without states[] (non-empty) — required (open question §8.1)
//   - mode "us-wide" without countries[] (defaults to ["US"] if missing —
//     more permissive than metro since us-wide is meant to be loose)

const VALID_GEO_MODES = new Set(["metro", "us-wide", "remote-only", "unrestricted"]);

function normalizeGeo(raw) {
  if (raw === undefined || raw === null) {
    return { mode: "unrestricted", remote_ok: false, blocklist: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `profile.geo must be an object, got ${Array.isArray(raw) ? "array" : typeof raw}`
    );
  }

  const mode = raw.mode || "unrestricted";
  if (!VALID_GEO_MODES.has(mode)) {
    throw new Error(
      `profile.geo.mode must be one of ${Array.from(VALID_GEO_MODES).join(", ")}; got ${JSON.stringify(mode)}`
    );
  }

  const cities = Array.isArray(raw.cities)
    ? raw.cities.map((c) => String(c)).filter(Boolean)
    : [];
  const states = Array.isArray(raw.states)
    ? raw.states.map((s) => String(s)).filter(Boolean)
    : [];
  const countries = Array.isArray(raw.countries)
    ? raw.countries.map((c) => String(c)).filter(Boolean)
    : mode === "us-wide"
    ? ["US"]
    : [];
  const remote_ok = raw.remote_ok === true;
  const blocklist = Array.isArray(raw.blocklist)
    ? raw.blocklist.map((b) => String(b)).filter(Boolean)
    : [];
  const max_radius_miles =
    typeof raw.max_radius_miles === "number" && Number.isFinite(raw.max_radius_miles)
      ? raw.max_radius_miles
      : null;

  if (mode === "metro") {
    if (cities.length === 0) {
      throw new Error(`profile.geo.cities is required (non-empty) when mode === "metro"`);
    }
    // §8.1 resolved: states are REQUIRED for metro mode (city-double safeguard).
    if (states.length === 0) {
      throw new Error(
        `profile.geo.states is required (non-empty) when mode === "metro" — ` +
          `prevents city-name collisions like Auburn (CA / AL / NY / WA)`
      );
    }
  }

  return { mode, cities, states, countries, remote_ok, blocklist, max_radius_miles };
}

module.exports = {
  loadProfile,
  saveProfile,
  loadSecrets,
  secretEnvName,
  secretPrefix,
  normalizeFilterRules,
  loadMemory,
  normalizeSalaryConfig,
  normalizeGeo,
  VALID_GEO_MODES,
  ID_REGEX,
};
