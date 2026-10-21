// `night` command — the deterministic rails of the unattended nightly run
// (RFC 068 §9 / §11, BL-225). The runbook skills/job-pipeline/night-apply.md
// drives it; Claude does the LLM work in between.
//
//   night --profile <id> --phase start [--target 100] [--stop-at 06:30] [--max-hours 10]
//     Takes the per-profile lock (a second night exits 3 and must not touch
//     anything), stamps the start, computes the deadline (next local --stop-at,
//     at most --max-hours away) and prints the apply-ready backlog.
//     A lock left by a night that died is closed as "abandoned" first.
//
//   night --profile <id> --phase check
//     Wall-clock + progress check. Prints one JSON line with `step`:
//     "prepare" (with `prepare_batch`), "apply" or "stop" (with `reason`).
//     Exit 0 for prepare / apply, 2 for stop.
//
//   night --profile <id> --phase prepare-fanout
//     Splits prepare_context.json into one small input file per batch row
//     (plus a shared memory.md and the JD body per row) under
//     profiles/<id>/.prepare-state/rounds/<stamp>/, so the orchestrator can
//     hand rows to parallel subagents by path. Rows that already have a
//     result file are not re-issued.
//
//   night --profile <id> --phase prepare-collect
//     Reads the per-row result files, validates each against what
//     `prepare --phase commit` accepts, and writes
//     profiles/<id>/prepare_results_<ts>.json. Bad / missing rows are left
//     out (they stay in Inbox) and listed. Exit 2 when nothing is committable.
//
//   night --profile <id> --phase apply-fanout
//     Splits .apply-state/apply_context.json into one input file per job with
//     open questions under .apply-state/rounds/<stamp>/ and creates the
//     answers/ directory `apply --phase submit --answers-file` reads.
//
//   night --profile <id> --phase finish --stop-reason <reason>
//     Appends one line to profiles/<id>/.health/apply_runs.jsonl (counts are
//     recomputed from the TSV and .apply-state files since the start, never
//     taken from the LLM) and releases the lock.
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

const LOCK_FILE = "night.lock";
const APPLY_STATE_DIR = ".apply-state";
const PREPARE_STATE_DIR = ".prepare-state";
const EXIT_STOP = 2;
const EXIT_LOCKED = 3;
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
    removeFile: (p) => fs.rmSync(p, { force: true }),
    appendNightRun: nightLog.appendNightRun,
    stateDir: (env) => defaultStateDir(env),
    now: () => new Date(),
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
  const ctxTonight = ctx && Date.parse(ctx.generatedAt) >= Date.parse(lock.started_at) ? ctx : null;
  const inboxExhausted = Boolean(ctxTonight && ctxTonight.stats && ctxTonight.stats.inboxExhausted);
  return {
    now,
    apps,
    apply,
    applyReady: queue.length,
    applyFresh,
    inboxExhausted,
    tsv: plan.countTsvSince(apps, lock.started_at),
  };
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

  let deadline;
  try {
    deadline = plan.computeDeadline(now, {
      stopAt: flags.stopAt || plan.DEFAULT_STOP_AT,
      maxHours: Number.isFinite(flags.maxHours) ? flags.maxHours : plan.DEFAULT_MAX_HOURS,
    });
  } catch (err) {
    stderr(`error: ${err.message}`);
    return 1;
  }
  const target = Number.isFinite(flags.target) && flags.target > 0 ? flags.target : 100;
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
    need: d.need,
    apply_ready: d.applyReady,
    apply_fresh: d.applyFresh,
    prepare_target: d.prepareTarget,
    prepare_batch: d.prepareBatch,
    inbox_exhausted: p.inboxExhausted,
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

function runPrepareFanout(ctx, profile, deps) {
  const { stdout, stderr } = ctx;
  const root = profile.paths.root;
  const context = readJson(path.join(root, "prepare_context.json"), deps);
  if (!context || !Array.isArray(context.batch)) {
    stderr("error: prepare_context.json missing or has no batch — run prepare --phase pre first");
    return 1;
  }
  const roundDir = path.join(root, PREPARE_STATE_DIR, "rounds", stamp(context.generatedAt));
  const dirs = {
    payloads: path.join(roundDir, "payloads"),
    jd: path.join(roundDir, "jd"),
    results: path.join(roundDir, "results"),
  };
  for (const d of Object.values(dirs)) deps.mkdirp(d);
  const memoryPath = path.join(roundDir, "memory.md");
  deps.writeFile(memoryPath, plan.renderMemoryMarkdown(context.memory));

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
      paths: { memory: memoryPath, jd: jdPath, result: resultPath },
    });
    deps.writeFile(payloadPath, JSON.stringify(payload, null, 2));
    pending.push({ payloadPath, entry });
  }

  printJson(stdout, {
    round_dir: roundDir,
    rows: context.batch.length,
    pending: pending.length,
    already_done: done,
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
  const context = readJson(path.join(root, "prepare_context.json"), deps);
  if (!context || !Array.isArray(context.batch)) {
    stderr("error: prepare_context.json missing or has no batch — run prepare --phase pre first");
    return 1;
  }
  const resultsDir = path.join(
    root,
    PREPARE_STATE_DIR,
    "rounds",
    stamp(context.generatedAt),
    "results"
  );
  const byKey = new Map();
  for (const entry of context.batch) {
    const p = path.join(resultsDir, `${plan.safeKey(entry.key)}.json`);
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
  for (const bad of c.invalid) stderr(`  invalid ${bad.key}: ${bad.problems.join("; ")}`);
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

function runFinish(ctx, profile, deps) {
  const { flags, stdout } = ctx;
  const { lock, file } = requireLock(ctx, profile, deps);
  if (!lock) return 1;
  const stopReason = String(flags.stopReason || "").trim() || "unspecified";
  const entry = closeRun(profile, lock, stopReason, deps);
  deps.removeFile(file);
  stdout(
    `night finished (${stopReason}): ${entry.submitted} submitted, ${entry.manual} manual, ` +
      `${entry.failed} failed, ${entry.deferred} deferred; prepared ${entry.prepared} ` +
      `(${entry.strong} Strong / ${entry.medium} Medium / ${entry.weak} Weak); scanned ${entry.scanned}`
  );
  printJson(stdout, entry);
  return 0;
}

const PHASES = {
  start: runStart,
  check: runCheck,
  "prepare-fanout": runPrepareFanout,
  "prepare-collect": runPrepareCollect,
  "apply-fanout": runApplyFanout,
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
