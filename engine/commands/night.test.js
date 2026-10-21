// `night` command tests — real temp profile on disk, injected clock and
// state dir. No network, no browser.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const applications = require("../core/applications_tsv.js");
const { readNightRuns, nightRunsPath } = require("../core/night_runs_log.js");
const { makeNightCommand, lockPath, EXIT_STOP, EXIT_LOCKED } = require("./night.js");

const START = new Date("2026-10-22T05:00:00.000Z");

function row(over) {
  return {
    key: over.key,
    source: "greenhouse",
    jobId: over.key,
    companyName: over.companyName || `Co ${over.key}`,
    title: "Product Manager",
    url: `https://job-boards.greenhouse.io/co/jobs/${over.key}`,
    locations: ["Remote, US"],
    status: "To Apply",
    notion_page_id: `page-${over.key}`,
    fit_score: "Strong",
    applied_date: "",
    apply_state: "",
    apply_note: "",
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    ...over,
  };
}

function setup({ apps = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aijs-night-"));
  const profilesDir = path.join(root, "profiles");
  const profileDir = path.join(profilesDir, "demo");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "profile.json"),
    JSON.stringify({
      id: "demo",
      resume: { versions_file: "resume_versions.json" },
      company_tiers: { Acme: "A" },
    })
  );
  fs.writeFileSync(
    path.join(profileDir, "resume_versions.json"),
    JSON.stringify({ versions: { Growth: { filename: "CV_Growth.docx" } } })
  );
  fs.writeFileSync(path.join(profileDir, "master_profile.md"), "# Master\n");
  applications.save(path.join(profileDir, "applications.tsv"), apps);
  const stateDir = path.join(root, "state");
  const clock = { now: new Date(START) };
  const cmd = makeNightCommand({
    stateDir: () => stateDir,
    now: () => new Date(clock.now),
  });
  const run = async (flags) => {
    const out = [];
    const err = [];
    const code = await cmd({
      profileId: "demo",
      profilesDir,
      env: {},
      flags,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    });
    return { code, out, err, json: lastJson(out) };
  };
  return { root, profileDir, stateDir, clock, run };
}

function lastJson(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (String(lines[i]).startsWith("{")) return JSON.parse(lines[i]);
  }
  return null;
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

test("phase is required", async () => {
  const t = setup();
  const r = await t.run({ phase: "" });
  assert.equal(r.code, 1);
  assert.match(r.err.join("\n"), /--phase <start\|check\|/);
});

test("start: takes the lock, sets the deadline; a second night exits 3 without touching it", async () => {
  const t = setup({ apps: [row({ key: "1" }), row({ key: "2", fit_score: "Weak" })] });
  const r = await t.run({ phase: "start", target: 50, stopAt: "06:30", maxHours: 2 });
  assert.equal(r.code, 0);
  assert.equal(r.json.started_at, START.toISOString());
  assert.equal(r.json.deadline, "2026-10-22T07:00:00.000Z", "capped at 2h");
  assert.equal(r.json.target, 50);
  assert.equal(r.json.apply_ready, 1, "only Strong / Medium rows are apply-ready");
  const lock = JSON.parse(fs.readFileSync(lockPath(t.stateDir, "demo"), "utf8"));
  assert.equal(lock.started_at, START.toISOString());

  t.clock.now = new Date("2026-10-22T06:00:00.000Z");
  const second = await t.run({ phase: "start" });
  assert.equal(second.code, EXIT_LOCKED);
  assert.match(second.err.join("\n"), /night already running/);
  const still = JSON.parse(fs.readFileSync(lockPath(t.stateDir, "demo"), "utf8"));
  assert.equal(still.started_at, START.toISOString(), "lock untouched");

  const bad = await setup().run({ phase: "start", stopAt: "late" });
  assert.equal(bad.code, 1);
});

test("start: a lock left by a dead night is logged as abandoned and replaced", async () => {
  const t = setup();
  await t.run({ phase: "start", maxHours: 2 });
  t.clock.now = new Date("2026-10-23T05:00:00.000Z");
  const r = await t.run({ phase: "start" });
  assert.equal(r.code, 0);
  assert.match(r.out.join("\n"), /never finished — logged as abandoned/);
  const runs = readNightRuns(nightRunsPath(t.profileDir));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].stop_reason, "abandoned");
  assert.equal(runs[0].started_at, START.toISOString());
  const lock = JSON.parse(fs.readFileSync(lockPath(t.stateDir, "demo"), "utf8"));
  assert.equal(lock.started_at, "2026-10-23T05:00:00.000Z");
});

