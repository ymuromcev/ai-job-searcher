// RFC 068 §4a — parse the PUBLISHED salary range from a job description.
//
// Not to be confused with the TSV `salary_min` / `salary_max` columns: those
// are the engine's own Company-Tier × Level estimate (`salary_calc.js`,
// written at `prepare --phase commit`), not what the employer published.
// The salary floor must compare against what the employer published, so it
// reads the JD text instead.
//
// Pure: string in, `{ min, max } | null` out. Annual USD-style amounts only —
// hourly ranges ("$45 - $60/hr") are ignored so an hourly number never trips
// an annual floor.

const { extractJDStructure } = require("./jd_extract.js");

// Plausible annual-salary bounds. Anything outside is noise ("$5M ARR",
// "$500 learning stipend") and ignored.
const MIN_ANNUAL = 10000;
const MAX_ANNUAL = 5000000;

const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const SUFFIX = String.raw`\s*([kKmM])?`;
const SEP = String.raw`\s*(?:USD|usd)?\s*(?:-|–|—|to)\s*(?:USD\s*)?`;
// Range: "$140,000 - $190,000", "$140K–$190K", "$140-190k", "USD 140,000 to 190,000".
const RANGE_RE = new RegExp(
  String.raw`(?:USD\s*\$?|\$)\s*${NUM}${SUFFIX}${SEP}\$?\s*${NUM}${SUFFIX}`,
  "g"
);
// Single amount: "$150,000", "$150K", "USD 150,000".
const SINGLE_RE = new RegExp(String.raw`(?:USD\s*\$?|\$)\s*${NUM}${SUFFIX}`, "g");

const HOURLY_RE = /^\s*(?:USD\s*)?(?:\/|per|an|a)\s*(?:hour|hr)\b|^\s*hourly\b/i;

function toNumber(numStr, suffix) {
  const n = parseFloat(String(numStr).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const s = (suffix || "").toLowerCase();
  if (s === "k") return n * 1000;
  if (s === "m") return n * 1000000;
  return n;
}

function plausible(n) {
  return typeof n === "number" && n >= MIN_ANNUAL && n <= MAX_ANNUAL;
}

function isHourlyAfter(text, endIndex) {
  return HOURLY_RE.test(text.slice(endIndex, endIndex + 24));
}

function findRanges(text) {
  const out = [];
  RANGE_RE.lastIndex = 0;
  let m;
  while ((m = RANGE_RE.exec(text)) !== null) {
    if (isHourlyAfter(text, m.index + m[0].length)) continue;
    let [, aNum, aSuf, bNum, bSuf] = m;
    // "$140-190K": the suffix on one bound applies to a bare small other bound.
    if (!aSuf && bSuf && parseFloat(aNum.replace(/,/g, "")) < 1000) aSuf = bSuf;
    if (!bSuf && aSuf && parseFloat(bNum.replace(/,/g, "")) < 1000) bSuf = aSuf;
    const a = toNumber(aNum, aSuf);
    const b = toNumber(bNum, bSuf);
    if (!plausible(a) || !plausible(b)) continue;
    out.push({ min: Math.min(a, b), max: Math.max(a, b) });
  }
  return out;
}

function findSingles(text) {
  const out = [];
  SINGLE_RE.lastIndex = 0;
  let m;
  while ((m = SINGLE_RE.exec(text)) !== null) {
    if (isHourlyAfter(text, m.index + m[0].length)) continue;
    const n = toNumber(m[1], m[2]);
    if (plausible(n)) out.push(n);
  }
  return out;
}

/**
 * Parse a published salary range from free text.
 *
 * Multiple ranges (e.g. per-location tiers) collapse to the overall span:
 * lowest min, highest max — so the job is only treated as below a floor when
 * EVERY published tier tops out below it.
 *
 * @param {string} text
 * @param {{allowSingle?: boolean}} [opts]  allowSingle: also accept a lone
 *   amount ("$150,000") when no range is present. Use only on text already
 *   known to be about pay (a Compensation section), never on a whole JD.
 * @returns {{min: number|null, max: number|null} | null}
 */
function parsePublishedSalaryRange(text, opts = {}) {
  const s = String(text == null ? "" : text);
  if (!s) return null;
  const ranges = findRanges(s);
  if (ranges.length > 0) {
    return {
      min: Math.min(...ranges.map((r) => r.min)),
      max: Math.max(...ranges.map((r) => r.max)),
    };
  }
  if (opts.allowSingle) {
    const singles = findSingles(s);
    if (singles.length > 0) return { min: null, max: Math.max(...singles) };
  }
  return null;
}

function mergeRanges(a, b) {
  if (!a) return b;
  if (!b) return a;
  const mins = [a.min, b.min].filter((v) => typeof v === "number");
  const maxes = [a.max, b.max].filter((v) => typeof v === "number");
  return {
    min: mins.length ? Math.min(...mins) : null,
    max: maxes.length ? Math.max(...maxes) : null,
  };
}

/**
 * Published salary from a raw JD body: the Compensation line (lone amounts
 * allowed) merged with every range found anywhere in the body (ranges only),
 * so per-location tiers listed after the first one widen the span.
 *
 * @param {string} jdText
 * @returns {{min: number|null, max: number|null} | null}
 */
function publishedSalaryFromJd(jdText) {
  const text = String(jdText == null ? "" : jdText);
  if (!text) return null;
  const structured = extractJDStructure(text);
  const fromSection =
    structured && structured.salary_text
      ? parsePublishedSalaryRange(structured.salary_text, { allowSingle: true })
      : null;
  return mergeRanges(fromSection, parsePublishedSalaryRange(text));
}

module.exports = {
  parsePublishedSalaryRange,
  publishedSalaryFromJd,
  MIN_ANNUAL,
  MAX_ANNUAL,
};
