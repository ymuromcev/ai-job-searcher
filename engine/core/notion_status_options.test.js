const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  EXPECTED_STATUS_OPTIONS,
  extractStatusOptions,
  checkStatusSchema,
} = require("./notion_status_options.js");

function mkDataSource(optionNames, propType = "status", fieldName = "Status") {
  return {
    properties: {
      [fieldName]: {
        [propType]: { options: optionNames.map((name) => ({ name })) },
      },
    },
  };
}

test("extractStatusOptions: reads names from status property", () => {
  const ds = mkDataSource(["To Apply", "Applied", "Closed"]);
  assert.deepEqual(extractStatusOptions(ds), ["To Apply", "Applied", "Closed"]);
});

test("extractStatusOptions: also reads from select-typed Status", () => {
  const ds = mkDataSource(["To Apply", "Applied"], "select");
  assert.deepEqual(extractStatusOptions(ds), ["To Apply", "Applied"]);
});

test("extractStatusOptions: returns null when Status property missing", () => {
  assert.equal(extractStatusOptions({ properties: {} }), null);
  assert.equal(extractStatusOptions(null), null);
  assert.equal(extractStatusOptions({}), null);
});

test("checkStatusSchema: all options present → ok, no missing", () => {
  const res = checkStatusSchema(EXPECTED_STATUS_OPTIONS);
  assert.equal(res.ok, true);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.extras, []);
});

test("checkStatusSchema: 2 missing → ok=false with the names", () => {
  const actual = EXPECTED_STATUS_OPTIONS.filter((n) => n !== "Applied" && n !== "Closed");
  const res = checkStatusSchema(actual);
  assert.equal(res.ok, false);
  assert.deepEqual(res.missing.sort(), ["Applied", "Closed"]);
  assert.deepEqual(res.extras, []);
});

test("checkStatusSchema: extras allowed (custom options don't fail)", () => {
  const res = checkStatusSchema([...EXPECTED_STATUS_OPTIONS, "Phone Screen", "Take-home"]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.extras.sort(), ["Phone Screen", "Take-home"]);
});

test("checkStatusSchema: Inbox in Notion is treated as an extra, not a missing-or-required", () => {
  // RFC 014: Inbox is TSV-only. If a user put it in Notion anyway, we don't
  // warn — it's just an extra option the user can use however they like.
  const res = checkStatusSchema([...EXPECTED_STATUS_OPTIONS, "Inbox"]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.extras, ["Inbox"]);
});

test("EXPECTED_STATUS_OPTIONS: stable order, 8 options, no Inbox", () => {
  assert.equal(EXPECTED_STATUS_OPTIONS.length, 8);
  assert.ok(!EXPECTED_STATUS_OPTIONS.includes("Inbox"));
  assert.deepEqual(EXPECTED_STATUS_OPTIONS, [
    "To Apply",
    "Applied",
    "Interview",
    "Offer",
    "Rejected",
    "No Response",
    "Closed",
    "Archived",
  ]);
});
