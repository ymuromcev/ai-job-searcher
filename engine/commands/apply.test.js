// `apply` command tests with every I/O dep faked (no browser, no network,
// no disk). The adapter fake scripts each ATS outcome by URL.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  makeApplyCommand,
  resolveFields,
  buildFillPlan,
  searchBank,
  loadAnswersFile,
  alreadyApplied,
} = require("./apply.js");
const { buildActiveCounts, resolveCapWindowDays } = require("./prepare.js");

const ROOT = "/fake/profiles/demo";
const CONTEXT_PATH = path.join(ROOT, ".apply-state", "apply_context.json");
const UUID = "0f0f0f0f-1111-4222-8333-444444444444";

const GH_URL = "https://job-boards.greenhouse.io/acme/jobs/111";
const GH2_URL = "https://job-boards.greenhouse.io/beta/jobs/222";
const LEVER_URL = `https://jobs.lever.co/gamma/${UUID}`;

function profile() {
  return {
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
    notion: {
      application_qa_db_id: "qa-db",
      property_map: { status: { field: "Status", type: "status" } },
    },
    resumeVersions: { versions: { Growth: { filename: "CV_Test_Candidate_Growth.docx" } } },
    paths: {
      root: ROOT,
      applicationsTsv: path.join(ROOT, "applications.tsv"),
      resumesDir: path.join(ROOT, "resumes"),
      jdCacheDir: path.join(ROOT, "jd_cache"),
    },
  };
}

function row(over) {
  return {
    key: over.key,
    source: "greenhouse",
    jobId: over.key,
    companyName: over.companyName,
    title: "Product Manager",
    url: over.url,
    status: "To Apply",
    notion_page_id: `page-${over.key}`,
    resume_ver: "Growth",
    cl_path: "",
    fit_score: "Strong",
    applied_date: "",
    apply_state: "",
    apply_note: "",
    createdAt: "2026-10-20T00:00:00Z",
    updatedAt: "2026-10-20T00:00:00Z",
    ...over,
  };
}

const FORM = [
  { id: "first_name", label: "First Name", type: "text", required: true, options: [] },
  { id: "email", label: "Email", type: "email", required: true, options: [] },
  { id: "resume", label: "Resume/CV", type: "file", required: true, options: [] },
  {
    id: "q_auth",
    label: "Are you legally authorized to work in the United States?",
    type: "select",
    required: true,
    options: ["Yes", "No"],
  },
  { id: "q_salary", label: "Desired salary", type: "text", required: false, options: [] },
  { id: "q_why", label: "Why do you want to join?", type: "textarea", required: true, options: [] },
  {
    id: "q_years",
    label: "How many years of SQL experience do you have?",
    type: "text",
    required: false,
    options: [],
  },
  {
    id: "gender",
    label: "Gender",
    type: "select",
    required: false,
    options: ["Male", "Female", "Decline To Self Identify"],
  },
];

// Scripted fake adapter. behavior[url] = { open, submit, missing }.
function fakeAdapter(name, behavior, log) {
  return {
    name,
    detect: () => true,
    normalizeUrl: (u) => u,
    tenantKey: (u) => `${name}:${new URL(u).pathname.split("/")[1]}`,
    jobRef: () => ({ slug: "acme", jobId: "111" }),
    async open(page, url) {
      page.url = url;
      log.push(["open", url]);
      const b = behavior[url] || {};
      return b.open || { ok: true };
    },
    async readSchema(page) {
      return (behavior[page.url] && behavior[page.url].form) || FORM;
    },
    async fill(page, values) {
      log.push(["fill", page.url, values]);
      return { filled: Object.keys(values), errors: [] };
    },
    async checkFilled(page) {
      return { missing: (behavior[page.url] && behavior[page.url].missing) || [] };
    },
    async submit(page) {
      log.push(["submit", page.url]);
      const b = behavior[page.url] || {};
      if (b.beforeSubmit) b.beforeSubmit();
      return (
        b.submit || {
          ok: true,
          evidence: { url: `${page.url}/confirmation`, text: "Thank you for applying" },
        }
      );
    },
  };
}

