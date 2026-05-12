// Tests for engine/commands/reclassify.js (RFC 028 / BL-44).
//
// Mocks every side-effecting dep injected via ctx.deps. No real IMAP, no
// real Notion, no disk writes outside an OS tmp dir for processed_messages.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

const reclassify = require("./reclassify.js");

// ---------- Tiny helpers ----------

function makeProfile(rootDir = "/tmp/test-profile") {
  return {
    id: "lilia",
    paths: {
      root: rootDir,
      applicationsTsv: path.join(rootDir, "applications.tsv"),
    },
    companies: { aliases: {} },
  };
}

function makeBaseDeps(overrides = {}) {
  const calls = {
    prompts: [],
    fetchedIds: [],
    notionStatusUpdates: [],
    notionComments: [],
    writes: [],
    copies: [],
  };
  const deps = {
    loadProfile: () => makeProfile(),
    loadSecrets: () => ({ notion_token: "FAKE_NOTION_TOKEN" }),
    loadApplications: () => ({ apps: [] }),
    loadProcessed: () => ({ processed: [], last_check: null }),
    classify: () => ({ type: "OTHER", evidence: null }),
    loadGmailCredentials: () => ({ user: "u@x", appPassword: "p", source: "env" }),
    assertGmailCredentials: () => true,
    makeGmailClient: () => ({}),
    fetchMessagesByGmailIds: async (_client, ids) => {
      calls.fetchedIds.push(...ids);
      return ids.map((id) => ({ id, raw: null }));
    },
    makeNotionClient: () => ({}),
    updatePageStatus: async (_c, pageId, status) => {
      calls.notionStatusUpdates.push({ pageId, status });
    },
    addPageComment: async (_c, pageId, text) => {
      calls.notionComments.push({ pageId, text });
    },
    prompt: async (q) => {
      calls.prompts.push(q);
      return "n";
    },
    sleep: async () => {},
    now: () => new Date("2026-05-12T12:00:00Z"),
    writeFile: (p, content) => {
      calls.writes.push({ path: p, content });
    },
    readFile: () => "",
    copyFile: (src, dst) => {
      calls.copies.push({ src, dst });
    },
    existsSync: () => true,
    ...overrides,
  };
  return { deps, calls };
}

function makeCtx({ deps, flags = {}, env = {} }) {
  const out = [];
  const err = [];
  return {
    ctx: {
      profileId: "lilia",
      env: { LILIA_NOTION_TOKEN: "FAKE_NOTION_TOKEN", ...env },
      flags,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      deps,
    },
    out,
    err,
  };
}

// ---------- clampSinceIso ----------

test("clampSinceIso: null in → null out", () => {
  assert.equal(reclassify.clampSinceIso(null, new Date()), null);
  assert.equal(reclassify.clampSinceIso("", new Date()), null);
});

test("clampSinceIso: valid ISO within 30d passes through", () => {
  const now = new Date("2026-05-12T00:00:00Z");
  const out = reclassify.clampSinceIso("2026-05-01T00:00:00Z", now);
  assert.equal(out, "2026-05-01T00:00:00.000Z");
});

test("clampSinceIso: pre-30d clamped to floor", () => {
  const now = new Date("2026-05-12T00:00:00Z");
  // 60 days ago is past floor
  const out = reclassify.clampSinceIso("2026-03-12T00:00:00Z", now);
  const floor = new Date(now.getTime() - 30 * 86400 * 1000).toISOString();
  assert.equal(out, floor);
});

test("clampSinceIso: future ISO clamped to now", () => {
  const now = new Date("2026-05-12T00:00:00Z");
  const out = reclassify.clampSinceIso("2030-01-01T00:00:00Z", now);
  assert.equal(out, now.toISOString());
});

test("clampSinceIso: invalid ISO → null", () => {
  assert.equal(reclassify.clampSinceIso("not-a-date", new Date()), null);
});

// ---------- buildAllJobsMap ----------

