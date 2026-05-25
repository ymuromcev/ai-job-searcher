const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  runTailorLoop,
  decideExit,
  decideEscalation,
  DEFAULT_THRESHOLD,
} = require("./tailor_orchestrator.js");

const OPTS = { iterationCap: 6, threshold: 85, noGrowthDelta: 1 };

test("decideExit — threshold_met on iter 1", () => {
  assert.deepEqual(decideExit(90, 0, 1, OPTS), { done: true, reason: "threshold_met" });
});

test("decideExit — no_growth on iter 2 with delta 0", () => {
  assert.deepEqual(decideExit(70, 70, 2, OPTS), { done: true, reason: "no_growth" });
});

test("decideExit — iter 1 with 0 delta does NOT bail (lets loop run)", () => {
  assert.deepEqual(decideExit(0, 0, 1, OPTS), { done: false, reason: null });
});

test("decideExit — iteration_cap_reached", () => {
  // n == cap, below threshold, but delta is healthy (so no_growth doesn't fire).
  assert.deepEqual(decideExit(70, 60, 6, OPTS), {
    done: true,
    reason: "iteration_cap_reached",
  });
});

test("decideExit — threshold beats no_growth", () => {
  // Coverage hit threshold AND delta is 0 — threshold_met wins.
  assert.deepEqual(decideExit(85, 85, 3, OPTS), {
    done: true,
    reason: "threshold_met",
  });
});

test("decideEscalation — no_growth_below_threshold", () => {
  assert.deepEqual(
    decideEscalation(70, [], { threshold: 85, noGrowthDelta: 1, lastDelta: 0 }),
    { escalate: true, reason: "no_growth_below_threshold" },
  );
});

test("decideEscalation — uncertain_about_fact at threshold", () => {
  assert.deepEqual(
    decideEscalation(88, [{ fact: "led ML team of 8" }], {
      threshold: 85,
      noGrowthDelta: 1,
      lastDelta: 5,
    }),
    { escalate: true, reason: "uncertain_about_fact" },
  );
});

test("decideEscalation — clean auto-ship", () => {
  assert.deepEqual(
    decideEscalation(90, [], { threshold: 85, noGrowthDelta: 1, lastDelta: 5 }),
    { escalate: false, reason: null },
  );
});

test("runTailorLoop — threshold_met on iteration 2, no escalation", async () => {
  const responses = [
    { coverage_pct: 62, missing: ["foo", "bar"], resume_data: { v: 1 } },
    {
      coverage_pct: 88,
      missing: ["foo"],
      resume_data: { v: 2 },
      coverage_table: [{ jd_phrase: "x", status: "exact_match" }],
      uncertain_facts: [],
    },
  ];
  let calls = 0;
  const subagentCallFn = async () => responses[calls++];
  const out = await runTailorLoop({
    jdText: "jd",
    jdStructure: {},
    masterProfilePath: "/tmp/m.md",
    profileId: "test",
    targetRoleTitle: "PM",
    subagentCallFn,
  });
  assert.equal(calls, 2);
  assert.equal(out.iterations.length, 2);
  assert.equal(out.final_coverage_pct, 88);
  assert.equal(out.exit_reason, "threshold_met");
  assert.equal(out.escalate, false);
  assert.equal(out.escalation_reason, null);
  assert.deepEqual(out.resume_data, { v: 2 });
});

test("runTailorLoop — no_growth exit with escalation", async () => {
  const responses = [
    { coverage_pct: 60, missing: ["x"], resume_data: { v: 1 } },
    { coverage_pct: 60, missing: ["x"], resume_data: { v: 2 } },
  ];
  let calls = 0;
  const subagentCallFn = async () => responses[calls++];
  const out = await runTailorLoop({
    jdText: "jd",
    jdStructure: {},
    masterProfilePath: "/tmp/m.md",
    profileId: "test",
    targetRoleTitle: "PM",
    subagentCallFn,
  });
  assert.equal(calls, 2);
  assert.equal(out.exit_reason, "no_growth");
  assert.equal(out.escalate, true);
  assert.equal(out.escalation_reason, "no_growth_below_threshold");
});

