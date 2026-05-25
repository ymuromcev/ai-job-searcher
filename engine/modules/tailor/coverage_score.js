// Coverage scoring for the Strong-fit lexical-mirror tailoring loop (RFC 044).
//
// Pure functions over in-memory data: given a list of JD phrases and the plain
// text of a candidate's tailored resume, returns the lexical-mirror coverage
// score plus per-phrase status and a breakdown by `priority`.
//
// The scoring formula matches RFC 044 §"Loop semantics" / Open Question #2:
//
//   coverage_pct = round(
//     (matched.length * 1.0 + partial.length * 0.5) / total * 100
//   )
//
// `matched` = exact case-insensitive substring of the phrase (after whitespace
// normalisation) is found in the resume text.
// `partial` = at least 60% of the phrase's tokens appear inside a 50-character
// window somewhere in the resume.
// `missing` = neither matched nor partial.
//
// Edge cases (per BL-123 contract):
//   - Empty jdPhrases → coverage_pct = 100, all buckets empty.
//   - Empty resumeText → coverage_pct = 0, every phrase lands in `missing`.
//   - Phrase with no alphanumeric content → treated as missing (we cannot match
//     punctuation reliably and we don't want to inflate the score).
//
// Exports:
//   computeCoverage(jdPhrases, resumeText)  → { coverage_pct, matched, partial,
//                                               missing, breakdown }
//   normalizeText(s)                        → string  (lowercase, collapsed ws)
//   findExactMatch(phrase, text)            → boolean
//   findPartialMatch(phrase, text)          → boolean

const PARTIAL_WINDOW = 50;
const PARTIAL_TOKEN_RATIO = 0.6;
const PRIORITY_BUCKETS = ["high", "medium", "low"];

/**
 * Lowercase, normalise whitespace (collapse runs of \s into a single space),
 * and trim. Null/undefined input → empty string.
 *
 * @param {string|null|undefined} s
 * @returns {string}
 */
