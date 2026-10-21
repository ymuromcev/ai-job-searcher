const { test } = require("node:test");
const assert = require("node:assert/strict");

const plan = require("./night_plan.js");

// Local-time constructors keep these tests independent of the machine TZ.
const local = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

test("computeDeadline: next local 06:30, capped at max hours", () => {
  // 22:00 → next morning 06:30 (8.5h < 10h cap)
  assert.equal(
    plan.computeDeadline(local(2026, 10, 21, 22)).getTime(),
    local(2026, 10, 22, 6, 30).getTime()
  );
  // 01:15 (started after midnight) → same morning 06:30
  assert.equal(
    plan.computeDeadline(local(2026, 10, 22, 1, 15)).getTime(),
    local(2026, 10, 22, 6, 30).getTime()
  );
  // 18:00 → 06:30 is 12.5h away → capped at 10h → 04:00
  assert.equal(
    plan.computeDeadline(local(2026, 10, 21, 18)).getTime(),
    local(2026, 10, 22, 4).getTime()
  );
  // custom stop time + cap
  assert.equal(
    plan.computeDeadline(local(2026, 10, 21, 23), { stopAt: "05:00", maxHours: 3 }).getTime(),
    local(2026, 10, 22, 2).getTime()
  );
  // exactly at stop time → the next day's stop time (then capped)
  assert.equal(
    plan.computeDeadline(local(2026, 10, 22, 6, 30), { maxHours: 30 }).getTime(),
    local(2026, 10, 23, 6, 30).getTime()
  );
  assert.throws(() => plan.computeDeadline(local(2026, 10, 21, 22), { stopAt: "6.30" }), /HH:MM/);
  assert.throws(() => plan.computeDeadline(local(2026, 10, 21, 22), { stopAt: "25:00" }), /HH:MM/);
});

test("prepareBatchSize: 1.5× the gap within [10, 40]", () => {
  assert.equal(plan.prepareBatchSize(0), 0);
  assert.equal(plan.prepareBatchSize(-3), 0);
  assert.equal(plan.prepareBatchSize(4), 10);
  assert.equal(plan.prepareBatchSize(20), 30);
  assert.equal(plan.prepareBatchSize(100), 40);
});

function state(over) {
  return {
    now: local(2026, 10, 22, 1),
    deadline: local(2026, 10, 22, 6, 30),
    target: 100,
    submittedTonight: 0,
    applyReady: 0,
    applyFresh: 0,
    inboxExhausted: false,
    ...over,
  };
}

test("decideNextStep: stop reasons come first, in order", () => {
  const late = plan.decideNextStep(state({ now: local(2026, 10, 22, 6, 30), applyFresh: 50 }));
  assert.equal(late.step, "stop");
  assert.equal(late.reason, "deadline");
  assert.equal(plan.decideNextStep(state({ usageStop: true })).reason, "usage_budget");
  const done = plan.decideNextStep(state({ submittedTonight: 100, applyFresh: 5 }));
  assert.deepEqual([done.step, done.reason], ["stop", "target_reached"]);
});

test("decideNextStep: apply once ≥10 fresh rows wait, else prepare the gap", () => {
  const a = plan.decideNextStep(state({ applyReady: 12, applyFresh: 12 }));
  assert.equal(a.step, "apply");

  const p = plan.decideNextStep(state({ applyReady: 4, applyFresh: 4 }));
  assert.equal(p.step, "prepare");
  assert.equal(p.need, 100);
  assert.equal(p.prepareTarget, 96);
  assert.equal(p.prepareBatch, 40);
  assert.equal(p.minutesLeft, 330);

  // Near the target: fewer than 10 fresh rows is enough when it covers the need.
  const tail = plan.decideNextStep(state({ submittedTonight: 97, applyReady: 3, applyFresh: 3 }));
  assert.equal(tail.step, "apply");
});

