const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  appendRecruiterLeads,
  appendRejectionLog,
  appendCheckLog,
  buildSummary,
} = require("./email_logs.js");

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "emlogs-")), name);
}

test("appendRecruiterLeads: creates header + row on first call", () => {
  const fp = tmpFile("rl.md");
  appendRecruiterLeads(fp, [
    { date: "2026-04-20", agency: "Acme Staffing", role: "PM", contact: "a@x.com", subject: "Role | X" },
  ]);
  const out = fs.readFileSync(fp, "utf8");
  assert.match(out, /# Recruiter Leads/);
  assert.match(out, /\| 2026-04-20 \| Acme Staffing \| PM \|/);
  assert.match(out, /Role \/ X/, "pipe in subject replaced with slash");
});

test("appendRecruiterLeads: noop on empty input", () => {
  const fp = tmpFile("rl.md");
  appendRecruiterLeads(fp, []);
  assert.ok(!fs.existsSync(fp));
});

test("appendRejectionLog: creates file with table on first call", () => {
  const fp = tmpFile("rej.md");
  appendRejectionLog(fp, [
    { company: "Acme", role: "Sr PM", level: "Senior", arch: "Risk_Fraud", prevApplied: true },
  ], new Date("2026-04-20T00:00:00Z"));
  const out = fs.readFileSync(fp, "utf8");
  assert.match(out, /# Rejection Log/);
  assert.match(out, /\| Acme \| Sr PM \| Senior \|/);
});

test("appendRejectionLog: inserts before '## Patterns Observed'", () => {
  const fp = tmpFile("rej.md");
  fs.writeFileSync(
    fp,
    "# Rejection Log\n\n- **Rejected**: 5\n- **Pending (Applied)**: 10\n\n## Rejections\n\n| Date | Company | Role | Level | Fit Score | CV Archetype | Possible Reason | Notes |\n|---|---|---|---|---|---|---|---|\n| 2026-04-01 | Old | Role | Senior | — | — | — | — |\n\n## Patterns Observed\n\nstuff\n"
  );
  appendRejectionLog(fp, [
    { company: "NewCo", role: "PM", level: "Mid", arch: "Growth", prevApplied: true },
  ]);
  const out = fs.readFileSync(fp, "utf8");
  assert.ok(out.indexOf("NewCo") < out.indexOf("## Patterns Observed"), "new row above patterns");
  assert.match(out, /\*\*Rejected\*\*: 6/);
  assert.match(out, /\*\*Pending \(Applied\)\*\*: 9/);
});

test("buildSummary: empty → default message", () => {
  assert.equal(buildSummary({}), "Новых ответов по вакансиям не найдено.");
});

test("buildSummary: 1 rejection → RU text", () => {
  const out = buildSummary({
    rejections: [{ company: "Acme" }],
    logRows: [{ type: "REJECTION", action: "queued: Status → Rejected" }],
    actionCount: 1,
  });
  assert.match(out, /1 отказ \(Acme\)/);
});

test("buildSummary: interview invite", () => {
  const out = buildSummary({
    logRows: [{ type: "INTERVIEW_INVITE", action: "queued: Status → Phone Screen", company: "Block" }],
    actionCount: 1,
  });
  assert.match(out, /🔔 1 приглашение на интервью \(Block\)/);
});

test("buildSummary: inbox additions + recruiter leads", () => {
  const out = buildSummary({
    logRows: [
      { type: "LINKEDIN_LEAD", action: "→ Inbox" },
      { type: "RECRUITER_OUTREACH", action: "→ recruiter_leads.md" },
    ],
    inboxAdded: 1,
    recruiterLeadsCount: 1,
  });
  assert.match(out, /📥 1 новых в Inbox/);
  assert.match(out, /📋 1 рекрутерских лидов/);
});

test("appendCheckLog: creates file with header + entry", () => {
  const fp = tmpFile("chk.md");
  appendCheckLog(fp, {
    logRows: [{ id: "m1", company: "Acme", role: "PM", match: "HIGH", type: "REJECTION", action: "queued", comment: "✅" }],
    actionCount: 1,
    now: new Date("2026-04-20T12:00:00Z"),
  });
  const out = fs.readFileSync(fp, "utf8");
  assert.match(out, /# Email Check Log/);
  assert.match(out, /## Check: 2026-04-20 12:00/);
  assert.match(out, /Acme.*PM.*HIGH.*REJECTION/);
});

test("appendCheckLog: inserts new entry newest-first", () => {
  const fp = tmpFile("chk.md");
  appendCheckLog(fp, {
    logRows: [],
    now: new Date("2026-04-19T10:00:00Z"),
  });
  appendCheckLog(fp, {
    logRows: [],
    now: new Date("2026-04-20T12:00:00Z"),
  });
  const out = fs.readFileSync(fp, "utf8");
  const i19 = out.indexOf("2026-04-19");
  const i20 = out.indexOf("2026-04-20");
  assert.ok(i20 < i19 && i20 > 0, "newest entry should be first");
});
