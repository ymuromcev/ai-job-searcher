// `apply` command — the bot fills and submits application forms (RFC 068).
//
// Three phases, same shape as `prepare` / `check`:
//
//   apply --profile <id> --phase pre [--limit N] [--concurrency N] [--dry-run]
//     Deterministic. Builds the queue (To Apply + Strong/Medium + never
//     applied + company cap), resolves aggregator links to the ATS form,
//     detects the ATS (unsupported → apply_state=manual), opens each form
//     headless, reads its schema, answers every field it can from identity /
//     apply_defaults / salary rule / the Notion answer bank, and writes
//     profiles/<id>/.apply-state/apply_context.json with the remaining
//     `unanswered[]` questions per job.
//
//   (LLM step — skill `job-pipeline`, mode `apply`) answers the unanswered
//     questions from the candidate's materials, truth-checks them, pushes
//     them to the bank and writes the answers file.
//
//   apply --profile <id> --phase submit --answers-file <f|dir> [--dry-run] [--concurrency N]
//         [--deadline <ISO>]
//     Deterministic. `--answers-file` is one answers JSON or a directory of
//     them (the night run writes one file per job). `--deadline`: no new form
//     is started after that time; the rest stay queued (outcome "skipped",
//     reason "deadline") for the next run. For every job whose required questions are all
//     answered: fill, attach resume + cover letter, pre-submit check,
//     re-check applied_date, Submit, wait for the adapter's confirmation,
//     screenshot. Success → status Applied / applied_by bot / apply_state
//     submitted (+ Notion status via notion_sync.updatePageStatus). No
//     confirmation → failed (never retried). Captcha / login / unexpected
//     screen → manual. `--dry-run` stops before the Submit click and keeps
//     a screenshot of the filled form.
//
// Safety rails (RFC 068 "Безопасность"):
//   - never two submissions for one job: applied_date is re-read from disk
//     right before the click; apply_state="queued" + apply_note
//     "submitting:<ts>" is persisted before the click so a crash mid-submit
//     is never auto-retried (see modules/apply/queue.js);
//   - no passwords, no accounts, no captcha solving — those pages stop as
//     manual with a reason;
//   - TSV writes go through applications_tsv.load/save under a mutex,
//     re-reading the file each time.
//
// The factory `makeApplyCommand(overrides)` lets tests inject every I/O dep.

/* global document -- page.evaluate callback runs in the browser */
const path = require("path");
const fs = require("fs");

const profileLoader = require("../core/profile_loader.js");
const applicationsTsv = require("../core/applications_tsv.js");
const { resolveProfilesDir, resolveDataDir } = require("../core/paths.js");
const notionSync = require("../core/notion_sync.js");
const { fetchAllAnswers, matchAnswers } = require("../core/qa_notion.js");
const { categorize } = require("../core/qa_categorize.js");
const { fetchJd } = require("../core/jd_cache.js");
const { extractJDStructure } = require("../core/jd_extract.js");
const { defaultFetch } = require("../modules/discovery/_http.js");
const { todayLocalISO } = require("../core/auto_no_response_sweep.js");
const { buildActiveCounts, resolveCapWindowDays } = require("./prepare.js");

const { detectAts, getAdapter } = require("../modules/apply/index.js");
const { resolveUrl, resolveViaPage, hostOf } = require("../modules/apply/resolve_url.js");
const {
  buildSlugIndex,
  canonicalFormUrl,
  checkPostingOpen,
} = require("../modules/apply/canonical_url.js");
const companiesTsv = require("../core/companies.js");
const { matchQuestion, pickOption, normalizeLabel } = require("../modules/apply/question_match.js");
const { parsePublishedRange, computeDesiredSalary } = require("../modules/apply/salary.js");
const { resolveResumePdf, resolveCoverLetterPdf } = require("../modules/apply/resume_path.js");
const { buildQueue, SUBMITTING_PREFIX } = require("../modules/apply/queue.js");
const { runPool, makeMutex } = require("../modules/apply/pool.js");
const { launchBrowser } = require("../modules/apply/browser.js");

const DEFAULT_CONCURRENCY = 4;
const STATE_DIR = ".apply-state";
const CONTEXT_FILE = "apply_context.json";

// Stop reasons that leave the job for a human (manual) vs. a submit that
// went out without confirmation (failed).
const MANUAL_REASONS = new Set([
  "captcha",
  "login_required",
  "email_verification",
  "unknown_page",
  "job_closed",
]);

// Bank answers to these categories are facts about the candidate (work
// logistics, tools, experience) and may be reused across companies when the
// question text is identical. Motivation / culture answers are
// company-specific and only reused on an exact company+role+question match.
const REUSABLE_CATEGORIES = new Set(["Logistics", "Technical", "Experience"]);

// --- helpers -----------------------------------------------------------------