function harness({
  apps,
  behavior = {},
  files = [],
  bank = [],
  secrets = { NOTION_TOKEN: "t" },
} = {}) {
  const log = [];
  const store = { apps: apps.map((a) => ({ ...a })), saves: 0 };
  const disk = new Map();
  for (const f of files) disk.set(f, "%PDF");
  const notionCalls = [];
  const shots = [];
  const adapter = (n) => fakeAdapter(n, behavior, log);
  const deps = {
    loadProfile: () => profile(),
    loadSecrets: () => secrets,
    loadApplications: () => ({ apps: store.apps.map((a) => ({ ...a })) }),
    saveApplications: (_p, list) => {
      store.apps = list.map((a) => ({ ...a }));
      store.saves += 1;
    },
    buildActiveCounts,
    resolveCapWindowDays,
    fetchFn: async () => {
      throw new Error("no network in tests");
    },
    resolveUrl: async (url) => {
      if (url.includes("adzuna"))
        return { ok: false, url, reason: "blocked", status: 403, hops: [url] };
      if (url.includes("workday"))
        return { ok: false, url, reason: "no_ats", status: 200, hops: [url] };
      if (url.includes("gone")) return { ok: false, url, reason: "dead", status: 404, hops: [url] };
      const ats = url.includes("lever") ? "lever" : "greenhouse";
      return { ok: true, url, ats, status: 0, hops: [] };
    },
    detectAts: (url) =>
      url.includes("lever") ? "lever" : url.includes("greenhouse") ? "greenhouse" : null,
    getAdapter: (n) => (n === "greenhouse" || n === "lever" ? adapter(n) : null),
    launchBrowser: async () => ({
      newPage: async () => ({
        page: {
          url: "",
          screenshot: async ({ path: p }) => {
            shots.push(p);
          },
        },
        close: async () => {},
      }),
      close: async () => {},
    }),
    fetchJd: async () => ({ text: (behavior.jdText && behavior.jdText) || "" }),
    extractJDStructure: (t) => ({ salary_text: t }),
    makeNotionClient: () => ({ fake: true }),
    fetchAllAnswers: async () => bank,
    updatePageStatus: async (client, pageId, status) => {
      notionCalls.push([pageId, status]);
    },
    readFile: (p) => {
      if (!disk.has(p)) throw new Error(`ENOENT ${p}`);
      return disk.get(p);
    },
    writeFile: (p, data) => disk.set(p, data),
    fileExists: (p) => disk.has(p),
    mkdirp: () => {},
    now: () => new Date("2026-10-21T08:00:00Z"),
    today: () => "2026-10-21",
  };
  const out = [];
  const err = [];
  const ctx = (flags) => ({
    profileId: "demo",
    profilesDir: "/fake/profiles",
    env: {},
    flags: { phase: "", dryRun: false, limit: null, concurrency: 2, answersFile: "", ...flags },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });
  return {
    deps,
    run: (flags) => makeApplyCommand(deps)(ctx(flags)),
    store,
    disk,
    log,
    notionCalls,
    shots,
    out,
    err,
  };
}

const RESUME = path.join(ROOT, "resumes", "CV_Test_Candidate_Growth.pdf");

// ---------------------------------------------------------------------------

test("phase is required", async () => {
  const h = harness({ apps: [] });
  assert.equal(await h.run({}), 1);
  assert.match(h.err.join("\n"), /--phase <pre\|submit>/);
});

