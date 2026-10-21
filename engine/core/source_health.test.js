const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildSourceHealth, sourceName, SOURCE_NAMES } = require("./source_health.js");

const NOW = "2026-10-21T12:00:00Z";

function hoursAgo(h) {
  return new Date(Date.parse(NOW) - h * 3600 * 1000).toISOString();
}
function run(source, h, found = 5, error = null) {
  return { ts: hoursAgo(h), source, found, error };
}
function sourceRow(result, key) {
  return result.sources.find((s) => s.key === key);
}

// --- job sources -----------------------------------------------------------

test("source: «Ещё не запускался» for a configured module with no runs", () => {
  const r = buildSourceHealth({ modules: ["discovery:greenhouse"], now: NOW });
  const g = sourceRow(r, "greenhouse");
  assert.equal(g.status_label, "Ещё не запускался");
  assert.equal(g.name, "Greenhouse");
  assert.equal(g.last_run, "");
  assert.equal(g.found_7d, 0);
});

test("source: «Работает» when the last run had no error", () => {
  const r = buildSourceHealth({
    runs: [run("lever", 2, 7), run("lever", 26, 3)],
    modules: ["discovery:lever"],
    now: NOW,
  });
  const l = sourceRow(r, "lever");
  assert.equal(l.status, "ok");
  assert.equal(l.status_label, "Работает");
  assert.equal(l.found_7d, 10);
  assert.equal(l.last_run, "2026-10-21");
  assert.equal(l.last_error, "");
});

test("source: «Работает, но вакансий нет» when every run of the last 7 days found 0", () => {
  const r = buildSourceHealth({
    runs: [run("ashby", 2, 0), run("ashby", 30, 0), run("ashby", 100, 0), run("ashby", 24 * 9, 12)],
    now: NOW,
  });
  assert.equal(sourceRow(r, "ashby").status_label, "Работает, но вакансий нет");
});

test("source: «Сбоит» — latest OK with an error among the last 3", () => {
  const r = buildSourceHealth({
    runs: [run("workday", 2, 4), run("workday", 26, 0, "HTTP 500"), run("workday", 50, 3)],
    now: NOW,
  });
  const w = sourceRow(r, "workday");
  assert.equal(w.status_label, "Сбоит");
  assert.equal(w.last_error, "HTTP 500");
});

test("source: «Сбоит» — latest error with an OK run earlier in the last 3", () => {
  const r = buildSourceHealth({
    runs: [run("taleo", 2, 0, "timeout"), run("taleo", 26, 0, "timeout"), run("taleo", 50, 3)],
    now: NOW,
  });
  assert.equal(sourceRow(r, "taleo").status_label, "Сбоит");
});

test("source: «Не работает» — last 3 runs all errors (older OK runs don't matter)", () => {
  const r = buildSourceHealth({
    runs: [
      run("icims", 2, 0, "403"),
      run("icims", 26, 0, "403"),
      run("icims", 50, 0, "403"),
      run("icims", 74, 9),
    ],
    now: NOW,
  });
  assert.equal(sourceRow(r, "icims").status_label, "Не работает");
});

test("source: «Не работает» — a single run that errored", () => {
  const r = buildSourceHealth({ runs: [run("usajobs", 2, 0, "401 Unauthorized")], now: NOW });
  assert.equal(sourceRow(r, "usajobs").status_label, "Не работает");
});

test("source: «Давно не запускался» — no run in the last 3 days", () => {
  const r = buildSourceHealth({ runs: [run("adzuna", 24 * 4, 30)], now: NOW });
  const a = sourceRow(r, "adzuna");
  assert.equal(a.status_label, "Давно не запускался");
  assert.equal(a.found_7d, 30);
});

test("source: long errors are shortened; sources sorted worst first", () => {
  const r = buildSourceHealth({
    runs: [run("lever", 1, 5), run("remoteok", 1, 0, "x".repeat(500))],
    modules: ["discovery:greenhouse"],
    now: NOW,
  });
  assert.deepEqual(
    r.sources.map((s) => s.key),
    ["remoteok", "greenhouse", "lever"]
  );
  assert.ok(r.sources[0].last_error.length <= 120);
});