function safeKey(key) {
  return String(key || "job").replace(/[^A-Za-z0-9._-]+/g, "_");
}

function isChoice(field) {
  return field.type === "select" || field.type === "radio" || field.type === "checkbox";
}

function readJsonIfExists(p, deps) {
  if (!deps.fileExists(p)) return null;
  return JSON.parse(deps.readFile(p));
}

function loadApplyDefaults(profile, deps) {
  if (profile.applyDefaults !== undefined) return profile.applyDefaults;
  // Fallback until the loader exposes `profile.applyDefaults` (RFC 068 U1).
  try {
    return readJsonIfExists(path.join(profile.paths.root, "apply_defaults.json"), deps);
  } catch {
    return null;
  }
}

function aggregatorHost(host) {
  return /(^|\.)(adzuna\.[a-z.]+|lnkd\.in|grnh\.se|bit\.ly|t\.co|linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com|substack\.com|beehiiv\.com|mailchi\.mp|list-manage\.com)$/i.test(
    host
  );
}

// Map one bank row onto a field. Choice fields must land on an option.
function bankValue(field, answer) {
  if (!answer) return null;
  if (isChoice(field)) return pickOption(field.options, answer);
  return answer;
}

function searchBank(bank, job, field) {
  if (!bank || !bank.length) return null;
  const { exact, partials } = matchAnswers(bank, {
    company: job.company,
    role: job.title,
    question: field.label,
  });
  if (exact) {
    const v = bankValue(field, exact.answer);
    if (v) return { source: "bank", value: v, bank_page_id: exact.pageId || null };
  }
  const q = String(field.label || "")
    .trim()
    .toLowerCase();
  for (const p of partials || []) {
    if (
      String(p.question || "")
        .trim()
        .toLowerCase() !== q
    )
      continue;
    const category = p.category || categorize(field.label);
    if (!REUSABLE_CATEGORIES.has(category)) continue;
    // An answer that names its original company is not portable.
    if (p.company && new RegExp(`\\b${escapeRe(p.company)}\\b`, "i").test(p.answer || "")) continue;
    const v = bankValue(field, p.answer);
    if (v) return { source: "bank_reuse", value: v, bank_page_id: p.pageId || null };
  }
  return null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Resolve every field of a form. Returns { answers[], unanswered[], blockers[] }.
//   files: { resume: {rel}, cover_letter: {rel} | null }
function resolveFields(fields, { job, identity, applyDefaults, salary, bank, files }) {
  const answers = [];
  const unanswered = [];
  const blockers = [];
  for (const field of fields) {
    const m = matchQuestion(field, { identity, applyDefaults, salary });
    if (m && m.source === "file") {
      const f = files[m.value];
      if (f) {
        answers.push({ field_id: field.id, label: field.label, value: f.rel, source: "file" });
      } else if (field.required) {
        blockers.push(`${m.value}_missing`);
      }
      continue;
    }
    if (field.type === "file") {
      if (field.required) blockers.push("unsupported_required_file");
      continue;
    }
    if (m && m.value !== "" && m.value != null) {
      answers.push({ field_id: field.id, label: field.label, value: m.value, source: m.source });
      continue;
    }
    const b = searchBank(bank, job, field);
    if (b) {
      answers.push({ field_id: field.id, label: field.label, ...b });
      continue;
    }
    unanswered.push({
      field_id: field.id,
      label: field.label,
      type: field.type,
      options: field.options || [],
      required: Boolean(field.required),
    });
  }
  return { answers, unanswered, blockers };
}

// Merge context answers + LLM answers into a { fieldId → value } plan for a
// live schema. Matching: field id first, then normalized label.
function buildFillPlan(liveFields, contextJob, llmAnswers, profileRoot) {
  const byId = new Map();
  const byLabel = new Map();
  for (const a of contextJob.answers || []) {
    byId.set(a.field_id, a);
    byLabel.set(normalizeLabel(a.label), a);
  }
  for (const a of llmAnswers || []) {
    const k = normalizeLabel(a.label);
    if (!byLabel.has(k)) byLabel.set(k, { ...a, value: a.answer, source: "llm" });
  }
  const values = {};
  const missingRequired = [];
  for (const f of liveFields) {
    const a = byId.get(f.id) || byLabel.get(normalizeLabel(f.label));
    let v = a ? a.value : null;
    if (v != null && a.source === "file") v = path.resolve(profileRoot, String(v));
    if (v != null && isChoice(f) && f.options && f.options.length) {
      if (Array.isArray(v)) {
        v = v.map((x) => pickOption(f.options, x)).filter(Boolean);
        if (!v.length) v = null;
      } else {
        v = pickOption(f.options, v);
      }
    }
    if (v == null || v === "") {
      if (f.required) missingRequired.push(f.id);
      continue;
    }
    values[f.id] = v;
  }
  return { values, missingRequired };
}

// --- deps --------------------------------------------------------------------

function makeDefaultDeps() {
  return {
    loadProfile: profileLoader.loadProfile,
    loadSecrets: profileLoader.loadSecrets,
    loadApplications: applicationsTsv.load,
    saveApplications: applicationsTsv.save,
    buildActiveCounts,
    resolveCapWindowDays,
    fetchFn: defaultFetch,
    resolveUrl,
    resolveViaPage,
    checkPostingOpen,
    loadCompanies: companiesTsv.load,
    detectAts,
    getAdapter,
    launchBrowser,
    fetchJd,
    extractJDStructure,
    makeNotionClient: notionSync.makeClient,
    fetchAllAnswers,
    updatePageStatus: notionSync.updatePageStatus,
    readFile: (p) => fs.readFileSync(p, "utf8"),
    writeFile: (p, data) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, p);
    },
    fileExists: (p) => fs.existsSync(p),
    isDirectory: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
    listDir: (p) => fs.readdirSync(p),
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
    now: () => new Date(),
    today: () => todayLocalISO(),
  };
}

