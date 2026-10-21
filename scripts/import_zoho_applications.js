#!/usr/bin/env node
// RFC 068 §7 (unit U2) — import the previous application bot's history from
// its Zoho mailbox into profiles/<id>/applications.tsv, so the new bot never
// re-applies to those jobs and the company cap counts them.
//
// Usage:
//   node scripts/import_zoho_applications.js --profile <id> [--since YYYY-MM-DD]
//        [--mbox <path>] [--folders a,b,c] [--export-messages <file.json>]
//        [--extracted <file.json>] [--apply] [--plan <plan.json>]
//
// Sources (pick one):
//   - IMAP (default): Zoho, credentials from .env via profile_loader.loadSecrets
//       <ID_UPPER>_ZOHO_USER / <ID_UPPER>_ZOHO_APP_PASSWORD
//     imap.zoho.com:993, falling back to imappro.zoho.com:993 on an auth
//     failure. Reads every selectable folder (the mailbox holds only
//     job-search mail), or only `--folders a,b,c`. Mailboxes are opened
//     read-only (EXAMINE) and bodies fetched with BODY.PEEK — flags are never
//     modified.
//   - --mbox <path>: a local mbox export, or a directory of .eml files. No
//     network.
//   - --extracted <file.json>: no mail at all. Records
//       [{ id, company, title, status: Applied|Rejected|Interview|Closed|
//          Account|Ignore, date, note? }]
//     written by an LLM extraction pass over an `--export-messages` file
//     replace the heuristic company/title extraction below.
//
// --export-messages <file.json>: after reading mail, write one compact record
// per message (id, date, from, to, folder, subject, classifier status,
// deterministic template match, cleaned ≤1500-char excerpt) to
// profiles/<id>/.legacy-import/<file> and stop — no plan is built.
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
// Notion: with --apply, matched rows that already have a Notion page get the
// same status pushed through notion_sync.updatePageStatus, so the pull-only
// `sync` does not overwrite the import. Dry-run never touches Notion.

const fs = require("fs");
const path = require("path");

const { loadProfile, loadSecrets, secretEnvName } = require("../engine/core/profile_loader");
const { resolveProfilesDir } = require("../engine/core/paths");
const appsTsv = require("../engine/core/applications_tsv");
const {
  buildPlan,
  buildPlanFromExtracted,
  applyPlan,
  splitMbox,
  formatReport,
  plainText,
  exportRecord,
} = require("../engine/core/legacy_import");

const ZOHO_HOSTS = ["imap.zoho.com", "imappro.zoho.com"];
const ZOHO_PORT = 993;
const FETCH_CHUNK = 50;
const PLAN_DIR = ".legacy-import";

const USAGE =
  "Usage: node scripts/import_zoho_applications.js --profile <id> [--since YYYY-MM-DD] " +
  "[--mbox <path>] [--folders a,b,c] [--export-messages <file.json>] " +
  "[--extracted <file.json>] [--apply] [--plan <plan.json>]";

