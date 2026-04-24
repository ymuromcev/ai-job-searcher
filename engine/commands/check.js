// `check` command — two-phase Gmail response polling (MCP-driven).
//
// Phase `--prepare`:
//   1. Load profile + applications.tsv.
//   2. Build activeJobsMap for rows with notion_page_id set and status ∈ ACTIVE.
//   3. Compute cursor epoch (last_check clamped to 30d, or --since override).
//   4. Build Gmail search batches (10 companies/batch + LinkedIn fixed + recruiter fixed).
//   5. Write .gmail-state/check_context.json.
//   6. Print JSON for Claude to drive MCP Gmail reads.
//
// Between phases: Claude writes .gmail-state/raw_emails.json via MCP.
//
// Phase `--apply` / dry-run:
//   1. Load context + raw_emails.json.
//   2. Filter already-processed by messageId.
//   3. Branch per email: LinkedIn alert / Recruiter outreach / Normal pipeline.
//   4. Build plan.
//   5. If --apply: save TSV, call updatePageStatus+addPageComment per plan,
//      append rejection_log / recruiter_leads / email_check_log, save
//      processed_messages.json.
//
// Ported from ../../Job Search/check_emails.js:287-597 (prototype).

const path = require("path");
const fs = require("fs");

const profileLoader = require("../core/profile_loader.js");
const { secretEnvName } = profileLoader;
const applicationsTsv = require("../core/applications_tsv.js");
const notion = require("../core/notion_sync.js");
const { classify } = require("../core/classifier.js");
const {
  companyTokens,
  findCompany,
  findRole,
  parseLevel,
  archetype,
} = require("../core/email_matcher.js");
const {
  parseLinkedInSubject,
  parseRecruiterRole,
  extractSenderName,
} = require("../core/email_parsers.js");
const {
  isATS,
  matchesRecruiterSubject,
  isLevelBlocked,
  isLocationBlocked,
  isTSVDup,
} = require("../core/email_filters.js");
const emailState = require("../core/email_state.js");
const emailLogs = require("../core/email_logs.js");

const ACTIVE_STATUSES = new Set([
  "Applied",
  "To Apply",
  "Interview",
  "Onsite",
  "Offer",
]);
const SKIP_STATUSES = new Set(["Rejected", "Closed"]);

const BATCH_SIZE = 10;

const DEFAULT_PROPERTY_MAP = {
  status: { field: "Status", type: "status" },
};

const DEFAULT_DEPS = {
  loadProfile: profileLoader.loadProfile,
  loadSecrets: profileLoader.loadSecrets,
  loadApplications: applicationsTsv.load,
  saveApplications: applicationsTsv.save,
  loadProcessed: emailState.loadProcessed,
  saveProcessed: emailState.saveProcessed,
  computeCursorEpoch: emailState.computeCursorEpoch,
  loadContext: emailState.loadContext,
  saveContext: emailState.saveContext,
  loadRawEmails: emailState.loadRawEmails,
  appendRecruiterLeads: emailLogs.appendRecruiterLeads,
  appendRejectionLog: emailLogs.appendRejectionLog,
  appendCheckLog: emailLogs.appendCheckLog,
  buildSummary: emailLogs.buildSummary,
  makeClient: notion.makeClient,
  updatePageStatus: notion.updatePageStatus,
  addPageComment: notion.addPageComment,
  now: () => new Date(),
};

// ---------- Path helpers ----------

function statePaths(profile) {
  const stateDir = path.join(profile.paths.root, ".gmail-state");
  return {
    stateDir,
    contextPath: path.join(stateDir, "check_context.json"),
    rawEmailsPath: path.join(stateDir, "raw_emails.json"),
    processedPath: path.join(stateDir, "processed_messages.json"),
    rejectionLogPath: path.join(profile.paths.root, "rejection_log.md"),
    recruiterLeadsPath: path.join(profile.paths.root, "recruiter_leads.md"),
    checkLogPath: path.join(profile.paths.root, "email_check_log.md"),
  };
}

// ---------- activeJobsMap builder ----------