test("decideNextStep: rows already seen tonight are not fresh — the loop always ends", () => {
  // Inbox exhausted, a few fresh rows → one more apply round.
  assert.equal(
    plan.decideNextStep(state({ inboxExhausted: true, applyReady: 6, applyFresh: 2 })).step,
    "apply"
  );
  // Inbox exhausted, rows left only ones an apply pre already skipped → stop.
  const s = plan.decideNextStep(state({ inboxExhausted: true, applyReady: 6, applyFresh: 0 }));
  assert.deepEqual([s.step, s.reason], ["stop", "queue_empty"]);
  // Stale ready rows do not shrink the prepare gap.
  const p = plan.decideNextStep(state({ applyReady: 30, applyFresh: 0 }));
  assert.equal(p.step, "prepare");
  assert.equal(p.prepareTarget, 100);
});

test("countTsvSince: scanned by createdAt, prepared by fit_evaluated_at outside Inbox", () => {
  const since = "2026-10-22T05:00:00.000Z";
  const apps = [
    { createdAt: "2026-10-22T05:10:00Z", status: "Inbox" },
    {
      createdAt: "2026-10-22T05:10:00Z",
      status: "To Apply",
      fit_score: "Strong",
      fit_evaluated_at: "2026-10-22T06:00:00Z",
    },
    {
      createdAt: "2026-10-01T00:00:00Z",
      status: "To Apply",
      fit_score: "Medium",
      fit_evaluated_at: "2026-10-22T06:00:00Z",
    },
    {
      createdAt: "2026-10-01T00:00:00Z",
      status: "To Apply",
      fit_score: "Weak",
      fit_evaluated_at: "2026-10-22T06:00:00Z",
    },
    // evaluated tonight but reverted to Inbox (Notion failure) → not prepared
    {
      createdAt: "2026-10-01T00:00:00Z",
      status: "Inbox",
      fit_score: "Strong",
      fit_evaluated_at: "2026-10-22T06:00:00Z",
    },
    // evaluated yesterday
    {
      createdAt: "2026-10-01T00:00:00Z",
      status: "To Apply",
      fit_score: "Strong",
      fit_evaluated_at: "2026-10-21T06:00:00Z",
    },
  ];
  assert.deepEqual(plan.countTsvSince(apps, since), {
    scanned: 2,
    prepared: { total: 3, strong: 1, medium: 1, weak: 1 },
  });
  assert.deepEqual(plan.countTsvSince(apps, "garbage").prepared.total, 0);
});

test("summarizeApplyFiles: counts tonight's non-dry-run files only", () => {
  const since = "2026-10-22T05:00:00.000Z";
  const files = [
    {
      kind: "pre",
      data: {
        generated_at: "2026-10-22T07:00:00.000Z",
        jobs: [{ key: "a" }, { key: "b" }],
        manual: [{ key: "m", reason: "captcha" }],
        skipped: [{ key: "d", reason: "url_dead" }],
      },
    },
    { kind: "pre", data: { generated_at: "2026-10-21T07:00:00.000Z", jobs: [{ key: "old" }] } },
    {
      kind: "pre",
      data: { generated_at: "2026-10-22T07:30:00.000Z", dry_run: true, jobs: [{ key: "x" }] },
    },
    {
      kind: "results",
      data: {
        generated_at: "2026-10-22T08:00:00.000Z",
        results: [
          { key: "a", outcome: "submitted" },
          { key: "b", outcome: "failed", reason: "no_confirmation" },
          { key: "c", outcome: "manual", reason: "captcha" },
          { key: "e", outcome: "skipped", reason: "deadline" },
          { key: "f", outcome: "skipped", reason: "already_applied" },
          { key: "g", outcome: "error" },
          null,
        ],
      },
    },
    {
      kind: "results",
      data: {
        generated_at: "2026-10-22T08:10:00.000Z",
        dry_run: true,
        results: [{ outcome: "dry_run" }],
      },
    },
  ];
  const s = plan.summarizeApplyFiles(files, since);
  assert.equal(s.applyRounds, 1);
  assert.equal(s.queued, 2);
  assert.equal(s.submitted, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.manual, 2, "pre manual + submit manual");
  assert.equal(s.deferred, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.errors, 1);
  assert.deepEqual(s.seenKeys.sort(), ["a", "b", "d", "m"]);
});

