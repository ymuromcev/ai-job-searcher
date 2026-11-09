// `questions` command — the owner's questions queue (RFC 070, BL-231).
//
//   questions --profile <id> [--phase <pull|requeue|push>] [--apply]
//
// No --phase runs all three, in this order:
//
//   pull     Entries of the Notion Application Q&A database the owner marked
//            "Answered" (with a non-empty Answer) become the bot's standing
//            answers; entries marked "Skip such jobs" become skip rules.
//            Both land in profiles/<id>/apply_defaults.json
//            (`standing_answers` / `skip_questions`, tagged with
//            `notion_page_id`; the owner's own entries are never touched,
//            Notion-tagged ones are replaced by what Notion says now). The
//            drafter and the truth review read standing_answers as a source;
//            `apply --phase pre` fills an exact match itself and skips forms
//            that ask a skip-rule question.
//
//   requeue  Rows skipped as `no_honest_answer` (still To Apply, never
//            applied, not Ashby) whose every blocking question now has a
//            standing answer → apply_state "queued", apply_note
//            "requeued:<date> answers". A row with a skip-rule question
//            stays skipped, apply_note "no_honest_answer: owner_skip: …".
//            The keys go to .apply-state/questions.json so the morning
//            report can count what went out thanks to the owner's answers.
//
//   push     The remaining blocking questions, one entry per distinct
//            question (same question across companies → one entry listing
//            the jobs), are added to the Q&A database as "Waiting for
//            answer" (Status / Question key / Jobs properties are added to
//            the database first when missing). An entry already there is
//            updated (its job list), never duplicated; answered and skipped
//            entries are left alone. "Prove you are human" and "certify no
//            AI was used" questions are never pushed.
//
// Default is a dry run that reads Notion and prints the plan; --apply
// writes apply_defaults.json, the TSV (under its lock, every row re-checked
// on the fresh file), Notion and .apply-state/questions.json. Without a
// Notion token or Q&A database, pull and push are skipped and requeue runs
// on the standing answers already on disk.

const fs = require("fs");
const path = require("path");

const profileLoader = require("../core/profile_loader.js");
const applicationsTsv = require("../core/applications_tsv.js");
const { resolveProfilesDir } = require("../core/paths.js");
const { makeClient } = require("../core/notion_sync.js");
const qaNotion = require("../core/qa_notion.js");
const { categorize } = require("../core/qa_categorize.js");
const { APPLY_DEFAULTS_FILE, validateApplyDefaults } = require("../core/apply_defaults.js");
const { todayLocalISO } = require("../core/auto_dead_sweep.js");
const oq = require("../core/owner_questions.js");

const VALID_PHASES = ["pull", "requeue", "push"];
const REQUEUED_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function makeDefaultDeps() {
  return {
    loadProfile: profileLoader.loadProfile,
    loadSecrets: profileLoader.loadSecrets,
    loadApplications: applicationsTsv.load,
    saveApplications: applicationsTsv.save,
    withApplicationsLock: applicationsTsv.withLock,
    readFile: (p) => fs.readFileSync(p, "utf8"),
    fileExists: (p) => fs.existsSync(p),
    writeFile: (p, data) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, p);
    },
    makeNotionClient: makeClient,
    fetchAllAnswers: qaNotion.fetchAllAnswers,
    ensurePendingSchema: qaNotion.ensurePendingSchema,
    createPendingPage: qaNotion.createPendingPage,
    updatePendingPage: qaNotion.updatePendingPage,
    today: () => todayLocalISO(),
    now: () => new Date(),
  };
}

function statePath(profile) {
  return oq.statePath(profile.paths.root);
}

function readJson(p, deps) {
  if (!deps.fileExists(p)) return null;
  try {
    return JSON.parse(deps.readFile(p));
  } catch {
    return null;
  }
}

// The "Waiting for answer" view the owner opens: profile setting, else the
// database itself.
function viewUrl(profile) {
  const n = (profile && profile.notion) || {};
  if (n.application_qa_waiting_view_url) return String(n.application_qa_waiting_view_url);
  const id = String(n.application_qa_db_id || "").replace(/-/g, "");
  return id ? `https://www.notion.so/${id}` : null;
}