test("buildAllJobsMap: groups by company, includes all statuses", () => {
  const apps = [
    { company: "Acme", role: "RDH", status: "To Apply" },
    { company: "Acme", role: "Float", status: "Rejected" },
    { company: "Beta", role: "PRN", status: "Closed" },
  ];
  const map = reclassify.buildAllJobsMap(apps);
  assert.equal(map.Acme.length, 2);
  assert.equal(map.Beta.length, 1);
  assert.equal(map.Acme[1].status, "Rejected");
});

// ---------- TYPE_TO_STATUS ----------

test("TYPE_TO_STATUS: shape is stable", () => {
  assert.equal(reclassify.TYPE_TO_STATUS.INTERVIEW_INVITE, "Interview");
  assert.equal(reclassify.TYPE_TO_STATUS.REJECTION, "Rejected");
  assert.equal(reclassify.TYPE_TO_STATUS.INFO_REQUEST, null);
  assert.equal(reclassify.TYPE_TO_STATUS.ACKNOWLEDGMENT, null);
});

// ---------- normalizeAnswer ----------

test("normalizeAnswer: blank → default, recognized → canonical", () => {
  assert.equal(reclassify.normalizeAnswer("", "n"), "n");
  assert.equal(reclassify.normalizeAnswer("y", "n"), "y");
  assert.equal(reclassify.normalizeAnswer("yes", "n"), "y");
  assert.equal(reclassify.normalizeAnswer("N", "y"), "n");
  assert.equal(reclassify.normalizeAnswer("skip-all", "n"), "skip-all");
  assert.equal(reclassify.normalizeAnswer("s", "n"), "skip-all");
  assert.equal(reclassify.normalizeAnswer("quit", "n"), "quit");
  assert.equal(reclassify.normalizeAnswer("garbage", "n"), "n"); // unrecognized → default
});

// ---------- fetchWithRetry ----------

test("fetchWithRetry: happy path returns immediately", async () => {
  let calls = 0;
  const out = await reclassify.fetchWithRetry({
    fetchFn: async () => {
      calls += 1;
      return ["ok"];
    },
    sleep: async () => {},
  });
  assert.deepEqual(out, ["ok"]);
  assert.equal(calls, 1);
});

test("fetchWithRetry: transient error → retry → success", async () => {
  let calls = 0;
  const out = await reclassify.fetchWithRetry({
    fetchFn: async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return "ok";
    },
    sleep: async () => {},
    maxRetries: 5,
  });
  assert.equal(out, "ok");
  assert.equal(calls, 3);
});

test("fetchWithRetry: exhausted retries → throws last error", async () => {
  let calls = 0;
  await assert.rejects(
    reclassify.fetchWithRetry({
      fetchFn: async () => {
        calls += 1;
        throw new Error(`fail-${calls}`);
      },
      sleep: async () => {},
      maxRetries: 3,
    }),
    /fail-3/
  );
});

// ---------- runReclassify: dry-run paths ----------

test("runReclassify: missing --profile → error exit 1", async () => {
  const { deps } = makeBaseDeps();
  const out = [];
  const err = [];
  const code = await reclassify.runReclassify({
    profileId: "",
    flags: {},
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    deps,
  });
  assert.equal(code, 1);
  assert.match(err.join("\n"), /--profile is required/);
});

test("runReclassify: missing IMAP creds → error exit 1", async () => {
  const { deps } = makeBaseDeps({
    assertGmailCredentials: () => {
      throw new Error("gmail_imap: missing LILIA_GMAIL_USER");
    },
  });
  const { ctx, err } = makeCtx({ deps });
  const code = await reclassify.runReclassify(ctx);
  assert.equal(code, 1);
  assert.match(err.join("\n"), /missing LILIA_GMAIL_USER/);
});

test("runReclassify: no OTHER entries → exit 0 with friendly message", async () => {
  const { deps } = makeBaseDeps({
    loadProcessed: () => ({
      processed: [{ id: "a", date: "2026-05-01", company: "X", type: "REJECTION" }],
      last_check: "2026-05-12T00:00:00Z",
    }),
  });
  const { ctx, out } = makeCtx({ deps });
  const code = await reclassify.runReclassify(ctx);
  assert.equal(code, 0);
  assert.match(out.join("\n"), /0 OTHER entries/);
  assert.match(out.join("\n"), /nothing to do/);
});