const CTX = {
  generatedAt: "2026-10-22T06:00:00.000Z",
  salaryConfig: { levelParser: "pm" },
  roleTargets: { tracks: [{ id: "pm" }] },
  memory: {
    fitProfile: "# Fit\nreal achievements",
    writingStyle: "plain",
    resumeKeyPoints: null,
    feedback: [{ file: "memory/feedback_a.md", content: "be concrete" }],
  },
  unknownTierCompanies: ["Newco"],
};

test("buildRowPayload: evaluator contract with memory and JD body moved to files", () => {
  const entry = {
    key: "greenhouse:1",
    companyName: "Acme",
    title: "Senior PM",
    url: "https://example.com/1",
    jdText: "long body",
    jdStatus: "ok",
    jdStructure: { requirements: ["x"] },
    geo_decision: "allowed",
    salary: { min: 1, max: 2 },
    clBase: { key: "base" },
  };
  const p = plan.buildRowPayload(entry, CTX, {
    profileId: "demo",
    resumeVersions: { versions: { Growth: {} } },
    companyTiers: { Acme: "B" },
    paths: { memory: "/r/memory.md", jd: "/r/jd/x.md", result: "/r/results/x.json" },
    masterProfilePath: "/p/master_profile.md",
    storybankPath: null,
  });
  assert.equal(p.row_key, "greenhouse:1");
  assert.equal(p.result_path, "/r/results/x.json");
  assert.equal(p.jd_text_path, "/r/jd/x.md");
  assert.equal(p.memory_path, "/r/memory.md");
  assert.equal(p.jd_text, undefined, "the JD body is not inlined");
  assert.equal(p.profile_context.memory, undefined, "memory is not inlined");
  assert.equal(p.profile_context.companyTier, "B");
  assert.equal(p.profile_context.unknownTier, false);
  assert.deepEqual(p.profile_context.salaryConfig, { levelParser: "pm" });
  assert.deepEqual(p.profile_context.clBase, { key: "base" });
  assert.equal(p.tailoring.master_profile_path, "/p/master_profile.md");
  assert.equal(p.tailoring.target_role_title, "Senior PM");
});

