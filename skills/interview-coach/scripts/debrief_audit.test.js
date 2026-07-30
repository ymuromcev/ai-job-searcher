// Unit tests for the debrief-loop detectors (RFC 066). One fixture per detector,
// plus a clean state that must produce zero findings.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const audit = require("./debrief_audit.js");

/** Build a single `## Outcome` block from field overrides. */
function outcome({
  title = "LawnStarter — recruiter screen",
  predicted = "advance to VP",
  result = "pending",
  gate = "recruiter screen",
  channel = "LIVE",
  conditions = "normal",
  baseline = "counted",
  reconciliation = "",
} = {}) {
  return [
    `## Outcome: ${title}`,
    `- Predicted: ${predicted}`,
    `- Result: ${result}`,
    `- Gate: ${gate}`,
    `- Channel: ${channel}`,
    `- Conditions: ${conditions}`,
    `- Baseline: ${baseline}`,
    `- Reconciliation: ${reconciliation}`,
    "",
  ].join("\n");
}

// The real registry schema: an H3 with `(active)`, no id column, Status 4th.
const ROOT_CAUSE_TABLE = `### Cross-Dimension Root Causes (active)

| Root Cause                       | Affected Dimensions          | First Detected | Status | Treatment                |
| -------------------------------- | ---------------------------- | -------------- | ------ | ------------------------ |
| volunteers low self-rating aloud | Credibility, Differentiation | Session 3      | active | pre-build anchor numbers |
`;

// A fully-resolved, reconciled, channel-tagged outcome with normal conditions.
const CLEAN_RESOLVED = outcome({
  result: "rejected",
  channel: "PAPER",
  conditions: "normal",
  baseline: "counted",
  reconciliation: "predicted advance; VP passed on paper. Miss: logged endorse-to-gate as advance.",
});

test("a clean state — resolved+reconciled outcome and a well-formed root cause — is silent", () => {
  const state = `# Coaching State\n\n${CLEAN_RESOLVED}\n${ROOT_CAUSE_TABLE}`;
  assert.deepEqual(audit.auditDebrief({ stateText: state }), []);
});

test("a still-pending outcome owes nothing — no channel, no reconciliation required", () => {
  const state = outcome({ result: "pending", channel: "—", reconciliation: "" });
  assert.deepEqual(audit.auditDebrief({ stateText: state }), []);
});

test("parseOutcomeBlocks reads fields and closes on the next H2", () => {
  const state = `${outcome({ result: "rejected", reconciliation: "x" })}\n## Something Else\n- Predicted: leaked`;
  const blocks = audit.parseOutcomeBlocks(state);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].fields.result, "rejected");
  assert.equal(blocks[0].fields.predicted, "advance to VP");
  assert.equal(blocks[0].fields.reconciliation, "x");
});

test("parseOutcomeBlocks does not swallow the `## Outcome Log` section", () => {
  // Regression: the anchored heading must not match `## Outcome Log`.
  const state = `## Outcome Log
| Date | Company | Role | Round | Result | Notes |
|------|---------|------|-------|--------|-------|
| 2026-07-20 | LawnStarter | PM | screen | rejected | endorse ≠ advance |

${outcome({ result: "pending", channel: "—", reconciliation: "" })}`;
  const blocks = audit.parseOutcomeBlocks(state);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].title, /LawnStarter/);
  // And the whole audit stays silent: the table row is not a resolved block.
  assert.deepEqual(audit.auditDebrief({ stateText: state }), []);
});

test("a free-text Result tail still classifies (pending owes nothing)", () => {
  const state = outcome({ result: "pending — waiting on VP", channel: "", reconciliation: "" });
  assert.deepEqual(audit.auditDebrief({ stateText: state }), []);
});

test("a free-text resolved tail is still resolved and owes its fields", () => {
  const found = audit.detectOutcomeWithoutChannel(
    outcome({ result: "rejected (after panel)", channel: "—", reconciliation: "x" })
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "outcome-without-channel");
});

