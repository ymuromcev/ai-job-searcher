// Pure semantic / logical-consistency checks. No fs, no network.
//
// See RFC 037 §3.2.
//
//   { severity, category: "semantic", field, message }

const COMMON_TYPO_KEYS = {
  // discovery.companies_blacklist is the canonical field name (RFC 011);
  // typos surface as silent no-ops.
  companies_blocklist: "companies_blacklist",
  company_blacklist: "companies_blacklist",
  companies_block_list: "companies_blacklist",
  companies_blklist: "companies_blacklist",
};

const US_MARKERS = new Set(["US", "USA", "U.S.", "U.S.A.", "United States"]);

function issue(severity, field, message) {
  return { severity, category: "semantic", field, message };
}

function checkRoleTargetsPresent(profile, issues) {
  // RFC 033: every profile must declare at least one role track.
  const rt = profile && profile.filterRules && profile.filterRules.role_targets;
  if (!rt) {
    issues.push(
      issue(
        "error",
        "filter_rules.role_targets",
        "role_targets block is required (RFC 033). Add at least one track."
      )
    );
    return;
  }
  if (!Array.isArray(rt.tracks) || rt.tracks.length === 0) {
    issues.push(
      issue(
        "error",
        "filter_rules.role_targets.tracks",
        "tracks[] is empty — no positive title gate, no fit-treatment routing (RFC 033)."
      )
    );
  }
}

function checkDuplicateTrackIds(profile, issues) {
  const tracks =
    profile &&
    profile.filterRules &&
    profile.filterRules.role_targets &&
    profile.filterRules.role_targets.tracks;
  if (!Array.isArray(tracks)) return;
  const counts = {};
  for (const t of tracks) {
    if (t && typeof t.id === "string" && t.id) {
      counts[t.id] = (counts[t.id] || 0) + 1;
    }
  }
  for (const [id, n] of Object.entries(counts)) {
    if (n > 1) {
      issues.push(
        issue(
          "error",
          "filter_rules.role_targets.tracks",
          `duplicate track id "${id}" (${n} occurrences) — fit_treatments keyed by id collapse`
        )
      );
    }
  }
}

function checkFitTreatmentsRef(profile, issues) {
  const rt = profile && profile.filterRules && profile.filterRules.role_targets;
  if (!rt || typeof rt.fit_treatments !== "object" || rt.fit_treatments === null) return;
  const tracks = Array.isArray(rt.tracks) ? rt.tracks : [];
  const trackIds = new Set(tracks.map((t) => t && t.id).filter(Boolean));
  // Some `fit_treatments` keys are documentation labels (e.g. "primary",
  // "bridge"). Only warn if a key is neither a fit-treatment-name nor a
  // track id. The base-vocabulary keys are reserved for docs.
  const BASE_LABELS = new Set(["primary", "bridge"]);
  for (const key of Object.keys(rt.fit_treatments)) {
    if (BASE_LABELS.has(key)) continue;
    if (!trackIds.has(key)) {
      issues.push(
        issue(
          "warn",
          `filter_rules.role_targets.fit_treatments.${key}`,
          `key does not match any tracks[].id — orphaned treatment entry`
        )
      );
    }
  }
}

function checkGeoCoherence(profile, issues) {
  const g = profile && profile.geo;
  if (!g || typeof g !== "object") return;
  if (g.mode === "metro") {
    if (!Array.isArray(g.cities) || g.cities.length === 0) {
      issues.push(
        issue(
          "error",
          "profile.geo.cities",
          'mode="metro" requires a non-empty cities[] (no row would ever pass)'
        )
      );
    }
    if (!Array.isArray(g.states) || g.states.length === 0) {
      issues.push(
        issue(
          "error",
          "profile.geo.states",
          'mode="metro" requires a non-empty states[] (city-collision guard)'
        )
      );
    }
  }
  if (g.mode === "us-wide" && Array.isArray(g.blocklist)) {
    for (const entry of g.blocklist) {
      if (typeof entry === "string" && US_MARKERS.has(entry.trim())) {
        issues.push(
          issue(
            "error",
            "profile.geo.blocklist",
            `mode="us-wide" with US marker "${entry}" in blocklist — no row would ever pass`
          )
        );
        break;
      }
    }
  }
  if (g.mode === "remote-only" && g.remote_ok === false) {
    issues.push(
      issue(
        "warn",
        "profile.geo.remote_ok",
        'mode="remote-only" with remote_ok=false — likely contradiction (set remote_ok=true)'
      )
    );
  }
}

function checkDiscoveryTypos(profile, issues) {
  // RFC 037 open-Q #1 resolved: warn severity for `companies_blacklist`-style
  // typos in profile.discovery (silent no-ops otherwise).
  const discovery = profile && profile.discovery;
  if (!discovery || typeof discovery !== "object") return;
  for (const key of Object.keys(discovery)) {
    if (COMMON_TYPO_KEYS[key]) {
      issues.push(
        issue(
          "warn",
          `profile.discovery.${key}`,
          `looks like a typo of "${COMMON_TYPO_KEYS[key]}" — field is silently ignored`
        )
      );
    }
  }
}

function runSemanticChecks(profile) {
  const issues = [];
  if (!profile || typeof profile !== "object") return issues;
  checkRoleTargetsPresent(profile, issues);
  checkDuplicateTrackIds(profile, issues);
  checkFitTreatmentsRef(profile, issues);
  checkGeoCoherence(profile, issues);
  checkDiscoveryTypos(profile, issues);
  return issues;
}

module.exports = {
  runSemanticChecks,
  COMMON_TYPO_KEYS,
  US_MARKERS,
};
