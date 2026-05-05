// Geo enforcement for profile-driven location policy (RFC 013, L-4).
//
// Pure function: given a job's locations array and a profile.geo policy,
// decide whether the job passes the geo filter.
//
// Modes:
//   - "unrestricted": no geo check — always allow. Optional blocklist still applied.
//   - "metro":         job.locations must contain a city from `cities` AND
//                      a state from `states` (states REQUIRED). `remote_ok=true`
//                      lets remote/anywhere postings through.
//   - "us-wide":       job.locations must contain a US marker (any of US_MARKERS
//                      from filter.js semantics — "united states" / "usa" /
//                      ", us" / "(us)" / "u.s.") OR be a US state name. `remote_ok`
//                      lets remote postings through.
//   - "remote-only":   job.locations must contain "Remote" / "Anywhere" /
//                      "Work from home". Cities/states ignored.
//
// Multi-location semantic (resolved §8.7): job passes if ANY element of
// locations[] satisfies the policy. Important for multi-city postings like
// ["Sacramento, CA", "Hybrid"] — one matching location is enough.
//
// Empty locations behavior:
//   - mode "unrestricted": pass (ok=true).
//   - all other modes:     reject with reason "geo_no_location".
//
// Blocklist (profile.geo.blocklist): substring deny-list applied AFTER positive
// match. If any location matches blocklist, job is rejected with "geo_blocklist".
// Mirrors filter_rules.location_blocklist (intentional duplication so geo block
// is self-contained).

const REMOTE_MARKERS = ["remote", "anywhere", "work from home", "wfh"];

// US markers — same set as filter.js US_MARKERS.
const US_MARKERS = ["united states", "usa", ", us", "(us)", "u.s.", "u.s.a"];

// US state name → 2-letter code lookup. Used in "us-wide" mode and as
// implicit country marker (e.g. "Sacramento, CA" → US even without "USA").
const US_STATE_CODES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS",
  "KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY",
  "NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV",
  "WI","WY","DC",
]);

// 2-letter code → full state name (lowercase). Used to expand states list:
// if user puts "CA" in profile.geo.states, matcher also accepts "California"
// in job locations (and vice versa).
const US_CODE_TO_NAME = {
  AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california",
  CO: "colorado", CT: "connecticut", DE: "delaware", FL: "florida", GA: "georgia",
  HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa",
  KS: "kansas", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland",
  MA: "massachusetts", MI: "michigan", MN: "minnesota", MS: "mississippi",
  MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire",
  NJ: "new jersey", NM: "new mexico", NY: "new york", NC: "north carolina",
  ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania",
  RI: "rhode island", SC: "south carolina", SD: "south dakota", TN: "tennessee",
  TX: "texas", UT: "utah", VT: "vermont", VA: "virginia", WA: "washington",
  WV: "west virginia", WI: "wisconsin", WY: "wyoming", DC: "district of columbia",
};

const US_NAME_TO_CODE = Object.fromEntries(
  Object.entries(US_CODE_TO_NAME).map(([code, name]) => [name, code])
);

const US_STATE_NAMES = new Set(Object.values(US_CODE_TO_NAME));

function normalizeLocStr(s) {
  return String(s == null ? "" : s).trim().toLowerCase();
}

function isRemoteLoc(locLower) {
  return REMOTE_MARKERS.some((m) => locLower.includes(m));
}

function hasUsMarker(locLower) {
  if (US_MARKERS.some((m) => locLower.includes(m))) return true;
  // State code as standalone token: ", CA" / " CA " / trailing " CA"
  for (const code of US_STATE_CODES) {
    const re = new RegExp(`(^|[\\s,])${code.toLowerCase()}([\\s,]|$)`, "i");
    if (re.test(locLower)) return true;
  }
  // Full state name substring.
  for (const name of US_STATE_NAMES) {
    if (locLower.includes(name)) return true;
  }
  return false;
}

