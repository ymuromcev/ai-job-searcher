// BL-243 / RFC 072 — the channel exception inside evaluateJob (steps 5, 6, 7).
// Fixtures only: nothing here reads a real profile.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { evaluateJob } = require("./evaluate_job.js");
const { needsJdWorkplaceCheck } = require("./jd_workplace.js");

const ALLOW = [
  "Mexico",
  "México",
  "Ciudad de México",
  "CDMX",
  "Colombia",
  "Bogotá",
  "Medellín",
  "LATAM",
  "Latin America",
  "Brazil",
  "Brasil",
  "São Paulo",
  "Argentina",
  "Buenos Aires",
  "Chile",
  "Peru",
  "Uruguay",
  "Montevideo",
];

const BLOCKLIST = [
  "Mexico",
  "Brazil",
  "Colombia",
  "Argentina",
  "Chile",
  "Peru",
  "Uruguay",
  "Montevideo",
  "Bogota",
  "São Paulo",
  "LATAM",
  "Madrid",
  "Cyprus",
  "London",
  "Moscow",
  "EMEA",
];

const GEO = { mode: "home_state_or_remote", home_state: "CA" };
const RULES = {
  location_blocklist: BLOCKLIST,
  channel_exceptions: { ru_latam: { allow_patterns: ALLOW } },
};
const DEFAULTS = {
  salary: {
    floor: 95000,
    default: 180000,
    currency: "USD",
    by_channel: { ru_latam: { floor: 80000, default: 80000 } },
  },
};

function run(
  job,
  { rules = RULES, geo = GEO, applyDefaults = DEFAULTS, context = "prepare" } = {}
) {
  return evaluateJob({
    job: { company: "Plata", title: "Senior Product Manager", ...job },
    profile: { filter_rules: rules, geo, applyDefaults },
    appState: { companyCounts: {} },
    context,
  });
}

const PLATA = { channel: "ru_latam" };

// --- cases 19, 20, 24, 26, 28: allowed locations pass both gates -----------------

test("Plata «Mexico City» passes location_blocklist AND geo (matchedBy channel:ru_latam)", () => {
  const r = run({ ...PLATA, locations: ["Mexico City"] });
  assert.equal(r.decision, "keep");
  assert.equal(r.matched.geoMatchedBy, "channel:ru_latam");
  assert.equal(r.matched.geoResult.ok, true);
});

test("the same location from a company without the channel is still archived (main regression)", () => {
  for (const loc of ["Mexico City", "Remote, Brazil", "Bogota, Colombia", "São Paulo"]) {
    const r = run({ company: "Acme", locations: [loc] });
    assert.equal(r.decision, "skip", loc);
    assert.equal(r.skipReason, "location_blocklist", loc);
  }
  // The channel is a hint: a company row with an empty / unknown one gets nothing.
  assert.equal(run({ channel: "", locations: ["Mexico City"] }).skipReason, "location_blocklist");
  assert.equal(
    run({ channel: "latam", locations: ["Mexico City"] }).skipReason,
    "location_blocklist"
  );
  assert.equal(
    run({ channel: "RU_LATAM", locations: ["Mexico City"] }).skipReason,
    "location_blocklist"
  );
});

test("Plata «Remote, Brazil» passes", () => {
  const r = run({ ...PLATA, locations: ["Remote, Brazil"] });
  assert.equal(r.decision, "keep");
  assert.equal(r.matched.geoMatchedBy, "channel:ru_latam");
});

test("accents and cities (Ciudad de México, CDMX, Bogotá, São Paulo, Medellín, Montevideo, Buenos Aires)", () => {
  for (const loc of [
    "Ciudad de México",
    "CDMX",
    "Bogotá",
    "São Paulo",
    "Medellín",
    "Montevideo",
    "Buenos Aires",
    "Mexico City, Mexico",
    "Remote - LATAM",
    "Latin America",
  ]) {
    const r = run({ ...PLATA, locations: [loc] });
    assert.equal(r.decision, "keep", `${loc}: ${r.skipReason}`);
    assert.equal(r.matched.geoMatchedBy, "channel:ru_latam", loc);
  }
});

test("mixed locations [Mexico City, Madrid]: one fitting place is enough", () => {
  const r = run({ ...PLATA, locations: ["Mexico City", "Madrid"] });
  assert.equal(r.decision, "keep");
  assert.equal(r.matched.geoMatchedBy, "channel:ru_latam");
  // and the reverse order
  assert.equal(run({ ...PLATA, locations: ["Madrid", "Mexico City"] }).decision, "keep");
});

test("channel exception also works in scan context (filter.js path)", () => {
  const r = run({ ...PLATA, locations: ["Mexico City"] }, { context: "scan" });
  assert.equal(r.decision, "keep");
});

// --- case 25: non-LatAm places of channel companies are archived as today ---------

test("Plata / Unlimit with Cyprus, Belgrade, London, Moscow, Yerevan → archived as today", () => {
  for (const company of ["Plata", "Unlimit"]) {
    for (const loc of ["Limassol, Cyprus", "Belgrade", "London", "Moscow", "Yerevan"]) {
      const r = run({ company, ...PLATA, locations: [loc] });
      assert.equal(r.decision, "skip", `${company} ${loc}`);
      assert.match(r.skipReason, /^(location_blocklist|geo_)/, `${company} ${loc}`);
      // identical verdict to a channel-less company
      const base = run({ company: "Acme", locations: [loc] });
      assert.equal(r.skipReason, base.skipReason, `${company} ${loc}`);
    }
  }
});

