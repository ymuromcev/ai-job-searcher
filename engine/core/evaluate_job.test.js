// RFC 040 / BL-92 — unit tests for `evaluateJob`.
// Coverage: one row per (rule × context × decision). Plus an enum
// guard fuzz that asserts every emitted `skipReason` ∈
// `ENGINE_SKIP_REASONS` ∪ `{null}`.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { evaluateJob } = require("./evaluate_job.js");
const { isEngineSkipReason } = require("./skip_reasons.js");

const CONTEXTS = ["scan", "prepare", "email"];

function profileWith(filterRules = {}, geo = null) {
  return { filter_rules: filterRules, geo };
}

function jobOf(overrides = {}) {
  return {
    company: "Stripe",
    title: "Senior Product Manager",
    locations: ["San Francisco, CA"],
    url: "https://example.com/job/1",
    source: "greenhouse",
    ...overrides,
  };
}

// ── company_blocklist (3 contexts × keep/skip = 6) ─────────────────

for (const ctx of CONTEXTS) {
  test(`company_blocklist × ${ctx} × skip`, () => {
    const result = evaluateJob({
      job: jobOf({ company: "BadCo" }),
      profile: profileWith({ company_blocklist: ["BadCo"] }),
      appState: { companyCounts: {} },
      context: ctx,
    });
    assert.equal(result.decision, "skip");
    assert.equal(result.skipReason, "company_blocklist");
    assert.equal(result.matched.rule, "company_blocklist");
    assert.equal(result.matched.company, "BadCo");
  });

  test(`company_blocklist × ${ctx} × keep`, () => {
    const result = evaluateJob({
      job: jobOf({ company: "GoodCo" }),
      profile: profileWith({ company_blocklist: ["BadCo"] }),
      appState: { companyCounts: {} },
      context: ctx,
    });
    assert.equal(result.decision, "keep");
    assert.equal(result.skipReason, null);
  });
}

test("company_blocklist: case-insensitive", () => {
  for (const variant of ["BADCO", "badco", "BadCo"]) {
    const result = evaluateJob({
      job: jobOf({ company: variant }),
      profile: profileWith({ company_blocklist: ["BadCo"] }),
      appState: { companyCounts: {} },
      context: "scan",
    });
    assert.equal(result.decision, "skip");
    assert.equal(result.skipReason, "company_blocklist");
  }
});

test("company_blocklist: tolerates {name,reason} objects (defensive)", () => {
  const result = evaluateJob({
    job: jobOf({ company: "Toast" }),
    profile: profileWith({
      company_blocklist: [{ name: "Toast", reason: "Not fintech" }],
    }),
    appState: { companyCounts: {} },
    context: "scan",
  });
  assert.equal(result.decision, "skip");
  assert.equal(result.skipReason, "company_blocklist");
});

// ── title_blocklist (3 contexts × keep/skip + word-boundary + slash) ─

for (const ctx of CONTEXTS) {
  test(`title_blocklist × ${ctx} × skip ("Office Manager" matches "manager")`, () => {
    const result = evaluateJob({
      job: jobOf({ title: "Office Manager" }),
      profile: profileWith({
        title_blocklist: [{ pattern: "manager", reason: "managerial" }],
      }),
      appState: { companyCounts: {} },
      context: ctx,
    });
    assert.equal(result.decision, "skip");
    assert.equal(result.skipReason, "title_blocklist");
    assert.equal(result.matched.pattern, "manager");
    assert.equal(result.matched.reason, "managerial");
  });

  test(`title_blocklist × ${ctx} × keep ("PRN Coordinator" with "rn" is word-boundary safe)`, () => {
    const result = evaluateJob({
      job: jobOf({ title: "PRN Coordinator" }),
      profile: profileWith({
        title_blocklist: [{ pattern: "rn", reason: "RN role" }],
      }),
      appState: { companyCounts: {} },
      context: ctx,
    });
    assert.equal(result.decision, "keep");
    assert.equal(result.skipReason, null);
  });
}