function locContainsCity(locLower, cities) {
  for (const city of cities) {
    if (!city) continue;
    if (locLower.includes(String(city).toLowerCase())) return city;
  }
  return null;
}

function locContainsState(locLower, states) {
  // For each state in the policy, try matching by BOTH forms (2-letter code
  // and full name). Lets users write "CA" in profile.geo.states and still
  // match jobs whose location says "Sacramento, California".
  for (const st of states) {
    if (!st) continue;
    const stRaw = String(st);
    const stLower = stRaw.toLowerCase();

    // Build candidate forms: code (2-letter) + full name.
    const codes = [];
    const names = [];
    if (stRaw.length === 2 && US_CODE_TO_NAME[stRaw.toUpperCase()]) {
      codes.push(stLower);
      names.push(US_CODE_TO_NAME[stRaw.toUpperCase()]);
    } else if (US_NAME_TO_CODE[stLower]) {
      names.push(stLower);
      codes.push(US_NAME_TO_CODE[stLower].toLowerCase());
    } else {
      // Unknown — fallback to substring match on whatever was provided.
      if (locLower.includes(stLower)) return st;
      continue;
    }

    for (const code of codes) {
      const re = new RegExp(`(^|[\\s,])${code}([\\s,]|$)`, "i");
      if (re.test(locLower)) return st;
    }
    for (const name of names) {
      if (locLower.includes(name)) return st;
    }
  }
  return null;
}

function locInBlocklist(locLower, blocklist) {
  if (!Array.isArray(blocklist) || blocklist.length === 0) return null;
  for (const b of blocklist) {
    if (!b) continue;
    if (locLower.includes(String(b).toLowerCase())) return b;
  }
  return null;
}

function checkOneLocation(locLower, profileGeo) {
  // Returns { ok: bool, matchedBy: string | null, blockedBy: string | null }.
  // matchedBy populated only when ok=true.
  // blockedBy populated only when blocklist hit (ok=false short-circuit).
  if (!locLower) return { ok: false, matchedBy: null, blockedBy: null };

  // Blocklist short-circuit BEFORE positive match: a blocklisted location
  // never passes, regardless of other criteria.
  const blocked = locInBlocklist(locLower, profileGeo.blocklist);
  if (blocked) return { ok: false, matchedBy: null, blockedBy: blocked };

  const mode = profileGeo.mode;
  const remoteOk = profileGeo.remote_ok === true;

  if (mode === "unrestricted") {
    return { ok: true, matchedBy: "unrestricted", blockedBy: null };
  }

  if (mode === "remote-only") {
    if (isRemoteLoc(locLower)) {
      return { ok: true, matchedBy: "remote", blockedBy: null };
    }
    return { ok: false, matchedBy: null, blockedBy: null };
  }

  // For metro / us-wide: remote_ok lets remote postings through unconditionally.
  if (remoteOk && isRemoteLoc(locLower)) {
    return { ok: true, matchedBy: "remote", blockedBy: null };
  }

  if (mode === "metro") {
    // City must match. Then state policy:
    //   - If location contains a state matching profile.states → accept.
    //   - If location contains NO state info at all (no 2-letter code, no
    //     full state name) → accept the bare-city match. Adapters like
    //     Sutter Health output bare cities ("Roseville"), and there's no
    //     ambiguity to defend against when state info is absent.
    //   - If location contains a state that does NOT match the policy
    //     (e.g. "Auburn, AL" with profile.states=["CA"]) → reject. This
    //     preserves the city-double safeguard (§8.1).
    const city = locContainsCity(locLower, profileGeo.cities || []);
    if (!city) return { ok: false, matchedBy: null, blockedBy: null };
    const state = locContainsState(locLower, profileGeo.states || []);
    if (state) return { ok: true, matchedBy: `city:${city}`, blockedBy: null };
    if (!hasUsMarker(locLower)) {
      // No state info present at all → city-only match is unambiguous.
      return { ok: true, matchedBy: `city:${city}`, blockedBy: null };
    }
    return { ok: false, matchedBy: null, blockedBy: null };
  }

  if (mode === "us-wide") {
    if (hasUsMarker(locLower)) {
      return { ok: true, matchedBy: "country:US", blockedBy: null };
    }
    return { ok: false, matchedBy: null, blockedBy: null };
  }

  // Unknown mode — defensive default to reject (profile_loader should have
  // caught this earlier).
  return { ok: false, matchedBy: null, blockedBy: null };
}

