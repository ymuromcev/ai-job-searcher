// `questions` tests — real temp profile on disk, fake Notion (no network).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const applications = require("../core/applications_tsv.js");
const { makeQuestionsCommand, planPush, viewUrl } = require("./questions.js");

const S = { waiting: "Waiting for answer", answered: "Answered", skip: "Skip such jobs" };

function defaults(extra = {}) {
  return {
    work_authorization: { authorized_us: true, requires_sponsorship: false, status_text: "PR" },
    relocation: { willing: false },
    eeo: { policy: "decline" },
    salary: { floor: 100000, default: 150000, currency: "USD" },
    how_did_you_hear_default: "Company careers page",
    ...extra,
  };
}

function row(key, over = {}) {
  return {
    key,
    source: "greenhouse",
    jobId: key,
    companyName: `Co${key}`,
    title: "Product Manager",
    url: `https://job-boards.greenhouse.io/co${key}/jobs/${key}`,
    status: "To Apply",
    fit_score: "Strong",
    apply_state: "skipped",
    apply_note: "no_honest_answer: Q?",
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-09T00:00:00.000Z",
    ...over,
  };
}

function setup({ apps, entries = [], ad = defaults(), token = "t", notion = true, over = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aijs-questions-"));
  const profilesDir = path.join(root, "profiles");
  const dir = path.join(profilesDir, "demo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "profile.json"),
    JSON.stringify({ id: "demo", notion: notion ? { application_qa_db_id: "db-1" } : {} })
  );
  if (ad) fs.writeFileSync(path.join(dir, "apply_defaults.json"), JSON.stringify(ad, null, 2));
  const tsv = path.join(dir, "applications.tsv");
  applications.save(tsv, apps);
  const notionCalls = [];
  const deps = {
    loadSecrets: () => (token ? { NOTION_TOKEN: token } : {}),
    makeNotionClient: () => ({ fake: true }),
    fetchAllAnswers: async () => entries,
    ensurePendingSchema: async () => {
      notionCalls.push(["schema"]);
      return { changed: ["Status"] };
    },
    createPendingPage: async (client, dbId, fields) => {
      notionCalls.push(["create", fields]);
      return { id: `new-${notionCalls.length}` };
    },
    updatePendingPage: async (client, pageId, fields) => {
      notionCalls.push(["update", pageId, fields]);
      return { id: pageId };
    },
    today: () => "2026-11-10",
    now: () => new Date("2026-11-10T12:00:00.000Z"),
    ...over,
  };
  const cmd = makeQuestionsCommand(deps);
  const run = async (flags = {}) => {
    const out = [];
    const err = [];
    const code = await cmd({
      profileId: "demo",
      profilesDir,
      env: {},
      flags,
      stdout: (s) => out.push(String(s)),
      stderr: (s) => err.push(String(s)),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const read = () => applications.load(tsv).apps;
  const byKey = () => new Map(read().map((a) => [a.key, a]));
  const readAd = () => JSON.parse(fs.readFileSync(path.join(dir, "apply_defaults.json"), "utf8"));
  const statePath = path.join(dir, ".apply-state", "questions.json");
  return { dir, tsv, run, read, byKey, readAd, statePath, notionCalls };
}

function scenario() {
  const apps = [
    // Answered in Notion tonight → requeue.
    row("a", { apply_note: "no_honest_answer: Do you have a valid driver's license?" }),
    // Owner said "skip such jobs".
    row("b", { apply_note: "no_honest_answer: Will you work 5 days a week in the office?" }),
    // Still waiting; already in Notion with an older job list.
    row("c", { apply_note: "no_honest_answer: Why do you want to work at Coc?" }),
    // Same question for another company, plus a bot check (never pushed).
    row("d", {
      apply_note: "no_honest_answer: Why do you want to work at Cod?; Are you a veteran?",
    }),
    row("e", { apply_note: "no_honest_answer: Please confirm you are not a robot" }),
    // Ashby: never collected, never requeued.
    row("f", { url: "https://jobs.ashbyhq.com/cof/f", apply_note: "no_honest_answer: Visa?" }),
    // Not a no_honest_answer skip.
    row("g", { apply_note: "captcha" }),
  ];
  const entries = [
    {
      pageId: "p-lic",
      question: "Do you have a valid driver's license?",
      answer: "Yes",
      status: S.answered,
    },
    {
      pageId: "p-office",
      question: "Will you work 5 days a week in the office?",
      answer: "",
      status: S.skip,
    },
    {
      pageId: "p-why",
      question: "Why do you want to work at <company>?",
      answer: "",
      status: S.waiting,
      questionKey: "why do you want to work at xcompanyx",
      jobs: "Coc — Product Manager — https://old",
    },
    { pageId: "p-bank", question: "Why us?", answer: "Bank answer", status: null },
  ];
  return { apps, entries };
}

test("dry run: prints the plan, writes nothing", async () => {
  const { apps, entries } = scenario();
  const t = setup({ apps, entries });
  const before = fs.readFileSync(t.tsv, "utf8");
  const adBefore = t.readAd();
  const r = await t.run();
  assert.equal(r.code, 0);
  assert.match(r.out, /pull — 1 answer\(s\) \(1 new\), 1 skip rule\(s\)/);
  assert.match(r.out, /requeue — 1 row\(s\) back to the queue, 1 kept by a skip rule/);
  assert.match(r.out, /push — 2 open question\(s\): 1 new, 1 updated/);
  assert.match(r.out, /dry-run: nothing written/);
  assert.equal(fs.readFileSync(t.tsv, "utf8"), before);
  assert.deepEqual(t.readAd(), adBefore);
  assert.equal(fs.existsSync(t.statePath), false);
  assert.deepEqual(t.notionCalls, []);
});

test("--apply: pull → requeue → push, state file for the morning report", async () => {
  const { apps, entries } = scenario();
  const t = setup({ apps, entries });
  const r = await t.run({ apply: true });
  assert.equal(r.code, 0, r.err);

  const ad = t.readAd();
  assert.deepEqual(ad.standing_answers, [
    { question: "Do you have a valid driver's license?", answer: "Yes", notion_page_id: "p-lic" },
  ]);
  assert.deepEqual(ad.skip_questions, [
    { question: "Will you work 5 days a week in the office?", notion_page_id: "p-office" },
  ]);
  assert.equal(ad.salary.floor, 100000);

  const rows = t.byKey();
  assert.equal(rows.get("a").apply_state, "queued");
  assert.equal(rows.get("a").apply_note, "requeued:2026-11-10 answers");
  assert.equal(rows.get("b").apply_state, "skipped");
  assert.equal(
    rows.get("b").apply_note,
    "no_honest_answer: owner_skip: Will you work 5 days a week in the office?"
  );
  assert.equal(rows.get("c").apply_state, "skipped");
  assert.equal(rows.get("f").apply_note, "no_honest_answer: Visa?");
  assert.equal(rows.get("g").apply_note, "captcha");

  const kinds = t.notionCalls.map((c) => c[0]);
  assert.deepEqual(kinds, ["schema", "create", "update"]);
  const created = t.notionCalls.find((c) => c[0] === "create")[1];
  assert.equal(created.question, "Are you a veteran?");
  assert.match(created.jobs, /^Cod — Product Manager — https:/);
  const updated = t.notionCalls.find((c) => c[0] === "update");
  assert.equal(updated[1], "p-why");
  assert.equal(updated[2].companies, "Coc, Cod");
  assert.equal(updated[2].jobs.split("\n").length, 2);
  // Never pushed: the bot check, the Ashby question.
  assert.equal(
    t.notionCalls.some((c) => /robot|Visa/.test(JSON.stringify(c))),
    false
  );

  const state = JSON.parse(fs.readFileSync(t.statePath, "utf8"));
  assert.equal(state.waiting, 2);
  assert.equal(state.view_url, "https://www.notion.so/db1");
  assert.deepEqual(
    state.requeued.map((x) => [x.key, x.date]),
    [["a", "2026-11-10"]]
  );

  // Second run: nothing new to pull, requeue or create.
  t.notionCalls.length = 0;
  const again = await t.run({ apply: true });
  assert.equal(again.code, 0);
  assert.match(again.out, /pull — 1 answer\(s\) \(0 new\)/);
  assert.match(again.out, /requeue — 0 row\(s\) back to the queue/);
  assert.equal(
    t.notionCalls.filter((c) => c[0] === "create").length,
    1,
    "the stale Notion snapshot still lacks the veteran entry"
  );
});

test("no Notion token: requeue runs on the standing answers on disk, pull / push skipped", async () => {
  const t = setup({
    token: "",
    apps: [
      row("a", { companyName: "Plaid", apply_note: "no_honest_answer: Have you worked at Plaid?" }),
      row("b", { apply_note: "no_honest_answer: Other?" }),
    ],
    ad: defaults({
      standing_answers: [{ question: "Have you worked at <company>?", answer: "No" }],
    }),
  });
  const r = await t.run({ apply: true });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /pull skipped — missing DEMO_NOTION_TOKEN/);
  assert.match(r.out, /push skipped — missing DEMO_NOTION_TOKEN; 1 question\(s\) would wait/);
  assert.equal(t.byKey().get("a").apply_state, "queued");
  assert.equal(t.byKey().get("b").apply_state, "skipped");
  assert.deepEqual(t.notionCalls, []);
  assert.equal(JSON.parse(fs.readFileSync(t.statePath, "utf8")).waiting, 1);
});

test("a row changed after the plan is not touched (re-checked under the TSV lock)", async () => {
  const t = setup({
    apps: [row("a", { apply_note: "no_honest_answer: Lic?" })],
    entries: [{ pageId: "p", question: "Lic?", answer: "Yes", status: S.answered }],
  });
  let lockRuns = 0;
  const cmd = makeQuestionsCommand({
    loadSecrets: () => ({ NOTION_TOKEN: "t" }),
    makeNotionClient: () => ({}),
    fetchAllAnswers: async () => [
      { pageId: "p", question: "Lic?", answer: "Yes", status: S.answered },
    ],
    ensurePendingSchema: async () => ({ changed: [] }),
    withApplicationsLock: async (file, fn) => {
      lockRuns += 1;
      // The submitter wrote the row meanwhile.
      const apps = applications.load(file).apps;
      apps[0].apply_state = "submitted";
      apps[0].status = "Applied";
      applications.save(file, apps);
      return fn();
    },
    today: () => "2026-11-10",
    now: () => new Date("2026-11-10T12:00:00.000Z"),
  });
  const code = await cmd({
    profileId: "demo",
    profilesDir: path.dirname(t.dir),
    env: {},
    flags: { apply: true },
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(code, 0);
  assert.equal(lockRuns, 1);
  assert.equal(t.byKey().get("a").apply_state, "submitted");
});

test("a Q&A schema that cannot be fixed → nothing pushed, exit 1", async () => {
  const t = setup({
    apps: [row("a", { apply_note: "no_honest_answer: New question?" })],
    over: {
      ensurePendingSchema: async () => {
        throw new Error('property "Status" exists with type "status" — needs a select');
      },
    },
  });
  const r = await t.run({ apply: true });
  assert.equal(r.code, 1);
  assert.match(r.err, /schema not ready/);
  assert.equal(t.notionCalls.length, 0);
});

test("--phase validates its value and runs one step only", async () => {
  const { apps, entries } = scenario();
  const t = setup({ apps, entries });
  const bad = await t.run({ phase: "everything" });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--phase <pull\|requeue\|push>/);
  const only = await t.run({ phase: "pull" });
  assert.equal(only.code, 0);
  assert.match(only.out, /questions: pull/);
  assert.doesNotMatch(only.out, /questions: requeue|questions: push/);
});

test("planPush: an answered / skipped entry is never duplicated nor updated", () => {
  const groups = [
    { key: "a", question: "A?", rows: [{ key: "1", company: "X", title: "PM", url: "u" }] },
    { key: "b", question: "B?", rows: [{ key: "2", company: "Y", title: "PM", url: "u" }] },
  ];
  const p = planPush(groups, [
    { pageId: "pa", question: "A?", status: S.answered, questionKey: "a" },
    { pageId: "pb", question: "B?", status: null }, // ordinary bank answer: not the queue
  ]);
  assert.equal(p.known.length, 1);
  assert.deepEqual(
    p.create.map((g) => g.key),
    ["b"]
  );
  assert.equal(p.update.length, 0);
});

test("viewUrl: profile setting first, else the database", () => {
  assert.equal(
    viewUrl({
      notion: { application_qa_db_id: "ab-cd", application_qa_waiting_view_url: "https://v" },
    }),
    "https://v"
  );
  assert.equal(
    viewUrl({ notion: { application_qa_db_id: "ab-cd" } }),
    "https://www.notion.so/abcd"
  );
  assert.equal(viewUrl({}), null);
});
