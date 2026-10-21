#!/usr/bin/env node
// RFC 068 §7 (unit U2) — import the previous application bot's history from
// its Zoho mailbox into profiles/<id>/applications.tsv, so the new bot never
// re-applies to those jobs and the company cap counts them.
//
// Usage:
//   node scripts/import_zoho_applications.js --profile <id> [--since YYYY-MM-DD]
//        [--mbox <path>] [--apply] [--plan <plan.json>]
//
// Sources (pick one):
//   - IMAP (default): Zoho, credentials from .env via profile_loader.loadSecrets
//       <ID_UPPER>_ZOHO_USER / <ID_UPPER>_ZOHO_APP_PASSWORD
//     imap.zoho.com:993, falling back to imappro.zoho.com:993 on an auth
//     failure. Reads INBOX plus any folder whose name matches
//     /applied|jobs|applications/i. Mailboxes are opened read-only (EXAMINE)
//     and bodies fetched with BODY.PEEK — flags are never modified.
//   - --mbox <path>: a local mbox export, or a directory of .eml files. No
//     network.
//
// What it does: every message goes through the `check` classifier
// (engine/core/classifier.js). Acknowledgements → Applied, rejections →
// Rejected, interview invites → Interview, role-closed notices → Closed.
// Company + job title are extracted from the ATS email and matched against the
// TSV by normalized company + title. Matched rows get status / applied_date /
// applied_by=legacy_bot / apply_state=submitted (Interview and Offer are never
// downgraded); unmatched applications become new rows with source=legacy_bot
// and a stable synthetic jobId, appended through applications_tsv.appendNew.
//
// Modes:
//   default       dry-run: prints a report and writes the full plan to
//                 profiles/<id>/.legacy-import/plan-<ts>.json. TSV untouched.
//   --apply       builds the plan the same way, writes it, then applies exactly
//                 that plan to the TSV.
//   --apply --plan <file>
//                 applies a previously reviewed plan file without reading mail.
//
// Notion is NOT touched by this script. Rows that already have a Notion page
// are listed in the report: their Notion status needs the same change, or the
// next `sync` pull will overwrite the TSV status.

const fs = require("fs");
const path = require("path");

const { loadProfile, loadSecrets, secretEnvName } = require("../engine/core/profile_loader");
const { resolveProfilesDir } = require("../engine/core/paths");
const appsTsv = require("../engine/core/applications_tsv");
const { stripHtmlTags } = require("../engine/modules/tracking/gmail_imap");
const { buildPlan, applyPlan, splitMbox, formatReport } = require("../engine/core/legacy_import");

const ZOHO_HOSTS = ["imap.zoho.com", "imappro.zoho.com"];
const ZOHO_PORT = 993;
const FOLDER_RE = /applied|jobs|applications/i;
const FETCH_CHUNK = 200;
const PLAN_DIR = ".legacy-import";

const USAGE =
  "Usage: node scripts/import_zoho_applications.js --profile <id> [--since YYYY-MM-DD] " +
  "[--mbox <path>] [--apply] [--plan <plan.json>]";

function parseArgs(argv) {
  const out = { profile: null, since: "", mbox: "", apply: false, plan: "", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--since") out.since = argv[++i] || "";
    else if (a === "--mbox") out.mbox = argv[++i] || "";
    else if (a === "--plan") out.plan = argv[++i] || "";
    else if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.help) return out;
  if (!out.profile) throw new Error("--profile <id> is required");
  if (out.since && !/^\d{4}-\d{2}-\d{2}$/.test(out.since)) {
    throw new Error(`--since must be YYYY-MM-DD, got ${JSON.stringify(out.since)}`);
  }
  if (out.plan && !out.apply) throw new Error("--plan is only used with --apply");
  if (out.plan && (out.mbox || out.since)) {
    throw new Error("--plan applies a saved plan; do not combine it with --mbox / --since");
  }
  return out;
}

// ---------- Message parsing ----------