function buildActiveJobsMap(apps) {
  const map = {};
  for (const app of apps) {
    if (!ACTIVE_STATUSES.has(app.status)) continue;
    if (!app.notion_page_id) continue;
    const co = app.companyName;
    if (!co) continue;
    if (!map[co]) map[co] = [];
    map[co].push({
      company: co,
      role: app.title,
      status: app.status,
      notion_id: app.notion_page_id,
      resume_version: app.resume_ver || "",
      key: app.key,
    });
  }
  return map;
}

// ---------- Gmail query batching ----------

function buildBatches(companies, searchWindow) {
  const batches = [];
  for (let i = 0; i < companies.length; i += BATCH_SIZE) {
    const slice = companies.slice(i, i + BATCH_SIZE);
    const terms = [
      ...new Set(slice.flatMap((c) => companyTokens(c).slice(0, 1))),
    ]
      .filter(Boolean)
      .join(" OR ");
    if (!terms) continue;
    batches.push(
      `(from:(${terms}) OR subject:(${terms})) ${searchWindow} -from:me`
    );
  }

  batches.push(`from:jobalerts-noreply@linkedin.com ${searchWindow}`);

  batches.push(
    `subject:("Requirement for" OR "Immediate need" OR "exciting opportunity" OR ` +
      `"job opportunity" OR "open position" OR "open role" OR "great fit" OR ` +
      `"perfect fit" OR "new role" OR "new opportunity" OR "came across your" OR ` +
      `"your background" OR "your profile" OR "I am reaching out" OR ` +
      `"contract role" OR "contract opportunity" OR "open to opportunities") ` +
      `${searchWindow} -from:me -from:linkedin.com -from:jobot.com ` +
      `-from:greenhouse -from:lever -from:workday -from:ashbyhq.com ` +
      `-from:smartrecruiters -from:icims`
  );

  return batches;
}

// ---------- Phase: --prepare ----------

async function runPrepare(ctx, deps) {
  const { profileId, flags, stdout } = ctx;
  const profilesDir = ctx.profilesDir || path.resolve(process.cwd(), "profiles");
  const profile = deps.loadProfile(profileId, { profilesDir });
  const paths = statePaths(profile);

  const saved = deps.loadProcessed(paths.processedPath);
  const now = deps.now();
  const sinceIso = flags.since || null;
  const epoch = deps.computeCursorEpoch({
    lastCheck: saved.last_check,
    sinceIso,
    now,
  });

  const { apps } = deps.loadApplications(profile.paths.applicationsTsv);
  const activeJobsMap = buildActiveJobsMap(apps);
  const companies = Object.keys(activeJobsMap);

  const searchWindow = `after:${epoch}`;
  const batches = buildBatches(companies, searchWindow);

  const context = {
    profileId,
    generatedAt: now.toISOString(),
    epoch,
    searchWindow,
    batches,
    companyCount: companies.length,
    activeJobsMap,
    processedIds: (saved.processed || []).map((e) => e.id),
  };

  if (flags.dryRun) {
    stdout(
      `(dry-run) would write check_context.json — ${companies.length} companies, ${batches.length} batches`
    );
    return 0;
  }

  deps.saveContext(paths.contextPath, context);
  stdout(
    JSON.stringify(
      {
        epoch,
        searchWindow,
        batchCount: batches.length,
        companyCount: companies.length,
        batches,
        contextPath: paths.contextPath,
        rawEmailsPath: paths.rawEmailsPath,
      },
      null,
      2
    )
  );
  return 0;
}

// ---------- Phase: --apply / dry-run ----------