test("title_blocklist: slash-compound — clean part keeps title", () => {
  const result = evaluateJob({
    job: jobOf({ title: "Product Manager/Marketing Lead" }),
    profile: profileWith({
      title_blocklist: [{ pattern: "marketing", reason: "not PM" }],
    }),
    appState: { companyCounts: {} },
    context: "prepare",
  });
  assert.equal(result.decision, "keep");
});

test("title_blocklist: slash-compound — all parts blocked → skip", () => {
  const result = evaluateJob({
    job: jobOf({ title: "Senior Manager/Director" }),
    profile: profileWith({
      title_blocklist: [
        { pattern: "manager", reason: "managerial" },
        { pattern: "director", reason: "too senior" },
      ],
    }),
    appState: { companyCounts: {} },
    context: "prepare",
  });
  assert.equal(result.decision, "skip");
  assert.equal(result.skipReason, "title_blocklist");
});

test("title_blocklist: standalone RN matches in email context (word-boundary)", () => {
  const result = evaluateJob({
    job: jobOf({ title: "RN Manager" }),
    profile: profileWith({
      title_blocklist: [{ pattern: "rn", reason: "RN role" }],
    }),
    appState: { companyCounts: {} },
    context: "email",
  });
  assert.equal(result.decision, "skip");
  assert.equal(result.skipReason, "title_blocklist");
});

// ── title_requirelist (scan/prepare × keep/skip + slash + skipped in email) ─

for (const ctx of ["scan", "prepare"]) {
  test(`title_requirelist × ${ctx} × skip (SWE missing PM)`, () => {
    const result = evaluateJob({
      job: jobOf({ title: "Senior Software Engineer" }),
      profile: profileWith({
        title_requirelist: [{ pattern: "product manager", reason: "PM" }],
      }),
      appState: { companyCounts: {} },
      context: ctx,
    });
    assert.equal(result.decision, "skip");
    assert.equal(result.skipReason, "title_requirelist");
  });

  test(`title_requirelist × ${ctx} × keep (PM matches)`, () => {
    const result = evaluateJob({
      job: jobOf({ title: "Senior Product Manager" }),
      profile: profileWith({
        title_requirelist: [{ pattern: "product manager", reason: "PM" }],
      }),
      appState: { companyCounts: {} },
      context: ctx,
    });
    assert.equal(result.decision, "keep");
  });
}

test("title_requirelist × email: SKIPPED (context matrix)", () => {
  // Email never enforces title_requirelist — emails are about already-
  // known pipeline rows, not surfacing decisions.
  const result = evaluateJob({
    job: jobOf({ title: "Senior Software Engineer" }),
    profile: profileWith({
      title_requirelist: [{ pattern: "product manager", reason: "PM" }],
    }),
    appState: { companyCounts: {} },
    context: "email",
  });
  assert.equal(result.decision, "keep");
});

test("title_requirelist: slash-compound — one PM part passes", () => {
  const result = evaluateJob({
    job: jobOf({ title: "Analyst/Product Manager" }),
    profile: profileWith({
      title_requirelist: [{ pattern: "product manager", reason: "PM" }],
    }),
    appState: { companyCounts: {} },
    context: "scan",
  });
  assert.equal(result.decision, "keep");
});

test("title_requirelist: slash-compound — no PM part → skip", () => {
  const result = evaluateJob({
    job: jobOf({ title: "Software Engineer/DevOps" }),
    profile: profileWith({
      title_requirelist: [{ pattern: "product manager", reason: "PM" }],
    }),
    appState: { companyCounts: {} },
    context: "scan",
  });
  assert.equal(result.decision, "skip");
  assert.equal(result.skipReason, "title_requirelist");
});

// ── company_cap (scan/prepare × under/at/override + skipped in email) ─