test("runReclassify: dry-run reports reclassification but does not write JSON", async () => {
  const processed = [
    { id: "aaaa", date: "2026-04-29", company: "DentEmploy", type: "OTHER" },
    { id: "bbbb", date: "2026-05-01", company: "Acme", type: "OTHER" },
  ];
  const { deps, calls } = makeBaseDeps({
    loadProcessed: () => ({ processed, last_check: null }),
    fetchMessagesByGmailIds: async (_c, ids) =>
      ids.map((id) => ({
        id,
        raw: { messageId: id, subject: "interview invitation", body: "" },
      })),
    classify: ({ subject }) =>
      subject.includes("interview")
        ? { type: "INTERVIEW_INVITE", evidence: "interview invitation" }
        : { type: "OTHER", evidence: null },
  });
  const { ctx, out } = makeCtx({ deps, flags: {} });
  const code = await reclassify.runReclassify(ctx);
  assert.equal(code, 0);
  const allOut = out.join("\n");
  assert.match(allOut, /OTHER → INTERVIEW_INVITE/);
  assert.match(allOut, /summary: 2 OTHER scanned · 2 reclassified/);
  assert.match(allOut, /dry-run/);
  // no writes in dry-run
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.copies.length, 0);
});

test("runReclassify: still-OTHER rows counted as unchanged, no apply needed", async () => {
  const processed = [{ id: "x", date: "2026-05-01", company: "X", type: "OTHER" }];
  const { deps } = makeBaseDeps({
    loadProcessed: () => ({ processed, last_check: null }),
    fetchMessagesByGmailIds: async (_c, ids) =>
      ids.map((id) => ({ id, raw: { subject: "newsletter", body: "" } })),
    classify: () => ({ type: "OTHER", evidence: null }),
  });
  const { ctx, out } = makeCtx({ deps });
  const code = await reclassify.runReclassify(ctx);
  assert.equal(code, 0);
  assert.match(out.join("\n"), /1 unchanged/);
});

test("runReclassify: --since filters OTHER entries by date", async () => {
  const processed = [
    { id: "old", date: "2026-03-01T00:00:00Z", company: "X", type: "OTHER" },
    { id: "new", date: "2026-05-10T00:00:00Z", company: "Y", type: "OTHER" },
  ];
  const { deps, calls } = makeBaseDeps({
    loadProcessed: () => ({ processed, last_check: null }),
  });
  const { ctx } = makeCtx({ deps, flags: { since: "2026-05-09T00:00:00Z" } });
  await reclassify.runReclassify(ctx);
  // Only `new` should have been fetched.
  assert.deepEqual(calls.fetchedIds, ["new"]);
});

test("runReclassify: --limit caps batch size", async () => {
  const processed = Array.from({ length: 10 }, (_, i) => ({
    id: `id${i}`,
    date: "2026-05-01",
    company: "X",
    type: "OTHER",
  }));
  const { deps, calls } = makeBaseDeps({
    loadProcessed: () => ({ processed, last_check: null }),
  });
  const { ctx } = makeCtx({ deps, flags: { limit: 3 } });
  await reclassify.runReclassify(ctx);
  assert.equal(calls.fetchedIds.length, 3);
});

test("runReclassify: fetch error per id reported but does not fail run", async () => {
  const processed = [
    { id: "gone", date: "2026-05-01", company: "X", type: "OTHER" },
    { id: "ok", date: "2026-05-02", company: "Y", type: "OTHER" },
  ];
  const { deps } = makeBaseDeps({
    loadProcessed: () => ({ processed, last_check: null }),
    fetchMessagesByGmailIds: async (_c, ids) =>
      ids.map((id) =>
        id === "gone"
          ? { id, raw: null, error: "not found" }
          : { id, raw: { subject: "unfortunately", body: "" } }
      ),
    classify: ({ subject }) =>
      subject.includes("unfortunately")
        ? { type: "REJECTION", evidence: "unfortunately" }
        : { type: "OTHER", evidence: null },
  });
  const { ctx, out } = makeCtx({ deps });
  const code = await reclassify.runReclassify(ctx);
  assert.equal(code, 0);
  const all = out.join("\n");
  assert.match(all, /error: not found/);
  assert.match(all, /OTHER → REJECTION/);
  assert.match(all, /1 reclassified.*1 unchanged.*1 errors|1 reclassified.*1 errors/s);
});