test("source: human names for every adapter key; unknown key shown raw", () => {
  const expected = {
    greenhouse: "Greenhouse",
    lever: "Lever",
    ashby: "Ashby",
    workday: "Workday",
    smartrecruiters: "SmartRecruiters",
    icims: "iCIMS",
    oracle_cloud: "Oracle Cloud",
    taleo: "Taleo",
    workable: "Workable",
    ultipro: "UltiPro",
    adzuna: "Adzuna",
    the_muse: "The Muse",
    remoteok: "RemoteOK",
    usajobs: "USAJOBS",
    calcareers: "CalCareers",
    indeed: "Indeed",
    jobsyn: "Jobsyn",
  };
  assert.deepEqual(SOURCE_NAMES, expected);
  assert.equal(sourceName("brand_new"), "brand_new");
});

test("source: every discovery adapter in the registry has a human name", () => {
  const { listAdapters } = require("../modules/discovery/index.js");
  for (const key of listAdapters()) assert.ok(SOURCE_NAMES[key], key);
});

test("source: ignores non-discovery modules and malformed runs", () => {
  const r = buildSourceHealth({
    runs: [{ ts: "garbage", source: "lever" }, null],
    modules: ["tailor:x", "discovery:lever", 42],
    now: NOW,
  });
  assert.deepEqual(
    r.sources.map((s) => [s.key, s.status]),
    [["lever", "never"]]
  );
});

// --- application sites -----------------------------------------------------

const GH = "https://boards.greenhouse.io/acme/jobs/";
function attempt(i, state, opts = {}) {
  return {
    key: `gh:${i}`,
    url: opts.url || `${GH}${i}`,
    status: state === "submitted" ? "Applied" : "To Apply",
    apply_state: state,
    apply_note: opts.note || "",
    applied_date: state === "submitted" ? opts.applied || "2026-10-20" : "",
    updatedAt: opts.updated || hoursAgo(i + 1),
  };
}
function site(result, name) {
  return result.sites.find((s) => s.name === name);
}

test("sites: supported sites always listed; «Пока не подавал» without attempts", () => {
  const r = buildSourceHealth({ rows: [], now: NOW });
  assert.deepEqual(
    r.sites.map((s) => [s.name, s.status_label]),
    [
      ["Greenhouse", "Пока не подавал"],
      ["Lever", "Пока не подавал"],
      ["Ashby", "Пока не подавал"],
    ]
  );
});

test("sites: «Работает» — a recent submission and few failures", () => {
  const rows = [];
  for (let i = 0; i < 9; i++) rows.push(attempt(i, "submitted"));
  rows.push(attempt(9, "failed", { note: "no_confirmation" }));
  rows.push(attempt(10, "manual", { note: "captcha" }));
  const g = site(buildSourceHealth({ rows, now: NOW }), "Greenhouse");
  assert.equal(g.status_label, "Работает");
  assert.equal(g.submitted_7d, 9);
  assert.equal(g.errors_last20, 1);
  assert.equal(g.attempts_last20, 11);
});

test("sites: «Сбоит» — failed share of the last 20 attempts ≥ 20%", () => {
  const rows = [];
  for (let i = 0; i < 4; i++) rows.push(attempt(i, "submitted"));
  rows.push(attempt(4, "failed", { note: "no_confirmation" }));
  const g = site(buildSourceHealth({ rows, now: NOW }), "Greenhouse");
  assert.equal(g.status_label, "Сбоит");
  assert.equal(g.top_reason, "после отправки нет подтверждения");
});

