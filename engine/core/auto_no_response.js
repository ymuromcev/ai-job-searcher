// Auto-No-Response — pure helpers (BL-187 / RFC 059 amendment).
//
// Mirror of auto-Dead (BL-169), but for the vacancy's MAIN status instead of
// the outreach status. Two deterministic decisions, both date-injected so they
// never call `Date.now()` themselves (the CLI glue computes "today" once as a
// `YYYY-MM-DD` string and passes it down — see RFC 059 "Amendment — BL-187
// auto-No-Response").
//
//   1. decideAppliedDate — when `sync` pulls `status="Applied"` from Notion and
//      the row has no `applied_date` anchor yet, the engine stamps "today" so
//      the 14-day timer has a start point. An existing anchor is never
//      overwritten (re-stamping would silently reset the timer). Any other
//      status leaves the anchor as-is — the sweep only ever inspects Applied
//      rows, so a stale anchor on a row that moved forward is harmless.
//
//   2. selectStaleApplied — rows that have been Applied for >= 14 days (with a
//      non-empty, well-formed anchor) are the auto-No-Response candidates.
//
// The date math (`daysBetween` / `epochDay`) is shared with auto-Dead — we
// reuse it rather than duplicate it. Both helpers below are pure over
// in-memory objects: no I/O, no network, no Date.

const { daysBetween, epochDay } = require("./auto_dead.js");

const APPLIED = "Applied";
const NO_RESPONSE = "No Response";

const DEFAULT_THRESHOLD_DAYS = 14;

// Decide the `applied_date` value after a main-status transition.
//
//   newStatus   — the status just pulled from Notion.
//   currentDate — existing `applied_date` on the row ("" if unset).
//   todayStr    — injected "today" as `YYYY-MM-DD`.
//
// Returns one of:
//   { action: "stamp", date: todayStr }     — entered Applied with no anchor.
//   { action: "keep",  date: currentDate }  — no change (already anchored, or
//                                              any non-Applied status).
//
// The caller applies the returned date only when action !== "keep", so a
// "keep" is a cheap no-op. Unlike auto-Dead's outreach helper there is no
// "clear" branch: moving forward out of Applied (Interview / Offer / Rejected /
// No Response) deliberately leaves the anchor in place — the sweep only looks
// at Applied rows, so the stale value never matters and we avoid losing the
// stamp on a future re-entry. Pure: no Date, no I/O.
function decideAppliedDate(newStatus, currentDate, todayStr) {
  const current = currentDate ? String(currentDate).trim() : "";
  if (newStatus === APPLIED) {
    // Stamp only when there is no anchor yet — never overwrite an existing one
    // (re-stamping would silently reset the 14-day timer on every sync).
    if (!current) return { action: "stamp", date: todayStr };
    return { action: "keep", date: current };
  }
  // Any non-Applied status → leave the anchor as-is.
  return { action: "keep", date: current };
}

// Select rows that have been Applied at least `thresholdDays` days.
//
//   apps          — loaded TSV rows.
//   todayStr      — injected "today" as `YYYY-MM-DD`.
//   thresholdDays — staleness cutoff (default 14).
//
// A row is stale iff:
//   status === "Applied"  AND
//   applied_date is a well-formed non-empty date  AND
//   (today - applied_date) >= thresholdDays days.
//
// Empty / malformed anchor → skipped (no timer). "No Response" (already
// terminal) and every other status → never selected. Returns shallow
// references to the original app objects so the caller can flip status in
// place. Pure: no Date, no I/O.
function selectStaleApplied(apps, todayStr, thresholdDays = DEFAULT_THRESHOLD_DAYS) {
  const stale = [];
  for (const app of apps || []) {
    if (!app || app.status !== APPLIED) continue;
    const anchor = app.applied_date ? String(app.applied_date).trim() : "";
    if (!anchor) continue;
    const age = daysBetween(anchor, todayStr);
    if (age === null) continue;
    if (age >= thresholdDays) stale.push(app);
  }
  return stale;
}

module.exports = {
  APPLIED,
  NO_RESPONSE,
  DEFAULT_THRESHOLD_DAYS,
  epochDay,
  daysBetween,
  decideAppliedDate,
  selectStaleApplied,
};