async function parseRawMessage(source, { parser, fallbackDate } = {}) {
  const parse = parser || require("mailparser").simpleParser;
  const parsed = await parse(source);
  const date =
    parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime())
      ? parsed.date.toISOString()
      : fallbackDate instanceof Date
        ? fallbackDate.toISOString()
        : "";
  return {
    messageId: parsed.messageId || "",
    subject: parsed.subject || "",
    from: (parsed.from && parsed.from.text) || "",
    body: parsed.text || (parsed.html ? stripHtmlTags(parsed.html) : "") || "",
    date,
  };
}

// ---------- Source B: mbox / .eml directory ----------

async function collectFromMbox(p, { parser, log = () => {} } = {}) {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) throw new Error(`--mbox path not found: ${abs}`);
  const raws = [];
  if (fs.statSync(abs).isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) {
      if (name.toLowerCase().endsWith(".eml")) raws.push(fs.readFileSync(path.join(abs, name)));
    }
  } else {
    raws.push(...splitMbox(fs.readFileSync(abs, "utf8")));
  }
  const out = [];
  let failed = 0;
  for (const raw of raws) {
    try {
      out.push(await parseRawMessage(raw, { parser }));
    } catch (_err) {
      failed += 1;
    }
  }
  if (failed) log(`warning: ${failed} message(s) could not be parsed and were skipped`);
  return out;
}

// ---------- Source A: Zoho IMAP ----------

function defaultMakeClient(host, creds) {
  const { ImapFlow } = require("imapflow");
  return new ImapFlow({
    host,
    port: ZOHO_PORT,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
    socketTimeout: 60_000,
    greetingTimeout: 30_000,
  });
}

function isAuthError(err) {
  if (!err) return false;
  if (err.authenticationFailed) return true;
  const text = `${err.responseText || ""} ${err.message || ""}`;
  return /auth|login|credential|password/i.test(text);
}

async function safeLogout(client) {
  try {
    await client.logout();
  } catch (_e) {
    // best-effort
  }
}

async function connectZoho(creds, { makeClient = defaultMakeClient, log = () => {} } = {}) {
  let lastErr = null;
  for (const host of ZOHO_HOSTS) {
    const client = makeClient(host, creds);
    try {
      await client.connect();
      return { client, host };
    } catch (err) {
      lastErr = err;
      await safeLogout(client);
      if (!isAuthError(err)) throw err;
      log(`IMAP auth failed on ${host}`);
    }
  }
  throw lastErr || new Error("IMAP connect failed");
}

function pickFolders(list) {
  const out = ["INBOX"];
  for (const box of Array.isArray(list) ? list : []) {
    if (!box || !box.path) continue;
    if (box.path.toUpperCase() === "INBOX") continue;
    if (FOLDER_RE.test(box.path) || FOLDER_RE.test(box.name || "")) out.push(box.path);
  }
  return [...new Set(out)];
}

async function fetchFolder(client, folder, { since, parser }) {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  const out = [];
  try {
    const query = since ? { since: new Date(`${since}T00:00:00Z`) } : { all: true };
    const uids = (await client.search(query, { uid: true })) || [];
    for (let i = 0; i < uids.length; i += FETCH_CHUNK) {
      const chunk = uids.slice(i, i + FETCH_CHUNK);
      for await (const msg of client.fetch(
        chunk,
        { uid: true, envelope: true, internalDate: true, source: true },
        { uid: true }
      )) {
        if (!msg || !msg.source) continue;
        try {
          out.push(await parseRawMessage(msg.source, { parser, fallbackDate: msg.internalDate }));
        } catch (_err) {
          // Unparseable MIME: skip, the report counts what was read.
        }
      }
    }
  } finally {
    lock.release();
  }
  return out;
}

async function collectFromImap(creds, { since, makeClient, parser, log = () => {} } = {}) {
  const { client, host } = await connectZoho(creds, { makeClient, log });
  const out = [];
  try {
    const folders = pickFolders(await client.list());
    log(`IMAP ${host}: reading ${folders.join(", ")}`);
    for (const folder of folders) {
      out.push(...(await fetchFolder(client, folder, { since, parser })));
    }
  } finally {
    await safeLogout(client);
  }
  return { messages: out, host };
}

