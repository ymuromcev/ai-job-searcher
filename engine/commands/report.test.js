const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const applications = require("../core/applications_tsv.js");
const { makeReportCommand, defaultReportsDir } = require("./report.js");

function capture() {
  const out = [];
  const err = [];
  return { stdout: (s) => out.push(s), stderr: (s) => err.push(s), out, err };
}

function makeTempProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aijs-report-"));
  const profilesDir = path.join(root, "profiles");
  const profileDir = path.join(profilesDir, "demo");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "profile.json"), JSON.stringify({ id: "demo" }));
  applications.save(path.join(profileDir, "applications.tsv"), [
    {
      key: "greenhouse:1",
      source: "greenhouse",
      jobId: "1",
      companyName: "Acme",
      title: "Senior PM",
      url: "https://boards.greenhouse.io/acme/jobs/1",
      locations: ["San Francisco, CA"],
      status: "Interview",
      createdAt: "2026-10-10T00:00:00Z",
      updatedAt: "2026-10-12T00:00:00Z",
      fit_score: "Strong",
      applied_date: "2026-10-12",
    },
  ]);
  return { root, profilesDir, profileDir };
}

function ctxFor(t, flags, io, env = {}) {
  return {
    command: "report",
    profileId: "demo",
    flags,
    env,
    profilesDir: t.profilesDir,
    stdout: io.stdout,
    stderr: io.stderr,
  };
}

test("report --weekly writes weekly-<date>.html into --out and prints the path", async () => {
  const t = makeTempProfile();
  const outDir = path.join(t.root, "out");
  const io = capture();
  const cmd = makeReportCommand({ today: () => "2026-10-14", now: () => "2026-10-14T09:00:00Z" });
  const tsvBefore = fs.readFileSync(path.join(t.profileDir, "applications.tsv"), "utf8");

  const code = await cmd(ctxFor(t, { weekly: true, out: outDir }, io));
  assert.equal(code, 0);
  const file = path.join(outDir, "weekly-2026-10-14.html");
  assert.deepEqual(io.out, [file]);
  const html = fs.readFileSync(file, "utf8");
  assert.match(html, /Отклики за неделю — demo/);
  assert.match(html, /<td>Подано<\/td>\n<td>1<\/td>/);
  assert.doesNotMatch(html, /<script/);
  // Read-only on the TSV.
  assert.equal(fs.readFileSync(path.join(t.profileDir, "applications.tsv"), "utf8"), tsvBefore);
  // No temp files left behind.
  assert.deepEqual(fs.readdirSync(outDir), ["weekly-2026-10-14.html"]);
});

test("report --weekly includes the nightly runs from .health/apply_runs.jsonl", async () => {
  const t = makeTempProfile();
  const outDir = path.join(t.root, "out");
  fs.mkdirSync(path.join(t.profileDir, ".health"), { recursive: true });
  const started = new Date(2026, 9, 13, 22, 0, 0).toISOString();
  fs.writeFileSync(
    path.join(t.profileDir, ".health", "apply_runs.jsonl"),
    JSON.stringify({ started_at: started, submitted: 41, target: 100, stop_reason: "deadline" }) +
      "\n"
  );
  const io = capture();
  const cmd = makeReportCommand({ today: () => "2026-10-14", now: () => "2026-10-14T09:00:00Z" });
  assert.equal(await cmd(ctxFor(t, { weekly: true, out: outDir }, io)), 0);
  const html = fs.readFileSync(path.join(outDir, "weekly-2026-10-14.html"), "utf8");
  assert.match(html, /<h2>Ночные запуски<\/h2>/);
  assert.match(html, /<td>41 из 100<\/td>/);
  assert.match(html, /<td>время вышло<\/td>/);
});

test("report without --weekly is an error", async () => {
  const t = makeTempProfile();
  const io = capture();
  const code = await makeReportCommand()(ctxFor(t, { weekly: false, out: "" }, io));
  assert.equal(code, 1);
  assert.match(io.err.join("\n"), /--weekly/);
});

test("report default dir: $AI_JOB_SEARCHER_DATA_DIR/reports, else <repo>/data/reports", async () => {
  const t = makeTempProfile();
  const dataDir = path.join(t.root, "data-dir");
  assert.equal(
    defaultReportsDir({ AI_JOB_SEARCHER_DATA_DIR: dataDir }),
    path.join(dataDir, "reports")
  );
  assert.equal(
    defaultReportsDir({}),
    path.join(path.resolve(__dirname, "..", ".."), "data", "reports")
  );

  const io = capture();
  const cmd = makeReportCommand({ today: () => "2026-10-14" });
  const code = await cmd(
    ctxFor(t, { weekly: true, out: "" }, io, { AI_JOB_SEARCHER_DATA_DIR: dataDir })
  );
  assert.equal(code, 0);
  assert.ok(fs.existsSync(path.join(dataDir, "reports", "weekly-2026-10-14.html")));
});
