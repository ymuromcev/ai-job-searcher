const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRegistryView,
  parseReason,
  isTechnicalReason,
  atsFromUrl,
  hostOf,
  appliedByLabel,
} = require("./registry_view.js");

function row(overrides = {}) {
  return {
    key: "greenhouse:1",
    source: "greenhouse",
    companyName: "Acme",
    title: "Senior PM",
    url: "https://boards.greenhouse.io/acme/jobs/1",
    locations: ["Remote"],
    status: "To Apply",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    fit_score: "Strong",
    applied_date: "",
    ...overrides,
  };
}

test("responses: post-apply statuses and any row with applied_date are included", () => {
  const rows = [
    row({ key: "a", status: "Applied", applied_date: "2026-10-10", applied_by: "bot" }),
    row({ key: "b", status: "Interview", applied_date: "2026-10-12", applied_by: "manual" }),
    row({ key: "c", status: "Rejected", applied_date: "", applied_by: "legacy_bot" }),
    row({ key: "d", status: "No Response" }),
    row({ key: "e", status: "Closed" }),
    row({ key: "f", status: "Offer", applied_date: "2026-10-01" }),
    row({ key: "g", status: "Archived", applied_date: "2026-09-01" }),
    row({ key: "h", status: "To Apply" }),
    row({ key: "i", status: "Inbox" }),
    row({ key: "j", status: "Archived" }),
  ];
  const view = buildRegistryView(rows);
  assert.deepEqual(
    view.responses.map((r) => r.key).sort(),
    ["a", "b", "c", "d", "e", "f", "g"].sort()
  );
});

test("responses: sorted by applied_date desc, undated rows last", () => {
  const rows = [
    row({ key: "old", status: "Applied", applied_date: "2026-09-01" }),
    row({ key: "nodate", status: "Rejected", companyName: "Zed" }),
    row({ key: "new", status: "Applied", applied_date: "2026-10-15" }),
    row({ key: "mid", status: "Applied", applied_date: "2026-10-01" }),
  ];
  const view = buildRegistryView(rows);
  assert.deepEqual(
    view.responses.map((r) => r.key),
    ["new", "mid", "old", "nodate"]
  );
});

test("responses: row view model carries labels; missing v8 fields read as empty", () => {
  const view = buildRegistryView([
    row({ status: "Applied", applied_date: "2026-10-10", applied_by: "bot" }),
    row({ key: "x", status: "No Response", applied_date: "2026-10-09" }), // no applied_by at all
  ]);
  const [bot, none] = view.responses;
  assert.equal(bot.company, "Acme");
  assert.equal(bot.title, "Senior PM");
  assert.equal(bot.applied_by_label, "бот");
  assert.equal(bot.status_label, "подано");
  assert.equal(bot.fit_score, "Strong");
  assert.equal(bot.url, "https://boards.greenhouse.io/acme/jobs/1");
  assert.equal(none.applied_by, "");
  assert.equal(none.applied_by_label, "—");
  assert.equal(none.status_label, "нет ответа");
});

test("appliedByLabel maps all known values", () => {
  assert.equal(appliedByLabel("bot"), "бот");
  assert.equal(appliedByLabel("manual"), "сам");
  assert.equal(appliedByLabel("legacy_bot"), "старый бот");
  assert.equal(appliedByLabel(""), "—");
  assert.equal(appliedByLabel(undefined), "—");
});

test("todo: only apply_state manual / failed, with Russian reasons", () => {
  const rows = [
    row({
      key: "m1",
      apply_state: "manual",
      apply_note: "captcha",
      updatedAt: "2026-10-02T00:00:00Z",
    }),
    row({
      key: "m2",
      apply_state: "manual",
      apply_note: "unsupported_ats:jobs.example.com",
      updatedAt: "2026-10-05T00:00:00Z",
    }),
    row({
      key: "f1",
      apply_state: "failed",
      apply_note: "no_confirmation",
      updatedAt: "2026-10-03T00:00:00Z",
    }),
    row({ key: "q", apply_state: "queued" }),
    row({ key: "s", apply_state: "submitted", status: "Applied", applied_date: "2026-10-01" }),
  ];
  const view = buildRegistryView(rows);
  assert.deepEqual(
    view.todo.map((r) => [r.key, r.apply_state_label, r.reason]),
    [
      ["m2", "руками", "сайт подачи не поддерживается: jobs.example.com"],
      ["f1", "ошибка", "после отправки нет подтверждения"],
      ["m1", "руками", "капча"],
    ]
  );
  assert.equal(view.todo[0].url, "https://boards.greenhouse.io/acme/jobs/1");
});

