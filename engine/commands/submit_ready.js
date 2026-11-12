// `submit-ready` command — the submitter outside Claude (RFC 069 §2, BL-225).
//
//   node engine/cli.js submit-ready --profile <id> [--concurrency 4]
//
// Started by launchd every 15 minutes (scripts/install_submitter.sh). No model
// is in this loop: it is deterministic engine code. The night writes ready
// manifests (`night --phase ready`, profiles/<id>/.apply-state/ready/*.json);
// this command:
//
//   1. does nothing outside the submit window — profile `apply_window`,
//      default "02:00-11:00" local;
//   2. takes its own lock (submit.lock next to night.lock, one submitter per
//      profile; it never waits for or blocks the night). A lock is taken
//      over only when its pid is gone — never from a live submitter, however
//      long it runs. Every start (inside the window or not, lock or not)
//      writes a heartbeat (submit-heartbeat.json next to the lock): `night
//      check` warns when the night waits on a submitter that is not running;
//   3. claims each manifest in stamp order with an atomic rename
//      ready/<stamp>.json → ready/claimed/<stamp>.json, so a manifest is
//      submitted by one run only; a claimed manifest left by a run that died
//      is picked up again first (the per-row guards — applied_date,
//      apply_state=submitted, the `submitting:` mark — prevent a double
//      submit);
//   4. runs the existing submit code (`apply --phase submit`, in process via
//      makeApplyCommand) on the manifest's rows with --deadline = the
//      earlier of the manifest deadline and the window close. The target
//      (30) is a minimum, not a cap: the submitter never stops at it.
//      The manifest only names the round (`stamp`) and its rows: the round
//      folder is always .apply-state/rounds/<stamp>/ (the manifest's own
//      `answers_dir` is ignored) and must resolve inside .apply-state;
//   5. moves the manifest to ready/done/<stamp>.json with the result file.
//      A manifest past its deadline goes to done/ as "expired" (its rows
//      stay queued for the next night); a failed submit run is retried on
//      the next start, up to MAX_ATTEMPTS times.
//
// On its first run after the window closes it runs the owner's questions
// step (`questions --apply`, RFC 070: pull his Notion answers, requeue the
// rows they unblock, push tonight's blocking questions), refreshes the
// morning report (.health/morning-<date>.json), runs the mail check over
// both mailboxes (`check --auto --apply`, RFC 071: rejections and invites go
// to the TSV + Notion) and sends one macOS notification for that date
// (marker .health/morning-<date>.notified), plus a separate one when an
// interview invite came in.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const profileLoader = require("../core/profile_loader.js");
const applicationsTsv = require("../core/applications_tsv.js");
const { resolveProfilesDir } = require("../core/paths.js");
const readyManifest = require("../core/ready_manifest.js");
const morning = require("../core/morning_report.js");
const nightLog = require("../core/night_runs_log.js");
const { createAtomic } = require("../core/file_lock.js");
const plan = require("../core/night_plan.js");
const { defaultStateDir } = require("./board.js");
const night = require("./night.js");

const LOCK_FILE = "submit.lock";
const STAMP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NIGHT_STALE_GRACE_MS = 60 * 60 * 1000;
// After the window closes, wait this long for a still-running night to
// finish before the notification goes out anyway.
const NOTIFY_GRACE_MS = 60 * 60 * 1000;
const DEFAULT_CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function escapeAppleScript(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function macNotify(title, text) {
  if (process.platform !== "darwin") return Promise.resolve(false);
  const script = `display notification "${escapeAppleScript(text)}" with title "${escapeAppleScript(title)}"`;
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (err) => (err ? reject(err) : resolve(true)));
  });
}

// Runs the existing submit phase in process. apply.js reads its context from
// .apply-state/apply_context.json; the manifest's snapshot (filtered to its
// rows) is served in its place, everything else is the real filesystem.
async function submitViaApply({ ctx, profile, context, answersDir, deadline, concurrency }) {
  const { makeApplyCommand } = require("./apply.js");
  const contextPath = path.resolve(profile.paths.root, ".apply-state", "apply_context.json");
  const snapshot = JSON.stringify(context);
  const apply = makeApplyCommand({
    readFile: (p) => (path.resolve(p) === contextPath ? snapshot : fs.readFileSync(p, "utf8")),
    fileExists: (p) => path.resolve(p) === contextPath || fs.existsSync(p),
  });
  let resultsFile = null;
  const code = await apply({
    profileId: profile.id,
    profilesDir: ctx.profilesDir,
    env: ctx.env || process.env,
    flags: { phase: "submit", answersFile: answersDir, deadline, concurrency },
    stdout: (s) => {
      const m = String(s).match(/^results: (.+)$/);
      if (m) resultsFile = path.resolve(process.cwd(), m[1].trim());
      ctx.stdout(s);
    },
    stderr: ctx.stderr,
  });
  return { code, resultsFile };
}