test("pre: builds the context, resolves standard answers, flags manual cases", async () => {
  const h = harness({
    apps: [
      row({ key: "gh1", companyName: "Acme", url: GH_URL }),
      row({ key: "adz", companyName: "Delta", url: "https://www.adzuna.com/land/ad/1" }),
      row({
        key: "wd",
        companyName: "Epsilon",
        url: "https://epsilon.wd5.myworkdayjobs.com/job/1",
      }),
      row({ key: "dead", companyName: "Zeta", url: "https://grnh.se/gone" }),
      row({ key: "weak", companyName: "Eta", url: GH2_URL, fit_score: "Weak" }),
      row({ key: "nores", companyName: "Theta", url: GH2_URL, resume_ver: "Missing" }),
    ],
    files: [RESUME],
    bank: [
      {
        pageId: "bank-1",
        company: "Other Co",
        role: "PM",
        question: "How many years of SQL experience do you have?",
        answer: "Five years",
        category: "Experience",
      },
    ],
    behavior: { jdText: "Pay range $150,000 - $190,000" },
  });
  assert.equal(await h.run({ phase: "pre" }), 0);

  const ctx = JSON.parse(h.disk.get(CONTEXT_PATH));
  assert.equal(ctx.jobs.length, 1);
  const job = ctx.jobs[0];
  assert.equal(job.key, "gh1");
  assert.equal(job.ats, "greenhouse");
  assert.equal(job.tenant, "greenhouse:acme");
  assert.equal(job.resume, "resumes/CV_Test_Candidate_Growth.pdf");
  assert.deepEqual(job.salary.published_range, { min: 150000, max: 190000 });
  const ans = Object.fromEntries(job.answers.map((a) => [a.field_id, a]));
  assert.equal(ans.first_name.value, "Test");
  assert.equal(ans.first_name.source, "identity");
  assert.equal(ans.resume.source, "file");
  assert.equal(ans.q_auth.value, "Yes");
  assert.equal(ans.q_salary.value, "190000");
  assert.equal(ans.gender.value, "Decline To Self Identify");
  assert.equal(ans.q_years.source, "bank_reuse");
  assert.equal(ans.q_years.bank_page_id, "bank-1");
  assert.deepEqual(
    job.unanswered.map((u) => [u.field_id, u.required]),
    [["q_why", true]]
  );

  const manual = Object.fromEntries(ctx.manual.map((m) => [m.key, m.reason]));
  assert.equal(manual.adz, "unresolved_url:www.adzuna.com");
  assert.equal(manual.wd, "unsupported_ats:epsilon.wd5.myworkdayjobs.com");
  assert.equal(manual.nores, "resume_missing");
  assert.equal(ctx.skipped.find((s) => s.key === "dead").reason, "url_dead");
  assert.equal(ctx.skipped.find((s) => s.key === "weak").reason, "fit_not_strong_medium");

  const byKey = Object.fromEntries(h.store.apps.map((a) => [a.key, a]));
  assert.equal(byKey.gh1.apply_state, "queued");
  assert.equal(byKey.adz.apply_state, "manual");
  assert.equal(byKey.adz.apply_note, "unresolved_url:www.adzuna.com");
  assert.equal(byKey.dead.apply_state, "", "dead links are not put on the human list");
  assert.equal(byKey.gh1.status, "To Apply");
});

test("pre: captcha / login at open → manual; salary under floor → skipped; --dry-run writes no TSV", async () => {
  const h = harness({
    apps: [
      row({ key: "cap", companyName: "Acme", url: GH_URL }),
      row({ key: "low", companyName: "Beta", url: GH2_URL }),
    ],
    files: [RESUME],
    behavior: { [GH_URL]: { open: { ok: false, reason: "captcha" } } },
  });
  h.deps.fetchJd = async (job) => ({ text: job.slug === "acme" ? "" : "$80,000 - $100,000" });
  h.deps.getAdapter = (n) => {
    const a = fakeAdapter(n, { [GH_URL]: { open: { ok: false, reason: "captcha" } } }, h.log);
    a.jobRef = (u) => ({ slug: u === GH_URL ? "acme" : "beta", jobId: "1" });
    return a;
  };
  assert.equal(await h.run({ phase: "pre", dryRun: true }), 0);
  const ctx = JSON.parse(h.disk.get(CONTEXT_PATH));
  assert.equal(ctx.manual[0].reason, "captcha");
  assert.equal(ctx.skipped.find((s) => s.key === "low").reason, "salary_below_floor");
  assert.equal(h.store.saves, 0);
});

// ---- submit -----------------------------------------------------------------

