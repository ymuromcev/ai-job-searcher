const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  makeCheckCommand,
  buildActiveJobsMap,
  buildBatches,
  processLinkedIn,
  processRecruiter,
  processPipeline,
} = require("./check.js");

function captureOut() {
  const stdout = [];
  const stderr = [];
  return {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    lines: stdout,
    errs: stderr,
    all: () => stdout.concat(stderr).join("\n"),
  };
}

function fakeApp(overrides = {}) {
  return {
    key: "greenhouse:1",
    source: "greenhouse",
    jobId: "1",
    companyName: "Affirm",
    title: "Product Manager",
    url: "https://x/1",
    status: "Applied",
    notion_page_id: "page-1",
    resume_ver: "",
    cl_key: "",
    salary_min: "",
    salary_max: "",
    cl_path: "",
    createdAt: "now",
    updatedAt: "now",
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const calls = {
    saveContext: [],
    saveProcessed: [],
    saveApplications: [],
    updatePageStatus: [],
    addPageComment: [],
    appendRecruiterLeads: [],
    appendRejectionLog: [],
    appendCheckLog: [],
  };
  const deps = {
    loadProfile: () => ({
      id: "jared",
      paths: {
        root: "/tmp/profiles/jared",
        applicationsTsv: "/tmp/profiles/jared/applications.tsv",
      },
      filterRules: {},
    }),
    loadSecrets: () => ({ NOTION_TOKEN: "tok" }),
    loadApplications: () => ({ apps: [fakeApp()] }),
    saveApplications: (file, apps) =>
      calls.saveApplications.push({ file, count: apps.length }),
    loadProcessed: () => ({ processed: [], last_check: null }),
    saveProcessed: (file, existing, entries, now) =>
      calls.saveProcessed.push({ file, count: entries.length, now }),
    computeCursorEpoch: () => 1700000000,
    loadContext: () => ({
      profileId: "jared",
      epoch: 1700000000,
      searchWindow: "after:1700000000",
      batches: [],
      activeJobsMap: { Affirm: [{ company: "Affirm", role: "Product Manager", status: "Applied", notion_id: "page-1", key: "greenhouse:1" }] },
      processedIds: [],
    }),
    saveContext: (file, ctx) => calls.saveContext.push({ file, ctx }),
    loadRawEmails: () => [],
    appendRecruiterLeads: (p, leads) => calls.appendRecruiterLeads.push({ p, leads }),
    appendRejectionLog: (p, rej) => calls.appendRejectionLog.push({ p, rej }),
    appendCheckLog: (p, opts) => calls.appendCheckLog.push({ p, opts }),
    buildSummary: () => "summary",
    makeClient: () => ({}),
    updatePageStatus: async (c, pageId, s) => {
      calls.updatePageStatus.push({ pageId, status: s });
      return { id: pageId };
    },
    addPageComment: async (c, pageId, text) => {
      calls.addPageComment.push({ pageId, text });
      return { id: "comment" };
    },
    now: () => new Date("2026-04-20T12:00:00Z"),
    ...overrides,
  };
  return { deps, calls };
}

function makeCtx(flags = {}) {
  const out = captureOut();
  return {
    out,
    ctx: {
      command: "check",
      profileId: "jared",
      flags: {
        dryRun: false,
        apply: false,
        verbose: false,
        prepare: false,
        since: "",
        ...flags,
      },
      env: {},
      stdout: out.stdout,
      stderr: out.stderr,
    },
  };
}

// ---------- buildActiveJobsMap ----------

test("buildActiveJobsMap: filters to active + notion_page_id set", () => {
  const apps = [
    fakeApp({ key: "a", status: "Applied", notion_page_id: "p1", companyName: "Acme" }),
    fakeApp({ key: "b", status: "Rejected", notion_page_id: "p2", companyName: "Acme" }),
    fakeApp({ key: "c", status: "Inbox", notion_page_id: "", companyName: "Acme" }),
    fakeApp({ key: "d", status: "Interview", notion_page_id: "p4", companyName: "Beta" }),
  ];
  const map = buildActiveJobsMap(apps);
  assert.deepEqual(Object.keys(map).sort(), ["Acme", "Beta"]);
  assert.equal(map.Acme.length, 1);
  assert.equal(map.Acme[0].notion_id, "p1");
  assert.equal(map.Beta.length, 1);
});

test("buildActiveJobsMap: excludes rows without notion_page_id", () => {
  const apps = [fakeApp({ notion_page_id: "", status: "Applied" })];
  assert.deepEqual(buildActiveJobsMap(apps), {});
});

// ---------- buildBatches ----------

test("buildBatches: chunks 10 companies, always appends LinkedIn + recruiter fixed batches", () => {
  const companies = [];
  for (let i = 0; i < 23; i++) companies.push(`Company${i}`);
  const batches = buildBatches(companies, "after:123");
  // 3 company batches (10+10+3) + 2 fixed
  assert.equal(batches.length, 5);
  assert.match(batches[3], /jobalerts-noreply@linkedin\.com/);
  assert.match(batches[4], /Requirement for/);
});

test("buildBatches: empty company list still returns the two fixed batches", () => {
  const batches = buildBatches([], "after:123");
  assert.equal(batches.length, 2);
  assert.match(batches[0], /jobalerts-noreply/);
  assert.match(batches[1], /Immediate need/);
});

// ---------- processLinkedIn ----------

function makeState(overrides = {}) {
  return {
    activeJobsMap: {},
    filterRules: {},
    tsvCache: [],
    newInboxRows: [],
    recruiterLeads: [],
    ...overrides,
  };
}

test("processLinkedIn: unparseable → skipped", () => {
  const row = processLinkedIn(
    { messageId: "m1", subject: "totally random" },
    { nowIso: "2026-04-20" },
    makeState()
  );
  assert.equal(row.type, "LINKEDIN_LEAD");
  assert.equal(row.action, "unparseable subject");
});

test("processLinkedIn: new parseable subject → Inbox row pushed", () => {
  const state = makeState();
  const row = processLinkedIn(
    { messageId: "m1", subject: "Product Manager at Acme" },
    { nowIso: "2026-04-20" },
    state
  );
  assert.equal(row.action, "→ Inbox");
  assert.equal(state.newInboxRows.length, 1);
  assert.equal(state.newInboxRows[0].companyName, "Acme");
  assert.equal(state.newInboxRows[0].status, "Inbox");
  assert.equal(state.newInboxRows[0].source, "linkedin");
});

test("processLinkedIn: duplicate against tsvCache", () => {
  const state = makeState({
    tsvCache: [{ companyName: "Acme", title: "Product Manager" }],
  });
  const row = processLinkedIn(
    { messageId: "m1", subject: "Product Manager at Acme" },
    { nowIso: "x" },
    state
  );
  assert.equal(row.action, "duplicate");
  assert.equal(state.newInboxRows.length, 0);
});

// ---------- processRecruiter ----------

test("processRecruiter: no role → unparseable", () => {
  const row = processRecruiter(
    { messageId: "m1", subject: "hey!" },
    { nowIso: "x" },
    makeState()
  );
  assert.equal(row.action, "unparseable role");
});

test("processRecruiter: role + no client → recruiter_leads", () => {
  const state = makeState();
  const row = processRecruiter(
    {
      messageId: "m1",
      subject: "Requirement for Senior PM",
      from: "jane@staffing.io",
      body: "hello",
      date: "2026-04-20T10:00:00Z",
    },
    { nowIso: "x" },
    state
  );
  assert.equal(row.action, "→ recruiter_leads.md");
  assert.equal(state.recruiterLeads.length, 1);
  assert.equal(state.recruiterLeads[0].role, "Senior PM");
});

test("processRecruiter: role + client → Inbox", () => {
  const state = makeState();
  const row = processRecruiter(
    {
      messageId: "m1",
      subject: "Requirement for Senior PM",
      from: "jane@staffing.io",
      body: "Our client: BigCorp, is hiring.",
    },
    { nowIso: "x" },
    state
  );
  assert.equal(row.action, "→ Inbox");
  assert.equal(state.newInboxRows[0].companyName, "BigCorp");
});

// ---------- processPipeline ----------

test("processPipeline: no company match → unmatched", () => {
  const res = processPipeline(
    { messageId: "m1", subject: "random", body: "" },
    { nowIso: "x" },
    makeState({ activeJobsMap: { Affirm: [{ company: "Affirm", role: "PM", status: "Applied", notion_id: "p1" }] } })
  );
  assert.equal(res.row.match, "NONE");
  assert.equal(res.action, undefined);
});

test("processPipeline: REJECTION → status+comment + rejection entry", () => {
  const res = processPipeline(
    {
      messageId: "m1",
      from: "no-reply@affirm.com",
      subject: "Update from Affirm",
      body: "unfortunately, we have decided not to proceed.",
    },
    { nowIso: "x" },
    makeState({
      activeJobsMap: {
        Affirm: [
          {
            company: "Affirm",
            role: "Senior PM",
            status: "Applied",
            notion_id: "p1",
            resume_version: "CV_Jared_Moore_Risk_Fraud",
            key: "greenhouse:1",
          },
        ],
      },
    })
  );
  assert.equal(res.row.type, "REJECTION");
  assert.equal(res.action.kind, "status+comment");
  assert.equal(res.action.newStatus, "Rejected");
  assert.ok(res.rejection);
  assert.equal(res.rejection.prevApplied, true);
  assert.equal(res.rejection.arch, "Risk_Fraud");
});

test("processPipeline: REJECTION skipped if already Rejected", () => {
  const res = processPipeline(
    {
      messageId: "m1",
      from: "no-reply@affirm.com",
      subject: "unfortunately...",
      body: "we have chosen another candidate",
    },
    { nowIso: "x" },
    makeState({
      activeJobsMap: {
        Affirm: [
          { company: "Affirm", role: "PM", status: "Rejected", notion_id: "p1", key: "k" },
        ],
      },
    })
  );
  assert.match(res.row.action, /Already Rejected, skipped/);
  assert.equal(res.action, undefined);
});

test("processPipeline: INTERVIEW_INVITE → Interview", () => {
  const res = processPipeline(
    {
      messageId: "m1",
      from: "recruiter@affirm.com",
      subject: "Interview with Affirm",
      body: "would like to schedule a call. calendly link inside.",
    },
    { nowIso: "x" },
    makeState({
      activeJobsMap: {
        Affirm: [{ company: "Affirm", role: "PM", status: "Applied", notion_id: "p1", key: "k" }],
      },
    })
  );
  assert.equal(res.row.type, "INTERVIEW_INVITE");
  assert.equal(res.action.newStatus, "Interview");
});

test("processPipeline: INFO_REQUEST → comment_only, no status", () => {
  const res = processPipeline(
    {
      messageId: "m1",
      from: "recruiter@affirm.com",
      subject: "Affirm assessment",
      body: "please complete the following coding challenge.",
    },
    { nowIso: "x" },
    makeState({
      activeJobsMap: {
        Affirm: [{ company: "Affirm", role: "PM", status: "Applied", notion_id: "p1", key: "k" }],
      },
    })
  );
  assert.equal(res.action.kind, "comment_only");
  assert.equal(res.action.newStatus, undefined);
});

test("processPipeline: LOW confidence → skipped, no action", () => {
  const res = processPipeline(
    {
      messageId: "m1",
      from: "no-reply@affirm.com",
      subject: "Update from Affirm",
      body: "unfortunately we won't be moving forward",
    },
    { nowIso: "x" },
    makeState({
      activeJobsMap: {
        Affirm: [
          { company: "Affirm", role: "Senior Product Manager, Growth", status: "Applied", notion_id: "p1", key: "k1" },
          { company: "Affirm", role: "Senior Product Manager, Risk", status: "Applied", notion_id: "p2", key: "k2" },
        ],
      },
    })
  );
  assert.equal(res.row.match, "LOW");
  assert.match(res.row.action, /LOW confidence/);
  assert.equal(res.action, undefined);
});

// ---------- Orchestration ----------

test("check --prepare: writes context + prints JSON", async () => {
  const { deps, calls } = makeDeps();
  const { ctx, out } = makeCtx({ prepare: true });
  const run = makeCheckCommand(deps);
  const code = await run(ctx);
  assert.equal(code, 0);
  assert.equal(calls.saveContext.length, 1);
  // last stdout line is JSON summary
  const last = out.lines[out.lines.length - 1];
  const parsed = JSON.parse(last);
  assert.equal(parsed.epoch, 1700000000);
  assert.equal(parsed.companyCount, 1);
  assert.ok(Array.isArray(parsed.batches));
});

test("check --prepare --dry-run: does NOT save context", async () => {
  const { deps, calls } = makeDeps();
  const { ctx } = makeCtx({ prepare: true, dryRun: true });
  const run = makeCheckCommand(deps);
  await run(ctx);
  assert.equal(calls.saveContext.length, 0);
});

test("check (apply phase) missing context → error", async () => {
  const { deps } = makeDeps({ loadContext: () => null });
  const { ctx, out } = makeCtx();
  const run = makeCheckCommand(deps);
  const code = await run(ctx);
  assert.equal(code, 1);
  assert.match(out.all(), /check_context\.json not found/);
});

test("check (apply phase) empty rawEmails → dry-run no-op with summary", async () => {
  const { deps, calls } = makeDeps({ loadRawEmails: () => [] });
  const { ctx, out } = makeCtx();
  const run = makeCheckCommand(deps);
  const code = await run(ctx);
  assert.equal(code, 0);
  // No apply without --apply flag → saveProcessed must NOT be called
  assert.equal(calls.saveProcessed.length, 0);
  const json = JSON.parse(out.lines[0]);
  assert.equal(json.emailsFound, 0);
});

test("check (apply phase, dry-run): prints plan, no mutation", async () => {
  const { deps, calls } = makeDeps({
    loadRawEmails: () => [
      {
        messageId: "m1",
        from: "no-reply@affirm.com",
        subject: "Update from Affirm",
        body: "unfortunately, we will not be proceeding.",
        date: "2026-04-20T10:00:00Z",
      },
    ],
  });
  const { ctx, out } = makeCtx();
  const run = makeCheckCommand(deps);
  const code = await run(ctx);
  assert.equal(code, 0);
  assert.equal(calls.updatePageStatus.length, 0);
  assert.equal(calls.addPageComment.length, 0);
  assert.equal(calls.saveApplications.length, 0);
  assert.equal(calls.saveProcessed.length, 0);
  const json = JSON.parse(out.lines[0]);
  assert.equal(json.actions, 1);
  assert.equal(json.plan[0].newStatus, "Rejected");
});

test("check --apply: calls Notion + saves TSV + processed + logs", async () => {
  const { deps, calls } = makeDeps({
    loadRawEmails: () => [
      {
        messageId: "m1",
        from: "no-reply@affirm.com",
        subject: "Update from Affirm",
        body: "unfortunately, we will not be proceeding.",
        date: "2026-04-20T10:00:00Z",
      },
    ],
  });
  const { ctx } = makeCtx({ apply: true });
  const run = makeCheckCommand(deps);
  const code = await run(ctx);
  assert.equal(code, 0);
  assert.equal(calls.updatePageStatus.length, 1);
  assert.equal(calls.updatePageStatus[0].status, "Rejected");
  assert.equal(calls.addPageComment.length, 1);
  assert.equal(calls.saveApplications.length, 1);
  assert.equal(calls.saveProcessed.length, 1);
  assert.equal(calls.appendRejectionLog.length, 1);
  assert.equal(calls.appendCheckLog.length, 1);
});

test("check --apply: idempotent on re-run with same raw_emails", async () => {
  // Simulate processedIds already containing m1
  const { deps, calls } = makeDeps({
    loadContext: () => ({
      profileId: "jared",
      epoch: 1,
      searchWindow: "after:1",
      batches: [],
      activeJobsMap: { Affirm: [{ company: "Affirm", role: "PM", status: "Applied", notion_id: "p1", key: "k" }] },
      processedIds: ["m1"],
    }),
    loadRawEmails: () => [
      {
        messageId: "m1",
        from: "no-reply@affirm.com",
        subject: "unfortunately",
        body: "not moving forward",
      },
    ],
  });
  const { ctx } = makeCtx({ apply: true });
  const run = makeCheckCommand(deps);
  const code = await run(ctx);
  assert.equal(code, 0);
  assert.equal(calls.updatePageStatus.length, 0);
  assert.equal(calls.addPageComment.length, 0);
});

test("check --apply: Notion error on one action — others still processed", async () => {
  let callIdx = 0;
  const { deps, calls } = makeDeps({
    loadContext: () => ({
      profileId: "jared",
      epoch: 1,
      searchWindow: "after:1",
      batches: [],
      activeJobsMap: {
        Affirm: [{ company: "Affirm", role: "PM", status: "Applied", notion_id: "p1", key: "k1" }],
        Block: [{ company: "Block", role: "PM", status: "Applied", notion_id: "p2", key: "k2" }],
      },
      processedIds: [],
    }),
    loadApplications: () => ({
      apps: [
        fakeApp({ key: "k1", companyName: "Affirm", title: "PM", notion_page_id: "p1" }),
        fakeApp({ key: "k2", companyName: "Block", title: "PM", notion_page_id: "p2" }),
      ],
    }),
    loadRawEmails: () => [
      { messageId: "m1", from: "@affirm.com", subject: "unfortunately", body: "not moving forward" },
      { messageId: "m2", from: "@block.xyz", subject: "unfortunately", body: "not moving forward" },
    ],
    updatePageStatus: async (c, pageId, s) => {
      callIdx += 1;
      if (callIdx === 1) throw new Error("rate limit");
      return { id: pageId };
    },
  });
  const { ctx, out } = makeCtx({ apply: true });
  const run = makeCheckCommand(deps);
  const code = await run(ctx);
  assert.equal(code, 1); // 1 = errors occurred
  // Both attempts were made
  // First failed at updatePageStatus (so comment was not called), second succeeded and called comment
  assert.equal(calls.addPageComment.length, 1);
  assert.match(out.all(), /rate limit/);
});
