// `night` command — the deterministic rails of the unattended nightly run
// (RFC 068 §9 / §11, BL-225). The runbook skills/job-pipeline/night-apply.md
// drives it; Claude does the LLM work in between.
//
//   night --profile <id> --phase start [--target N] [--stop-at HH:MM] [--max-hours 14]
//     Takes the per-profile lock (a second night exits 3 and must not touch
//     anything), stamps the start, computes the deadline (next local --stop-at,
//     at most --max-hours away) and prints the apply-ready backlog.
//     Target / stop time: flag › profile `apply_target` / `apply_stop_at` ›
//     30 / 11:00 (RFC 069 §3).
//     A lock left by a night that died is closed as "abandoned" first.
//
//   night --profile <id> --phase check
//     Wall-clock + progress check. Prints one JSON line with `step`:
//     "prepare" (with `prepare_batch`), "apply", "wait" (rows with the
//     submitter cover the gap), "topup" (nothing left to prepare or apply —
//     find more companies, RFC 069 §6) or "stop" (with `reason`).
//     Exit 0 for every step but stop, 2 for stop.
//
//   night --profile <id> --phase ready
//     Ends an apply round (RFC 069 §1): snapshots .apply-state/apply_context.json
//     into the round folder and writes the ready manifest
//     .apply-state/ready/<stamp>.json (atomic rename) for `submit-ready`.
//     The night never submits itself.
//
//   night --profile <id> --phase wait [--minutes 9]
//     Blocks until the submitter has finished every ready manifest, the
//     minutes run out or the deadline passes, then prints one JSON line.
//
//   night --profile <id> --phase prepare-fanout
//     Splits prepare_context.json into one small input file per batch row
//     (plus a shared memory.md and the JD body per row) under
//     profiles/<id>/.prepare-state/rows/ (one rolling folder; files of rows
//     no longer in the batch are pruned), so the orchestrator can
//     hand rows to parallel subagents by path. Rows that already have a
//     result file are not re-issued.
//
//   night --profile <id> --phase prepare-collect
//     Reads the per-row result files, validates each against what
//     `prepare --phase commit` accepts, and writes
//     profiles/<id>/prepare_results_<ts>.json. Bad / missing rows are left
//     out (they stay in Inbox) and listed; an invalid result file is removed
//     so the next fan-out re-issues the row. Exit 2 when nothing is committable.
//
//   night --profile <id> --phase apply-fanout
//     Splits .apply-state/apply_context.json into one input file per job with
//     open questions under .apply-state/rounds/<stamp>/ and creates the
//     answers/ directory `apply --phase submit --answers-file` reads.
//
//   night --profile <id> --phase finish --stop-reason <reason>
//     Appends one line to profiles/<id>/.health/apply_runs.jsonl (counts are
//     recomputed from the TSV and .apply-state files since the start, never
//     taken from the LLM), writes .health/morning-<date>.json (RFC 069 §7)
//     and releases the lock.
//
// Writes only its own files (lock, run log, fan-out files, results file) —
// never applications.tsv, never Notion.

const fs = require("fs");
const path = require("path");

const profileLoader = require("../core/profile_loader.js");
const applicationsTsv = require("../core/applications_tsv.js");
const { resolveProfilesDir } = require("../core/paths.js");
const { buildQueue } = require("../modules/apply/queue.js");
const { buildActiveCounts, resolveCapWindowDays } = require("./prepare.js");
const { defaultStateDir } = require("./board.js");
const plan = require("../core/night_plan.js");
const nightLog = require("../core/night_runs_log.js");
const readyManifest = require("../core/ready_manifest.js");
const morning = require("../core/morning_report.js");

const LOCK_FILE = "night.lock";
const APPLY_STATE_DIR = ".apply-state";
const PREPARE_STATE_DIR = ".prepare-state";
const EXIT_STOP = 2;
const EXIT_LOCKED = 3;
const READY_DIR = "ready";
const DEFAULT_WAIT_MINUTES = 9;
const WAIT_POLL_MS = 30 * 1000;
// A lock older than its deadline + this grace belongs to a night that died.
const STALE_GRACE_MS = 60 * 60 * 1000;

