const { test } = require("node:test");
const assert = require("node:assert/strict");

const L = require("./legacy_import.js");

const NOW = "2025-04-01T00:00:00.000Z";

function row(overrides = {}) {
  return {
    key: "greenhouse:1",
    source: "greenhouse",
    jobId: "1",
    companyName: "Acme",
    title: "Senior Product Manager, Growth",
    url: "https://example.com/1",
    locations: [],
    status: "To Apply",
    notion_page_id: "",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    applied_date: "",
    ...overrides,
  };
}

function msg(overrides = {}) {
  return {
    messageId: overrides.messageId || `<${Math.random()}@example.test>`,
    from: "Acme <no-reply@us.greenhouse-mail.io>",
    subject: "Thank you for applying to Acme!",
    body: "We received your application for Senior Product Manager, Growth, and we are delighted.",
    date: "2025-03-03T16:04:11.000Z",
    ...overrides,
  };
}

// ---------- extraction: common ATS formats ----------

const EXTRACT_CASES = [
  {
    name: "Greenhouse ack (company in subject, title in body)",
    in: {
      from: "Acme <no-reply@us.greenhouse-mail.io>",
      subject: "Thank you for applying to Acme!",
      body: "Thank you for your interest in Acme! We wanted to let you know we received your application for Senior Product Manager, Growth, and we are delighted that you would consider joining our team.",
    },
    company: "Acme",
    title: "Senior Product Manager, Growth",
  },
  {
    name: "Lever ack (title + company in body)",
    in: {
      from: "Globex <no-reply@hire.lever.co>",
      subject: "Thank you for your application to Globex",
      body: "Thank you for applying for the Sr. Product Manager - Payments position at Globex. We have received your application.",
    },
    company: "Globex",
    title: "Sr Product Manager - Payments",
  },
  {
    name: "Ashby ack",
    in: {
      from: "Initech Hiring Team <no-reply@ashbyhq.com>",
      subject: "Thanks for applying to Initech!",
      body: "Thank you for applying for the Product Manager, Checkout role at Initech.",
    },
    company: "Initech",
    title: "Product Manager, Checkout",
  },
  {
    name: "Workday ack (title in subject with req id, company from tenant sender)",
    in: {
      from: "umbrella@myworkday.com",
      subject: "Application Received for Senior Product Manager - R12345",
      body: "Thank you for applying to the Senior Product Manager position.",
    },
    company: "Umbrella",
    title: "Senior Product Manager",
  },
  {
    name: "iCIMS ack (Company: Application Received - Title)",
    in: {
      from: "Hooli Careers <hooli@icims.com>",
      subject: "Hooli: Application Received - Group Product Manager",
      body: "We have received your application.",
    },
    company: "Hooli",
    title: "Group Product Manager",
  },
  {
    name: "SmartRecruiters ack (Title at Company in subject)",
    in: {
      from: "Vandelay Industries <noreply@smartrecruiters.com>",
      subject: "Your application for Lead Product Manager at Vandelay Industries",
      body: "We received your application.",
    },
    company: "Vandelay Industries",
    title: "Lead Product Manager",
  },
  {
    name: "Interview subject (Title at Company)",
    in: {
      from: "Initech <no-reply@ashbyhq.com>",
      subject: "Interview invitation: Product Manager, Checkout at Initech",
      body: "We would like to schedule an interview.",
    },
    company: "Initech",
    title: "Product Manager, Checkout",
  },
  {
    name: "Labelled body fields",
    in: {
      from: "no-reply@hire.lever.co",
      subject: "Application confirmation",
      body: "Thanks for applying.\nCompany: Soylent\nJob Title: Product Lead\n",
    },
    company: "Soylent",
    title: "Product Lead",
  },
  {
    name: "Corporate sender domain fallback",
    in: {
      from: "Careers <careers@soylent.com>",
      subject: "Thank you for applying",
      body: "We have received your application for the Product Lead role.",
    },
    company: "Soylent",
    title: "Product Lead",
  },
];

for (const c of EXTRACT_CASES) {
  test(`extractCompanyTitle: ${c.name}`, () => {
    const r = L.extractCompanyTitle(c.in);
    assert.equal(r.company, c.company);
    assert.equal(r.title, c.title);
  });
}

