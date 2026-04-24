const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseIntake,
  validateIntake,
  toBool,
  foldSectionLines,
  coerceFields,
  isSkipValue,
} = require("./parse_intake.js");

// ---------- primitives ----------

test("toBool handles EN + RU tokens", () => {
  assert.equal(toBool("yes"), true);
  assert.equal(toBool("YES"), true);
  assert.equal(toBool("да"), true);
  assert.equal(toBool("no"), false);
  assert.equal(toBool("нет"), false);
  assert.equal(toBool("maybe"), null);
});

test("isSkipValue treats empty/skip placeholders as missing", () => {
  for (const v of ["", " ", "(skip)", "skip", "—", "-"]) {
    assert.equal(isSkipValue(v), true);
  }
  assert.equal(isSkipValue("profile_b"), false);
  assert.equal(isSkipValue(42), false);
});

// ---------- fold helper ----------

test("foldSectionLines: scalar + list + nested under list", () => {
  const lines = [
    { kind: "line", text: "- profile_id: profile_b", lineno: 1 },
    { kind: "line", text: "- full_name: Pat Example", lineno: 2 },
    { kind: "line", text: "- target_roles:", lineno: 3 },
    { kind: "line", text: "  - Product Manager", lineno: 4 },
    { kind: "line", text: "  - Senior PM", lineno: 5 },
    { kind: "line", text: "- title_blocklist:", lineno: 6 },
    { kind: "line", text: "  - Director", lineno: 7 },
  ];
  const folded = foldSectionLines(lines);
  assert.equal(folded.profile_id, "profile_b");
  assert.equal(folded.full_name, "Pat Example");
  assert.deepEqual(folded.target_roles, ["Product Manager", "Senior PM"]);
  assert.deepEqual(folded.title_blocklist, ["Director"]);
});

test("foldSectionLines: blank line closes an active list", () => {
  const lines = [
    { kind: "line", text: "- tier_s:", lineno: 1 },
    { kind: "line", text: "  - Stripe", lineno: 2 },
    { kind: "line", text: "", lineno: 3 },
    { kind: "line", text: "  - ShouldNotLand", lineno: 4 }, // no active key → dropped
    { kind: "line", text: "- tier_a:", lineno: 5 },
    { kind: "line", text: "  - Ramp", lineno: 6 },
  ];
  const folded = foldSectionLines(lines);
  assert.deepEqual(folded.tier_s, ["Stripe"]);
  assert.deepEqual(folded.tier_a, ["Ramp"]);
});

test("coerceFields: numbers, bools, comma-lists, skips", () => {
  const input = {
    full_name: "Pat",
    years_experience: "8",
    salary_min_total_comp: "180,000",
    has_prototype: "yes",
    company_sizes_ok: "Startup, Scaleup, Mid",
    pronouns: "(skip)",
    empty_list: [], // dropped
    target_roles: ["PM"], // kept
  };
  const out = coerceFields("X", input);
  assert.equal(out.full_name, "Pat");
  assert.equal(out.years_experience, 8);
  assert.equal(out.salary_min_total_comp, 180000);
  assert.equal(out.has_prototype, true);
  assert.deepEqual(out.company_sizes_ok, ["Startup", "Scaleup", "Mid"]);
  assert.equal(out.pronouns, undefined);
  assert.equal(out.empty_list, undefined);
  assert.deepEqual(out.target_roles, ["PM"]);
});

// ---------- full parse ----------

const FIXTURE_FULL = `# Onboarding Intake — AIJobSearcher

## A. Identity

- profile_id: profile_b
- full_name: Pat Example
- email: pat@example.com
- phone: +1 555 0199
- location_city: Sacramento
- location_state: CA
- location_country: US
- linkedin: linkedin.com/in/pat
- personal_site: (skip)
- pronouns: she/her

## B. Career context

- current_role: Senior PM at Acme
- years_experience: 8
- level: Senior IC
- seniority: senior
- target_roles:
  - Product Manager
  - Senior PM
- title_blocklist:
  - Director
  - Intern

## C. Preferences

- work_format: remote
- locations_ok:
  - Remote (US)
  - Sacramento, CA
- location_blocklist:
  - New York
- salary_min_total_comp: 180000
- salary_ideal_total_comp: 220000
- salary_currency: USD
- industries_prefer:
  - Fintech
  - AI
- industries_avoid:
  - Defense
- company_sizes_ok: Startup, Scaleup, Mid

## D. Target companies

- tier_s:
  - Stripe
  - Ramp
- tier_a:
  - Mercury
- tier_b:
  - Sardine
- tier_c:
- company_blocklist:
  - Palantir

## E. Resume archetypes

### E.1 ai-pm
- title: AI Product Manager
- summary: PM focused on AI platform products.
- bullets:
  - Built AI platform serving 100k users
  - Led team of 12
- tags: ai, ml, platform

### E.2 fintech
- title: FinTech PM
- summary: PM for payments and consumer fintech.
- bullets:
  - Launched a BNPL feature to 5M users
- tags: fintech, payments

## F. Cover letter voice

- signature: Best, Pat
- tone: conversational
- length: medium
- intro_hint: Open with why this company matters to me.
- why_interested_hint: Reference a recent product launch.
- why_fit_hint: Tie my last shipped thing to their roadmap.
- close_hint: Propose a 30-min chat.

## G. Notion

- parent_page_url: https://www.notion.so/Pat-00000000000000000000000000000000
- integration_name: AIJobSearcher-Pat
- integration_shared: yes

## H. Discovery modules

- modules:
  - discovery:greenhouse
  - discovery:lever
  - discovery:ashby

## I. Required .env variables

- env_notion_token_set: yes
- env_usajobs_set: no

## J. Prototype import (optional)

- has_prototype: yes
- prototype_path: /Users/me/Profile B Job Search
- import_cover_letter_template: yes
- import_resume_versions: yes
- import_cover_letter_versions: yes
- import_generated_cover_letters: yes
- import_generated_resumes: yes
- import_tsv: no
- import_notion_workspace_url: (skip)

## K. Optional flags

- watcher_enabled: no
- include_companies_seed: yes
`;

