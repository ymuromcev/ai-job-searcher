// BL-243 (RFC 072) — "this number is not an annual USD amount" guard shared by
// both published-salary parsers (core/published_salary.js for prepare,
// modules/apply/salary.js for the apply bot).
//
// LatAm postings (Plata, Unlimit) publish pay like "$45,000 – $60,000 MXN
// mensuales": the `$` and the plausible size would pass as an annual USD range
// and feed a wrong number to the salary floor. A range is dropped when a
// non-USD currency code or a monthly marker sits right next to it (before or
// after), the same way hourly ranges are dropped. A dropped range means "no
// published range" — the channel default applies.
//
// Pure: strings in, boolean out.

const CURRENCY = String.raw`(?:MXN|COP|BRL|ARS|CLP|PEN|UYU|MX\$|R\$)`;
const MONTHLY = String.raw`(?:mensual(?:es)?|mensal|monthly|per\s+month|a\s+month|al\s+mes|por\s+mes)`;

// Text right after the range.
const AFTER_RE = new RegExp(
  String.raw`^\s*(?:(?:${CURRENCY})(?![A-Za-z])|${MONTHLY}\b|\/\s*(?:month|mo|mes|m[eê]s)\b)`,
  "i"
);
// Text right before the range ("MXN $45,000 - $60,000", "MXN45,000"). A range
// match starts at its first "$", so a glued "MX$45,000" / "R$45,000" arrives
// here as a bare "MX" / "R" ending the slice (no space in between).
const BEFORE_RE = new RegExp(String.raw`(?:^|[^A-Za-z])(?:${CURRENCY}\s*|MX|R)$`, "i");

/**
 * @param {string} text   full text
 * @param {number} start  index where the matched range starts
 * @param {number} end    index right after the matched range
 * @returns {boolean} true when the range is non-USD or per-month
 */
function isNonUsdOrMonthlyContext(text, start, end) {
  const s = String(text || "");
  const after = s.slice(end, end + 24);
  const before = s.slice(Math.max(0, start - 8), start);
  return AFTER_RE.test(after) || BEFORE_RE.test(before);
}

/**
 * `extractJDStructure().salary_text` is the amount without the words around it
 * ("$45,000 - $60,000" out of "… $60,000 MXN mensuales"). Look the section up
 * in the full JD and judge the text around it.
 *
 * @param {string} fullText     whole JD / page text
 * @param {string} sectionText  the extracted salary text
 * @returns {boolean} true when the section sits in a non-USD / monthly context
 */
function sectionIsNonUsdOrMonthly(fullText, sectionText) {
  const full = String(fullText || "");
  const sec = String(sectionText || "").trim();
  if (!full || !sec) return false;
  const idx = full.indexOf(sec);
  if (idx < 0) return false;
  return isNonUsdOrMonthlyContext(full, idx, idx + sec.length);
}

module.exports = { isNonUsdOrMonthlyContext, sectionIsNonUsdOrMonthly };