function contextFor(keys) {
  return {
    generated_at: "2026-10-21T07:00:00Z",
    profile: "demo",
    jobs: keys.map(([key, url, company]) => ({
      key,
      company,
      title: "Product Manager",
      url,
      resolved_url: url,
      form_url: url,
      ats: url.includes("lever") ? "lever" : "greenhouse",
      tenant: `x:${company}`,
      resume: "resumes/CV_Test_Candidate_Growth.pdf",
      cover_letter: null,
      fields: FORM,
      answers: [
        { field_id: "first_name", label: "First Name", value: "Test", source: "identity" },
        { field_id: "email", label: "Email", value: "candidate@example.com", source: "identity" },
        {
          field_id: "resume",
          label: "Resume/CV",
          value: "resumes/CV_Test_Candidate_Growth.pdf",
          source: "file",
        },
        {
          field_id: "q_auth",
          label: "Are you legally authorized to work in the United States?",
          value: "Yes",
          source: "defaults",
        },
      ],
      unanswered: [
        {
          field_id: "q_why",
          label: "Why do you want to join?",
          type: "textarea",
          options: [],
          required: true,
        },
      ],
    })),
  };
}

function submitHarness({ apps, keys, answers, behavior }) {
  const h = harness({ apps, behavior, files: [RESUME] });
  h.disk.set(CONTEXT_PATH, JSON.stringify(contextFor(keys)));
  h.disk.set("/fake/answers.json", JSON.stringify({ answers }));
  return h;
}

const WHY = (key) => ({
  key,
  label: "Why do you want to join?",
  answer: "A sourced, truthful answer.",
  bank_page_id: null,
});

test("submit: success marks Applied, applied_by bot, screenshot, Notion status", async () => {
  let stateAtClick = null;
  const h = submitHarness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL })],
    keys: [["gh1", GH_URL, "Acme"]],
    answers: [WHY("gh1")],
    behavior: {
      [GH_URL]: {
        beforeSubmit: () => {
          const r = h.store.apps.find((a) => a.key === "gh1");
          stateAtClick = { state: r.apply_state, note: r.apply_note };
        },
      },
    },
  });
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 0);
  assert.deepEqual(stateAtClick, { state: "queued", note: "submitting:2026-10-21T08:00:00.000Z" });

  const r = h.store.apps.find((a) => a.key === "gh1");
  assert.equal(r.status, "Applied");
  assert.equal(r.applied_date, "2026-10-21");
  assert.equal(r.applied_by, "bot");
  assert.equal(r.apply_state, "submitted");
  assert.equal(r.apply_note, path.join(".apply-state", "shots", "gh1.png"));
  assert.deepEqual(h.notionCalls, [["page-gh1", "Applied"]]);
  assert.deepEqual(h.shots, [path.join(ROOT, ".apply-state", "shots", "gh1.png")]);

  const fill = h.log.find((l) => l[0] === "fill");
  assert.equal(fill[2].q_why, "A sourced, truthful answer.");
  assert.equal(fill[2].resume, RESUME, "files are attached by absolute path");
  assert.equal(fill[2].q_auth, "Yes");
});

test("submit: a required question without an honest answer → manual, browser never opened", async () => {
  const h = submitHarness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL })],
    keys: [["gh1", GH_URL, "Acme"]],
    answers: [],
  });
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 0);
  const r = h.store.apps.find((a) => a.key === "gh1");
  assert.equal(r.apply_state, "manual");
  assert.equal(r.apply_note, "no_honest_answer");
  assert.equal(r.status, "To Apply");
  assert.equal(h.log.filter((l) => l[0] === "open").length, 0);
});

test("submit: never double-applies — applied_date set since pre → skipped, no click", async () => {
  const h = submitHarness({
    apps: [
      row({
        key: "gh1",
        companyName: "Acme",
        url: GH_URL,
        applied_date: "2026-10-20",
        status: "Applied",
      }),
    ],
    keys: [["gh1", GH_URL, "Acme"]],
    answers: [WHY("gh1")],
  });
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 0);
  assert.equal(h.log.filter((l) => l[0] === "submit").length, 0);
  assert.equal(h.notionCalls.length, 0);
  assert.equal(h.store.apps[0].applied_date, "2026-10-20");
});