function stateDir(profile) {
  return path.join(profile.paths.root, STATE_DIR);
}

function concurrencyOf(flags) {
  const n = Number(flags.concurrency);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CONCURRENCY;
}

// Lazily launched, shared browser for one run.
function makeBrowserHandle(deps) {
  let launching = null;
  return {
    async get() {
      if (!launching) launching = deps.launchBrowser({ headless: true });
      return launching;
    },
    async close() {
      if (!launching) return;
      try {
        const b = await launching;
        await b.close();
      } catch {
        // launch failed — nothing to close
      }
    },
  };
}

// Read-modify-write one TSV row under the mutex. `mutate(app)` edits in place.
function makeRowWriter(applicationsPath, deps, { dryRun }) {
  const withLock = makeMutex();
  return function writeRow(key, mutate) {
    if (dryRun) return Promise.resolve(false);
    return withLock(async () => {
      const { apps } = deps.loadApplications(applicationsPath);
      const app = apps.find((a) => a.key === key);
      if (!app) return false;
      mutate(app);
      deps.saveApplications(applicationsPath, apps);
      return true;
    });
  };
}

// --- Phase: pre --------------------------------------------------------------

async function pageText(page) {
  if (!page || typeof page.evaluate !== "function") return "";
  try {
    return String(await page.evaluate(() => (document.body ? document.body.innerText : "")));
  } catch {
    return "";
  }
}

async function salaryForJob(job, ats, adapter, resolvedUrl, profile, deps, applyDefaults) {
  let text = "";
  const ref = adapter && adapter.jobRef ? adapter.jobRef(resolvedUrl) : null;
  if (ref && ref.slug && ref.jobId) {
    try {
      const jd = await deps.fetchJd(
        { source: ats, slug: ref.slug, jobId: ref.jobId },
        profile.paths.jdCacheDir
      );
      text = (jd && jd.text) || "";
    } catch {
      text = "";
    }
  }
  let range = null;
  if (text) {
    const structure = deps.extractJDStructure(text);
    range =
      parsePublishedRange((structure && structure.salary_text) || "") || parsePublishedRange(text);
  }
  const desired = computeDesiredSalary({ range, salaryCfg: applyDefaults && applyDefaults.salary });
  return { range, desired };
}

