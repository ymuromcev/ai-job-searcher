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

// ---------- BL-225 follow-up: cleaning, sender noise, fragments ----------

test("decodeEntities / plainText clean HTML leaking into text parts", () => {
  assert.equal(
    L.decodeEntities("Manager&nbsp;opportunity &amp; more &#39;x&#x27;"),
    "Manager opportunity & more 'x'"
  );
  assert.equal(
    L.plainText("<p>Hello&nbsp;Pat,</p><p>Thanks for applying</p>"),
    "Hello Pat,\nThanks for applying"
  );
  assert.equal(L.plainText("", "<div>A<br>B</div><style>x{}</style>"), "A\nB");
});

test("validCompany strips sender noise and rejects ATS / support names", () => {
  assert.equal(L.validCompany("Workday Support"), null);
  assert.equal(L.validCompany("DoNotReply-WorkdayNotifications Carrier"), "Carrier");
  assert.equal(L.validCompany("Group 1001 Talent Acquisition"), "Group 1001");
  assert.equal(L.validCompany("Acme Careers"), "Acme");
  assert.equal(L.validCompany("Globex Recruiting Team"), "Globex");
});

test("validTitle rejects sentence fragments, keeps real titles", () => {
  assert.equal(L.validTitle("CrowdStrike, and we wish you success in your"), null);
  assert.equal(L.validTitle("open"), null);
  assert.equal(
    L.validTitle("Product Manager (Remote)&nbsp;opportunity"),
    "Product Manager (Remote)"
  );
  assert.equal(L.validTitle("Senior Product Manager, Growth"), "Senior Product Manager, Growth");
});

test("extractCompanyTitle: sender noise never becomes the company", () => {
  const r = L.extractCompanyTitle({
    from: '"Workday Support" <support@myworkday.com>',
    subject: "Thank you for applying",
    body: "Thank you for applying. We received your application for Product Manager.",
  });
  assert.equal(r.company, null);
  assert.equal(r.title, "Product Manager");
});

test("exportRecord: stable id, folder, classifier status, capped clean excerpt", () => {
  const m = msg({
    messageId: "<abc@example.test>",
    folder: "Rejections",
    fromName: "Acme",
    fromAddress: "no-reply@us.greenhouse-mail.io",
    to: "pat@example.com",
    body: `<p>We received your application&nbsp;for PM.</p>${"x".repeat(3000)}`,
  });
  const r = L.exportRecord(m);
  assert.equal(r.id, L.messageKey(m));
  assert.equal(r.id, L.exportRecord({ ...m, subject: "changed" }).id);
  assert.equal(r.folder, "Rejections");
  assert.equal(r.status, "Applied");
  assert.equal(r.date, "2025-03-03");
  assert.deepEqual(r.from, { name: "Acme", address: "no-reply@us.greenhouse-mail.io" });
  assert.equal(r.excerpt.length, 1500);
  assert.doesNotMatch(r.excerpt, /<p>|&nbsp;/);
});

test("buildPlan: new rows carry status / applied_date / provenance at top level", () => {
  const plan = L.buildPlan([], [msg()], { now: NOW });
  const a = plan.appends[0];
  assert.equal(a.status, "Applied");
  assert.equal(a.applied_date, "2025-03-03");
  assert.equal(a.applied_by, "legacy_bot");
  assert.equal(a.apply_state, "submitted");
  assert.equal(a.apply_note, "zoho:2025-03-03");
});

// ---------- --extracted ----------

function rec(id, company, title, status, date, extra = {}) {
  return { id, company, title, status, date, ...extra };
}

test("buildPlanFromExtracted: dedupes to one row per application, latest terminal status", () => {
  const plan = L.buildPlanFromExtracted(
    [],
    [
      rec("1", "Acme", "Senior PM", "Applied", "2025-03-03"),
      rec("2", "Acme", "Sr. PM", "Applied", "2025-03-01"),
      rec("3", "ACME Inc.", "Senior PM", "Rejected", "2025-03-20"),
      rec("4", "Globex", "PM", "Interview", "2025-03-10"),
      rec("5", "x", "", "Ignore", "2025-03-10"),
      rec("6", "", "", "Bogus", "2025-03-10"),
      rec("1", "Acme", "Senior PM", "Applied", "2025-03-03"),
    ],
    { now: NOW }
  );
  assert.equal(plan.stats.duplicates, 1);
  assert.equal(plan.stats.ignored, 1);
  assert.equal(plan.stats.unparseable, 1);
  assert.equal(plan.appends.length, 2);
  const acme = plan.appends.find((a) => a.companyName !== "Globex");
  assert.equal(acme.status, "Rejected");
  assert.equal(acme.applied_date, "2025-03-01");
});

