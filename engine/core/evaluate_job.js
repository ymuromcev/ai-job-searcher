// RFC 040 / BL-92 — Unified `evaluateJob`.
//
// Single pure module that decides whether a job-like record passes the
// profile's filter rules. Today the same rule-set is implemented three
// times across `engine/core/filter.js`, `engine/commands/prepare.js`, and
// `engine/core/email_filters.js`; this module is the canonical
// implementation that those call-sites delegate to via thin shape
// adapters and shim layers (Phase 1 — see RFC 040 §4).
//
// Contract recap:
//   - Pure: no I/O, no `process`, no input mutation.
//   - `appState.companyCounts` is read-only here; the caller increments
//     on `decision === "keep"` (same contract as `filterJobs` today).
//   - `skipReason` is always a value from `ENGINE_SKIP_REASONS` (BL-91)
//     when `decision === "skip"`, or `null` on `keep`.
//   - Multi-loc location_blocklist follows BL-24: a US marker in ANY
//     element of `locations[]` suppresses the entire location_blocklist
//     branch (delegated to `hasUsMarker`).
//
// Decision pipeline order (RFC 040 §3.3) — first match short-circuits:
//   1. company_blocklist        (always)
//   2. title_requirelist        (skipped in `email`)
//   3. title_blocklist          (always — word-boundary canonical)
//   4. company_cap              (skipped in `email`)
//   5. location_blocklist       (skipped in `email`)
//   6. geo                      (skipped in `email`)

const { enforceGeo, hasUsMarker } = require("./geo_enforcer.js");
const { findTitleBlocklistHit } = require("./filter_helpers.js");
const { isEngineSkipReason } = require("./skip_reasons.js");

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary regex matching filter.js#makeBoundaryRegex semantics.
function makeBoundaryRegex(needle) {
  const lower = String(needle).toLowerCase();
  const startB = /\w/.test(lower[0]) ? "\\b" : "";
  const endB = /\w/.test(lower[lower.length - 1]) ? "\\b" : "";
  return new RegExp(`${startB}${escapeRegex(lower)}${endB}`, "i");
}

// Normalize a job record. Accepts both `locations[]` (canonical) and
// the legacy single-string `location`. Returns `{ company, title,
// locations, url, source }` plus untouched `jd_text` if present.
function normalizeJob(raw) {
  const job = raw || {};
  const locations = Array.isArray(job.locations)
    ? job.locations.map((l) => String(l == null ? "" : l)).filter(Boolean)
    : job.location
      ? [String(job.location)]
      : [];
  return {
    company: String(job.company || ""),
    title: String(job.title || ""),
    locations,
    url: job.url ? String(job.url) : "",
    source: job.source ? String(job.source) : "",
    jd_text: job.jd_text || "",
  };
}

// company_blocklist may arrive as flat strings or as `{ name, reason }`
// objects (defensive — profile_loader normalizes to strings, but inline
// tests sometimes feed objects). Returns a Set of lowercased names.
function normalizeCompanyBlocklist(rules) {
  const list = Array.isArray(rules && rules.company_blocklist)
    ? rules.company_blocklist
    : [];
  const out = new Set();
  for (const entry of list) {
    const name = entry && typeof entry === "object" ? entry.name : entry;
    if (typeof name === "string" && name.length > 0) {
      out.add(name.toLowerCase());
    }
  }
  return out;
}

// title_blocklist may arrive as `{ pattern, reason }` or flat strings.
// Returns the original `{pattern, reason}` entries (preserves `reason`
// for diagnostics) plus a parallel array of bare lowercase pattern
// strings for `findTitleBlocklistHit`.
function normalizeTitleBlocklist(rules) {
  const raw = Array.isArray(rules && rules.title_blocklist)
    ? rules.title_blocklist
    : [];
  const entries = [];
  const patterns = [];
  for (const item of raw) {
    const pattern =
      item && typeof item === "object" ? item.pattern : item;
    if (typeof pattern !== "string" || !pattern) continue;
    const reason =
      item && typeof item === "object" ? item.reason : undefined;
    entries.push({ pattern, reason });
    patterns.push(pattern);
  }
  return { entries, patterns };
}

function normalizeTitleRequirelist(rules) {
  const raw = Array.isArray(rules && rules.title_requirelist)
    ? rules.title_requirelist
    : [];
  const out = [];
  for (const item of raw) {
    const pattern =
      item && typeof item === "object" ? item.pattern : item;
    if (typeof pattern !== "string" || !pattern) continue;
    out.push(pattern);
  }
  return out;
}

// title_requirelist: at least one slash-part of the title must match at
// least one required pattern (word-boundary, case-insensitive). Empty
// requirelist → pass-through (no positive gate).
function titlePassesRequirelist(title, patterns) {
  if (!patterns || patterns.length === 0) return true;
  const titleLower = String(title || "").toLowerCase();
  if (!titleLower) return false;
  const parts = titleLower
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  const titleParts = parts.length > 0 ? parts : [titleLower];
  return titleParts.some((part) =>
    patterns.some((pat) => makeBoundaryRegex(pat).test(part))
  );
}

function shouldRunCompanyCap(context) {
  return context === "scan" || context === "prepare";
}

function shouldRunTitleRequire(context) {
  return context === "scan" || context === "prepare";
}

