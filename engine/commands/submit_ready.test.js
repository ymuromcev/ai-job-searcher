// `submit-ready` tests — real temp profile on disk, injected clock, state dir,
// submit runner and notifier. No network, no browser, no osascript.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const applications = require("../core/applications_tsv.js");
const {
  makeSubmitReadyCommand,
  escapeAppleScript,
  submitViaApply,
  LOCK_FILE,
  MAX_ATTEMPTS,
} = require("./submit_ready.js");
const { lockPath: nightLockPath } = require("./night.js");

// Local-time constructor: the window is local time, so are these clocks.
const local = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const IN_WINDOW = local(2026, 11, 10, 3);
const AFTER_WINDOW = local(2026, 11, 10, 11, 5);

function row(key, over = {}) {
  return {
    key,
    source: "lever",
    jobId: key,
    companyName: `Co ${key}`,
    title: "Product Manager",
    url: `https://jobs.lever.co/co/${key}`,
    status: "To Apply",
    fit_score: "Strong",
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-09T00:00:00.000Z",
    ...over,
  };
}

function setup({ profileExtra = {}, apps = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aijs-submit-"));
  const profilesDir = path.join(root, "profiles");
  const profileDir = path.join(profilesDir, "demo");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "profile.json"),
    JSON.stringify({ id: "demo", ...profileExtra })
  );
  applications.save(path.join(profileDir, "applications.tsv"), apps);
  const stateDir = path.join(root, "state");
  const clock = { now: new Date(IN_WINDOW) };
  const calls = [];
  const notes = [];
  const behavior = { code: 0, outcomes: {} };
  const apply = path.join(profileDir, ".apply-state");
  const runSubmit = async (args) => {
    calls.push(args);
    if (behavior.code !== 0) return { code: behavior.code };
    const file = path.join(apply, `apply_results-${calls.length}.json`);
    fs.mkdirSync(apply, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        generated_at: new Date(clock.now).toISOString(),
        results: args.context.jobs.map((j) => ({
          key: j.key,
          company: j.company,
          title: j.title,
          outcome: behavior.outcomes[j.key] || "submitted",
          reason: behavior.outcomes[j.key] ? "captcha" : undefined,
        })),
      })
    );
    return { code: 0, resultsFile: file };
  };
  const overrides = {
    stateDir: () => stateDir,
    now: () => new Date(clock.now),
    pid: 4242,
    pidAlive: (pid) => pid === 4242 || pid === 777,
    runSubmit,
    notify: async (title, text) => {
      notes.push({ title, text });
      return true;
    },
  };
  const cmd = makeSubmitReadyCommand(overrides);
  const run = async (flags = {}) => {
    const out = [];
    const err = [];
    const code = await cmd({
      profileId: "demo",
      profilesDir,
      env: {},
      flags,
      stdout: (s) => out.push(String(s)),
      stderr: (s) => err.push(String(s)),
    });
    return { code, out, err };
  };
  const readyDir = path.join(apply, "ready");
  return { root, profileDir, stateDir, clock, calls, notes, behavior, run, readyDir, apply };
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

// A manifest + its round snapshot, as `night --phase ready` writes them.
function addManifest(t, stamp, rows, { deadline = local(2026, 11, 10, 11), jobs } = {}) {
  const roundDir = path.join(t.apply, "rounds", stamp);
  fs.mkdirSync(path.join(roundDir, "answers"), { recursive: true });
  writeJson(path.join(roundDir, "apply_context.json"), {
    generated_at: "2026-11-10T09:00:00.000Z",
    jobs: (jobs || rows).map((k) => ({ key: k, company: `Co ${k}`, title: "PM", unanswered: [] })),
  });
  const manifest = {
    stamp,
    answers_dir: path.join(roundDir, "answers"),
    deadline: deadline.toISOString(),
    rows,
    created_at: "2026-11-10T09:01:00.000Z",
  };
  writeJson(path.join(t.readyDir, `${stamp}.json`), manifest);
  return manifest;
}