test("buildPlanFromExtracted: title-less ack attaches to the company's single titled row", () => {
  const plan = L.buildPlanFromExtracted(
    [],
    [
      rec("1", "Acme", "Senior PM", "Applied", "2025-03-03"),
      rec("2", "Acme", "", "Rejected", "2025-03-20"),
      rec("3", "Globex", "", "Applied", "2025-03-04"),
      rec("4", "Globex", "", "Applied", "2025-03-02"),
    ],
    { now: NOW }
  );
  assert.equal(plan.appends.length, 2);
  assert.equal(plan.appends.find((a) => a.companyName === "Acme").status, "Rejected");
  const globex = plan.appends.find((a) => a.companyName === "Globex");
  assert.equal(globex.title, "");
  assert.equal(globex.applied_date, "2025-03-02");
  assert.equal(plan.stats.companyOnlyRows, 1);
});

test("buildPlanFromExtracted: account mails count only for companies nothing else names", () => {
  const apps = [row({ companyName: "Hooli", title: "PM", status: "Applied", key: "gh:9" })];
  const plan = L.buildPlanFromExtracted(
    apps,
    [
      rec("1", "Acme", "Senior PM", "Applied", "2025-03-03"),
      rec("2", "Acme", "", "Account", "2025-03-02"),
      rec("3", "Hooli", "", "Account", "2025-03-02"),
      rec("4", "Initech", "", "Account", "2025-03-05"),
      rec("5", "Initech", "", "Account", "2025-03-04"),
    ],
    { now: NOW }
  );
  assert.equal(plan.stats.accountIgnored, 2);
  assert.equal(plan.stats.accountRows, 1);
  const initech = plan.appends.find((a) => a.companyName === "Initech");
  assert.equal(initech.status, "Applied");
  assert.equal(initech.applied_date, "2025-03-04");
  assert.equal(initech.apply_note, "account:2025-03-04");
});

test("buildPlanFromExtracted + applyPlan: company-only rows append and are idempotent", () => {
  const records = [rec("1", "Globex", "", "Applied", "2025-03-04")];
  const plan = L.buildPlanFromExtracted([], records, { now: NOW });
  const res = L.applyPlan([], plan, { now: NOW });
  assert.equal(res.appended, 1);
  assert.equal(res.apps[0].title, "");
  assert.equal(res.apps[0].status, "Applied");
  const plan2 = L.buildPlanFromExtracted(res.apps, records, { now: NOW });
  assert.equal(plan2.appends.length, 0);
  assert.equal(plan2.stats.matchedRows, 1);
});

// ---------- templateExtract (deterministic templates over export records) ----------

function exp(overrides = {}) {
  return {
    id: "abc",
    date: "2025-03-03T10:00:00.000Z",
    from: { name: "", address: "no-reply@us.greenhouse-mail.io" },
    to: "candidate@example.test",
    folder: "Notification",
    subject: "Thank you for applying to Acme!",
    status: "Applied",
    calendar: false,
    excerpt: "Hi Pat, Thanks for applying to Acme. Your application has been received.",
    ...overrides,
  };
}

test("templateExtract: subject template → Applied with company", () => {
  const d = L.templateExtract(exp());
  assert.equal(d.status, "Applied");
  assert.equal(d.company, "Acme");
  assert.equal(d.rule, "subject");
});

test("templateExtract: security code / workday account mails are Account signals", () => {
  const sec = L.templateExtract(
    exp({ subject: "Security code for your application to Initech", status: "Other" })
  );
  assert.deepEqual([sec.status, sec.company], ["Account", "Initech"]);
  const wd = L.templateExtract(
    exp({
      folder: "Verifications",
      subject: "Verify your candidate account",
      status: "Other",
      from: { name: "", address: "hooli@otp.workday.com" },
      excerpt: "Click this link https://hooli.wd5.myworkdayjobs.com/careers/activate/x",
    })
  );
  assert.deepEqual([wd.status, wd.company], ["Account", "Hooli"]);
});

test("templateExtract: filtered / LinkedIn notifications / newsletters → Ignore", () => {
  assert.equal(L.templateExtract(exp({ status: "Filtered" })).status, "Ignore");
  assert.equal(
    L.templateExtract(exp({ folder: "LinkedIn", subject: "You have 1 new invitation" })).status,
    "Ignore"
  );
  assert.equal(L.templateExtract(exp({ folder: "Newsletter", status: "Other" })).status, "Ignore");
});

