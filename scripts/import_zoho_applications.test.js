const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const appsTsv = require("../engine/core/applications_tsv");
const { run, parseArgs, pickFolders, isAuthError } = require("./import_zoho_applications.js");

const FIXTURES = path.join(__dirname, "..", "engine", "core", "fixtures", "legacy_import");
const PROFILE = "testprof";
const NOW = "2025-04-01T00:00:00.000Z";

function makeProfile() {
  const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-import-"));
  const root = path.join(profilesDir, PROFILE);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "profile.json"), JSON.stringify({ id: PROFILE }));
  const tsvPath = path.join(root, "applications.tsv");
  appsTsv.save(tsvPath, [
    {
      key: "greenhouse:111",
      source: "greenhouse",
      jobId: "111",
      companyName: "Acme",
      title: "Senior Product Manager - Growth",
      url: "https://example.com/111",
      locations: ["Remote"],
      status: "To Apply",
      notion_page_id: "page-111",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      hm_outreach_status: "To do",
    },
  ]);
  return { profilesDir, root, tsvPath };
}

// Fake Notion: records status pushes for rows that already have a page.
const notionCalls = [];
const fakeNotion = {
  makeClient: () => ({}),
  DEFAULT_PROPERTY_MAP: {},
  updatePageStatus: async (_client, pageId, status) => {
    notionCalls.push({ pageId, status });
  },
};

function quietRun(opts) {
  const lines = [];
  const env = { TESTPROF_NOTION_TOKEN: "fake", ...(opts.env || {}) };
  return run({ now: NOW, log: (s) => lines.push(s), notion: fakeNotion, ...opts, env }).then(
    (res) => ({
      ...res,
      output: lines.join("\n"),
    })
  );
}

const HAS_V8 = appsTsv.HEADER.includes("applied_by");

test("parseArgs: defaults to dry-run, validates --since and --plan", () => {
  assert.deepEqual(parseArgs(["--profile", "x"]), {
    profile: "x",
    since: "",
    mbox: "",
    folders: [],
    exportMessages: "",
    extracted: "",
    apply: false,
    plan: "",
    help: false,
  });
  assert.deepEqual(parseArgs(["--profile", "x", "--folders", "INBOX, Rejections"]).folders, [
    "INBOX",
    "Rejections",
  ]);
  assert.throws(
    () => parseArgs(["--profile", "x", "--export-messages", "m.json", "--apply"]),
    /only exports/
  );
  assert.throws(
    () => parseArgs(["--profile", "x", "--extracted", "e.json", "--mbox", "a.mbox"]),
    /reads no mail/
  );
  assert.throws(() => parseArgs([]), /--profile/);
  assert.throws(() => parseArgs(["--profile", "x", "--since", "03/01/2025"]), /YYYY-MM-DD/);
  assert.throws(() => parseArgs(["--profile", "x", "--plan", "p.json"]), /only used with --apply/);
  assert.throws(() => parseArgs(["--profile", "x", "--bogus"]), /unknown argument/);
});

test("pickFolders: every selectable folder by default, --folders override", () => {
  const list = [
    { path: "Sent", name: "Sent" },
    { path: "INBOX", name: "INBOX" },
    { path: "Jobs", name: "Jobs", flags: new Set(["\\Noselect"]) },
    { path: "Jobs/Applied", name: "Applied" },
    { path: "Rejections", name: "Rejections" },
  ];
  assert.deepEqual(pickFolders(list), ["INBOX", "Sent", "Jobs/Applied", "Rejections"]);
  assert.deepEqual(pickFolders(list, ["rejections", "Applied"]), ["Jobs/Applied", "Rejections"]);
});

test("isAuthError recognises imapflow auth failures", () => {
  const e = new Error("Command failed");
  e.authenticationFailed = true;
  assert.equal(isAuthError(e), true);
  assert.equal(isAuthError(new Error("AUTHENTICATE failed")), true);
  assert.equal(isAuthError(new Error("ECONNRESET")), false);
});

