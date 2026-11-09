// Apply queue: which TSV rows the bot may submit tonight (RFC 068 §1). Pure.
//
// Gates, in order:
//   1. status === "To Apply"
//   2. applied_date empty (never applied — the double-apply guard)
//   3. apply_state not "submitted" / "failed" / "manual" / "skipped" (a row the
//      bot gave up on — captcha, account, no honest answer — is not retried;
//      `requeue` can put it back)
//      (failed is never retried automatically; manual waits for a human),
//      and not an interrupted submit: apply_state "queued" with apply_note
//      "submitting:<ts>" means the process died between the Submit click
//      and the result write — the application may have gone out, so a
//      human checks it (never re-submitted automatically).
//   4. fit_score ∈ {Strong, Medium, Weak} (RFC 069 §3: every scored fit is
//      applied to; an unscored row is skipped as `fit_unscored`)
//   5. company cap: ≤ filter_rules.company_cap applications per company in
//      the rolling window. Counts come from `buildActiveCounts` (prepare.js)
//      over rows that already left "To Apply" (Applied / Interview / …), and
//      the limit comes from the canonical `evaluateJob` cap rule. Each row
//      queued tonight increments its company's count, so one night never
//      pushes a company over the cap.
//
//   4b. geo (RFC 068 §3, profile.geo): enforced upstream in `prepare`, and
//      again here as a safety net — rows that reached To Apply before the
//      geo rule (or with an unparsed location) must never be applied to.
//      A miss is skipped with `archive: true` and the engine's geo reason;
//      `apply --phase pre` archives the row.
//
// Order: Strong → Medium → Weak, then newest `createdAt` first (RFC 069 §3).
// `limit` truncates after gating.

const { evaluateJob } = require("../../core/evaluate_job.js");
const { enforceGeo } = require("../../core/geo_enforcer.js");

// Fit priority: lower rank goes first.
const FIT_RANK = { Strong: 0, Medium: 1, Weak: 2 };
const FIT_OK = new Set(Object.keys(FIT_RANK));
const STATES_DONE = new Set(["submitted", "failed", "manual", "skipped"]);

function companyCapDecision(companyName, filterRules, counts) {
  const capOnly = { filter_rules: { company_cap: (filterRules && filterRules.company_cap) || {} } };
  const res = evaluateJob({
    job: { company: companyName, title: "", locations: [] },
    profile: capOnly,
    appState: { companyCounts: counts },
    context: "prepare",
  });
  return res;
}

const SUBMITTING_PREFIX = "submitting:";

function isInterruptedSubmit(app) {
  return (
    String(app.apply_state || "") === "queued" &&
    String(app.apply_note || "").startsWith(SUBMITTING_PREFIX)
  );
}

function createdMs(app) {
  const t = Date.parse(app.createdAt || "");
  return Number.isFinite(t) ? t : 0;
}

// apps: TSV rows. opts: { filterRules, buildActiveCounts, windowDays, now, limit }.
// Returns { queue: app[], skipped: [{ key, company, title, reason, detail? }] }.
function buildQueue(apps, opts = {}) {
  const {
    filterRules = {},
    buildActiveCounts,
    windowDays = null,
    now,
    limit = null,
    profileGeo = null,
  } = opts;
  if (typeof buildActiveCounts !== "function") {
    throw new Error("buildQueue: buildActiveCounts is required");
  }
  const skipped = [];
  const candidates = [];
  for (const app of apps) {
    if (app.status !== "To Apply") continue;
    const base = { key: app.key, company: app.companyName, title: app.title };
    if (String(app.applied_date || "").trim()) {
      skipped.push({ ...base, reason: "already_applied" });
      continue;
    }
    const state = String(app.apply_state || "").trim();
    if (STATES_DONE.has(state)) {
      skipped.push({ ...base, reason: `apply_state_${state}` });
      continue;
    }
    if (isInterruptedSubmit(app)) {
      skipped.push({ ...base, reason: "interrupted_submit" });
      continue;
    }
    if (!FIT_OK.has(app.fit_score)) {
      skipped.push({ ...base, reason: "fit_unscored" });
      continue;
    }
    if (profileGeo) {
      const geo = enforceGeo(app.locations || [], profileGeo, {
        title: app.title,
        workplaceType: app.workplaceType || "",
      });
      if (!geo.ok) {
        skipped.push({ ...base, reason: geo.reason, archive: true });
        continue;
      }
    }
    candidates.push(app);
  }

  candidates.sort(
    (a, b) => FIT_RANK[a.fit_score] - FIT_RANK[b.fit_score] || createdMs(b) - createdMs(a)
  );

  const settled = apps.filter((a) => a.status !== "To Apply" && a.status !== "Inbox");
  const counts = { ...buildActiveCounts(settled, { windowDays, now }) };

  const queue = [];
  for (const app of candidates) {
    const base = { key: app.key, company: app.companyName, title: app.title };
    const cap = companyCapDecision(app.companyName, filterRules, counts);
    if (cap.decision === "skip" && cap.skipReason === "company_cap") {
      skipped.push({ ...base, reason: "company_cap", detail: cap.matched });
      continue;
    }
    if (Number.isFinite(limit) && limit > 0 && queue.length >= limit) {
      skipped.push({ ...base, reason: "over_limit" });
      continue;
    }
    counts[app.companyName] = (counts[app.companyName] || 0) + 1;
    queue.push(app);
  }
  return { queue, skipped };
}

module.exports = {
  buildQueue,
  companyCapDecision,
  isInterruptedSubmit,
  SUBMITTING_PREFIX,
  FIT_RANK,
};