test("sites: «Не работает» — last 5 attempts all technical failures", () => {
  const rows = [
    attempt(0, "failed", { note: "no_confirmation" }),
    attempt(1, "manual", { note: "form_changed" }),
    attempt(2, "failed", { note: "required_field_missing" }),
    attempt(3, "failed", { note: "no_confirmation" }),
    attempt(4, "failed", { note: "no_confirmation" }),
    attempt(5, "submitted"),
  ];
  const g = site(buildSourceHealth({ rows, now: NOW }), "Greenhouse");
  assert.equal(g.status_label, "Не работает");
  assert.equal(g.top_reason, "после отправки нет подтверждения");
});

test("sites: captcha / login manual rows do not make a site «Не работает»", () => {
  const rows = [];
  for (let i = 0; i < 5; i++)
    rows.push(attempt(i, "manual", { note: i % 2 ? "captcha" : "login_required" }));
  rows.push(attempt(6, "submitted"));
  const g = site(buildSourceHealth({ rows, now: NOW }), "Greenhouse");
  assert.notEqual(g.status, "broken");
  assert.equal(g.status_label, "Работает");
});

test("sites: «Давно не подавал» — healthy but nothing submitted in 7 days", () => {
  const rows = [attempt(0, "submitted", { applied: "2026-10-01" })];
  const g = site(buildSourceHealth({ rows, now: NOW }), "Greenhouse");
  assert.equal(g.status_label, "Давно не подавал");
  assert.equal(g.submitted_7d, 0);
});

test("sites: only the last 20 attempts count toward the failure share", () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(attempt(i, "submitted", { applied: "2026-10-21" }));
  for (let i = 20; i < 30; i++) {
    rows.push(attempt(i, "failed", { note: "no_confirmation", updated: "2026-10-10T00:00:00Z" }));
  }
  const g = site(buildSourceHealth({ rows, now: NOW }), "Greenhouse");
  assert.equal(g.status_label, "Работает");
  assert.equal(g.errors_last20, 0);
});

test("sites: unsupported hosts grouped with waiting count and hand-made applications", () => {
  const rows = [
    attempt(0, "manual", {
      note: "unsupported_ats:acme.wd5.myworkdayjobs.com",
      url: "https://acme.wd5.myworkdayjobs.com/a",
    }),
    attempt(1, "manual", {
      note: "unsupported_ats:acme.wd5.myworkdayjobs.com",
      url: "https://acme.wd5.myworkdayjobs.com/b",
    }),
    attempt(2, "manual", {
      note: "unsupported_ats:careers.other.com",
      url: "https://careers.other.com/c",
    }),
    {
      key: "done",
      url: "https://careers.other.com/d",
      status: "Applied",
      applied_by: "manual",
      apply_state: "manual",
      apply_note: "unsupported_ats:careers.other.com",
      applied_date: "2026-10-19",
      updatedAt: hoursAgo(10),
    },
  ];
  const r = buildSourceHealth({ rows, now: NOW });
  const wd = site(r, "acme.wd5.myworkdayjobs.com");
  assert.equal(wd.status_label, "Не поддерживается — подаёшь руками (ждут: 2)");
  assert.equal(wd.waiting, 2);
  const other = site(r, "careers.other.com");
  assert.equal(other.waiting, 1);
  assert.equal(other.submitted_7d, 1);
  // Order: supported, then unsupported by waiting desc.
  assert.deepEqual(
    r.sites.map((s) => s.name),
    ["Greenhouse", "Lever", "Ashby", "acme.wd5.myworkdayjobs.com", "careers.other.com"]
  );
});

test("sites: rows without an apply attempt are ignored", () => {
  const rows = [
    { url: `${GH}1`, status: "Applied", applied_date: "2026-10-20", apply_state: "" },
    { url: `${GH}2`, status: "To Apply", apply_state: "queued" },
  ];
  const g = site(buildSourceHealth({ rows, now: NOW }), "Greenhouse");
  assert.equal(g.status_label, "Пока не подавал");
});

test("now accepts a Date; rejects garbage", () => {
  assert.ok(buildSourceHealth({ now: new Date(NOW) }));
  assert.throws(() => buildSourceHealth({ now: "nope" }), /invalid "now"/);
});