test("inside the window: manifests in stamp order, snapshot rows only, done/ with the result", async () => {
  const t = setup();
  addManifest(t, "2026-11-10T09-00-00-000Z", ["b1"]);
  // The snapshot also holds a job that is not in the manifest: never sent.
  addManifest(t, "2026-11-10T08-00-00-000Z", ["a1", "a2"], {
    jobs: ["a1", "a2", "zz"],
    deadline: local(2026, 11, 10, 9),
  });
  const r = await t.run();
  assert.equal(r.code, 0);
  assert.equal(t.calls.length, 2);
  assert.deepEqual(
    t.calls.map((c) => c.context.jobs.map((j) => j.key)),
    [["a1", "a2"], ["b1"]]
  );
  // --deadline: the manifest's own when earlier, else the window close.
  assert.equal(t.calls[0].deadline, local(2026, 11, 10, 9).toISOString());
  assert.equal(t.calls[1].deadline, local(2026, 11, 10, 11).toISOString());
  assert.equal(t.calls[0].concurrency, 4);
  assert.match(t.calls[0].answersDir, /rounds\/2026-11-10T08-00-00-000Z\/answers$/);

  assert.deepEqual(
    fs.readdirSync(t.readyDir).filter((n) => n.endsWith(".json")),
    [],
    "nothing left waiting"
  );
  assert.deepEqual(fs.readdirSync(path.join(t.readyDir, "claimed")), []);
  const done = JSON.parse(
    fs.readFileSync(path.join(t.readyDir, "done", "2026-11-10T08-00-00-000Z.json"), "utf8")
  );
  assert.equal(done.outcome, "submitted");
  assert.equal(done.result_file, path.join(t.apply, "apply_results-1.json"));
  assert.deepEqual(done.rows, ["a1", "a2"]);
  assert.match(r.out.at(-1), /2 submitted/);
  assert.equal(fs.existsSync(path.join(t.stateDir, "demo", LOCK_FILE)), false, "lock released");

  // A second run finds nothing.
  const again = await t.run();
  assert.equal(t.calls.length, 2);
  assert.match(again.out.at(-1), /nothing ready/);
});

test("a manifest past its deadline is not submitted: done/ as expired", async () => {
  const t = setup();
  addManifest(t, "s1", ["a1"], { deadline: local(2026, 11, 10, 2, 30) });
  await t.run();
  assert.equal(t.calls.length, 0);
  const done = JSON.parse(fs.readFileSync(path.join(t.readyDir, "done", "s1.json"), "utf8"));
  assert.equal(done.outcome, "expired");
});

test("outside the window nothing is submitted; the profile's apply_window is honoured", async () => {
  const t = setup({ profileExtra: { apply_window: "04:00-06:00" } });
  addManifest(t, "s1", ["a1"]);
  t.clock.now = local(2026, 11, 10, 3, 30);
  await t.run();
  assert.equal(t.calls.length, 0);
  assert.ok(fs.existsSync(path.join(t.readyDir, "s1.json")), "still waiting");
  t.clock.now = local(2026, 11, 10, 4, 0);
  await t.run();
  assert.equal(t.calls.length, 1);

  const bad = setup({ profileExtra: { apply_window: "late" } });
  const r = await bad.run();
  assert.equal(r.code, 1);
  assert.match(r.err.join("\n"), /invalid apply_window/);
});

test("a second submitter exits while the first holds the lock; a dead holder is replaced", async () => {
  const t = setup();
  addManifest(t, "s1", ["a1"]);
  const lock = path.join(t.stateDir, "demo", LOCK_FILE);
  writeJson(lock, { pid: 777, started_at: new Date(IN_WINDOW).toISOString() });
  const r = await t.run();
  assert.match(r.out.join("\n"), /another submitter \(pid 777\) is running/);
  assert.equal(t.calls.length, 0);
  assert.ok(fs.existsSync(lock), "the live holder's lock is untouched");

  writeJson(lock, { pid: 999, started_at: new Date(IN_WINDOW).toISOString() });
  await t.run();
  assert.equal(t.calls.length, 1, "pid 999 is dead — taken over");
});

test("a manifest claimed by a run that died is submitted first", async () => {
  const t = setup();
  addManifest(t, "s2", ["b1"]);
  addManifest(t, "s1", ["a1"]);
  fs.mkdirSync(path.join(t.readyDir, "claimed"), { recursive: true });
  fs.renameSync(path.join(t.readyDir, "s2.json"), path.join(t.readyDir, "claimed", "s2.json"));
  await t.run();
  assert.deepEqual(
    t.calls.map((c) => c.context.jobs[0].key),
    ["b1", "a1"]
  );
});

test("a failed submit run goes back to the queue, then gives up after MAX_ATTEMPTS", async () => {
  const t = setup();
  addManifest(t, "s1", ["a1"]);
  addManifest(t, "s2", ["b1"]);
  t.behavior.code = 1;
  await t.run();
  assert.equal(t.calls.length, 1, "stops after the failure, retries next start");
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.readyDir, "s1.json"), "utf8")).attempts, 1);
  for (let i = 1; i < MAX_ATTEMPTS; i++) await t.run();
  const done = JSON.parse(fs.readFileSync(path.join(t.readyDir, "done", "s1.json"), "utf8"));
  assert.equal(done.outcome, "submit_failed");
  assert.equal(done.attempts, MAX_ATTEMPTS);
});

