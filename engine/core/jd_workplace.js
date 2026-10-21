// JD workplace classifier (BL-225 / RFC 068 §3).
//
// Pure helper. Reads a job description (plain text or the HTML that some ATS
// feeds return) and answers two questions the location string can't:
//
//   1. Work format: "remote" | "hybrid" | "onsite" | "unknown".
//   2. Which offices the JD ties the role to: US state codes ("CA", "TX") or
//      "INTL" for a known non-US city.
//
// `prepare --phase pre` uses it for rows that passed geo without a home-state
// location (`us_unspecified`, `remote:location`, `remote:title`): when the JD
// says hybrid/onsite and the named office is outside the home state, the row
// is archived with `geo_jd_not_remote`. Anything ambiguous is kept — the
// helper only drops on a clear hybrid/onsite signal plus a named office.
//
// Signal precedence (first hit wins):
//   1. A structured "SCHEDULE: Full-time · Hybrid" header line (written by the
//      JD fetchers from the ATS workplace field).
//   2. Strong remote wording ("fully remote", "remote-first", "this role is
//      remote", "Remote (US)", a "Location: … Remote" line).
//   3. Hybrid wording ("hybrid work model", "3 days a week in our … office").
//   4. Onsite wording ("this is an onsite role", "#LI-Onsite", "5 days a week
//      in the office", "we do not offer remote roles").
//   5. A role pinned to a named place ("this role is based in Austin, TX",
//      "within commuting distance of our Denver office") → onsite.
//   6. Any other "remote" mention → remote.
//   7. Otherwise "unknown".
//
// Sentences about perks, interviews, events, pay ranges and EEO boilerplate are
// ignored — they mention "onsite" / "hybrid" / office cities without saying
// anything about where this role works.

const {
  US_CODE_TO_NAME,
  canonicalStateCode,
  isUsCompatibleRemoteLoc,
} = require("./geo_enforcer.js");

// Rows that passed geo by a non-home-state clause and therefore need the JD
// check. `remote:structured` (adapter flag) is authoritative and skipped.
const JD_WORKPLACE_CHECK_MATCHED_BY = Object.freeze(
  new Set(["us_unspecified", "remote:location", "remote:title"])
);

function needsJdWorkplaceCheck(matchedBy) {
  return JD_WORKPLACE_CHECK_MATCHED_BY.has(String(matchedBy || ""));
}

// --- Text normalization ------------------------------------------------------

