// Night plan (RFC 068 §9 / §11, BL-225): pure helpers behind the `night`
// command — the unattended nightly run that targets ~100 applications.
//
// Nothing here touches the filesystem, the network or the clock: callers pass
// `now`, parsed files and TSV rows in. The command (engine/commands/night.js)
// owns the I/O.
//
//   computeDeadline(start, opts)       → Date — when the night stops starting work
//   decideNextStep(state)              → { step: "prepare"|"apply"|"stop", … }
//   prepareBatchSize(prepareTarget)    → --batch for the next prepare round
//   countTsvSince(apps, sinceIso)      → { scanned, prepared{…} }
//   summarizeApplyFiles(files, since)  → submit / manual / failed counts + keys seen
//   buildRowPayload(entry, ctx, opts)  → one prepare row's subagent input
//   renderMemoryMarkdown(memory)       → the shared memory blob as markdown
//   collectRowResults(batch, byKey, o) → results[] + companyTiers for commit
//   buildQuestionJob(job, paths)       → one apply job's subagent input

const DEFAULT_STOP_AT = "06:30";
const DEFAULT_MAX_HOURS = 10;
const DEFAULT_TARGET = 100;
const HOUR_MS = 60 * 60 * 1000;

const FIT_SCORES = new Set(["Strong", "Medium", "Weak"]);
const STRONG_ESCALATION_REASONS = new Set([
  "no_growth_below_threshold",
  "iteration_cap_below_threshold",
  "uncertain_about_fact",
]);
const TIERS = new Set(["S", "A", "B", "C"]);

function str(v) {
  return v === undefined || v === null ? "" : String(v);
}