// Where is this job's application form? Order:
//   1. ATS-sourced row + board slug (companies.tsv or the row URL) → the
//      canonical form URL, after a posting-API liveness check (404 → closed).
//   2. No URL at all → manual `no_application_url`.
//   3. Fetch-based redirect resolver; for aggregators that block fetch
//      (Adzuna) a real browser page is tried next.
// Returns { res } | { closed: true } | { manual } | { skip }.
async function resolveJobUrl(app, env) {
  const { deps, slugIndex, browser } = env;
  const canon = canonicalFormUrl(app, slugIndex);
  if (canon) {
    const state = await deps.checkPostingOpen(canon, deps.fetchFn);
    if (state === "closed") return { closed: true };
    return { res: { ok: true, url: canon.url, ats: canon.ats, via: "canonical" } };
  }
  if (!String(app.url || "").trim()) return { manual: "no_application_url" };

  let res = await deps.resolveUrl(app.url, { fetchFn: deps.fetchFn, detectAts: deps.detectAts });
  const origHost = hostOf(app.url);
  // Aggregators (Adzuna) answer node fetch with 403/404 even for live ads, so
  // a "dead" from fetch is re-checked in the browser before it is believed.
  if (!res.ok && res.reason !== "unsafe_url" && aggregatorHost(origHost)) {
    const b = await browser.get();
    const { page, close } = await b.newPage();
    try {
      const viaPage = await deps.resolveViaPage(page, app.url, { detectAts: deps.detectAts });
      if (viaPage.ok) {
        res = viaPage;
      } else if (viaPage.reason === "no_ats" && viaPage.url && hostOf(viaPage.url) !== origHost) {
        // Landed on the employer's page: let the fetch resolver find the ATS.
        res = await deps.resolveUrl(viaPage.url, {
          fetchFn: deps.fetchFn,
          detectAts: deps.detectAts,
        });
      } else if (res.reason !== "dead" || viaPage.reason === "no_ats") {
        // A live aggregator page without an ATS link overrides a fetch 404
        // (manual, not dead). A blocked browser does not overrule fetch's 404.
        res = viaPage;
      }
    } finally {
      await close();
    }
  }
  if (!res.ok) {
    if (res.reason === "dead") return { skip: "url_dead" };
    const host = hostOf(res.url) || origHost;
    if (res.reason === "no_ats" && !aggregatorHost(host)) {
      return { manual: `unsupported_ats:${host}` };
    }
    return { manual: `unresolved_url:${origHost || host}` };
  }
  const ats = res.ats || deps.detectAts(res.url);
  const adapter = ats ? deps.getAdapter(ats) : null;
  const ref = adapter && adapter.jobRef ? adapter.jobRef(res.url) : null;
  if (ref && ref.slug && ref.jobId) {
    const state = await deps.checkPostingOpen(
      { ats, slug: ref.slug, jobId: ref.jobId },
      deps.fetchFn
    );
    if (state === "closed") return { closed: true };
  }
  return { res: { ...res, ats } };
}

async function preparePreJob(app, env) {
  const { profile, deps, applyDefaults, bank, browser, stderr } = env;
  const job = { key: app.key, company: app.companyName, title: app.title, url: app.url };

  const where = await resolveJobUrl(app, env);
  if (where.closed) return { job, closed: true };
  if (where.manual) return { job, manual: where.manual };
  if (where.skip) return { job, skip: where.skip };
  const res = where.res;
  const ats = res.ats;
  if (!ats) return { job, manual: `unsupported_ats:${hostOf(res.url)}` };
  const adapter = deps.getAdapter(ats);
  if (!adapter) return { job, manual: `unsupported_ats:${hostOf(res.url)}` };
  const formUrl = adapter.normalizeUrl(res.url);

  const resume = resolveResumePdf(app, profile, { exists: deps.fileExists });
  if (resume.error) return { job, manual: resume.error };
  const cl = resolveCoverLetterPdf(app, profile, { exists: deps.fileExists });

  let salary = await salaryForJob(job, ats, adapter, res.url, profile, deps, applyDefaults);
  if (salary.desired.belowFloor) return { job, skip: "salary_below_floor" };

  const b = await browser.get();
  const { page, close } = await b.newPage();
  try {
    const opened = await adapter.open(page, formUrl);
    if (!opened.ok && opened.reason === "job_closed") return { job, closed: true };
    if (!opened.ok) return { job, manual: opened.reason };
    // No JD in the cache / API: Greenhouse renders the posting (with its
    // pay range) above the form, so read the range off the page itself.
    if (!salary.range) {
      const range = parsePublishedRange(await pageText(page));
      if (range) {
        salary = {
          range,
          desired: computeDesiredSalary({
            range,
            salaryCfg: applyDefaults && applyDefaults.salary,
          }),
        };
        if (salary.desired.belowFloor) return { job, skip: "salary_below_floor" };
      }
    }
    const fields = await adapter.readSchema(page);
    const { answers, unanswered, blockers } = resolveFields(fields, {
      job,
      identity: profile.identity || {},
      applyDefaults,
      salary: salary.desired,
      bank,
      files: { resume: { rel: resume.rel }, cover_letter: cl ? { rel: cl.rel } : null },
    });
    if (blockers.length) return { job, manual: blockers[0] };
    return {
      job,
      entry: {
        key: app.key,
        company: app.companyName,
        title: app.title,
        url: app.url,
        resolved_url: res.url,
        form_url: formUrl,
        ats,
        tenant: adapter.tenantKey(res.url),
        resume: resume.rel,
        cover_letter: cl ? cl.rel : null,
        salary: {
          published_range: salary.range,
          desired: salary.desired.value,
          source: salary.desired.source,
        },
        fields,
        answers,
        unanswered,
      },
    };
  } catch (err) {
    stderr(`apply pre: ${app.key}: ${err.message}`);
    return { job, manual: "unknown_page" };
  } finally {
    await close();
  }
}

