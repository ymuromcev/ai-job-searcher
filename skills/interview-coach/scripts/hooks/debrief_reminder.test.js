// Unit tests for the debrief-loop reminder hook (RFC 066).
const { test } = require("node:test");
const assert = require("node:assert/strict");

const hook = require("./debrief_reminder.js");

test("triggers when an upcoming interview is mentioned with prep intent", () => {
  assert.equal(hook.shouldRemind("готовлюсь к следующему интервью в пятницу"), true);
  assert.equal(hook.shouldRemind("назначили скрининг на вторник"), true);
  assert.equal(hook.shouldRemind("prep for the next interview round"), true);
});

test("does not trigger without a round marker", () => {
  assert.equal(hook.shouldRemind("что мне надеть завтра"), false);
  assert.equal(hook.shouldRemind("подготовь резюме к следующей неделе"), false);
});

test("does not trigger without a next/prep marker", () => {
  assert.equal(hook.shouldRemind("вчера было интервью, разберём"), false);
});

test("empty and non-string prompts are safe", () => {
  assert.equal(hook.shouldRemind(""), false);
  assert.equal(hook.shouldRemind(undefined), false);
  assert.equal(hook.shouldRemind(null), false);
});

test("extractOpenLoops pulls active root causes and skips closed ones", () => {
  const state = `### Cross-Dimension Root Causes (active)

| Root Cause            | Affected Dimensions | First Detected | Status    | Treatment           |
| --------------------- | ------------------- | -------------- | --------- | ------------------- |
| low self-rating aloud | Credibility         | Session 3      | active    | pre-build anchors   |
| rambling opener       | Structure           | Session 2      | closed    | constraint ladder   |
| blurry role image     | Relevance           | Session 4      | improving | one-line role frame |
`;
  const loops = hook.extractOpenLoops(state);
  assert.equal(loops.rootCauses.length, 2);
  assert.deepEqual(loops.rootCauses.map((r) => r.pattern).sort(), [
    "blurry role image",
    "low self-rating aloud",
  ]);
  assert.equal(
    loops.rootCauses.find((r) => r.pattern === "low self-rating aloud").treatment,
    "pre-build anchors"
  );
});

test("extractOpenLoops pulls pending outcomes and ignores resolved ones", () => {
  const state = `## Outcome: LawnStarter — screen
- Predicted: advance to VP
- Result: rejected
- Reconciliation: endorse-to-gate ≠ advance

## Outcome: Plata — recruiter screen
- Predicted: advance to HM
- Result: pending
`;
  const loops = hook.extractOpenLoops(state);
  assert.equal(loops.pending.length, 1);
  assert.match(loops.pending[0].title, /Plata/);
  assert.equal(loops.pending[0].predicted, "advance to HM");
});

test("buildReminder lists root causes with treatment and pending outcomes", () => {
  const text = hook.buildReminder({
    rootCauses: [{ pattern: "low self-rating aloud", status: "active", treatment: "anchors" }],
    pending: [{ title: "Plata — screen", predicted: "advance to HM" }],
  });
  assert.match(text, /Активные корневые причины/);
  assert.match(text, /low self-rating aloud \[active\] → anchors/);
  assert.match(text, /Исходы без сверки/);
  assert.match(text, /Plata — screen/);
});

test("extractOpenLoops ignores the `## Outcome Log` table (anchored heading)", () => {
  const state = `## Outcome Log
| Date | Company | Role | Round | Result | Notes |
|------|---------|------|-------|--------|-------|
| 2026-07-20 | LawnStarter | PM | screen | pending | awaiting VP |

## Outcome: Plata — recruiter screen
- Predicted: advance to HM
- Result: pending
`;
  const loops = hook.extractOpenLoops(state);
  assert.equal(loops.pending.length, 1);
  assert.match(loops.pending[0].title, /Plata/);
});

test("scanOpenLoops fails open on a missing directory", () => {
  assert.deepEqual(hook.scanOpenLoops("/nonexistent-path-for-test"), {
    rootCauses: [],
    pending: [],
  });
});