function who(app) {
  return `${app.companyName || "?"} — ${app.title || "?"}`;
}

function quote(s, max = 90) {
  const t = String(s || "");
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
}

// Notion entries that belong to the questions queue, by question key.
function queueIndex(entries) {
  const statuses = new Set(Object.values(qaNotion.QA_STATUS));
  const out = new Map();
  for (const e of entries || []) {
    if (!e || !statuses.has(e.status)) continue;
    const key = String(e.questionKey || "").trim() || oq.questionKey(e.question, null);
    if (key && !out.has(key)) out.set(key, e);
  }
  return out;
}

// Pure: groups → { create, update, known } against the Notion entries.
function planPush(groups, entries) {
  const byKey = queueIndex(entries);
  const create = [];
  const update = [];
  const known = [];
  for (const g of groups) {
    const e = byKey.get(g.key);
    if (!e) create.push(g);
    else if (e.status === qaNotion.QA_STATUS.waiting) {
      if (String(e.jobs || "") !== oq.jobsText(g)) update.push({ entry: e, group: g });
      else known.push({ entry: e, group: g });
    } else known.push({ entry: e, group: g });
  }
  return { create, update, known };
}

function pendingFields(g) {
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  return {
    question: g.question,
    key: g.key,
    jobs: oq.jobsText(g),
    companies: uniq(g.rows.map((r) => r.company)).join(", "),
    roles: uniq(g.rows.map((r) => r.title)).join("; "),
    category: categorize(g.question),
  };
}

// --- phases ----------------------------------------------------------------

function runPull(ctx, run) {
  const { stdout, stderr } = ctx;
  if (run.entries === null) {
    stdout(`questions: pull skipped — ${run.notionWhy}`);
    return;
  }
  if (!run.applyDefaults) {
    stdout(`questions: pull skipped — no ${APPLY_DEFAULTS_FILE} in the profile`);
    return;
  }
  const S = qaNotion.QA_STATUS;
  const m = oq.mergeOwnerAnswers(run.applyDefaults, run.entries, S);
  const empty = run.entries.filter((e) => e && e.status === S.answered && !String(e.answer).trim());
  stdout(
    `questions: pull — ${m.answers.length} answer(s) (${m.answers.filter((a) => a.new).length} new), ` +
      `${m.skips.length} skip rule(s), ${m.removed.length} removed`
  );
  for (const a of m.answers.filter((x) => x.new)) stdout(`  answer   ${quote(a.question)}`);
  for (const s of m.skips.filter((x) => x.new)) stdout(`  skip     ${quote(s.question)}`);
  for (const r of m.removed) stdout(`  removed  ${quote(r.question)}`);
  for (const e of empty) {
    stderr(`  warn: ${quote(e.question)} is marked ${S.answered} but has no answer — not used`);
  }
  if (!m.changed) return;
  const before = new Set(
    validateApplyDefaults(run.applyDefaults)
      .filter((i) => i.severity === "error")
      .map((i) => i.field)
  );
  const fresh = validateApplyDefaults(m.next).filter(
    (i) => i.severity === "error" && !before.has(i.field)
  );
  if (fresh.length) {
    stderr(
      `error: merged ${APPLY_DEFAULTS_FILE} would be invalid (${fresh
        .map((i) => `${i.field}: ${i.message}`)
        .join("; ")}) — not written`
    );
    run.errors += 1;
    return;
  }
  run.applyDefaults = m.next;
  if (run.apply) {
    ctx.deps.writeFile(run.applyDefaultsPath, `${JSON.stringify(m.next, null, 2)}\n`);
    run.wrote.push(APPLY_DEFAULTS_FILE);
  }
}