async function runPre(ctx, deps) {
  const { profileId, flags, stdout, stderr } = ctx;
  const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);
  const profile = deps.loadProfile(profileId, { profilesDir });
  const applyDefaults = loadApplyDefaults(profile, deps);
  if (!applyDefaults) {
    stderr(
      `warn: no apply defaults for "${profileId}" (profiles/${profileId}/apply_defaults.json) — ` +
        `work authorization / EEO / salary questions will go to the LLM step`
    );
  }
  const applicationsPath = profile.paths.applicationsTsv;
  const { apps } = deps.loadApplications(applicationsPath);
  const filterRules = profile.filterRules || {};
  const { queue, skipped } = buildQueue(apps, {
    filterRules,
    buildActiveCounts: deps.buildActiveCounts,
    windowDays: deps.resolveCapWindowDays(filterRules),
    now: deps.now(),
    limit: Number.isFinite(flags.limit) && flags.limit > 0 ? flags.limit : null,
  });
  stdout(`apply queue: ${queue.length} job(s) (${skipped.length} gated out)`);

  // Answer bank — fetched once, matched locally per question.
  let bank = [];
  const dbId = profile.notion && profile.notion.application_qa_db_id;
  const secrets = deps.loadSecrets(profileId, ctx.env || {}) || {};
  if (dbId && secrets.NOTION_TOKEN && queue.length) {
    try {
      bank = await deps.fetchAllAnswers(deps.makeNotionClient(secrets.NOTION_TOKEN), dbId);
      stdout(`answer bank: ${bank.length} answer(s)`);
    } catch (err) {
      stderr(`warn: answer bank unavailable (${err.message}) — bank answers skipped`);
    }
  }

  // Board slugs for ATS-sourced rows (canonical form URLs).
  let slugIndex = new Map();
  try {
    const companiesPath = path.join(
      resolveDataDir(ctx.env || process.env),
      "data",
      "companies.tsv"
    );
    slugIndex = buildSlugIndex(deps.loadCompanies(companiesPath).rows);
  } catch (err) {
    stderr(
      `warn: data/companies.tsv unavailable (${err.message}) — falling back to URL resolution`
    );
  }

  const browser = makeBrowserHandle(deps);
  const env = { profile, deps, applyDefaults, bank, browser, stderr, slugIndex };
  let results;
  try {
    results = await runPool(queue, {
      concurrency: concurrencyOf(flags),
      // One open form per ATS tenant: the canonical board when known,
      // otherwise the raw host + first path segment.
      keyOf: (app) => {
        const c = canonicalFormUrl(app, slugIndex);
        if (c) return `${c.ats}:${c.slug.toLowerCase()}`;
        return app.url ? hostOf(app.url) + pathHead(app.url) : null;
      },
      worker: (app) => preparePreJob(app, env),
    });
  } finally {
    await browser.close();
  }

  const jobs = [];
  const manual = [];
  const closed = [];
  const skippedNow = [];
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i] || {};
    const app = queue[i];
    if (r.error) {
      manual.push({
        key: app.key,
        company: app.companyName,
        title: app.title,
        reason: "unknown_page",
      });
      continue;
    }
    if (r.entry) jobs.push(r.entry);
    else if (r.closed) closed.push({ ...r.job, reason: "job_closed" });
    else if (r.manual) manual.push({ ...r.job, reason: r.manual });
    else if (r.skip) skippedNow.push({ ...r.job, reason: r.skip });
  }

  // Persist states: manual reasons for the human list, "queued" for jobs
  // carried to the LLM / submit steps.
  if (!flags.dryRun) {
    const byKey = new Map(apps.map((a) => [a.key, a]));
    for (const m of manual) {
      const a = byKey.get(m.key);
      if (!a) continue;
      a.apply_state = "manual";
      a.apply_note = m.reason;
    }
    for (const j of jobs) {
      const a = byKey.get(j.key);
      if (!a) continue;
      a.apply_state = "queued";
      a.apply_note = "";
    }
    // Closed postings are not work for anyone: the job itself is Closed.
    const nowIso = deps.now().toISOString();
    for (const c of closed) {
      const a = byKey.get(c.key);
      if (!a) continue;
      a.status = "Closed";
      a.apply_state = "";
      a.apply_note = "job_closed";
      a.updatedAt = nowIso;
    }
    if (manual.length || jobs.length || closed.length)
      deps.saveApplications(applicationsPath, apps);
    await pushClosedToNotion(closed, byKey, profile, secrets, deps, stderr);
  }

  const context = {
    generated_at: deps.now().toISOString(),
    profile: profileId,
    jobs,
    manual,
    closed,
    skipped: [...skipped, ...skippedNow],
  };
  const contextPath = path.join(stateDir(profile), CONTEXT_FILE);
  deps.writeFile(contextPath, JSON.stringify(context, null, 2));
  // Small stamped record of this pre run, next to apply_results-*.json: the
  // nightly run log (`night --phase finish`) counts rounds / queued / manual
  // from these, and `night --phase check` uses the keys to tell rows already
  // looked at tonight from fresh ones (apply_context.json is overwritten).
  const preStamp = context.generated_at.replace(/[:.]/g, "-");
  const keyOf = (x) => ({ key: x.key, reason: x.reason });
  deps.writeFile(
    path.join(stateDir(profile), `apply_pre-${preStamp}.json`),
    JSON.stringify(
      {
        generated_at: context.generated_at,
        dry_run: Boolean(flags.dryRun),
        jobs: jobs.map((j) => ({ key: j.key })),
        manual: manual.map(keyOf),
        skipped: skippedNow.map(keyOf),
      },
      null,
      2
    )
  );

  const needLlm = jobs.filter((j) => j.unanswered.some((u) => u.required)).length;
  stdout(
    `apply pre: ${jobs.length} form(s) read — ${jobs.length - needLlm} fully answered, ` +
      `${needLlm} need the LLM step; ${manual.length} manual; ${closed.length} closed; ` +
      `${skippedNow.length} skipped`
  );
  for (const m of manual) stdout(`  manual  ${m.company} — ${m.title}: ${m.reason}`);
  stdout(`context: ${path.relative(process.cwd(), contextPath)}`);
  return 0;
}

