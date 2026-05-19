const { test } = require("node:test");
const assert = require("node:assert/strict");

const { pickClBase, detectShape, DEFAULT_THRESHOLD } = require("./cl_base_matcher.js");

// --- Fixtures ----------------------------------------------------------------

function templateVariantsVersions() {
  return {
    defaults: {
      p2: "Locked P2 proof paragraph.",
      p3: "Locked P3 secondary paragraph.",
      p4_template: "Available {availability}. Thanks, {sign}.",
      availability: "starting next month",
      sign: "Lilia",
    },
    letters: [{ job_id: "kp-1", role: "RN", company: "Kaiser", p1: "Hello Kaiser..." }],
  };
}

function libraryVersions() {
  return {
    affirm_capital: {
      filename: "Affirm_Capital_PM.pdf",
      paragraphs: ["P1 affirm", "P2 affirm capital proof", "P3 affirm why", "P4 close"],
      company: "Affirm",
      archetype: "ConsumerLending",
      role_keywords: ["pm", "capital", "credit"],
    },
    lendbuzz_creditcard: {
      filename: "LendBuzz_PM.pdf",
      paragraphs: ["P1 lendbuzz", "P2 lendbuzz proof", "P3 lendbuzz why", "P4 close"],
      company: "LendBuzz",
      archetype: "ConsumerLending",
      role_keywords: ["pm", "credit", "card"],
    },
    stripe_platform: {
      filename: "Stripe_Platform.pdf",
      paragraphs: ["P1 stripe", "P2 stripe platform proof", "P3 stripe why", "P4 close"],
      company: "Stripe",
      archetype: "PaymentsInfra",
      role_keywords: ["pm", "platform", "api"],
    },
  };
}

// --- detectShape -------------------------------------------------------------

test("detectShape: template-variants when `defaults` has p2/p3", () => {
  assert.equal(detectShape(templateVariantsVersions()), "template-variants");
});

test("detectShape: library when entries have paragraphs[]", () => {
  assert.equal(detectShape(libraryVersions()), "library");
});

test("detectShape: empty for null / {} / non-object", () => {
  assert.equal(detectShape(null), "empty");
  assert.equal(detectShape(undefined), "empty");
  assert.equal(detectShape({}), "empty");
  assert.equal(detectShape("not-an-object"), "empty");
});

test("detectShape: leading-underscore keys (_description) ignored", () => {
  assert.equal(detectShape({ _description: "doc" }), "empty");
});

// --- Template-variants shape -------------------------------------------------

test("template-variants: returns defaults with paragraphs P2/P3/P4", () => {
  const out = pickClBase({
    job: { companyName: "Anything", title: "Anything" },
    versions: templateVariantsVersions(),
  });
  assert.equal(out.key, "defaults");
  assert.equal(out.score, 1);
  assert.equal(out.reason, "template-variants:defaults");
  assert.equal(out.paragraphs.P2, "Locked P2 proof paragraph.");
  assert.equal(out.paragraphs.P3, "Locked P3 secondary paragraph.");
  assert.equal(out.paragraphs.P4, "Available {availability}. Thanks, {sign}.");
});

// --- Library shape: scoring + priority --------------------------------------

test("library: exact company match wins (score >= 10)", () => {
  const out = pickClBase({
    job: { companyName: "Affirm", title: "Senior PM, Capital" },
    versions: libraryVersions(),
    resumeVer: null,
  });
  assert.equal(out.key, "affirm_capital");
  assert.ok(out.score >= 10, `expected score >= 10, got ${out.score}`);
  assert.match(out.reason, /company_exact/);
  assert.equal(out.paragraphs.P2, "P2 affirm capital proof");
});

