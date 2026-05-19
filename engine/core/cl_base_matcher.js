// Pure helper: pick the cover-letter base entry to reuse for a given job
// from a profile's `cover_letter_versions.json`. See RFC 036.
//
// Two shapes are supported:
//   - "template-variants" (e.g. lilia): top-level `defaults` object with
//     `p2`, `p3`, `p4_template` strings and a `letters` array. Single base —
//     `defaults` is always picked, no scoring.
//   - "library" (e.g. jared): top-level keys map to entries shaped as
//     `{ filename, paragraphs: [p1, p2, p3, p4], company?, archetype?,
//        role_keywords? }`. Score every entry, pick the max.
//
// Returns:
//   {
//     key: string | null,         // entry key, or "defaults" for template-variants,
//                                 //   or null for empty/no-match
//     score: number,              // 0 when no match above threshold
//     reason: string,             // grep-friendly trace of which components fired
//     paragraphs: { P2: string|null, P3: string|null, P4: string|null }
//   }
//
// `resumeVer = null` is the pre-phase calling convention (RFC 036 §4) —
// archetype component is skipped, only company / title / JD-body fire.

const STOPWORDS = new Set([
  "a", "an", "the", "of", "and", "or", "for", "to", "in", "on", "at", "by",
  "with", "as", "from", "into", "is", "are", "was", "were", "be", "been",
  "being", "&",
  // role-title noise
  "senior", "sr", "junior", "jr", "lead", "staff", "principal", "head",
  "manager", "director", "vp", "chief", "officer", "specialist", "associate",
  "i", "ii", "iii", "iv", "v",
]);

const DEFAULT_WEIGHTS = {
  company: 10,
  archetype: 5,
  title: 3,
  jd_body: 1,
};
const DEFAULT_THRESHOLD = 8;
const JD_BODY_CAP = 5;

