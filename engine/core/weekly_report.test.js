const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildWeeklyReport,
  weeklyTables,
  renderWeeklyHtml,
  geoBucket,
  ageBucket,
} = require("./weekly_report.js");

const REF = "2026-10-21"; // week = 2026-10-15 … 2026-10-21

function row(overrides = {}) {
  return {
    key: `k${Math.random()}`,
    source: "greenhouse",
    companyName: "Acme",
    title: "Senior PM",
    url: "https://boards.greenhouse.io/acme/jobs/1",
    locations: ["Remote - US"],
    status: "Applied",
    createdAt: "2026-10-14T08:00:00Z",
    updatedAt: "2026-10-16T08:00:00Z",
    fit_score: "Strong",
    resume_ver: "Growth",
    applied_date: "2026-10-16",
    applied_by: "bot",
    ...overrides,
  };
}

function fixture() {
  return [
    // In the week.
    row({ status: "Applied" }),
    row({ status: "Interview", applied_date: "2026-10-15", fit_score: "Medium" }),
    row({ status: "Rejected", applied_date: "2026-10-21", locations: ["San Francisco, CA"] }),
    row({ status: "Offer", applied_date: "2026-10-18", applied_by: "manual" }),
    // Before the week (cumulative only).
    row({
      status: "Rejected",
      applied_date: "2026-10-14",
      source: "lever",
      url: "https://jobs.lever.co/x/1",
    }),
    row({
      status: "No Response",
      applied_date: "2026-09-01",
      applied_by: "legacy_bot",
      locations: ["New York, NY"],
    }),
    // Applied without an anchor date (legacy) — cumulative only.
    row({ status: "Closed", applied_date: "", applied_by: "" }),
    // Not applied.
    row({ status: "To Apply", applied_date: "" }),
    row({ status: "Inbox", applied_date: "" }),
    // Manual / failed queue.
    row({
      status: "To Apply",
      applied_date: "",
      apply_state: "manual",
      apply_note: "captcha",
      updatedAt: "2026-10-20T00:00:00Z",
    }),
    row({
      status: "To Apply",
      applied_date: "",
      apply_state: "manual",
      apply_note: "captcha",
      updatedAt: "2026-10-01T00:00:00Z",
    }),
    row({
      status: "To Apply",
      applied_date: "",
      apply_state: "failed",
      apply_note: "no_confirmation: still on form",
      updatedAt: "2026-10-19T00:00:00Z",
    }),
    row({
      status: "To Apply",
      applied_date: "",
      apply_state: "manual",
      apply_note: "unsupported_ats:jobs.example.com",
      updatedAt: "2026-10-19T00:00:00Z",
    }),
  ];
}

test("week window is 7 days ending on refDate inclusive", () => {
  const r = buildWeeklyReport(fixture(), REF);
  assert.equal(r.refDate, "2026-10-21");
  assert.equal(r.weekStart, "2026-10-15");
  assert.equal(r.week.applied, 4);
});

test("week and total counts: applied, responses, interviews, offers, rejections, rate", () => {
  const r = buildWeeklyReport(fixture(), REF);
  assert.deepEqual(
    {
      applied: r.week.applied,
      responses: r.week.responses,
      interviews: r.week.interviews,
      offers: r.week.offers,
      rejections: r.week.rejections,
      waiting: r.week.waiting,
    },
    { applied: 4, responses: 3, interviews: 2, offers: 1, rejections: 1, waiting: 1 }
  );
  assert.equal(r.week.responseRate, 0.75);
  assert.equal(r.total.applied, 7);
  assert.equal(r.total.responses, 4);
  assert.equal(r.total.rejections, 2);
  assert.ok(Math.abs(r.total.responseRate - 4 / 7) < 1e-9);
});

test("empty input: zero counts, null rate, no crash", () => {
  const r = buildWeeklyReport([], REF);
  assert.equal(r.week.applied, 0);
  assert.equal(r.week.responseRate, null);
  assert.deepEqual(r.week.by.fit_score, []);
  assert.deepEqual(r.reasons.open, []);
});

test("refDate accepts a Date and rejects garbage", () => {
  const r = buildWeeklyReport([], new Date(2026, 9, 21, 15, 0, 0));
  assert.equal(r.refDate, "2026-10-21");
  assert.throws(() => buildWeeklyReport([], "yesterday"), /invalid reference date/);
});