// ---------- runReclassify: --apply ----------

test("runReclassify: --apply writes processed_messages.json with new types, preserves last_check", async () => {
  const processed = [
    { id: "aaaa", date: "2026-04-29", company: "X", type: "OTHER" },
    { id: "bbbb", date: "2026-05-01", company: "Y", type: "REJECTION" }, // unchanged
  ];
  const lastCheck = "2026-05-11T00:00:00Z";
  const { deps, calls } = makeBaseDeps({
    loadProcessed: () => ({ processed, last_check: lastCheck }),
    fetchMessagesByGmailIds: async (_c, ids) =>
      ids.map((id) => ({ id, raw: { subject: "interview", body: "" } })),
    classify: () => ({ type: "INTERVIEW_INVITE", evidence: "interview" }),
  });
  const { ctx, out } = makeCtx({ deps, flags: { apply: true } });
  const code = await reclassify.runReclassify(ctx);
  assert.equal(code, 0);
  assert.equal(calls.copies.length, 1, "must write .bak before mutating");
  assert.match(calls.copies[0].dst, /\.\d{4}-\d{2}-\d{2}T.*\.bak$/, "timestamped .bak");
  assert.equal(calls.writes.length, 1);
  const written = JSON.parse(calls.writes[0].content);
  assert.equal(written.last_check, lastCheck, "last_check NOT bumped by reclassify");
  assert.equal(written.processed[0].type, "INTERVIEW_INVITE");
  assert.equal(written.processed[1].type, "REJECTION"); // untouched
  assert.match(out.join("\n"), /1 rows updated/);
});

test("runReclassify: --apply with zero changes → no write", async () => {
  const processed = [{ id: "x", date: "2026-05-01", company: "X", type: "OTHER" }];
  const { deps, calls } = makeBaseDeps({
    loadProcessed: () => ({ processed, last_check: null }),
    fetchMessagesByGmailIds: async (_c, ids) =>
      ids.map((id) => ({ id, raw: { subject: "newsletter", body: "" } })),
    classify: () => ({ type: "OTHER", evidence: null }),
  });
  const { ctx, out } = makeCtx({ deps, flags: { apply: true } });
  const code = await reclassify.runReclassify(ctx);
  assert.equal(code, 0);
  assert.equal(calls.writes.length, 0);
  assert.match(out.join("\n"), /nothing to apply/);
});

// ---------- runReclassify: --apply --notion interactive ----------

test("runReclassify: --apply --notion 'y' updates page status + adds comment", async () => {
  const processed = [{ id: "aaaa", date: "2026-04-29", company: "DentEmploy", type: "OTHER" }];
  const apps = [
    {
      company: "DentEmploy",
      role: "Dental Hygienist",
      status: "To Apply",
      notion_page_id: "page-1",
    },
  ];
  const { deps, calls } = makeBaseDeps({
    loadProcessed: () => ({ processed, last_check: null }),
    loadApplications: () => ({ apps }),
    fetchMessagesByGmailIds: async (_c, ids) =>
      ids.map((id) => ({
        id,
        raw: {
          subject: "Interview Invitation - DentEmploy",
          body: "We'd like to invite you",
          from: "DentEmploy <noreply@dentemploy.com>",
        },
      })),
    classify: () => ({ type: "INTERVIEW_INVITE", evidence: "interview invitation" }),
    prompt: async () => "y",
  });
  const { ctx } = makeCtx({ deps, flags: { apply: true, notion: true } });
  const code = await reclassify.runReclassify(ctx);
  assert.equal(code, 0);
  assert.equal(calls.notionStatusUpdates.length, 1);
  assert.deepEqual(calls.notionStatusUpdates[0], { pageId: "page-1", status: "Interview" });
  assert.equal(calls.notionComments.length, 1);
  assert.equal(calls.notionComments[0].pageId, "page-1");
  assert.match(calls.notionComments[0].text, /OTHER → INTERVIEW_INVITE/);
  assert.match(calls.notionComments[0].text, /BL-44 \(RFC 028\)/);
  assert.match(calls.notionComments[0].text, /source: aaaa/);
});