test("runTailorLoop — iteration_cap_reached with steady growth below threshold", async () => {
  // Climb +5 each iter, never hits 85. After 6 iterations: 5,10,15,20,25,30.
  const responses = [];
  for (let i = 0; i < 6; i += 1) {
    responses.push({ coverage_pct: (i + 1) * 5, missing: ["x"], resume_data: { v: i } });
  }
  let calls = 0;
  const subagentCallFn = async () => responses[calls++];
  const out = await runTailorLoop({
    jdText: "jd",
    jdStructure: {},
    masterProfilePath: "/tmp/m.md",
    profileId: "test",
    targetRoleTitle: "PM",
    subagentCallFn,
    iterationCap: 6,
  });
  assert.equal(calls, 6);
  assert.equal(out.exit_reason, "iteration_cap_reached");
  assert.equal(out.final_coverage_pct, 30);
  // Below threshold but still growing → distinct escalation reason so user
  // sees the model wasn't stuck — it just ran out of budget.
  assert.equal(out.escalate, true);
  assert.equal(out.escalation_reason, "iteration_cap_below_threshold");
});

test("decideEscalation — iteration_cap_below_threshold (still climbing)", () => {
  assert.deepEqual(
    decideEscalation(70, [], { threshold: 85, noGrowthDelta: 1, lastDelta: 5 }),
    { escalate: true, reason: "iteration_cap_below_threshold" },
  );
});

test("runTailorLoop — threshold met with uncertain_facts → escalate", async () => {
  const responses = [
    {
      coverage_pct: 90,
      missing: [],
      resume_data: { v: 1 },
      uncertain_facts: [
        { fact: "led ML team of 8", source_hint: "not in master", suggested_action: "confirm" },
      ],
    },
  ];
  let calls = 0;
  const subagentCallFn = async () => responses[calls++];
  const out = await runTailorLoop({
    jdText: "jd",
    jdStructure: {},
    masterProfilePath: "/tmp/m.md",
    profileId: "test",
    targetRoleTitle: "PM",
    subagentCallFn,
  });
  assert.equal(out.exit_reason, "threshold_met");
  assert.equal(out.escalate, true);
  assert.equal(out.escalation_reason, "uncertain_about_fact");
  assert.equal(out.uncertain_facts.length, 1);
});

test("runTailorLoop — passes prev_resume_data and missing_from_prev to subagent", async () => {
  const captured = [];
  const responses = [
    { coverage_pct: 50, missing: ["alpha"], resume_data: { v: 1 } },
    { coverage_pct: 95, missing: [], resume_data: { v: 2 } },
  ];
  let calls = 0;
  const subagentCallFn = async (input) => {
    captured.push({
      prev: input.prev_resume_data,
      missing: input.missing_from_prev,
      n: input.iteration,
    });
    return responses[calls++];
  };
  await runTailorLoop({
    jdText: "jd",
    jdStructure: {},
    masterProfilePath: "/tmp/m.md",
    profileId: "test",
    targetRoleTitle: "PM",
    rowKey: "row-1",
    subagentCallFn,
  });
  assert.equal(captured.length, 2);
  // Iter 1: no prev.
  assert.equal(captured[0].prev, null);
  assert.deepEqual(captured[0].missing, []);
  assert.equal(captured[0].n, 1);
  // Iter 2: gets iter 1's data + missing.
  assert.deepEqual(captured[1].prev, { v: 1 });
  assert.deepEqual(captured[1].missing, ["alpha"]);
  assert.equal(captured[1].n, 2);
});

test("runTailorLoop — throws when subagentCallFn missing", async () => {
  await assert.rejects(
    () =>
      runTailorLoop({
        jdText: "x",
        jdStructure: {},
        masterProfilePath: "/tmp/m.md",
        profileId: "test",
        targetRoleTitle: "PM",
        subagentCallFn: null,
      }),
    /subagentCallFn is required/,
  );
});

test("runTailorLoop — DEFAULT_THRESHOLD sanity", () => {
  assert.equal(DEFAULT_THRESHOLD, 85);
});