test("e2e mbox dir: dry-run writes a plan, leaves the TSV alone; --apply is idempotent", async () => {
  const { profilesDir, root, tsvPath } = makeProfile();
  const before = fs.readFileSync(tsvPath, "utf8");

  const dry = await quietRun({
    argv: ["--profile", PROFILE, "--mbox", FIXTURES],
    profilesDir,
  });
  assert.equal(dry.applied, false);
  assert.equal(fs.readFileSync(tsvPath, "utf8"), before, "dry-run must not touch the TSV");
  assert.ok(dry.planPath.startsWith(path.join(root, ".legacy-import", "plan-")));
  const saved = JSON.parse(fs.readFileSync(dry.planPath, "utf8"));
  assert.equal(saved.profile, PROFILE);
  assert.equal(saved.source, "mbox:legacy_import");

  const s = dry.plan.stats;
  assert.equal(s.scanned, 10);
  assert.equal(s.filtered, 1); // Indeed digest
  assert.equal(s.classified.Applied, 7);
  assert.equal(s.classified.Rejected, 1);
  assert.equal(s.classified.Interview, 1);
  assert.equal(s.matchedRows, 1); // Acme
  assert.equal(s.newRows, 5); // Globex, Initech, Umbrella, Hooli, Vandelay
  assert.equal(s.unparseable, 1); // generic Lever ack
  assert.equal(s.notionLinkedUpdates, 1);
  assert.match(dry.output, /Thanks for applying/);
  assert.match(dry.output, /Notion/);
  assert.doesNotMatch(dry.output, /We will be in touch/, "report must not print bodies");

  const applied = await quietRun({
    argv: ["--profile", PROFILE, "--mbox", FIXTURES, "--apply"],
    profilesDir,
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.result.updated, 1);
  assert.equal(applied.result.appended, 5);

  const { apps } = appsTsv.load(tsvPath);
  assert.equal(apps.length, 6);
  const acme = apps.find((a) => a.key === "greenhouse:111");
  assert.equal(acme.status, "Rejected"); // ack 03-03, rejection 03-24
  assert.equal(acme.applied_date, "2025-03-03");
  assert.equal(acme.notion_page_id, "page-111");
  const initech = apps.find((a) => a.companyName === "Initech");
  assert.equal(initech.status, "Interview");
  assert.equal(initech.source, "legacy_bot");
  assert.equal(initech.url, "");
  assert.equal(initech.applied_date, "2025-03-05");
  const umbrella = apps.find((a) => a.companyName === "Umbrella");
  assert.equal(umbrella.title, "Senior Product Manager");
  assert.equal(umbrella.status, "Applied");
  if (HAS_V8) {
    assert.equal(initech.applied_by, "legacy_bot");
    assert.equal(initech.apply_state, "submitted");
    assert.equal(acme.applied_by, "legacy_bot");
  }

  // Second run: nothing new.
  const again = await quietRun({
    argv: ["--profile", PROFILE, "--mbox", FIXTURES, "--apply"],
    profilesDir,
  });
  assert.equal(again.plan.stats.newRows, 0);
  assert.equal(again.result.appended, 0);
  if (HAS_V8) assert.equal(again.plan.stats.updates, 0);
  assert.equal(appsTsv.load(tsvPath).apps.length, 6);
});

test("e2e: --apply --plan applies the reviewed plan without reading mail, once", async () => {
  const { profilesDir, tsvPath } = makeProfile();
  const dry = await quietRun({
    argv: ["--profile", PROFILE, "--mbox", path.join(FIXTURES, "sample.mbox")],
    profilesDir,
  });
  assert.equal(dry.plan.stats.scanned, 2);
  assert.equal(dry.plan.stats.matchedRows, 1);
  assert.equal(dry.plan.stats.newRows, 1);

  const res = await quietRun({
    argv: ["--profile", PROFILE, "--apply", "--plan", dry.planPath],
    profilesDir,
    makeImapClient: () => {
      throw new Error("must not connect");
    },
  });
  assert.equal(res.result.updated, 1);
  assert.equal(res.result.appended, 1);
  const { apps } = appsTsv.load(tsvPath);
  const globex = apps.find((a) => a.companyName === "Globex");
  assert.equal(globex.status, "Rejected");
  assert.equal(globex.applied_date, "2025-03-24");
  assert.ok(JSON.parse(fs.readFileSync(dry.planPath, "utf8")).appliedAt);

  await assert.rejects(
    quietRun({ argv: ["--profile", PROFILE, "--apply", "--plan", dry.planPath], profilesDir }),
    /already applied/
  );
});

// ---------- IMAP with a fake client ----------

function fakeImapFactory({ failAuthOn = [], mailboxes }) {
  const calls = [];
  const factory = (host, creds) => {
    let current = null;
    return {
      async connect() {
        calls.push(["connect", host, creds.user]);
        if (failAuthOn.includes(host)) {
          const e = new Error("Command failed");
          e.authenticationFailed = true;
          throw e;
        }
      },
      async logout() {
        calls.push(["logout", host]);
      },
      async list() {
        return Object.keys(mailboxes).map((p) => ({ path: p, name: p.split("/").pop() }));
      },
      async getMailboxLock(p, opts) {
        calls.push(["lock", p, opts]);
        current = p;
        return { release: () => calls.push(["release", p]) };
      },
      async search(query) {
        calls.push(["search", current, query]);
        return mailboxes[current].map((_, i) => i + 1);
      },
      async *fetch(uids, query, opts) {
        calls.push(["fetch", current, query, opts]);
        for (const uid of uids) {
          yield {
            uid,
            source: Buffer.from(mailboxes[current][uid - 1]),
            internalDate: new Date(NOW),
          };
        }
      },
      messageFlagsAdd() {
        throw new Error("flags must never be modified");
      },
      messageFlagsSet() {
        throw new Error("flags must never be modified");
      },
      messageDelete() {
        throw new Error("messages must never be deleted");
      },
    };
  };
  return { factory, calls };
}

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

test("IMAP: falls back to imappro on auth failure, reads every folder read-only", async () => {
  const { profilesDir } = makeProfile();
  const { factory, calls } = fakeImapFactory({
    failAuthOn: ["imap.zoho.com"],
    mailboxes: {
      INBOX: [fixture("01_greenhouse_ack_acme.eml"), fixture("09_indeed_alert.eml")],
      "Jobs/Applied": [fixture("03_ashby_ack_initech.eml")],
      Spam: [fixture("05_icims_ack_hooli.eml")],
    },
  });
  const res = await quietRun({
    argv: ["--profile", PROFILE, "--since", "2025-01-01"],
    profilesDir,
    env: { TESTPROF_ZOHO_USER: "user@example.test", TESTPROF_ZOHO_APP_PASSWORD: "fake" },
    makeImapClient: factory,
  });
  assert.deepEqual(
    calls.filter((c) => c[0] === "connect").map((c) => c[1]),
    ["imap.zoho.com", "imappro.zoho.com"]
  );
  const locks = calls.filter((c) => c[0] === "lock");
  assert.deepEqual(
    locks.map((c) => c[1]),
    ["INBOX", "Jobs/Applied", "Spam"]
  );
  for (const l of locks) assert.deepEqual(l[2], { readOnly: true });
  assert.equal(calls.filter((c) => c[0] === "release").length, 3);
  const search = calls.find((c) => c[0] === "search");
  assert.ok(search[2].since instanceof Date);
  assert.equal(res.plan.source, "imap:imappro.zoho.com");
  assert.equal(res.plan.stats.scanned, 4); // Spam is read too: every folder by default
  assert.equal(res.plan.stats.filtered, 1);
  assert.equal(res.plan.stats.matchedRows, 1);
  assert.equal(res.plan.stats.newRows, 2);
  assert.equal(calls.at(-1)[0], "logout");
});

test("IMAP: missing credentials → clear error naming the env vars, no connect", async () => {
  const { profilesDir } = makeProfile();
  const { factory, calls } = fakeImapFactory({ mailboxes: { INBOX: [] } });
  await assert.rejects(
    quietRun({ argv: ["--profile", PROFILE], profilesDir, env: {}, makeImapClient: factory }),
    /TESTPROF_ZOHO_USER.*TESTPROF_ZOHO_APP_PASSWORD/
  );
  assert.equal(calls.length, 0);
});

test("IMAP: a non-auth connect error does not try the fallback host", async () => {
  const { profilesDir } = makeProfile();
  const calls = [];
  const factory = (host) => ({
    async connect() {
      calls.push(host);
      throw new Error("ECONNREFUSED");
    },
    async logout() {},
  });
  await assert.rejects(
    quietRun({
      argv: ["--profile", PROFILE],
      profilesDir,
      env: { TESTPROF_ZOHO_USER: "u", TESTPROF_ZOHO_APP_PASSWORD: "p" },
      makeImapClient: factory,
    }),
    /ECONNREFUSED/
  );
  assert.deepEqual(calls, ["imap.zoho.com"]);
});

test("--apply pushes the new status to Notion for matched rows with a page", () => {
  assert.ok(notionCalls.length > 0, "expected at least one Notion status update");
  for (const c of notionCalls) assert.ok(c.pageId && c.status);
});

test("--export-messages writes compact records under .legacy-import and builds no plan", async () => {
  const { profilesDir, root, tsvPath } = makeProfile();
  const before = fs.readFileSync(tsvPath, "utf8");
  const res = await quietRun({
    argv: ["--profile", PROFILE, "--mbox", FIXTURES, "--export-messages", "../../escape.json"],
    profilesDir,
  });
  assert.equal(res.exportPath, path.join(root, ".legacy-import", "escape.json"));
  assert.equal(res.plan, undefined);
  assert.equal(fs.readFileSync(tsvPath, "utf8"), before);
  assert.equal(fs.readdirSync(path.join(root, ".legacy-import")).length, 1, "no plan file");
  const records = JSON.parse(fs.readFileSync(res.exportPath, "utf8"));
  assert.equal(records.length, 10);
  const lever = records.find((r) => r.subject === "Thank you for your application to Globex");
  assert.match(lever.id, /^[0-9a-f]{16}$/);
  assert.equal(lever.date, "2025-03-04");
  assert.deepEqual(lever.from, { name: "Globex", address: "no-reply@hire.lever.co" });
  assert.match(lever.to, /pat\.example@example\.com/);
  assert.equal(lever.status, "Applied");
  assert.doesNotMatch(lever.excerpt, /<p>|&nbsp;/);
  assert.match(lever.excerpt, /Sr\. Product Manager - Payments position at\sGlobex/);
  assert.equal(records.find((r) => /more new jobs/.test(r.subject)).status, "Filtered");
  for (const r of records) assert.ok(r.excerpt.length <= 1500);
});

test("--extracted builds the plan from LLM records (no mail read)", async () => {
  const { profilesDir, tsvPath } = makeProfile();
  const before = fs.readFileSync(tsvPath, "utf8");
  const file = path.join(profilesDir, "extracted.json");
  const rec = (id, company, title, status, date, extra = {}) => ({
    id,
    company,
    title,
    status,
    date,
    ...extra,
  });
  fs.writeFileSync(
    file,
    JSON.stringify([
      rec("a1", "Acme", "Senior Product Manager, Growth", "Applied", "2025-03-03"),
      rec("a2", "Acme", "Senior Product Manager, Growth", "Rejected", "2025-03-24"),
      rec("b1", "Globex", "", "Applied", "2025-03-04"),
      rec("c1", "Initech", "Product Manager", "Applied", "2025-03-05", { note: "linkedin" }),
      rec("n1", "", "", "Ignore", "2025-03-06"),
    ])
  );
  const res = await quietRun({
    argv: ["--profile", PROFILE, "--extracted", file],
    profilesDir,
    makeImapClient: () => {
      throw new Error("must not connect");
    },
  });
  assert.equal(fs.readFileSync(tsvPath, "utf8"), before);
  const s = res.plan.stats;
  assert.equal(s.ignored, 1);
  assert.equal(s.matchedRows, 1);
  assert.equal(s.newRows, 2);
  assert.equal(s.companyOnlyRows, 1);
  assert.equal(res.plan.source, "extracted:extracted.json");
  assert.equal(res.plan.updates[0].patch.status, "Rejected");
  const initech = res.plan.appends.find((a) => a.companyName === "Initech");
  assert.equal(initech.status, "Applied");
  assert.equal(initech.applied_date, "2025-03-05");
  assert.equal(initech.apply_note, "linkedin:2025-03-05");
  const globex = res.plan.appends.find((a) => a.companyName === "Globex");
  assert.equal(globex.title, "");
  assert.equal(globex.status, "Applied");
  assert.match(res.output, /ignored: 1/);
});

test("IMAP: a dropped connection mid-folder reconnects and fetches only the rest", async () => {
  const { profilesDir } = makeProfile();
  const box = [
    fixture("01_greenhouse_ack_acme.eml"),
    fixture("02_lever_ack_globex.eml"),
    fixture("03_ashby_ack_initech.eml"),
  ];
  let connects = 0;
  let dropped = false;
  const fetched = [];
  const factory = () => ({
    async connect() {
      connects += 1;
    },
    async logout() {},
    async list() {
      return [{ path: "INBOX", name: "INBOX" }];
    },
    async getMailboxLock() {
      return { release() {} };
    },
    async search() {
      return [1, 2, 3];
    },
    async *fetch(uids) {
      for (const uid of uids) {
        if (uid === 2 && !dropped) {
          dropped = true;
          throw new Error("Connection not available");
        }
        fetched.push(uid);
        yield { uid, source: Buffer.from(box[uid - 1]), internalDate: new Date(NOW) };
      }
    },
  });
  const res = await quietRun({
    argv: ["--profile", PROFILE, "--folders", "INBOX"],
    profilesDir,
    env: { TESTPROF_ZOHO_USER: "u", TESTPROF_ZOHO_APP_PASSWORD: "p" },
    makeImapClient: factory,
  });
  assert.equal(connects, 2);
  assert.deepEqual(fetched, [1, 2, 3]);
  assert.equal(res.plan.stats.scanned, 3);
  assert.match(res.output, /reconnecting/);
});