test("breakdowns: fit, source, ATS, geo, applied_by, resume", () => {
  const r = buildWeeklyReport(fixture(), REF);
  const pick = (list) => list.map((e) => [e.key, e.applied]);
  assert.deepEqual(pick(r.week.by.fit_score), [
    ["Strong", 3],
    ["Medium", 1],
  ]);
  assert.deepEqual(pick(r.total.by.source), [
    ["greenhouse", 6],
    ["lever", 1],
  ]);
  assert.deepEqual(pick(r.total.by.ats), [
    ["Greenhouse", 6],
    ["Lever", 1],
  ]);
  assert.deepEqual(pick(r.total.by.geo), [
    ["ca", 1],
    ["remote", 5],
    ["other", 1],
  ]);
  assert.deepEqual(pick(r.total.by.applied_by), [
    ["bot", 4],
    ["manual", 1],
    ["legacy_bot", 1],
    ["", 1],
  ]);
  assert.equal(r.total.by.applied_by[3].label, "не отмечено");
  assert.deepEqual(pick(r.total.by.resume), [["Growth", 7]]);
});

test("breakdown entries carry their own response numbers", () => {
  const r = buildWeeklyReport(fixture(), REF);
  const medium = r.week.by.fit_score.find((e) => e.key === "Medium");
  assert.equal(medium.responses, 1);
  assert.equal(medium.interviews, 1);
  assert.equal(medium.responseRate, 1);
});

test("ageBucket: applied_date − createdAt in days", () => {
  const mk = (created, applied) => ({ createdAt: created, applied_date: applied });
  assert.equal(ageBucket(mk("2026-10-01T23:00:00Z", "2026-10-01")), "0-3");
  assert.equal(ageBucket(mk("2026-10-01", "2026-10-04")), "0-3");
  assert.equal(ageBucket(mk("2026-10-01", "2026-10-05")), "4-14");
  assert.equal(ageBucket(mk("2026-10-01", "2026-10-15")), "4-14");
  assert.equal(ageBucket(mk("2026-10-01", "2026-10-16")), "15-30");
  assert.equal(ageBucket(mk("2026-10-01", "2026-10-31")), "15-30");
  assert.equal(ageBucket(mk("2026-10-01", "2026-11-01")), "31+");
  assert.equal(ageBucket(mk("", "2026-11-01")), "unknown");
  assert.equal(ageBucket(mk("2026-10-05", "2026-10-01")), "unknown");
  assert.equal(ageBucket(mk("2026-10-05", "")), "unknown");
});

test("geoBucket: CA wins over remote; remote; other", () => {
  assert.equal(geoBucket(["San Francisco, CA or Remote"]), "ca");
  assert.equal(geoBucket(["Remote", "Los Angeles"]), "ca");
  assert.equal(geoBucket(["Sacramento, California"]), "ca");
  assert.equal(geoBucket(["Remote - US"]), "remote");
  assert.equal(geoBucket(["New York (Hybrid)"]), "other");
  assert.equal(geoBucket([]), "other");
  assert.equal(geoBucket(undefined), "other");
  assert.equal(geoBucket("Remote"), "remote");
});

test("top reasons: grouped, counted, with week subset by updatedAt", () => {
  const r = buildWeeklyReport(fixture(), REF);
  assert.deepEqual(
    r.reasons.open.map((x) => [x.label, x.count]),
    [
      ["капча", 2],
      ["после отправки нет подтверждения", 1],
      ["сайт подачи не поддерживается: jobs.example.com", 1],
    ]
  );
  assert.deepEqual(
    r.reasons.week.map((x) => [x.label, x.count]),
    [
      ["капча", 1],
      ["после отправки нет подтверждения", 1],
      ["сайт подачи не поддерживается: jobs.example.com", 1],
    ]
  );
});

test("weeklyTables: summary table + one table per dimension + reasons", () => {
  const tables = weeklyTables(buildWeeklyReport(fixture(), REF));
  assert.equal(tables[0].title, "Итоги");
  assert.match(tables[0].columns[1], /15\.10\.2026 – 21\.10\.2026/);
  assert.deepEqual(tables[0].rows[0], ["Подано", "4", "7"]);
  assert.deepEqual(tables[0].rows[6], ["Доля ответов", "75%", "57%"]);
  const titles = tables.map((t) => t.title);
  assert.ok(titles.includes("По возрасту вакансии на момент подачи"));
  assert.ok(titles.includes("Кто подал"));
  const reasons = tables[tables.length - 1];
  assert.deepEqual(reasons.rows[0], ["капча", "2", "1"]);
});

