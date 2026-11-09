const { test } = require("node:test");
const assert = require("node:assert/strict");

const oq = require("./owner_questions.js");

const STATUSES = { waiting: "Waiting for answer", answered: "Answered", skip: "Skip such jobs" };

function row(key, over = {}) {
  return {
    key,
    companyName: "Acme",
    title: "Product Manager",
    url: `https://job-boards.greenhouse.io/acme/jobs/${key}`,
    status: "To Apply",
    applied_date: "",
    apply_state: "skipped",
    apply_note: "no_honest_answer: Do you have a valid driver's license?",
    ...over,
  };
}

test("questionKey: company name, required marker, case and punctuation do not matter", () => {
  const a = oq.questionKey("Why do you want to work at Acme? *", "Acme");
  const b = oq.questionKey("why do you want to work at BETA?", "Beta, Inc.");
  const c = oq.questionKey("Why do you want to work at <company>?", null);
  assert.equal(a, b);
  assert.equal(a, c);
  assert.notEqual(a, oq.questionKey("Why do you want to work here?", "Acme"));
  // A company name inside another word is not replaced.
  assert.equal(oq.displayQuestion("Are you an Acmeist?", "Acme"), "Are you an Acmeist?");
  assert.equal(
    oq.displayQuestion("Have you worked at Acme before? (required)", "Acme"),
    "Have you worked at <company> before?"
  );
});

test("excludedReason: bot checks and no-AI certifications are never collected", () => {
  assert.equal(oq.excludedReason("Please confirm you are not a robot"), "bot_check");
  assert.equal(oq.excludedReason("Type the secret word from the job post"), "bot_check");
  assert.equal(
    oq.excludedReason("I certify this application was written without the use of AI"),
    "ai_certification"
  );
  assert.equal(
    oq.excludedReason("Did you use ChatGPT? I did not use AI tools"),
    "ai_certification"
  );
  assert.equal(oq.excludedReason("Describe a product you shipped with generative AI"), null);
  assert.equal(oq.excludedReason("Do you have a valid driver's license?"), null);
});

test("parseBlockers / blockerNote round-trip, owner_skip tag, non-NHA notes → null", () => {
  assert.deepEqual(oq.parseBlockers("no_honest_answer: A?; B?; A?"), {
    blockers: ["A?", "B?"],
    ownerSkip: false,
  });
  assert.deepEqual(oq.parseBlockers("no_honest_answer: owner_skip: A?"), {
    blockers: ["A?"],
    ownerSkip: true,
  });
  assert.deepEqual(oq.parseBlockers("no_honest_answer"), { blockers: [], ownerSkip: false });
  assert.deepEqual(oq.parseBlockers("no_honest_answer: schema_changed"), {
    blockers: [],
    ownerSkip: false,
  });
  assert.equal(oq.parseBlockers("captcha"), null);
  assert.equal(oq.parseBlockers("required_empty: A"), null);
  assert.equal(oq.blockerNote(["A?", "B?"], false), "no_honest_answer: A?; B?");
  assert.equal(oq.blockerNote(["A?"], true), "no_honest_answer: owner_skip: A?");
  assert.equal(oq.requeueNote("2026-11-10"), "requeued:2026-11-10 answers");
});

test("isBlockedRow: only skipped no_honest_answer To Apply rows, never applied, never Ashby", () => {
  assert.equal(oq.isBlockedRow(row("1")), true);
  assert.equal(oq.isBlockedRow(row("2", { apply_state: "queued" })), false);
  assert.equal(oq.isBlockedRow(row("3", { status: "Applied" })), false);
  assert.equal(oq.isBlockedRow(row("4", { applied_date: "2026-11-01" })), false);
  assert.equal(oq.isBlockedRow(row("5", { apply_note: "captcha" })), false);
  assert.equal(oq.isBlockedRow(row("6", { url: "https://jobs.ashbyhq.com/acme/123" })), false);
});

test("planRows: requeue when every blocker is answered, skip rule wins, excluded → stuck", () => {
  const apps = [
    row("all", {
      apply_note: "no_honest_answer: Do you have a valid driver's license?; Why Acme?",
    }),
    row("part", {
      companyName: "Beta",
      apply_note:
        "no_honest_answer: Do you have a valid driver's license? *; Are you a US veteran?",
    }),
    row("rule", { apply_note: "no_honest_answer: Will you work 5 days in the office?" }),
    row("bot", { apply_note: "no_honest_answer: Please confirm you are not a robot" }),
    row("nolabels", { apply_note: "no_honest_answer" }),
    row("other", { apply_note: "captcha" }),
  ];
  const ad = {
    standing_answers: [
      { question: "Do you have a valid driver's license?", answer: "Yes" },
      { question: "Why <company>?", answer: "Because." },
    ],
    skip_questions: [{ question: "Will you work 5 days in the office?" }],
  };
  const plan = oq.planRows(apps, ad);
  assert.deepEqual(
    plan.requeue.map((x) => x.app.key),
    ["all"]
  );
  assert.deepEqual(
    plan.ownerSkip.map((x) => [x.app.key, x.note]),
    [["rule", "no_honest_answer: owner_skip: Will you work 5 days in the office?"]]
  );
  assert.deepEqual(
    plan.waiting.map((x) => [x.app.key, x.open]),
    [["part", ["Are you a US veteran?"]]]
  );
  assert.deepEqual(plan.stuck.map((x) => [x.app.key, x.why]).sort(), [
    ["bot", "excluded"],
    ["nolabels", "no_labels"],
  ]);
});

