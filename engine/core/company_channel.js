// BL-242 / BL-243, RFC 072 — company channel index and the channel exception.
//
// `data/companies.tsv` rows may carry `extra_json.channel` (e.g. "ru_latam" for
// the RU-friendly LatAm pool: Plata, Unlimit). This module turns the pool into
// an index "normalized company name -> channel" and compiles the profile's
// `filter_rules.channel_exceptions[channel].allow_patterns` into a matcher.
// The matcher is the ONE place that decides "this location / title marker is
// allowed for this channel"; evaluate_job.js (location_blocklist, geo) and
// prepare.js (title geo marker) all call it.
//
// Pure except `loadChannelIndexFromFile` (reads one TSV, never throws).
// No column is added to the TSV: the channel lives in `extra_json`.

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./company_keys.js");
const { rowVisibleToProfile } = require("./companies.js");

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Channel of one companies.tsv row (shape of companies.load: `{ name, extra }`).
// Missing / non-string / blank channel -> "".
function channelOfRow(row) {
  const extra = row && isPlainObject(row.extra) ? row.extra : null;
  const ch = extra && typeof extra.channel === "string" ? extra.channel.trim() : "";
  return ch;
}

const EMPTY_INDEX = Object.freeze({
  size: 0,
  channelOf: () => "",
});

// rows: companies.tsv rows. opts:
//   profileId — only rows visible to that profile count (RFC 010 part B)
//   aliases   — profile.company_aliases `{ Parent: [Brand, ...] }`: a brand of a
//               channel parent gets the parent's channel. Brands the profile did
//               not list ("Plata Card") get nothing: matching is by exact
//               normalized name, never by prefix.
function buildChannelIndex(rows, opts = {}) {
  const { profileId = null, aliases = null } = opts;
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.name !== "string") continue;
    if (profileId && !rowVisibleToProfile(row, profileId)) continue;
    const ch = channelOfRow(row);
    if (!ch) continue;
    const key = normalizeName(row.name);
    if (key && !byKey.has(key)) byKey.set(key, ch);
  }
  if (isPlainObject(aliases)) {
    for (const [parent, brands] of Object.entries(aliases)) {
      const ch = byKey.get(normalizeName(parent));
      if (!ch || !Array.isArray(brands)) continue;
      for (const brand of brands) {
        const key = normalizeName(typeof brand === "string" ? brand : "");
        if (key && !byKey.has(key)) byKey.set(key, ch);
      }
    }
  }
  return {
    size: byKey.size,
    channelOf(name) {
      const key = normalizeName(typeof name === "string" ? name : "");
      return key ? byKey.get(key) || "" : "";
    },
  };
}

// Null-safe lookup: channel of `companyName` in `index` ("" when none).
function channelFor(index, companyName) {
  return index && typeof index.channelOf === "function" ? index.channelOf(companyName) : "";
}

// Parse companies.tsv leniently: a broken line or a broken extra_json costs
// only that row (companies.load throws on the first bad line, which would take
// the whole feature down). Returns rows shaped like companies.load.
function parseCompaniesTolerant(raw) {
  const rows = [];
  const lines = String(raw || "")
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i].split("\t");
    if (parts.length < 3 || !parts[0]) continue;
    let extra = null;
    if (parts[3]) {
      try {
        const parsed = JSON.parse(parts[3]);
        extra = isPlainObject(parsed) ? parsed : null;
      } catch {
        extra = null;
      }
    }
    rows.push({ name: parts[0].trim(), extra, profile: (parts[4] || "").trim().toLowerCase() });
  }
  return rows;
}

// Index from a companies.tsv file. Missing / unreadable file -> empty index.
function loadChannelIndexFromFile(filePath, opts = {}) {
  const readFile = opts.readFile || ((p) => fs.readFileSync(p, "utf8"));
  try {
    return buildChannelIndex(parseCompaniesTolerant(readFile(filePath)), opts);
  } catch {
    return EMPTY_INDEX;
  }
}

// Index for a loaded profile. Reads `<dataDir>/data/companies.tsv` only when
// the profile has `channel_exceptions` (nothing to apply otherwise).
function loadChannelIndexForProfile(profile, dataDir, opts = {}) {
  const rules = (profile && profile.filterRules) || {};
  if (!hasChannelExceptions(rules)) return EMPTY_INDEX;
  return loadChannelIndexFromFile(path.join(dataDir, "data", "companies.tsv"), {
    profileId: profile.id,
    aliases: profile.company_aliases || null,
    ...opts,
  });
}

function hasChannelExceptions(rules) {
  const ex = rules && rules.channel_exceptions;
  return isPlainObject(ex) && Object.keys(ex).length > 0;
}

// --- allow matcher ----------------------------------------------------------

// Lowercase, no diacritics: "São Paulo" -> "sao paulo", "México" -> "mexico".
function fold(s) {
  return String(s == null ? "" : s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// "new mexico" is a US state, not the country: never an allow hit.
const US_NEW_MEXICO_RE = /\bnew mexico\b/;

const compiledCache = new WeakMap();

function compileAllow(entry, warn) {
  const raw = entry && Array.isArray(entry.allow_patterns) ? entry.allow_patterns : [];
  const regexes = [];
  for (const p of raw) {
    const folded = fold(typeof p === "string" ? p.trim() : "");
    if (!folded) continue;
    try {
      // Word boundaries on both sides; literal text (not a user regex).
      regexes.push(new RegExp(`(?<![a-z0-9])${escapeRegex(folded)}(?![a-z0-9])`));
    } catch (err) {
      warn(`channel_exceptions: bad allow pattern ${JSON.stringify(p)} skipped (${err.message})`);
    }
  }
  return regexes;
}

/**
 * Matcher for the channel exception, or null when the profile has none for
 * this channel (no `channel_exceptions` block, other channel, empty list).
 *
 * @param {object} filterRules  profile filter_rules
 * @param {string} channel      exact channel key, e.g. "ru_latam"
 * @param {{warn?: Function}} [opts]
 * @returns {{channel: string, test: (text: string) => boolean} | null}
 */
function buildChannelAllow(filterRules, channel, opts = {}) {
  const ex = filterRules && filterRules.channel_exceptions;
  if (!channel || typeof channel !== "string" || !isPlainObject(ex) || !hasOwn(ex, channel)) {
    return null;
  }
  const warn = typeof opts.warn === "function" ? opts.warn : () => {};
  let perChannel = compiledCache.get(ex);
  if (!perChannel) {
    perChannel = new Map();
    compiledCache.set(ex, perChannel);
  }
  let regexes = perChannel.get(channel);
  if (!regexes) {
    regexes = compileAllow(ex[channel], warn);
    perChannel.set(channel, regexes);
  }
  if (regexes.length === 0) return null;
  return {
    channel,
    test(text) {
      const f = fold(text);
      if (!f || US_NEW_MEXICO_RE.test(f)) return false;
      return regexes.some((re) => re.test(f));
    },
  };
}

module.exports = {
  buildChannelIndex,
  channelFor,
  channelOfRow,
  parseCompaniesTolerant,
  loadChannelIndexFromFile,
  loadChannelIndexForProfile,
  hasChannelExceptions,
  buildChannelAllow,
  EMPTY_INDEX,
};