test("extractCompanyTitle: generic sender + no details → nulls", () => {
  const r = L.extractCompanyTitle({
    from: "no-reply@hire.lever.co",
    subject: "Thanks for applying",
    body: "Thanks for applying. We will be in touch.",
  });
  assert.equal(r.company, null);
  assert.equal(r.title, null);
});

test("extractCompanyTitle: a job title is never taken as the company", () => {
  const r = L.extractCompanyTitle({
    from: '"Talent Acquisition" <noreply@smartrecruiters.com>',
    subject: "Thank you for your interest",
    body: "Thank you for your interest in Senior Product Manager.",
  });
  assert.equal(r.company, null);
});

test("looseTitle folds Sr / dashes / commas", () => {
  assert.equal(
    L.looseTitle("Sr. Product Manager - Growth"),
    L.looseTitle("Senior Product Manager, Growth")
  );
});

// ---------- classification reuse ----------

test("classifyMessage maps the tracking classifier to ledger events", () => {
  assert.equal(L.classifyMessage(msg()).event, "Applied");
  assert.equal(
    L.classifyMessage(msg({ body: "Unfortunately we have decided not to move forward." })).event,
    "Rejected"
  );
  assert.equal(
    L.classifyMessage(msg({ subject: "Hi", body: "We would like to schedule an interview." }))
      .event,
    "Interview"
  );
  assert.equal(
    L.classifyMessage(msg({ subject: "Hi", body: "The position is now closed." })).event,
    "Closed"
  );
  assert.equal(L.classifyMessage(msg({ subject: "Hi", body: "Newsletter" })).event, null);
});

test("classifyMessage drops job-alert digests before classifying", () => {
  const r = L.classifyMessage(
    msg({ from: "Indeed <donotreply@match.indeed.com>", subject: "PM + 12 more new jobs" })
  );
  assert.equal(r.filtered, true);
  assert.equal(r.event, null);
});

// ---------- status merge ----------

test("decideStatus: never downgrades Interview / Offer; Applied moves only forward", () => {
  assert.equal(L.decideStatus("Interview", "Applied"), "Interview");
  assert.equal(L.decideStatus("Interview", "Rejected"), "Interview");
  assert.equal(L.decideStatus("Offer", "Rejected"), "Offer");
  assert.equal(L.decideStatus("Rejected", "Interview"), "Rejected");
  assert.equal(L.decideStatus("Applied", "Applied"), "Applied");
  assert.equal(L.decideStatus("Applied", "Rejected"), "Rejected");
  assert.equal(L.decideStatus("No Response", "Applied"), "No Response");
  assert.equal(L.decideStatus("No Response", "Interview"), "Interview");
  assert.equal(L.decideStatus("To Apply", "Applied"), "Applied");
  assert.equal(L.decideStatus("Inbox", "Rejected"), "Rejected");
  assert.equal(L.decideStatus("Archived", "Applied"), "Applied");
});

test("computePatch: fills provenance only when empty, keeps the earliest applied_date", () => {
  const p = L.computePatch(row(), { status: "Applied", appliedDate: "2025-03-03" });
  assert.deepEqual(p, {
    status: "Applied",
    applied_date: "2025-03-03",
    applied_by: "legacy_bot",
    apply_state: "submitted",
    apply_note: "zoho:2025-03-03",
  });
  const manual = row({
    status: "Applied",
    applied_date: "2025-03-01",
    applied_by: "manual",
    apply_state: "manual",
  });
  assert.deepEqual(L.computePatch(manual, { status: "Applied", appliedDate: "2025-03-03" }), {});
  const later = row({ status: "Applied", applied_date: "2025-03-10", applied_by: "legacy_bot" });
  assert.deepEqual(L.computePatch(later, { status: "Applied", appliedDate: "2025-03-03" }), {
    applied_date: "2025-03-03",
  });
});