test("planRows: a lifted skip rule turns the row back into a plain waiting one", () => {
  const app = row("r", { apply_note: "no_honest_answer: owner_skip: Office 5 days?" });
  const plan = oq.planRows([app], { standing_answers: [] });
  assert.equal(plan.waiting.length, 1);
  assert.equal(plan.waiting[0].note, "no_honest_answer: Office 5 days?");
});

test("groupQuestions: one entry per question across companies, jobs listed once", () => {
  const plan = oq.planRows(
    [
      row("a", { companyName: "Acme", apply_note: "no_honest_answer: Why Acme?; Visa?" }),
      row("b", { companyName: "Beta", apply_note: "no_honest_answer: Why Beta?" }),
      row("c", { companyName: "Gamma", apply_note: "no_honest_answer: Visa?" }),
    ],
    {}
  );
  const groups = oq.groupQuestions(plan.waiting);
  assert.deepEqual(
    groups.map((g) => [g.question, g.rows.map((r) => r.key)]),
    [
      ["Visa?", ["a", "c"]],
      ["Why <company>?", ["a", "b"]],
    ]
  );
  assert.match(oq.jobsText(groups[0]), /^Acme — Product Manager — https:\/\/job-boards/);
});

test("findStandingAnswer / isSkipQuestion match a form label exactly (normalized)", () => {
  const idx = oq.answerIndex({
    standing_answers: [{ question: "Have you worked at <company> before?", answer: "No" }],
    skip_questions: [{ question: "Are you willing to relocate to Texas?" }],
  });
  assert.equal(oq.findStandingAnswer(idx, "Have you worked at Plaid before? *", "Plaid"), "No");
  assert.equal(oq.findStandingAnswer(idx, "Have you worked here before?", "Plaid"), null);
  assert.equal(oq.isSkipQuestion(idx, "Are you willing to relocate to Texas?", "X"), true);
  assert.equal(oq.isSkipQuestion(idx, "Are you willing to relocate?", "X"), false);
  assert.equal(oq.findStandingAnswer(oq.answerIndex(null), "Q", "X"), null);
});

test("mergeOwnerAnswers: Notion entries replace Notion-tagged ones, the owner's own stay", () => {
  const ad = {
    salary: { floor: 1 },
    standing_answers: [
      { question: "Own?", answer: "Mine" },
      { question: "Old?", answer: "Gone", notion_page_id: "p-old" },
      { question: "Kept?", answer: "Old text", notion_page_id: "p-kept" },
    ],
  };
  const entries = [
    { pageId: "p-kept", question: "Kept?", answer: "New text", status: STATUSES.answered },
    { pageId: "p-new", question: "New?", answer: "Yes", status: STATUSES.answered },
    { pageId: "p-empty", question: "Empty?", answer: " ", status: STATUSES.answered },
    { pageId: "p-skip", question: "Office 5 days?", answer: "", status: STATUSES.skip },
    { pageId: "p-wait", question: "Waiting?", answer: "", status: STATUSES.waiting },
    { pageId: "p-bank", question: "Bank?", answer: "Bank", status: null },
  ];
  const m = oq.mergeOwnerAnswers(ad, entries, STATUSES);
  assert.equal(m.changed, true);
  assert.deepEqual(m.next.standing_answers, [
    { question: "Own?", answer: "Mine" },
    { question: "Kept?", answer: "New text", notion_page_id: "p-kept" },
    { question: "New?", answer: "Yes", notion_page_id: "p-new" },
  ]);
  assert.deepEqual(m.next.skip_questions, [
    { question: "Office 5 days?", notion_page_id: "p-skip" },
  ]);
  assert.deepEqual(
    m.removed.map((r) => r.notion_page_id),
    ["p-old"]
  );
  assert.deepEqual(
    m.answers.map((a) => [a.notion_page_id, a.new]),
    [
      ["p-kept", false],
      ["p-new", true],
    ]
  );
  assert.equal(m.next.salary.floor, 1);
  // Same input again → nothing changes.
  assert.equal(oq.mergeOwnerAnswers(m.next, entries, STATUSES).changed, false);
});

test("a reworded Notion title still answers the form question it was pushed for", () => {
  const key = oq.questionKey("Why do you want to work at Acme?", "Acme");
  const m = oq.mergeOwnerAnswers(
    {},
    [
      {
        pageId: "p1",
        question: "Why this company (any)?",
        questionKey: key,
        answer: "I use <company> every day.",
        status: STATUSES.answered,
      },
    ],
    STATUSES
  );
  assert.equal(m.next.standing_answers[0].question_key, key);
  const idx = oq.answerIndex(m.next);
  assert.equal(
    oq.findStandingAnswer(idx, "Why do you want to work at Beta?", "Beta"),
    "I use Beta every day."
  );
  assert.equal(
    oq.findStandingAnswer(idx, "Why this company (any)?", "Gamma"),
    "I use Gamma every day."
  );
});

test("mergeOwnerAnswers: no Notion entries and no lists → apply_defaults unchanged", () => {
  const m = oq.mergeOwnerAnswers({ salary: {} }, [], STATUSES);
  assert.equal(m.changed, false);
  assert.deepEqual(m.next, { salary: {} });
});