test("parseReason: known codes, details, unsupported host, unknown raw, empty", () => {
  assert.deepEqual(parseReason("captcha"), { code: "captcha", detail: "", label: "капча" });
  assert.equal(parseReason("login_required").label, "нужен вход в аккаунт");
  assert.equal(parseReason("no_honest_answer").label, "нет честного ответа на вопрос формы");
  assert.deepEqual(parseReason("unsupported_ats:apply.workday.com"), {
    code: "unsupported_ats",
    detail: "apply.workday.com",
    label: "сайт подачи не поддерживается: apply.workday.com",
  });
  assert.equal(
    parseReason("no_confirmation: page did not change").label,
    "после отправки нет подтверждения (page did not change)"
  );
  assert.equal(parseReason("weird_new_code").label, "weird_new_code");
  assert.equal(parseReason("Something odd happened").label, "Something odd happened");
  assert.deepEqual(parseReason(""), { code: "", detail: "", label: "" });
  assert.deepEqual(parseReason(undefined), { code: "", detail: "", label: "" });
});

test("todo: empty note shows a placeholder, never blank", () => {
  const view = buildRegistryView([row({ apply_state: "failed", apply_note: "" })]);
  assert.equal(view.todo[0].reason, "причина не указана");
});

test("isTechnicalReason: candidate-side reasons are not technical", () => {
  for (const c of ["captcha", "login_required", "account_required", "no_honest_answer"]) {
    assert.equal(isTechnicalReason(c), false, c);
  }
  assert.equal(isTechnicalReason("no_confirmation"), true);
  assert.equal(isTechnicalReason(""), true);
});

test("summary counts", () => {
  const rows = [
    row({ key: "a", status: "Applied", applied_date: "2026-10-10", applied_by: "bot" }),
    row({ key: "b", status: "Interview", applied_date: "2026-10-12", applied_by: "bot" }),
    row({ key: "c", status: "Offer", applied_date: "2026-10-12", applied_by: "manual" }),
    row({ key: "d", status: "Rejected", applied_by: "legacy_bot" }),
    row({ key: "e", status: "No Response" }),
    row({ key: "m", apply_state: "manual" }),
    row({ key: "f", apply_state: "failed" }),
    row({ key: "f2", apply_state: "failed" }),
    row({ key: "q", apply_state: "queued" }),
  ];
  const { summary } = buildRegistryView(rows);
  assert.equal(summary.applied, 5);
  assert.deepEqual(summary.byAppliedBy, { bot: 2, manual: 1, legacy_bot: 1, unknown: 1 });
  assert.equal(summary.interviews, 2);
  assert.equal(summary.offers, 1);
  assert.equal(summary.rejected, 1);
  assert.equal(summary.manual, 1);
  assert.equal(summary.failed, 2);
  assert.equal(summary.todo, 3);
  assert.equal(summary.queued, 1);
});

test("empty / missing input gives empty view", () => {
  for (const input of [[], undefined, null]) {
    const view = buildRegistryView(input);
    assert.deepEqual(view.responses, []);
    assert.deepEqual(view.todo, []);
    assert.equal(view.summary.applied, 0);
  }
});

test("atsFromUrl / hostOf", () => {
  assert.equal(atsFromUrl("https://boards.greenhouse.io/x/jobs/1"), "Greenhouse");
  assert.equal(atsFromUrl("https://job-boards.greenhouse.io/x/jobs/1"), "Greenhouse");
  assert.equal(atsFromUrl("https://jobs.lever.co/x/abc"), "Lever");
  assert.equal(atsFromUrl("https://jobs.ashbyhq.com/x/abc"), "Ashby");
  assert.equal(atsFromUrl("https://acme.wd5.myworkdayjobs.com/x"), "Workday");
  assert.equal(atsFromUrl("https://www.careers.example.com/x"), "careers.example.com");
  assert.equal(atsFromUrl("not a url"), "");
  assert.equal(atsFromUrl(""), "");
  assert.equal(hostOf("https://WWW.Example.com/a"), "example.com");
});