function parseArgs(argv) {
  const out = {
    profile: null,
    since: "",
    mbox: "",
    folders: [],
    exportMessages: "",
    extracted: "",
    apply: false,
    plan: "",
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--since") out.since = argv[++i] || "";
    else if (a === "--mbox") out.mbox = argv[++i] || "";
    else if (a === "--folders") {
      out.folders = String(argv[++i] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--export-messages") out.exportMessages = argv[++i] || "";
    else if (a === "--extracted") out.extracted = argv[++i] || "";
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
  if (out.plan && (out.mbox || out.since || out.extracted || out.folders.length)) {
    throw new Error("--plan applies a saved plan; do not combine it with mail / extraction flags");
  }
  if (out.exportMessages && (out.apply || out.extracted || out.plan)) {
    throw new Error("--export-messages only exports; do not combine it with --apply / --extracted");
  }
  if (out.extracted && (out.mbox || out.folders.length)) {
    throw new Error("--extracted builds the plan from the extracted file; it reads no mail");
  }
  return out;
}

// ---------- Message parsing ----------

function hasCalendarPart(parsed) {
  const atts = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  if (atts.some((a) => /text\/calendar|application\/ics/i.test(a.contentType || ""))) return true;
  const ct = parsed.headers && parsed.headers.get ? parsed.headers.get("content-type") : null;
  const v = ct && (ct.value || ct);
  return typeof v === "string" && /text\/calendar/i.test(v);
}

async function parseRawMessage(source, { parser, fallbackDate, folder = "" } = {}) {
  const parse = parser || require("mailparser").simpleParser;
  const parsed = await parse(source);
  const date =
    parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime())
      ? parsed.date.toISOString()
      : fallbackDate instanceof Date
        ? fallbackDate.toISOString()
        : "";
  const from0 = (parsed.from && Array.isArray(parsed.from.value) && parsed.from.value[0]) || {};
  const recipients = [parsed.to, parsed.cc]
    .flatMap((x) => (Array.isArray(x) ? x : x ? [x] : []))
    .map((x) => x.text || "")
    .filter(Boolean)
    .join(", ");
  return {
    messageId: parsed.messageId || "",
    subject: parsed.subject || "",
    from: (parsed.from && parsed.from.text) || "",
    fromName: from0.name || "",
    fromAddress: from0.address || "",
    to: recipients,
    calendar: hasCalendarPart(parsed),
    folder,
    body: plainText(parsed.text || "", parsed.html || ""),
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

// Every selectable folder by default (the mailbox holds only job-search mail;
// the folder is a hint for the extraction pass). `override` = --folders list,
// matched case-insensitively against the folder path or name.
function pickFolders(list, override = []) {
  const boxes = (Array.isArray(list) ? list : []).filter((b) => {
    if (!b || !b.path) return false;
    const flags = b.flags instanceof Set ? [...b.flags] : Array.isArray(b.flags) ? b.flags : [];
    return !flags.some((f) => /\\(?:noselect|nonexistent)/i.test(f));
  });
  if (override.length) {
    const want = new Set(override.map((s) => s.toLowerCase()));
    return boxes
      .filter((b) => want.has(b.path.toLowerCase()) || want.has(String(b.name || "").toLowerCase()))
      .map((b) => b.path);
  }
  const out = ["INBOX"];
  for (const b of boxes) if (b.path.toUpperCase() !== "INBOX") out.push(b.path);
  return [...new Set(out)];
}

// Fetch one folder into `out`, skipping UIDs already in `done`. Resumable: a
// dropped connection throws, the caller reconnects and calls again with the
// same `done` / `out`, and only the remaining UIDs are fetched.
async function fetchFolder(client, folder, { since, parser, done = new Set(), out = [] } = {}) {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const query = since ? { since: new Date(`${since}T00:00:00Z`) } : { all: true };
    const uids = ((await client.search(query, { uid: true })) || []).filter((u) => !done.has(u));
    for (let i = 0; i < uids.length; i += FETCH_CHUNK) {
      const chunk = uids.slice(i, i + FETCH_CHUNK);
      for await (const msg of client.fetch(
        chunk,
        { uid: true, envelope: true, internalDate: true, source: true },
        { uid: true }
      )) {
        if (!msg) continue;
        if (msg.uid !== undefined) done.add(msg.uid);
        if (!msg.source) continue;
        try {
          out.push(
            await parseRawMessage(msg.source, {
              parser,
              fallbackDate: msg.internalDate,
              folder,
            })
          );
        } catch (_err) {
          // Unparseable MIME: skip, the report counts what was read.
        }
      }
    }
  } finally {
    try {
      lock.release();
    } catch (_e) {
      // connection already gone
    }
  }
  return out;
}

const MAX_RECONNECTS = 8;

function isConnectionError(err) {
  if (!err) return false;
  if (
    ["ECONNRESET", "ETIMEDOUT", "EPIPE", "NoConnection", "ClosedAfterConnectTLS"].includes(err.code)
  )
    return true;
  return /connection not available|socket|timed? ?out|closed|ECONNRESET|EPIPE/i.test(
    String(err.message || "")
  );
}

async function collectFromImap(
  creds,
  { since, folders: override = [], makeClient, parser, log = () => {} } = {}
) {
  let conn = await connectZoho(creds, { makeClient, log });
  const host = conn.host;
  const out = [];
  try {
    const folders = pickFolders(await conn.client.list(), override);
    if (override.length && folders.length < override.length) {
      log(`warning: some --folders not found; reading ${folders.join(", ") || "(none)"}`);
    }
    log(`IMAP ${host}: reading ${folders.join(", ")}`);
    for (const folder of folders) {
      const done = new Set();
      const got = [];
      let failures = 0;
      for (;;) {
        const before = done.size;
        try {
          await fetchFolder(conn.client, folder, { since, parser, done, out: got });
          break;
        } catch (err) {
          if (!isConnectionError(err)) throw err;
          failures = done.size > before ? 1 : failures + 1;
          if (failures > MAX_RECONNECTS) throw err;
          log(`  ${folder}: connection lost after ${done.size} message(s), reconnecting`);
          await safeLogout(conn.client);
          conn = await connectZoho(creds, { makeClient, log });
        }
      }
      log(`  ${folder}: ${got.length} message(s)`);
      out.push(...got);
    }
  } finally {
    await safeLogout(conn.client);
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
  } else if (args.extracted) {
    const file = path.resolve(args.extracted);
    if (!fs.existsSync(file)) throw new Error(`--extracted file not found: ${file}`);
    const records = JSON.parse(fs.readFileSync(file, "utf8"));
    const { apps } = appsTsv.load(tsvPath);
    plan = buildPlanFromExtracted(apps, records, {
      since: args.since,
      companyAliases: profile.company_aliases || {},
      now,
    });
    plan.profile = args.profile;
    plan.source = `extracted:${path.basename(file)}`;
    planPath = writePlan(root, plan, now);
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
        folders: args.folders,
        makeClient: opts.makeImapClient,
        parser: opts.parser,
        log,
      });
      messages = res.messages;
      source = `imap:${res.host}`;
    }
    if (args.exportMessages) {
      // Personal data: always lands in the gitignored profile dir.
      const dir = planDir(root);
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, path.basename(args.exportMessages));
      const seen = new Set();
      const records = [];
      for (const m of messages) {
        if (args.since && m.date && m.date.slice(0, 10) < args.since) continue;
        const r = exportRecord(m);
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        records.push(r);
      }
      fs.writeFileSync(out, JSON.stringify(records, null, 1) + "\n");
      const byFolder = {};
      for (const r of records) byFolder[r.folder || "-"] = (byFolder[r.folder || "-"] || 0) + 1;
      log(`exported ${records.length} message(s) from ${source} → ${out}`);
      for (const [f, n] of Object.entries(byFolder)) log(`  ${f}: ${n}`);
      return { exported: records.length, exportPath: out, byFolder };
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
  // Matched rows that already have a Notion page get the same status there;
  // otherwise the next pull-only `sync` would overwrite the import from Notion.
  const before = new Map(apps.map((a) => [a.key, a.status]));
  const notionTargets = res.apps.filter(
    (a) => a.notion_page_id && before.has(a.key) && before.get(a.key) !== a.status
  );
  let notionFailed = 0;
  if (notionTargets.length) {
    const notion = opts.notion || require("../engine/core/notion_sync.js");
    const secrets = loadSecrets(args.profile, env) || {};
    if (!secrets.NOTION_TOKEN) {
      throw new Error(`missing ${secretEnvName(args.profile, "NOTION_TOKEN")} — nothing written`);
    }
    const client = notion.makeClient(secrets.NOTION_TOKEN);
    const propertyMap =
      (profile.notion && profile.notion.property_map) || notion.DEFAULT_PROPERTY_MAP;
    for (const a of notionTargets) {
      try {
        await notion.updatePageStatus(client, a.notion_page_id, a.status, propertyMap);
      } catch (err) {
        notionFailed++;
        log(`  notion update failed for ${a.key}: ${err.message}`);
      }
    }
  }
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
      `. Notion status updated on ${notionTargets.length - notionFailed} page(s)` +
      (notionFailed ? `, ${notionFailed} failed (re-run sync after fixing)` : "") +
      "."
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