function makeDefaultDeps() {
  return {
    loadProfile: profileLoader.loadProfile,
    loadApplications: applicationsTsv.load,
    readFile: (p) => fs.readFileSync(p, "utf8"),
    writeFile: (p, data) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, p);
    },
    fileExists: (p) => fs.existsSync(p),
    listDir: (p) => (fs.existsSync(p) ? fs.readdirSync(p) : []),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    removeFile: (p) => fs.rmSync(p, { force: true, recursive: true }),
    appendNightRun: nightLog.appendNightRun,
    stateDir: (env) => defaultStateDir(env),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function lockPath(stateDir, profileId) {
  return path.join(stateDir, profileId, LOCK_FILE);
}

function readJson(p, deps) {
  try {
    return JSON.parse(deps.readFile(p));
  } catch {
    return null;
  }
}

function stamp(iso) {
  return plan.safeKey(String(iso || "").replace(/[:.]/g, "-"));
}

function tsStamp(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function printJson(stdout, obj) {
  stdout(JSON.stringify(obj));
}

// --- shared state readers ---------------------------------------------------

function applyFiles(profile, deps) {
  const dir = path.join(profile.paths.root, APPLY_STATE_DIR);
  const out = [];
  for (const name of deps.listDir(dir)) {
    let kind = null;
    if (/^apply_pre-.*\.json$/.test(name)) kind = "pre";
    else if (/^apply_results-.*\.json$/.test(name)) kind = "results";
    if (!kind) continue;
    const data = readJson(path.join(dir, name), deps);
    if (data) out.push({ kind, data });
  }
  return out;
}

// Ready manifests waiting for the submitter (ready/) or being submitted
// right now (ready/claimed/). Finished ones live in ready/done/.
function readyDirs(profile) {
  const base = path.join(profile.paths.root, APPLY_STATE_DIR, READY_DIR);
  return { base, claimed: path.join(base, "claimed"), done: path.join(base, "done") };
}

// A manifest past its deadline is never submitted (the submitter files it as
// expired), so it is not pending either — an old one left behind by a
// missing submitter must not keep tonight waiting.
function pendingManifests(profile, deps) {
  const dirs = readyDirs(profile);
  const nowMs = deps.now().getTime();
  const out = [];
  for (const dir of [dirs.base, dirs.claimed]) {
    for (const name of readyManifest.orderManifestNames(deps.listDir(dir))) {
      const raw = readJson(path.join(dir, name), deps);
      const { manifest } = readyManifest.parseManifest(raw);
      if (manifest && Date.parse(manifest.deadline) > nowMs) out.push(manifest);
    }
  }
  return out;
}

// Distinct jobs in unfinished manifests that are not submitted yet.
function pendingKeys(profile, deps, submittedKeys = []) {
  const done = new Set(submittedKeys);
  const keys = new Set();
  for (const m of pendingManifests(profile, deps)) {
    for (const k of m.rows) if (!done.has(k)) keys.add(k);
  }
  return keys;
}

function applyQueue(apps, profile, now) {
  const filterRules = profile.filterRules || {};
  return buildQueue(apps, {
    filterRules,
    buildActiveCounts,
    windowDays: resolveCapWindowDays(filterRules),
    now,
  }).queue;
}

function progress(profile, lock, deps) {
  const now = deps.now();
  const { apps } = deps.loadApplications(profile.paths.applicationsTsv);
  const apply = plan.summarizeApplyFiles(applyFiles(profile, deps), lock.started_at);
  const seen = new Set(apply.seenKeys);
  const queue = applyQueue(apps, profile, now);
  const applyFresh = queue.filter((a) => !seen.has(a.key)).length;
  const ctx = readJson(path.join(profile.paths.root, "prepare_context.json"), deps);
  const ctxMs = ctx ? Date.parse(ctx.generatedAt) : NaN;
  const ctxTonight = ctx && ctxMs >= Date.parse(lock.started_at) ? ctx : null;
  // Inbox rows a scan added after that prepare round (a top-up scan): the
  // Inbox is not exhausted any more, prepare them first.
  const scannedSinceCtx = ctxTonight
    ? apps.filter((a) => a.status === "Inbox" && Date.parse(a.createdAt || "") > ctxMs).length
    : 0;
  // A prepare round tonight that found nothing to judge also means "stop
  // preparing" — otherwise check would send the night to prepare forever.
  const inboxExhausted = Boolean(
    ctxTonight &&
    scannedSinceCtx === 0 &&
    ((ctxTonight.stats && ctxTonight.stats.inboxExhausted) ||
      (Array.isArray(ctxTonight.batch) && ctxTonight.batch.length === 0))
  );
  return {
    now,
    apps,
    apply,
    applyReady: queue.length,
    applyFresh,
    pending: pendingKeys(profile, deps, apply.submittedKeys).size,
    inboxExhausted,
    scannedSinceCtx,
    tsv: plan.countTsvSince(apps, lock.started_at),
  };
}

// The morning report (RFC 069 §7) for the night that started at `since`.
// Written by `finish` and refreshed by `submit-ready` after the window.
function writeMorningReport(profile, { since, target, night, date }, deps) {
  const now = deps.now();
  const { apps } = deps.loadApplications(profile.paths.applicationsTsv);
  const report = morning.buildMorningReport({
    date: date || readyManifest.localDate(now),
    since,
    now,
    target,
    apps,
    applyFiles: applyFiles(profile, deps),
    night,
  });
  const file = morning.morningPath(profile.paths.root, report.date);
  deps.writeFile(file, JSON.stringify(report, null, 2));
  return { file, report };
}

function closeRun(profile, lock, stopReason, deps) {
  const p = progress(profile, lock, deps);
  const entry = nightLog.buildNightEntry({
    startedAt: lock.started_at,
    finishedAt: p.now.toISOString(),
    target: lock.target,
    tsv: p.tsv,
    apply: p.apply,
    stopReason,
  });
  deps.appendNightRun(nightLog.nightRunsPath(profile.paths.root), entry, { now: p.now });
  return entry;
}

// --- phases -----------------------------------------------------------------

function runStart(ctx, profile, deps) {
  const { flags, stdout, stderr } = ctx;
  const file = lockPath(deps.stateDir(ctx.env || process.env), profile.id);
  const now = deps.now();
  const existing = deps.fileExists(file) ? readJson(file, deps) : null;
  if (existing) {
    const deadline = Date.parse(existing.deadline);
    const stale = !Number.isFinite(deadline) || now.getTime() > deadline + STALE_GRACE_MS;
    if (!stale) {
      stderr(
        `night already running for ${profile.id} since ${existing.started_at} ` +
          `(deadline ${existing.deadline}) — this run stops here`
      );
      return EXIT_LOCKED;
    }
    if (existing.started_at && !Number.isNaN(Date.parse(existing.started_at))) {
      const entry = closeRun(profile, existing, "abandoned", deps);
      stdout(
        `previous night (${existing.started_at}) never finished — logged as abandoned ` +
          `(${entry.submitted} submitted)`
      );
    }
    deps.removeFile(file);
  }

  const settings = plan.resolveNightSettings(profile, flags);
  let deadline;
  try {
    deadline = plan.computeDeadline(now, {
      stopAt: settings.stopAt,
      maxHours: Number.isFinite(flags.maxHours) ? flags.maxHours : plan.DEFAULT_MAX_HOURS,
    });
  } catch (err) {
    stderr(`error: ${err.message}`);
    return 1;
  }
  const target = settings.target;
  const lock = {
    profile: profile.id,
    started_at: now.toISOString(),
    deadline: deadline.toISOString(),
    target,
    pid: process.pid,
  };
  deps.mkdirp(path.dirname(file));
  deps.writeFile(file, JSON.stringify(lock, null, 2));

  const { apps } = deps.loadApplications(profile.paths.applicationsTsv);
  const applyReady = applyQueue(apps, profile, now).length;
  stdout(
    `night started for ${profile.id}: target ${target} applications, stop starting new work at ` +
      `${deadline.toString()} (${plan.minutesLeft(now, deadline)} min); apply-ready backlog ${applyReady}`
  );
  printJson(stdout, { ...lock, apply_ready: applyReady });
  return 0;
}

function requireLock(ctx, profile, deps) {
  const file = lockPath(deps.stateDir(ctx.env || process.env), profile.id);
  const lock = deps.fileExists(file) ? readJson(file, deps) : null;
  if (!lock || Number.isNaN(Date.parse(lock.started_at))) {
    ctx.stderr(`error: no night in progress for ${profile.id} — run night --phase start first`);
    return { lock: null, file };
  }
  return { lock, file };
}

function runCheck(ctx, profile, deps) {
  const { lock } = requireLock(ctx, profile, deps);
  if (!lock) return 1;
  const p = progress(profile, lock, deps);
  const d = plan.decideNextStep({
    now: p.now,
    deadline: lock.deadline,
    target: lock.target,
    submittedTonight: p.apply.submitted,
    pendingSubmit: p.pending,
    applyReady: p.applyReady,
    applyFresh: p.applyFresh,
    inboxExhausted: p.inboxExhausted,
  });
  const out = {
    step: d.step,
    reason: d.reason,
    minutes_left: d.minutesLeft,
    deadline: lock.deadline,
    target: lock.target,
    submitted_tonight: p.apply.submitted,
    pending_submit: p.pending,
    need: d.need,
    apply_ready: d.applyReady,
    apply_fresh: d.applyFresh,
    prepare_target: d.prepareTarget,
    prepare_batch: d.prepareBatch,
    inbox_exhausted: p.inboxExhausted,
    scanned_since_prepare: p.scannedSinceCtx,
    prepared_tonight: p.tsv.prepared.total,
  };
  printJson(ctx.stdout, out);
  return d.step === "stop" ? EXIT_STOP : 0;
}

function storybankPath(root, deps) {
  for (const rel of ["storybank.md", path.join("interview-coach-state", "coaching_state.md")]) {
    const p = path.join(root, rel);
    if (deps.fileExists(p)) return p;
  }
  return null;
}

// One rolling folder for the prepare fan-out, not one per context: a manual
// topup rewrites prepare_context.json (new generatedAt) and must keep the
// results already judged. Files of rows that left the batch (committed, or
// from an older round) are pruned on every fan-out, so a result is only ever
// reused for the same row in the current batch.
function rowsDirs(root) {
  const base = path.join(root, PREPARE_STATE_DIR, "rows");
  return {
    base,
    payloads: path.join(base, "payloads"),
    jd: path.join(base, "jd"),
    results: path.join(base, "results"),
    tailor: path.join(base, "tailor"),
    memory: path.join(base, "memory.md"),
  };
}

function pruneRows(dirs, batchKeys, deps) {
  let removed = 0;
  for (const dir of [dirs.payloads, dirs.jd, dirs.results, dirs.tailor]) {
    for (const name of deps.listDir(dir)) {
      const stem = name.replace(/\.(json|md)$/, "");
      if (batchKeys.has(stem)) continue;
      deps.removeFile(path.join(dir, name));
      removed++;
    }
  }
  return removed;
}

function readPrepareContext(ctx, root, deps) {
  const context = readJson(path.join(root, "prepare_context.json"), deps);
  if (!context || !Array.isArray(context.batch)) {
    ctx.stderr(
      "error: prepare_context.json missing or has no batch — run prepare --phase pre first"
    );
    return null;
  }
  return context;
}

function runPrepareFanout(ctx, profile, deps) {
  const { stdout } = ctx;
  const root = profile.paths.root;
  const context = readPrepareContext(ctx, root, deps);
  if (!context) return 1;
  const dirs = rowsDirs(root);
  for (const d of [dirs.payloads, dirs.jd, dirs.results, dirs.tailor]) deps.mkdirp(d);
  const batchKeys = new Set(context.batch.map((e) => plan.safeKey(e.key)));
  const pruned = pruneRows(dirs, batchKeys, deps);
  deps.writeFile(dirs.memory, plan.renderMemoryMarkdown(context.memory));

  const masterProfile = path.join(root, "master_profile.md");
  const common = {
    profileId: profile.id,
    resumeVersions: profile.resumeVersions || null,
    companyTiers: profile.company_tiers || {},
    masterProfilePath: deps.fileExists(masterProfile) ? masterProfile : null,
    storybankPath: storybankPath(root, deps),
  };

  const pending = [];
  let done = 0;
  for (const entry of context.batch) {
    const sk = plan.safeKey(entry.key);
    const resultPath = path.join(dirs.results, `${sk}.json`);
    if (deps.fileExists(resultPath)) {
      done++;
      continue;
    }
    const jdPath = entry.jdText ? path.join(dirs.jd, `${sk}.md`) : null;
    if (jdPath) deps.writeFile(jdPath, String(entry.jdText));
    const payloadPath = path.join(dirs.payloads, `${sk}.json`);
    const payload = plan.buildRowPayload(entry, context, {
      ...common,
      paths: {
        memory: dirs.memory,
        jd: jdPath,
        result: resultPath,
        tailor: path.join(dirs.tailor, sk),
      },
    });
    deps.writeFile(payloadPath, JSON.stringify(payload, null, 2));
    pending.push({ payloadPath, entry });
  }

  printJson(stdout, {
    rows_dir: dirs.base,
    rows: context.batch.length,
    pending: pending.length,
    already_done: done,
    pruned,
    brief: "skills/job-pipeline/references/night_row_worker.md",
  });
  for (const p of pending) {
    stdout(`${p.payloadPath}\t${p.entry.companyName} — ${p.entry.title}`);
  }
  return 0;
}

function runPrepareCollect(ctx, profile, deps) {
  const { stdout, stderr } = ctx;
  const root = profile.paths.root;
  const context = readPrepareContext(ctx, root, deps);
  if (!context) return 1;
  const dirs = rowsDirs(root);
  const pathOf = (key) => path.join(dirs.results, `${plan.safeKey(key)}.json`);
  const byKey = new Map();
  for (const entry of context.batch) {
    const p = pathOf(entry.key);
    if (!deps.fileExists(p)) continue;
    const parsed = readJson(p, deps);
    byKey.set(entry.key, parsed === null ? "unparseable" : parsed);
  }
  const versions =
    profile.resumeVersions && profile.resumeVersions.versions
      ? Object.keys(profile.resumeVersions.versions)
      : [];
  const c = plan.collectRowResults(context.batch, byKey, {
    unknownTierCompanies: context.unknownTierCompanies || [],
    resumeVersionKeys: new Set(versions),
  });
  // An invalid result is removed so the next prepare-fanout re-issues the row.
  for (const bad of c.invalid) deps.removeFile(pathOf(bad.key));

  let resultsFile = null;
  if (c.results.length) {
    const now = deps.now();
    resultsFile = path.join(root, `prepare_results_${tsStamp(now)}.json`);
    deps.writeFile(
      resultsFile,
      JSON.stringify(
        {
          profileId: profile.id,
          generatedAt: now.toISOString(),
          companyTiers: c.companyTiers,
          results: c.results,
        },
        null,
        2
      )
    );
  }
  printJson(stdout, {
    results_file: resultsFile,
    counts: c.counts,
    committable: c.results.length,
    missing: c.missing,
    invalid: c.invalid,
    untiered_companies: c.untiered,
  });
  for (const bad of c.invalid) {
    stderr(
      `  invalid ${bad.key}: ${bad.problems.join("; ")} (result removed — re-issued on fan-out)`
    );
  }
  if (c.missing.length) stderr(`  no result yet: ${c.missing.length} row(s) — they stay in Inbox`);
  return resultsFile ? 0 : EXIT_STOP;
}

function runApplyFanout(ctx, profile, deps) {
  const { stdout, stderr } = ctx;
  const stateDir = path.join(profile.paths.root, APPLY_STATE_DIR);
  const context = readJson(path.join(stateDir, "apply_context.json"), deps);
  if (!context || !Array.isArray(context.jobs)) {
    stderr("error: .apply-state/apply_context.json missing — run apply --phase pre first");
    return 1;
  }
  const roundDir = path.join(stateDir, "rounds", stamp(context.generated_at));
  const dirs = {
    jobs: path.join(roundDir, "jobs"),
    drafts: path.join(roundDir, "drafts"),
    reviews: path.join(roundDir, "reviews"),
    answers: path.join(roundDir, "answers"),
    bank: path.join(roundDir, "bank"),
  };
  for (const d of Object.values(dirs)) deps.mkdirp(d);

  const written = [];
  for (const job of context.jobs) {
    if (!Array.isArray(job.unanswered) || job.unanswered.length === 0) continue;
    const sk = plan.safeKey(job.key);
    const jobPath = path.join(dirs.jobs, `${sk}.json`);
    deps.writeFile(
      jobPath,
      JSON.stringify(
        plan.buildQuestionJob(job, {
          draft: path.join(dirs.drafts, `${sk}.json`),
          review: path.join(dirs.reviews, `${sk}.json`),
          answers: path.join(dirs.answers, `${sk}.json`),
          bank: dirs.bank,
        }),
        null,
        2
      )
    );
    written.push({ jobPath, job });
  }
  printJson(stdout, {
    round_dir: roundDir,
    answers_dir: dirs.answers,
    bank_dir: dirs.bank,
    jobs: context.jobs.length,
    with_questions: written.length,
    brief: "skills/job-pipeline/SKILL.md (apply mode, Phase 2)",
  });
  for (const w of written) {
    stdout(`${w.jobPath}\t${w.job.company} — ${w.job.title} (${w.job.unanswered.length} open)`);
  }
  return 0;
}

// Ends an apply round: the rows of the current apply context go to the
// submitter as one ready manifest. Idempotent per context — a manifest for
// the same stamp (waiting, claimed or done) is never written twice.
function runReady(ctx, profile, deps) {
  const { stdout, stderr } = ctx;
  const { lock } = requireLock(ctx, profile, deps);
  if (!lock) return 1;
  const stateDir = path.join(profile.paths.root, APPLY_STATE_DIR);
  const context = readJson(path.join(stateDir, "apply_context.json"), deps);
  if (!context || !Array.isArray(context.jobs)) {
    stderr("error: .apply-state/apply_context.json missing — run apply --phase pre first");
    return 1;
  }
  const st = stamp(context.generated_at);
  const roundDir = path.join(stateDir, "rounds", st);
  const answersDir = path.join(roundDir, "answers");
  const dirs = readyDirs(profile);
  const name = `${st}.json`;
  const manifestPath = path.join(dirs.base, name);
  for (const dir of [dirs.base, dirs.claimed, dirs.done]) {
    if (deps.fileExists(path.join(dir, name))) {
      printJson(stdout, { manifest: path.join(dir, name), rows: null, already_written: true });
      return 0;
    }
  }
  const rows = context.jobs.map((j) => j && j.key).filter(Boolean);
  if (!rows.length) {
    printJson(stdout, { manifest: null, rows: 0 });
    return 0;
  }
  deps.mkdirp(answersDir);
  // The submitter reads this snapshot, not the live context: the next apply
  // pre rewrites apply_context.json while this manifest may still wait.
  deps.writeFile(path.join(roundDir, "apply_context.json"), JSON.stringify(context, null, 2));
  const manifest = readyManifest.buildManifest({
    stamp: st,
    answersDir,
    deadline: lock.deadline,
    rows,
    createdAt: deps.now().toISOString(),
  });
  deps.mkdirp(dirs.base);
  deps.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  printJson(stdout, {
    manifest: manifestPath,
    rows: manifest.rows.length,
    deadline: lock.deadline,
  });
  return 0;
}

// Waits for the submitter (check said "wait"): returns as soon as no ready
// manifest is left, after --minutes (default 9, under a tool-call timeout),
// or at the night deadline.
async function runWait(ctx, profile, deps) {
  const { flags, stdout } = ctx;
  const { lock } = requireLock(ctx, profile, deps);
  if (!lock) return 1;
  const minutes =
    Number.isFinite(flags.minutes) && flags.minutes > 0 ? flags.minutes : DEFAULT_WAIT_MINUTES;
  const startMs = deps.now().getTime();
  const untilMs = Math.min(startMs + minutes * 60000, Date.parse(lock.deadline));
  const pendingNow = () => {
    const apply = plan.summarizeApplyFiles(applyFiles(profile, deps), lock.started_at);
    return pendingKeys(profile, deps, apply.submittedKeys).size;
  };
  let pending = pendingNow();
  while (pending > 0 && deps.now().getTime() < untilMs) {
    await deps.sleep(Math.min(WAIT_POLL_MS, Math.max(0, untilMs - deps.now().getTime())));
    pending = pendingNow();
  }
  printJson(stdout, {
    waited_minutes: Math.round((deps.now().getTime() - startMs) / 6000) / 10,
    pending_submit: pending,
  });
  return 0;
}

function runFinish(ctx, profile, deps) {
  const { flags, stdout } = ctx;
  const { lock, file } = requireLock(ctx, profile, deps);
  if (!lock) return 1;
  const stopReason = String(flags.stopReason || "").trim() || "unspecified";
  const entry = closeRun(profile, lock, stopReason, deps);
  const { file: morningFile } = writeMorningReport(
    profile,
    { since: lock.started_at, target: lock.target, night: { stop_reason: stopReason } },
    deps
  );
  deps.removeFile(file);
  stdout(
    `night finished (${stopReason}): ${entry.submitted} submitted, ${entry.manual} manual, ` +
      `${entry.failed} failed, ${entry.deferred} deferred; prepared ${entry.prepared} ` +
      `(${entry.strong} Strong / ${entry.medium} Medium / ${entry.weak} Weak); scanned ${entry.scanned}`
  );
  printJson(stdout, { ...entry, morning_report: morningFile });
  return 0;
}

const PHASES = {
  start: runStart,
  check: runCheck,
  "prepare-fanout": runPrepareFanout,
  "prepare-collect": runPrepareCollect,
  "apply-fanout": runApplyFanout,
  ready: runReady,
  wait: runWait,
  finish: runFinish,
};

function makeNightCommand(overrides = {}) {
  const deps = { ...makeDefaultDeps(), ...overrides };
  return async function nightCommand(ctx) {
    const phase = (ctx.flags && ctx.flags.phase) || "";
    const run = PHASES[phase];
    if (!run) {
      ctx.stderr(`error: --phase <${Object.keys(PHASES).join("|")}> is required for night`);
      return 1;
    }
    const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);
    const profile = deps.loadProfile(ctx.profileId, { profilesDir, warn: () => {} });
    return run(ctx, profile, deps);
  };
}

module.exports = makeNightCommand();
module.exports.makeNightCommand = makeNightCommand;
module.exports.lockPath = lockPath;
module.exports.EXIT_STOP = EXIT_STOP;
module.exports.EXIT_LOCKED = EXIT_LOCKED;
module.exports.PHASES = Object.keys(PHASES);
module.exports.makeDefaultDeps = makeDefaultDeps;
module.exports.readyDirs = readyDirs;
module.exports.applyFiles = applyFiles;
module.exports.writeMorningReport = writeMorningReport;