for (const ctx of ["scan", "prepare"]) {
  test(`company_cap × ${ctx} × under-cap keeps`, () => {
    const result = evaluateJob({
      job: jobOf({ company: "Stripe" }),
      profile: profileWith({ company_cap: { max_active: 3 } }),
      appState: { companyCounts: { Stripe: 1 } },
      context: ctx,
    });
    assert.equal(result.decision, "keep");
  });

  test(`company_cap × ${ctx} × at-cap skips + appState not mutated`, () => {
    const counts = { Stripe: 3 };
    const result = evaluateJob({
      job: jobOf({ company: "Stripe" }),
      profile: profileWith({ company_cap: { max_active: 3 } }),
      appState: { companyCounts: counts },
      context: ctx,
    });
    assert.equal(result.decision, "skip");
    assert.equal(result.skipReason, "company_cap");
    assert.equal(result.matched.cap, 3);
    assert.equal(result.matched.current, 3);
    // appState mutation guard
    assert.deepEqual(counts, { Stripe: 3 });
  });

  test(`company_cap × ${ctx} × override raises limit`, () => {
    const result = evaluateJob({
      job: jobOf({ company: "Stripe" }),
      profile: profileWith({
        company_cap: { max_active: 1, overrides: { Stripe: 5 } },
      }),
      appState: { companyCounts: { Stripe: 3 } },
      context: ctx,
    });
    assert.equal(result.decision, "keep");
  });
}

test("company_cap × email: SKIPPED (context matrix)", () => {
  const result = evaluateJob({
    job: jobOf({ company: "Stripe" }),
    profile: profileWith({ company_cap: { max_active: 1 } }),
    appState: { companyCounts: { Stripe: 5 } },
    context: "email",
  });
  // Cap is skipped in email context — row passes.
  assert.equal(result.decision, "keep");
});

// ── location_blocklist (scan/prepare × BL-24 fixture + skipped in email) ─

for (const ctx of ["scan", "prepare"]) {
  test(`location_blocklist × ${ctx} × skip (Berlin only, no US marker)`, () => {
    const result = evaluateJob({
      job: jobOf({ locations: ["Berlin, Germany"] }),
      profile: profileWith({ location_blocklist: ["Berlin"] }),
      appState: { companyCounts: {} },
      context: ctx,
    });
    assert.equal(result.decision, "skip");
    assert.equal(result.skipReason, "location_blocklist");
    assert.equal(result.matched.match, "Berlin");
  });

  test(`location_blocklist × ${ctx} × keep (BL-24: US marker in any element wins)`, () => {
    const result = evaluateJob({
      job: jobOf({ locations: ["Berlin, DE", ", US"] }),
      profile: profileWith({ location_blocklist: ["Berlin"] }),
      appState: { companyCounts: {} },
      context: ctx,
    });
    assert.equal(result.decision, "keep");
    assert.equal(result.skipReason, null);
  });
}

test("location_blocklist × email: SKIPPED (never runs on email locations)", () => {
  const result = evaluateJob({
    job: { company: "X", title: "PM", locations: ["Berlin, Germany"] },
    profile: profileWith({ location_blocklist: ["Berlin"] }),
    appState: { companyCounts: {} },
    context: "email",
  });
  assert.equal(result.decision, "keep");
});

test("location_blocklist: BL-24 — US state code wins", () => {
  const result = evaluateJob({
    job: jobOf({ locations: ["Warsaw, Poland", "Sacramento, CA"] }),
    profile: profileWith({ location_blocklist: ["Poland"] }),
    appState: { companyCounts: {} },
    context: "scan",
  });
  assert.equal(result.decision, "keep");
});

// ── geo (scan/prepare × modes × match/miss; skipped in email) ─

const LILIA_GEO = {
  mode: "metro",
  cities: ["Sacramento"],
  states: ["CA"],
  remote_ok: false,
  blocklist: [],
};

