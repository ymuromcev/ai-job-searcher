// Unit tests for the freeze / cheat-sheet-schema guard.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const guard = require("./prep_freeze_guard.js");

const CALL_AT = "2026-08-05T14:00:00-07:00";
const CALL_MS = Date.parse(CALL_AT);
const ROUND = `---
kind: exam
company: "Plata"
datetime: "${CALL_AT}" # source of truth for the freeze
status: prep
---

# Plata
`;

const SHEET_PATH =
  "/repo/profiles/jared/interview-coach-state/rounds/2026-08-05_plata_exam_ШПАРГАЛКА.md";

function call({
  toolName = "Write",
  filePath = SHEET_PATH,
  content = "текст",
  roundText = ROUND,
  nowMs,
}) {
  return guard.decide({
    toolName,
    filePath,
    toolInput: { file_path: filePath, content },
    roundText,
    nowMs: nowMs === undefined ? CALL_MS - 30 * 3600 * 1000 : nowMs,
  });
}

test("allows a normal write well before the call", () => {
  assert.equal(call({}).allow, true);
});

test("blocks a write inside the freeze window", () => {
  const verdict = call({ nowMs: CALL_MS - 2 * 3600 * 1000 });
  assert.equal(verdict.allow, false);
  assert.match(verdict.reason, /стоп-линия/);
  assert.match(verdict.reason, /2\.0 ч/);
});

test("allows a write exactly outside the window and blocks just inside it", () => {
  const boundary = CALL_MS - guard.FREEZE_HOURS * 3600 * 1000;
  assert.equal(call({ nowMs: boundary - 1000 }).allow, true);
  assert.equal(call({ nowMs: boundary + 1000 }).allow, false);
});

test("blocks a formula without «Вытекает из» even outside the freeze", () => {
  const verdict = call({ content: "- Формула: h = z·√(p(1−p)/n)\n" });
  assert.equal(verdict.allow, false);
  assert.match(verdict.reason, /Вытекает из/);
});

test("allows a formula that states where it comes from", () => {
  const verdict = call({ content: "- Формула: h = z·√(p(1−p)/n) Вытекает из: SE доли.\n" });
  assert.equal(verdict.allow, true);
});

test("reads new_string for Edit and edits[] for MultiEdit", () => {
  const bad = "- Формула: n = (z+z)²·2p(1−p)/MDE²";
  assert.equal(
    guard.decide({
      toolName: "Edit",
      filePath: SHEET_PATH,
      toolInput: { file_path: SHEET_PATH, new_string: bad },
      roundText: ROUND,
      nowMs: CALL_MS - 30 * 3600 * 1000,
    }).allow,
    false
  );
  assert.equal(
    guard.decide({
      toolName: "MultiEdit",
      filePath: SHEET_PATH,
      toolInput: { file_path: SHEET_PATH, edits: [{ new_string: "ok" }, { new_string: bad }] },
      roundText: ROUND,
      nowMs: CALL_MS - 30 * 3600 * 1000,
    }).allow,
    false
  );
});

test("ignores tools and paths it does not own", () => {
  assert.equal(call({ toolName: "Read" }).allow, true);
  assert.equal(call({ filePath: "/repo/engine/cli.js", nowMs: CALL_MS - 1000 }).allow, true);
});

test("fails open when the round file has no datetime", () => {
  const noDate = ROUND.replace(/^datetime:.*$/m, 'datetime: ""');
  assert.equal(call({ roundText: noDate, nowMs: CALL_MS - 1000 }).allow, true);
});

test("fails open when no round file was found at all", () => {
  assert.equal(call({ roundText: "", nowMs: CALL_MS - 1000 }).allow, true);
});

test("callTimeMs strips inline comments and quotes", () => {
  assert.equal(guard.callTimeMs(ROUND), CALL_MS);
  assert.ok(Number.isNaN(guard.callTimeMs("no frontmatter here")));
});

test("findRoundFile pairs a cheat sheet with its round file", () => {
  const found = guard.findRoundFile(
    SHEET_PATH,
    () => ["2026-08-05_plata_exam.md", "2026-08-05_plata_exam_ШПАРГАЛКА.md"],
    () => ROUND,
    () => true
  );
  assert.match(String(found), /2026-08-05_plata_exam\.md$/);
});

test("findRoundFile returns the round file itself when the target is one", () => {
  const target = "/repo/profiles/jared/interview-coach-state/rounds/2026-08-05_plata_exam.md";
  assert.equal(
    guard.findRoundFile(
      target,
      () => [],
      () => "",
      () => true
    ),
    target
  );
});

test("findRoundFile falls back to the nearest upcoming round in the directory", () => {
  const later = ROUND.replace(CALL_AT, "2026-09-01T10:00:00-07:00");
  const files = ["2026-09-01_other_exam.md", "2026-08-05_plata_exam.md"];
  const found = guard.findRoundFile(
    "/repo/profiles/jared/interview-coach-state/rounds/notes.md",
    () => files,
    (full) => (String(full).includes("other") ? later : ROUND),
    () => true
  );
  assert.match(String(found), /2026-08-05_plata_exam\.md$/);
});

test("findRoundFile returns null when the directory has no round files", () => {
  assert.equal(
    guard.findRoundFile(
      "/repo/profiles/jared/interview-coach-state/rounds/notes.md",
      () => ["notes.md"],
      () => "",
      () => true
    ),
    null
  );
});
