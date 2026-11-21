// BL-243 / RFC 072 — apply queue: AI first inside one fit; channel in the geo net.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildQueue } = require("./queue.js");
const { buildChannelIndex } = require("../../core/company_channel.js");
const { buildActiveCounts } = require("../../commands/prepare.js");

const NOW = new Date("2026-10-21T12:00:00Z");
const PRIORITY = {
  ai_title_patterns: ["AI", "GenAI", "Generative", "LLM", "Agentic", "Machine Learning"],
  ai_track_ids: ["ai_roles"],
  ai_companies: ["Anthropic"],
};
const WITH_AI = { company_cap: { max_active: 3, window_days: 30 }, apply_priority: PRIORITY };
const NO_AI = { company_cap: { max_active: 3, window_days: 30 } };

let seq = 0;
function row(over) {
  seq += 1;
  return {
    key: over.key,
    companyName: over.companyName || `Co${seq}`,
    title: "Product Manager",
    status: "To Apply",
    fit_score: "Strong",
    applied_date: "",
    apply_state: "",
    apply_note: "",
    createdAt: "2026-10-20T00:00:00Z",
    updatedAt: "2026-10-20T00:00:00Z",
    ...over,
  };
}
const q = (apps, extra = {}) =>
  buildQueue(apps, { filterRules: WITH_AI, buildActiveCounts, windowDays: 30, now: NOW, ...extra });
const keys = (r) => r.queue.map((a) => a.key);

// case 1
test("Strong non-AI, Strong AI, Medium AI, Weak AI → Strong AI, Strong non-AI, Medium AI, Weak AI", () => {
  const apps = [
    row({ key: "s-plain", fit_score: "Strong", title: "Product Manager" }),
    row({ key: "s-ai", fit_score: "Strong", title: "AI Product Manager" }),
    row({ key: "m-ai", fit_score: "Medium", title: "GenAI Product Manager" }),
    row({ key: "w-ai", fit_score: "Weak", title: "LLM Product Manager" }),
  ];
  assert.deepEqual(keys(q(apps)), ["s-ai", "s-plain", "m-ai", "w-ai"]);
});

test("fit still beats AI: Strong non-AI goes before Medium AI (owner: «1. Мэтч 2. ИИ»)", () => {
  const apps = [
    row({ key: "m-ai", fit_score: "Medium", title: "AI Product Manager" }),
    row({ key: "s-plain", fit_score: "Strong", title: "Product Manager" }),
    row({ key: "m-plain", fit_score: "Medium", title: "Product Manager" }),
  ];
  assert.deepEqual(keys(q(apps)), ["s-plain", "m-ai", "m-plain"]);
});

test("at equal fit and equal AI-ness the old order stays: newest first, no createdAt last", () => {
  const at = (d) => `2026-10-${d}T00:00:00Z`;
  const apps = [
    row({ key: "plain-old", title: "Product Manager", createdAt: at("01") }),
    row({ key: "ai-old", title: "AI Product Manager", createdAt: at("02") }),
    row({ key: "plain-new", title: "Product Manager", createdAt: at("19") }),
    row({ key: "ai-new", title: "AI PM", createdAt: at("18") }),
    row({ key: "plain-nodate", title: "Product Manager", createdAt: "" }),
    row({ key: "ai-nodate", title: "Machine Learning PM", createdAt: "" }),
  ];
  assert.deepEqual(keys(q(apps)), [
    "ai-new",
    "ai-old",
    "ai-nodate",
    "plain-new",
    "plain-old",
    "plain-nodate",
  ]);
});

test("an AI company makes its rows AI even with a plain title", () => {
  const apps = [
    row({ key: "plain", title: "Product Manager", companyName: "Acme" }),
    row({ key: "lab", title: "Product Manager", companyName: "Anthropic" }),
  ];
  assert.deepEqual(keys(q(apps)), ["lab", "plain"]);
});

// case 8
test("no apply_priority → exactly today's order (rollback / lilia)", () => {
  const apps = [
    row({ key: "plain-new", title: "Product Manager", createdAt: "2026-10-20T00:00:00Z" }),
    row({ key: "ai-old", title: "AI Product Manager", createdAt: "2026-10-01T00:00:00Z" }),
    row({ key: "m-ai", fit_score: "Medium", title: "AI Product Manager" }),
  ];
  assert.deepEqual(keys(q(apps, { filterRules: NO_AI })), ["plain-new", "ai-old", "m-ai"]);
  assert.deepEqual(keys(q(apps, { filterRules: {} })), ["plain-new", "ai-old", "m-ai"]);
  // and with the block the AI row jumps ahead inside the fit
  assert.deepEqual(keys(q(apps)), ["ai-old", "plain-new", "m-ai"]);
});