test("check: needs a running night; apply when fresh rows wait; stop at the deadline", async () => {
  const apps = [];
  for (let i = 0; i < 12; i++) apps.push(row({ key: `s${i}` }));
  const t = setup({ apps });
  assert.equal((await t.run({ phase: "check" })).code, 1);

  await t.run({ phase: "start", target: 100 });
  t.clock.now = new Date("2026-10-22T06:00:00.000Z");
  const r = await t.run({ phase: "check" });
  assert.equal(r.code, 0);
  assert.equal(r.json.step, "apply");
  assert.equal(r.json.apply_ready, 12);
  assert.equal(r.json.apply_fresh, 12);

  // An apply round looked at all 12 tonight → they are no longer fresh;
  // the gap now sends the night to prepare.
  const stateDir = path.join(t.profileDir, ".apply-state");
  writeJson(path.join(stateDir, "apply_pre-a.json"), {
    generated_at: "2026-10-22T06:10:00.000Z",
    jobs: apps.map((a) => ({ key: a.key })),
    manual: [],
    skipped: [],
  });
  writeJson(path.join(stateDir, "apply_results-a.json"), {
    generated_at: "2026-10-22T06:20:00.000Z",
    results: [{ key: "s0", outcome: "submitted" }],
  });
  const r2 = await t.run({ phase: "check" });
  assert.equal(r2.json.step, "prepare");
  assert.equal(r2.json.submitted_tonight, 1);
  assert.equal(r2.json.apply_fresh, 0);
  assert.equal(r2.json.prepare_target, 99);
  assert.equal(r2.json.prepare_batch, 40);

  // Tonight's prepare context says Inbox is empty → nothing fresh → stop.
  writeJson(path.join(t.profileDir, "prepare_context.json"), {
    generatedAt: "2026-10-22T06:30:00.000Z",
    batch: [],
    stats: { inboxExhausted: true },
  });
  const r3 = await t.run({ phase: "check" });
  assert.equal(r3.code, EXIT_STOP);
  assert.equal(r3.json.reason, "queue_empty");

  // A round tonight that found nothing to judge counts as exhausted too.
  writeJson(path.join(t.profileDir, "prepare_context.json"), {
    generatedAt: "2026-10-22T06:40:00.000Z",
    batch: [],
    stats: { inboxExhausted: false },
  });
  assert.equal((await t.run({ phase: "check" })).json.inbox_exhausted, true);
  // …but a context from before tonight's start is ignored.
  writeJson(path.join(t.profileDir, "prepare_context.json"), {
    generatedAt: "2026-10-21T06:40:00.000Z",
    batch: [],
    stats: { inboxExhausted: true },
  });
  assert.equal((await t.run({ phase: "check" })).json.step, "prepare");

  t.clock.now = new Date("2026-10-22T20:00:00.000Z");
  const late = await t.run({ phase: "check" });
  assert.equal(late.code, EXIT_STOP);
  assert.equal(late.json.reason, "deadline");
});

const CTX = {
  generatedAt: "2026-10-22T06:00:00.000Z",
  memory: { fitProfile: "real achievements", writingStyle: "plain", feedback: [] },
  roleTargets: null,
  salaryConfig: null,
  unknownTierCompanies: ["Newco"],
  batch: [
    {
      key: "greenhouse:1",
      companyName: "Acme",
      title: "Senior PM",
      url: "u1",
      jdText: "JD one\nline two",
      jdStructure: { requirements: ["a"] },
      geo_decision: "allowed",
    },
    { key: "greenhouse:2", companyName: "Newco", title: "PM", url: "u2", unknownTier: true },
  ],
  stats: { inboxExhausted: false },
};

