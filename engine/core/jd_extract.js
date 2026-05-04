// JD field extractors for the prepare stage.
//
// Two pure regex-based functions that pull schedule + requirements signal out
// of a job-description body and produce short canonical strings suitable for
// Notion fields:
//   - schedule    → select  (single canonical employment type, e.g. "Full-time")
//   - requirements → rich_text (short bulleted summary, capped ~500 chars)
//
// The extractors are deliberately conservative. If no signal is found we return
// null and let the SKILL fall back to no-write (back-compat: profiles whose
// property_map doesn't declare these fields aren't affected at all).
//
// Healthcare JDs are the primary target (Lilia profile) but the patterns are
// generic enough to fire on any JD that uses common employment-type vocabulary.
//
// Exports:
//   extractSchedule(jdText)    → string | null
//   extractRequirements(jdText) → string | null
//   extractFromJd(jdText)      → { schedule, requirements } convenience wrapper

// --- Helpers ----------------------------------------------------------------

function normalize(text) {
  return String(text || "")
    // collapse runs of whitespace to a single space inside a line, but keep
    // line breaks so bullet/heading patterns still anchor.
    .replace(/[ \t]+/g, " ")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function firstMatch(text, regex) {
  const m = regex.exec(text);
  return m ? m[0] : null;
}

// --- Schedule ---------------------------------------------------------------

// Canonical employment types we map to. The order is the priority used when
// a JD mentions multiple (e.g. "Full-time or Part-time" → return "Full-time").
const EMPLOYMENT_TYPES = [
  // [canonical, regex (case-insensitive, word-boundary aware)]
  ["Full-time", /\bfull[\s-]?time\b/i],
  ["Part-time", /\bpart[\s-]?time\b/i],
  ["Per Diem", /\bper[\s-]diem\b/i],
  ["PRN", /\bprn\b/i],
  ["Contract", /\b(contract(?:or)?|contract-to-hire|temp[\s-]?to[\s-]?hire)\b/i],
  ["Temporary", /\btemporary\b/i],
  ["Internship", /\bintern(?:ship)?\b/i],
];

const SHIFT_PATTERNS = [
  ["Days", /\b(day shift|days|daytime|first shift|1st shift)\b/i],
  ["Evenings", /\b(evening shift|evenings|second shift|2nd shift)\b/i],
  ["Nights", /\b(night shift|nights|overnight|third shift|3rd shift)\b/i],
  ["Weekends", /\b(weekend(?:s)?|saturday\/sunday)\b/i],
  ["Rotating", /\b(rotating shift|rotating shifts|rotating schedule)\b/i],
];

/**
 * Extract a single canonical schedule string from JD text.
 *
 * Priority: employment type wins over shift hint. If both are present we
 * return the employment type only (keeps the Notion `Schedule` select bounded
 * to a small set; shift detail can land in requirements instead).
 *
 * @param {string} jdText
 * @returns {string|null}
 */
function extractSchedule(jdText) {
  const text = normalize(jdText);
  if (!text) return null;

  for (const [canonical, re] of EMPLOYMENT_TYPES) {
    if (re.test(text)) return canonical;
  }

  for (const [canonical, re] of SHIFT_PATTERNS) {
    if (re.test(text)) return canonical;
  }

  // hours-per-week — usually in benefits/section header, e.g. "40 hours/week"
  // or "32-40 hrs". Only fire if no employment type was found above.
  const hours = /\b(\d{2})\s*(?:-\s*\d{2})?\s*hours?\s*(?:\/|per)\s*week\b/i.exec(text);
  if (hours) {
    const n = Number(hours[1]);
    if (n >= 35) return "Full-time";
    if (n >= 16) return "Part-time";
    return "Per Diem";
  }

  return null;
}

// --- Requirements -----------------------------------------------------------

// Education vocabulary. The capture group preserves the matched span so we
// can render it back in the summary verbatim (less paraphrase risk).
const EDUCATION_PATTERNS = [
  /\b(high school diploma(?:[^.\n]{0,40}?(?:or equivalent|or ged)?)?)\b/i,
  /\bhs\s+diploma\b/i,
  /\bged\b/i,
  /\bassociate(?:'s)?\s+degree\b/i,
  /\bbachelor(?:'s)?\s+degree\b/i,
  /\bmaster(?:'s)?\s+degree\b/i,
  /\b(?:doctorate|phd|md|do)\b/i,
];

// Years of experience. Picks up "1+ years", "2-3 years", "6 months". The span
// after "year(s)/month(s)" is captured up to the end of the line so the bullet
// reads like "1+ years of customer service experience" verbatim.
// Note: months are NOT matched — anything sub-year is too noisy to surface.
const EXPERIENCE_PATTERN = /\b(\d+\+?(?:\s*-\s*\d+\+?)?)\s*(?:year|yr)s?\b(?:[^.\n]{0,80})?/i;

// Healthcare certifications (Lilia's domain). Match common abbreviations as
// whole tokens — avoid bare "RN" matching "WARN", "LEARN", etc.
const HEALTHCARE_CERTS = [
  "BLS", "ACLS", "CPR", "PALS",
  "CMA", "RMA", "MA",
  "CNA", "CRMA", "CCMA",
  "RDA", "RDH", "RDAEF",
  "LVN", "LPN", "RN", "NP", "PA",
  "CPC", "CPB", "CCS", "CMRS",
  "Phlebotomy", "EMT",
];

const CERT_PATTERN = new RegExp(
  `\\b(${HEALTHCARE_CERTS.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b(?:\\s+(?:cert(?:ification)?|license|licensure|credential))?`,
  "g",
);

// Software certifications (Lilia's billing/admin context — kept short).
const SOFTWARE_CERTS = [
  "Epic", "Cerner", "Athena", "AthenaHealth", "eClinicalWorks", "NextGen",
  "Dentrix", "Eaglesoft", "Open Dental", "Nextech",
];
const SOFTWARE_PATTERN = new RegExp(
  `\\b(${SOFTWARE_CERTS.map((c) => c.replace(/\s+/g, "\\s+")).join("|")})\\b`,
  "gi",
);

// Languages. Bilingual / Spanish-speaking is a Lilia-specific positive signal
// but also relevant generally. Trilingual / specific language pairs included.
const LANGUAGE_PATTERNS = [
  /\b(bilingual|trilingual|multilingual)(?:\s+(?:in\s+)?[a-z\/-]+)?/gi,
  /\b(spanish|mandarin|cantonese|vietnamese|korean|russian|tagalog|hmong|portuguese)[\s-]+(?:speaker|speaking|fluent|preferred|required|a plus)\b/gi,
];

// Soft signals worth surfacing — keep tight, otherwise the summary balloons.
const STRENGTH = {
  required: /\brequired\b/i,
  preferred: /\b(preferred|a plus|nice to have|desired|ideal)\b/i,
};

function classifyStrength(span) {
  if (STRENGTH.required.test(span)) return "required";
  if (STRENGTH.preferred.test(span)) return "preferred";
  return null;
}

// Collect a strength context for a regex hit. Scope is limited to the same
// SENTENCE / LINE / BULLET as the match — delimiters are newline, period,
// semicolon. Extending past these tends to bleed "required" / "preferred"
// markers across unrelated bullets/sentences.
function pickContext(text, matchIndex, matchLength) {
  const delim = /[\n.;]/;
  let start = matchIndex;
  while (start > 0 && !delim.test(text[start - 1])) start--;
  let end = matchIndex + matchLength;
  while (end < text.length && !delim.test(text[end])) end++;
  return text.slice(start, end);
}

function dedupePush(arr, value) {
  if (!value) return;
  const norm = value.trim().toLowerCase();
  if (!arr.some((v) => v.toLowerCase() === norm)) {
    arr.push(value.trim());
  }
}

/**
 * Extract a short requirements summary from JD text.
 *
 * Returns a newline-delimited bullet list, capped at ~500 chars, or null when
 * no signal is found.
 *
 * @param {string} jdText
 * @returns {string|null}
 */
function extractRequirements(jdText) {
  const text = normalize(jdText);
  if (!text) return null;

  const bullets = [];

  // Education — pick the highest level mentioned.
  for (const re of EDUCATION_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const span = m[0].replace(/\s+/g, " ").trim();
      const ctx = pickContext(text, m.index, m[0].length);
      const strength = classifyStrength(ctx);
      const label = strength ? `${capitalize(span)} (${strength})` : capitalize(span);
      dedupePush(bullets, label);
      break; // one education line is enough
    }
  }

  // Years of experience — first hit only (most JDs state once).
  const exp = EXPERIENCE_PATTERN.exec(text);
  if (exp) {
    const span = exp[0].replace(/\s+/g, " ").trim();
    dedupePush(bullets, capitalize(span));
  }

  // Languages.
  for (const re of LANGUAGE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const span = m[0].replace(/\s+/g, " ").trim();
      dedupePush(bullets, capitalize(span));
      if (bullets.length >= 8) break;
    }
  }

  // Healthcare certs — collect unique tokens. Tag each with strength when
  // immediate context has it (e.g. "BLS preferred" → "BLS (preferred)").
  CERT_PATTERN.lastIndex = 0;
  const certHits = new Map();
  let cm;
  while ((cm = CERT_PATTERN.exec(text)) !== null) {
    const cert = cm[1];
    if (!certHits.has(cert)) {
      const ctx = pickContext(text, cm.index, cm[0].length);
      certHits.set(cert, classifyStrength(ctx));
    }
  }
  for (const [cert, strength] of certHits) {
    const label = strength ? `${cert} (${strength})` : cert;
    dedupePush(bullets, label);
    if (bullets.length >= 12) break;
  }

  // Software / EMR systems.
  SOFTWARE_PATTERN.lastIndex = 0;
  const softwareHits = new Map();
  let sm;
  while ((sm = SOFTWARE_PATTERN.exec(text)) !== null) {
    const name = sm[1];
    if (!softwareHits.has(name.toLowerCase())) {
      const ctx = pickContext(text, sm.index, sm[0].length);
      softwareHits.set(name.toLowerCase(), { name, strength: classifyStrength(ctx) });
    }
  }
  for (const { name, strength } of softwareHits.values()) {
    const label = strength ? `${name} (${strength})` : name;
    dedupePush(bullets, label);
    if (bullets.length >= 14) break;
  }

  if (bullets.length === 0) return null;

  // Render as bullet list. Cap total length at 500 chars so Notion rich_text
  // stays readable; truncate excess bullets, not mid-bullet.
  const lines = bullets.map((b) => `- ${b}`);
  let out = lines.join("\n");
  if (out.length > 500) {
    let trimmed = "";
    for (const line of lines) {
      const next = trimmed ? `${trimmed}\n${line}` : line;
      if (next.length > 480) break;
      trimmed = next;
    }
    out = `${trimmed}\n- …`;
  }
  return out;
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- Convenience wrapper ----------------------------------------------------

/**
 * Run both extractors at once. Returns a stable shape so callers can spread
 * directly into a batch entry.
 *
 * @param {string} jdText
 * @returns {{schedule: string|null, requirements: string|null}}
 */
function extractFromJd(jdText) {
  return {
    schedule: extractSchedule(jdText),
    requirements: extractRequirements(jdText),
  };
}

module.exports = {
  extractSchedule,
  extractRequirements,
  extractFromJd,
  // Exported for tests / debugging
  EMPLOYMENT_TYPES,
  SHIFT_PATTERNS,
  HEALTHCARE_CERTS,
  SOFTWARE_CERTS,
};
