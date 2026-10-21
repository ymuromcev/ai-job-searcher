// End-to-end `apply` run against the synthetic Greenhouse fixture with the
// real Playwright Chromium and the real adapter: pre → (LLM answers file) →
// submit --dry-run → submit. TSV and Notion are faked; the profile lives in
// a temp dir. Skips when Chromium is not installed.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const { makeApplyCommand } = require("./apply.js");
const { buildActiveCounts, resolveCapWindowDays } = require("./prepare.js");
const { browserStatus } = require("../modules/apply/browser.js");

const status = browserStatus();
const SKIP = status.ok ? false : `Playwright Chromium unavailable: ${status.reason}`;

const FIXTURE = pathToFileURL(
  path.join(__dirname, "..", "modules", "apply", "fixtures", "greenhouse_form.html")
).href;

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-e2e-"));
  fs.mkdirSync(path.join(root, "resumes"), { recursive: true });
  fs.writeFileSync(path.join(root, "resumes", "CV_Test_Candidate_Growth.pdf"), "%PDF-1.4\n%%EOF\n");
});
after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const store = {
    apps: [
      {
        key: "greenhouse:111",
        companyName: "Acme Synthetic",
        title: "Senior Product Manager",
        url: FIXTURE,
        status: "To Apply",
        notion_page_id: "page-1",
        resume_ver: "Growth",
        cl_path: "",
        fit_score: "Medium",
        applied_date: "",
        apply_state: "",
        apply_note: "",
        createdAt: "2026-10-20T00:00:00Z",
        updatedAt: "2026-10-20T00:00:00Z",
      },
    ],
  };
  const notionCalls = [];
  const profile = {
    id: "demo",
    identity: {
      name: "Test Candidate",
      email: "candidate@example.com",
      phone: "+1 555 010 0000",
      location: "Springfield, IL",
      linkedin: "linkedin.com/in/example",
    },
    applyDefaults: {
      work_authorization: { authorized_us: true, requires_sponsorship: false },
      relocation: { willing: false },
      eeo: { policy: "decline" },
      salary: { floor: 120000, default: 180000 },
      how_did_you_hear_default: "Company careers page",
    },
    filterRules: { company_cap: { max_active: 3, window_days: 30 } },
    notion: {},
    resumeVersions: { versions: { Growth: { filename: "CV_Test_Candidate_Growth.docx" } } },
    paths: {
      root,
      applicationsTsv: path.join(root, "applications.tsv"),
      resumesDir: path.join(root, "resumes"),
      jdCacheDir: path.join(root, "jd_cache"),
    },
  };
  const deps = {
    loadProfile: () => profile,
    loadSecrets: () => ({ NOTION_TOKEN: "t" }),
    loadApplications: () => ({ apps: store.apps.map((a) => ({ ...a })) }),
    saveApplications: (_p, list) => {
      store.apps = list.map((a) => ({ ...a }));
    },
    buildActiveCounts,
    resolveCapWindowDays,
    resolveUrl: async (url) => ({ ok: true, url, ats: "greenhouse", status: 0, hops: [] }),
    fetchJd: async () => ({ text: "The base pay range for this role is $150,000 - $190,000." }),
    makeNotionClient: () => ({}),
    fetchAllAnswers: async () => [],
    updatePageStatus: async (_c, pageId, s) => notionCalls.push([pageId, s]),
    today: () => "2026-10-21",
  };
  const out = [];
  const err = [];
  const run = (flags) =>
    makeApplyCommand(deps)({
      profileId: "demo",
      env: {},
      flags: { phase: "", dryRun: false, limit: null, concurrency: 2, answersFile: "", ...flags },
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    });
  return { run, store, notionCalls, out, err };
}

test(
  "apply e2e on the Greenhouse fixture: pre → dry-run → submit",
  { skip: SKIP, timeout: 120000 },
  async () => {
    const h = setup();

    assert.equal(await h.run({ phase: "pre" }), 0, h.err.join("\n"));
    const ctx = JSON.parse(
      fs.readFileSync(path.join(root, ".apply-state", "apply_context.json"), "utf8")
    );
    assert.equal(ctx.jobs.length, 1, JSON.stringify(ctx.manual));
    const job = ctx.jobs[0];
    assert.deepEqual(
      job.unanswered
        .filter((u) => u.required)
        .map((u) => u.label)
        .sort(),
      ["Have you ever worked for Acme Synthetic before?", "Why do you want to join Acme Synthetic?"]
    );
    assert.equal(job.answers.find((a) => a.field_id === "question_1005").value, "190000");
    assert.equal(h.store.apps[0].apply_state, "queued");

    const answersPath = path.join(root, "answers.json");
    fs.writeFileSync(
      answersPath,
      JSON.stringify({
        answers: [
          {
            key: job.key,
            label: "Why do you want to join Acme Synthetic?",
            answer: "Synthetic answer.",
            bank_page_id: null,
          },
          {
            key: job.key,
            label: "Have you ever worked for Acme Synthetic before?",
            answer: "No",
            bank_page_id: null,
          },
        ],
      })
    );

    assert.equal(
      await h.run({ phase: "submit", answersFile: answersPath, dryRun: true }),
      0,
      h.err.join("\n")
    );
    const shot = path.join(root, ".apply-state", "shots", "greenhouse_111.png");
    assert.ok(fs.existsSync(shot), "dry-run keeps a screenshot of the filled form");
    assert.equal(h.store.apps[0].status, "To Apply");

    assert.equal(await h.run({ phase: "submit", answersFile: answersPath }), 0, h.err.join("\n"));
    const r = h.store.apps[0];
    assert.equal(r.status, "Applied", h.out.join("\n"));
    assert.equal(r.applied_by, "bot");
    assert.equal(r.apply_state, "submitted");
    assert.equal(r.applied_date, "2026-10-21");
    assert.deepEqual(h.notionCalls, [["page-1", "Applied"]]);

    // A second submit run with the same context is a no-op (never double-apply).
    assert.equal(await h.run({ phase: "submit", answersFile: answersPath }), 0);
    assert.match(h.out.join("\n"), /0 submitted, 0 dry-run, 0 manual, 0 failed, 1 skipped/);
  }
);
