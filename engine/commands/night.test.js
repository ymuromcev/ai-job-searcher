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

function setup({ apps = [], profileExtra = {} } = {}) {
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
      ...profileExtra,
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
    // `wait` sleeps on the fake clock; a test hook may change the disk meanwhile.
    sleep: async (ms) => {
      clock.now = new Date(clock.now.getTime() + ms);
      clock.sleeps = (clock.sleeps || 0) + 1;
      if (clock.onSleep) clock.onSleep();
    },
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
  // Stop time 5 h after START in the runner's own time zone, so the 2 h cap
  // wins on any machine (CI runs in UTC, the owner's Mac in Pacific).
  const later = new Date(START.getTime() + 5 * 3600 * 1000);
  const stopAt = `${String(later.getHours()).padStart(2, "0")}:${String(later.getMinutes()).padStart(2, "0")}`;
  const r = await t.run({ phase: "start", target: 50, stopAt, maxHours: 2 });
  assert.equal(r.code, 0);
  assert.equal(r.json.started_at, START.toISOString());
  assert.equal(r.json.deadline, "2026-10-22T07:00:00.000Z", "capped at 2h");
  assert.equal(r.json.target, 50);
  assert.equal(r.json.apply_ready, 2, "every scored fit is apply-ready (RFC 069)");
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

  // Tonight's prepare context says Inbox is empty → nothing fresh → top up
  // with more companies (RFC 069 §6), never a queue_empty stop.
  writeJson(path.join(t.profileDir, "prepare_context.json"), {
    generatedAt: "2026-10-22T06:30:00.000Z",
    batch: [],
    stats: { inboxExhausted: true },
  });
  const r3 = await t.run({ phase: "check" });
  assert.equal(r3.code, 0);
  assert.equal(r3.json.step, "topup");
  assert.equal(r3.json.reason, null);

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
  const round = head.rows_dir;
  assert.equal(round, path.join(t.profileDir, ".prepare-state", "rows"));
  assert.match(fs.readFileSync(path.join(round, "memory.md"), "utf8"), /real achievements/);
  assert.equal(
    fs.readFileSync(path.join(round, "jd", "greenhouse_1.md"), "utf8"),
    "JD one\nline two"
  );
  const p1 = JSON.parse(fs.readFileSync(path.join(round, "payloads", "greenhouse_1.json"), "utf8"));
  assert.equal(p1.row_key, "greenhouse:1");
  assert.equal(p1.result_path, path.join(round, "results", "greenhouse_1.json"));
  assert.equal(p1.tailor_dir, path.join(round, "tailor", "greenhouse_1"));
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

  // A topup rewrites the context (new generatedAt, more rows): judged rows
  // keep their results. A new fresh batch without greenhouse:1 prunes it.
  writeJson(path.join(t.profileDir, "prepare_context.json"), {
    ...CTX,
    generatedAt: "2026-10-22T06:20:00.000Z",
    batch: [...CTX.batch, { key: "lever:3", companyName: "Gamma", title: "PM", url: "u3" }],
  });
  const topup = JSON.parse((await t.run({ phase: "prepare-fanout" })).out[0]);
  assert.deepEqual([topup.rows, topup.pending, topup.already_done], [3, 2, 1]);
  fs.mkdirSync(path.join(round, "tailor", "greenhouse_1"), { recursive: true });
  writeJson(path.join(t.profileDir, "prepare_context.json"), {
    ...CTX,
    generatedAt: "2026-10-23T06:00:00.000Z",
    batch: [CTX.batch[1]],
  });
  const fresh = JSON.parse((await t.run({ phase: "prepare-fanout" })).out[0]);
  assert.equal(fresh.pending, 1);
  assert.ok(fresh.pruned >= 4, "payload, jd, result and tailor dir of greenhouse:1 removed");
  for (const sub of ["payloads", "jd", "results"]) {
    assert.ok(
      !fs.readdirSync(path.join(round, sub)).some((n) => n.startsWith("greenhouse_1")),
      `${sub} pruned`
    );
  }
  assert.deepEqual(fs.readdirSync(path.join(round, "tailor")), []);

  assert.equal((await setup().run({ phase: "prepare-fanout" })).code, 1);
});