test("prepare-fanout: one payload per row, shared memory.md, JD body in its own file", async () => {
  const t = setup();
  writeJson(path.join(t.profileDir, "prepare_context.json"), CTX);
  const r = await t.run({ phase: "prepare-fanout" });
  assert.equal(r.code, 0);
  const head = JSON.parse(r.out[0]);
  assert.equal(head.rows, 2);
  assert.equal(head.pending, 2);
  const round = head.round_dir;
  assert.ok(round.startsWith(path.join(t.profileDir, ".prepare-state", "rounds")));
  assert.match(fs.readFileSync(path.join(round, "memory.md"), "utf8"), /real achievements/);
  assert.equal(
    fs.readFileSync(path.join(round, "jd", "greenhouse_1.md"), "utf8"),
    "JD one\nline two"
  );
  const p1 = JSON.parse(fs.readFileSync(path.join(round, "payloads", "greenhouse_1.json"), "utf8"));
  assert.equal(p1.row_key, "greenhouse:1");
  assert.equal(p1.result_path, path.join(round, "results", "greenhouse_1.json"));
  assert.equal(p1.profile_context.companyTier, "A");
  assert.deepEqual(Object.keys(p1.profile_context.resumeVersions.versions), ["Growth"]);
  assert.equal(p1.tailoring.master_profile_path, path.join(t.profileDir, "master_profile.md"));
  assert.equal(p1.tailoring.storybank_path, null);
  const p2 = JSON.parse(fs.readFileSync(path.join(round, "payloads", "greenhouse_2.json"), "utf8"));
  assert.equal(p2.jd_text_path, null, "no JD body → no JD file");
  assert.equal(p2.profile_context.unknownTier, true);
  assert.match(r.out[1], /greenhouse_1\.json\tAcme — Senior PM$/);

  // A row with a result is not re-issued.
  writeJson(p1.result_path, { row_key: "greenhouse:1", fitScore: "Weak", fitRationale: "r" });
  const again = await t.run({ phase: "prepare-fanout" });
  assert.equal(JSON.parse(again.out[0]).pending, 1);
  assert.equal(JSON.parse(again.out[0]).already_done, 1);

  assert.equal((await setup().run({ phase: "prepare-fanout" })).code, 1);
});

test("prepare-collect: writes prepare_results_<ts>.json from valid rows; exit 2 when none", async () => {
  const t = setup();
  writeJson(path.join(t.profileDir, "prepare_context.json"), CTX);
  const fan = await t.run({ phase: "prepare-fanout" });
  const round = JSON.parse(fan.out[0]).round_dir;

  const none = await t.run({ phase: "prepare-collect" });
  assert.equal(none.code, EXIT_STOP);
  assert.equal(none.json.results_file, null);
  assert.deepEqual(none.json.missing, ["greenhouse:1", "greenhouse:2"]);

  writeJson(path.join(round, "results", "greenhouse_1.json"), {
    row_key: "greenhouse:1",
    fitScore: "Medium",
    fitRationale: "growth overlap",
    clKey: "Acme_senior-pm_20261022",
    clParagraphs: ["p1", "p2", "p3", "p4"],
    resumeVer: "Growth",
  });
  writeJson(path.join(round, "results", "greenhouse_2.json"), {
    row_key: "greenhouse:2",
    fitScore: "Weak",
    fitRationale: "outside domain",
    companyTier: "C",
  });
  t.clock.now = new Date(2026, 9, 22, 1, 2, 3);
  const r = await t.run({ phase: "prepare-collect" });
  assert.equal(r.code, 0);
  assert.equal(r.json.committable, 2);
  assert.equal(path.basename(r.json.results_file), "prepare_results_20261022_010203.json");
  const written = JSON.parse(fs.readFileSync(r.json.results_file, "utf8"));
  assert.equal(written.profileId, "demo");
  assert.deepEqual(written.companyTiers, { Newco: "C" });
  assert.deepEqual(
    written.results.map((x) => [x.key, x.fitScore]),
    [
      ["greenhouse:1", "Medium"],
      ["greenhouse:2", "Weak"],
    ]
  );
  assert.equal(written.results[0].row_key, undefined);

  // An invalid row is left out and reported.
  writeJson(path.join(round, "results", "greenhouse_1.json"), {
    row_key: "greenhouse:1",
    fitScore: "Medium",
    fitRationale: "r",
    resumeVer: "Unknown",
  });
  const r2 = await t.run({ phase: "prepare-collect" });
  assert.equal(r2.json.committable, 1);
  assert.equal(r2.json.invalid[0].key, "greenhouse:1");
  assert.match(r2.err.join("\n"), /invalid greenhouse:1: .*clParagraphs/);
});