async function runRequeue(ctx, run) {
  const { stdout, deps } = ctx;
  const plan = run.plan;
  const skipChanges = plan.ownerSkip.filter((x) => x.note !== x.app.apply_note);
  stdout(
    `questions: requeue — ${plan.requeue.length} row(s) back to the queue, ` +
      `${plan.ownerSkip.length} kept by a skip rule, ${plan.waiting.length} waiting for an answer, ` +
      `${plan.stuck.length} with no question to ask`
  );
  for (const r of plan.requeue) stdout(`  requeue  ${r.app.key}  ${who(r.app)}`);
  for (const s of skipChanges) stdout(`  skip     ${s.app.key}  ${who(s.app)}`);
  const reverts = plan.waiting.filter((w) => w.note !== w.app.apply_note);
  if (!run.apply || (!plan.requeue.length && !skipChanges.length && !reverts.length)) return;

  const today = deps.today();
  const nowIso = deps.now().toISOString();
  // key → { note it was planned from, note to write, requeue? }
  const planned = new Map();
  for (const r of plan.requeue) {
    planned.set(r.app.key, { from: r.app.apply_note, requeue: true, blockers: r.blockers });
  }
  for (const s of [...skipChanges, ...reverts]) {
    planned.set(s.app.key, { from: s.app.apply_note, note: s.note });
  }
  const applicationsPath = run.profile.paths.applicationsTsv;
  const requeued = [];
  let written = 0;
  await deps.withApplicationsLock(applicationsPath, () => {
    const fresh = deps.loadApplications(applicationsPath).apps;
    for (const a of fresh) {
      const p = planned.get(a.key);
      if (!p) continue;
      // The submitter or a night may have touched the row since the plan.
      if (!oq.isBlockedRow(a) || a.apply_note !== p.from) continue;
      if (p.requeue) {
        a.apply_state = "queued";
        a.apply_note = oq.requeueNote(today);
        requeued.push({ key: a.key, date: today, at: nowIso, questions: p.blockers });
      } else {
        a.apply_note = p.note;
      }
      a.updatedAt = nowIso;
      written += 1;
    }
    if (written) deps.saveApplications(applicationsPath, fresh);
  });
  run.requeued = requeued;
  if (written) run.wrote.push(`applications.tsv (${written} row(s))`);
}

async function runPush(ctx, run) {
  const { stdout, stderr, deps } = ctx;
  const groups = oq.groupQuestions(run.plan.waiting);
  if (run.entries === null) {
    stdout(
      `questions: push skipped — ${run.notionWhy}; ${groups.length} question(s) would wait for an answer`
    );
    for (const g of groups) stdout(`  waiting  ${quote(g.question)} (${g.rows.length} job(s))`);
    run.waiting = groups.length;
    return;
  }
  const p = planPush(groups, run.entries);
  const waitingBefore = run.entries.filter(
    (e) => e && e.status === qaNotion.QA_STATUS.waiting
  ).length;
  stdout(
    `questions: push — ${groups.length} open question(s): ${p.create.length} new, ` +
      `${p.update.length} updated, ${p.known.length} already in Notion`
  );
  for (const g of p.create) {
    const cos = [...new Set(g.rows.map((r) => r.company))].join(", ");
    stdout(`  new      ${quote(g.question)} (${g.rows.length} job(s): ${cos})`);
  }
  for (const u of p.update) {
    stdout(`  update   ${quote(u.group.question)} (${u.group.rows.length} job(s))`);
  }
  run.waiting = waitingBefore + p.create.length;
  if (!run.apply || (!p.create.length && !p.update.length)) return;

  try {
    const schema = await deps.ensurePendingSchema(run.client, run.dbId);
    if (schema.changed.length) {
      stdout(`questions: added to the Q&A database: ${schema.changed.join(", ")}`);
    }
  } catch (err) {
    stderr(`error: Q&A database schema not ready (${err.message}) — nothing pushed`);
    run.errors += 1;
    run.waiting = waitingBefore;
    return;
  }
  let created = 0;
  for (const g of p.create) {
    try {
      await deps.createPendingPage(run.client, run.dbId, pendingFields(g));
      created += 1;
    } catch (err) {
      run.errors += 1;
      stderr(`  error: Notion create for ${quote(g.question)} failed (${err.message})`);
    }
  }
  let updated = 0;
  for (const u of p.update) {
    try {
      await deps.updatePendingPage(run.client, u.entry.pageId, pendingFields(u.group));
      updated += 1;
    } catch (err) {
      run.errors += 1;
      stderr(`  error: Notion update for ${quote(u.group.question)} failed (${err.message})`);
    }
  }
  run.waiting = waitingBefore + created;
  if (created || updated) run.wrote.push(`Notion (${created} new, ${updated} updated)`);
}