function processLinkedIn(email, ctx, state) {
  const parsed = parseLinkedInSubject(email.subject || "");
  const logRow = {
    id: email.messageId,
    company: parsed ? parsed.company : "?",
    role: parsed ? parsed.role : "?",
    match: "SOURCE",
    type: "LINKEDIN_LEAD",
    action: "skipped",
    comment: "",
  };

  if (!parsed) {
    logRow.action = "unparseable subject";
  } else if (isLevelBlocked(parsed.role, state.filterRules)) {
    logRow.action = "filtered: level";
  } else if (isLocationBlocked(email.subject || "", state.filterRules)) {
    logRow.action = "filtered: location";
  } else if (isTSVDup(parsed.company, parsed.role, state.tsvCache)) {
    logRow.action = "duplicate";
  } else {
    const newRow = {
      key: `linkedin:${email.messageId}`,
      source: "linkedin",
      jobId: email.messageId,
      companyName: parsed.company,
      title: parsed.role,
      url: "",
      status: "Inbox",
      notion_page_id: "",
      resume_ver: "",
      cl_key: "",
      salary_min: "",
      salary_max: "",
      cl_path: "",
      createdAt: ctx.nowIso,
      updatedAt: ctx.nowIso,
    };
    state.newInboxRows.push(newRow);
    state.tsvCache.push(newRow);
    logRow.action = "→ Inbox";
    logRow.comment = "✅";
  }
  return logRow;
}

function processRecruiter(email, ctx, state) {
  const role = parseRecruiterRole(email.subject || "");
  const logRow = {
    id: email.messageId,
    company: "?",
    role: role || "?",
    match: "SOURCE",
    type: "RECRUITER_OUTREACH",
    action: "skipped",
    comment: "",
  };

  if (!role) {
    logRow.action = "unparseable role";
  } else if (isLevelBlocked(role, state.filterRules)) {
    logRow.action = "filtered: level";
  } else {
    const clientMatch = (email.body || "").match(
      /(?:client|company)[:\s]+([A-Za-z][a-zA-Z0-9\s&,\.]+?)(?:\.|,|\n|$)/i
    );
    if (clientMatch && clientMatch[1].trim().length > 2) {
      const company = clientMatch[1].trim();
      if (isTSVDup(company, role, state.tsvCache)) {
        logRow.action = "duplicate";
      } else {
        const newRow = {
          key: `recruiter:${email.messageId}`,
          source: "recruiter",
          jobId: email.messageId,
          companyName: company,
          title: role,
          url: "",
          status: "Inbox",
          notion_page_id: "",
          resume_ver: "",
          cl_key: "",
          salary_min: "",
          salary_max: "",
          cl_path: "",
          createdAt: ctx.nowIso,
          updatedAt: ctx.nowIso,
        };
        state.newInboxRows.push(newRow);
        state.tsvCache.push(newRow);
        logRow.company = company;
        logRow.action = "→ Inbox";
        logRow.comment = "✅";
      }
    } else {
      state.recruiterLeads.push({
        date: (email.date || new Date().toISOString()).slice(0, 10),
        agency: extractSenderName(email.from || ""),
        role,
        contact: email.from || "?",
        subject: (email.subject || "").replace(/\|/g, "/"),
      });
      logRow.action = "→ recruiter_leads.md";
      logRow.comment = "📋";
    }
  }
  return logRow;
}

function processPipeline(email, ctx, state) {
  const cls = classify({ subject: email.subject, body: email.body });
  const type = cls.type;
  const match = findCompany(email, state.activeJobsMap);
  const row = {
    id: email.messageId,
    company: "?",
    role: "?",
    match: "NONE",
    type,
    action: "unmatched",
    comment: "",
  };
  if (!match) return { row };

  const { company, jobs } = match;
  const r = findRole(email, jobs);
  if (!r) {
    row.company = company;
    return { row };
  }
  const { job, confidence } = r;
  row.company = company;
  row.role = job.role;
  row.match = confidence;

  if (confidence === "LOW") {
    row.action = "skipped: LOW confidence";
    return { row };
  }

  if (type === "REJECTION") {
    if (SKIP_STATUSES.has(job.status)) {
      row.action = `Already ${job.status}, skipped`;
      return { row };
    }
    const action = {
      kind: "status+comment",
      pageId: job.notion_id,
      appKey: job.key,
      newStatus: "Rejected",
      comment: `❌ Получен отказ. Тема: ${email.subject}. Статус → Rejected.`,
    };
    row.action = "queued: Status → Rejected";
    row.comment = "✅ queued";
    const rejection = {
      company,
      role: job.role,
      level: parseLevel(job.role),
      arch: archetype(job.resume_version),
      prevApplied: job.status === "Applied",
      date: email.date || new Date().toISOString(),
    };
    return { row, action, rejection };
  }

  if (type === "INTERVIEW_INVITE") {
    if (SKIP_STATUSES.has(job.status)) {
      row.action = `Already ${job.status}, skipped`;
      return { row };
    }
    const action = {
      kind: "status+comment",
      pageId: job.notion_id,
      appKey: job.key,
      newStatus: "Interview",
      comment: `🔔 Приглашение на интервью! Тема: ${email.subject}. Проверь письмо и запланируй.`,
    };
    row.action = "queued: Status → Interview";
    row.comment = "✅ queued";
    return { row, action };
  }

  if (type === "INFO_REQUEST") {
    const action = {
      kind: "comment_only",
      pageId: job.notion_id,
      appKey: job.key,
      comment: `📋 Запрос информации. Тема: ${email.subject}. Нужно ответить.`,
    };
    row.action = "queued: comment_only";
    row.comment = "✅ queued";
    return { row, action };
  }

  if (type === "OTHER") {
    row.action = "No change (OTHER)";
    return { row };
  }

  row.action = "No change";
  return { row };
}

