// `reclassify` command — re-evaluate historical `OTHER` entries in
// processed_messages.json through the current classifier (RFC 028 / BL-44).
//
// Why this exists: after RFC 021 (OAuth→IMAP cron transport) and the classifier
// pattern widening for ATS multi-step interview invites, *future* check ticks
// catch e.g. dentemploy-style invites correctly — but *historical* entries
// already persisted as `OTHER` are not re-evaluated. This command fixes that,
// dry-run by default, opt-in apply with operator-supervised Notion updates.
//
// Transport: shares `engine/modules/tracking/gmail_imap.js` with `check --auto`.
// No new credentials: reads {ID}_GMAIL_USER + {ID}_GMAIL_APP_PASSWORD.
//
// Window: 30 days (= email_state.MAX_DAYS). Older entries are already pruned
// from processed_messages.json — out of scope.

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const profileLoader = require("../core/profile_loader.js");
const applicationsTsv = require("../core/applications_tsv.js");
const notion = require("../core/notion_sync.js");
const { classify } = require("../core/classifier.js");
const { resolveProfilesDir } = require("../core/paths.js");
const { matchEmailToApp } = require("../core/email_matcher.js");
const emailState = require("../core/email_state.js");
const gmailImap = require("../modules/tracking/gmail_imap.js");

// Canonical 30-day window — stays aligned with the file we mutate. If
// `email_state.MAX_DAYS` ever moves, reclassify follows automatically.
const { MAX_DAYS } = emailState;
const DEFAULT_RETRIES = 5;

// `OTHER` rows always re-classified. These are the *Notion-side* statuses for
// which we keep the default operator answer as N — operator must explicitly
// type `y` to overwrite a terminal state. Avoids accidentally reopening
// closed/rejected applications via stale-email mis-fires.
const SKIP_STATUSES = ["Inbox", "Rejected", "Closed", "Archived", "No Response"];

// classifier type → Notion status string. INFO_REQUEST / ACKNOWLEDGMENT do
// not move status (informational only); they leave the page status alone and
// only add a bot comment (if --notion).
const TYPE_TO_STATUS = {
  INTERVIEW_INVITE: "Interview",
  REJECTION: "Rejected",
  INFO_REQUEST: null,
  ACKNOWLEDGMENT: null,
};

const DEFAULT_DEPS = {
  loadProfile: profileLoader.loadProfile,
  loadSecrets: profileLoader.loadSecrets,
  loadApplications: applicationsTsv.load,
  loadProcessed: emailState.loadProcessed,
  classify,
  loadGmailCredentials: gmailImap.loadCredentials,
  assertGmailCredentials: gmailImap.assertCredentials,
  makeGmailClient: gmailImap.makeGmailClient,
  fetchMessagesByGmailIds: gmailImap.fetchMessagesByGmailIds,
  makeNotionClient: notion.makeClient,
  updatePageStatus: notion.updatePageStatus,
  addPageComment: notion.addPageComment,
  prompt: defaultPrompt,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
  writeFile: fs.writeFileSync,
  readFile: fs.readFileSync,
  copyFile: fs.copyFileSync,
  existsSync: fs.existsSync,
};

// ---------- Pure helpers (exported for tests) ----------

function clampSinceIso(sinceIso, now, maxDays = MAX_DAYS) {
  if (!sinceIso) return null;
  const requested = new Date(sinceIso);
  if (Number.isNaN(requested.getTime())) return null;
  const floor = new Date(now.getTime() - maxDays * 86400 * 1000);
  if (requested < floor) return floor.toISOString();
  if (requested > now) return now.toISOString();
  return requested.toISOString();
}

// Build a company → [jobs] map including ALL rows (any status, including
// terminal). Reclassify needs to find e.g. an "already Rejected" row that's
// about to be reopened by a stale invite, so we can default the prompt to N
// and warn the operator. (`check --auto` uses ACTIVE-only — different intent.)
function buildAllJobsMap(apps) {
  const map = {};
  for (const a of apps || []) {
    const c = a && a.company;
    if (!c) continue;
    if (!map[c]) map[c] = [];
    map[c].push(a);
  }
  return map;
}