// Mirror Closed onto the Notion job pages through the shared status writer.
async function pushClosedToNotion(closed, byKey, profile, secrets, deps, stderr) {
  if (!closed.length || !secrets.NOTION_TOKEN) return;
  const client = deps.makeNotionClient(secrets.NOTION_TOKEN);
  const propertyMap =
    (profile.notion && profile.notion.property_map) || notionSync.DEFAULT_PROPERTY_MAP;
  for (const c of closed) {
    const a = byKey.get(c.key);
    if (!a || !a.notion_page_id) continue;
    try {
      await deps.updatePageStatus(client, a.notion_page_id, "Closed", propertyMap);
    } catch (err) {
      stderr(`warn: Notion status Closed failed for ${c.key}: ${err.message}`);
    }
  }
}

function pathHead(u) {
  try {
    return `/${new URL(u).pathname.split("/")[1] || ""}`;
  } catch {
    return "";
  }
}

// --- Phase: submit -----------------------------------------------------------

function readAnswersList(abs, deps) {
  const parsed = JSON.parse(deps.readFile(abs));
  const list = Array.isArray(parsed && parsed.answers) ? parsed.answers : null;
  if (!list) throw new Error(`answers file must be {"answers": [...]}: ${abs}`);
  return list;
}

// One answers JSON, or a directory of them (*.json, one per job — the night
// run's answers/ folder). An empty directory is valid: every job is then
// submitted on its deterministic answers alone.
function loadAnswersFile(file, deps) {
  const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  if (!deps.fileExists(abs)) throw new Error(`answers file not found: ${abs}`);
  let list;
  if (deps.isDirectory && deps.isDirectory(abs)) {
    list = [];
    const names = deps
      .listDir(abs)
      .filter((n) => n.endsWith(".json") && !n.startsWith("."))
      .sort();
    for (const name of names) list.push(...readAnswersList(path.join(abs, name), deps));
  } else {
    list = readAnswersList(abs, deps);
  }
  const byKey = new Map();
  for (const a of list) {
    if (!a || typeof a.key !== "string" || typeof a.label !== "string") continue;
    if (a.answer == null || a.answer === "") continue;
    if (!byKey.has(a.key)) byKey.set(a.key, []);
    byKey.get(a.key).push(a);
  }
  return byKey;
}

async function screenshot(page, absPath, deps) {
  try {
    deps.mkdirp(path.dirname(absPath));
    await page.screenshot({ path: absPath, fullPage: true });
    return true;
  } catch {
    return false;
  }
}

function freshRow(applicationsPath, key, deps) {
  const { apps } = deps.loadApplications(applicationsPath);
  return apps.find((a) => a.key === key) || null;
}

function alreadyApplied(row) {
  if (!row) return "row_missing";
  if (String(row.applied_date || "").trim()) return "already_applied";
  if (row.apply_state === "submitted") return "already_applied";
  // A previous submit run died between the Submit click and the result
  // write: the application may have gone out. Re-running submit on the same
  // context must never click again — a human checks it (BL-225).
  if (String(row.apply_note || "").startsWith(SUBMITTING_PREFIX)) return "interrupted_submit";
  if (row.status !== "To Apply") return `status_${String(row.status || "").replace(/\s+/g, "_")}`;
  return null;
}