for (const ctx of ["scan", "prepare"]) {
  test(`geo metro × ${ctx} × match`, () => {
    const result = evaluateJob({
      job: jobOf({ locations: ["Sacramento, CA"] }),
      profile: { filter_rules: {}, geo: LILIA_GEO },
      appState: { companyCounts: {} },
      context: ctx,
    });
    assert.equal(result.decision, "keep");
    assert.ok(result.matched.geoMatchedBy);
  });

  test(`geo metro × ${ctx} × miss → geo_metro_miss`, () => {
    const result = evaluateJob({
      job: jobOf({ locations: ["Houston, TX"] }),
      profile: { filter_rules: {}, geo: LILIA_GEO },
      appState: { companyCounts: {} },
      context: ctx,
    });
    assert.equal(result.decision, "skip");
    assert.equal(result.skipReason, "geo_metro_miss");
    assert.equal(result.matched.mode, "metro");
  });

  test(`geo us-wide × ${ctx} × match`, () => {
    const result = evaluateJob({
      job: jobOf({ locations: ["Austin, TX"] }),
      profile: { filter_rules: {}, geo: { mode: "us-wide" } },
      appState: { companyCounts: {} },
      context: ctx,
    });
    assert.equal(result.decision, "keep");
  });

  test(`geo us-wide × ${ctx} × miss → geo_country_miss`, () => {
    const result = evaluateJob({
      job: jobOf({ locations: ["London, UK"] }),
      profile: { filter_rules: {}, geo: { mode: "us-wide" } },
      appState: { companyCounts: {} },
      context: ctx,
    });
    assert.equal(result.decision, "skip");
    assert.equal(result.skipReason, "geo_country_miss");
  });

  test(`geo remote-only × ${ctx} × match`, () => {
    const result = evaluateJob({
      job: jobOf({ locations: ["Remote"] }),
      profile: { filter_rules: {}, geo: { mode: "remote-only" } },
      appState: { companyCounts: {} },
      context: ctx,
    });
    assert.equal(result.decision, "keep");
  });

  test(`geo remote-only × ${ctx} × miss → geo_remote_only_miss`, () => {
    const result = evaluateJob({
      job: jobOf({ locations: ["Austin, TX"] }),
      profile: { filter_rules: {}, geo: { mode: "remote-only" } },
      appState: { companyCounts: {} },
      context: ctx,
    });
    assert.equal(result.decision, "skip");
    assert.equal(result.skipReason, "geo_remote_only_miss");
  });

  test(`geo unrestricted × ${ctx} × keep`, () => {
    const result = evaluateJob({
      job: jobOf({ locations: ["Munich, Germany"] }),
      profile: { filter_rules: {}, geo: { mode: "unrestricted" } },
      appState: { companyCounts: {} },
      context: ctx,
    });
    assert.equal(result.decision, "keep");
  });

  test(`geo empty locations × ${ctx} × geo_no_location in restrictive mode`, () => {
    const result = evaluateJob({
      job: jobOf({ locations: [] }),
      profile: { filter_rules: {}, geo: LILIA_GEO },
      appState: { companyCounts: {} },
      context: ctx,
    });
    assert.equal(result.decision, "skip");
    assert.equal(result.skipReason, "geo_no_location");
  });
}

test("geo × email: SKIPPED entirely (context matrix)", () => {
  // Even with a profile.geo that would normally reject, email context
  // does not run geo at all.
  const result = evaluateJob({
    job: jobOf({ locations: ["London, UK"] }),
    profile: { filter_rules: {}, geo: LILIA_GEO },
    appState: { companyCounts: {} },
    context: "email",
  });
  assert.equal(result.decision, "keep");
});

test("geo unknown-mode → geo_unknown_mode skip", () => {
  const result = evaluateJob({
    job: jobOf({ locations: ["Sacramento, CA"] }),
    profile: { filter_rules: {}, geo: { mode: "lunar-colony" } },
    appState: { companyCounts: {} },
    context: "scan",
  });
  assert.equal(result.decision, "skip");
  assert.equal(result.skipReason, "geo_unknown_mode");
});

test("geo: matched.geoResult cached on keep (BL-102)", () => {
  const result = evaluateJob({
    job: jobOf({ locations: ["Sacramento, CA"] }),
    profile: { filter_rules: {}, geo: LILIA_GEO },
    appState: { companyCounts: {} },
    context: "prepare",
  });
  assert.equal(result.decision, "keep");
  assert.ok(result.matched.geoResult);
  assert.equal(result.matched.geoResult.ok, true);
  assert.ok(result.matched.geoResult.matchedBy);
});

// ── Decision pipeline order ───────────────────────────────────────

test("pipeline order: company_blocklist fires before title_requirelist", () => {
  const result = evaluateJob({
    job: jobOf({ company: "BadCo", title: "Software Engineer" }),
    profile: profileWith({
      company_blocklist: ["BadCo"],
      title_requirelist: [{ pattern: "product manager" }],
    }),
    appState: { companyCounts: {} },
    context: "scan",
  });
  assert.equal(result.skipReason, "company_blocklist");
});