test("parseIntake: full fixture round-trips all sections", () => {
  const intake = parseIntake(FIXTURE_FULL);

  // Identity
  assert.equal(intake.identity.profile_id, "profile_b");
  assert.equal(intake.identity.full_name, "Pat Example");
  assert.equal(intake.identity.personal_site, undefined); // skipped
  assert.equal(intake.identity.pronouns, "she/her");

  // Career — numbers, lists
  assert.equal(intake.career.years_experience, 8);
  assert.deepEqual(intake.career.target_roles, ["Product Manager", "Senior PM"]);
  assert.deepEqual(intake.career.title_blocklist, ["Director", "Intern"]);

  // Preferences
  assert.equal(intake.preferences.salary_min_total_comp, 180000);
  assert.equal(intake.preferences.salary_ideal_total_comp, 220000);
  assert.deepEqual(intake.preferences.company_sizes_ok, ["Startup", "Scaleup", "Mid"]);

  // Companies — empty tier_c is dropped
  assert.deepEqual(intake.companies.tier_s, ["Stripe", "Ramp"]);
  assert.equal(intake.companies.tier_c, undefined);
  assert.deepEqual(intake.companies.company_blocklist, ["Palantir"]);

  // Resume archetypes — 2 items, both with tags parsed as arrays
  assert.equal(intake.resume_archetypes.length, 2);
  const aiPm = intake.resume_archetypes[0];
  assert.equal(aiPm.key, "ai-pm");
  assert.equal(aiPm.title, "AI Product Manager");
  assert.deepEqual(aiPm.tags, ["ai", "ml", "platform"]);
  assert.equal(aiPm.bullets.length, 2);

  // Cover letter voice
  assert.equal(intake.cover_letter.signature, "Best, Pat");
  assert.equal(intake.cover_letter.tone, "conversational");

  // Notion
  assert.equal(intake.notion.integration_shared, true);
  assert.ok(intake.notion.parent_page_url.includes("notion.so"));

  // Modules — array
  assert.deepEqual(intake.modules, [
    "discovery:greenhouse",
    "discovery:lever",
    "discovery:ashby",
  ]);

  // Env checks — booleans
  assert.equal(intake.env_checks.env_notion_token_set, true);
  assert.equal(intake.env_checks.env_usajobs_set, false);

  // Prototype import
  assert.equal(intake.prototype.has_prototype, true);
  assert.equal(intake.prototype.import_tsv, false);
  assert.equal(intake.prototype.import_notion_workspace_url, undefined);

  // Flags
  assert.equal(intake.flags.watcher_enabled, false);
  assert.equal(intake.flags.include_companies_seed, true);
});

test("parseIntake: commented-out modules in section H are ignored", () => {
  const md = `## H. Discovery modules
- modules:
  - discovery:greenhouse
  # - discovery:calcareers
  - discovery:lever
  # - discovery:usajobs
`;
  const intake = parseIntake(md);
  assert.deepEqual(intake.modules, ["discovery:greenhouse", "discovery:lever"]);
});

test("parseIntake: template placeholders in E.<key> are dropped", () => {
  const md = `## E. Resume archetypes

### E.1 <key>
- title:
- summary:

### E.2 ai-pm
- title: AI PM
- summary: Actual.
- tags: ai
`;
  const intake = parseIntake(md);
  assert.equal(intake.resume_archetypes.length, 1);
  assert.equal(intake.resume_archetypes[0].key, "ai-pm");
});

test("parseIntake: strips HTML comments from template hints", () => {
  const md = `## A. Identity
- profile_id: profile_b <!-- e.g. profile_b -->
- full_name: Pat
`;
  const intake = parseIntake(md);
  assert.equal(intake.identity.profile_id, "profile_b");
});

test("parseIntake: rejects non-string input", () => {
  assert.throws(() => parseIntake(null));
  assert.throws(() => parseIntake(""));
  assert.throws(() => parseIntake(123));
});

// ---------- validation ----------

test("validateIntake: detects missing required fields", () => {
  const intake = {
    identity: {},
    notion: {},
    resume_archetypes: [],
    env_checks: {},
  };
  const v = validateIntake(intake);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("profile_id")));
  assert.ok(v.errors.some((e) => e.includes("full_name")));
  assert.ok(v.errors.some((e) => e.includes("parent_page_url")));
  assert.ok(v.errors.some((e) => e.includes("resume archetype")));
  assert.ok(v.errors.some((e) => e.includes("NOTION_TOKEN")));
});

test("validateIntake: accepts minimal-valid intake", () => {
  const intake = {
    identity: {
      profile_id: "profile_b",
      full_name: "Pat",
      email: "pat@example.com",
    },
    notion: { parent_page_url: "https://notion.so/x-00000000000000000000000000000000" },
    resume_archetypes: [{ key: "ai-pm", title: "AI PM" }],
    env_checks: { env_notion_token_set: true },
  };
  const v = validateIntake(intake);
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
});