test("library: archetype + title overlap (no company hit) wins by combined score", () => {
  // Job at unknown company "Acme" but archetype matches lendbuzz_creditcard
  // (ConsumerLending) and title overlaps "pm", "credit", "card".
  const out = pickClBase({
    job: { companyName: "Acme", title: "Senior Credit Card PM" },
    versions: libraryVersions(),
    resumeVer: "ConsumerLending",
  });
  assert.equal(out.key, "lendbuzz_creditcard");
  // archetype(5) + title:3*3=9 → 14 (above threshold 8)
  assert.ok(out.score >= 8);
  assert.match(out.reason, /archetype_match/);
  assert.match(out.reason, /title:\d+/);
  assert.doesNotMatch(out.reason, /low_confidence/);
});

test("library: no `archetype` field on entries → archetype component does not fire, title picks winner", () => {
  const versions = {
    foo_pm: {
      filename: "foo.pdf",
      paragraphs: ["P1 foo", "P2 foo", "P3 foo", "P4 foo"],
      // no company, no archetype, no role_keywords
    },
    bar_credit: {
      filename: "bar.pdf",
      paragraphs: ["P1 bar", "P2 bar", "P3 bar", "P4 bar"],
    },
  };
  const out = pickClBase({
    job: { companyName: "Other", title: "Credit Risk PM" },
    versions,
    resumeVer: "AnyArchetype",
  });
  // bar_credit overlaps "credit" via key-tokenization; foo_pm overlaps "pm".
  // Both single-token overlap → tie 3 vs 3 → first declared wins (foo_pm).
  // To make the test deterministic against the priority rule, swap to a
  // title that uniquely matches bar.
  const out2 = pickClBase({
    job: { companyName: "Other", title: "Credit Card Analyst" },
    versions,
    resumeVer: "AnyArchetype",
  });
  assert.equal(out2.key, "bar_credit");
  // single token overlap = 1 → title:3 → below threshold 8 → low_confidence
  assert.match(out2.reason, /title:1/);
  assert.match(out2.reason, /low_confidence/);
  // Sanity for the first call: foo_pm wins by tie-break (declaration order).
  assert.equal(out.key, "foo_pm");
});

test("library: tiebreak — equal score → first-declared wins", () => {
  const versions = {
    alpha: {
      paragraphs: ["P1", "P2 alpha", "P3", "P4"],
      company: "Other",
      role_keywords: ["pm"],
    },
    beta: {
      paragraphs: ["P1", "P2 beta", "P3", "P4"],
      company: "Other2",
      role_keywords: ["pm"],
    },
  };
  const out = pickClBase({
    job: { companyName: "Unknown", title: "PM" },
    versions,
  });
  assert.equal(out.key, "alpha");
  assert.equal(out.paragraphs.P2, "P2 alpha");
});

test("library: threshold edge — top score below 8 includes low_confidence", () => {
  // Single title overlap → score 3, below threshold 8.
  const out = pickClBase({
    job: { companyName: "Nowhere", title: "Capital Analyst" },
    versions: libraryVersions(),
    resumeVer: null,
  });
  assert.equal(out.key, "affirm_capital"); // "capital" overlaps role_keywords
  assert.equal(out.score, 3);
  assert.match(out.reason, /low_confidence/);
  // Paragraphs still returned (RFC §3b — return highest scorer regardless)
  assert.equal(out.paragraphs.P2, "P2 affirm capital proof");
});

test("library: top score above threshold does NOT include low_confidence", () => {
  const out = pickClBase({
    job: { companyName: "Affirm", title: "Senior PM" },
    versions: libraryVersions(),
  });
  // company_exact (10) + title:1 (3) = 13
  assert.ok(out.score >= 8);
  assert.doesNotMatch(out.reason, /low_confidence/);
});