test("after the window: one morning report + one notification per date", async () => {
  const t = setup({
    apps: [row("a1"), row("a2", { fit_score: "Weak" }), row("a3", { fit_score: "Medium" })],
  });
  t.behavior.outcomes = { a3: "manual" };
  addManifest(t, "s1", ["a1", "a2", "a3"]);
  writeJson(path.join(t.profileDir, ".health", "apply_runs.jsonl"), {
    started_at: local(2026, 11, 9, 22).toISOString(),
    finished_at: local(2026, 11, 10, 9).toISOString(),
    target: 30,
    stop_reason: "usage_budget",
  });
  await t.run(); // inside the window: submits
  t.clock.now = new Date(AFTER_WINDOW);
  const r = await t.run();
  assert.equal(r.code, 0);
  assert.equal(t.notes.length, 1);
  assert.equal(t.notes[0].title, "Ночные отклики");
  assert.match(t.notes[0].text, /^Подано 2 из 30 \(Strong 1 · Medium 0 · Weak 1\)/);
  assert.match(t.notes[0].text, /лимит Claude/);
  assert.match(t.notes[0].text, /captcha 1/);
  const rep = JSON.parse(
    fs.readFileSync(path.join(t.profileDir, ".health", "morning-2026-11-10.json"), "utf8")
  );
  assert.equal(rep.submitted.total, 2);
  assert.equal(rep.since, local(2026, 11, 9, 22).toISOString());
  assert.ok(fs.existsSync(path.join(t.profileDir, ".health", "morning-2026-11-10.notified")));

  // Every later start that day (and the next night before 02:00): silent.
  t.clock.now = local(2026, 11, 10, 15);
  await t.run();
  t.clock.now = local(2026, 11, 11, 1);
  await t.run();
  assert.equal(t.notes.length, 1);
});

test("the notification waits for a night that is still running, up to an hour", async () => {
  const t = setup();
  writeJson(nightLockPath(t.stateDir, "demo"), {
    started_at: local(2026, 11, 9, 22).toISOString(),
    deadline: local(2026, 11, 10, 11).toISOString(),
    target: 30,
  });
  t.clock.now = new Date(AFTER_WINDOW);
  const r = await t.run();
  assert.equal(t.notes.length, 0);
  assert.match(r.out.join("\n"), /night_running/);
  t.clock.now = local(2026, 11, 10, 11, 50);
  await t.run();
  assert.equal(t.notes.length, 0, "still inside the hour");
  // An hour past its deadline the night is dead: report it as broken off.
  t.clock.now = local(2026, 11, 10, 12, 5);
  await t.run();
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0].text, /ночная сессия оборвалась/);
});

test("no night at all still sends one notification (a silent failure is visible)", async () => {
  const t = setup();
  t.clock.now = new Date(AFTER_WINDOW);
  await t.run();
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0].text, /ночного запуска не было/);
});

test("escapeAppleScript: quotes and backslashes cannot break out of the string", () => {
  assert.equal(escapeAppleScript('say "hi" \\ bye'), 'say \\"hi\\" \\\\ bye');
});

test("submitViaApply: apply's submit phase reads the manifest snapshot, not the live context", async () => {
  const t = setup();
  const profile = require("../core/profile_loader.js").loadProfile("demo", {
    profilesDir: path.join(t.root, "profiles"),
  });
  const answersDir = path.join(t.apply, "rounds", "x", "answers");
  fs.mkdirSync(answersDir, { recursive: true });
  assert.equal(fs.existsSync(path.join(t.apply, "apply_context.json")), false, "no live context");
  const out = [];
  const res = await submitViaApply({
    ctx: {
      profilesDir: path.join(t.root, "profiles"),
      env: {},
      stdout: (s) => out.push(String(s)),
      stderr: (s) => out.push(String(s)),
    },
    profile,
    context: { generated_at: "2026-11-10T09:00:00.000Z", jobs: [] },
    answersDir,
    deadline: local(2026, 11, 10, 11).toISOString(),
    concurrency: 4,
  });
  assert.equal(res.code, 0, out.join("\n"));
  assert.match(out.join("\n"), /apply submit: 0 job\(s\)/);
  assert.ok(res.resultsFile && fs.existsSync(res.resultsFile), "results file found");
});

test("the CLI registers submit-ready", async () => {
  const { runCli, KNOWN_COMMANDS } = require("../cli.js");
  assert.ok(KNOWN_COMMANDS.includes("submit-ready"));
  let seen = null;
  const code = await runCli({
    argv: ["submit-ready", "--profile", "demo", "--concurrency", "2"],
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    commands: {
      "submit-ready": async (ctx) => {
        seen = ctx;
        return 0;
      },
    },
  });
  assert.equal(code, 0);
  assert.equal(seen.flags.concurrency, 2);
});