function htmlToText(raw) {
  return String(raw == null ? "" : raw)
    .replace(/<\s*(br|\/?p|\/?li|\/?div|\/?h[1-6]|\/?ul|\/?ol|\/?tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&rsquo;|&lsquo;|&#39;|&#x27;|&#8217;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

// Split into sentence-sized units: lines first, then sentence ends followed
// by a capital letter.
function splitUnits(text) {
  const out = [];
  for (const line of text.split(/\n+/)) {
    const t = line.trim();
    if (!t) continue;
    for (const part of t.split(/(?<=[.!?])\s+(?=[A-Z#*])/)) {
      const p = part.trim();
      if (p) out.push(p);
    }
  }
  return out;
}

// --- Signal patterns (matched on the lowercased unit) ------------------------

const NOISE_RE =
  /\b(interviews?|offsites?|off-sites?|retreats?|meetups?|gatherings?|events?|clinic|gym|fitness|snacks?|lunch(es)?|dinners?|meals?|kitchen|commuter|happy hours?|workshops?|customer sites?|customer locations?|dealers?(hip)?s?|zip code|pay range|salary|salaries|compensation|base pay|pay zone|geographic zones?|tier [0-9])\b|\$|\bwhether (they|you)('re| are)?\b|\bhybrid (cloud|environments|apps?|mobile|infrastructure)\b|\bhybrid of\b/;

const SCHEDULE_LINE_RE =
  /^\s*\**\s*(schedule|workplace(\s+type)?|work\s+type|work\s+arrangement)\s*:\s*(.+)$/i;
const LOCATION_LINE_RE =
  /^\s*\**\s*(location|locations|office location|based in)\s*:\s*\**\s*(.+)$/i;

const NON_REMOTE_RES = [
  /\b(not|isn't|is not|cannot be|can't be|won't be|will not be)\s+(a\s+)?(fully\s+)?remote\b/,
  /\b(do|does) not offer (fully\s+)?remote/,
  /\bno remote\b/,
  /\boffice[- ](first|centric)\b/,
];

const REMOTE_STRONG_RES = [
  /\b(fully|100%|completely|entirely|permanently)[ -]remote\b/,
  /\bremote[- ]first\b/,
  /\b(role|position|job|opportunity)\s+(is|will be|can be)\s+(a\s+)?(fully\s+)?remote\b/,
  /\b(is|be) a (fully )?remote (role|position|job|opportunity)\b/,
  /\bremote\s*[(\-–—,:]?\s*(within |in |across )?(the )?(us|u\.s\.?|usa|united states)(?![a-z])/,
  /(?<![a-z])(us|u\.s\.|usa|united states)[ -](based )?remote\b/,
  /\bwork (remotely )?from anywhere\b/,
  /\bremote(ly)? from anywhere\b/,
  /\b(can|may) (be )?(work(ed)?|done|based) remotely\b/,
  /\bremote[- ]eligible\b/,
  /#li-remote\b/,
  /\bor remote\b/,
  /\bopen to remote\b/,
];

const HYBRID_RES = [
  /\bhybrid\s+(work|working|role|position|schedule|model|policy|arrangement|workplace|setup|set-up|environment|company|team|opportunity|basis)\b/,
  /\b(role|position|job)\s+is\s+(a\s+)?hybrid\b/,
  /\(hybrid\)/,
  /^\W*hybrid\b/,
  /#li-hybrid\b/,
  /\bin[- ]person attendance\b/,
  /\banchor days?\b/,
];

const DAYS_PER_WEEK_RE =
  /\b([1-5]|one|two|three|four|five)(\s*(-|–|to|or)\s*([1-5]|two|three|four|five))?\s*(days?|x|times?)\s*(a|per|\/|each|every)\s*week\b/;
const DAYS_IN_OFFICE_RE =
  /\b([1-5]|one|two|three|four|five)\s+days\s+(in|at|from)\s+(the|our|an?)\s+[a-z ,.'-]{0,40}\boffices?\b/;
const IN_OFFICE_DAYS_RE = /\bin[- ]office\s+(work\s+)?([1-5]|one|two|three|four|five)\s+days\b/;
const OFFICE_CUE_RE =
  /\b(offices?|in[- ]person|on-?site|in[- ]office|hq|headquarters|campus|based (in|out of))\b/;
const FULL_WEEK_RE = /^(5|five)$/;
const MON_FRI_RE = /\bmonday\s*(through|to|-|–)\s*friday\b/;

const ONSITE_RES = [
  /\b(role|position|job)\s+is\s+(an?\s+)?(fully\s+)?(on-?site|in[- ]office|in[- ]person|office[- ]based)\b/,
  /\bis an? (fully\s+)?(on-?site|in[- ]office|in[- ]person|office[- ]based) (role|position|job)\b/,
  /#li-onsite\b/,
  /^\W*on-?site\b/,
  /\(on-?site\)/,
];

// "This role is based in Austin, TX" / "within commuting distance of our
// Denver office" — onsite only when the unit also names a place.
const PINNED_RES = [
  /\b(role|position|job|team)\s+(is|will be)\s+based\s+(in|out of|at)\b/,
  /\bbased (in|out of) (our|the) [^.]{0,80}\boffices?\b/,
  /\bcommuting distance\b/,
  /\b(must|required to|need to|expected to) (be able to )?(commute|relocate)\b/,
  /\brelocation (is )?required\b/,
];

const REMOTE_WEAK_RE = /\bremote\b/;

// --- Place extraction ---------------------------------------------------------

// City → state code (or "INTL"). Lowercase; longest phrases are matched first.
const CITY_TO_STATE = {
  // California
  "san francisco": "CA",
  "south san francisco": "CA",
  "bay area": "CA",
  "silicon valley": "CA",
  "los angeles": "CA",
  "san diego": "CA",
  "san jose": "CA",
  "palo alto": "CA",
  "mountain view": "CA",
  sunnyvale: "CA",
  "menlo park": "CA",
  "redwood city": "CA",
  "san mateo": "CA",
  "foster city": "CA",
  "san carlos": "CA",
  burlingame: "CA",
  oakland: "CA",
  berkeley: "CA",
  emeryville: "CA",
  cupertino: "CA",
  "santa clara": "CA",
  "santa monica": "CA",
  "culver city": "CA",
  "playa vista": "CA",
  "el segundo": "CA",
  irvine: "CA",
  "costa mesa": "CA",
  "newport beach": "CA",
  pasadena: "CA",
  burbank: "CA",
  sacramento: "CA",
  roseville: "CA",
  fremont: "CA",
  "long beach": "CA",
  "walnut creek": "CA",
  pleasanton: "CA",
  "los gatos": "CA",
  milpitas: "CA",
  "santa barbara": "CA",
  // New York
  "new york city": "NY",
  nyc: "NY",
  manhattan: "NY",
  brooklyn: "NY",
  // Other US hubs
  austin: "TX",
  dallas: "TX",
  houston: "TX",
  plano: "TX",
  "san antonio": "TX",
  seattle: "WA",
  bellevue: "WA",
  redmond: "WA",
  kirkland: "WA",
  boston: "MA",
  chicago: "IL",
  denver: "CO",
  boulder: "CO",
  atlanta: "GA",
  alpharetta: "GA",
  miami: "FL",
  tampa: "FL",
  orlando: "FL",
  phoenix: "AZ",
  scottsdale: "AZ",
  tempe: "AZ",
  "salt lake city": "UT",
  lehi: "UT",
  philadelphia: "PA",
  pittsburgh: "PA",
  minneapolis: "MN",
  detroit: "MI",
  nashville: "TN",
  raleigh: "NC",
  charlotte: "NC",
  "washington dc": "DC",
  "washington d.c.": "DC",
  mclean: "VA",
  reston: "VA",
  "jersey city": "NJ",
  hoboken: "NJ",
  portland: "OR",
  columbus: "OH",
  indianapolis: "IN",
  "st. louis": "MO",
  "kansas city": "MO",
  "las vegas": "NV",
  baltimore: "MD",
  // Non-US
  london: "INTL",
  toronto: "INTL",
  vancouver: "INTL",
  montreal: "INTL",
  dublin: "INTL",
  berlin: "INTL",
  amsterdam: "INTL",
  paris: "INTL",
  warsaw: "INTL",
  bangalore: "INTL",
  bengaluru: "INTL",
  singapore: "INTL",
  sydney: "INTL",
  "tel aviv": "INTL",
  "mexico city": "INTL",
  "sao paulo": "INTL",
  "são paulo": "INTL",
  tokyo: "INTL",
  zurich: "INTL",
  barcelona: "INTL",
  madrid: "INTL",
  lisbon: "INTL",
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CITY_ENTRIES = Object.entries(CITY_TO_STATE)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([city, code]) => ({ re: new RegExp(`(?<![a-z])${escapeRe(city)}(?![a-z])`, "g"), code }));

const STATE_NAME_ENTRIES = Object.entries(US_CODE_TO_NAME)
  .sort((a, b) => b[1].length - a[1].length)
  .map(([code, name]) => ({ re: new RegExp(`\\b${escapeRe(name)}\\b`, "g"), code }));

// "Austin, TX" / "New York, NY" — run on the original-case unit so ordinary
// words ("in", "or") are not read as state codes.
const CITY_STATE_RE = /\b[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){0,3},\s*([A-Z]{2})\b/g;
const CANADA_RE = /\bcanada\b|,\s*(on|bc|qc|ab|mb|sk|ns|nb|nl|pe)\s*,\s*ca\b/i;

function extractPlaces(unit) {
  const found = new Set();
  const canada = CANADA_RE.test(unit);
  let rest = unit.replace(/\bwashington,?\s*d\.?\s?c\.?(?![a-z])/gi, () => {
    found.add("DC");
    return " ";
  });
  rest = rest.replace(CITY_STATE_RE, (m, st) => {
    if (US_CODE_TO_NAME[st] && !(st === "CA" && canada)) {
      found.add(st);
      return " ";
    }
    return m;
  });
  let lower = rest.toLowerCase();
  for (const { re, code } of CITY_ENTRIES) {
    lower = lower.replace(re, () => {
      found.add(code);
      return " ";
    });
  }
  for (const { re, code } of STATE_NAME_ENTRIES) {
    lower = lower.replace(re, () => {
      found.add(code);
      return " ";
    });
  }
  if (canada) found.add("INTL");
  return found;
}

// --- Classifier ---------------------------------------------------------------

function anyMatch(res, s) {
  return res.some((re) => re.test(s));
}

function daysSignal(lower) {
  const m = DAYS_PER_WEEK_RE.exec(lower);
  if (m && (OFFICE_CUE_RE.test(lower) || /\bhybrid\b/.test(lower))) {
    const upper = m[4] || m[1];
    return FULL_WEEK_RE.test(upper) && !m[4] ? "onsite" : "hybrid";
  }
  if (DAYS_IN_OFFICE_RE.test(lower) || IN_OFFICE_DAYS_RE.test(lower)) {
    const n = (DAYS_IN_OFFICE_RE.exec(lower) || IN_OFFICE_DAYS_RE.exec(lower) || [])[1] || "";
    return FULL_WEEK_RE.test(n) ? "onsite" : "hybrid";
  }
  if (MON_FRI_RE.test(lower) && OFFICE_CUE_RE.test(lower)) return "onsite";
  return null;
}

/**
 * Classify a JD's work format and the offices it names.
 *
 * @param {string} jdText  Plain text or HTML.
 * @returns {{ workplace: "remote"|"hybrid"|"onsite"|"unknown",
 *             offices: string[], signals: string[] }}
 *   `offices` — sorted US state codes and/or "INTL", taken from location lines
 *   and from sentences that talk about the office / in-person work.
 *   `signals` — short labels of what fired (for debugging / reports).
 */
function classifyJdWorkplace(jdText) {
  const text = htmlToText(jdText);
  const units = splitUnits(text);
  const signals = [];
  const offices = new Set();
  let scheduled = null;
  let remoteStrong = false;
  let remoteWeak = false;
  let nonRemote = false;
  let hybrid = false;
  let onsite = false;
  let pinned = false;

  const addPlaces = (unit) => {
    for (const p of extractPlaces(unit)) offices.add(p);
  };

  for (const unit of units) {
    const lower = unit.toLowerCase();

    const sched = SCHEDULE_LINE_RE.exec(unit);
    if (sched) {
      const v = sched[3].toLowerCase();
      if (/\bhybrid\b/.test(v)) scheduled = scheduled || "hybrid";
      else if (/\bon-?site\b|\bin[- ]office\b|\bin[- ]person\b/.test(v))
        scheduled = scheduled || "onsite";
      else if (/\bremote\b/.test(v)) scheduled = scheduled || "remote";
      if (scheduled) signals.push(`schedule:${scheduled}`);
      continue;
    }

    const loc = LOCATION_LINE_RE.exec(unit);
    if (loc) {
      const v = loc[2].toLowerCase();
      if (/\bremote[- ]friendly\b/.test(v)) remoteWeak = true;
      else if (/\bremote\b/.test(v) && isUsCompatibleRemoteLoc(v)) {
        remoteStrong = true;
        signals.push("location:remote");
      } else if (/\bremote\b/.test(v)) remoteWeak = true;
      if (/\bhybrid\b/.test(v)) {
        hybrid = true;
        signals.push("location:hybrid");
      } else if (/\bon-?site\b|[-–—(]\s*office\b|\bin[- ]office\b/.test(v)) {
        onsite = true;
        signals.push("location:onsite");
      }
      addPlaces(loc[2]);
      continue;
    }

    if (NOISE_RE.test(lower)) continue;

    let officeUnit = false;
    if (anyMatch(NON_REMOTE_RES, lower)) {
      nonRemote = true;
      officeUnit = true;
      signals.push("non_remote");
    }
    if (!anyMatch(NON_REMOTE_RES, lower) && anyMatch(REMOTE_STRONG_RES, lower)) {
      remoteStrong = true;
      signals.push("remote");
    } else if (REMOTE_WEAK_RE.test(lower)) {
      remoteWeak = true;
    }
    const days = daysSignal(lower);
    if (days === "hybrid" || anyMatch(HYBRID_RES, lower)) {
      hybrid = true;
      officeUnit = true;
      signals.push("hybrid");
    } else if (days === "onsite" || anyMatch(ONSITE_RES, lower)) {
      onsite = true;
      officeUnit = true;
      signals.push("onsite");
    }
    if (anyMatch(PINNED_RES, lower)) {
      const places = extractPlaces(unit);
      const named = [...places].length > 0;
      if (named) {
        pinned = true;
        officeUnit = true;
        signals.push("pinned");
      }
    }
    if (officeUnit || /\boffices?\b/.test(lower)) addPlaces(unit);
  }

  let workplace = "unknown";
  if (scheduled) workplace = scheduled;
  else if (remoteStrong && !nonRemote) workplace = "remote";
  else if (hybrid) workplace = "hybrid";
  else if (onsite || nonRemote || pinned) workplace = "onsite";
  else if (remoteWeak) workplace = "remote";

  return { workplace, offices: [...offices].sort(), signals: [...new Set(signals)] };
}

/**
 * Decide whether a JD rules a row out for a home-state-or-remote candidate.
 * Drops ONLY when the JD is hybrid/onsite AND it names at least one office AND
 * none of the named offices is in the home state. Remote, unknown, or
 * hybrid/onsite without a named office → keep.
 *
 * @param {{workplace: string, offices: string[]}} classification
 * @param {string} homeState  2-letter code or full state name.
 * @returns {{ drop: boolean, reason: string|null }}
 */
function jdWorkplaceVerdict(classification, homeState) {
  const keep = { drop: false, reason: null };
  const home = canonicalStateCode(homeState);
  if (!classification || !home) return keep;
  const { workplace, offices } = classification;
  if (workplace !== "hybrid" && workplace !== "onsite") return keep;
  if (!Array.isArray(offices) || offices.length === 0) return keep;
  if (offices.includes(home)) return keep;
  return { drop: true, reason: "geo_jd_not_remote" };
}

module.exports = {
  classifyJdWorkplace,
  jdWorkplaceVerdict,
  needsJdWorkplaceCheck,
  JD_WORKPLACE_CHECK_MATCHED_BY,
  // Exported for tests.
  extractPlaces,
  htmlToText,
};
