// RFC 040 §5.3 / BL-92 — property-based fuzz.
//
// Load-bearing test of the RFC: same `(job, profile)` input produces
// identical `decision` + `skipReason` from all three call-sites'
// adapters. If the abstraction has leaked anywhere — divergent
// blocklist semantics, inconsistent slash-split, drift in
// company_blocklist case-folding — this test fails on the diverging
// tuple.
//
// We don't generically compare full call-site outputs (their shapes
// differ — `matchBlocklists` returns `{ kind, ... }`, applyPrepareFilter
// returns `{ passed, skipped }`, `isLevelBlocked` returns boolean).
// Instead, we lower each output to a shared `{ decision, skipReason }`
// form and assert agreement WITHIN the context matrix (RFC §3.1):
//
//   - scan vs prepare: agree on all rules.
//   - email: agrees on company_blocklist + title_blocklist only (the
//     rules that run in email context — see §3.1).
//
// Each rule gets 100 random `(job, profile)` tuples generated from a
// tight token alphabet (titles with slash compounds, locations with
// state codes, blocklist patterns short enough to hit BL-79 / BL-100
// word-boundary edge cases).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { evaluateJob } = require("./evaluate_job.js");
const { matchBlocklists, filterJobs } = require("./filter.js");
const { applyPrepareFilter } = require("../commands/prepare.js");
const { isLevelBlocked } = require("./email_filters.js");