// case 9
test("--limit N: AI rows push non-AI rows of the same fit out → over_limit, they stay To Apply", () => {
  const apps = [
    row({ key: "plain-1", title: "Product Manager", createdAt: "2026-10-20T00:00:00Z" }),
    row({ key: "plain-2", title: "Product Manager", createdAt: "2026-10-19T00:00:00Z" }),
    row({ key: "ai-1", title: "AI Product Manager", createdAt: "2026-10-01T00:00:00Z" }),
    row({ key: "ai-2", title: "Generative AI PM", createdAt: "2026-10-02T00:00:00Z" }),
  ];
  const r = q(apps, { limit: 2 });
  assert.deepEqual(keys(r), ["ai-2", "ai-1"]);
  const over = r.skipped
    .filter((s) => s.reason === "over_limit")
    .map((s) => s.key)
    .sort();
  assert.deepEqual(over, ["plain-1", "plain-2"]);
  // over_limit is not an archive decision: the row stays To Apply
  assert.equal(
    r.skipped.some((s) => s.archive),
    false
  );
  for (const a of apps) assert.equal(a.status, "To Apply");
});

// case 10
test("company cap: sorted before the cap, a company's AI rows take its slots first", () => {
  const apps = [
    row({
      key: "p1",
      companyName: "Acme",
      title: "Product Manager",
      createdAt: "2026-10-20T00:00:00Z",
    }),
    row({
      key: "p2",
      companyName: "Acme",
      title: "Product Manager",
      createdAt: "2026-10-19T00:00:00Z",
    }),
    row({
      key: "a1",
      companyName: "Acme",
      title: "AI Product Manager",
      createdAt: "2026-10-01T00:00:00Z",
    }),
    row({
      key: "a2",
      companyName: "Acme",
      title: "LLM Product Manager",
      createdAt: "2026-10-02T00:00:00Z",
    }),
  ];
  const r = q(apps, {
    filterRules: { ...WITH_AI, company_cap: { max_active: 2, window_days: 30 } },
  });
  assert.deepEqual(keys(r), ["a2", "a1"]);
  const capped = r.skipped
    .filter((s) => s.reason === "company_cap")
    .map((s) => s.key)
    .sort();
  assert.deepEqual(capped, ["p1", "p2"]);
  // without the block the newest two win, as before
  const old = q(apps, { filterRules: { company_cap: { max_active: 2, window_days: 30 } } });
  assert.deepEqual(keys(old), ["p1", "p2"]);
});

test("a bad pattern in apply_priority warns through opts.warn and the queue still builds", () => {
  const warnings = [];
  const r = q([row({ key: "x", title: "LLM PM" }), row({ key: "y", title: "PM" })], {
    filterRules: { ...WITH_AI, apply_priority: { ai_title_patterns: ["(bad", "LLM"] } },
    warn: (m) => warnings.push(m),
  });
  assert.equal(warnings.length, 1);
  assert.deepEqual(keys(r), ["x", "y"]);
});

// case 30 (queue half): channel in the geo safety net
const GEO = { mode: "home_state_or_remote", home_state: "CA" };
const LATAM_RULES = {
  ...WITH_AI,
  channel_exceptions: { ru_latam: { allow_patterns: ["Mexico", "Brazil", "LATAM"] } },
};
const INDEX = buildChannelIndex([{ name: "Plata", extra: { channel: "ru_latam" } }]);

test("queue geo net: Plata «Mexico City» stays in the queue (no archive:true)", () => {
  const apps = [row({ key: "pl", companyName: "Plata", locations: ["Mexico City"] })];
  const r = q(apps, { filterRules: LATAM_RULES, profileGeo: GEO, channelIndex: INDEX });
  assert.deepEqual(keys(r), ["pl"]);
  assert.equal(r.skipped.length, 0);
});

test("queue geo net: a company without the channel with Mexico City is archived as today", () => {
  const apps = [row({ key: "ac", companyName: "Acme", locations: ["Mexico City"] })];
  const r = q(apps, { filterRules: LATAM_RULES, profileGeo: GEO, channelIndex: INDEX });
  assert.deepEqual(keys(r), []);
  assert.equal(r.skipped[0].archive, true);
  assert.equal(r.skipped[0].reason, "geo_not_home_state_or_remote");
});

test("queue geo net: Plata with Cyprus / London is archived; no index or no block = as today", () => {
  const apps = [
    row({ key: "cy", companyName: "Plata", locations: ["Limassol, Cyprus"] }),
    row({ key: "ldn", companyName: "Plata", locations: ["London"] }),
  ];
  const r = q(apps, { filterRules: LATAM_RULES, profileGeo: GEO, channelIndex: INDEX });
  assert.deepEqual(keys(r), []);
  assert.equal(r.skipped.filter((s) => s.archive).length, 2);
  const mex = [row({ key: "pl", companyName: "Plata", locations: ["Mexico City"] })];
  // no channelIndex passed
  assert.equal(q(mex, { filterRules: LATAM_RULES, profileGeo: GEO }).skipped[0].archive, true);
  // no channel_exceptions block (rollback / lilia)
  assert.equal(
    q(mex, { filterRules: WITH_AI, profileGeo: GEO, channelIndex: INDEX }).skipped[0].archive,
    true
  );
});