test("submit: captcha → manual, no confirmation → failed (no retry), pre-submit gap → manual", async () => {
  const h = submitHarness({
    apps: [
      row({ key: "a", companyName: "Acme", url: GH_URL }),
      row({ key: "b", companyName: "Beta", url: GH2_URL }),
      row({ key: "c", companyName: "Gamma", url: LEVER_URL }),
    ],
    keys: [
      ["a", GH_URL, "Acme"],
      ["b", GH2_URL, "Beta"],
      ["c", LEVER_URL, "Gamma"],
    ],
    answers: [WHY("a"), WHY("b"), WHY("c")],
    behavior: {
      [GH_URL]: { submit: { ok: false, reason: "captcha", evidence: {} } },
      [GH2_URL]: { submit: { ok: false, reason: "no_confirmation", evidence: {} } },
      [LEVER_URL]: { missing: ["resume"] },
    },
  });
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 0);
  const by = Object.fromEntries(h.store.apps.map((a) => [a.key, a]));
  assert.deepEqual([by.a.apply_state, by.a.apply_note], ["manual", "captcha"]);
  assert.deepEqual([by.b.apply_state, by.b.apply_note], ["failed", "no_confirmation"]);
  assert.deepEqual([by.c.apply_state, by.c.apply_note], ["manual", "presubmit_check"]);
  for (const k of ["a", "b", "c"]) assert.equal(by[k].status, "To Apply");
  assert.equal(h.log.filter((l) => l[0] === "submit" && l[1] === LEVER_URL).length, 0);
  assert.equal(h.notionCalls.length, 0);
});

test("submit --dry-run: fills and screenshots, never clicks Submit, writes nothing", async () => {
  const h = submitHarness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL })],
    keys: [["gh1", GH_URL, "Acme"]],
    answers: [WHY("gh1")],
  });
  assert.equal(
    await h.run({ phase: "submit", answersFile: "/fake/answers.json", dryRun: true }),
    0
  );
  assert.equal(h.log.filter((l) => l[0] === "submit").length, 0);
  assert.equal(h.log.filter((l) => l[0] === "fill").length, 1);
  assert.equal(h.shots.length, 1);
  assert.equal(h.store.saves, 0);
  assert.equal(h.notionCalls.length, 0);
  assert.match(h.out.join("\n"), /1 dry-run/);
});

test("submit: input validation", async () => {
  const h = harness({ apps: [] });
  assert.equal(await h.run({ phase: "submit" }), 1);
  assert.match(h.err.join("\n"), /--answers-file/);
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 1);
  assert.match(h.err.join("\n"), /run apply --phase pre first/);
  h.disk.set(CONTEXT_PATH, JSON.stringify({ jobs: [] }));
  h.disk.set("/fake/bad.json", JSON.stringify({ nope: [] }));
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/bad.json" }), 1);
});

// ---- pure helpers -----------------------------------------------------------

test("searchBank: exact match first; cross-company reuse only for portable categories", () => {
  const job = { company: "Acme", title: "PM" };
  const field = { id: "q", label: "Why Acme?", type: "textarea", options: [] };
  const bank = [
    {
      pageId: "x1",
      company: "Acme",
      role: "PM",
      question: "Why Acme?",
      answer: "Because…",
      category: "Motivation",
    },
  ];
  assert.deepEqual(searchBank(bank, job, field), {
    source: "bank",
    value: "Because…",
    bank_page_id: "x1",
  });
  // Same question for another company, motivation → not reused.
  const other = [{ ...bank[0], company: "Other", pageId: "x2" }];
  assert.equal(searchBank(other, job, field), null);
  // Experience answer that names its company → not reused.
  const f2 = { id: "y", label: "Years of SQL?", type: "text", options: [] };
  const named = [
    {
      pageId: "x3",
      company: "Other",
      role: "PM",
      question: "Years of SQL?",
      answer: "5 at Other",
      category: "Experience",
    },
  ];
  assert.equal(searchBank(named, job, f2), null);
  // Choice field: bank text must land on an option.
  const sel = { id: "z", label: "Q", type: "select", options: ["Yes", "No"] };
  assert.equal(
    searchBank([{ company: "Acme", role: "PM", question: "Q", answer: "Maybe" }], job, sel),
    null
  );
});