test("prepare-collect: writes prepare_results_<ts>.json from valid rows; exit 2 when none", async () => {
  const t = setup();
  writeJson(path.join(t.profileDir, "prepare_context.json"), CTX);
  const fan = await t.run({ phase: "prepare-fanout" });
  const round = JSON.parse(fan.out[0]).rows_dir;

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
  // …and its result file is removed so the next fan-out re-issues the row.
  assert.equal(fs.existsSync(path.join(round, "results", "greenhouse_1.json")), false);
  const refan = JSON.parse((await t.run({ phase: "prepare-fanout" })).out[0]);
  assert.equal(refan.pending, 1);
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

// --- RFC 069 -----------------------------------------------------------------

function localClockAfter(hours) {
  const d = new Date(START.getTime() + hours * 3600 * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

test("start: target / stop time come from the profile, else 30 / 11:00", async () => {
  const plain = setup();
  const r = await plain.run({ phase: "start" });
  assert.equal(r.json.target, 30);
  const d = new Date(r.json.deadline);
  const capped = d.getTime() === START.getTime() + 14 * 3600 * 1000;
  assert.ok(capped || (d.getHours() === 11 && d.getMinutes() === 0), "11:00 or the 14 h cap");

  const stopAt = localClockAfter(3);
  const own = setup({ profileExtra: { apply_target: 45, apply_stop_at: stopAt } });
  const r2 = await own.run({ phase: "start" });
  assert.equal(r2.json.target, 45);
  assert.equal(r2.json.deadline, new Date(START.getTime() + 3 * 3600 * 1000).toISOString());

  // A flag still wins over the profile.
  const flag = setup({ profileExtra: { apply_target: 45 } });
  assert.equal((await flag.run({ phase: "start", target: 7 })).json.target, 7);
});

const APPLY_CTX = {
  generated_at: "2026-10-22T06:00:00.000Z",
  jobs: [
    { key: "lever:a", company: "Acme", title: "PM", unanswered: [] },
    { key: "lever:b", company: "Beta", title: "PM", unanswered: [] },
  ],
};

test("ready: writes the manifest atomically with a context snapshot; idempotent per round", async () => {
  const t = setup();
  assert.equal((await t.run({ phase: "ready" })).code, 1, "needs a running night");
  await t.run({ phase: "start", maxHours: 6 });
  assert.equal((await t.run({ phase: "ready" })).code, 1, "needs an apply context");

  const stateDir = path.join(t.profileDir, ".apply-state");
  writeJson(path.join(stateDir, "apply_context.json"), APPLY_CTX);
  t.clock.now = new Date("2026-10-22T06:05:00.000Z");
  const r = await t.run({ phase: "ready" });
  assert.equal(r.code, 0);
  const readyDir = path.join(stateDir, "ready");
  assert.equal(r.json.manifest, path.join(readyDir, "2026-10-22T06-00-00-000Z.json"));
  assert.deepEqual(fs.readdirSync(readyDir), ["2026-10-22T06-00-00-000Z.json"], "no tmp left");
  const m = JSON.parse(fs.readFileSync(r.json.manifest, "utf8"));
  const roundDir = path.join(stateDir, "rounds", "2026-10-22T06-00-00-000Z");
  assert.deepEqual(m, {
    stamp: "2026-10-22T06-00-00-000Z",
    answers_dir: path.join(roundDir, "answers"),
    deadline: "2026-10-22T11:00:00.000Z",
    rows: ["lever:a", "lever:b"],
    created_at: "2026-10-22T06:05:00.000Z",
  });
  assert.ok(fs.statSync(m.answers_dir).isDirectory());
  const snap = JSON.parse(fs.readFileSync(path.join(roundDir, "apply_context.json"), "utf8"));
  assert.deepEqual(snap, APPLY_CTX);

  // Same context again → nothing new, even once the submitter moved it on.
  fs.mkdirSync(path.join(readyDir, "done"), { recursive: true });
  fs.renameSync(r.json.manifest, path.join(readyDir, "done", path.basename(r.json.manifest)));
  const again = await t.run({ phase: "ready" });
  assert.equal(again.json.already_written, true);
  assert.deepEqual(
    fs.readdirSync(readyDir).filter((n) => n.endsWith(".json")),
    []
  );

  // No jobs → no manifest.
  writeJson(path.join(stateDir, "apply_context.json"), {
    generated_at: "2026-10-22T07:00:00.000Z",
    jobs: [],
  });
  assert.equal((await t.run({ phase: "ready" })).json.manifest, null);
});

test("check: rows with the submitter → wait; a top-up scan re-opens prepare", async () => {
  const apps = [];
  for (let i = 0; i < 3; i++) apps.push(row({ key: `s${i}` }));
  const t = setup({ apps });
  await t.run({ phase: "start", target: 3 });
  const stateDir = path.join(t.profileDir, ".apply-state");
  writeJson(path.join(stateDir, "apply_pre-a.json"), {
    generated_at: "2026-10-22T05:10:00.000Z",
    jobs: apps.map((a) => ({ key: a.key })),
    manual: [],
    skipped: [],
  });
  writeJson(path.join(stateDir, "ready", "2026-10-22T05-10-00-000Z.json"), {
    stamp: "2026-10-22T05-10-00-000Z",
    answers_dir: path.join(stateDir, "rounds", "x", "answers"),
    deadline: "2026-10-22T11:00:00.000Z",
    rows: ["s0", "s1", "s2"],
    created_at: "2026-10-22T05:11:00.000Z",
  });
  t.clock.now = new Date("2026-10-22T05:20:00.000Z");
  const w = await t.run({ phase: "check" });
  assert.equal(w.code, 0);
  assert.deepEqual([w.json.step, w.json.pending_submit, w.json.need], ["wait", 3, 0]);

  // The submitter sent two (one twice — counted once) and skipped one.
  fs.mkdirSync(path.join(stateDir, "ready", "done"), { recursive: true });
  fs.renameSync(
    path.join(stateDir, "ready", "2026-10-22T05-10-00-000Z.json"),
    path.join(stateDir, "ready", "done", "2026-10-22T05-10-00-000Z.json")
  );
  writeJson(path.join(stateDir, "apply_results-a.json"), {
    generated_at: "2026-10-22T05:30:00.000Z",
    results: [
      { key: "s0", outcome: "submitted" },
      { key: "s1", outcome: "submitted" },
      { key: "s2", outcome: "manual", reason: "captcha" },
    ],
  });
  writeJson(path.join(stateDir, "apply_results-b.json"), {
    generated_at: "2026-10-22T05:31:00.000Z",
    results: [{ key: "s1", outcome: "submitted" }],
  });
  writeJson(path.join(t.profileDir, "prepare_context.json"), {
    generatedAt: "2026-10-22T05:40:00.000Z",
    batch: [],
    stats: { inboxExhausted: true },
  });
  t.clock.now = new Date("2026-10-22T05:45:00.000Z");
  const top = await t.run({ phase: "check" });
  assert.deepEqual(
    [top.json.step, top.json.submitted_tonight, top.json.need, top.json.pending_submit],
    ["topup", 2, 1, 0]
  );

  // The top-up scan added an Inbox row after that prepare round → prepare.
  const { apps: now } = applications.load(path.join(t.profileDir, "applications.tsv"));
  now.push(row({ key: "new", status: "Inbox", createdAt: "2026-10-22T05:50:00.000Z" }));
  applications.save(path.join(t.profileDir, "applications.tsv"), now);
  const p = await t.run({ phase: "check" });
  assert.deepEqual(
    [p.json.step, p.json.inbox_exhausted, p.json.scanned_since_prepare],
    ["prepare", false, 1]
  );

  // A manifest left over from an earlier night (deadline passed) is not
  // pending: it never makes tonight wait.
  writeJson(path.join(stateDir, "ready", "old.json"), {
    stamp: "old",
    answers_dir: "/tmp/a",
    deadline: "2026-10-21T18:00:00.000Z",
    rows: ["zz1", "zz2"],
    created_at: "2026-10-21T05:00:00.000Z",
  });
  assert.equal((await t.run({ phase: "check" })).json.pending_submit, 0);
});

test("wait: returns when the submitter is done, else after --minutes", async () => {
  const t = setup();
  await t.run({ phase: "start" });
  const readyDir = path.join(t.profileDir, ".apply-state", "ready");
  const m = {
    stamp: "x1",
    answers_dir: "/tmp/a",
    deadline: "2026-10-22T11:00:00.000Z",
    rows: ["k1"],
    created_at: "2026-10-22T05:00:00.000Z",
  };
  writeJson(path.join(readyDir, "x1.json"), m);
  const r = await t.run({ phase: "wait", minutes: 3 });
  assert.equal(r.code, 0);
  assert.equal(r.json.pending_submit, 1);
  assert.equal(r.json.waited_minutes, 3);

  // The submitter finishes during the second poll → wait returns early.
  t.clock.sleeps = 0;
  t.clock.onSleep = () => {
    if (t.clock.sleeps === 2) fs.rmSync(path.join(readyDir, "x1.json"));
  };
  const early = await t.run({ phase: "wait", minutes: 9 });
  assert.equal(early.json.pending_submit, 0);
  assert.equal(early.json.waited_minutes, 1);
});

test("finish: writes the morning report (submitted split by fit, skip reasons)", async () => {
  const t = setup({
    apps: [
      row({ key: "a", status: "Applied", fit_score: "Strong" }),
      row({ key: "b", status: "Applied", fit_score: "Weak" }),
      row({ key: "c", fit_score: "Medium" }),
    ],
  });
  await t.run({ phase: "start", target: 30 });
  writeJson(path.join(t.profileDir, ".apply-state", "apply_results-a.json"), {
    generated_at: "2026-10-22T06:00:00.000Z",
    results: [
      { key: "a", outcome: "submitted", evidence: { email: "thanks" } },
      { key: "b", outcome: "submitted" },
      { key: "c", outcome: "manual", reason: "captcha" },
    ],
  });
  t.clock.now = new Date(2026, 9, 22, 11, 0, 0);
  const r = await t.run({ phase: "finish", stopReason: "deadline" });
  assert.equal(r.code, 0);
  assert.equal(
    r.json.morning_report,
    path.join(t.profileDir, ".health", "morning-2026-10-22.json")
  );
  const rep = JSON.parse(fs.readFileSync(r.json.morning_report, "utf8"));
  assert.deepEqual(rep.submitted, { total: 2, strong: 1, medium: 0, weak: 1, other: 0 });
  assert.equal(rep.skip_line, "captcha 1");
  assert.equal(rep.why_below_target, "deadline");
  assert.equal(rep.applications[0].confirmation, "email");
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