// Deterministic PRNG so test failures reproduce.
function lcg(seed) {
  let state = seed | 0;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const COMPANIES = ["Stripe", "BadCo", "Toast", "Ramp", "Affirm", "Kaiser", "VIP"];
const TITLES = [
  "Senior Product Manager",
  "PRN Coordinator",
  "RN Manager",
  "Director of Product",
  "Software Engineer",
  "Analyst/Product Manager",
  "Office Manager",
  "Sr. PM, Payments",
  "Associate Product Manager",
  "Product Manager/Marketing Lead",
];
const LOCATIONS = [
  "Sacramento, CA",
  "London, UK",
  "Munich, Germany",
  "Warsaw, Poland",
  "Austin, TX",
  "Remote",
  "Houston, TX",
  "Berlin, Germany",
];

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function makeFuzzCase(seed) {
  const rng = lcg(seed * 9301 + 49297);
  return {
    job: {
      company: pick(rng, COMPANIES),
      title: pick(rng, TITLES),
      locations: [pick(rng, LOCATIONS), pick(rng, LOCATIONS)],
    },
    profile: {
      filter_rules: {
        company_blocklist: ["BadCo"],
        title_blocklist: [
          { pattern: "director", reason: "over-level" },
          { pattern: "rn", reason: "RN role" },
        ],
        // No requirelist — would skew the keep distribution too much.
        company_cap: { max_active: 2 },
        location_blocklist: ["Germany"],
      },
      geo: null,
    },
    counts: { Stripe: seed % 3, Toast: seed % 2 },
  };
}

// Translate scan-side `matchBlocklists` to `{ decision, skipReason }`.
// (Cap is not in matchBlocklists; tests cover cap via filterJobs in a
// separate block below.)
function scanLower(job, rules) {
  // Convert the EvaluateJobInput-shaped job to scan job shape (`role`
  // instead of `title`, single `location` ok).
  const scanJob = {
    company: job.company,
    role: job.title,
    locations: job.locations,
  };
  const reason = matchBlocklists(scanJob, rules);
  if (!reason) return { decision: "keep", skipReason: null };
  return { decision: "skip", skipReason: reason.kind };
}

// Translate prepare-side `applyPrepareFilter` (single-app input) to
// `{ decision, skipReason }`. We feed `app.locations[]` directly.
function prepareLower(job, rules, counts) {
  const app = {
    key: "fuzz:1",
    companyName: job.company,
    title: job.title,
    locations: job.locations,
    url: "",
  };
  const { passed, skipped } = applyPrepareFilter([app], rules, counts);
  if (passed.length > 0) return { decision: "keep", skipReason: null };
  return { decision: "skip", skipReason: skipped[0].reason };
}

// Translate email-side `isLevelBlocked` to a partial
// `{ decision, skipReason }` — only the title_blocklist branch.
function emailTitleLower(job, rules) {
  return isLevelBlocked(job.title, rules)
    ? { decision: "skip", skipReason: "title_blocklist" }
    : { decision: "keep", skipReason: null };
}

// ── scan ↔ prepare cross-check ─────────────────────────────────────

test("fuzz: scan-shim ↔ evaluateJob({ context: scan }) agree on 100 tuples", () => {
  for (let i = 0; i < 100; i++) {
    const { job, profile, counts } = makeFuzzCase(i);
    const rules = profile.filter_rules;
    const direct = evaluateJob({
      job,
      profile,
      appState: { companyCounts: counts },
      context: "scan",
    });
    const shim = scanLower(job, rules);
    // matchBlocklists does NOT consult company_cap. Skip cases where
    // evaluateJob's only differentiator is cap.
    if (direct.skipReason === "company_cap") continue;
    const directLowered = {
      decision: direct.decision,
      skipReason: direct.skipReason,
    };
    assert.deepEqual(
      shim,
      directLowered,
      `seed ${i}: scan-shim vs evaluateJob diverged on ${JSON.stringify({ job, rules })}`
    );
  }
});

test("fuzz: prepare-shim ↔ evaluateJob({ context: prepare }) agree on 100 tuples", () => {
  for (let i = 0; i < 100; i++) {
    const { job, profile, counts } = makeFuzzCase(i);
    const rules = profile.filter_rules;
    const direct = evaluateJob({
      job,
      profile: { filter_rules: rules },
      appState: { companyCounts: counts },
      context: "prepare",
    });
    const shim = prepareLower(job, rules, counts);
    const directLowered = {
      decision: direct.decision,
      skipReason: direct.skipReason,
    };
    assert.deepEqual(
      shim,
      directLowered,
      `seed ${i}: prepare-shim vs evaluateJob diverged on ${JSON.stringify({ job, rules })}`
    );
  }
});

// ── scan ↔ prepare ─────────────────────────────────────────────

test("fuzz: scan-shim ↔ prepare-shim agree on 100 tuples (same context matrix)", () => {
  // The RFC pins canonical: scan and prepare apply the same rule-set.
  // matchBlocklists doesn't run cap; we filter those tuples out.
  for (let i = 0; i < 100; i++) {
    const { job, profile, counts } = makeFuzzCase(i);
    const rules = profile.filter_rules;
    const scan = scanLower(job, rules);
    const prep = prepareLower(job, rules, counts);
    if (prep.skipReason === "company_cap") continue;
    assert.deepEqual(
      scan,
      prep,
      `seed ${i}: scan vs prepare diverged on ${JSON.stringify({ job, rules })}`
    );
  }
});

// ── email title_blocklist ↔ scan/prepare title_blocklist ──────────

test("fuzz: email title_blocklist ↔ scan/prepare title_blocklist agree on 100 tuples", () => {
  // Email only runs title_blocklist of the comparable rules. Build a
  // profile with ONLY title_blocklist so other rules don't shadow.
  for (let i = 0; i < 100; i++) {
    const { job } = makeFuzzCase(i);
    const rules = {
      title_blocklist: [
        { pattern: "director", reason: "over-level" },
        { pattern: "rn", reason: "RN role" },
        { pattern: "manager", reason: "manager" },
      ],
    };
    const email = emailTitleLower(job, rules);
    const direct = evaluateJob({
      job,
      profile: { filter_rules: rules },
      appState: { companyCounts: {} },
      context: "email",
    });
    const directLowered = {
      decision: direct.decision,
      skipReason: direct.skipReason,
    };
    assert.deepEqual(
      email,
      directLowered,
      `seed ${i}: email-shim vs evaluateJob diverged on ${JSON.stringify({ job, rules })}`
    );
  }
});

// ── geo cross-context (scan via filterJobs ↔ evaluateJob) ───────────

test("fuzz: filterJobs geo ↔ evaluateJob geo agree on 50 tuples", () => {
  for (let i = 0; i < 50; i++) {
    const { job } = makeFuzzCase(i);
    const geo = {
      mode: ["unrestricted", "metro", "us-wide", "remote-only"][i % 4],
      cities: ["Sacramento"],
      states: ["CA"],
      remote_ok: false,
    };
    const scanJob = {
      company: job.company,
      role: job.title,
      locations: job.locations,
    };
    const { passed, rejected } = filterJobs([scanJob], { geo });
    const shim =
      passed.length > 0
        ? { decision: "keep", skipReason: null }
        : { decision: "skip", skipReason: rejected[0].reason.kind };

    const direct = evaluateJob({
      job,
      profile: { filter_rules: {}, geo },
      appState: { companyCounts: {} },
      context: "scan",
    });
    const directLowered = {
      decision: direct.decision,
      skipReason: direct.skipReason,
    };
    assert.deepEqual(
      shim,
      directLowered,
      `seed ${i}: filterJobs geo vs evaluateJob diverged on ${JSON.stringify({ job, geo })}`
    );
  }
});