test("resolveFields: missing required cover letter / unknown required file block the job", () => {
  const fields = [
    { id: "cl", label: "Cover Letter", type: "file", required: true, options: [] },
    { id: "p", label: "Portfolio", type: "file", required: false, options: [] },
  ];
  const r = resolveFields(fields, {
    job: { company: "A", title: "PM" },
    identity: {},
    applyDefaults: null,
    salary: null,
    bank: [],
    files: { resume: { rel: "r.pdf" }, cover_letter: null },
  });
  assert.deepEqual(r.blockers, ["cover_letter_missing"]);
  const r2 = resolveFields(
    [{ id: "t", label: "Transcript", type: "file", required: true, options: [] }],
    {
      job: {},
      identity: {},
      files: { resume: { rel: "r.pdf" }, cover_letter: null },
    }
  );
  assert.deepEqual(r2.blockers, ["unsupported_required_file"]);
});

test("buildFillPlan: id first, then label; LLM answers mapped onto options", () => {
  const live = [
    { id: "new_id", label: "First Name", type: "text", required: true, options: [] },
    {
      id: "q2",
      label: "Do you have 5+ years of PM experience?",
      type: "radio",
      required: true,
      options: ["Yes", "No"],
    },
    { id: "q3", label: "Optional note", type: "textarea", required: false, options: [] },
  ];
  const job = {
    answers: [{ field_id: "first_name", label: "First Name", value: "Test", source: "identity" }],
  };
  const llm = [{ key: "k", label: "Do you have 5+ years of PM experience?", answer: "yes" }];
  const plan = buildFillPlan(live, job, llm, ROOT);
  assert.deepEqual(plan.values, { new_id: "Test", q2: "Yes" });
  assert.deepEqual(plan.missingRequired, []);
  const plan2 = buildFillPlan(live, job, [], ROOT);
  assert.deepEqual(plan2.missingRequired, ["q2"]);
});

test("alreadyApplied guard", () => {
  assert.equal(alreadyApplied(null), "row_missing");
  assert.equal(
    alreadyApplied({ status: "To Apply", applied_date: "2026-01-01" }),
    "already_applied"
  );
  assert.equal(alreadyApplied({ status: "To Apply", apply_state: "submitted" }), "already_applied");
  assert.equal(alreadyApplied({ status: "No Response" }), "status_No_Response");
  assert.equal(alreadyApplied({ status: "To Apply", applied_date: "" }), null);
  // A submit run that died after the click: a re-run must not click again.
  assert.equal(
    alreadyApplied({
      status: "To Apply",
      apply_state: "queued",
      apply_note: "submitting:2026-10-22T08:00:00.000Z",
    }),
    "interrupted_submit"
  );
});

test("loadAnswersFile groups answers by job key and drops empty ones", () => {
  const disk = new Map([
    [
      "/a.json",
      JSON.stringify({
        answers: [
          { key: "k1", label: "Q", answer: "A" },
          { key: "k1", label: "Q2", answer: "" },
          { key: "k2", label: "Q", answer: "B" },
          { label: "no key", answer: "x" },
        ],
      }),
    ],
  ]);
  const deps = { fileExists: (p) => disk.has(p), readFile: (p) => disk.get(p) };
  const m = loadAnswersFile("/a.json", deps);
  assert.equal(m.get("k1").length, 1);
  assert.equal(m.get("k2")[0].answer, "B");
  assert.throws(() => loadAnswersFile("/missing.json", deps), /not found/);
});

// ---- night run support (BL-225) ---------------------------------------------