test("apply-fanout: one job file per job with open questions; answers dir always exists", async () => {
  const t = setup();
  writeJson(path.join(t.profileDir, ".apply-state", "apply_context.json"), {
    generated_at: "2026-10-22T07:00:00.000Z",
    jobs: [
      {
        key: "lever:a",
        company: "Acme",
        title: "PM",
        url: "u",
        form_url: "f",
        ats: "lever",
        fields: [{ id: "x" }],
        answers: [],
        unanswered: [{ field_id: "q", label: "Why us?", type: "textarea", required: true }],
      },
      { key: "lever:b", company: "Beta", title: "PM", unanswered: [] },
    ],
  });
  const r = await t.run({ phase: "apply-fanout" });
  assert.equal(r.code, 0);
  const head = JSON.parse(r.out[0]);
  assert.equal(head.jobs, 2);
  assert.equal(head.with_questions, 1);
  assert.ok(fs.statSync(head.answers_dir).isDirectory());
  assert.ok(fs.statSync(head.bank_dir).isDirectory());
  const jobFile = r.out[1].split("\t")[0];
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(job.key, "lever:a");
  assert.equal(job.answers_path, path.join(head.answers_dir, "lever_a.json"));
  assert.equal(job.fields, undefined);
  assert.match(r.out[1], /Acme — PM \(1 open\)$/);

  assert.equal((await setup().run({ phase: "apply-fanout" })).code, 1);
});

test("finish: one line in apply_runs.jsonl with counts recomputed from disk; lock released", async () => {
  const t = setup({
    apps: [
      row({ key: "old", createdAt: "2026-10-01T00:00:00.000Z" }),
      row({
        key: "new",
        status: "Applied",
        createdAt: "2026-10-22T05:05:00.000Z",
        fit_evaluated_at: "2026-10-22T06:00:00.000Z",
        fit_score: "Medium",
      }),
    ],
  });
  assert.equal((await t.run({ phase: "finish", stopReason: "deadline" })).code, 1);

  await t.run({ phase: "start", target: 100 });
  const stateDir = path.join(t.profileDir, ".apply-state");
  writeJson(path.join(stateDir, "apply_pre-a.json"), {
    generated_at: "2026-10-22T07:00:00.000Z",
    jobs: [{ key: "new" }, { key: "x" }],
    manual: [{ key: "m", reason: "captcha" }],
    skipped: [],
  });
  writeJson(path.join(stateDir, "apply_results-a.json"), {
    generated_at: "2026-10-22T07:30:00.000Z",
    results: [
      { key: "new", outcome: "submitted" },
      { key: "x", outcome: "skipped", reason: "deadline" },
    ],
  });
  t.clock.now = new Date("2026-10-22T13:30:00.000Z");
  const r = await t.run({ phase: "finish", stopReason: "deadline" });
  assert.equal(r.code, 0);
  assert.match(
    r.out[0],
    /night finished \(deadline\): 1 submitted, 1 manual, 0 failed, 1 deferred/
  );
  const runs = readNightRuns(nightRunsPath(t.profileDir));
  assert.equal(runs.length, 1);
  assert.deepEqual(
    [
      runs[0].scanned,
      runs[0].prepared,
      runs[0].medium,
      runs[0].queued,
      runs[0].submitted,
      runs[0].manual,
      runs[0].deferred,
      runs[0].apply_rounds,
    ],
    [1, 1, 1, 2, 1, 1, 1, 1]
  );
  assert.equal(runs[0].finished_at, "2026-10-22T13:30:00.000Z");
  assert.equal(fs.existsSync(lockPath(t.stateDir, "demo")), false);
  assert.equal((await t.run({ phase: "finish", stopReason: "deadline" })).code, 1);
});

test("the CLI registers the real night handler", async () => {
  const { runCli } = require("../cli.js");
  const err = [];
  const code = await runCli({
    argv: ["night", "--profile", "demo"],
    stdout: { write: () => {} },
    stderr: { write: (s) => err.push(String(s)) },
    commands: { night: require("./night.js") },
  });
  assert.equal(code, 1);
  assert.match(err.join(""), /--phase <start\|check\|prepare-fanout/);
});