function zohoCreds(profileId, env) {
  const secrets = loadSecrets(profileId, env);
  const user = secrets.ZOHO_USER;
  const pass = secrets.ZOHO_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      `missing Zoho credentials: add ${secretEnvName(profileId, "ZOHO_USER")} and ` +
        `${secretEnvName(profileId, "ZOHO_APP_PASSWORD")} to .env, or use --mbox <path>`
    );
  }
  return { user, pass };
}

// ---------- Plan files ----------

function planDir(profileRoot) {
  return path.join(profileRoot, PLAN_DIR);
}

function writePlan(profileRoot, plan, now) {
  const dir = planDir(profileRoot);
  fs.mkdirSync(dir, { recursive: true });
  const ts = String(now).replace(/[:.]/g, "-");
  const file = path.join(dir, `plan-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(plan, null, 2) + "\n");
  return file;
}

function readPlan(file, profileId) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`plan not found: ${abs}`);
  const plan = JSON.parse(fs.readFileSync(abs, "utf8"));
  if (plan.kind !== "legacy_mail_import") throw new Error(`not a legacy import plan: ${abs}`);
  if (plan.profile !== profileId) {
    throw new Error(`plan is for profile "${plan.profile}", not "${profileId}"`);
  }
  if (plan.appliedAt) throw new Error(`plan already applied at ${plan.appliedAt}: ${abs}`);
  return { plan, file: abs };
}

// ---------- Main ----------

async function run(opts = {}) {
  const argv = opts.argv || process.argv.slice(2);
  const env = opts.env || process.env;
  const log = opts.log || ((s) => process.stdout.write(`${s}\n`));
  const now = opts.now || new Date().toISOString();

  const args = parseArgs(argv);
  if (args.help) {
    log(USAGE);
    return { help: true };
  }

  const profile = loadProfile(args.profile, {
    profilesDir: opts.profilesDir || resolveProfilesDir({}, env),
    warn: () => {},
  });
  const root = profile.paths.root;
  const tsvPath = profile.paths.applicationsTsv;

  let plan;
  let planPath;
  if (args.plan) {
    ({ plan, file: planPath } = readPlan(args.plan, args.profile));
    log(formatReport(plan, { source: plan.source, planPath }));
  } else {
    let messages;
    let source;
    if (args.mbox) {
      messages = await collectFromMbox(args.mbox, { parser: opts.parser, log });
      source = `mbox:${path.basename(args.mbox)}`;
    } else {
      const creds = zohoCreds(args.profile, env);
      const res = await collectFromImap(creds, {
        since: args.since,
        makeClient: opts.makeImapClient,
        parser: opts.parser,
        log,
      });
      messages = res.messages;
      source = `imap:${res.host}`;
    }
    const { apps } = appsTsv.load(tsvPath);
    plan = buildPlan(apps, messages, {
      since: args.since,
      companyAliases: profile.company_aliases || {},
      now,
    });
    plan.profile = args.profile;
    plan.source = source;
    planPath = writePlan(root, plan, now);
    log(formatReport(plan, { source, planPath }));
  }

  if (!args.apply) {
    log("\nDry-run: TSV not modified. Re-run with --apply to write.");
    return { plan, planPath, applied: false };
  }

  const { apps } = appsTsv.load(tsvPath);
  const res = applyPlan(apps, plan, { now });
  appsTsv.save(tsvPath, res.apps);
  plan.appliedAt = now;
  plan.applyResult = {
    updated: res.updated,
    appended: res.appended,
    unchanged: res.unchanged,
    missing: res.missing,
  };
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");
  log(
    `\nApplied to ${path.relative(process.cwd(), tsvPath) || tsvPath}: ` +
      `${res.updated} updated, ${res.appended} appended, ${res.unchanged} already up to date` +
      (res.missing.length ? `, ${res.missing.length} planned row(s) no longer in TSV` : "") +
      ". Notion not touched."
  );
  return { plan, planPath, applied: true, result: res };
}

if (require.main === module) {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
  run().catch((err) => {
    process.stderr.write(`error: ${err.message}\n${USAGE}\n`);
    process.exit(1);
  });
}

module.exports = {
  run,
  parseArgs,
  parseRawMessage,
  collectFromMbox,
  collectFromImap,
  connectZoho,
  pickFolders,
  isAuthError,
  zohoCreds,
  ZOHO_HOSTS,
};