// The owner's questions queue (RFC 070), in process: pull his Notion
// answers, requeue the rows they unblock, push tonight's new blocking
// questions — so the morning report counts them and they are in Notion by
// the time he reads it.
async function questionsViaCommand({ ctx, profile }) {
  const { makeQuestionsCommand } = require("./questions.js");
  return makeQuestionsCommand()({
    profileId: profile.id,
    profilesDir: ctx.profilesDir,
    env: ctx.env || process.env,
    flags: { apply: true },
    stdout: ctx.stdout,
    stderr: ctx.stderr,
  });
}

// The morning mail check (RFC 071, BL-234): the same `check --auto --apply`
// the fly.io cron ran, in process, over the main and the apply mailbox
// (RFC 068 §5) — replies to the night's applications land in the apply
// mailbox. Its JSON run log is parsed into a short summary for the
// notification and is not echoed into the submitter log.
async function mailCheckViaCommand({ ctx, profile }) {
  const { makeCheckCommand } = require("./check.js");
  let parsed = null;
  const code = await makeCheckCommand()({
    profileId: profile.id,
    profilesDir: ctx.profilesDir,
    env: ctx.env || process.env,
    flags: { auto: true, apply: true },
    stdout: (s) => {
      const text = String(s).trim();
      if (text.startsWith("{")) {
        try {
          const json = JSON.parse(text);
          if (json && typeof json.emailsFound === "number") {
            parsed = json;
            return;
          }
        } catch {
          // not the run log — fall through and log it
        }
      }
      ctx.stdout(s);
    },
    stderr: ctx.stderr,
  });
  const summary = parsed ? morning.mailCheckSummary(parsed) : null;
  if (summary && code) summary.incomplete = true;
  return { code, summary };
}

// A stalled mailbox must not hold the morning notification forever.
const MAIL_CHECK_TIMEOUT_MS = 10 * 60 * 1000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function makeDefaultDeps() {
  const nightDeps = night.makeDefaultDeps();
  return {
    loadProfile: profileLoader.loadProfile,
    loadApplications: applicationsTsv.load,
    readFile: nightDeps.readFile,
    writeFile: nightDeps.writeFile,
    fileExists: (p) => fs.existsSync(p),
    listDir: (p) => (fs.existsSync(p) ? fs.readdirSync(p) : []),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    removeFile: (p) => fs.rmSync(p, { force: true }),
    rename: (from, to) => fs.renameSync(from, to),
    // Atomic: the lock file appears fully written or not at all.
    createExclusive: (p, data) => createAtomic(p, data),
    realpath: (p) => fs.realpathSync(p),
    readNightRuns: nightLog.readNightRuns,
    stateDir: (env) => defaultStateDir(env),
    now: () => new Date(),
    pid: process.pid,
    pidAlive,
    runSubmit: submitViaApply,
    runQuestions: questionsViaCommand,
    runMailCheck: mailCheckViaCommand,
    notify: macNotify,
  };
}

function readJson(p, deps) {
  try {
    return JSON.parse(deps.readFile(p));
  } catch {
    return null;
  }
}

// --- lock --------------------------------------------------------------------

function acquireLock(file, deps) {
  deps.mkdirp(path.dirname(file));
  const body = JSON.stringify({ pid: deps.pid, started_at: deps.now().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      deps.createExclusive(file, body);
      return { ok: true };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const cur = readJson(file, deps);
      // A live holder keeps its lock, however long it has been running (a
      // slow night of forms is not a dead one). Only a gone pid, or a file
      // that is not a lock at all, is taken over.
      if (cur && Number.isInteger(cur.pid) && deps.pidAlive(cur.pid)) {
        return { ok: false, holder: cur };
      }
      deps.removeFile(file); // a run that died — take over
    }
  }
  return { ok: false, holder: readJson(file, deps) };
}