test("summarizeEvents: earliest ack date, latest non-ack status", () => {
  const s = L.summarizeEvents([
    { date: "2025-03-24", event: "Rejected", subject: "r" },
    { date: "2025-03-03", event: "Applied", subject: "a" },
    { date: "2025-03-10", event: "Interview", subject: "i" },
  ]);
  assert.equal(s.appliedDate, "2025-03-03");
  assert.equal(s.status, "Rejected");
  assert.equal(s.events[0].date, "2025-03-03");
});

// ---------- plan ----------

test("buildPlan: matches an existing row by company + normalized title", () => {
  const apps = [row({ title: "Senior Product Manager - Growth", notion_page_id: "page-1" })];
  const plan = L.buildPlan(apps, [msg()], { now: NOW });
  assert.equal(plan.stats.matchedRows, 1);
  assert.equal(plan.stats.newRows, 0);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].key, "greenhouse:1");
  assert.equal(plan.updates[0].patch.status, "Applied");
  assert.equal(plan.updates[0].patch.applied_date, "2025-03-03");
  assert.equal(plan.stats.notionLinkedUpdates, 1);
});

test("buildPlan: unmatched application → new legacy_bot row with stable synthetic id", () => {
  const plan = L.buildPlan([], [msg()], { now: NOW });
  assert.equal(plan.appends.length, 1);
  const a = plan.appends[0];
  assert.equal(a.source, "legacy_bot");
  assert.equal(a.companyName, "Acme");
  assert.equal(a.title, "Senior Product Manager, Growth");
  assert.equal(a.url, "");
  assert.equal(a.jobId, L.syntheticJobId("Acme", "Sr. Product Manager - Growth"));
  assert.equal(a.key, `legacy_bot:${a.jobId}`);
  assert.equal(a.summary.status, "Applied");
});

test("buildPlan: later rejection wins over the ack; title-less rejection attaches by company", () => {
  const plan = L.buildPlan(
    [],
    [
      msg({ messageId: "a" }),
      msg({
        messageId: "b",
        subject: "Update on your application",
        body: "Unfortunately, we have decided not to move forward.",
        date: "2025-03-24T00:00:00.000Z",
      }),
    ],
    { now: NOW }
  );
  assert.equal(plan.appends.length, 1);
  assert.equal(plan.appends[0].summary.status, "Rejected");
  assert.equal(plan.appends[0].summary.appliedDate, "2025-03-03");
  assert.equal(plan.unparseable.length, 0);
});

test("buildPlan: title-less ack with no anchor is unparseable (subject + date only)", () => {
  const plan = L.buildPlan(
    [],
    [
      msg({
        from: "no-reply@hire.lever.co",
        subject: "Thanks for applying",
        body: "Thanks for applying. We will be in touch.",
      }),
    ],
    { now: NOW }
  );
  assert.equal(plan.appends.length, 0);
  assert.deepEqual(Object.keys(plan.unparseable[0]).sort(), ["date", "event", "reason", "subject"]);
  assert.equal(plan.unparseable[0].subject, "Thanks for applying");
  assert.equal(plan.unparseable[0].date, "2025-03-03");
});

test("buildPlan: --since drops older messages, duplicate Message-IDs are counted once", () => {
  const plan = L.buildPlan(
    [],
    [msg({ messageId: "x" }), msg({ messageId: "x" }), msg({ messageId: "y", date: "2024-12-01" })],
    { since: "2025-01-01", now: NOW }
  );
  assert.equal(plan.stats.scanned, 3);
  assert.equal(plan.stats.duplicates, 1);
  assert.equal(plan.stats.outOfRange, 1);
  assert.equal(plan.stats.classified.Applied, 1);
});

test("buildPlan: company_aliases map a brand to the parent's TSV row", () => {
  const apps = [row({ companyName: "Acme Holdings" })];
  const plan = L.buildPlan(apps, [msg()], {
    companyAliases: { "Acme Holdings": ["Acme"] },
    now: NOW,
  });
  assert.equal(plan.stats.matchedRows, 1);
  assert.equal(plan.appends.length, 0);
});

test("buildPlan: Interview row is never downgraded; already-imported row is unchanged", () => {
  const apps = [row({ status: "Interview", applied_date: "2025-03-03", applied_by: "legacy_bot" })];
  const plan = L.buildPlan(apps, [msg()], { now: NOW });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.stats.unchanged, 1);
});