// "06:30" → { h: 6, m: 30 }; throws on anything else.
function parseClock(value) {
  const m = str(value || DEFAULT_STOP_AT)
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`invalid --stop-at "${value}" — expected HH:MM (local time)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`invalid --stop-at "${value}" — expected HH:MM`);
  return { h, m: min };
}

// Next local `stopAt` strictly after `start`, capped at start + maxHours.
// The cap keeps a run started at an odd hour (e.g. 08:00 by hand) from
// thinking it owns the next 22 hours.
function computeDeadline(start, { stopAt = DEFAULT_STOP_AT, maxHours = DEFAULT_MAX_HOURS } = {}) {
  const s = start instanceof Date ? start : new Date(start);
  if (Number.isNaN(s.getTime())) throw new Error(`invalid start time: ${start}`);
  const { h, m } = parseClock(stopAt);
  const next = new Date(s.getFullYear(), s.getMonth(), s.getDate(), h, m, 0, 0);
  if (next.getTime() <= s.getTime()) next.setDate(next.getDate() + 1);
  const hours = Number.isFinite(maxHours) && maxHours > 0 ? maxHours : DEFAULT_MAX_HOURS;
  const cap = s.getTime() + hours * HOUR_MS;
  return new Date(Math.min(next.getTime(), cap));
}

function minutesLeft(now, deadline) {
  const n = now instanceof Date ? now.getTime() : Date.parse(now);
  const d = deadline instanceof Date ? deadline.getTime() : Date.parse(deadline);
  return Math.floor((d - n) / 60000);
}

// Rows the prepare round should aim for: the evaluator turns roughly two of
// three alive rows into Strong / Medium, so ask for 1.5× the gap, within
// [min, max] so one round stays small enough to commit before the deadline.
function prepareBatchSize(prepareTarget, { min = 10, max = 40, yieldFactor = 1.5 } = {}) {
  if (!Number.isFinite(prepareTarget) || prepareTarget <= 0) return 0;
  return Math.max(min, Math.min(max, Math.ceil(prepareTarget * yieldFactor)));
}

// Apply as soon as this many fresh rows wait, so submissions start early in
// the night instead of after every prepare round (prepare is the slow part).
const APPLY_MIN_BATCH = 10;

// state: {
//   now, deadline, target,
//   submittedTonight,   // applications sent since the night started
//   applyReady,         // queueable To Apply rows (Strong/Medium, cap, never applied)
//   applyFresh,         // of those, rows no apply pre has looked at tonight
//   inboxExhausted,     // last prepare context (tonight) said Inbox is empty
//   usageStop,          // operator / usage budget says stop
// }
// The order of the checks is the contract the runbook relies on:
//   deadline → usage → target → apply (≥ APPLY_MIN_BATCH fresh) → prepare
//   → apply (any fresh) → stop (queue_empty).
// Rows an apply pre already looked at tonight (skipped as dead / under the
// salary floor, deferred by the deadline) are not "fresh": they never count
// toward the prepare gap and never trigger another apply round, so the loop
// always ends.
function decideNextStep(state) {
  const target = Number.isFinite(state.target) && state.target > 0 ? state.target : DEFAULT_TARGET;
  const submitted = state.submittedTonight || 0;
  const applyReady = state.applyReady || 0;
  const applyFresh = state.applyFresh === undefined ? applyReady : state.applyFresh || 0;
  const left = minutesLeft(state.now, state.deadline);
  const need = Math.max(0, target - submitted);
  const prepareTarget = Math.max(0, need - applyFresh);
  const base = { minutesLeft: left, need, prepareTarget, applyReady, applyFresh };
  const stop = (reason) => ({ step: "stop", reason, ...base, prepareBatch: 0 });

  if (left <= 0) return stop("deadline");
  if (state.usageStop) return stop("usage_budget");
  if (need === 0) return stop("target_reached");
  if (applyFresh >= Math.min(APPLY_MIN_BATCH, need)) {
    return { step: "apply", reason: null, ...base, prepareBatch: 0 };
  }
  if (prepareTarget > 0 && !state.inboxExhausted) {
    return {
      step: "prepare",
      reason: null,
      ...base,
      prepareBatch: prepareBatchSize(prepareTarget),
    };
  }
  if (applyFresh > 0) return { step: "apply", reason: null, ...base, prepareBatch: 0 };
  return stop("queue_empty");
}

function atOrAfter(value, sinceMs) {
  const t = Date.parse(str(value));
  return Number.isFinite(t) && t >= sinceMs;
}

// TSV rows → what tonight added (scan) and evaluated (prepare commit).
function countTsvSince(apps, sinceIso) {
  const since = Date.parse(str(sinceIso));
  const prepared = { total: 0, strong: 0, medium: 0, weak: 0 };
  let scanned = 0;
  if (!Number.isFinite(since)) return { scanned, prepared };
  for (const a of apps || []) {
    if (atOrAfter(a.createdAt, since)) scanned++;
    if (atOrAfter(a.fit_evaluated_at, since) && str(a.status) !== "Inbox") {
      prepared.total++;
      if (a.fit_score === "Strong") prepared.strong++;
      else if (a.fit_score === "Medium") prepared.medium++;
      else if (a.fit_score === "Weak") prepared.weak++;
    }
  }
  return { scanned, prepared };
}

// files: [{ kind: "pre" | "results", data }] — parsed `apply_pre-*.json` /
// `apply_results-*.json` from .apply-state/. Only files generated at or after
// `sinceIso` and not dry-run count.
function summarizeApplyFiles(files, sinceIso) {
  const since = Date.parse(str(sinceIso));
  const out = {
    applyRounds: 0,
    queued: 0,
    submitted: 0,
    manual: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
    errors: 0,
    seenKeys: [],
  };
  const seen = new Set();
  for (const f of files || []) {
    const d = f && f.data;
    if (!d || d.dry_run) continue;
    if (Number.isFinite(since) && !atOrAfter(d.generated_at, since)) continue;
    if (f.kind === "pre") {
      out.applyRounds++;
      out.queued += Array.isArray(d.jobs) ? d.jobs.length : 0;
      out.manual += Array.isArray(d.manual) ? d.manual.length : 0;
      for (const k of [].concat(d.jobs || [], d.manual || [], d.skipped || [])) {
        if (k && k.key) seen.add(k.key);
      }
      continue;
    }
    if (f.kind === "results") {
      for (const r of Array.isArray(d.results) ? d.results : []) {
        if (!r) continue;
        if (r.outcome === "submitted") out.submitted++;
        else if (r.outcome === "manual") out.manual++;
        else if (r.outcome === "failed") out.failed++;
        else if (r.outcome === "error") out.errors++;
        else if (r.outcome === "skipped" && r.reason === "deadline") out.deferred++;
        else if (r.outcome === "skipped") out.skipped++;
      }
    }
  }
  out.seenKeys = [...seen];
  return out;
}

// Filesystem-safe name for a row key ("greenhouse:123" → "greenhouse_123").
function safeKey(key) {
  return str(key || "row").replace(/[^A-Za-z0-9._-]+/g, "_");
}

// The memory blob as one markdown file the row workers read once. Kept out
// of the per-row JSON so no JSON string line runs to tens of kilobytes.
function renderMemoryMarkdown(memory) {
  const m = memory || {};
  const parts = [
    "# Candidate memory for this prepare round",
    "",
    "Generated by `night --phase prepare-fanout` from prepare_context.json `memory`.",
    "Sections map to `profile_context.memory.*` in the pipeline-fit-evaluator contract.",
    "",
  ];
  const section = (title, body) => {
    parts.push(`## ${title}`, "", body ? String(body).trim() : "(missing)", "");
  };
  section("fitProfile", m.fitProfile);
  section("writingStyle", m.writingStyle);
  section("resumeKeyPoints (legacy fallback — not for fit scoring)", m.resumeKeyPoints);
  const feedback = Array.isArray(m.feedback) ? m.feedback : [];
  if (!feedback.length) section("feedback", "(none)");
  for (const f of feedback) section(`feedback — ${str(f && f.file)}`, f && f.content);
  return parts.join("\n");
}