async function submitOne(job, env) {
  const { profile, deps, browser, flags, writeRow, applicationsPath, llmByKey, stdout } = env;
  const root = profile.paths.root;
  const shotRel = path.join(STATE_DIR, "shots", `${safeKey(job.key)}.png`);
  const shotAbs = path.join(root, shotRel);
  const out = { key: job.key, company: job.company, title: job.title, ats: job.ats };

  // Night wall-clock budget: past the deadline no new form is opened. The
  // row keeps apply_state "queued" (no "submitting:" mark), so the next run
  // picks it up again.
  if (env.deadlineMs !== null && deps.now().getTime() >= env.deadlineMs) {
    return { ...out, outcome: "skipped", reason: "deadline" };
  }

  // Required questions answered (context + LLM)? Checked before the browser.
  const pre = buildFillPlan(job.fields || [], job, llmByKey.get(job.key) || [], root);
  if (pre.missingRequired.length) return { ...out, outcome: "manual", reason: "no_honest_answer" };

  const guard = alreadyApplied(freshRow(applicationsPath, job.key, deps));
  if (guard) return { ...out, outcome: "skipped", reason: guard };

  const adapter = deps.getAdapter(job.ats);
  if (!adapter) return { ...out, outcome: "manual", reason: `unsupported_ats:${job.ats}` };

  const b = await browser.get();
  const { page, close } = await b.newPage();
  try {
    const opened = await adapter.open(page, job.form_url);
    if (!opened.ok) return { ...out, outcome: "manual", reason: opened.reason };

    const live = await adapter.readSchema(page);
    const plan = buildFillPlan(live, job, llmByKey.get(job.key) || [], root);
    if (plan.missingRequired.length) {
      return { ...out, outcome: "manual", reason: "schema_changed", detail: plan.missingRequired };
    }
    const filled = await adapter.fill(page, plan.values);
    const requiredIds = new Set(live.filter((f) => f.required).map((f) => f.id));
    const hardErrors = filled.errors.filter((e) => requiredIds.has(e.id));
    if (hardErrors.length) {
      await screenshot(page, shotAbs, deps);
      return {
        ...out,
        outcome: "manual",
        reason: `fill_error:${hardErrors[0].error}`,
        detail: hardErrors,
      };
    }
    const check = await adapter.checkFilled(page);
    if (check.missing.length) {
      await screenshot(page, shotAbs, deps);
      return { ...out, outcome: "manual", reason: "presubmit_check", detail: check.missing };
    }

    if (flags.dryRun) {
      await screenshot(page, shotAbs, deps);
      return { ...out, outcome: "dry_run", screenshot: shotRel };
    }

    // Final double-apply guard, then mark the attempt before clicking.
    const last = alreadyApplied(freshRow(applicationsPath, job.key, deps));
    if (last) return { ...out, outcome: "skipped", reason: last };
    await writeRow(job.key, (a) => {
      a.apply_state = "queued";
      a.apply_note = `${SUBMITTING_PREFIX}${deps.now().toISOString()}`;
    });

    const result = await adapter.submit(page);
    await screenshot(page, shotAbs, deps);
    if (result.ok) {
      stdout(`  applied  ${job.company} — ${job.title}`);
      return { ...out, outcome: "submitted", screenshot: shotRel, evidence: result.evidence };
    }
    const outcome = MANUAL_REASONS.has(result.reason) ? "manual" : "failed";
    return {
      ...out,
      outcome,
      reason: result.reason,
      evidence: result.evidence,
      screenshot: shotRel,
    };
  } catch (err) {
    await screenshot(page, shotAbs, deps);
    return { ...out, outcome: "manual", reason: "unknown_page", detail: err.message };
  } finally {
    await close();
  }
}

async function recordOutcome(r, env) {
  const { deps, writeRow, notion } = env;
  if (!r || r.outcome === "skipped" || r.outcome === "dry_run") return;
  if (r.outcome === "submitted") {
    const today = deps.today();
    let pageId = "";
    await writeRow(r.key, (a) => {
      a.status = "Applied";
      a.applied_date = today;
      a.applied_by = "bot";
      a.apply_state = "submitted";
      a.apply_note = r.screenshot || "";
      a.updatedAt = deps.now().toISOString();
      pageId = a.notion_page_id || "";
    });
    if (pageId && notion.client) {
      try {
        await deps.updatePageStatus(notion.client, pageId, "Applied", notion.propertyMap);
        r.notion = "updated";
      } catch (err) {
        r.notion = `error: ${err.message}`;
      }
    }
    return;
  }
  await writeRow(r.key, (a) => {
    a.apply_state = r.outcome === "failed" ? "failed" : "manual";
    a.apply_note = r.reason || r.outcome;
  });
}