test("templateExtract: interview claims and sent mail go to review (null)", () => {
  assert.equal(L.templateExtract(exp({ status: "Interview" })), null);
  assert.equal(L.templateExtract(exp({ folder: "Sent" })), null);
});

test("templateExtract: an acknowledgement's hedge is not a rejection", () => {
  const d = L.templateExtract(
    exp({
      status: "Rejected",
      excerpt:
        "Hi Pat, Thank you for your interest in Acme. What happens next? We may not be able to respond if there is not a match for this role.",
    })
  );
  assert.equal(d.status, "Applied");
});

test("templateExtract: explicit rejection / filled wording overrides the classifier", () => {
  const rej = L.templateExtract(
    exp({
      excerpt:
        "Hi Pat, Thank you for applying. We have decided to move forward with other candidates.",
    })
  );
  assert.equal(rej.status, "Rejected");
  const closed = L.templateExtract(
    exp({ status: "Rejected", excerpt: "Hi Pat, the Senior PM position has been filled." })
  );
  assert.equal(closed.status, "Closed");
});

test("templateExtract: greeted name and subject filler never become the company", () => {
  const greeted = L.templateExtract(
    exp({
      subject: "Pat, we have received your application",
      from: { name: "", address: "hooli@myworkday.com" },
      excerpt: "Hello Pat Thank you for applying for the Senior Product Owner position.",
    })
  );
  assert.equal(greeted.company, "Hooli");
  const filler = L.templateExtract(
    exp({
      subject: "Thanks for Applying – Stay Tuned!",
      excerpt: "Hi Pat, Thanks for your interest!",
    })
  );
  assert.equal(filler, null);
});

test("templateExtract: a recruiter's own name falls back to the sender domain", () => {
  const d = L.templateExtract(
    exp({
      subject: "Regret to inform",
      status: "Rejected",
      folder: "Rejections",
      from: { name: "Pat Lee", address: "plee@initech.com" },
      excerpt: "Hi Sam, Unfortunately we decided not to move forward.",
    })
  );
  assert.equal(d.company, "Initech");
});

test("templateExtract: strips the company possessive from a title", () => {
  const d = L.templateExtract(
    exp({
      excerpt: "Hi Pat, Thank you for applying for Acme's Senior Product Manager, Growth role.",
    })
  );
  assert.equal(d.company, "Acme");
  assert.ok(!/Acme/.test(d.title || ""));
});

test("companyFromSubject: drops 'was received' tails and keeps lowercase-led brands", () => {
  assert.equal(
    L.companyFromSubject("Your application to Acme Labs was received").company,
    "Acme Labs"
  );
  assert.equal(L.companyFromSubject("Thank you for applying to refurbed").company, "refurbed");
});

test("workdayTenant: activation URL, tenant sender, myworkday@ corporate sender", () => {
  assert.equal(L.workdayTenant({ excerpt: "https://acme.wd1.myworkdayjobs.com/x" }), "acme");
  assert.equal(L.workdayTenant({ excerpt: "", from: { address: "hooli@myworkday.com" } }), "hooli");
  assert.equal(
    L.workdayTenant({ excerpt: "", from: { address: "myworkday@initech.com" } }),
    "initech"
  );
  assert.equal(L.workdayTenant({ excerpt: "", from: { address: "pat@example.com" } }), null);
});

test("validCompany: loose mode accepts lowercase brands but not lowercase prose", () => {
  assert.equal(L.validCompany("refurbed", { loose: true }), "refurbed");
  assert.equal(L.validCompany("refurbed"), null);
  assert.equal(L.validCompany("the team", { loose: true }), null);
});

test("validTitle: strips prose wrapped around a title", () => {
  assert.equal(L.validTitle("Acme and the Senior Product Manager"), "Senior Product Manager");
  assert.equal(L.validTitle("Staff Product Manager role here"), "Staff Product Manager");
  assert.equal(L.validTitle("for the Product Designer"), "Product Designer");
  assert.equal(L.validTitle("Acme for the"), null);
});

test("summarizeEvents: same-day terminal answer wins over the invite", () => {
  const s = L.summarizeEvents([
    { date: "2025-03-05", event: "Closed", subject: "b" },
    { date: "2025-03-05", event: "Interview", subject: "a" },
    { date: "2025-03-01", event: "Applied", subject: "c" },
  ]);
  assert.equal(s.status, "Closed");
  assert.equal(s.appliedDate, "2025-03-01");
});