test("detector 1 — a resolved outcome with no channel", () => {
  const found = audit.detectOutcomeWithoutChannel(
    outcome({ result: "rejected", channel: "—", reconciliation: "x" })
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "outcome-without-channel");
  assert.match(found[0].message, /LIVE.*PAPER/);
});

test("detector 1 — silent while the result is still pending", () => {
  assert.deepEqual(
    audit.detectOutcomeWithoutChannel(outcome({ result: "pending", channel: "" })),
    []
  );
});

test("detector 2 — a resolved outcome with an empty reconciliation", () => {
  const found = audit.detectUnreconciledOutcome(
    outcome({ result: "advanced", reconciliation: "" })
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "outcome-unreconciled");
  assert.match(found[0].message, /калибровочный урок/);
});

test("detector 2 — a reconciled outcome is accepted", () => {
  assert.deepEqual(
    audit.detectUnreconciledOutcome(
      outcome({ result: "advanced", reconciliation: "matched the prediction" })
    ),
    []
  );
});

test("detector 3 — a loss under adverse conditions not quarantined", () => {
  const found = audit.detectConditionNotQuarantined(
    outcome({
      result: "rejected",
      conditions: "severe sleep-deprivation; cold English; va-bank",
      baseline: "counted",
      channel: "PAPER",
      reconciliation: "x",
    })
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "condition-not-quarantined");
  assert.match(found[0].message, /quarantined/);
});

test("detector 3 — the same loss, quarantined, is accepted", () => {
  assert.deepEqual(
    audit.detectConditionNotQuarantined(
      outcome({
        result: "rejected",
        conditions: "no sleep",
        baseline: "quarantined",
        channel: "PAPER",
        reconciliation: "x",
      })
    ),
    []
  );
});

test("detector 3 — a loss under normal conditions owes no quarantine", () => {
  assert.deepEqual(
    audit.detectConditionNotQuarantined(
      outcome({
        result: "rejected",
        conditions: "normal",
        baseline: "counted",
        channel: "PAPER",
        reconciliation: "x",
      })
    ),
    []
  );
});

test("detector 3 — an advance under adverse conditions is not a quarantine target", () => {
  assert.deepEqual(
    audit.detectConditionNotQuarantined(
      outcome({
        result: "advanced",
        conditions: "no sleep",
        baseline: "counted",
        channel: "LIVE",
        reconciliation: "x",
      })
    ),
    []
  );
});

test("detector 4 — a root-cause row with an unrecognized status", () => {
  const table = `### Cross-Dimension Root Causes (active)

| Root Cause      | Affected Dimensions | First Detected | Status | Treatment |
| --------------- | ------------------- | -------------- | ------ | --------- |
| low self-rating | Credibility         | Session 3      |        | anchors   |
`;
  const found = audit.detectRootCauseMissingStatus(table);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, "root-cause-missing-status");
  assert.match(found[0].message, /low self-rating/);
});

test("detector 4 — the First Detected date is not mistaken for the status", () => {
  // Regression: parsing must read Status (4th cell), not First Detected (3rd).
  assert.deepEqual(audit.detectRootCauseMissingStatus(ROOT_CAUSE_TABLE), []);
  const rows = audit.parseRootCauses(ROOT_CAUSE_TABLE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "active");
  assert.equal(rows[0].firstDetected, "Session 3");
});

test("detector 4 — recognized statuses pass", () => {
  assert.deepEqual(audit.detectRootCauseMissingStatus(ROOT_CAUSE_TABLE), []);
});

test("formatReport states the loop-closure rule when findings exist", () => {
  const report = audit.formatReport(
    [{ code: "outcome-without-channel", message: "нет канала" }],
    "jared"
  );
  assert.match(report, /1 находок/);
  assert.match(report, /Луп закрыт/);
  assert.match(audit.formatReport([], "jared"), /чисто/);
});