function writeState(ctx, run, ran) {
  const { deps } = ctx;
  const file = statePath(run.profile);
  const prev = readJson(file, deps) || {};
  const nowMs = deps.now().getTime();
  const keep = (Array.isArray(prev.requeued) ? prev.requeued : []).filter(
    (r) => r && r.key && nowMs - Date.parse(r.at) < REQUEUED_KEEP_DAYS * DAY_MS
  );
  const state = {
    updated_at: deps.now().toISOString(),
    waiting: ran.push && Number.isInteger(run.waiting) ? run.waiting : prev.waiting || 0,
    view_url: viewUrl(run.profile),
    requeued: [...keep, ...run.requeued],
  };
  deps.writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

// --- command ---------------------------------------------------------------

function makeQuestionsCommand(overrides = {}) {
  const deps = { ...makeDefaultDeps(), ...overrides };
  return async function questionsCommand(ctx) {
    const { profileId, flags = {}, stdout, stderr } = ctx;
    const phase = String(flags.phase || "").trim();
    if (phase && !VALID_PHASES.includes(phase)) {
      stderr(`error: --phase <pull|requeue|push> (or none for all three), got "${phase}"`);
      return 1;
    }
    const ran = {
      pull: !phase || phase === "pull",
      requeue: !phase || phase === "requeue",
      push: !phase || phase === "push",
    };
    const env = ctx.env || process.env;
    const profile = deps.loadProfile(profileId, {
      profilesDir: resolveProfilesDir(ctx, env),
      warn: () => {},
    });
    const applyDefaultsPath = path.join(profile.paths.root, APPLY_DEFAULTS_FILE);
    let applyDefaults;
    try {
      applyDefaults = readJsonStrict(applyDefaultsPath, deps);
    } catch (err) {
      stderr(`error: ${APPLY_DEFAULTS_FILE} unreadable (${err.message}) — nothing changed`);
      return 1;
    }
    const run = {
      apply: Boolean(flags.apply) && !flags.dryRun,
      profile,
      applyDefaults,
      applyDefaultsPath,
      dbId: (profile.notion && profile.notion.application_qa_db_id) || "",
      client: null,
      entries: null,
      notionWhy: "",
      plan: null,
      requeued: [],
      waiting: null,
      errors: 0,
      wrote: [],
    };

    if (ran.pull || ran.push) {
      const secrets = deps.loadSecrets(profileId, env) || {};
      if (!run.dbId) run.notionWhy = "profile has no notion.application_qa_db_id";
      else if (!secrets.NOTION_TOKEN) {
        run.notionWhy = `missing ${profileLoader.secretEnvName(profileId, "NOTION_TOKEN")}`;
      } else {
        run.client = deps.makeNotionClient(secrets.NOTION_TOKEN);
        try {
          run.entries = await deps.fetchAllAnswers(run.client, run.dbId);
        } catch (err) {
          run.notionWhy = `Q&A database unavailable (${err.message})`;
          stderr(`warn: ${run.notionWhy}`);
        }
      }
    }

    const ctxDeps = { ...ctx, deps };
    if (ran.pull) runPull(ctxDeps, run);
    const { apps } = deps.loadApplications(profile.paths.applicationsTsv);
    run.plan = oq.planRows(apps, run.applyDefaults);
    if (ran.requeue) await runRequeue(ctxDeps, run);
    if (ran.push) await runPush(ctxDeps, run);

    if (!run.apply) {
      stdout("dry-run: nothing written. Re-run with --apply to write.");
      return 0;
    }
    writeState(ctxDeps, run, ran);
    stdout(
      `questions: wrote ${run.wrote.length ? run.wrote.join(", ") : "nothing new"}` +
        `${run.errors ? `; ${run.errors} error(s)` : ""}`
    );
    return run.errors ? 1 : 0;
  };
}

// Missing file → null; a file that is not JSON throws (never overwrite it).
function readJsonStrict(p, deps) {
  if (!deps.fileExists(p)) return null;
  return JSON.parse(deps.readFile(p));
}

module.exports = makeQuestionsCommand();
module.exports.makeQuestionsCommand = makeQuestionsCommand;
module.exports.planPush = planPush;
module.exports.viewUrl = viewUrl;
module.exports.statePath = statePath;
module.exports.VALID_PHASES = VALID_PHASES;
