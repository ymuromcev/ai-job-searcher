const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const morning = require("./morning_report.js");

const SINCE = "2026-11-10T05:00:00.000Z";
const NOW = new Date("2026-11-10T19:00:00.000Z");
const APPS = [
  { key: "s", companyName: "Acme", title: "PM", fit_score: "Strong" },
  { key: "m", companyName: "Beta", title: "Senior PM", fit_score: "Medium" },
  { key: "w", companyName: "Gamma", title: "PM", fit_score: "Weak" },
  { key: "x", companyName: "Delta", title: "PM", fit_score: "Medium" },
];

function files() {
  return [
    {
      kind: "pre",
      data: {
        generated_at: "2026-11-10T06:00:00.000Z",
        jobs: [{ key: "s" }, { key: "m" }, { key: "w" }, { key: "x" }],
        manual: [{ key: "u", reason: "unsupported_ats:x.com" }],
        skipped: [{ key: "d", reason: "url_dead" }],
      },
    },
    {
      kind: "results",
      data: {
        generated_at: "2026-11-10T10:00:00.000Z",
        results: [
          { key: "m", outcome: "submitted", evidence: { email: "thanks" } },
          { key: "w", outcome: "manual", reason: "captcha" },
          { key: "x", outcome: "skipped", reason: "required_empty" },
          { key: "s", outcome: "skipped", reason: "deadline" },
        ],
      },
    },
    {
      kind: "results",
      data: {
        generated_at: "2026-11-10T11:00:00.000Z",
        results: [
          { key: "s", outcome: "submitted" },
          { key: "m", outcome: "skipped", reason: "already_applied" },
          { key: "w", outcome: "submitted" },
        ],
      },
    },
    // Yesterday and dry runs never count.
    {
      kind: "results",
      data: {
        generated_at: "2026-11-09T10:00:00.000Z",
        results: [{ key: "old", outcome: "submitted" }],
      },
    },
    {
      kind: "results",
      data: {
        generated_at: "2026-11-10T12:00:00.000Z",
        dry_run: true,
        results: [{ key: "x", outcome: "submitted" }],
      },
    },
  ];
}

test("buildMorningReport: distinct submitted jobs split by fit, in time order", () => {
  const r = morning.buildMorningReport({
    date: "2026-11-10",
    since: SINCE,
    now: NOW,
    target: 30,
    apps: APPS,
    applyFiles: files(),
    night: { stop_reason: "deadline" },
  });
  assert.deepEqual(r.submitted, { total: 3, strong: 1, medium: 1, weak: 1, other: 0 });
  assert.deepEqual(
    r.applications.map((a) => [a.key, a.company, a.fit, a.confirmation]),
    [
      ["m", "Beta", "Medium", "email"],
      ["s", "Acme", "Strong", "page"],
      ["w", "Gamma", "Weak", "page"],
    ]
  );
  assert.equal(r.applications[1].at, "2026-11-10T11:00:00.000Z");
  assert.equal(r.generated_at, NOW.toISOString());
});

test("buildMorningReport: one line of skip reasons, submitted rows and already_applied left out", () => {
  const r = morning.buildMorningReport({
    date: "2026-11-10",
    since: SINCE,
    now: NOW,
    target: 30,
    apps: APPS,
    applyFiles: files(),
    night: { stop_reason: "deadline" },
  });
  assert.deepEqual(r.skips, [
    { reason: "required_empty", count: 1 },
    { reason: "unsupported_ats:x.com", count: 1 },
    { reason: "url_dead", count: 1 },
  ]);
  assert.equal(r.skip_line, "required_empty 1 · unsupported_ats:x.com 1 · url_dead 1");
});

test("buildMorningReport: why it stopped below the target", () => {
  const base = { date: "d", since: SINCE, now: NOW, apps: APPS, applyFiles: files() };
  const below = morning.buildMorningReport({
    ...base,
    target: 30,
    night: { stop_reason: "usage_budget" },
  });
  assert.equal(below.below_target, true);
  assert.equal(below.why_below_target, "usage_budget");
  assert.match(below.why_text, /лимит/);
  const running = morning.buildMorningReport({ ...base, target: 30, night: { running: true } });
  assert.equal(running.why_below_target, "night_running");
  const none = morning.buildMorningReport({ ...base, target: 30, night: null });
  assert.equal(none.why_below_target, "no_night");
  const reached = morning.buildMorningReport({
    ...base,
    target: 3,
    night: { stop_reason: "target_reached" },
  });
  assert.equal(reached.below_target, false);
  assert.equal(reached.why_below_target, null);
  assert.equal(reached.why_text, null);
});

test("notificationText / morningPath / pickLatestMorning", () => {
  const r = morning.buildMorningReport({
    date: "2026-11-10",
    since: SINCE,
    now: NOW,
    target: 30,
    apps: APPS,
    applyFiles: files(),
    night: { stop_reason: "deadline" },
  });
  const text = morning.notificationText(r);
  assert.match(text, /^Подано 3 из 30 \(Strong 1 · Medium 1 · Weak 1\)/);
  assert.match(text, /Меньше цели: наступило время остановки/);
  assert.match(text, /Пропуски: required_empty 1/);
  assert.equal(
    morning.morningPath("/p", "2026-11-10"),
    path.join("/p", ".health", "morning-2026-11-10.json")
  );
  assert.equal(
    morning.pickLatestMorning([
      "morning-2026-11-09.json",
      "morning-2026-11-10.json",
      "morning-2026-11-10.notified",
      "apply_runs.jsonl",
    ]),
    "morning-2026-11-10.json"
  );
  assert.equal(morning.pickLatestMorning([]), null);
});