test("pre: writes a stamped apply_pre-<ts>.json with the keys it looked at", async () => {
  const h = harness({
    apps: [
      row({ key: "gh1", companyName: "Acme", url: GH_URL }),
      row({ key: "wd", companyName: "Epsilon", url: "https://epsilon.wd5.myworkdayjobs.com/j/1" }),
      row({ key: "dead", companyName: "Zeta", url: "https://grnh.se/gone" }),
    ],
    files: [RESUME],
  });
  assert.equal(await h.run({ phase: "pre" }), 0);
  const name = [...h.disk.keys()].find((k) => /apply_pre-.*\.json$/.test(k));
  assert.ok(name, "stamped pre summary written");
  assert.equal(path.dirname(name), path.join(ROOT, ".apply-state"));
  const pre = JSON.parse(h.disk.get(name));
  assert.equal(pre.generated_at, "2026-10-21T08:00:00.000Z");
  assert.equal(pre.dry_run, false);
  assert.deepEqual(pre.jobs, [{ key: "gh1" }]);
  assert.deepEqual(pre.manual, [
    { key: "wd", reason: "unsupported_ats:epsilon.wd5.myworkdayjobs.com" },
  ]);
  assert.deepEqual(pre.skipped, [{ key: "dead", reason: "url_dead" }]);
});

test("submit --deadline: no form is opened after the deadline; rows stay queued", async () => {
  const h = submitHarness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL, apply_state: "queued" })],
    keys: [["gh1", GH_URL, "Acme"]],
    answers: [WHY("gh1")],
  });
  // harness clock: 2026-10-21T08:00:00Z
  const code = await h.run({
    phase: "submit",
    answersFile: "/fake/answers.json",
    deadline: "2026-10-21T07:59:00Z",
  });
  assert.equal(code, 0);
  assert.equal(h.log.filter((l) => l[0] === "open").length, 0);
  const r = h.store.apps.find((a) => a.key === "gh1");
  assert.equal(r.apply_state, "queued");
  assert.equal(r.apply_note, "");
  assert.equal(r.status, "To Apply");
  assert.match(h.out.join("\n"), /1 left for the next run: deadline/);
  const results = [...h.disk.entries()].find(([k]) => /apply_results-/.test(k));
  assert.equal(JSON.parse(results[1]).results[0].reason, "deadline");

  // Before the deadline the job goes out as usual.
  const h2 = submitHarness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL })],
    keys: [["gh1", GH_URL, "Acme"]],
    answers: [WHY("gh1")],
  });
  await h2.run({
    phase: "submit",
    answersFile: "/fake/answers.json",
    deadline: "2026-10-21T09:00:00Z",
  });
  assert.equal(h2.store.apps[0].status, "Applied");

  const h3 = submitHarness({ apps: [], keys: [], answers: [] });
  assert.equal(
    await h3.run({ phase: "submit", answersFile: "/fake/answers.json", deadline: "soon" }),
    1
  );
  assert.match(h3.err.join("\n"), /--deadline must be an ISO timestamp/);
});

test("submit: --answers-file may be a directory of per-job answer files", async () => {
  const h = submitHarness({
    apps: [
      row({ key: "a", companyName: "Acme", url: GH_URL }),
      row({ key: "b", companyName: "Beta", url: GH2_URL }),
    ],
    keys: [
      ["a", GH_URL, "Acme"],
      ["b", GH2_URL, "Beta"],
    ],
    answers: [],
  });
  const dir = "/fake/round/answers";
  h.disk.set(dir, "<dir>");
  h.disk.set(`${dir}/a.json`, JSON.stringify({ answers: [WHY("a")] }));
  h.disk.set(`${dir}/b.json`, JSON.stringify({ answers: [WHY("b")] }));
  h.deps.isDirectory = (p) => p === dir;
  h.deps.listDir = () => ["b.json", "a.json", ".DS_Store", "notes.txt"];
  assert.equal(await h.run({ phase: "submit", answersFile: dir }), 0);
  assert.deepEqual(
    h.store.apps.map((r) => r.status),
    ["Applied", "Applied"]
  );
});

test("loadAnswersFile: an empty directory is valid (deterministic answers only)", () => {
  const deps = {
    fileExists: () => true,
    isDirectory: () => true,
    listDir: () => [],
    readFile: () => {
      throw new Error("no files to read");
    },
  };
  assert.equal(loadAnswersFile("/empty", deps).size, 0);
});