async function runApply(ctx, deps) {
  const { profileId, flags, stdout, stderr, env } = ctx;
  const profilesDir = ctx.profilesDir || path.resolve(process.cwd(), "profiles");
  const profile = deps.loadProfile(profileId, { profilesDir });
  const paths = statePaths(profile);

  const context = deps.loadContext(paths.contextPath);
  if (!context) {
    stderr(`error: check_context.json not found at ${paths.contextPath}. Run --prepare first.`);
    return 1;
  }

  const rawEmails = deps.loadRawEmails(paths.rawEmailsPath);
  const processedSet = new Set(context.processedIds || []);
  const newEmails = rawEmails.filter(
    (e) => e && e.messageId && !processedSet.has(e.messageId)
  );

  const { apps } = deps.loadApplications(profile.paths.applicationsTsv);
  const tsvCache = [...apps];

  const now = deps.now();
  const nowIso = now.toISOString();
  const state = {
    activeJobsMap: context.activeJobsMap || {},
    filterRules: profile.filterRules || {},
    tsvCache,
    newInboxRows: [],
    recruiterLeads: [],
  };
  const procCtx = { nowIso };

  const logRows = [];
  const actions = [];
  const rejections = [];

  if (newEmails.length === 0) {
    stdout(
      JSON.stringify(
        {
          emailsFound: 0,
          matched: 0,
          actions: 0,
          summary: deps.buildSummary({}),
        },
        null,
        2
      )
    );
    if (flags.apply) {
      // Still bump last_check so the next --prepare window advances.
      const saved = deps.loadProcessed(paths.processedPath);
      deps.saveProcessed(paths.processedPath, saved, [], now);
    }
    return 0;
  }

  for (const email of newEmails) {
    const fromLower = (email.from || "").toLowerCase();

    if (fromLower.includes("jobalerts-noreply@linkedin.com")) {
      logRows.push(processLinkedIn(email, procCtx, state));
      continue;
    }

    if (!isATS(email.from) && matchesRecruiterSubject(email.subject || "")) {
      logRows.push(processRecruiter(email, procCtx, state));
      continue;
    }

    const { row, action, rejection } = processPipeline(email, procCtx, state);
    logRows.push(row);
    if (action) actions.push(action);
    if (rejection) rejections.push(rejection);
  }

  const inboxAdded = state.newInboxRows.length;
  const recruiterLeadsCount = state.recruiterLeads.length;
  const summary = deps.buildSummary({
    rejections,
    logRows,
    actionCount: actions.length,
    inboxAdded,
    recruiterLeadsCount,
  });

  stdout(
    JSON.stringify(
      {
        emailsFound: newEmails.length,
        matched: logRows.filter((r) => r.match !== "NONE").length,
        actions: actions.length,
        inboxAdded,
        recruiterLeadsLogged: recruiterLeadsCount,
        results: logRows,
        plan: actions.map((a) => ({
          kind: a.kind,
          pageId: a.pageId,
          appKey: a.appKey,
          newStatus: a.newStatus || null,
        })),
        summary,
      },
      null,
      2
    )
  );

  if (!flags.apply) {
    stdout(`(dry-run — pass --apply to mutate TSV + Notion)`);
    return 0;
  }

  // --- Apply phase: Notion first, then local state.
  const secrets = deps.loadSecrets(profileId, env);
  const token = secrets.NOTION_TOKEN;
  if (!token && actions.length > 0) {
    stderr(`error: missing ${secretEnvName(profileId, "NOTION_TOKEN")} in env`);
    return 1;
  }

  const propertyMap =
    (profile.notion && profile.notion.property_map) || DEFAULT_PROPERTY_MAP;

  let client = null;
  const getClient = () => {
    if (!client) client = deps.makeClient(token);
    return client;
  };

  let notionErrors = 0;
  const appliedStatusByAppKey = {};
  for (const a of actions) {
    try {
      if (a.kind === "status+comment") {
        await deps.updatePageStatus(getClient(), a.pageId, a.newStatus, propertyMap);
        await deps.addPageComment(getClient(), a.pageId, a.comment);
        appliedStatusByAppKey[a.appKey] = a.newStatus;
      } else if (a.kind === "comment_only") {
        await deps.addPageComment(getClient(), a.pageId, a.comment);
      }
    } catch (err) {
      notionErrors += 1;
      stderr(`  notion error for ${a.pageId}: ${err.message}`);
    }
  }

  // Merge inbox rows + status updates into TSV.
  const byKey = new Map(apps.map((a) => [a.key, a]));
  for (const newRow of state.newInboxRows) {
    byKey.set(newRow.key, newRow);
  }
  for (const [appKey, newStatus] of Object.entries(appliedStatusByAppKey)) {
    const existing = byKey.get(appKey);
    if (existing) {
      byKey.set(appKey, { ...existing, status: newStatus, updatedAt: nowIso });
    }
  }
  const merged = Array.from(byKey.values());
  deps.saveApplications(profile.paths.applicationsTsv, merged);

  // Logs.
  if (state.recruiterLeads.length > 0) {
    deps.appendRecruiterLeads(paths.recruiterLeadsPath, state.recruiterLeads);
  }
  if (rejections.length > 0) {
    deps.appendRejectionLog(paths.rejectionLogPath, rejections, now);
  }
  deps.appendCheckLog(paths.checkLogPath, {
    logRows,
    actionCount: actions.length,
    rejections,
    inboxAdded,
    recruiterLeadsCount,
    now,
  });

  // processed_messages.json
  const saved = deps.loadProcessed(paths.processedPath);
  const newEntries = newEmails.map((e) => {
    const r = logRows.find((rr) => rr.id === e.messageId) || {};
    return {
      id: e.messageId,
      date: e.date || nowIso,
      company: r.company || "unknown",
      type: r.type || "OTHER",
    };
  });
  deps.saveProcessed(paths.processedPath, saved, newEntries, now);

  stdout(
    `applied: ${actions.length - notionErrors} Notion ops, ${inboxAdded} Inbox rows, ${rejections.length} rejections${
      notionErrors ? `, ${notionErrors} errors` : ""
    }`
  );
  return notionErrors > 0 ? 1 : 0;
}

// ---------- Entry ----------

function makeCheckCommand(overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  return async function checkCommand(ctx) {
    if (ctx.flags && ctx.flags.prepare) {
      return runPrepare(ctx, deps);
    }
    return runApply(ctx, deps);
  };
}

module.exports = makeCheckCommand();
module.exports.makeCheckCommand = makeCheckCommand;
module.exports.buildActiveJobsMap = buildActiveJobsMap;
module.exports.buildBatches = buildBatches;
module.exports.processLinkedIn = processLinkedIn;
module.exports.processRecruiter = processRecruiter;
module.exports.processPipeline = processPipeline;
module.exports.ACTIVE_STATUSES = ACTIVE_STATUSES;
module.exports.SKIP_STATUSES = SKIP_STATUSES;
module.exports.DEFAULT_PROPERTY_MAP = DEFAULT_PROPERTY_MAP;
