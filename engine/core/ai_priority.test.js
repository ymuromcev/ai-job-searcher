// BL-243 / RFC 072 — isAi(): what counts as an AI vacancy (profile data).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildIsAi } = require("./ai_priority.js");

const RULES = {
  apply_priority: {
    ai_title_patterns: ["AI", "GenAI", "Generative", "LLM", "Agentic", "Machine Learning"],
    ai_track_ids: ["ai_roles"],
    ai_companies: ["Anthropic", "OpenAI", "Cohere"],
  },
  role_targets: {
    tracks: [
      { id: "pm", patterns: [{ pattern: "product manager" }, { pattern: "PM" }] },
      {
        id: "ai_roles",
        patterns: [
          { pattern: "AI Strategy", reason: "x" },
          { pattern: "AI Program Manager" },
          { pattern: "AI Adoption" },
        ],
      },
    ],
  },
};

const isAi = buildIsAi(RULES, { warn: () => {} });
const t = (title, companyName = "Acme") => isAi({ title, companyName });

// case 2
test("false friends are not AI: Sustainability, Supply Chain, Retail, Maintenance, Email Automation, Thailand, Dubai, Hawaii", () => {
  for (const title of [
    "Sustainability Product Manager",
    "Supply Chain Product Manager",
    "Retail Product Manager",
    "Maintenance Product Manager",
    "Email Automation Product Manager",
    "Product Manager, Thailand",
    "Product Manager - Dubai",
    "Product Manager (Hawaii)",
    "Senior Product Manager, Payments",
    "Said Product Manager",
  ]) {
    assert.equal(t(title), false, title);
  }
});

// case 3
test("case and separators: Ai, genAI, llm, AI-native, «PM, AI/ML», (AI)", () => {
  for (const title of [
    "Ai Product Manager",
    "genAI Product Manager",
    "Product Manager, llm Platform",
    "AI-native PM",
    "PM, AI/ML",
    "Product Manager (AI)",
    "AI Product Manager",
    "Senior Product Manager – AI",
    "Agentic Workflows PM",
    "Generative AI Product Manager",
    "Product Manager, Machine Learning",
  ]) {
    assert.equal(t(title), true, title);
  }
});

// case 4
test("«OpenAI» / «Claude Code» in the title are not AI; an AI company is — through profile data", () => {
  assert.equal(t("Product Manager, OpenAI Integrations"), false);
  assert.equal(t("Product Manager, Claude Code"), false);
  assert.equal(t("Product Manager", "Anthropic"), true);
  assert.equal(t("Product Manager", "  anthropic  "), true);
  assert.equal(t("Product Manager", "Cohere, Inc."), true);
  // exact company name, never a prefix or a substring
  assert.equal(t("Product Manager", "Anthropic Wellness"), false);
  assert.equal(t("Product Manager", "Open"), false);
  // no company list → the company alone makes nothing AI
  const noCompanies = buildIsAi(
    { apply_priority: { ai_title_patterns: ["AI"] } },
    { warn: () => {} }
  );
  assert.equal(noCompanies({ title: "Product Manager", companyName: "Anthropic" }), false);
});

// case 5
test("«AI Platform PM», «Responsible AI PM», «Machine Learning PM» count as AI (RFC 072)", () => {
  assert.equal(t("AI Platform PM"), true);
  assert.equal(t("Responsible AI PM"), true);
  assert.equal(t("Machine Learning PM"), true);
});

test("ai_roles track patterns count (word boundaries); other tracks do not", () => {
  assert.equal(t("AI Strategy Lead"), true);
  assert.equal(t("Head of AI Adoption"), true);
  assert.equal(t("Senior AI Program Manager"), true);
  // `pm` track is not listed in ai_track_ids
  assert.equal(t("Product Manager, Payments"), false);
  // a track-only AI title (no ai_title_patterns match on its own)
  const onlyTrack = buildIsAi(
    { ...RULES, apply_priority: { ai_track_ids: ["ai_roles"] } },
    { warn: () => {} }
  );
  assert.equal(onlyTrack({ title: "Head of AI Adoption" }), true);
  assert.equal(onlyTrack({ title: "Product Manager" }), false);
  assert.equal(onlyTrack({ title: "AI Strategyx" }), false);
});

// case 6
test("empty / null / missing title → not AI, no throw", () => {
  for (const app of [
    { title: "" },
    { title: null },
    { title: undefined },
    {},
    null,
    undefined,
    { title: "   " },
  ]) {
    assert.equal(isAi(app), false);
  }
  // a missing title does not hide an AI company
  assert.equal(isAi({ title: "", companyName: "Anthropic" }), true);
});

// case 7
test("a broken regex in ai_title_patterns warns, is skipped, the rest still works", () => {
  const warnings = [];
  const f = buildIsAi(
    { apply_priority: { ai_title_patterns: ["(unclosed", "[bad", "LLM", 5, null, ""] } },
    { warn: (m) => warnings.push(m) }
  );
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /\(unclosed/);
  assert.match(warnings[1], /\[bad/);
  assert.equal(f({ title: "LLM Product Manager" }), true);
  assert.equal(f({ title: "Product Manager" }), false);
});

// case 8
test("no apply_priority block (lilia, rollback) → never AI", () => {
  for (const rules of [
    {},
    null,
    undefined,
    { apply_priority: null },
    { apply_priority: [] },
    { apply_priority: "x" },
    { apply_priority: {} },
    { apply_priority: { ai_title_patterns: "AI" } },
  ]) {
    const f = buildIsAi(rules, { warn: () => {} });
    assert.equal(f({ title: "AI Product Manager", companyName: "Anthropic" }), false);
  }
});

test("a pattern with regex syntax is honoured (alternation stays inside the boundaries)", () => {
  const f = buildIsAi({ apply_priority: { ai_title_patterns: ["AI|ML"] } }, { warn: () => {} });
  assert.equal(f({ title: "ML Product Manager" }), true);
  assert.equal(f({ title: "HTML Product Manager" }), false);
  assert.equal(f({ title: "Brain Product Manager" }), false);
});