test("runReclassify: --apply --notion 'N' skips, no Notion calls", async () => {
  const processed = [{ id: "aaaa", date: "2026-04-29", company: "Acme", type: "OTHER" }];
  const apps = [{ company: "Acme", role: "Hygienist", status: "To Apply", notion_page_id: "p1" }];
  let promptCount = 0;
  const { deps, calls } = makeBaseDeps({
    loadProcessed: () => ({ processed, last_check: null }),
    loadApplications: () => ({ apps }),
    fetchMessagesByGmailIds: async (_c, ids) =>
      ids.map((id) => ({
        id,
        raw: {
          subject: "Interview Invitation - Acme Hygienist",
          body: "Interview at Acme.",
          from: "Acme <hr@acme.com>",
        },
      })),
    classify: () => ({ type: "INTERVIEW_INVITE", evidence: "interview" }),
    prompt: async () => {
      promptCount += 1;
      return "n";
    },
  });
  const { ctx } = makeCtx({ deps, flags: { apply: true, notion: true } });
  const code = await reclassify.runReclassify(ctx);
  assert.equal(code, 0);
  assert.equal(promptCount, 1, "prompt should fire once for a matched row");
  assert.equal(calls.notionStatusUpdates.length, 0);
  assert.equal(calls.notionComments.length, 0);
});

test("runReclassify: --apply --notion 'skip-all' halts further prompts", async () => {
  const processed = [
    { id: "a", date: "2026-04-29", company: "Acme", type: "OTHER" },
    { id: "b", date: "2026-04-30", company: "Beta", type: "OTHER" },
    { id: "c", date: "2026-05-01", company: "Gamma", type: "OTHER" },
  ];
  const apps = [
    { company: "Acme", role: "Hygienist", status: "To Apply", notion_page_id: "p1" },
    { company: "Beta", role: "Hygienist", status: "To Apply", notion_page_id: "p2" },
    { company: "Gamma", role: "Hygienist", status: "To Apply", notion_page_id: "p3" },
  ];
  let promptCount = 0;
  const { deps, calls } = makeBaseDeps({
    loadProcessed: () => ({ processed, last_check: null }),
    loadApplications: () => ({ apps }),
    fetchMessagesByGmailIds: async (_c, ids) =>
      ids.map((id) => {
        const co = id === "a" ? "Acme" : id === "b" ? "Beta" : "Gamma";
        return {
          id,
          raw: {
            subject: `Interview Invitation - ${co} Hygienist`,
            body: `We'd like to invite you to interview at ${co}.`,
            from: `${co} <hr@${co.toLowerCase()}.com>`,
          },
        };
      }),
    classify: () => ({ type: "INTERVIEW_INVITE", evidence: "interview" }),
    prompt: async () => {
      promptCount += 1;
      return "skip-all";
    },
  });
  const { ctx, out } = makeCtx({ deps, flags: { apply: true, notion: true } });
  await reclassify.runReclassify(ctx);
  // After 'skip-all' on the first prompt, no more prompts and no Notion calls.
  assert.equal(promptCount, 1, "skip-all must stop further prompts after the first");
  assert.equal(calls.notionStatusUpdates.length, 0);
  assert.equal(calls.notionComments.length, 0);
  assert.match(out.join("\n"), /skip-all/);
});