test("guard skips are not skip reasons; warnings reach the report and the notification", () => {
  const report = morning.buildMorningReport({
    date: "2026-11-10",
    since: SINCE,
    now: NOW,
    target: 30,
    apps: APPS,
    applyFiles: [
      {
        kind: "pre",
        data: {
          generated_at: "2026-11-10T06:00:00.000Z",
          skipped: [{ key: "dup", reason: "duplicate_job" }],
        },
      },
      {
        kind: "results",
        data: {
          generated_at: "2026-11-10T07:00:00.000Z",
          results: [
            { key: "a", outcome: "skipped", reason: "deadline" },
            { key: "b", outcome: "skipped", reason: "interrupted_submit" },
            { key: "c", outcome: "skipped", reason: "already_applied" },
            { key: "d", outcome: "skipped", reason: "status_Closed" },
            { key: "e", outcome: "skipped", reason: "row_missing" },
            { key: "f", outcome: "skipped", reason: "captcha" },
          ],
        },
      },
    ],
    night: { stop_reason: "deadline" },
    warnings: ["submitter_not_running", "submitter_not_running"],
  });
  assert.deepEqual(report.skips, [{ reason: "captcha", count: 1 }]);
  assert.equal(report.skip_line, "captcha 1");
  assert.deepEqual(report.warnings, ["submitter_not_running"]);
  assert.match(morning.notificationText(report), /Внимание: отправка не запускалась/);
});

test("buildMorningReport: re-submitted thanks to the owner's answers + waiting questions (RFC 070)", () => {
  const report = morning.buildMorningReport({
    date: "2026-11-10",
    since: SINCE,
    now: NOW,
    target: 30,
    apps: APPS,
    applyFiles: files(),
    night: { stop_reason: "deadline" },
    questions: {
      waiting: 3,
      view_url: "https://www.notion.so/qa",
      // "s" and "w" went out tonight; "x" was requeued but not submitted.
      requeued: [{ key: "s" }, { key: "w" }, { key: "x" }, null],
    },
  });
  assert.deepEqual(report.answers, {
    resubmitted: 2,
    waiting: 3,
    view_url: "https://www.notion.so/qa",
  });
  assert.equal(report.answers_line, "подано заново по твоим ответам: 2 · ждут твоего ответа: 3");
  assert.match(
    morning.notificationText(report),
    /\. Подано заново по твоим ответам: 2 · ждут твоего ответа: 3/
  );
  const none = morning.buildMorningReport({
    date: "2026-11-10",
    since: SINCE,
    now: NOW,
    target: 30,
    apps: APPS,
    applyFiles: files(),
  });
  assert.deepEqual(none.answers, { resubmitted: 0, waiting: 0, view_url: null });
  assert.equal(none.answers_line, "");
  assert.doesNotMatch(morning.notificationText(none), /ответ/);
});

// RFC 071 / BL-234 — morning mail check summary and lines.
test("mailCheckSummary: invites at any confidence, HIGH rejections and info requests", () => {
  const log = {
    results: [
      { company: "Acme", role: "Product Manager", match: "LOW", type: "INTERVIEW_INVITE" },
      { company: "Beta", role: "Sr PM", match: "HIGH", type: "REJECTION" },
      { company: "Gamma", role: "PM", match: "LOW", type: "REJECTION" },
      { company: "?", role: "?", match: "NONE", type: "REJECTION" },
      { company: "Delta", role: "PM", match: "HIGH", type: "INFO_REQUEST" },
      { company: "Eps", role: "PM", match: "HIGH", type: "ACKNOWLEDGMENT" },
    ],
  };
  const s = morning.mailCheckSummary(log);
  assert.deepEqual(s.interviews, [{ company: "Acme", role: "Product Manager" }]);
  assert.equal(s.rejections, 1);
  assert.deepEqual(s.info_requests, [{ company: "Delta", role: "PM" }]);
  assert.equal(morning.mailCheckLine(s), "Почта: 1 приглашение, 1 запрос от работодателя, 1 отказ");
  assert.equal(morning.interviewNotificationText(s), "Acme — Product Manager");
});

test("mailCheckLine: nothing found or no run → empty", () => {
  assert.equal(morning.mailCheckLine(null), "");
  assert.equal(morning.mailCheckLine(morning.mailCheckSummary({ results: [] })), "");
  assert.equal(morning.interviewNotificationText(null), "");
  const many = { interviews: [], info_requests: [], rejections: 5 };
  assert.equal(morning.mailCheckLine(many), "Почта: 5 отказов");
});

test("interviewNotificationText: the same invite twice is listed once", () => {
  const s = {
    interviews: [
      { company: "Acme", role: "PM" },
      { company: "Acme", role: "PM" },
    ],
    info_requests: [],
    rejections: 0,
  };
  assert.equal(morning.interviewNotificationText(s), "Acme — PM");
});