async function runSubmit(ctx, deps) {
  const { profileId, flags, stdout, stderr } = ctx;
  const answersFile = String(flags.answersFile || "").trim();
  if (!answersFile) {
    stderr("error: --phase submit requires --answers-file <path>");
    return 1;
  }
  const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);
  const profile = deps.loadProfile(profileId, { profilesDir });
  const contextPath = path.join(stateDir(profile), CONTEXT_FILE);
  if (!deps.fileExists(contextPath)) {
    stderr(`error: ${contextPath} not found — run apply --phase pre first`);
    return 1;
  }
  const context = JSON.parse(deps.readFile(contextPath));
  let llmByKey;
  try {
    llmByKey = loadAnswersFile(answersFile, deps);
  } catch (err) {
    stderr(`error: ${err.message}`);
    return 1;
  }

  let deadlineMs = null;
  if (flags.deadline) {
    deadlineMs = Date.parse(String(flags.deadline));
    if (!Number.isFinite(deadlineMs)) {
      stderr(`error: --deadline must be an ISO timestamp, got "${flags.deadline}"`);
      return 1;
    }
  }

  const applicationsPath = profile.paths.applicationsTsv;
  const writeRow = makeRowWriter(applicationsPath, deps, { dryRun: flags.dryRun });

  const secrets = deps.loadSecrets(profileId, ctx.env || {}) || {};
  const notion = {
    client:
      secrets.NOTION_TOKEN && !flags.dryRun ? deps.makeNotionClient(secrets.NOTION_TOKEN) : null,
    propertyMap: (profile.notion && profile.notion.property_map) || notionSync.DEFAULT_PROPERTY_MAP,
  };
  if (!secrets.NOTION_TOKEN && !flags.dryRun) {
    stderr(
      `warn: missing ${profileLoader.secretEnvName(profileId, "NOTION_TOKEN")} — ` +
        `Applied is written to the TSV only; sync will not see it in Notion until the status is set there`
    );
  }

  const jobs = Array.isArray(context.jobs) ? context.jobs : [];
  stdout(
    `apply submit: ${jobs.length} job(s)${flags.dryRun ? " (dry-run — no Submit click)" : ""}`
  );
  const browser = makeBrowserHandle(deps);
  const env = {
    profile,
    deps,
    browser,
    flags,
    writeRow,
    applicationsPath,
    llmByKey,
    notion,
    stdout,
    deadlineMs,
  };
  let results;
  try {
    results = await runPool(jobs, {
      concurrency: concurrencyOf(flags),
      keyOf: (job) => job.tenant || job.ats,
      worker: async (job) => {
        const r = await submitOne(job, env);
        await recordOutcome(r, env);
        return r;
      },
    });
  } finally {
    await browser.close();
  }

  const normalized = results.map((r, i) =>
    r && r.error
      ? {
          key: jobs[i].key,
          company: jobs[i].company,
          title: jobs[i].title,
          outcome: "error",
          reason: "worker_error",
          detail: r.error,
        }
      : r
  );
  // A worker that threw leaves its row untouched — if it got as far as the
  // Submit click, the row carries apply_state "queued" + "submitting:<ts>"
  // and the queue keeps it away from automatic retries.
  const count = (o) => normalized.filter((r) => r && r.outcome === o).length;
  const stamp = deps.now().toISOString().replace(/[:.]/g, "-");
  const resultsPath = path.join(stateDir(profile), `apply_results-${stamp}.json`);
  deps.writeFile(
    resultsPath,
    JSON.stringify(
      {
        generated_at: deps.now().toISOString(),
        dry_run: Boolean(flags.dryRun),
        results: normalized,
      },
      null,
      2
    )
  );
  const deferred = normalized.filter(
    (r) => r && r.outcome === "skipped" && r.reason === "deadline"
  ).length;
  stdout(
    `apply submit: ${count("submitted")} submitted, ${count("dry_run")} dry-run, ` +
      `${count("manual")} manual, ${count("failed")} failed, ${count("skipped")} skipped` +
      (deferred ? ` (${deferred} left for the next run: deadline)` : "")
  );
  for (const r of normalized) {
    if (r && (r.outcome === "manual" || r.outcome === "failed" || r.outcome === "error")) {
      stdout(`  ${r.outcome.padEnd(6)} ${r.company} — ${r.title}: ${r.reason}`);
    }
  }
  stdout(`results: ${path.relative(process.cwd(), resultsPath)}`);
  return 0;
}

// --- factory -----------------------------------------------------------------

function makeApplyCommand(overrides = {}) {
  const deps = { ...makeDefaultDeps(), ...overrides };
  return async function applyCommand(ctx) {
    const phase = (ctx.flags && ctx.flags.phase) || "";
    if (phase === "pre") return runPre(ctx, deps);
    if (phase === "submit") return runSubmit(ctx, deps);
    ctx.stderr("error: --phase <pre|submit> is required for the apply command");
    return 1;
  };
}

module.exports = makeApplyCommand();
module.exports.makeApplyCommand = makeApplyCommand;
module.exports.resolveFields = resolveFields;
module.exports.buildFillPlan = buildFillPlan;
module.exports.searchBank = searchBank;
module.exports.loadAnswersFile = loadAnswersFile;
module.exports.alreadyApplied = alreadyApplied;
module.exports.CONTEXT_FILE = CONTEXT_FILE;
module.exports.STATE_DIR = STATE_DIR;
