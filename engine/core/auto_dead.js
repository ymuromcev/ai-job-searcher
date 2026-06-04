// Auto-Dead — pure helpers (BL-169 / RFC 059 amendment).
//
// Two deterministic decisions, both date-injected so they never call
// `Date.now()` themselves (the CLI glue computes "today" once as a
// `YYYY-MM-DD` string and passes it down — see RFC 059 "Amendment —
// BL-169 auto-Dead").
//
//   1. stampOnTransition — when the operator flips `Outreach → In flight`
//      in Notion, the engine stamps `hm_outreach_date` with "today" so the
//      7-day timer has an anchor. Leaving In flight back to "To do" clears
//      the anchor (a re-entry re-stamps). Terminal "Replied"/"Dead" leave
//      the existing date as-is.
//
//   2. selectStaleInFlight — rows that have been In flight for >= 7 days
//      (with a non-empty anchor) are the auto-Dead candidates.
//
// Both are pure over in-memory objects. No I/O, no network, no Date.

const IN_FLIGHT = "In flight";
const TO_DO = "To do";
const DEAD = "Dead";

const DEFAULT_THRESHOLD_DAYS = 7;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Parse a strict `YYYY-MM-DD` string to a UTC epoch-day integer. Returns null
// for anything that isn't a well-formed date (empty, partial, garbage). Using
// UTC midnight avoids DST / timezone drift — we only care about whole-day
// deltas.
function epochDay(isoDate) {
  if (!isoDate || typeof isoDate !== "string") return null;
  const trimmed = isoDate.trim();
  if (!ISO_DATE_RE.test(trimmed)) return null;
  const ms = Date.parse(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 86400000);
}

// Whole days from `fromDate` to `toDate` (both `YYYY-MM-DD`). Returns null if
// either side is unparseable. Positive when toDate is later.
function daysBetween(fromDate, toDate) {
  const a = epochDay(fromDate);
  const b = epochDay(toDate);
  if (a === null || b === null) return null;
  return b - a;
}

// Decide the `hm_outreach_date` value after an outreach-status transition.
//
//   newStatus      — the status just pulled from Notion.
//   currentDate    — existing `hm_outreach_date` on the row ("" if unset).
//   todayStr       — injected "today" as `YYYY-MM-DD`.
//
// Returns one of:
//   { action: "stamp",  date: todayStr } — entered In flight with no anchor.
//   { action: "clear",  date: "" }       — left In flight back to To do.
//   { action: "keep",   date: currentDate } — no change (already anchored,
//                                              terminal status, etc.).
//
// The caller applies the returned date only when action !== "keep", so a
// "keep" is a cheap no-op. Pure: no Date, no I/O.
function decideOutreachDate(newStatus, currentDate, todayStr) {
  const current = currentDate ? String(currentDate).trim() : "";
  if (newStatus === IN_FLIGHT) {
    // Stamp only when there is no anchor yet — never overwrite an existing
    // one (re-stamping would silently reset the 7-day timer on every sync).
    if (!current) return { action: "stamp", date: todayStr };
    return { action: "keep", date: current };
  }
  if (newStatus === TO_DO) {
    // Moved back out of In flight → drop the anchor so a re-entry re-stamps.
    if (current) return { action: "clear", date: "" };
    return { action: "keep", date: current };
  }
  // Terminal ("Replied" / "Dead") or any other value → leave the date as-is.
  return { action: "keep", date: current };
}

// Select rows that have been In flight at least `thresholdDays` days.
//
//   apps          — loaded TSV rows.
//   todayStr      — injected "today" as `YYYY-MM-DD`.
//   thresholdDays — staleness cutoff (default 7).
//
// A row is stale iff:
//   status === "In flight"  AND
//   hm_outreach_date is a well-formed non-empty date  AND
//   (today - hm_outreach_date) >= thresholdDays days.
//
// Empty / malformed anchor → skipped (no timer). "Replied"/"Dead"/"To do" →
// never selected. Returns shallow references to the original app objects so
// the caller can flip status in place. Pure: no Date, no I/O.
function selectStaleInFlight(apps, todayStr, thresholdDays = DEFAULT_THRESHOLD_DAYS) {
  const stale = [];
  for (const app of apps || []) {
    if (!app || app.status !== IN_FLIGHT) continue;
    const anchor = app.hm_outreach_date ? String(app.hm_outreach_date).trim() : "";
    if (!anchor) continue;
    const age = daysBetween(anchor, todayStr);
    if (age === null) continue;
    if (age >= thresholdDays) stale.push(app);
  }
  return stale;
}

module.exports = {
  IN_FLIGHT,
  TO_DO,
  DEAD,
  DEFAULT_THRESHOLD_DAYS,
  epochDay,
  daysBetween,
  decideOutreachDate,
  selectStaleInFlight,
};