/**
 * Apply profile geo policy to a job's locations.
 *
 * @param {string[]} jobLocations  Array of location strings from NormalizedJob.locations[].
 *                                 Single-element string also accepted as legacy fallback.
 * @param {object}   profileGeo    Canonical block from profile.geo (post-normalizeGeo).
 *                                 Required shape: { mode, cities?, states?, countries?,
 *                                 remote_ok?, blocklist?, max_radius_miles? }.
 * @returns {{ ok: boolean, reason: string | null, matchedBy: string | null }}
 *   - ok=true:  reason=null, matchedBy describes which clause matched
 *               ("city:Sacramento" / "remote" / "country:US" / "unrestricted").
 *   - ok=false: reason ∈ { "geo_metro_miss", "geo_country_miss",
 *                          "geo_remote_only_miss", "geo_blocklist",
 *                          "geo_no_location", "geo_unknown_mode" }.
 *               matchedBy=null.
 */
function enforceGeo(jobLocations, profileGeo) {
  if (!profileGeo || typeof profileGeo !== "object") {
    // Defensive: no geo block → unrestricted.
    return { ok: true, reason: null, matchedBy: "unrestricted" };
  }

  const mode = profileGeo.mode || "unrestricted";

  // Normalize input: accept array (canonical) or single string (legacy).
  const locsRaw = Array.isArray(jobLocations)
    ? jobLocations
    : jobLocations
    ? [jobLocations]
    : [];
  const locs = locsRaw.map(normalizeLocStr).filter(Boolean);

  if (locs.length === 0) {
    if (mode === "unrestricted") {
      return { ok: true, reason: null, matchedBy: "unrestricted" };
    }
    return { ok: false, reason: "geo_no_location", matchedBy: null };
  }

  // Multi-location semantic (§8.7): pass if ANY location matches.
  // BUT: if any location is in the blocklist, reject the whole job.
  // Reasoning: blocklist is "I refuse to commute here", whereas missing match
  // is "this particular city isn't on my list". A multi-city posting
  // ["Sacramento", "Napa"] for someone who blocklists Napa should still pass
  // (user wants Sacramento). Inverse — ["Napa"] alone — should block.
  // Therefore: blocklist applied per-location; positive match also per-location.
  // A location that's blocklisted contributes neither pass nor reject by
  // itself (we just skip it). A location that passes positive match wins.

  let firstReason = null;
  let blockedAll = true; // all locations were blocklist hits (no positive ones)

  for (const loc of locs) {
    const r = checkOneLocation(loc, profileGeo);
    if (r.ok) {
      return { ok: true, reason: null, matchedBy: r.matchedBy };
    }
    if (!r.blockedBy) {
      blockedAll = false; // at least one location wasn't a blocklist hit
      if (!firstReason) {
        firstReason =
          mode === "metro" ? "geo_metro_miss"
          : mode === "us-wide" ? "geo_country_miss"
          : mode === "remote-only" ? "geo_remote_only_miss"
          : mode === "unrestricted" ? null  // unreachable (unrestricted always passes)
          : "geo_unknown_mode";
      }
    }
  }

  if (blockedAll) {
    return { ok: false, reason: "geo_blocklist", matchedBy: null };
  }
  return { ok: false, reason: firstReason || "geo_metro_miss", matchedBy: null };
}

module.exports = {
  enforceGeo,
  // Exported for tests / debugging.
  REMOTE_MARKERS,
  US_MARKERS,
  US_STATE_CODES,
  US_STATE_NAMES,
  isRemoteLoc,
  hasUsMarker,
};