// Wraps a batch IMAP fetch with retry/backoff for transient network/IMAP
// errors. Per-message fetch errors are already absorbed by
// fetchMessagesByGmailIds (returned as {raw: null, error}) — this wrapper
// only retries when the whole batch fails (e.g. connection drop on greeting).
async function fetchWithRetry({ fetchFn, sleep, maxRetries = DEFAULT_RETRIES }) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return await fetchFn();
    } catch (err) {
      lastErr = err;
      const backoff = Math.min(30_000, 1000 * 2 ** attempt);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// ---------- Interactive prompt (readline) ----------

function defaultPrompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Normalize a raw operator answer to one of {y, n, skip-all, quit}.
function normalizeAnswer(raw, defaultAnswer) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (s === "") return defaultAnswer;
  if (s === "y" || s === "yes") return "y";
  if (s === "n" || s === "no") return "n";
  if (s === "skip-all" || s === "s") return "skip-all";
  if (s === "quit" || s === "q") return "quit";
  return defaultAnswer; // unrecognized → safe default
}

// ---------- Main entry ----------

async function runReclassify(ctx) {
  const deps = { ...DEFAULT_DEPS, ...(ctx.deps || {}) };
  const { profileId, flags = {}, stdout, stderr, env } = ctx;

  if (!profileId) {
    stderr("error: --profile is required");
    return 1;
  }

  // Load profile + IMAP credentials.
  let profile;
  let creds;
  try {
    const profilesDir = resolveProfilesDir(ctx, env || process.env);
    profile = deps.loadProfile(profileId, { profilesDir });
    creds = deps.loadGmailCredentials(profileId, {
      env: env || process.env,
      profileRoot: profile.paths.root,
    });
    deps.assertGmailCredentials(creds, profileId);
  } catch (err) {
    stderr(`error: ${err.message}`);
    return 1;
  }

  // Load processed_messages.json, filter to OTHER.
  const processedPath = path.join(profile.paths.root, ".gmail-state", "processed_messages.json");
  const saved = deps.loadProcessed(processedPath);
  const allEntries = Array.isArray(saved.processed) ? saved.processed : [];
  const now = deps.now();

  const sinceIso = clampSinceIso(flags.since, now);
  const sinceMs = sinceIso ? new Date(sinceIso).getTime() : 0;

  let otherEntries = allEntries.filter((e) => e && e.type === "OTHER");
  if (sinceMs) {
    otherEntries = otherEntries.filter((e) => {
      const d = new Date(e.date || 0).getTime();
      return Number.isFinite(d) && d >= sinceMs;
    });
  }
  if (flags.limit && Number.isFinite(flags.limit) && flags.limit > 0) {
    otherEntries = otherEntries.slice(0, flags.limit);
  }

  stdout(
    `reclassify: ${profileId} — ${otherEntries.length} OTHER entries to scan` +
      (sinceIso ? ` (since ${sinceIso.slice(0, 10)})` : "") +
      (flags.limit ? ` (limit ${flags.limit})` : "")
  );

  if (otherEntries.length === 0) {
    stdout("nothing to do (no OTHER entries in window).");
    return 0;
  }

  // Open IMAP, batch-fetch all messages.
  const hexIds = otherEntries.map((e) => e.id);
  const client = deps.makeGmailClient(creds);
  let fetched;
  try {
    fetched = await fetchWithRetry({
      fetchFn: () =>
        deps.fetchMessagesByGmailIds(client, hexIds, {
          onProgress: ({ index, total, ok, error }) => {
            if (flags.verbose) {
              const tag = ok ? "✓" : `✗ ${error || "?"}`;
              stderr(`  [${index + 1}/${total}] ${hexIds[index]} ${tag}`);
            }
          },
        }),
      sleep: deps.sleep,
    });
  } catch (err) {
    stderr(`error: IMAP batch fetch failed after retries: ${err.message}`);
    return 1;
  }

  // Classify and build report rows.
  const fetchedById = new Map(fetched.map((f) => [f.id, f]));
  const rows = otherEntries.map((entry) => {
    const f = fetchedById.get(entry.id);
    if (!f || !f.raw) {
      return {
        entry,
        oldType: "OTHER",
        newType: null,
        evidence: null,
        error: f && f.error ? f.error : "not found",
        raw: null,
      };
    }
    const cls = deps.classify({ subject: f.raw.subject, body: f.raw.body });
    return {
      entry,
      oldType: "OTHER",
      newType: cls.type === "OTHER" ? null : cls.type,
      evidence: cls.evidence,
      error: null,
      raw: f.raw,
    };
  });

  // Per-row output.
  const changedRows = rows.filter((r) => r.newType);
  const unchangedCount = rows.filter((r) => !r.newType && !r.error).length;
  const errorCount = rows.filter((r) => r.error).length;

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const idx = `[${i + 1}/${rows.length}]`;
    const head = `${r.entry.date || "(no date)"} | ${r.entry.company || "(no co)"}`;
    if (r.error) {
      stdout(`${idx} ${head} → error: ${r.error} (id ${r.entry.id})`);
    } else if (r.newType) {
      stdout(`${idx} ${head}`);
      stdout(`  OTHER → ${r.newType}`);
      stdout(`  evidence: ${JSON.stringify(r.evidence || "")}`);
      stdout(`  source: ${r.entry.id}`);
    } else if (flags.verbose) {
      stdout(`${idx} ${head} → unchanged (still OTHER)`);
    }
  }

  // Summary.
  const counts = changedRows.reduce((acc, r) => {
    acc[r.newType] = (acc[r.newType] || 0) + 1;
    return acc;
  }, {});
  const breakdown = Object.entries(counts)
    .map(([t, n]) => `${n} ${t}`)
    .join(", ");
  stdout("");
  stdout(
    `summary: ${rows.length} OTHER scanned · ${changedRows.length} reclassified` +
      (breakdown ? ` (${breakdown})` : "") +
      ` · ${unchangedCount} unchanged · ${errorCount} errors`
  );

  if (!flags.apply) {
    stdout("(dry-run — pass --apply to mutate processed_messages.json)");
    return 0;
  }

  if (changedRows.length === 0) {
    stdout("(nothing to apply.)");
    return 0;
  }

  // --apply: backup, then rewrite processed_messages.json with new types.
  // last_check intentionally NOT bumped — reclassify is not a check tick.
  //
  // Backup is timestamped to make accidental overwrites impossible — if a
  // bad reclassify lands, the previous .bak survives a re-run. Operator
  // restores manually with `cp <ts.bak> processed_messages.json`.
  try {
    if (deps.existsSync(processedPath)) {
      const stamp = now.toISOString().replace(/[:.]/g, "-");
      const bakPath = `${processedPath}.${stamp}.bak`;
      deps.copyFile(processedPath, bakPath);
      stdout(`  backup: ${bakPath}`);
    }
    const changedById = new Map(changedRows.map((r) => [r.entry.id, r.newType]));
    const newProcessed = allEntries.map((e) =>
      changedById.has(e.id) ? { ...e, type: changedById.get(e.id) } : e
    );
    const out = {
      processed: newProcessed,
      last_check: saved.last_check || null,
    };
    deps.writeFile(processedPath, JSON.stringify(out, null, 2));
    stdout(`  wrote ${processedPath} (${changedRows.length} rows updated)`);
  } catch (err) {
    stderr(`error: failed to write processed_messages.json: ${err.message}`);
    return 1;
  }

  if (!flags.notion) {
    stdout("(JSON state updated. Pass --notion for interactive Notion page updates.)");
    return 0;
  }

  // --apply --notion: interactive per-row Notion update.
  const code = await applyNotionUpdates({
    profile,
    profileId,
    changedRows,
    env: env || process.env,
    deps,
    stdout,
    stderr,
  });
  return code;
}