function shouldRunLocationBlocklist(context) {
  return context === "scan" || context === "prepare";
}

function shouldRunGeo(context) {
  return context === "scan" || context === "prepare";
}

/**
 * @param {EvaluateJobInput} input
 * @returns {EvaluateJobResult}
 */
function evaluateJob({ job, profile, appState, context }) {
  if (context !== "scan" && context !== "prepare" && context !== "email") {
    throw new Error(
      `evaluateJob: context must be "scan" | "prepare" | "email" (got ${JSON.stringify(context)})`
    );
  }

  const norm = normalizeJob(job);
  const rules = (profile && profile.filter_rules) || {};
  // RFC 013: profile-level geo lives at `profile.geo`; legacy callers may
  // inject it as `rules.geo`. Both accepted.
  const profileGeo =
    (profile && profile.geo) || (rules && rules.geo) || null;

  // ---- 1. company_blocklist ----
  const companyBlocklist = normalizeCompanyBlocklist(rules);
  const companyLower = norm.company.toLowerCase();
  if (companyLower && companyBlocklist.has(companyLower)) {
    return {
      decision: "skip",
      skipReason: "company_blocklist",
      matched: { rule: "company_blocklist", company: norm.company },
    };
  }

  // ---- 2. title_requirelist (skipped in email) ----
  if (shouldRunTitleRequire(context)) {
    const requirelist = normalizeTitleRequirelist(rules);
    if (requirelist.length > 0 && !titlePassesRequirelist(norm.title, requirelist)) {
      return {
        decision: "skip",
        skipReason: "title_requirelist",
        matched: {
          rule: "title_requirelist",
          why: "title does not match any required pattern",
        },
      };
    }
  }

  // ---- 3. title_blocklist (word-boundary canonical, always) ----
  const { entries: titleEntries, patterns: titlePatterns } =
    normalizeTitleBlocklist(rules);
  if (titlePatterns.length > 0 && norm.title) {
    const hit = findTitleBlocklistHit(norm.title, titlePatterns);
    if (hit) {
      const orig = titleEntries.find(
        (p) => String(p.pattern).toLowerCase() === String(hit).toLowerCase()
      );
      return {
        decision: "skip",
        skipReason: "title_blocklist",
        matched: {
          rule: "title_blocklist",
          pattern: orig ? orig.pattern : hit,
          reason: orig ? orig.reason : undefined,
        },
      };
    }
  }

  // ---- 4. company_cap (skipped in email) ----
  if (shouldRunCompanyCap(context)) {
    const cap = (rules && rules.company_cap) || {};
    const overrides = cap.overrides || {};
    const limit = Object.prototype.hasOwnProperty.call(overrides, norm.company)
      ? Number(overrides[norm.company])
      : cap.max_active != null
        ? Number(cap.max_active)
        : Infinity;
    const counts =
      (appState && appState.companyCounts) || {};
    const current = counts[norm.company] || 0;
    if (current >= limit) {
      return {
        decision: "skip",
        skipReason: "company_cap",
        matched: {
          rule: "company_cap",
          cap: limit,
          current,
        },
      };
    }
  }

  // ---- 5. location_blocklist (skipped in email) ----
  // BL-24: US marker in ANY element wins — suppress blocklist entirely
  // when present.
  if (shouldRunLocationBlocklist(context)) {
    const locsLower = norm.locations.map((l) => l.toLowerCase());
    if (locsLower.length > 0 && !hasUsMarker(locsLower)) {
      const blocklist = Array.isArray(rules.location_blocklist)
        ? rules.location_blocklist
        : [];
      for (const blocked of blocklist) {
        const needle = String(blocked || "").toLowerCase();
        if (!needle) continue;
        if (locsLower.some((l) => l.includes(needle))) {
          return {
            decision: "skip",
            skipReason: "location_blocklist",
            matched: {
              rule: "location_blocklist",
              match: blocked,
            },
          };
        }
      }
    }
  }

  // ---- 6. geo (enforceGeo; skipped in email) ----
  // BL-102 cache: when geo runs (regardless of mode), the full
  // `enforceGeo` result is attached as `matched.geoResult` so callers
  // can cache it on the passing entry (`_geoResult`) without
  // recomputing downstream.
  if (shouldRunGeo(context) && profileGeo) {
    const locsForGeo = norm.locations.length > 0 ? norm.locations : [];
    const geoResult = enforceGeo(locsForGeo, profileGeo);
    const mode = profileGeo.mode || "unrestricted";
    if (!geoResult.ok && mode !== "unrestricted") {
      // geoResult.reason is one of the enum values (geo_*).
      const reason = geoResult.reason;
      // Defensive: ensure we only emit known enum values. Anything
      // unexpected falls back to geo_unknown_mode.
      const safeReason = isEngineSkipReason(reason) ? reason : "geo_unknown_mode";
      return {
        decision: "skip",
        skipReason: safeReason,
        matched: {
          rule: safeReason,
          mode,
          matchedBy: null,
          geoResult,
        },
      };
    }
    return {
      decision: "keep",
      skipReason: null,
      matched: {
        geoMatchedBy: geoResult.matchedBy || null,
        geoResult,
      },
    };
  }

  return {
    decision: "keep",
    skipReason: null,
    matched: { geoMatchedBy: null },
  };
}

module.exports = { evaluateJob };