test("runReclassify: --apply --notion 'quit' exits early", async () => {
  const processed = [
    { id: "a", date: "2026-04-29", company: "Acme", type: "OTHER" },
    { id: "b", date: "2026-04-30", company: "Beta", type: "OTHER" },
  ];
  const apps = [
    { company: "Acme", role: "Hygienist", status: "To Apply", notion_page_id: "p1" },
    { company: "Beta", role: "Hygienist", status: "To Apply", notion_page_id: "p2" },
  ];
  let promptCount = 0;
  const { deps, calls } = makeBaseDeps({
    loadProcessed: () => ({ processed, last_check: null }),
    loadApplications: () => ({ apps }),
    fetchMessagesByGmailIds: async (_c, ids) =>
      ids.map((id) => {
        const co = id === "a" ? "Acme" : "Beta";
        return {
          id,
          raw: {
            subject: `Interview Invitation - ${co} Hygienist`,
            body: `Interview at ${co}.`,
            from: `${co} <hr@${co.toLowerCase()}.com>`,
          },
        };
      }),
    classify: () => ({ type: "INTERVIEW_INVITE", evidence: "interview" }),
    prompt: async () => {
      promptCount += 1;
      return "quit";
    },
  });
  const { ctx, out } = makeCtx({ deps, flags: { apply: true, notion: true } });
  await reclassify.runReclassify(ctx);
  assert.equal(promptCount, 1, "quit on first prompt exits before second");
  assert.equal(calls.notionStatusUpdates.length, 0);
  assert.match(out.join("\n"), /quit/);
});

test("runReclassify: --apply --notion terminal-status default-N (blank → skip)", async () => {
  const processed = [{ id: "a", date: "2026-04-29", company: "Acme", type: "OTHER" }];
  // Current status is Rejected — operator must explicitly type 'y'.
  const apps = [{ company: "Acme", role: "Hygienist", status: "Rejected", notion_page_id: "p1" }];
  let promptQuestion = "";
  const { deps, calls } = makeBaseDeps({
    loadProcessed: () => ({ processed, last_check: null }),
    loadApplications: () => ({ apps }),
    fetchMessagesByGmailIds: async (_c, ids) =>
      ids.map((id) => ({
        id,
        raw: {
          subject: "Interview Invitation - Acme Hygienist",
          body: "Interview at Acme.",
          from: "Acme <hr@acme.com>",
        },
      })),
    classify: () => ({ type: "INTERVIEW_INVITE", evidence: "interview" }),
    prompt: async (q) => {
      promptQuestion = q;
      return ""; // blank → default
    },
  });
  const { ctx } = makeCtx({ deps, flags: { apply: true, notion: true } });
  await reclassify.runReclassify(ctx);
  assert.match(promptQuestion, /y\/N/, "default must be N for terminal status");
  assert.equal(calls.notionStatusUpdates.length, 0, "blank-on-terminal must not update");
});

test("runReclassify: --apply --notion no TSV match → skipped silently", async () => {
  const processed = [{ id: "a", date: "2026-04-29", company: "Unknown", type: "OTHER" }];
  const { deps, calls } = makeBaseDeps({
    loadProcessed: () => ({ processed, last_check: null }),
    loadApplications: () => ({ apps: [] }),
    fetchMessagesByGmailIds: async (_c, ids) =>
      ids.map((id) => ({ id, raw: { subject: "interview", body: "", from: "x <a@b>" } })),
    classify: () => ({ type: "INTERVIEW_INVITE", evidence: "interview" }),
  });
  const { ctx, out } = makeCtx({ deps, flags: { apply: true, notion: true } });
  await reclassify.runReclassify(ctx);
  assert.equal(calls.prompts.length, 0, "no prompt for rows without TSV match");
  assert.equal(calls.notionStatusUpdates.length, 0);
  assert.match(out.join("\n"), /no TSV match|no notion_page_id/);
});

// ---------- IMAP-side write smoke: real fs round-trip ----------