// One prepare batch entry → the row worker's input (pipeline-fit-evaluator
// contract, with memory and the JD body moved to files).
//   ctx: prepare_context.json
//   opts: { profileId, resumeVersions, companyTiers, paths: { memory, jd, result, tailor },
//           masterProfilePath, storybankPath }
function buildRowPayload(entry, ctx, opts = {}) {
  const tiers = opts.companyTiers || {};
  const company = str(entry.companyName);
  return {
    row_key: entry.key,
    result_path: opts.paths && opts.paths.result,
    jd_text_path: opts.paths && opts.paths.jd,
    memory_path: opts.paths && opts.paths.memory,
    tailor_dir: (opts.paths && opts.paths.tailor) || null,
    jd_status: entry.jdStatus || null,
    jd_structure: entry.jdStructure || null,
    profile_context: {
      profile_id: opts.profileId,
      company,
      title: str(entry.title),
      url: str(entry.url),
      geo_decision: entry.geo_decision || "allowed",
      salary: entry.salary || null,
      salaryConfig: (ctx && ctx.salaryConfig) || null,
      clBase: entry.clBase || null,
      roleTargets: (ctx && ctx.roleTargets) || null,
      resumeVersions: opts.resumeVersions || null,
      companyTier: Object.prototype.hasOwnProperty.call(tiers, company) ? tiers[company] : null,
      unknownTier: Boolean(entry.unknownTier),
    },
    tailoring: {
      master_profile_path: opts.masterProfilePath || null,
      storybank_path: opts.storybankPath || null,
      target_role_title: str(entry.title),
    },
  };
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// Validate one row worker result against what `prepare --phase commit`
// accepts. Returns { entry, companyTier, problems[] }. A row with problems is
// left out of the results file and stays in Inbox for the next round.
function normalizeRowResult(raw, expectedKey, { resumeVersionKeys } = {}) {
  const problems = [];
  if (!raw || typeof raw !== "object") return { entry: null, problems: ["not a JSON object"] };
  const entry = { ...raw };
  const key = entry.key || entry.row_key;
  delete entry.row_key;
  delete entry.result_path;
  if (key !== expectedKey) problems.push(`key mismatch: ${key} ≠ ${expectedKey}`);
  entry.key = expectedKey;

  if (entry.fitScore === "Skip") {
    entry.fitScore = "Weak";
    entry.flags = [].concat(entry.flags || [], "evaluator-skip");
  }
  if (!FIT_SCORES.has(entry.fitScore)) problems.push(`fitScore "${entry.fitScore}" invalid`);
  if (!isNonEmptyString(entry.fitRationale)) problems.push("fitRationale missing");

  const strongOrMedium = entry.fitScore === "Strong" || entry.fitScore === "Medium";
  if (strongOrMedium) {
    const p = entry.clParagraphs;
    if (!Array.isArray(p) || p.length !== 4 || !p.every(isNonEmptyString)) {
      problems.push("clParagraphs must be 4 non-empty strings");
    }
    if (!isNonEmptyString(entry.clKey)) problems.push("clKey missing");
    const keys = resumeVersionKeys instanceof Set ? resumeVersionKeys : null;
    if (!isNonEmptyString(entry.resumeVer)) problems.push("resumeVer missing");
    else if (keys && keys.size && !keys.has(entry.resumeVer)) {
      problems.push(`resumeVer "${entry.resumeVer}" not in resume_versions`);
    }
  }
  if (entry.fitScore === "Strong") {
    const tailored = entry.tailoredResume && typeof entry.tailoredResume === "object";
    if (!tailored && !entry.tailorEscalated) {
      problems.push("Strong row without tailoredResume (Step 6.5 skipped)");
    }
    if (entry.tailorEscalated && !STRONG_ESCALATION_REASONS.has(entry.tailorEscalationReason)) {
      problems.push(`tailorEscalationReason "${entry.tailorEscalationReason}" invalid`);
    }
  }
  if (entry.fitScore === "Weak") {
    // RFC 034 §5: Weak rows carry no cover letter.
    delete entry.clParagraphs;
  }

  let companyTier = null;
  if (entry.companyTier !== undefined) {
    if (TIERS.has(entry.companyTier)) companyTier = entry.companyTier;
    else if (entry.companyTier) problems.push(`companyTier "${entry.companyTier}" invalid`);
    delete entry.companyTier;
  }
  return { entry, companyTier, problems };
}

// batch: prepare_context.batch; byKey: Map(key → parsed result | undefined).
// opts: { unknownTierCompanies: string[], resumeVersionKeys: Set }
function collectRowResults(batch, byKey, opts = {}) {
  const results = [];
  const missing = [];
  const invalid = [];
  const companyTiers = {};
  const companyOf = new Map((batch || []).map((e) => [e.key, str(e.companyName)]));
  for (const e of batch || []) {
    const raw = byKey.get(e.key);
    if (raw === undefined) {
      missing.push(e.key);
      continue;
    }
    const { entry, companyTier, problems } = normalizeRowResult(raw, e.key, opts);
    if (problems.length) {
      invalid.push({ key: e.key, problems });
      continue;
    }
    if (companyTier) companyTiers[companyOf.get(e.key)] = companyTier;
    results.push(entry);
  }
  const untiered = (opts.unknownTierCompanies || []).filter(
    (c) =>
      !Object.prototype.hasOwnProperty.call(companyTiers, c) &&
      results.some((r) => companyOf.get(r.key) === c)
  );
  const counts = { Strong: 0, Medium: 0, Weak: 0 };
  for (const r of results) counts[r.fitScore]++;
  return { results, companyTiers, missing, invalid, untiered, counts };
}

// One apply_context job → the answer worker's input.
function buildQuestionJob(job, paths) {
  return {
    key: job.key,
    company: str(job.company),
    title: str(job.title),
    url: str(job.url),
    form_url: str(job.form_url),
    ats: str(job.ats),
    unanswered: Array.isArray(job.unanswered) ? job.unanswered : [],
    draft_path: paths.draft,
    review_path: paths.review,
    answers_path: paths.answers,
    bank_dir: paths.bank,
  };
}

module.exports = {
  computeDeadline,
  minutesLeft,
  prepareBatchSize,
  decideNextStep,
  countTsvSince,
  summarizeApplyFiles,
  safeKey,
  renderMemoryMarkdown,
  buildRowPayload,
  normalizeRowResult,
  collectRowResults,
  buildQuestionJob,
  parseClock,
  DEFAULT_STOP_AT,
  DEFAULT_MAX_HOURS,
  DEFAULT_TARGET,
  APPLY_MIN_BATCH,
};
