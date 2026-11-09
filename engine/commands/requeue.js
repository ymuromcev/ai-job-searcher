// `requeue` command (RFC 069 §8): put bot submissions that never really went
// out back into the apply queue.
//
//   requeue --profile <id> --since <YYYY-MM-DD> [--apply]
//
// October 2026: Ashby forms were "submitted" with required radio groups left
// empty, so the rows were marked Applied while nothing was sent. A row is
// requeued when ALL hold:
//   1. it was a bot / recorded submit: apply_state "submitted" or
//      applied_by "bot";
//   2. applied on or after --since (applied_date);
//   3. its status is still Applied / No Response (anything later — an
//      interview, a rejection — proves the application arrived);
//   4. no "thank you for applying" mail for the company in the apply mailbox
//      since the application day (email_code.findConfirmation — the same
//      matcher the submit step uses);
//   5. the job is not closed (canonical_url.checkPostingOpen — the same
//      posting-API check `apply --phase pre` uses; "unknown" counts as open,
//      the apply pre-phase checks the page again).
//
// Requeue = status "To Apply", applied_date / applied_by cleared,
// apply_state "queued", apply_note "requeued:<today>". The Notion page goes
// back to "To Apply" first (sync is pull-only: a page left at Applied would
// flip the row back on the next sync); a row whose Notion update fails is not
// written. Default is a dry run that prints the list; --apply writes.
// The apply mailbox must be configured (<ID>_APPLY_GMAIL_USER /
// <ID>_APPLY_GMAIL_APP_PASSWORD): without it nothing can be told apart and
// the command refuses rather than risk a second application.

const path = require("path");

const profileLoader = require("../core/profile_loader.js");
const applicationsTsv = require("../core/applications_tsv.js");
const companiesTsv = require("../core/companies.js");
const notionSync = require("../core/notion_sync.js");
const { resolveDataDir, resolveProfilesDir } = require("../core/paths.js");
const { todayLocalISO } = require("../core/auto_dead_sweep.js");
const { findConfirmation } = require("../modules/apply/email_code.js");
const {
  buildSlugIndex,
  canonicalFormUrl,
  checkPostingOpen,
} = require("../modules/apply/canonical_url.js");
const { detectAts, getAdapter } = require("../modules/apply/index.js");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REQUEUE_STATUSES = new Set(["Applied", "No Response"]);
const DAY_MS = 24 * 60 * 60 * 1000;

function appliedDay(app) {
  const d = String(app.applied_date || "").trim();
  if (DATE_RE.test(d)) return d;
  const u = String(app.updatedAt || "").slice(0, 10);
  return DATE_RE.test(u) ? u : "";
}

function isBotSubmit(app) {
  return (
    String(app.apply_state || "").trim() === "submitted" ||
    String(app.applied_by || "").trim() === "bot"
  );
}

// Pure: rows to look at. → { candidates: app[], skipped: [{ app, reason }] }
function selectCandidates(apps, since) {
  const candidates = [];
  const skipped = [];
  for (const app of apps || []) {
    if (!isBotSubmit(app)) continue;
    const day = appliedDay(app);
    if (!day || day < since) continue;
    if (!REQUEUE_STATUSES.has(app.status)) {
      skipped.push({ app, reason: `status_${String(app.status || "").replace(/\s+/g, "_")}` });
      continue;
    }
    candidates.push(app);
  }
  return { candidates, skipped };
}