test("runReclassify: --apply writes valid JSON readable from disk", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reclassify-"));
  const stateDir = path.join(tmp, ".gmail-state");
  fs.mkdirSync(stateDir, { recursive: true });
  const processedPath = path.join(stateDir, "processed_messages.json");
  const initial = {
    processed: [{ id: "aaaa", date: "2026-04-29", company: "X", type: "OTHER" }],
    last_check: "2026-05-11T00:00:00Z",
  };
  fs.writeFileSync(processedPath, JSON.stringify(initial, null, 2));

  const { deps } = makeBaseDeps({
    loadProfile: () => ({
      id: "lilia",
      paths: { root: tmp, applicationsTsv: path.join(tmp, "applications.tsv") },
      companies: { aliases: {} },
    }),
    loadProcessed: (p) => JSON.parse(fs.readFileSync(p, "utf8")),
    fetchMessagesByGmailIds: async (_c, ids) =>
      ids.map((id) => ({ id, raw: { subject: "interview", body: "" } })),
    classify: () => ({ type: "INTERVIEW_INVITE", evidence: "interview" }),
    writeFile: fs.writeFileSync,
    copyFile: fs.copyFileSync,
    existsSync: fs.existsSync,
  });
  const { ctx } = makeCtx({ deps, flags: { apply: true } });
  const code = await reclassify.runReclassify(ctx);
  assert.equal(code, 0);

  const written = JSON.parse(fs.readFileSync(processedPath, "utf8"));
  assert.equal(written.processed[0].type, "INTERVIEW_INVITE");
  assert.equal(written.last_check, "2026-05-11T00:00:00Z");
  // Timestamped .bak (e.g. processed_messages.json.2026-05-12T12-00-00-000Z.bak)
  const bakFiles = fs.readdirSync(stateDir).filter((f) => /\.bak$/.test(f));
  assert.equal(bakFiles.length, 1, "exactly one timestamped .bak must exist");
  assert.match(bakFiles[0], /processed_messages\.json\.\d{4}-\d{2}-\d{2}T.*\.bak/);

  // cleanup
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- Partial-state hazard (status OK, comment fails) ----------

test("runReclassify: --apply --notion status-succeeds-comment-fails surfaces page id + source id", async () => {
  const processed = [{ id: "aaaa", date: "2026-04-29", company: "DentEmploy", type: "OTHER" }];
  const apps = [
    {
      company: "DentEmploy",
      role: "Dental Hygienist",
      status: "To Apply",
      notion_page_id: "page-broken",
    },
  ];
  const statusCalls = [];
  const { deps, calls } = makeBaseDeps({
    loadProcessed: () => ({ processed, last_check: null }),
    loadApplications: () => ({ apps }),
    fetchMessagesByGmailIds: async (_c, ids) =>
      ids.map((id) => ({
        id,
        raw: {
          subject: "Interview Invitation - DentEmploy",
          body: "We'd like to invite you to DentEmploy.",
          from: "DentEmploy <hr@dentemploy.com>",
        },
      })),
    classify: () => ({ type: "INTERVIEW_INVITE", evidence: "interview invitation" }),
    prompt: async () => "y",
    // status update succeeds, comment throws — partial state. Don't shadow
    // the calls.notionStatusUpdates recorder from makeBaseDeps; use a local
    // tracker for this test.
    updatePageStatus: async (_c, pageId, status) => {
      statusCalls.push({ pageId, status });
    },
    addPageComment: async () => {
      throw new Error("Notion 502 bad gateway");
    },
  });
  const { ctx, err } = makeCtx({ deps, flags: { apply: true, notion: true } });
  const code = await reclassify.runReclassify(ctx);
  // Non-zero exit: notion error count > 0
  assert.equal(code, 1);
  // Status moved (locally tracked, since we overrode the dep)
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].status, "Interview");
  // No comment was recorded (it threw).
  assert.equal(calls.notionComments.length, 0);
  // Comment errored — error message must surface BOTH page id and source id
  // so the operator can find and recover the half-applied row.
  const stderr = err.join("\n");
  assert.match(stderr, /PARTIAL/);
  assert.match(stderr, /page-broken/);
  assert.match(stderr, /aaaa/);
  assert.match(stderr, /Interview/, "name the new status in the partial-state warning");
});