// ---------- Notion interactive update ----------

async function applyNotionUpdates({ profile, profileId, changedRows, env, deps, stdout, stderr }) {
  // Load applications.tsv to find notion_page_id by company match.
  const appsPath = profile.paths.applicationsTsv;
  let apps;
  try {
    const loaded = deps.loadApplications(appsPath);
    apps = Array.isArray(loaded) ? loaded : loaded && loaded.apps;
    if (!Array.isArray(apps)) apps = [];
  } catch (err) {
    stderr(`error: cannot load applications.tsv: ${err.message}`);
    return 1;
  }

  const jobsMap = buildAllJobsMap(apps);
  // `company_aliases` lives at the top of profile.json (matches check.js usage).
  // Wrong dotted path silently disabled brand→parent matching on real profiles.
  const companyAliases = profile.company_aliases || {};

  // Notion client.
  const secrets = deps.loadSecrets ? deps.loadSecrets(profileId, env) : {};
  const notionToken =
    (secrets && secrets.notion_token) || env[`${profileId.toUpperCase()}_NOTION_TOKEN`];
  if (!notionToken) {
    stderr(`error: missing ${profileId.toUpperCase()}_NOTION_TOKEN — Notion updates skipped.`);
    return 1;
  }
  const client = deps.makeNotionClient(notionToken);

  let skipAll = false;
  let notionUpdates = 0;
  let notionSkips = 0;
  let notionErrors = 0;

  for (let i = 0; i < changedRows.length; i += 1) {
    const r = changedRows[i];
    if (skipAll) break;

    const proposedStatus = TYPE_TO_STATUS[r.newType];
    const synthEmail = {
      subject: r.raw && r.raw.subject ? r.raw.subject : "",
      body: r.raw && r.raw.body ? r.raw.body : "",
      from: r.raw && r.raw.from ? r.raw.from : "",
    };
    const matched = matchEmailToApp(synthEmail, jobsMap, companyAliases);

    if (!matched || !matched.job) {
      stdout(
        `[${i + 1}/${changedRows.length}] ${r.entry.company || "(no co)"} — ${r.newType}: no TSV match, skipped.`
      );
      notionSkips += 1;
      continue;
    }
    const pageId = matched.job.notion_page_id;
    if (!pageId) {
      stdout(
        `[${i + 1}/${changedRows.length}] ${r.entry.company} — ${r.newType}: no notion_page_id (Inbox row?), skipped.`
      );
      notionSkips += 1;
      continue;
    }

    const currentStatus = matched.job.status || "(unknown)";
    const isTerminal = SKIP_STATUSES.includes(currentStatus);
    const defaultAns = isTerminal ? "n" : proposedStatus ? "y" : "n";

    stdout("");
    stdout(
      `[${i + 1}/${changedRows.length}] ${matched.company || r.entry.company} — ${matched.job.role || ""}`
    );
    stdout(`  OTHER → ${r.newType}`);
    stdout(`  evidence: ${JSON.stringify(r.evidence || "")}`);
    stdout(`  source: ${r.entry.id} (${r.entry.date || "?"})`);
    stdout(`  current status: ${currentStatus}${isTerminal ? "  ⚠ terminal" : ""}`);
    stdout(`  proposed status: ${proposedStatus || "(no status change; comment only)"}`);
    const promptStr = `  update? [${defaultAns === "y" ? "Y/n" : "y/N"}/skip-all/quit]: `;
    const raw = await deps.prompt(promptStr);
    const ans = normalizeAnswer(raw, defaultAns);

    if (ans === "quit") {
      stdout("(quit — stopping.)");
      break;
    }
    if (ans === "skip-all") {
      stdout("(skip-all — no further prompts.)");
      skipAll = true;
      break;
    }
    if (ans !== "y") {
      notionSkips += 1;
      continue;
    }

    // Apply: status + bot comment. We track each step separately so a
    // status-succeeds-comment-fails partial state is loud (operator must be
    // able to find the half-applied page by id from stderr).
    let statusOk = false;
    try {
      if (proposedStatus) {
        await deps.updatePageStatus(client, pageId, proposedStatus);
      }
      statusOk = true;
      const comment =
        `🤖 Reclassified via BL-44 (RFC 028): OTHER → ${r.newType}\n` +
        `evidence: ${JSON.stringify(r.evidence || "")}\n` +
        `source: ${r.entry.id} (${r.entry.date || "?"})`;
      await deps.addPageComment(client, pageId, comment);
      notionUpdates += 1;
      stdout(`  ✓ updated.`);
    } catch (err) {
      // Partial state: status moved but comment failed. Surface both pageId
      // AND source-messageId so operator can grep recovery commands.
      const partial =
        statusOk && proposedStatus
          ? ` (PARTIAL: status moved to "${proposedStatus}", comment FAILED — ` +
            `page ${pageId}, source ${r.entry.id})`
          : ` (page ${pageId}, source ${r.entry.id})`;
      stderr(`  ✗ Notion error${partial}: ${err.message}`);
      notionErrors += 1;
    }
  }

  stdout("");
  stdout(`notion: ${notionUpdates} updated · ${notionSkips} skipped · ${notionErrors} errors`);
  return notionErrors > 0 ? 1 : 0;
}

module.exports = runReclassify;
module.exports.runReclassify = runReclassify;
module.exports.applyNotionUpdates = applyNotionUpdates;
module.exports.DEFAULT_DEPS = DEFAULT_DEPS;
module.exports.clampSinceIso = clampSinceIso;
module.exports.buildAllJobsMap = buildAllJobsMap;
module.exports.fetchWithRetry = fetchWithRetry;
module.exports.normalizeAnswer = normalizeAnswer;
module.exports.TYPE_TO_STATUS = TYPE_TO_STATUS;
module.exports.SKIP_STATUSES = SKIP_STATUSES;
module.exports.MAX_DAYS = MAX_DAYS;