// Gmail search for confirmation mails since the day before `since` (the
// mailbox and the TSV can disagree on the date across time zones).
function confirmationQuery(since) {
  const d = new Date(Date.parse(`${since}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  return (
    `after:${d.replace(/-/g, "/")} -subject:"security code" ` +
    `("thank you for applying" OR "thanks for applying" OR "your application" OR ` +
    `"thank you for your interest" OR "application received" OR "application submitted" OR ` +
    `"received your application")`
  );
}

function sinceMsFor(app) {
  const t = Date.parse(`${appliedDay(app)}T00:00:00Z`);
  return Number.isFinite(t) ? t - DAY_MS : 0;
}

// "open" | "closed" | "unknown".
async function jobState(app, { slugIndex, fetchFn, checkOpen = checkPostingOpen }) {
  const canon = canonicalFormUrl(app, slugIndex);
  if (canon) return checkOpen(canon, fetchFn);
  const ats = detectAts(app.url || "");
  const adapter = ats ? getAdapter(ats) : null;
  const ref = adapter && adapter.jobRef ? adapter.jobRef(app.url) : null;
  if (ref && ref.slug && ref.jobId) {
    return checkOpen({ ats, slug: ref.slug, jobId: ref.jobId }, fetchFn);
  }
  return "unknown";
}

// IMAP over the apply mailbox (same credentials as email_code's code
// fetcher). null when the mailbox is not configured.
function imapMailFetcher(profileId, env = process.env) {
  const imap = require("../modules/tracking/gmail_imap.js");
  const creds = imap.loadApplyCredentials(profileId, { env });
  if (creds.source !== "env") return null;
  return async (query) => imap.fetchEmailsForBatches(imap.makeGmailClient(creds), [query]);
}

function makeDefaultDeps() {
  const { defaultFetch } = require("../modules/discovery/_http.js");
  return {
    loadProfile: profileLoader.loadProfile,
    loadSecrets: profileLoader.loadSecrets,
    loadApplications: applicationsTsv.load,
    saveApplications: applicationsTsv.save,
    loadCompanies: companiesTsv.load,
    fetchFn: defaultFetch,
    checkPostingOpen,
    makeMailFetcher: imapMailFetcher,
    makeNotionClient: notionSync.makeClient,
    updatePageStatus: notionSync.updatePageStatus,
    today: () => todayLocalISO(),
  };
}

function loadSlugIndex(ctx, deps, stderr) {
  const dataDir = ctx.dataDir || path.join(resolveDataDir(ctx.env || process.env), "data");
  try {
    return buildSlugIndex(deps.loadCompanies(path.join(dataDir, "companies.tsv")).rows);
  } catch (err) {
    stderr(`warn: data/companies.tsv unavailable (${err.message}) — closed-job check by URL only`);
    return new Map();
  }
}

function line(tag, app, extra) {
  const who = `${app.companyName || "?"} — ${app.title || "?"}`;
  return `  ${tag.padEnd(9)} ${app.key}  ${who}  (applied ${appliedDay(app)}${extra ? `; ${extra}` : ""})`;
}

function makeRequeueCommand(overrides = {}) {
  return async function requeueCommand(ctx) {
    const deps = { ...makeDefaultDeps(), ...overrides };
    const { profileId, flags, stdout, stderr } = ctx;
    const since = String(flags.since || "").trim();
    if (!DATE_RE.test(since) || !Number.isFinite(Date.parse(`${since}T00:00:00Z`))) {
      stderr("error: --since <YYYY-MM-DD> is required");
      return 1;
    }
    const apply = Boolean(flags.apply) && !flags.dryRun;
    const env = ctx.env || process.env;
    const profile = deps.loadProfile(profileId, { profilesDir: resolveProfilesDir(ctx, env) });
    const applicationsPath = profile.paths.applicationsTsv;
    const { apps } = deps.loadApplications(applicationsPath);

    const { candidates, skipped } = selectCandidates(apps, since);
    if (!candidates.length) {
      stdout(`requeue: since ${since} — no bot submissions to check`);
      for (const s of skipped) stdout(line("kept", s.app, s.reason));
      return 0;
    }

    const fetchMails = deps.makeMailFetcher(profileId, env);
    if (!fetchMails) {
      stderr(
        `error: apply mailbox not configured (${profileId.toUpperCase()}_APPLY_GMAIL_USER / ` +
          `${profileId.toUpperCase()}_APPLY_GMAIL_APP_PASSWORD) — cannot tell sent from unsent; nothing changed`
      );
      return 1;
    }
    let mails;
    try {
      mails = await fetchMails(confirmationQuery(since));
    } catch (err) {
      stderr(`error: apply mailbox read failed (${err.message}) — nothing changed`);
      return 1;
    }

    const slugIndex = loadSlugIndex(ctx, deps, stderr);
    const plan = { requeue: [], confirmed: [], closed: [] };
    for (const app of candidates) {
      const mail = findConfirmation(mails, { company: app.companyName, sinceMs: sinceMsFor(app) });
      if (mail) {
        plan.confirmed.push({ app, mail });
        continue;
      }
      const state = await jobState(app, {
        slugIndex,
        fetchFn: deps.fetchFn,
        checkOpen: deps.checkPostingOpen,
      });
      if (state === "closed") plan.closed.push({ app });
      else plan.requeue.push({ app, state });
    }

    stdout(
      `requeue: since ${since} — ${candidates.length} bot submission(s): ` +
        `${plan.requeue.length} to requeue, ${plan.confirmed.length} confirmed by email, ` +
        `${plan.closed.length} closed`
    );
    for (const r of plan.requeue) stdout(line("requeue", r.app, `job ${r.state}`));
    for (const c of plan.confirmed) {
      stdout(line("confirmed", c.app, `mail "${c.mail.subject || ""}" ${c.mail.date || ""}`));
    }
    for (const c of plan.closed) stdout(line("closed", c.app));
    for (const s of skipped) stdout(line("kept", s.app, s.reason));

    if (!apply) {
      stdout(
        plan.requeue.length
          ? `dry-run: nothing written. Re-run with --apply to requeue ${plan.requeue.length} row(s).`
          : "dry-run: nothing to requeue."
      );
      return 0;
    }
    if (!plan.requeue.length) {
      stdout("requeue: nothing to write.");
      return 0;
    }

    const needsNotion = plan.requeue.some((r) => r.app.notion_page_id);
    const secrets = deps.loadSecrets(profileId, env) || {};
    if (needsNotion && !secrets.NOTION_TOKEN) {
      stderr(
        `error: missing ${profileLoader.secretEnvName(profileId, "NOTION_TOKEN")} — the Notion ` +
          `pages would stay Applied and the next sync would undo the requeue; nothing changed`
      );
      return 1;
    }
    const client = needsNotion ? deps.makeNotionClient(secrets.NOTION_TOKEN) : null;
    const propertyMap =
      (profile.notion && profile.notion.property_map) || notionSync.DEFAULT_PROPERTY_MAP;

    const ok = new Set();
    let errors = 0;
    for (const { app } of plan.requeue) {
      if (app.notion_page_id) {
        try {
          await deps.updatePageStatus(client, app.notion_page_id, "To Apply", propertyMap);
        } catch (err) {
          errors += 1;
          stderr(`  error: Notion update for ${app.key} failed (${err.message}) — row left as is`);
          continue;
        }
      }
      ok.add(app.key);
    }

    const today = deps.today();
    const nowIso = new Date().toISOString();
    // Re-read: the Notion round trips take a while.
    const fresh = deps.loadApplications(applicationsPath).apps;
    let written = 0;
    for (const a of fresh) {
      if (!ok.has(a.key)) continue;
      a.status = "To Apply";
      a.applied_date = "";
      a.applied_by = "";
      a.apply_state = "queued";
      a.apply_note = `requeued:${today}`;
      a.updatedAt = nowIso;
      written += 1;
    }
    if (written) deps.saveApplications(applicationsPath, fresh);
    stdout(`requeue: ${written} row(s) back in the queue${errors ? `, ${errors} error(s)` : ""}.`);
    return errors ? 1 : 0;
  };
}

module.exports = makeRequeueCommand();
module.exports.makeRequeueCommand = makeRequeueCommand;
module.exports.selectCandidates = selectCandidates;
module.exports.confirmationQuery = confirmationQuery;
module.exports.jobState = jobState;