test("a location without the channel hint but with a blocklisted LatAm name: nothing changes", () => {
  const r = run({ locations: ["Buenos Aires"] });
  assert.equal(r.decision, "skip");
});

test("New Mexico is a US state, never the country (no channel pass-through)", () => {
  const r = run({ ...PLATA, locations: ["Albuquerque, New Mexico"] });
  assert.equal(r.decision, "skip");
  assert.equal(r.skipReason, "geo_not_home_state_or_remote");
});

// --- case 28: the JD workplace check (BL-225) does not fire on it ----------------

test("matchedBy channel:ru_latam is not a JD-workplace-check trigger (BL-225 does not drop it)", () => {
  assert.equal(needsJdWorkplaceCheck("channel:ru_latam"), false);
  // control: the triggers of BL-225 are unchanged
  assert.equal(needsJdWorkplaceCheck("us_unspecified"), true);
});

test("geo.blocklist of the profile still wins over the channel exception", () => {
  const geo = { ...GEO, blocklist: ["Mexico"] };
  const r = run({ ...PLATA, locations: ["Mexico City"] }, { geo });
  assert.equal(r.decision, "skip");
  assert.match(r.skipReason, /^geo_/);
});

// --- case 18 / 38: no block → today's behaviour -------------------------------------

test("profile without channel_exceptions (lilia / rollback): Plata Mexico City is archived", () => {
  const rules = { location_blocklist: BLOCKLIST };
  const r = run({ ...PLATA, locations: ["Mexico City"] }, { rules });
  assert.equal(r.decision, "skip");
  assert.equal(r.skipReason, "location_blocklist");
  const r2 = run({ ...PLATA, locations: ["Remote, Brazil"] }, { rules, geo: GEO });
  assert.equal(r2.skipReason, "location_blocklist");
  // `channel_exceptions` present but another channel only
  const other = { ...rules, channel_exceptions: { other: { allow_patterns: ["Mexico"] } } };
  assert.equal(
    run({ ...PLATA, locations: ["Mexico City"] }, { rules: other }).skipReason,
    "location_blocklist"
  );
});

test("without the block, geo alone also stays strict (blocklist-free fixture)", () => {
  const rules = {};
  const r = run({ ...PLATA, locations: ["Mexico City"] }, { rules });
  assert.equal(r.decision, "skip");
  assert.equal(r.skipReason, "geo_not_home_state_or_remote");
});

test("malformed channel_exceptions never throws and gives no exception", () => {
  for (const bad of [
    null,
    [],
    "x",
    { ru_latam: null },
    { ru_latam: { allow_patterns: "Mexico" } },
  ]) {
    const rules = { location_blocklist: BLOCKLIST, channel_exceptions: bad };
    const r = run({ ...PLATA, locations: ["Mexico City"] }, { rules });
    assert.equal(r.decision, "skip");
  }
});

// --- cases 31-37: salary floor by channel (step 6) ---------------------------------

const US_LOC = { locations: ["Remote - US"] };

test("ru_latam 85–90k stays: the channel floor is 80000", () => {
  const r = run({ ...PLATA, ...US_LOC, published_salary: { min: 85000, max: 90000 } });
  assert.equal(r.decision, "keep");
});

test("ru_latam 60–75k → salary_below_floor, floor 80000", () => {
  const r = run({ ...PLATA, ...US_LOC, published_salary: { min: 60000, max: 75000 } });
  assert.equal(r.decision, "skip");
  assert.equal(r.skipReason, "salary_below_floor");
  assert.equal(r.matched.floor, 80000);
  assert.equal(r.matched.top, 75000);
});

test("ru_latam 70–90k passes (top 90k ≥ 80k)", () => {
  const r = run({ ...PLATA, ...US_LOC, published_salary: { min: 70000, max: 90000 } });
  assert.equal(r.decision, "keep");
});

test("not ru_latam with 85k top → salary_below_floor by the general floor 95000", () => {
  const r = run({ company: "Acme", ...US_LOC, published_salary: { min: 70000, max: 85000 } });
  assert.equal(r.decision, "skip");
  assert.equal(r.skipReason, "salary_below_floor");
  assert.equal(r.matched.floor, 95000);
});

test("rollback: no by_channel → the channel company uses the general floor", () => {
  const applyDefaults = { salary: { floor: 95000, default: 180000, currency: "USD" } };
  const r = run(
    { ...PLATA, ...US_LOC, published_salary: { min: 85000, max: 90000 } },
    { applyDefaults }
  );
  assert.equal(r.decision, "skip");
  assert.equal(r.matched.floor, 95000);
});

test("by_channel for another channel or broken shape → general floor, no throw", () => {
  for (const by_channel of [
    { other: { floor: 10000 } },
    { ru_latam: null },
    { ru_latam: { floor: "x" } },
    [],
  ]) {
    const applyDefaults = {
      salary: { floor: 95000, default: 180000, currency: "USD", by_channel },
    };
    const r = run(
      { ...PLATA, ...US_LOC, published_salary: { min: 85000, max: 90000 } },
      { applyDefaults }
    );
    assert.equal(r.skipReason, "salary_below_floor");
    assert.equal(r.matched.floor, 95000);
  }
});