test("library: profile.cl_base_matcher.weights override honored", () => {
  // Boost archetype weight; without override would lose to title-only winner.
  const versions = {
    arch_winner: {
      paragraphs: ["P1", "P2 arch_winner", "P3", "P4"],
      archetype: "MyArch",
      role_keywords: ["analyst"], // no title overlap
    },
    title_winner: {
      paragraphs: ["P1", "P2 title_winner", "P3", "P4"],
      role_keywords: ["pm", "platform", "growth"],
    },
  };
  const job = { companyName: "X", title: "Senior PM Platform Growth" };

  // Default weights: arch_winner only gets archetype:5 = 5;
  // title_winner gets title:3*3 = 9 → title_winner wins.
  const baseline = pickClBase({ job, versions, resumeVer: "MyArch" });
  assert.equal(baseline.key, "title_winner");

  // Boost archetype to 20 → arch_winner now scores 20.
  const profile = { cl_base_matcher: { weights: { archetype: 20 } } };
  const out = pickClBase({ job, versions, resumeVer: "MyArch", profile });
  assert.equal(out.key, "arch_winner");
});

test("library: profile.cl_base_matcher.threshold override honored", () => {
  // Lower threshold so a single title hit (score 3) is treated as confident.
  const profile = { cl_base_matcher: { threshold: 1 } };
  const out = pickClBase({
    job: { companyName: "Nowhere", title: "Capital Analyst" },
    versions: libraryVersions(),
    resumeVer: null,
    profile,
  });
  assert.equal(out.score, 3);
  assert.doesNotMatch(out.reason, /low_confidence/);
});

// --- Empty library ----------------------------------------------------------

test("empty: null versions → reason=empty_library, paragraphs all null", () => {
  const out = pickClBase({ job: { companyName: "X", title: "Y" }, versions: null });
  assert.equal(out.key, null);
  assert.equal(out.score, 0);
  assert.equal(out.reason, "empty_library");
  assert.deepEqual(out.paragraphs, { P2: null, P3: null, P4: null });
});

test("empty: {} → empty_library", () => {
  const out = pickClBase({ job: { companyName: "X" }, versions: {} });
  assert.equal(out.key, null);
  assert.equal(out.reason, "empty_library");
});

// --- resumeVer null at pre-phase --------------------------------------------

test("resumeVer=null: archetype component skipped, company+title still fire", () => {
  const out = pickClBase({
    job: { companyName: "Stripe", title: "Platform PM" },
    versions: libraryVersions(),
    resumeVer: null,
  });
  assert.equal(out.key, "stripe_platform");
  assert.match(out.reason, /company_exact/);
  assert.doesNotMatch(out.reason, /archetype_match/);
});

// --- Fallback: entry without `company` / `role_keywords` ---------------------

test("library: entry without explicit metadata → key tokenization fallback", () => {
  const versions = {
    affirm_capital: {
      paragraphs: ["P1", "P2 from-key-tokens", "P3", "P4"],
      // no company / archetype / role_keywords
    },
  };
  const out = pickClBase({
    job: { companyName: "Affirm", title: "Capital PM" },
    versions,
  });
  // company derived from key token "affirm" matches; title overlap on "capital".
  assert.equal(out.key, "affirm_capital");
  assert.match(out.reason, /company_exact/);
});

// --- JD body keyword density -------------------------------------------------

test("library: JD body keyword density adds score, capped at +5", () => {
  const versions = {
    fintech: {
      paragraphs: ["P1", "P2 fintech", "P3", "P4"],
      archetype: "FintechPM",
      role_keywords: ["pm"],
    },
  };
  const profile = {
    resume_archetypes: {
      FintechPM: {
        keywords: ["credit", "lending", "underwriting", "risk", "loan", "fraud", "interest"],
      },
    },
  };
  const jdText =
    "We work on credit, lending, underwriting, risk, loan, fraud, and interest models.";
  const out = pickClBase({
    job: { companyName: "X", title: "PM", jdText },
    versions,
    resumeVer: "FintechPM",
    profile,
  });
  // archetype (5) + title:1*3 (3) + jd_body capped at 5*1 (5) = 13
  assert.match(out.reason, /jd_body:5/);
  assert.ok(out.score >= 13);
});

// --- DEFAULT_THRESHOLD is 8 -------------------------------------------------

test("DEFAULT_THRESHOLD constant matches RFC value 8", () => {
  assert.equal(DEFAULT_THRESHOLD, 8);
});
