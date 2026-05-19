// Pure schema checks for a normalized profile object.
//
// Operates over the in-memory profile produced by `profile_loader.loadProfile`
// (so `filterRules` is the flat normalized shape, `geo` is canonical).
// Never throws, never touches the filesystem. Returns an array of issues:
//
//   { severity: "error"|"warn", category: "schema", field, message }
//
// See RFC 037 §3.1 for the full check list and severity matrix.

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const VALID_FIT_TREATMENTS = new Set(["primary", "bridge"]);
const VALID_GEO_MODES = new Set(["metro", "us-wide", "remote-only", "unrestricted"]);
const REGEX_ANCHOR_CHARS = /[\^$]|\\b/;

function issue(severity, field, message) {
  return { severity, category: "schema", field, message };
}

function compilesAsRegex(pattern) {
  try {
    // Match what filter.js does — case-insensitive compile.
    // eslint-disable-next-line no-new
    new RegExp(pattern, "i");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function checkRoleTargets(profile, issues) {
  const rt = profile && profile.filterRules && profile.filterRules.role_targets;
  if (!rt) return;
  if (!Array.isArray(rt.tracks)) {
    issues.push(issue("error", "filter_rules.role_targets.tracks", "tracks must be an array"));
    return;
  }
  const seenIds = new Set();
  rt.tracks.forEach((track, i) => {
    const base = `filter_rules.role_targets.tracks[${i}]`;
    if (!track || typeof track !== "object") {
      issues.push(issue("error", base, "track entry must be an object"));
      return;
    }
    if (!track.id || typeof track.id !== "string") {
      issues.push(issue("error", `${base}.id`, "id is required (non-empty string)"));
    } else if (seenIds.has(track.id)) {
      // Duplicate-id detection is semantic, not schema — handled in semantic.js.
      // We still warn here if id is empty after coercion.
    } else {
      seenIds.add(track.id);
    }
    if (!track.name || typeof track.name !== "string") {
      issues.push(issue("error", `${base}.name`, "name is required (non-empty string)"));
    }
    if (!Array.isArray(track.patterns)) {
      issues.push(issue("error", `${base}.patterns`, "patterns must be an array"));
    } else {
      if (track.patterns.length === 0) {
        issues.push(issue("error", `${base}.patterns`, "patterns[] is empty"));
      }
      track.patterns.forEach((p, j) => {
        const pBase = `${base}.patterns[${j}]`;
        if (!p || typeof p !== "object" || !p.pattern || typeof p.pattern !== "string") {
          issues.push(issue("error", pBase, "entry must have a non-empty `pattern` string"));
          return;
        }
        const c = compilesAsRegex(p.pattern);
        if (!c.ok) {
          issues.push(issue("error", `${pBase}.pattern`, `invalid regex: ${c.error}`));
        }
      });
    }
    if (track.fit_treatment !== undefined && !VALID_FIT_TREATMENTS.has(track.fit_treatment)) {
      issues.push(
        issue(
          "error",
          `${base}.fit_treatment`,
          `must be one of [${Array.from(VALID_FIT_TREATMENTS).join(", ")}] or absent`
        )
      );
    }
  });
}

function checkPatternList(fieldBase, list, issues) {
  if (!Array.isArray(list)) {
    issues.push(issue("error", fieldBase, "must be an array"));
    return;
  }
  list.forEach((p, i) => {
    const base = `${fieldBase}[${i}]`;
    if (!p || typeof p !== "object" || !p.pattern || typeof p.pattern !== "string") {
      issues.push(issue("error", base, "entry must have a non-empty `pattern` string"));
      return;
    }
    const c = compilesAsRegex(p.pattern);
    if (!c.ok) {
      issues.push(issue("error", `${base}.pattern`, `invalid regex: ${c.error}`));
    }
  });
}

function checkTitleBlocklist(profile, issues) {
  const fr = profile && profile.filterRules;
  if (!fr) return;
  // Both title_blocklist and title_requirelist are normalized to flat arrays
  // of `{pattern, ...}`. Only check explicitly-set non-empty arrays — empty
  // is valid (no positive/negative gate).
  if (Array.isArray(fr.title_blocklist) && fr.title_blocklist.length > 0) {
    checkPatternList("filter_rules.title_blocklist", fr.title_blocklist, issues);
  }
  if (Array.isArray(fr.title_requirelist) && fr.title_requirelist.length > 0) {
    checkPatternList("filter_rules.title_requirelist", fr.title_requirelist, issues);
  }
}

function checkLocationBlocklist(profile, issues) {
  const lb = profile && profile.filterRules && profile.filterRules.location_blocklist;
  if (!Array.isArray(lb)) return;
  lb.forEach((entry, i) => {
    const base = `filter_rules.location_blocklist[${i}]`;
    if (typeof entry !== "string") {
      issues.push(issue("error", base, "each entry must be a string"));
      return;
    }
    if (REGEX_ANCHOR_CHARS.test(entry)) {
      // filter.js does a substring match — regex anchors are user-error
      // (silent no-op). Warn, don't error.
      issues.push(
        issue(
          "warn",
          base,
          `entry "${entry}" looks like a regex (substring match is used; anchors won't fire)`
        )
      );
    }
  });
}

function checkCompanyCap(profile, issues) {
  const cap = profile && profile.filterRules && profile.filterRules.company_cap;
  if (!cap || typeof cap !== "object") return;
  if (cap.max_active !== undefined) {
    if (!Number.isInteger(cap.max_active) || cap.max_active < 0) {
      issues.push(
        issue(
          "error",
          "filter_rules.company_cap.max_active",
          `must be an integer >= 0, got ${JSON.stringify(cap.max_active)}`
        )
      );
    }
  }
}

function checkGeoMode(profile, issues) {
  // profile.geo is normalized by loader, which already throws on bad shape.
  // But raw input via tests may include unnormalized values — guard anyway.
  const g = profile && profile.geo;
  if (!g || typeof g !== "object") return;
  if (g.mode !== undefined && !VALID_GEO_MODES.has(g.mode)) {
    issues.push(
      issue(
        "error",
        "profile.geo.mode",
        `must be one of [${Array.from(VALID_GEO_MODES).join(", ")}], got ${JSON.stringify(g.mode)}`
      )
    );
  }
}

function checkNotion(profile, issues) {
  const notion = profile && profile.notion;
  if (!notion || typeof notion !== "object") return;
  if (notion.jobs_pipeline_db_id !== undefined) {
    const id = notion.jobs_pipeline_db_id;
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      issues.push(
        issue(
          "error",
          "profile.notion.jobs_pipeline_db_id",
          `must be a Notion UUID (got ${JSON.stringify(id)})`
        )
      );
    }
  }
  if (notion.property_map && typeof notion.property_map === "object") {
    for (const [key, mapping] of Object.entries(notion.property_map)) {
      const base = `profile.notion.property_map.${key}`;
      if (!mapping || typeof mapping !== "object") {
        issues.push(issue("error", base, "must be an object"));
        continue;
      }
      if (!mapping.field || typeof mapping.field !== "string") {
        issues.push(issue("error", `${base}.field`, "must be a non-empty string"));
      }
    }
  }
}

// Public entry point. Runs all schema checks against a normalized profile.
function runSchemaChecks(profile) {
  const issues = [];
  if (!profile || typeof profile !== "object") return issues;
  checkRoleTargets(profile, issues);
  checkTitleBlocklist(profile, issues);
  checkLocationBlocklist(profile, issues);
  checkCompanyCap(profile, issues);
  checkGeoMode(profile, issues);
  checkNotion(profile, issues);
  return issues;
}

module.exports = {
  runSchemaChecks,
  // Exposed for unit tests / reuse.
  compilesAsRegex,
  UUID_RE,
  VALID_FIT_TREATMENTS,
  VALID_GEO_MODES,
};
