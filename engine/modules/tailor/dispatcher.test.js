// Unit tests for the pure dispatch helpers in `dispatcher.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyRow,
  buildEscalationRecord,
  tailoredResumePath,
} = require("./dispatcher.js");

// --- classifyRow -------------------------------------------------------------

test("classifyRow: tailored when tailoredResume present and not escalated", () => {
  const row = {
    key: "gh:1",
    fitScore: "Strong",
    tailoredResume: { contact: {}, version: { summary: "x" } },
    tailorCoverage: 88,
    tailorEscalated: false,
    tailorEscalationReason: null,
    tailorEscalationDetail: null,
  };
  assert.equal(classifyRow(row), "tailored");
});

test("classifyRow: escalated when tailorEscalated=true", () => {
  const row = {
    key: "gh:2",
    fitScore: "Strong",
    tailoredResume: null,
    tailorCoverage: 72,
    tailorEscalated: true,
    tailorEscalationReason: "no_growth_below_threshold",
    tailorEscalationDetail: { iterations: [{ n: 1, coverage_pct: 72, missing: [] }] },
  };
  assert.equal(classifyRow(row), "escalated");
});

test("classifyRow: escalated wins over tailoredResume (both set)", () => {
  const row = {
    key: "gh:3",
    tailoredResume: { contact: {}, version: { summary: "x" } },
    tailorEscalated: true,
    tailorEscalationReason: "uncertain_about_fact",
  };
  assert.equal(classifyRow(row), "escalated");
});

test("classifyRow: archetype when no tailor fields (Weak/Medium row)", () => {
  const row = { key: "gh:4", fitScore: "Weak" };
  assert.equal(classifyRow(row), "archetype");
});

test("classifyRow: archetype when tailoredResume is null", () => {
  const row = {
    key: "gh:5",
    fitScore: "Medium",
    tailoredResume: null,
    tailorEscalated: false,
  };
  assert.equal(classifyRow(row), "archetype");
});

test("classifyRow: archetype when tailoredResume is malformed (string)", () => {
  const row = { key: "gh:6", tailoredResume: "not-an-object", tailorEscalated: false };
  assert.equal(classifyRow(row), "archetype");
});

test("classifyRow: archetype on null / non-object row", () => {
  assert.equal(classifyRow(null), "archetype");
  assert.equal(classifyRow(undefined), "archetype");
  assert.equal(classifyRow("nope"), "archetype");
});

// --- buildEscalationRecord ---------------------------------------------------

test("buildEscalationRecord: maps SKILL fields to MD renderer shape", () => {
  const row = {
    key: "ats:lever:acme:pm-001",
    company: "Acme",
    targetRole: "PM",
    jdUrl: "https://jobs.lever.co/acme/pm",
    tailorCoverage: 78,
    tailorEscalated: true,
    tailorEscalationReason: "no_growth_below_threshold",
    tailorEscalationDetail: {
      iterations: [
        { n: 1, coverage_pct: 62, missing: ["python", "sql"] },
        { n: 2, coverage_pct: 78, missing: ["sql"] },
      ],
      uncertain_facts: [{ fact: "led team of 8", source_hint: "verify headcount" }],
      coverage_table: [],
    },
    masterSourceHash: "abc123",
  };
  const rec = buildEscalationRecord(row);
  assert.equal(rec.row_key, "ats:lever:acme:pm-001");
  assert.equal(rec.target_role, "PM");
  assert.equal(rec.company, "Acme");
  assert.equal(rec.jd_url, "https://jobs.lever.co/acme/pm");
  assert.equal(rec.final_coverage_pct, 78);
  assert.equal(rec.escalation_reason, "no_growth_below_threshold");
  assert.equal(rec.exit_reason, "no_growth_below_threshold");
  assert.equal(rec.iterations.length, 2);
  // missing_high_priority falls back to last iteration's `missing`
  assert.deepEqual(rec.missing_high_priority, ["sql"]);
  assert.equal(rec.uncertain_facts.length, 1);
  assert.equal(rec.master_source_hash, "abc123");
});

test("buildEscalationRecord: tolerates missing detail (empty defaults)", () => {
  const row = {
    key: "k1",
    tailorEscalated: true,
    tailorEscalationReason: "uncertain_about_fact",
  };
  const rec = buildEscalationRecord(row);
  assert.equal(rec.row_key, "k1");
  assert.equal(rec.final_coverage_pct, 0);
  assert.deepEqual(rec.iterations, []);
  assert.deepEqual(rec.uncertain_facts, []);
  assert.deepEqual(rec.missing_high_priority, []);
  assert.equal(rec.escalation_reason, "uncertain_about_fact");
  assert.equal(rec.exit_reason, "uncertain_about_fact");
});

test("buildEscalationRecord: explicit missing_high_priority wins over last iter", () => {
  const row = {
    key: "k2",
    tailorEscalated: true,
    tailorEscalationReason: "no_growth_below_threshold",
    tailorEscalationDetail: {
      iterations: [{ n: 1, coverage_pct: 50, missing: ["x", "y"] }],
      missing_high_priority: ["override"],
    },
  };
  const rec = buildEscalationRecord(row);
  assert.deepEqual(rec.missing_high_priority, ["override"]);
});

// --- tailoredResumePath ------------------------------------------------------

test("tailoredResumePath: formats relative POSIX path with slug + date", () => {
  const p = tailoredResumePath("jared", "stripe", "2026-05-24");
  assert.equal(p, "resumes/tailored/stripe-2026-05-24.docx");
});

test("tailoredResumePath: profile id does not leak into the path", () => {
  // Path is relative to profile root, so profileId is intentionally unused
  // in the output. This guards against an accidental change to embed it.
  const p = tailoredResumePath("anyone", "acme-inc", "2026-01-01");
  assert.equal(p, "resumes/tailored/acme-inc-2026-01-01.docx");
});
