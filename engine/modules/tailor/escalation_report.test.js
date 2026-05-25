const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  renderEscalationReport,
  renderEscalationStdout,
  formatIterationsLine,
  formatMissingList,
} = require("./escalation_report.js");

const FIXED_TS = "2026-05-24 16:30:00";

function sampleRecord(overrides = {}) {
  return {
    row_key: "ats:lever:acme:pm-2026-05-24",
    target_role: "PM",
    company: "Acme",
    jd_url: "https://example.com/jd/acme-pm",
    final_coverage_pct: 78,
    exit_reason: "no_growth",
    escalation_reason: "no_growth_below_threshold",
    iterations: [
      { n: 1, coverage_pct: 78, missing: ["SAFe methodology"] },
      { n: 2, coverage_pct: 78, missing: ["SAFe methodology"] },
      { n: 3, coverage_pct: 78, missing: ["SAFe methodology"] },
    ],
    missing_high_priority: ["SAFe methodology", "scrum-of-scrums", "distributed teams >50"],
    uncertain_facts: [],
    master_source_hash: "00c8f940006a",
    ...overrides,
  };
}

test("formatIterationsLine — coverage progression", () => {
  assert.equal(
    formatIterationsLine([
      { n: 1, coverage_pct: 62 },
      { n: 2, coverage_pct: 81 },
      { n: 3, coverage_pct: 88 },
    ]),
    "62%, 81%, 88% (3 iters)",
  );
  assert.equal(formatIterationsLine([{ n: 1, coverage_pct: 50 }]), "50% (1 iter)");
  assert.equal(formatIterationsLine([]), "(no iterations)");
  assert.equal(formatIterationsLine(null), "(no iterations)");
});

test("formatMissingList — truncates after 4 with +N more", () => {
  assert.equal(formatMissingList([]), "(none)");
  assert.equal(formatMissingList(["a", "b"]), "a, b");
  assert.equal(
    formatMissingList(["a", "b", "c", "d", "e", "f"]),
    "a, b, c, d, +2 more",
  );
});

test("renderEscalationReport — single record produces summary + details", () => {
  const md = renderEscalationReport([sampleRecord()], { timestamp: FIXED_TS });
  assert.ok(md.startsWith("# Tailor escalations — 2026-05-24 16:30:00"));
  // Summary table header.
  assert.ok(md.includes("| Job | Final coverage | Exit reason | Missing / Uncertain |"));
  // Acme row appears.
  assert.ok(md.includes("Acme PM"));
  assert.ok(md.includes("78%"));
  assert.ok(md.includes("no_growth"));
  // Details section.
  assert.ok(md.includes("## Details"));
  assert.ok(md.includes("### Acme PM (row_key=ats:lever:acme:pm-2026-05-24)"));
  assert.ok(md.includes("Missing high-priority JD phrases"));
  assert.ok(md.includes('"SAFe methodology"'));
  assert.ok(md.includes("source_hash=00c8f940006a"));
});

test("renderEscalationReport — multiple records (mix of stuck + uncertain)", () => {
  const records = [
    sampleRecord(),
    sampleRecord({
      row_key: "ats:greenhouse:brex:pm",
      target_role: "PM",
      company: "Brex",
      final_coverage_pct: 86,
      exit_reason: "threshold_met",
      escalation_reason: "uncertain_about_fact",
      iterations: [
        { n: 1, coverage_pct: 81, missing: ["x"] },
        { n: 2, coverage_pct: 86, missing: [] },
      ],
      missing_high_priority: [],
      uncertain_facts: [
        {
          fact: "led ML team of 8",
          source_hint: "не нашёл в master, мог упустить",
          suggested_action: "confirm or deny",
        },
      ],
    }),
  ];
  const md = renderEscalationReport(records, { timestamp: FIXED_TS });
  assert.ok(md.includes("Acme PM"));
  assert.ok(md.includes("Brex PM"));
  assert.ok(md.includes('"led ML team of 8"'));
  assert.ok(md.includes("Uncertain facts"));
  // Both detail sections present.
  const detailHeaders = md.match(/^### /gm) || [];
  assert.equal(detailHeaders.length, 2);
});

test("renderEscalationReport — empty list yields placeholder body", () => {
  const md = renderEscalationReport([], { timestamp: FIXED_TS });
  assert.ok(md.includes("# Tailor escalations — 2026-05-24 16:30:00"));
  assert.ok(md.includes("_No escalations in this batch._"));
  assert.ok(!md.includes("## Details"));
});

test("renderEscalationStdout — short table, distinct format from MD", () => {
  const out = renderEscalationStdout([sampleRecord()]);
  // Plain header, no markdown.
  assert.ok(out.startsWith("Tailor escalations: 1"));
  assert.ok(out.includes("Job | Coverage | Reason | Hint"));
  assert.ok(out.includes("Acme PM"));
  // No MD table syntax.
  assert.ok(!out.includes("|---"));
  // Empty list → empty string.
  assert.equal(renderEscalationStdout([]), "");
});