test("pipeline order: title_requirelist fires before title_blocklist", () => {
  const result = evaluateJob({
    job: jobOf({ title: "Senior Software Engineer" }),
    profile: profileWith({
      title_requirelist: [{ pattern: "product manager" }],
      title_blocklist: [{ pattern: "senior", reason: "over-level" }],
    }),
    appState: { companyCounts: {} },
    context: "scan",
  });
  assert.equal(result.skipReason, "title_requirelist");
});

// ── Legacy single-string location compat ──────────────────────────

test("normalizeJob: single-string `location` is wrapped to locations[]", () => {
  // Use Germany (not "DE" — `DE` collides with Delaware US state code in
  // the hasUsMarker check, by design).
  const result = evaluateJob({
    job: { company: "X", title: "PM", location: "Berlin, Germany" },
    profile: profileWith({ location_blocklist: ["Berlin"] }),
    appState: { companyCounts: {} },
    context: "scan",
  });
  assert.equal(result.skipReason, "location_blocklist");
});

// ── Enum guard: fuzz 200 random tuples per context ────────────────

function randomString(seed, alphabet) {
  let s = "";
  let n = seed;
  for (let i = 0; i < 4 + (seed % 6); i++) {
    n = (n * 1103515245 + 12345) & 0x7fffffff;
    s += alphabet[n % alphabet.length];
  }
  return s;
}

const NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ ,.";
const LOC_TOKENS = [
  "Sacramento, CA",
  "London, UK",
  "Munich, Germany",
  "Berlin, DE",
  "Austin, TX",
  "Remote",
  "Anywhere",
  "Houston, TX",
  ", US",
  "",
];
const TITLE_TOKENS = [
  "Senior Product Manager",
  "PRN Coordinator",
  "RN Manager",
  "Director of Product",
  "Software Engineer",
  "Analyst/Product Manager",
  "Office Manager",
  "Sr. PM, Payments",
];
const COMPANY_TOKENS = ["Stripe", "BadCo", "Toast", "Ramp", "Affirm"];
const MODES = ["unrestricted", "metro", "us-wide", "remote-only", "lunar-colony"];

function fuzzInput(seed) {
  const pick = (arr, n) => arr[((seed * (n + 17)) >>> 0) % arr.length];
  const locA = pick(LOC_TOKENS, 1);
  const locB = pick(LOC_TOKENS, 2);
  return {
    job: {
      company: pick(COMPANY_TOKENS, 0),
      title: pick(TITLE_TOKENS, 3),
      locations: [locA, locB].filter(Boolean),
    },
    profile: {
      filter_rules: {
        company_blocklist: ["BadCo"],
        title_blocklist: [{ pattern: "director", reason: "x" }, { pattern: "rn", reason: "y" }],
        title_requirelist: [{ pattern: "product manager" }, { pattern: "PM" }],
        company_cap: { max_active: 2 },
        location_blocklist: ["Germany"],
      },
      geo: { mode: pick(MODES, 4), cities: ["Sacramento"], states: ["CA"] },
    },
    appState: { companyCounts: { Stripe: seed % 4 } },
  };
}

for (const ctx of CONTEXTS) {
  test(`enum guard: 200 fuzz inputs × ${ctx} → skipReason ∈ ENGINE_SKIP_REASONS ∪ {null}`, () => {
    for (let i = 0; i < 200; i++) {
      const input = fuzzInput(i);
      const result = evaluateJob({ ...input, context: ctx });
      if (result.decision === "keep") {
        assert.equal(result.skipReason, null);
      } else {
        assert.equal(typeof result.skipReason, "string");
        assert.ok(
          isEngineSkipReason(result.skipReason),
          `seed ${i} ctx ${ctx}: ${result.skipReason} not in enum`
        );
      }
    }
  });
}

// ── Invalid context throws ───────────────────────────────────────

test("throws on invalid context", () => {
  assert.throws(
    () =>
      evaluateJob({
        job: jobOf(),
        profile: profileWith(),
        appState: { companyCounts: {} },
        context: "bogus",
      }),
    /context must be/
  );
});
