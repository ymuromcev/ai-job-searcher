// BL-243, RFC 072 — "is this vacancy an AI one?" for the apply queue order.
//
// Owner (21.11.2026): «Порядок приоритета: 1. Мэтч 2. ИИ. Если в одном мэтч,
// а в другом мэтч и ИИ, выигрывает второй.» — fit decides first, AI breaks the
// tie inside one fit. The definition of "AI" is profile data, not an engine
// constant: `filter_rules.apply_priority` =
//   {
//     "ai_title_patterns": ["AI", "GenAI", "Generative", "LLM", ...],  // regex sources
//     "ai_track_ids":      ["ai_roles"],        // role_targets tracks whose patterns count
//     "ai_companies":      ["Anthropic", ...]   // AI-native companies (any role there)
//   }
// A title matches when a pattern is found on word boundaries, case-insensitive
// ("AI" matches "Ai PM", "(AI)", "AI/ML", "AI-native"; not "Sustainability",
// "Thailand", "OpenAI"). Track patterns are literal phrases on word boundaries.
// No `apply_priority` block -> never AI -> today's order (the rollback switch).
//
// Pure: no I/O. A bad regex is reported through `warn` and skipped.

const { normalizeName } = require("./company_keys.js");
const { makeBoundaryRegex } = require("./filter_helpers.js");

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function defaultWarn(msg) {
  process.stderr.write(`ai_priority: ${msg}\n`);
}

/**
 * @param {object} filterRules  profile filter_rules (post-normalize)
 * @param {{warn?: (msg: string) => void}} [opts]
 * @returns {(app: {title?: string, companyName?: string}) => boolean}
 */
function buildIsAi(filterRules, opts = {}) {
  const warn = typeof opts.warn === "function" ? opts.warn : defaultWarn;
  const cfg = filterRules && filterRules.apply_priority;
  if (!isPlainObject(cfg)) return () => false;

  const titleRegexes = [];

  // 1. ai_title_patterns: regex sources, wrapped in word boundaries.
  const titlePatterns = Array.isArray(cfg.ai_title_patterns) ? cfg.ai_title_patterns : [];
  for (const p of titlePatterns) {
    if (typeof p !== "string" || !p.trim()) continue;
    try {
      // Validate the bare pattern first: a stray "[" or ")" could otherwise
      // pair up with the wrapper's own brackets and compile by accident.
      new RegExp(p.trim(), "iu");
      titleRegexes.push(new RegExp(`(?<![\\p{L}\\p{N}_])(?:${p.trim()})(?![\\p{L}\\p{N}_])`, "iu"));
    } catch (err) {
      warn(
        `apply_priority.ai_title_patterns: bad pattern ${JSON.stringify(p)} skipped (${err.message})`
      );
    }
  }

  // 2. ai_track_ids: literal patterns of those role_targets tracks.
  const trackIds = new Set(Array.isArray(cfg.ai_track_ids) ? cfg.ai_track_ids.map(String) : []);
  const tracks =
    filterRules.role_targets && Array.isArray(filterRules.role_targets.tracks)
      ? filterRules.role_targets.tracks
      : [];
  for (const track of tracks) {
    if (!track || !trackIds.has(String(track.id))) continue;
    for (const entry of Array.isArray(track.patterns) ? track.patterns : []) {
      const pat = entry && typeof entry === "object" ? entry.pattern : entry;
      if (typeof pat !== "string" || !pat.trim()) continue;
      titleRegexes.push(makeBoundaryRegex(pat.trim()));
    }
  }

  // 3. ai_companies: exact normalized company name (company_keys.normalizeName).
  const companies = new Set();
  for (const c of Array.isArray(cfg.ai_companies) ? cfg.ai_companies : []) {
    const key = normalizeName(typeof c === "string" ? c : "");
    if (key) companies.add(key);
  }

  return function isAi(app) {
    const title = app && app.title != null ? String(app.title) : "";
    if (title && titleRegexes.some((re) => re.test(title))) return true;
    const key = normalizeName(app && typeof app.companyName === "string" ? app.companyName : "");
    return Boolean(key) && companies.has(key);
  };
}

module.exports = { buildIsAi };