function releaseLock(file, deps) {
  const cur = readJson(file, deps);
  if (cur && cur.pid === deps.pid) deps.removeFile(file);
}

// --- manifests ---------------------------------------------------------------

function moveToDone(dirs, name, record, deps) {
  deps.mkdirp(dirs.done);
  deps.writeFile(path.join(dirs.done, name), JSON.stringify(record, null, 2));
  deps.removeFile(path.join(dirs.claimed, name));
}

// Claim = atomic rename into claimed/. Another run that got there first makes
// the rename fail with ENOENT: not ours, skip it.
function claim(dirs, name, deps) {
  deps.mkdirp(dirs.claimed);
  try {
    deps.rename(path.join(dirs.base, name), path.join(dirs.claimed, name));
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

// The round folder of a manifest: .apply-state/rounds/<stamp>/, never a path
// the manifest names. null when the stamp is not a plain name or the folder
// resolves (through a symlink) outside .apply-state.
function roundDirFor(manifest, profile, deps) {
  const st = String((manifest && manifest.stamp) || "");
  if (!STAMP_RE.test(st) || st.includes("..")) return null;
  const stateRoot = path.join(profile.paths.root, ".apply-state");
  const dir = path.join(stateRoot, "rounds", st);
  if (!deps.fileExists(dir)) return dir; // nothing to resolve yet
  let realRoot;
  let realDir;
  try {
    realRoot = deps.realpath(stateRoot);
    realDir = deps.realpath(dir);
  } catch {
    return null;
  }
  const rel = path.relative(realRoot, realDir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return dir;
}

function contextFor(manifest, profile, deps, roundDir) {
  const snapshot = path.join(roundDir, "apply_context.json");
  const live = path.join(profile.paths.root, ".apply-state", "apply_context.json");
  const source = deps.fileExists(snapshot) ? snapshot : live;
  const context = readJson(source, deps);
  if (!context || !Array.isArray(context.jobs)) return null;
  const rows = new Set(manifest.rows);
  return { ...context, jobs: context.jobs.filter((j) => j && rows.has(j.key)) };
}

async function processManifest(name, raw, env) {
  const { ctx, profile, deps, dirs, windowState, concurrency } = env;
  const now = deps.now();
  const { manifest, problems } = readyManifest.parseManifest(raw);
  const base = { ...(raw && typeof raw === "object" ? raw : {}), finished_at: now.toISOString() };
  if (!manifest) {
    moveToDone(dirs, name, { ...base, outcome: "invalid", problems }, deps);
    ctx.stderr(`submit-ready: ${name} is not a valid manifest (${problems.join("; ")})`);
    return { outcome: "invalid" };
  }
  if (now.getTime() >= Date.parse(manifest.deadline)) {
    moveToDone(dirs, name, { ...base, outcome: "expired" }, deps);
    ctx.stdout(`submit-ready: ${name} expired at ${manifest.deadline} — rows stay queued`);
    return { outcome: "expired" };
  }
  const roundDir = roundDirFor(manifest, profile, deps);
  if (!roundDir) {
    moveToDone(dirs, name, { ...base, outcome: "invalid", problems: ["round dir outside"] }, deps);
    ctx.stderr(`submit-ready: ${name} names a round outside .apply-state — not submitted`);
    return { outcome: "invalid" };
  }
  const context = contextFor(manifest, profile, deps, roundDir);
  if (!context || context.jobs.length === 0) {
    moveToDone(dirs, name, { ...base, outcome: "no_jobs" }, deps);
    ctx.stdout(`submit-ready: ${name} has no jobs in its apply context`);
    return { outcome: "no_jobs" };
  }
  const deadline = readyManifest.effectiveDeadline(manifest, windowState).toISOString();
  ctx.stdout(`submit-ready: ${name} — ${context.jobs.length} job(s), deadline ${deadline}`);
  let res;
  try {
    res = await deps.runSubmit({
      ctx,
      profile,
      context,
      answersDir: path.join(roundDir, "answers"),
      deadline,
      concurrency,
    });
  } catch (err) {
    res = { code: 1, error: err.message };
  }
  if (res.code === 0) {
    moveToDone(
      dirs,
      name,
      { ...base, outcome: "submitted", result_file: res.resultsFile || null },
      deps
    );
    return { outcome: "submitted", resultsFile: res.resultsFile || null };
  }
  const attempts = (Number(raw.attempts) || 0) + 1;
  if (res.error) ctx.stderr(`submit-ready: ${name} failed: ${res.error}`);
  if (attempts >= MAX_ATTEMPTS) {
    moveToDone(dirs, name, { ...base, outcome: "submit_failed", attempts }, deps);
    return { outcome: "submit_failed" };
  }
  // Back to the queue for the next start (15 min later).
  deps.writeFile(path.join(dirs.base, name), JSON.stringify({ ...raw, attempts }, null, 2));
  deps.removeFile(path.join(dirs.claimed, name));
  return { outcome: "retry", stop: true };
}

// --- morning notification ------------------------------------------------------

// The night's lock, if any: { lock, stale }. A lock past its deadline + 1 h
// belongs to a night that died (the next `night start` logs it abandoned).
function nightLockState(ctx, profile, deps) {
  const lock = readJson(night.lockPath(deps.stateDir(ctx.env || process.env), profile.id), deps);
  if (!lock || Number.isNaN(Date.parse(lock.started_at))) return null;
  const deadline = Date.parse(lock.deadline);
  const stale =
    !Number.isFinite(deadline) || deps.now().getTime() > deadline + NIGHT_STALE_GRACE_MS;
  return { lock, stale };
}

async function maybeNotify(ctx, profile, deps, ws) {
  const date = ws.lastCloseDate;
  const marker = path.join(profile.paths.root, morning.HEALTH_DIR, `morning-${date}.notified`);
  if (deps.fileExists(marker)) return { sent: false, reason: "already_sent" };
  const held = nightLockState(ctx, profile, deps);
  const closeMs = ws.lastClose.getTime();
  if (held && !held.stale && deps.now().getTime() < closeMs + NOTIFY_GRACE_MS) {
    return { sent: false, reason: "night_running" };
  }
  const running = held && Date.parse(held.lock.started_at) <= closeMs ? held : null;

  // Tonight's new blocking questions go to Notion before the report counts
  // them; a failure here never stops the morning notification.
  try {
    const code = await deps.runQuestions({ ctx, profile });
    if (code) ctx.stderr(`submit-ready: questions step exited ${code}`);
  } catch (err) {
    ctx.stderr(`submit-ready: questions step failed: ${err.message}`);
  }

  // The night this morning belongs to: the last run log line that started in
  // the day before the window closed, else the running night, else none.
  const runs = deps.readNightRuns(nightLog.nightRunsPath(profile.paths.root));
  const entry = runs
    .filter((r) => {
      const t = Date.parse(r.started_at);
      return t <= closeMs && t > closeMs - DAY_MS;
    })
    .pop();
  let since;
  let nightInfo = null;
  let target = plan.resolveNightSettings(profile, {}).target;
  if (entry) {
    since = entry.started_at;
    nightInfo = { stop_reason: entry.stop_reason };
    target = entry.target || target;
  } else if (running) {
    since = running.lock.started_at;
    nightInfo = running.stale ? { stop_reason: "abandoned" } : { running: true };
    target = running.lock.target || target;
  } else {
    since = new Date(closeMs - DAY_MS).toISOString();
  }
  const { report, file } = night.writeMorningReport(
    profile,
    { since, target, night: nightInfo, date },
    deps
  );
  // Replies in both mailboxes (RFC 071). A failure here never stops the
  // morning notification; the line just stays out of it.
  let mail = null;
  if (deps.runMailCheck) {
    try {
      const res = await withTimeout(
        deps.runMailCheck({ ctx, profile }),
        deps.mailCheckTimeoutMs || MAIL_CHECK_TIMEOUT_MS,
        "mail check"
      );
      if (res && res.code) ctx.stderr(`submit-ready: mail check exited ${res.code}`);
      mail = (res && res.summary) || null;
    } catch (err) {
      ctx.stderr(`submit-ready: mail check failed: ${err.message}`);
    }
  }

  let text = morning.notificationText(report);
  const mailLine = morning.mailCheckLine(mail);
  if (mailLine) text += `. ${mailLine}`;
  let sent = false;
  try {
    sent = Boolean(await deps.notify("Ночные отклики", text));
  } catch (err) {
    ctx.stderr(`submit-ready: notification failed: ${err.message}`);
  }
  // An interview invite gets its own notification: it must not drown in the
  // morning counts.
  const inviteText = morning.interviewNotificationText(mail);
  if (inviteText) {
    try {
      await deps.notify("Приглашение на собеседование", inviteText);
    } catch (err) {
      ctx.stderr(`submit-ready: invite notification failed: ${err.message}`);
    }
  }
  deps.writeFile(
    marker,
    JSON.stringify({ notified_at: deps.now().toISOString(), sent, text }, null, 2)
  );
  ctx.stdout(`submit-ready: morning report ${file}${sent ? " (notified)" : ""}`);
  return { sent, text, file };
}

// --- heartbeat ---------------------------------------------------------------

function writeHeartbeat(ctx, profile, deps, window) {
  const file = night.heartbeatPath(deps.stateDir(ctx.env || process.env), profile.id);
  try {
    deps.mkdirp(path.dirname(file));
    deps.writeFile(
      file,
      JSON.stringify({
        at: deps.now().toISOString(),
        pid: deps.pid,
        window: window.text,
        window_open: readyManifest.windowState(deps.now(), window).open,
      })
    );
  } catch (err) {
    ctx.stderr(`submit-ready: heartbeat not written: ${err.message}`);
  }
}

// --- command -----------------------------------------------------------------

async function runSubmitReady(ctx, deps) {
  const { stdout, stderr, flags = {} } = ctx;
  const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);
  const profile = deps.loadProfile(ctx.profileId, { profilesDir, warn: () => {} });
  let window;
  try {
    window = readyManifest.parseWindow(profile.apply_window || readyManifest.DEFAULT_WINDOW);
  } catch (err) {
    stderr(`error: ${err.message}`);
    return 1;
  }
  const lockFile = path.join(deps.stateDir(ctx.env || process.env), profile.id, LOCK_FILE);
  writeHeartbeat(ctx, profile, deps, window);
  const lock = acquireLock(lockFile, deps);
  if (!lock.ok) {
    stdout(
      `submit-ready: another submitter (pid ${lock.holder && lock.holder.pid}) is running — skipped`
    );
    return 0;
  }
  try {
    let ws = readyManifest.windowState(deps.now(), window);
    if (!ws.open) {
      const n = await maybeNotify(ctx, profile, deps, ws);
      if (n.reason) stdout(`submit-ready: window ${window.text} closed (${n.reason})`);
      return 0;
    }
    const dirs = night.readyDirs(profile);
    const concurrency =
      Number.isFinite(flags.concurrency) && flags.concurrency > 0
        ? flags.concurrency
        : DEFAULT_CONCURRENCY;
    const tally = {};
    // Orphans of a run that died first (we hold the lock, so they are not
    // anyone's), then the waiting queue. Re-listed after each manifest, so
    // manifests the night writes meanwhile are picked up in the same run.
    const done = new Set();
    for (;;) {
      ws = readyManifest.windowState(deps.now(), window);
      if (!ws.open) break;
      let name = readyManifest
        .orderManifestNames(deps.listDir(dirs.claimed))
        .find((n) => !done.has(n));
      if (!name) {
        name = readyManifest.orderManifestNames(deps.listDir(dirs.base)).find((n) => !done.has(n));
        if (!name) break;
        if (!claim(dirs, name, deps)) {
          done.add(name);
          continue;
        }
      }
      done.add(name);
      const raw = readJson(path.join(dirs.claimed, name), deps);
      const r = await processManifest(name, raw, {
        ctx,
        profile,
        deps,
        dirs,
        windowState: ws,
        concurrency,
      });
      tally[r.outcome] = (tally[r.outcome] || 0) + 1;
      if (r.stop) break;
    }
    const parts = Object.entries(tally).map(([k, v]) => `${v} ${k}`);
    stdout(`submit-ready: ${parts.length ? parts.join(", ") : "nothing ready"}`);
    return 0;
  } finally {
    releaseLock(lockFile, deps);
  }
}

function makeSubmitReadyCommand(overrides = {}) {
  const deps = { ...makeDefaultDeps(), ...overrides };
  return async function submitReadyCommand(ctx) {
    return runSubmitReady(ctx, deps);
  };
}

module.exports = makeSubmitReadyCommand();
module.exports.makeSubmitReadyCommand = makeSubmitReadyCommand;
module.exports.escapeAppleScript = escapeAppleScript;
module.exports.submitViaApply = submitViaApply;
module.exports.LOCK_FILE = LOCK_FILE;
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