// ---------- apply ----------

test("applyPlan: updates rows, appends through appendNew, is idempotent", () => {
  const apps = [row()];
  const messages = [
    msg({ messageId: "1" }),
    msg({
      messageId: "2",
      from: "Globex <no-reply@hire.lever.co>",
      subject: "Thank you for your application to Globex",
      body: "Thank you for applying for the Product Manager position at Globex.",
      date: "2025-03-04T00:00:00.000Z",
    }),
  ];
  const plan = L.buildPlan(apps, messages, { now: NOW });
  const res = L.applyPlan(apps, plan, { now: NOW });
  assert.equal(res.updated, 1);
  assert.equal(res.appended, 1);
  const acme = res.apps.find((r) => r.key === "greenhouse:1");
  assert.equal(acme.status, "Applied");
  assert.equal(acme.applied_date, "2025-03-03");
  assert.equal(acme.applied_by, "legacy_bot");
  assert.equal(acme.apply_state, "submitted");
  assert.equal(acme.updatedAt, NOW);
  const globex = res.apps.find((r) => r.source === "legacy_bot");
  assert.equal(globex.companyName, "Globex");
  assert.equal(globex.status, "Applied");
  assert.equal(globex.applied_date, "2025-03-04");
  assert.equal(globex.applied_by, "legacy_bot");
  assert.equal(globex.apply_note, "zoho:2025-03-04");
  // input rows are not mutated
  assert.equal(apps[0].status, "To Apply");

  const plan2 = L.buildPlan(res.apps, messages, { now: NOW });
  assert.equal(plan2.appends.length, 0);
  assert.equal(plan2.updates.length, 0);
  const res2 = L.applyPlan(res.apps, plan, { now: NOW });
  assert.equal(res2.appended, 0);
  assert.equal(res2.updated, 0);
  assert.equal(res2.apps.length, res.apps.length);
});

test("applyPlan: re-checks guards against the current row", () => {
  const apps = [row()];
  const plan = L.buildPlan(apps, [msg()], { now: NOW });
  // Between dry-run and apply the row moved to Interview.
  const moved = [row({ status: "Interview" })];
  const res = L.applyPlan(moved, plan, { now: NOW });
  assert.equal(res.apps[0].status, "Interview");
  assert.equal(res.apps[0].applied_by, "legacy_bot");
});

test("applyPlan: fuzzy duplicate of an existing row folds into it instead of appending", () => {
  const plan = L.buildPlan([], [msg()], { now: NOW });
  const apps = [row({ title: "Senior Product Manager, Growth" })];
  const res = L.applyPlan(apps, plan, { now: NOW });
  assert.equal(res.appended, 0);
  assert.equal(res.apps.length, 1);
  assert.equal(res.apps[0].status, "Applied");
});

// ---------- mbox ----------

test("splitMbox: splits on envelope lines and unquotes >From", () => {
  const text = [
    "From a@b Mon Mar 03 16:04:11 +0000 2025",
    "Subject: one",
    "",
    "body one",
    ">From here",
    "",
    "From c@d Tue Mar 04 16:04:11 +0000 2025",
    "Subject: two",
    "",
    "From the team (not a separator)",
    "",
  ].join("\n");
  const parts = L.splitMbox(text);
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^Subject: one/);
  assert.match(parts[0], /\nFrom here/);
  assert.match(parts[1], /From the team/);
});

test("formatReport lists counts and unparseable subjects, never bodies", () => {
  const plan = L.buildPlan(
    [],
    [
      msg(),
      msg({
        messageId: "z",
        from: "no-reply@hire.lever.co",
        subject: "Thanks for applying",
        body: "SECRET BODY TEXT. Thanks for applying.",
      }),
    ],
    { now: NOW }
  );
  const out = L.formatReport(plan, { source: "mbox:x", planPath: "/tmp/plan.json" });
  assert.match(out, /messages scanned: 2/);
  assert.match(out, /new rows: 1/);
  assert.match(out, /Thanks for applying/);
  assert.doesNotMatch(out, /SECRET BODY/);
});
