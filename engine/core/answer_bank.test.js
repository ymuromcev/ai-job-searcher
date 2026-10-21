const { test } = require("node:test");
const assert = require("node:assert/strict");

const ab = require("./answer_bank.js");

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

function entry(pageId, over = {}) {
  return {
    pageId,
    company: "Acme",
    role: "PM",
    question: "Why us?",
    answer: "Because.",
    category: "Motivation",
    notes: "",
    createdAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

const r = (rating, extra = {}) => ({ rating, rated_at: "", question_key: "", ...extra });

// --- ids / input -----------------------------------------------------------

test("isValidBankId: Notion UUIDs (dashed or bare) and local backup ids only", () => {
  assert.ok(ab.isValidBankId(A));
  assert.ok(ab.isValidBankId(A.replace(/-/g, "")));
  assert.ok(ab.isValidBankId("local:Acme_pm_20261001.md#1"));
  assert.ok(!ab.isValidBankId("local:../x.md#1"));
  assert.ok(!ab.isValidBankId("bank-1"));
  assert.ok(!ab.isValidBankId(""));
  assert.ok(!ab.isValidBankId(42));
  assert.ok(!ab.isValidBankId("__proto__"));
});

test("validateRatingInput: exactly { id, rating }, rating 1..5 integer or null", () => {
  assert.deepEqual(ab.validateRatingInput({ id: A, rating: 4 }), { ok: true, id: A, rating: 4 });
  assert.deepEqual(ab.validateRatingInput({ id: A, rating: null }), {
    ok: true,
    id: A,
    rating: null,
  });
  for (const bad of [
    null,
    [],
    "x",
    { rating: 3 },
    { id: A, rating: 0 },
    { id: A, rating: 6 },
    { id: A, rating: 2.5 },
    { id: A, rating: "5" },
    { id: A, rating: 3, extra: 1 },
    { id: "bank-1", rating: 3 },
  ]) {
    const v = ab.validateRatingInput(bad);
    assert.equal(v.ok, false, JSON.stringify(bad));
    assert.ok(v.error);
  }
});

// --- ratings map -----------------------------------------------------------

test("normalizeRatings drops malformed entries; setRating sets and clears", () => {
  const raw = { [A]: r(5), [B]: r(9), "not-an-id": r(3), [C]: "x" };
  assert.deepEqual(Object.keys(ab.normalizeRatings(raw)), [A]);
  assert.deepEqual(ab.normalizeRatings(null), {});

  const now = new Date("2026-10-21T10:00:00Z");
  const set = ab.setRating({}, { id: B, rating: 2, questionKey: "k", now });
  assert.deepEqual(set[B], { rating: 2, rated_at: "2026-10-21T10:00:00.000Z", question_key: "k" });
  const cleared = ab.setRating(set, { id: B, rating: null });
  assert.equal(cleared[B], undefined);
  assert.throws(() => ab.setRating({}, { id: "bad", rating: 3 }), /invalid bank id/);
  assert.throws(() => ab.setRating({}, { id: A, rating: 7 }), /invalid rating/);
});

test("ratingFor: by id; a local-backup rating reaches the Notion row with the same question key", () => {
  const notionRow = entry(A);
  const localId = "local:Acme_pm_20261001.md#1";
  const idx = ab.indexRatings({ [localId]: r(1, { question_key: ab.questionKey(notionRow) }) });
  assert.equal(ab.ratingFor(notionRow, idx), 1);
  const own = ab.indexRatings({
    [A]: r(5),
    [localId]: r(1, { question_key: ab.questionKey(notionRow) }),
  });
  assert.equal(ab.ratingFor(notionRow, own), 5, "the row's own rating wins");
  assert.equal(ab.ratingFor(entry(B, { question: "Other?" }), idx), null);
});

// --- ranking ---------------------------------------------------------------

test("rankBank: drops 1–2, higher rated first, unrated as 3, then newer, then original order", () => {
  const bank = [
    entry(A, { createdAt: "2026-09-01T00:00:00Z" }),
    entry(B, { createdAt: "2026-10-01T00:00:00Z" }),
    entry(C, { createdAt: "2026-08-01T00:00:00Z" }),
  ];
  const none = ab.rankBank(bank, {});
  assert.deepEqual(
    none.bank.map((e) => e.pageId),
    [B, A, C]
  );
  assert.equal(none.hidden, 0);

  const rated = ab.rankBank(bank, { [C]: r(5), [B]: r(2) });
  assert.deepEqual(
    rated.bank.map((e) => e.pageId),
    [C, A]
  );
  assert.equal(rated.hidden, 1);

  const four = ab.rankBank(bank, { [A]: r(4), [C]: r(3) });
  assert.deepEqual(
    four.bank.map((e) => e.pageId),
    [A, B, C],
    "4 beats unrated; a 3 ties with unrated and falls back to date"
  );

  const undated = ab.rankBank([entry(A, { createdAt: null }), entry(B, { createdAt: null })], {});
  assert.deepEqual(
    undated.bank.map((e) => e.pageId),
    [A, B]
  );
  assert.deepEqual(ab.rankBank(null, {}), { bank: [], hidden: 0 });
});

// --- uses ------------------------------------------------------------------

test("bankUsesFromJobs + countBankUses: distinct jobs per answer, dry runs ignored", () => {
  const jobs = [
    {
      key: "j1",
      answers: [
        { source: "bank", bank_page_id: A },
        { source: "identity", value: "x" },
        { source: "bank_reuse", bank_page_id: B },
      ],
    },
    { key: "j2", answers: [{ source: "bank_reuse", bank_page_id: B }] },
  ];
  const used = ab.bankUsesFromJobs(jobs);
  assert.equal(used.length, 3);
  const uses = ab.countBankUses([
    { dry_run: false, bank_used: used },
    { dry_run: false, bank_used: [{ key: "j1", bank_page_id: B }] }, // j1 again: not counted twice
    { dry_run: true, bank_used: [{ key: "j9", bank_page_id: A }] },
    { dry_run: false }, // older record without the field
    null,
  ]);
  assert.equal(uses.get(A), 1);
  assert.equal(uses.get(B), 2);
});

// --- board view ------------------------------------------------------------

test("buildBankView: newest first, origin from notes, uses, ratings, summary", () => {
  const entries = [
    entry(A, { createdAt: "2026-10-01T00:00:00Z", notes: "apply bot, truth-checked" }),
    entry(B, { createdAt: "2026-10-05T00:00:00Z", notes: "long version" }),
    entry("local:x_y_20260101.md#1", { createdAt: "2026-01-01", notes: "apply bot" }),
    entry("", { createdAt: "" }),
  ];
  const view = ab.buildBankView(entries, { [A]: r(4), [B]: r(5) }, { uses: new Map([[A, 3]]) });
  assert.deepEqual(
    view.rows.map((x) => x.id),
    [B, A, "local:x_y_20260101.md#1", ""]
  );
  const byId = Object.fromEntries(view.rows.map((x) => [x.id, x]));
  assert.equal(byId[A].origin, "bot");
  assert.equal(byId[A].origin_label, "бот, проверен на правду");
  assert.equal(byId["local:x_y_20260101.md#1"].origin_label, "бот");
  assert.equal(byId[B].origin_label, "свой");
  assert.equal(byId[A].uses, 3);
  assert.equal(byId[B].uses, 0);
  assert.equal(byId[A].date, "2026-10-01");
  assert.equal(byId[A].rating, 4);
  assert.equal(byId[""].ratable, false);
  assert.deepEqual(view.summary, { total: 4, bot: 2, rated: 2, unrated: 2, average: 4.5 });
});

test("botBankStats: bot answers only, in the period, rated / unrated / average", () => {
  const entries = [
    entry(A, { notes: "apply bot, truth-checked", createdAt: "2026-10-20T00:00:00Z" }),
    entry(B, { notes: "apply bot, truth-checked", createdAt: "2026-10-19T00:00:00Z" }),
    entry(C, { notes: "apply bot, truth-checked", createdAt: "2026-09-01T00:00:00Z" }),
    entry("dddddddd-0000-4000-8000-000000000004", { notes: "", createdAt: "2026-10-20" }),
  ];
  const ratings = { [A]: r(5), [C]: r(2) };
  const inWeek = (e) => e.createdAt >= "2026-10-15";
  assert.deepEqual(ab.botBankStats(entries, ratings, inWeek), {
    added: 2,
    rated: 1,
    unrated: 1,
    average: 5,
  });
  assert.deepEqual(ab.botBankStats(entries, ratings), {
    added: 3,
    rated: 2,
    unrated: 1,
    average: 3.5,
  });
  assert.deepEqual(ab.botBankStats([], {}), { added: 0, rated: 0, unrated: 0, average: null });
});

// --- local backup ----------------------------------------------------------

test("parseBackupMarkdown: the current single-question format", () => {
  const text = [
    "# Acme Corp — Senior PM",
    "",
    "- **Date saved**: 2026-10-20T18:00:00.000Z",
    "- **Role**: Senior PM",
    "- **Status**: submitted",
    "- **Category**: Motivation",
    "- **Notes**: apply bot, truth-checked",
    "",
    "---",
    "",
    "## Q. Why Acme?",
    "",
    "First line.",
    "",
    "Second paragraph.",
    "",
    "_(34 chars)_",
    "",
  ].join("\n");
  const [e, ...rest] = ab.parseBackupMarkdown(text, "Acme-Corp_senior-pm_20261020.md");
  assert.equal(rest.length, 0);
  assert.deepEqual(e, {
    pageId: "local:Acme-Corp_senior-pm_20261020.md#1",
    url: null,
    question: "Why Acme?",
    answer: "First line.\n\nSecond paragraph.",
    category: "Motivation",
    role: "Senior PM",
    company: "Acme Corp",
    notes: "apply bot, truth-checked",
    createdAt: "2026-10-20T18:00:00.000Z",
  });
  assert.ok(ab.isValidBankId(e.pageId));
});

test("parseBackupMarkdown: older multi-question files, date from the file name", () => {
  const text = [
    "# Beta — Product Manager",
    "",
    "- **Role**: Product Manager",
    "- **Status**: submitted",
    "",
    "---",
    "",
    "## Q1. Who inspires you?",
    "",
    "People.",
    "",
    "_(7 chars)_",
    "",
    "---",
    "",
    "## Q2. What motivates you?",
    "",
    "Craft.",
    "",
  ].join("\n");
  const list = ab.parseBackupMarkdown(text, "Beta_product-manager_20260430_v2.md");
  assert.deepEqual(
    list.map((e) => [e.pageId, e.question, e.answer, e.company, e.createdAt, e.category]),
    [
      [
        "local:Beta_product-manager_20260430_v2.md#1",
        "Who inspires you?",
        "People.",
        "Beta",
        "2026-04-30",
        null,
      ],
      [
        "local:Beta_product-manager_20260430_v2.md#2",
        "What motivates you?",
        "Craft.",
        "Beta",
        "2026-04-30",
        null,
      ],
    ]
  );
  assert.deepEqual(ab.parseBackupMarkdown("# nothing here", "x.md"), []);
});