function tokenize(s) {
  if (s === null || s === undefined) return [];
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function normalizeCompany(s) {
  if (s === null || s === undefined) return "";
  return String(s).toLowerCase().trim();
}

// Detect shape. Treat empty / nullish / non-object as "empty".
function detectShape(versions) {
  if (!versions || typeof versions !== "object") return "empty";
  const keys = Object.keys(versions).filter((k) => !k.startsWith("_"));
  if (keys.length === 0) return "empty";
  // Template-variants: a `defaults` object with at least p2 or p3.
  const d = versions.defaults;
  if (d && typeof d === "object" && (typeof d.p2 === "string" || typeof d.p3 === "string")) {
    return "template-variants";
  }
  // Library: at least one entry that looks like `{ paragraphs: [...] }`.
  for (const k of keys) {
    const v = versions[k];
    if (v && typeof v === "object" && Array.isArray(v.paragraphs)) return "library";
  }
  return "empty";
}

// Library entries may carry explicit `company` / `archetype` / `role_keywords`
// fields, OR none of them. Fallback: parse the entry key
// (`affirm_capital` → company `"affirm"`, keywords `["affirm", "capital"]`).
function entryMeta(entryKey, entry) {
  const fromKeyTokens = tokenize(entryKey.replace(/[_\-]+/g, " "));
  const company = entry && typeof entry.company === "string" && entry.company.length > 0
    ? normalizeCompany(entry.company)
    : (fromKeyTokens[0] || "");
  const archetype = entry && typeof entry.archetype === "string" && entry.archetype.length > 0
    ? entry.archetype
    : null;
  const roleKeywords = entry && Array.isArray(entry.role_keywords) && entry.role_keywords.length > 0
    ? entry.role_keywords.map((k) => String(k).toLowerCase()).filter(Boolean)
    : fromKeyTokens;
  return { company, archetype, roleKeywords };
}

function readWeightsAndThreshold(profile) {
  const cfg = profile && profile.cl_base_matcher;
  const weights = { ...DEFAULT_WEIGHTS, ...(cfg && cfg.weights ? cfg.weights : {}) };
  const threshold = cfg && typeof cfg.threshold === "number" ? cfg.threshold : DEFAULT_THRESHOLD;
  return { weights, threshold };
}

function scoreLibraryEntry({ entryKey, entry, job, resumeVer, weights, profile }) {
  const meta = entryMeta(entryKey, entry);
  const reasons = [];
  let score = 0;

  // Component 1: same company (case-insensitive exact).
  const jobCompany = normalizeCompany(job && job.companyName);
  if (jobCompany && meta.company && jobCompany === meta.company) {
    score += weights.company;
    reasons.push("company_exact");
  }

  // Component 2: archetype match — only fires when both sides have a value.
  if (resumeVer && meta.archetype && String(resumeVer) === String(meta.archetype)) {
    score += weights.archetype;
    reasons.push("archetype_match");
  }

  // Component 3: title-keyword overlap.
  const jobTitleTokens = new Set(tokenize(job && job.title));
  const entryTokens = new Set(meta.roleKeywords.flatMap((k) => tokenize(k)));
  let overlap = 0;
  for (const t of entryTokens) {
    if (jobTitleTokens.has(t)) overlap += 1;
  }
  if (overlap > 0) {
    score += weights.title * overlap;
    reasons.push(`title:${overlap}`);
  }

  // Component 4: JD-body keyword density. Looks up archetype keywords from
  // profile.resume_archetypes[resumeVer].keywords. Skipped when resumeVer is
  // null (pre-phase) or the profile doesn't carry archetype keywords.
  const arch = resumeVer
    && profile
    && profile.resume_archetypes
    && profile.resume_archetypes[resumeVer];
  const archKeywords = arch && Array.isArray(arch.keywords) ? arch.keywords : [];
  const jdText = job && typeof job.jdText === "string" ? job.jdText.toLowerCase() : "";
  if (archKeywords.length > 0 && jdText.length > 0) {
    let hits = 0;
    for (const kw of archKeywords) {
      if (typeof kw !== "string" || kw.length === 0) continue;
      if (jdText.includes(kw.toLowerCase())) hits += 1;
    }
    const capped = Math.min(hits, JD_BODY_CAP);
    if (capped > 0) {
      score += weights.jd_body * capped;
      reasons.push(`jd_body:${capped}`);
    }
  }

  return { score, reasonParts: reasons };
}

function paragraphsFromLibraryEntry(entry) {
  const p = entry && Array.isArray(entry.paragraphs) ? entry.paragraphs : [];
  return {
    P2: typeof p[1] === "string" ? p[1] : null,
    P3: typeof p[2] === "string" ? p[2] : null,
    P4: typeof p[3] === "string" ? p[3] : null,
  };
}

function paragraphsFromDefaults(defaults) {
  return {
    P2: typeof defaults.p2 === "string" ? defaults.p2 : null,
    P3: typeof defaults.p3 === "string" ? defaults.p3 : null,
    P4: typeof defaults.p4_template === "string" ? defaults.p4_template : null,
  };
}

function pickClBase({ job, versions, resumeVer = null, profile = null } = {}) {
  const shape = detectShape(versions);

  if (shape === "empty") {
    return {
      key: null,
      score: 0,
      reason: "empty_library",
      paragraphs: { P2: null, P3: null, P4: null },
    };
  }

  if (shape === "template-variants") {
    return {
      key: "defaults",
      score: 1,
      reason: "template-variants:defaults",
      paragraphs: paragraphsFromDefaults(versions.defaults),
    };
  }

  // Library shape.
  const { weights, threshold } = readWeightsAndThreshold(profile);
  const orderedKeys = Object.keys(versions).filter((k) => !k.startsWith("_"));

  let best = null; // { key, score, reasonParts }
  for (const entryKey of orderedKeys) {
    const entry = versions[entryKey];
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.paragraphs)) continue;
    const { score, reasonParts } = scoreLibraryEntry({
      entryKey,
      entry,
      job: job || {},
      resumeVer,
      weights,
      profile,
    });
    if (best === null || score > best.score) {
      best = { key: entryKey, score, reasonParts, entry };
    }
    // Tiebreak: declaration order. We strictly use `>` above so the
    // first-declared winner of any tie is preserved.
  }

  if (best === null) {
    return {
      key: null,
      score: 0,
      reason: "no_library_entries",
      paragraphs: { P2: null, P3: null, P4: null },
    };
  }

  const meetsThreshold = best.score >= threshold;
  const parts = best.reasonParts.length > 0 ? best.reasonParts.join("+") : "no_components";
  const reason = meetsThreshold ? parts : `${parts}+low_confidence`;

  if (!meetsThreshold) {
    // RFC §3b: below threshold, still return the highest scorer but flag
    // low_confidence so SKILL knows to regenerate P3 (and P2 if it judges
    // the focus has drifted).
    return {
      key: best.key,
      score: best.score,
      reason,
      paragraphs: paragraphsFromLibraryEntry(best.entry),
    };
  }

  return {
    key: best.key,
    score: best.score,
    reason,
    paragraphs: paragraphsFromLibraryEntry(best.entry),
  };
}

module.exports = {
  pickClBase,
  detectShape,
  DEFAULT_WEIGHTS,
  DEFAULT_THRESHOLD,
};