test("weeklyTables on empty data: dimension tables are empty with a Russian empty state", () => {
  const tables = weeklyTables(buildWeeklyReport([], REF));
  assert.deepEqual(tables[0].rows[6], ["Доля ответов", "—", "—"]);
  for (const t of tables.slice(1)) {
    assert.equal(t.rows.length, 0);
    assert.ok(t.empty.length > 0);
  }
});

// BL-225: nightly runs from .health/apply_runs.jsonl.
function night(startLocal, over = {}) {
  const started = new Date(...startLocal);
  return {
    started_at: started.toISOString(),
    finished_at: new Date(started.getTime() + 8 * 3600 * 1000).toISOString(),
    target: 100,
    scanned: 200,
    prepared: 60,
    strong: 10,
    medium: 30,
    weak: 20,
    queued: 45,
    submitted: 40,
    manual: 4,
    failed: 1,
    deferred: 0,
    apply_rounds: 3,
    stop_reason: "deadline",
    ...over,
  };
}

test("nights: only the week's nights (by local start day), one row each + a total", () => {
  const nights = [
    night([2026, 9, 14, 22, 0]), // Oct 14 — before the week
    night([2026, 9, 15, 22, 30], { submitted: 52, stop_reason: "target_reached" }),
    night([2026, 9, 20, 22, 0], { submitted: 38, deferred: 3, stop_reason: "abandoned" }),
  ];
  const report = buildWeeklyReport(fixture(), REF, { nights });
  assert.equal(report.nights.list.length, 2);
  assert.equal(report.nights.sum.submitted, 90);
  const tables = weeklyTables(report);
  assert.equal(tables[1].title, "Ночные запуски");
  const rows = tables[1].rows;
  assert.equal(rows.length, 3);
  assert.equal(rows[0][0], "15.10.2026");
  assert.equal(rows[0][1], "22:30–06:30");
  assert.deepEqual(rows[0].slice(2), [
    "200",
    "60 (10 / 30)",
    "45",
    "52 из 100",
    "4",
    "1",
    "0",
    "цель достигнута",
  ]);
  assert.equal(rows[1][9], "оборвалась");
  assert.deepEqual(rows[2].slice(0, 6), ["Итого", "2 ноч.", "400", "120 (20 / 60)", "90", "90"]);
  assert.equal(rows[2][8], "3");

  // No nights this week → empty state; no `nights` option → no table at all.
  const empty = weeklyTables(buildWeeklyReport([], REF, { nights: [nights[0]] }));
  assert.equal(empty[1].rows.length, 0);
  assert.match(empty[1].empty, /не было/);
  assert.ok(!weeklyTables(buildWeeklyReport([], REF)).some((t) => t.title === "Ночные запуски"));
});

test("renderWeeklyHtml: self-contained, escaped, no scripts", () => {
  const rows = [row({ resume_ver: "<script>alert(1)</script>" })];
  const html = renderWeeklyHtml(buildWeeklyReport(rows, REF), {
    profileId: "demo",
    generatedAt: "2026-10-21T10:00:00Z",
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Отклики за неделю — demo/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /https?:\/\//); // nothing loaded from the network
});

test("bank line: bot answers saved this week vs all, rated / unrated / average (BL-225 U7)", () => {
  const bot = "apply bot, truth-checked";
  const id = (n) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
  const entries = [
    { pageId: id(1), notes: bot, createdAt: "2026-10-20T18:00:00.000Z" },
    { pageId: id(2), notes: bot, createdAt: "2026-10-15" }, // local backup date, first day
    { pageId: id(3), notes: bot, createdAt: "2026-10-14" }, // the day before the week
    { pageId: id(4), notes: "", createdAt: "2026-10-20" }, // the owner's own answer
  ];
  const ratings = {
    [id(1)]: { rating: 4, rated_at: "", question_key: "" },
    [id(3)]: { rating: 1, rated_at: "", question_key: "" },
  };
  const report = buildWeeklyReport([], REF, { bank: { entries, ratings } });
  assert.deepEqual(report.bank.week, { added: 2, rated: 1, unrated: 1, average: 4 });
  assert.deepEqual(report.bank.total, { added: 3, rated: 2, unrated: 1, average: 2.5 });
  const line = weeklyTables(report)[0].rows.at(-1);
  assert.deepEqual(line, [
    "Ответы бота, сохранённые в банк",
    "2 (с оценкой 1, без оценки 1, средняя 4)",
    "3 (с оценкой 2, без оценки 1, средняя 2,5)",
  ]);

  const none = buildWeeklyReport([], REF, {});
  assert.equal(none.bank, undefined);
  assert.ok(!weeklyTables(none)[0].rows.some((r) => /Ответы бота/.test(r[0])));
});