test("renderMemoryMarkdown: every memory block under its own heading", () => {
  const md = plan.renderMemoryMarkdown(CTX.memory);
  assert.match(md, /## fitProfile\n\n# Fit\nreal achievements/);
  assert.match(md, /## writingStyle\n\nplain/);
  assert.match(md, /## resumeKeyPoints .*\n\n\(missing\)/);
  assert.match(md, /## feedback — memory\/feedback_a\.md\n\nbe concrete/);
});

const VERSIONS = new Set(["Growth", "Platform"]);
const CL = ["p1", "p2", "p3", "p4"];

test("normalizeRowResult: accepts evaluator output and enforces the commit contract", () => {
  const medium = plan.normalizeRowResult(
    {
      row_key: "k1",
      fitScore: "Medium",
      fitRationale: "overlap",
      clKey: "Acme_pm_20261022",
      clParagraphs: CL,
      resumeVer: "Growth",
      companyTier: "B",
      result_path: "/x",
    },
    "k1",
    { resumeVersionKeys: VERSIONS }
  );
  assert.deepEqual(medium.problems, []);
  assert.equal(medium.entry.key, "k1");
  assert.equal(medium.entry.row_key, undefined);
  assert.equal(medium.entry.result_path, undefined);
  assert.equal(medium.entry.companyTier, undefined);
  assert.equal(medium.companyTier, "B");

  const weak = plan.normalizeRowResult(
    { row_key: "k2", fitScore: "Skip", fitRationale: "no overlap", clParagraphs: CL },
    "k2"
  );
  assert.deepEqual(weak.problems, []);
  assert.equal(weak.entry.fitScore, "Weak");
  assert.ok(weak.entry.flags.includes("evaluator-skip"));
  assert.equal(weak.entry.clParagraphs, undefined, "Weak rows carry no cover letter");

  const strongNoTailor = plan.normalizeRowResult(
    {
      key: "k3",
      fitScore: "Strong",
      fitRationale: "core",
      clKey: "c",
      clParagraphs: CL,
      resumeVer: "Growth",
    },
    "k3",
    { resumeVersionKeys: VERSIONS }
  );
  assert.match(strongNoTailor.problems.join(), /Step 6\.5 skipped/);

  const strongEscalated = plan.normalizeRowResult(
    {
      key: "k4",
      fitScore: "Strong",
      fitRationale: "core",
      clKey: "c",
      clParagraphs: CL,
      resumeVer: "Growth",
      tailorEscalated: true,
      tailorEscalationReason: "no_growth_below_threshold",
    },
    "k4",
    { resumeVersionKeys: VERSIONS }
  );
  assert.deepEqual(strongEscalated.problems, []);

  const bad = plan.normalizeRowResult(
    { key: "other", fitScore: "Great", clParagraphs: ["one"], resumeVer: "Nope" },
    "k5",
    { resumeVersionKeys: VERSIONS }
  );
  assert.ok(bad.problems.some((p) => /key mismatch/.test(p)));
  assert.ok(bad.problems.some((p) => /fitScore "Great"/.test(p)));
  assert.ok(bad.problems.some((p) => /fitRationale/.test(p)));

  const badMedium = plan.normalizeRowResult(
    { key: "k6", fitScore: "Medium", fitRationale: "r", clParagraphs: ["a"], resumeVer: "Nope" },
    "k6",
    { resumeVersionKeys: VERSIONS }
  );
  assert.ok(badMedium.problems.some((p) => /4 non-empty strings/.test(p)));
  assert.ok(badMedium.problems.some((p) => /clKey/.test(p)));
  assert.ok(badMedium.problems.some((p) => /not in resume_versions/.test(p)));

  assert.deepEqual(plan.normalizeRowResult("unparseable", "k7").problems, ["not a JSON object"]);
});

test("collectRowResults: committable rows, tiers, missing and invalid listed", () => {
  const batch = [
    { key: "a", companyName: "Newco" },
    { key: "b", companyName: "Acme" },
    { key: "c", companyName: "Beta" },
    { key: "d", companyName: "Gamma" },
  ];
  const byKey = new Map([
    [
      "a",
      {
        row_key: "a",
        fitScore: "Medium",
        fitRationale: "r",
        clKey: "k",
        clParagraphs: CL,
        resumeVer: "Growth",
        companyTier: "C",
      },
    ],
    ["b", { row_key: "b", fitScore: "Weak", fitRationale: "r" }],
    ["c", { row_key: "c", fitScore: "Strong", fitRationale: "r" }],
  ]);
  const c = plan.collectRowResults(batch, byKey, {
    unknownTierCompanies: ["Newco"],
    resumeVersionKeys: VERSIONS,
  });
  assert.deepEqual(
    c.results.map((r) => r.key),
    ["a", "b"]
  );
  assert.deepEqual(c.companyTiers, { Newco: "C" });
  assert.deepEqual(c.missing, ["d"]);
  assert.equal(c.invalid.length, 1);
  assert.equal(c.invalid[0].key, "c");
  assert.deepEqual(c.untiered, []);
  assert.deepEqual(c.counts, { Strong: 0, Medium: 1, Weak: 1 });

  // A committed row of an unknown-tier company without a tier is reported.
  const noTier = plan.collectRowResults(
    [{ key: "a", companyName: "Newco" }],
    new Map([["a", { row_key: "a", fitScore: "Weak", fitRationale: "r" }]]),
    { unknownTierCompanies: ["Newco"] }
  );
  assert.deepEqual(noTier.untiered, ["Newco"]);
});

test("buildQuestionJob + safeKey", () => {
  assert.equal(plan.safeKey("greenhouse:acme/1 2"), "greenhouse_acme_1_2");
  const j = plan.buildQuestionJob(
    {
      key: "k",
      company: "Acme",
      title: "PM",
      url: "u",
      form_url: "f",
      ats: "lever",
      unanswered: [{ label: "Why?" }],
      fields: [{ id: "big" }],
    },
    { draft: "/d", review: "/r", answers: "/a", bank: "/b" }
  );
  assert.deepEqual(j.unanswered, [{ label: "Why?" }]);
  assert.equal(j.fields, undefined);
  assert.equal(j.answers_path, "/a");
  assert.equal(j.bank_dir, "/b");
});