function normalizeText(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split a normalised string into alphanumeric tokens. We strip punctuation so
 * "open finance," and "open-finance" both yield ["open", "finance"].
 *
 * @param {string} s — assumed already normalised (lowercase, single-spaced).
 * @returns {string[]}
 */
function tokenize(s) {
  // Match runs of word-chars (letters, digits, underscore). Empty input → [].
  const out = String(s || "").match(/[a-z0-9]+/g);
  return out || [];
}

/**
 * Exact case-insensitive substring check after whitespace normalisation.
 *
 * @param {string} phrase
 * @param {string} text
 * @returns {boolean}
 */
function findExactMatch(phrase, text) {
  const p = normalizeText(phrase);
  const t = normalizeText(text);
  if (!p || !t) return false;
  return t.includes(p);
}

/**
 * Partial-match heuristic: ≥`PARTIAL_TOKEN_RATIO` of the phrase's tokens fall
 * inside a sliding `PARTIAL_WINDOW`-character window of the text. Designed to
 * catch slight rewordings ("own a product area end-to-end" vs "own product
 * area").
 *
 * We slide character-by-character; for each window we count how many distinct
 * phrase tokens appear as whole tokens (so "manager" doesn't match "managers"
 * accidentally — we tokenize the window the same way).
 *
 * Single-token phrases: degenerates to exact-match (one window, hit-or-miss).
 *
 * @param {string} phrase
 * @param {string} text
 * @returns {boolean}
 */
function findPartialMatch(phrase, text) {
  const t = normalizeText(text);
  const phraseTokens = tokenize(normalizeText(phrase));
  if (phraseTokens.length === 0 || t.length === 0) return false;

  // Single-token: partial == exact for our purposes; just check token-presence.
  if (phraseTokens.length === 1) {
    const textTokens = new Set(tokenize(t));
    return textTokens.has(phraseTokens[0]);
  }

  const phraseSet = new Set(phraseTokens);
  const needed = Math.ceil(phraseTokens.length * PARTIAL_TOKEN_RATIO);

  // Slide a PARTIAL_WINDOW-char window. Step by ~half window so we don't
  // re-tokenize every position but we never skip a candidate region.
  const step = Math.max(1, Math.floor(PARTIAL_WINDOW / 2));
  for (let i = 0; i <= Math.max(0, t.length - 1); i += step) {
    const window = t.slice(i, i + PARTIAL_WINDOW);
    const winTokens = new Set(tokenize(window));
    let hits = 0;
    for (const pt of phraseSet) {
      if (winTokens.has(pt)) hits += 1;
      if (hits >= needed) return true;
    }
    if (hits >= needed) return true;
    if (i + PARTIAL_WINDOW >= t.length) break;
  }
  return false;
}

/**
 * Compute lexical-mirror coverage of `jdPhrases` against `resumeText`.
 *
 * @param {Array<{phrase: string, category?: string, priority?: string}>} jdPhrases
 * @param {string} resumeText
 * @returns {{
 *   coverage_pct: number,
 *   matched: Array<object>,
 *   partial: Array<object>,
 *   missing: Array<object>,
 *   breakdown: { high: object, medium: object, low: object }
 * }}
 */
function computeCoverage(jdPhrases, resumeText) {
  const phrases = Array.isArray(jdPhrases) ? jdPhrases : [];
  const text = String(resumeText || "");

  // Empty JD: nothing to cover — degenerate "100%".
  if (phrases.length === 0) {
    return {
      coverage_pct: 100,
      matched: [],
      partial: [],
      missing: [],
      breakdown: emptyBreakdown(),
    };
  }

  const matched = [];
  const partial = [];
  const missing = [];

  for (const item of phrases) {
    const phrase = item && typeof item === "object" ? String(item.phrase || "") : "";
    if (!phrase || tokenize(normalizeText(phrase)).length === 0) {
      // Phrase with no alphanumeric content — treat as missing.
      missing.push(item);
      continue;
    }
    if (findExactMatch(phrase, text)) {
      matched.push(item);
    } else if (findPartialMatch(phrase, text)) {
      partial.push(item);
    } else {
      missing.push(item);
    }
  }

  const total = phrases.length;
  const coverage_pct = Math.round(
    ((matched.length * 1.0 + partial.length * 0.5) / total) * 100,
  );

  return {
    coverage_pct,
    matched,
    partial,
    missing,
    breakdown: buildBreakdown(matched, partial, missing),
  };
}

function emptyBreakdown() {
  const out = {};
  for (const p of PRIORITY_BUCKETS) {
    out[p] = { matched: 0, partial: 0, missing: 0, total: 0, coverage_pct: 100 };
  }
  return out;
}

function buildBreakdown(matched, partial, missing) {
  const out = emptyBreakdown();
  // Reset coverage_pct to 0 if no items for that priority — we want 0 not 100
  // when the priority bucket has phrases but none scored.
  for (const p of PRIORITY_BUCKETS) {
    out[p] = { matched: 0, partial: 0, missing: 0, total: 0, coverage_pct: 0 };
  }
  const bumpBucket = (item, key) => {
    const prio = (item && item.priority) || "medium";
    if (!Object.prototype.hasOwnProperty.call(out, prio)) {
      out[prio] = { matched: 0, partial: 0, missing: 0, total: 0, coverage_pct: 0 };
    }
    out[prio][key] += 1;
    out[prio].total += 1;
  };
  for (const m of matched) bumpBucket(m, "matched");
  for (const p of partial) bumpBucket(p, "partial");
  for (const x of missing) bumpBucket(x, "missing");

  for (const k of Object.keys(out)) {
    const b = out[k];
    if (b.total === 0) {
      b.coverage_pct = 100; // no phrases in bucket → vacuously covered
    } else {
      b.coverage_pct = Math.round(((b.matched * 1.0 + b.partial * 0.5) / b.total) * 100);
    }
  }
  return out;
}

module.exports = {
  computeCoverage,
  normalizeText,
  tokenize,
  findExactMatch,
  findPartialMatch,
  PARTIAL_WINDOW,
  PARTIAL_TOKEN_RATIO,
};
