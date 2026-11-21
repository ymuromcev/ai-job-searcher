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
    // Board slug + job id from the URL path (".../<slug>/jobs/<id>",
    // ".../<slug>/<uuid>"); acme / 111 when the URL has neither.
    jobRef: (u) => {
      const m = String(u || "").match(
        /\/([A-Za-z0-9_.-]+)\/(?:jobs\/)?(\d+|[0-9a-f-]{36})(?:[/?#]|$)/
      );
      return m ? { slug: m[1], jobId: m[2] } : { slug: "acme", jobId: "111" };
    },
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
  companies = [],
  posting = {},
  viaPage = null,
  profileOver = {},
  notionFails = new Set(),
} = {}) {
  const log = [];
  // Order of the side effects that matter to BL-236: Notion before the TSV.
  const events = [];
  const store = { apps: apps.map((a) => ({ ...a })), saves: 0 };
  const disk = new Map();
  for (const f of files) disk.set(f, "%PDF");
  const notionCalls = [];
  const shots = [];
  const adapter = (n) => fakeAdapter(n, behavior, log);
  const deps = {
    loadProfile: () => ({ ...profile(), ...profileOver }),
    loadSecrets: () => secrets,
    loadApplications: () => ({ apps: store.apps.map((a) => ({ ...a })) }),
    saveApplications: (_p, list) => {
      events.push(["save"]);
      store.apps = list.map((a) => ({ ...a }));
      store.saves += 1;
    },
    buildActiveCounts,
    resolveCapWindowDays,
    fetchFn: async () => {
      throw new Error("no network in tests");
    },
    resolveUrl: async (url) => {
      log.push(["resolveUrl", url]);
      if (url.includes("adzuna") && url.includes("gone"))
        return { ok: false, url, reason: "dead", status: 404, hops: [url] };
      if (url.includes("adzuna"))
        return { ok: false, url, reason: "blocked", status: 403, hops: [url] };
      if (url.includes("workday"))
        return { ok: false, url, reason: "no_ats", status: 200, hops: [url] };
      if (url.includes("gone")) return { ok: false, url, reason: "dead", status: 404, hops: [url] };
      const ats = url.includes("lever") ? "lever" : "greenhouse";
      return { ok: true, url, ats, status: 0, hops: [] };
    },
    detectAts: (url) =>
      url.includes("lever")
        ? "lever"
        : url.includes("greenhouse")
          ? "greenhouse"
          : url.includes("ashbyhq")
            ? "ashby"
            : null,
    loadCompanies: () => ({ rows: companies }),
    // posting[jobId] = "open" | "closed"; default unknown.
    checkPostingOpen: async (ref) => {
      log.push(["posting", ref.ats, ref.slug, ref.jobId]);
      return posting[ref.jobId] || "unknown";
    },
    resolveViaPage: async (_page, url) => {
      log.push(["viaPage", url]);
      return viaPage
        ? viaPage(url)
        : { ok: false, url, reason: "blocked", status: 403, hops: [url] };
    },
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
      if (notionFails.has(pageId)) throw new Error("notion down");
      events.push(["notion", pageId, status]);
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
    events,
    shots,
    out,
    err,
  };
}

const RESUME = path.join(ROOT, "resumes", "CV_Test_Candidate_Growth.pdf");

// Rows the bot gave up on (RFC 069 vocabulary): key → [reason, code].
const { isSkipReason } = require("../modules/apply/skip_reasons.js");
function gaveUp(ctx) {
  return Object.fromEntries(
    ctx.skipped.filter((s) => isSkipReason(s.reason)).map((s) => [s.key, [s.reason, s.code]])
  );
}

// ---------------------------------------------------------------------------

test("phase is required", async () => {
  const h = harness({ apps: [] });
  assert.equal(await h.run({}), 1);
  assert.match(h.err.join("\n"), /--phase <pre\|submit\|open>/);
});

test("pre: builds the context, resolves standard answers, skips what it cannot do", async () => {
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
      row({ key: "weak", companyName: "Eta", url: GH2_URL, fit_score: "" }),
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
    // The browser opens the short link and sees "not found" on the same path.
    viaPage: (url) =>
      url.includes("gone")
        ? { ok: false, url, reason: "dead", status: 404, hops: [url] }
        : { ok: false, url, reason: "blocked", status: 403, hops: [url] },
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

  assert.equal(ctx.manual, undefined, "nothing is left for a human");
  const gave = gaveUp(ctx);
  assert.deepEqual(gave.adz, ["no_company_form", "unresolved_url:www.adzuna.com"]);
  assert.deepEqual(gave.wd, ["no_company_form", "unsupported_ats:epsilon.wd5.myworkdayjobs.com"]);
  assert.deepEqual(gave.nores, ["required_empty", "resume_missing"]);
  assert.equal(
    ctx.closed.find((c) => c.key === "dead").reason,
    "url_dead",
    "a dead link is listed once, under closed"
  );
  assert.equal(
    ctx.skipped.find((s) => s.key === "dead"),
    undefined
  );
  assert.equal(ctx.skipped.find((s) => s.key === "weak").reason, "fit_unscored");

  const byKey = Object.fromEntries(h.store.apps.map((a) => [a.key, a]));
  assert.equal(byKey.gh1.apply_state, "queued");
  assert.equal(byKey.adz.apply_state, "skipped");
  assert.equal(byKey.adz.apply_note, "no_company_form: unresolved_url:www.adzuna.com");
  assert.equal(byKey.dead.status, "Closed", "a dead link closes the job");
  assert.equal(byKey.dead.apply_state, "");
  assert.equal(byKey.dead.apply_note, "url_dead");
  assert.equal(byKey.gh1.status, "To Apply");
});

test("pre: captcha at open → skipped captcha; salary under floor → skipped; --dry-run writes no TSV", async () => {
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
  assert.deepEqual(gaveUp(ctx).cap, ["captcha", undefined]);
  assert.equal(ctx.skipped.find((s) => s.key === "low").reason, "salary_below_floor");
  assert.equal(h.store.saves, 0);
});

test("pre: salary under the floor archives the row with the reason (BL-236)", async () => {
  const h = harness({
    apps: [row({ key: "low", companyName: "Beta", url: GH2_URL })],
    files: [RESUME],
  });
  h.deps.fetchJd = async () => ({ text: "$80,000 - $100,000" });
  h.deps.getAdapter = (n) => {
    const a = fakeAdapter(n, {}, h.log);
    a.jobRef = () => ({ slug: "beta", jobId: "1" });
    return a;
  };
  assert.equal(await h.run({ phase: "pre" }), 0);
  const ctx = JSON.parse(h.disk.get(CONTEXT_PATH));
  assert.equal(ctx.skipped.find((s) => s.key === "low").reason, "salary_below_floor");
  const low = h.store.apps.find((a) => a.key === "low");
  assert.equal(low.status, "Archived");
  assert.equal(low.skip_reason, "salary_below_floor");
  assert.equal(low.apply_state, "");
});

// ---- BL-236: dead links and below-floor rows leave the queue ------------------

const goneBrowser = (url) => ({ ok: false, url, reason: "dead", status: 404, hops: [url] });
const deadRows = (n) =>
  Array.from({ length: n }, (_, i) =>
    row({ key: `d${i}`, companyName: `Dead${i}`, url: `https://www.adzuna.com/land/ad/gone-${i}` })
  );

test("pre: a dead link is closed in Notion first, then in the TSV, counted once", async () => {
  const h = harness({ apps: deadRows(2), files: [RESUME], viaPage: goneBrowser });
  assert.equal(await h.run({ phase: "pre" }), 0);
  assert.deepEqual(
    h.events.map((e) => e[0]),
    ["notion", "notion", "save"],
    "Notion pages move before the TSV is written"
  );
  assert.deepEqual(h.notionCalls, [
    ["page-d0", "Closed"],
    ["page-d1", "Closed"],
  ]);
  for (const a of h.store.apps) {
    assert.equal(a.status, "Closed");
    assert.equal(a.apply_note, "url_dead");
  }
  const line = h.out.find((l) => l.startsWith("apply pre:"));
  assert.match(line, /2 dead link\(s\) closed/);
  assert.match(line, /0 closed;/, "the plain 'closed' count does not repeat them");
  assert.match(line, /; 0 skipped/, "and neither does the skipped count");
  const ctx = JSON.parse(h.disk.get(CONTEXT_PATH));
  assert.equal(ctx.closed.filter((c) => c.reason === "url_dead").length, 2);
  assert.equal(ctx.skipped.filter((s) => s.reason === "url_dead").length, 0);
  // The night's stamped record keeps them for the morning report, once.
  const stamp = [...h.disk.keys()].find((k) => /apply_pre-.*\.json$/.test(k));
  const rec = JSON.parse(h.disk.get(stamp));
  assert.deepEqual(
    rec.skipped.map((x) => x.reason),
    ["url_dead", "url_dead"]
  );
});

test("pre: a Notion error leaves the dead-link row To Apply (not Closed in the TSV)", async () => {
  const h = harness({
    apps: deadRows(2),
    files: [RESUME],
    viaPage: goneBrowser,
    notionFails: new Set(["page-d0"]),
  });
  assert.equal(await h.run({ phase: "pre" }), 0);
  const byKey = Object.fromEntries(h.store.apps.map((a) => [a.key, a]));
  assert.equal(byKey.d0.status, "To Apply");
  assert.equal(byKey.d1.status, "Closed");
  assert.match(h.err.join("\n"), /Notion status Closed failed for d0/);
  // Skipped tonight, with the reason, so the report still shows it.
  const ctx = JSON.parse(h.disk.get(CONTEXT_PATH));
  assert.equal(ctx.skipped.find((s) => s.key === "d0").reason, "url_dead");
});

test("pre: no Notion token → a row with a page stays To Apply; a row without a page closes", async () => {
  const apps = deadRows(2);
  apps[1].notion_page_id = "";
  const h = harness({ apps, files: [RESUME], viaPage: goneBrowser, secrets: {} });
  assert.equal(await h.run({ phase: "pre" }), 0);
  const byKey = Object.fromEntries(h.store.apps.map((a) => [a.key, a]));
  assert.equal(byKey.d0.status, "To Apply");
  assert.equal(byKey.d1.status, "Closed");
});

test("pre: a dead verdict nobody confirmed (browser blocked / fetch error) closes nothing", async () => {
  const h = harness({ apps: deadRows(2), files: [RESUME] }); // default browser: blocked
  assert.equal(await h.run({ phase: "pre" }), 0);
  assert.ok(h.store.apps.every((a) => a.status === "To Apply"));
  assert.deepEqual(h.notionCalls, []);
  // Still reported as skipped url_dead tonight.
  const ctx = JSON.parse(h.disk.get(CONTEXT_PATH));
  assert.equal(ctx.skipped.filter((s) => s.reason === "url_dead").length, 2);
});

test("pre: a night-sized backlog of 68 reliably dead links drains over rounds, 40 per run", async () => {
  const h = harness({ apps: deadRows(68), files: [RESUME], viaPage: goneBrowser });
  assert.equal(await h.run({ phase: "pre", concurrency: 4 }), 0);
  assert.equal(h.store.apps.filter((a) => a.status === "Closed").length, 40);
  assert.equal(h.notionCalls.length, 40);
  assert.match(h.err.join("\n"), /68 dead links in one run - closing 40/);
  // Next round: the remaining 28 are checked again and closed.
  assert.equal(await h.run({ phase: "pre", concurrency: 4 }), 0);
  assert.ok(h.store.apps.every((a) => a.status === "Closed"));
});

test("pre: below-floor rows are archived in Notion first; a Notion error keeps the row", async () => {
  const h = harness({
    apps: [
      row({ key: "low", companyName: "Beta", url: GH2_URL }),
      row({ key: "low2", companyName: "Gamma", url: GH_URL }),
    ],
    files: [RESUME],
    notionFails: new Set(["page-low2"]),
  });
  h.deps.fetchJd = async () => ({ text: "$80,000 - $100,000" });
  h.deps.getAdapter = (n) => {
    const a = fakeAdapter(n, {}, h.log);
    a.jobRef = (u) => ({ slug: u === GH_URL ? "acme" : "beta", jobId: "1" });
    return a;
  };
  assert.equal(await h.run({ phase: "pre" }), 0);
  const byKey = Object.fromEntries(h.store.apps.map((a) => [a.key, a]));
  assert.equal(byKey.low.status, "Archived");
  assert.equal(byKey.low2.status, "To Apply");
  assert.deepEqual(
    h.events.map((e) => e[0]),
    ["notion", "save"]
  );
  assert.deepEqual(h.notionCalls, [["page-low", "Archived"]]);
});

test("pre: a row the submitter took while Notion was moving is put back in Notion", async () => {
  const h = harness({ apps: deadRows(1), files: [RESUME], viaPage: goneBrowser });
  // The submitter applies to the row right after the check, before the save.
  let loads = 0;
  const realLoad = h.deps.loadApplications;
  h.deps.loadApplications = (p) => {
    loads += 1;
    const r = realLoad(p);
    // 1st load: pre start; 2nd: the pre-Notion re-read; 3rd: inside the lock.
    if (loads === 3) {
      r.apps[0].status = "Applied";
      r.apps[0].applied_date = "2026-10-21";
      r.apps[0].apply_state = "submitted";
    }
    return r;
  };
  assert.equal(await h.run({ phase: "pre" }), 0);
  assert.deepEqual(h.notionCalls, [
    ["page-d0", "Closed"],
    ["page-d0", "Applied"],
  ]);
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

function submitHarness({ apps, keys, answers, behavior, profileOver }) {
  const h = harness({ apps, behavior, files: [RESUME], profileOver });
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

test("submit: a required question without an honest answer → skipped no_honest_answer, browser never opened", async () => {
  const h = submitHarness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL })],
    keys: [["gh1", GH_URL, "Acme"]],
    answers: [],
  });
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 0);
  const r = h.store.apps.find((a) => a.key === "gh1");
  assert.equal(r.apply_state, "skipped");
  assert.equal(r.apply_note, "no_honest_answer: Why do you want to join?");
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

test("submit: captcha → skipped, no confirmation → failed (no retry), required field empty → skipped, no click", async () => {
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
  assert.deepEqual([by.a.apply_state, by.a.apply_note], ["skipped", "captcha"]);
  assert.deepEqual([by.b.apply_state, by.b.apply_note], ["failed", "no_confirmation"]);
  assert.deepEqual([by.c.apply_state, by.c.apply_note], ["skipped", "required_empty: Resume/CV"]);
  const results = JSON.parse([...h.disk.entries()].find(([k]) => /apply_results-/.test(k))[1]);
  const c = results.results.find((r) => r.key === "c");
  assert.deepEqual(
    [c.outcome, c.reason, c.empty_fields],
    ["skipped", "required_empty", ["Resume/CV"]]
  );
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

test("submit: Greenhouse security code is read from the apply mailbox, typed, resubmitted", async () => {
  const h = submitHarness({
    apps: [
      row({ key: "a", companyName: "Acme", url: GH_URL }),
      row({ key: "b", companyName: "Beta", url: GH2_URL }),
    ],
    keys: [
      ["a", GH_URL, "Acme"],
      ["b", GH2_URL, "Beta"],
    ],
    answers: [WHY("a"), WHY("b")],
    behavior: {},
  });
  const typed = [];
  const clicks = { [GH_URL]: 0, [GH2_URL]: 0 };
  const base = h.deps.getAdapter;
  h.deps.getAdapter = (n) => {
    const a = base(n);
    return {
      ...a,
      async submit(page) {
        clicks[page.url] += 1;
        if (clicks[page.url] === 1) return { ok: false, reason: "email_verification" };
        return { ok: true, evidence: { url: page.url, text: "Thank you for applying" } };
      },
      async enterSecurityCode(page, code) {
        typed.push([page.url, code]);
        return { ok: true };
      },
    };
  };
  const asked = [];
  h.deps.makeCodeWaiter = () => ({
    wait: async ({ company }) => {
      asked.push(company);
      return company === "Acme" ? "Ab3dE9fZ" : null;
    },
  });
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 0);
  const by = Object.fromEntries(h.store.apps.map((x) => [x.key, x]));
  assert.equal(by.a.status, "Applied");
  assert.equal(by.a.apply_state, "submitted");
  assert.deepEqual(typed, [[GH_URL, "Ab3dE9fZ"]]);
  assert.equal(clicks[GH_URL], 2, "Submit pressed again after the code");
  // No code in the mailbox → skipped as a bot check, the run moves on.
  assert.deepEqual(
    [by.b.apply_state, by.b.apply_note],
    ["skipped", "bot_check: email_code_missing"]
  );
  assert.equal(by.b.status, "To Apply");
  assert.deepEqual(asked.sort(), ["Acme", "Beta"]);
});

test("submit: no confirmation on the page but a thank-you mail → Applied, never failed", async () => {
  const h = submitHarness({
    apps: [
      row({ key: "a", companyName: "Acme", url: GH_URL }),
      row({ key: "b", companyName: "Beta", url: GH2_URL }),
    ],
    keys: [
      ["a", GH_URL, "Acme"],
      ["b", GH2_URL, "Beta"],
    ],
    answers: [WHY("a"), WHY("b")],
    behavior: {
      [GH_URL]: { submit: { ok: false, reason: "no_confirmation" } },
      [GH2_URL]: { submit: { ok: false, reason: "no_confirmation" } },
    },
  });
  h.deps.makeCodeWaiter = () => ({
    wait: async () => null,
    confirmed: async ({ company }) =>
      company === "Acme" ? { subject: "Thank you for applying to Acme" } : null,
  });
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 0);
  const by = Object.fromEntries(h.store.apps.map((x) => [x.key, x]));
  assert.deepEqual([by.a.status, by.a.apply_state], ["Applied", "submitted"]);
  assert.deepEqual(
    [by.b.status, by.b.apply_state, by.b.apply_note],
    ["To Apply", "failed", "no_confirmation"]
  );
});

test("submit: no apply mailbox configured → security code screen is skipped as bot_check", async () => {
  const h = submitHarness({
    apps: [row({ key: "a", companyName: "Acme", url: GH_URL })],
    keys: [["a", GH_URL, "Acme"]],
    answers: [WHY("a")],
    behavior: { [GH_URL]: { submit: { ok: false, reason: "email_verification" } } },
  });
  h.deps.makeCodeWaiter = () => null;
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 0);
  const r = h.store.apps[0];
  assert.deepEqual([r.apply_state, r.apply_note], ["skipped", "bot_check: email_verification"]);
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

test("resolveFields: the owner's standing answers fill exact matches; a skip rule blocks (RFC 070)", () => {
  const applyDefaults = {
    standing_answers: [
      { question: "Have you worked at <company> before?", answer: "No" },
      { question: "Your favourite <company> product?", answer: "The API" },
    ],
    skip_questions: [{ question: "Can you work 5 days a week in our office?" }],
  };
  const ctx = {
    job: { company: "Acme", title: "PM" },
    identity: {},
    applyDefaults,
    salary: null,
    bank: [],
    files: { resume: { rel: "r.pdf" }, cover_letter: null },
  };
  const fields = [
    {
      id: "w",
      label: "Have you worked at Acme before? *",
      type: "radio",
      required: true,
      options: ["Yes", "No"],
    },
    { id: "p", label: "Your favourite Acme product?", type: "text", required: true, options: [] },
    { id: "o", label: "Other question?", type: "text", required: true, options: [] },
  ];
  const r = resolveFields(fields, ctx);
  assert.deepEqual(
    r.answers.map((a) => [a.field_id, a.value, a.source]),
    [
      ["w", "No", "standing"],
      ["p", "The API", "standing"],
    ]
  );
  assert.deepEqual(
    r.unanswered.map((u) => u.field_id),
    ["o"]
  );
  assert.deepEqual(r.blockers, []);

  const blocked = resolveFields(
    [
      ...fields,
      {
        id: "x",
        label: "Can you work 5 days a week in our office?",
        type: "radio",
        required: false,
        options: ["Yes", "No"],
      },
    ],
    ctx
  );
  assert.deepEqual(blocked.blockers, ["owner_skip: Can you work 5 days a week in our office?"]);
  // The note the pre phase writes from that stop code.
  const { skipReasonFor, skipNote } = require("../modules/apply/skip_reasons.js");
  const code = blocked.blockers[0];
  assert.equal(
    skipNote(skipReasonFor(code), code),
    "no_honest_answer: owner_skip: Can you work 5 days a week in our office?"
  );
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

// ---- canonical form URLs + closed postings (RFC 068 follow-up) -------------

const COMPANIES = [
  { name: "Samsara", source: "greenhouse", slug: "samsara" },
  { name: "Navan", source: "greenhouse", slug: "tripactions" },
  { name: "Navan", source: "lever", slug: "navan-lever" },
  { name: "Gamma Inc.", source: "lever", slug: "gamma" },
];

test("pre: ATS-sourced rows use the canonical form URL, never the career page", async () => {
  const h = harness({
    apps: [
      row({
        key: "greenhouse:8017174",
        source: "greenhouse",
        jobId: "8017174",
        companyName: "Samsara",
        url: "https://www.samsara.com/company/careers/roles/8017174?gh_jid=8017174",
      }),
      row({
        key: "gh:8010057",
        source: "Greenhouse",
        jobId: "gh:8010057",
        companyName: "Navan",
        url: "https://navan.com/careers/openings?gh_jid=8010057",
      }),
      row({ key: "lv1", source: "lever", jobId: UUID, companyName: "Gamma", url: "" }),
    ],
    files: [RESUME],
    companies: COMPANIES,
    posting: { 8017174: "open", 8010057: "closed" },
  });
  assert.equal(await h.run({ phase: "pre" }), 0);
  const ctx = JSON.parse(h.disk.get(CONTEXT_PATH));
  const byKey = Object.fromEntries(ctx.jobs.map((j) => [j.key, j]));
  assert.equal(
    byKey["greenhouse:8017174"].form_url,
    "https://job-boards.greenhouse.io/embed/job_app?for=samsara&token=8017174"
  );
  assert.equal(byKey.lv1.form_url, `https://jobs.lever.co/gamma/${UUID}/apply`);
  // No redirect-following for rows with a slug.
  assert.deepEqual(
    h.log.filter((l) => l[0] === "resolveUrl"),
    []
  );
  // Navan: slug from the greenhouse row (not the lever one), posting closed.
  assert.ok(h.log.some((l) => l[0] === "posting" && l[2] === "tripactions" && l[3] === "8010057"));
  assert.deepEqual(
    ctx.closed.map((c) => c.key),
    ["gh:8010057"]
  );
  const navan = h.store.apps.find((a) => a.key === "gh:8010057");
  assert.equal(navan.status, "Closed");
  assert.equal(navan.apply_note, "job_closed");
  assert.equal(navan.apply_state, "");
  assert.deepEqual(h.notionCalls, [["page-gh:8010057", "Closed"]]);
});

test("pre: no URL and no ATS slug → skipped no_company_form (no_application_url)", async () => {
  const h = harness({
    apps: [
      row({ key: "recruiter:x", source: "recruiter", jobId: "x", companyName: "Kappa", url: "" }),
      row({ key: "manual:y", source: "Manual", jobId: "y", companyName: "Lambda", url: "" }),
    ],
    files: [RESUME],
  });
  assert.equal(await h.run({ phase: "pre" }), 0);
  const ctx = JSON.parse(h.disk.get(CONTEXT_PATH));
  assert.deepEqual(gaveUp(ctx), {
    "recruiter:x": ["no_company_form", "no_application_url"],
    "manual:y": ["no_company_form", "no_application_url"],
  });
});

test("pre: Ashby rows → skipped bot_check before any form is read (its reCAPTCHA blocks submit)", async () => {
  const h = harness({
    apps: [
      row({
        key: "ashby:a1",
        source: "ashby",
        jobId: "a1",
        companyName: "Kappa",
        url: "https://jobs.ashbyhq.com/kappa/a1",
      }),
    ],
    files: [RESUME],
  });
  const resolve = h.deps.resolveUrl;
  h.deps.resolveUrl = async (url, o) =>
    url.includes("ashbyhq")
      ? { ok: true, url, ats: "ashby", status: 0, hops: [] }
      : resolve(url, o);
  assert.equal(await h.run({ phase: "pre" }), 0);
  const ctx = JSON.parse(h.disk.get(CONTEXT_PATH));
  assert.deepEqual(gaveUp(ctx), { "ashby:a1": ["bot_check", "bot_check:ashby_recaptcha"] });
  assert.equal(ctx.jobs.length, 0);
});

test("pre: blocked aggregator falls back to a browser page; still blocked → unresolved_url", async () => {
  const h = harness({
    apps: [
      row({
        key: "adz1",
        source: "adzuna",
        jobId: "1",
        companyName: "Mu",
        url: "https://www.adzuna.com/land/ad/1",
      }),
      row({
        key: "adz2",
        source: "adzuna",
        jobId: "2",
        companyName: "Nu",
        url: "https://www.adzuna.com/land/ad/2",
      }),
    ],
    files: [RESUME],
    viaPage: (url) =>
      url.endsWith("/1")
        ? { ok: true, url: GH_URL, ats: "greenhouse", status: 200, hops: [url, GH_URL] }
        : { ok: false, url, reason: "blocked", status: 403, hops: [url] },
  });
  assert.equal(await h.run({ phase: "pre" }), 0);
  const ctx = JSON.parse(h.disk.get(CONTEXT_PATH));
  assert.deepEqual(
    ctx.jobs.map((j) => [j.key, j.resolved_url]),
    [["adz1", GH_URL]]
  );
  assert.deepEqual(gaveUp(ctx), {
    adz2: ["no_company_form", "unresolved_url:www.adzuna.com"],
  });
  // Resolved ATS URLs get the posting-API liveness check too.
  assert.ok(h.log.some((l) => l[0] === "posting" && l[1] === "greenhouse"));
});

test("pre: a closed page in the browser marks the job Closed, not manual", async () => {
  const h = harness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL })],
    files: [RESUME],
    behavior: { [GH_URL]: { open: { ok: false, reason: "job_closed" } } },
  });
  assert.equal(await h.run({ phase: "pre" }), 0);
  const r = h.store.apps[0];
  assert.equal(r.status, "Closed");
  assert.equal(r.apply_note, "job_closed");
});

test("pre: aggregator 404 from fetch is re-checked in the browser", async () => {
  const live = "https://www.adzuna.com/land/ad/gone-live";
  const gone = "https://www.adzuna.com/land/ad/gone-dead";
  const blocked = "https://www.adzuna.com/land/ad/gone-blocked";
  const h = harness({
    apps: [
      row({ key: "live", source: "adzuna", jobId: "1", companyName: "Xi", url: live }),
      row({ key: "gone", source: "adzuna", jobId: "2", companyName: "Omicron", url: gone }),
      row({ key: "blk", source: "adzuna", jobId: "3", companyName: "Pi", url: blocked }),
    ],
    files: [RESUME],
    viaPage: (url) => {
      if (url === live) {
        const details = "https://www.adzuna.com/details/1";
        return { ok: false, url: details, reason: "no_ats", status: 404, hops: [url, details] };
      }
      if (url === gone) return { ok: false, url, reason: "dead", status: 404, hops: [url] };
      return { ok: false, url, reason: "blocked", status: 403, hops: [url] };
    },
  });
  assert.equal(await h.run({ phase: "pre" }), 0);
  const ctx = JSON.parse(h.disk.get(CONTEXT_PATH));
  // Live ad on Adzuna without an employer link: no company form, not dead.
  assert.deepEqual(gaveUp(ctx), {
    live: ["no_company_form", "unresolved_url:www.adzuna.com"],
  });
  const skipped = Object.fromEntries(ctx.skipped.map((s) => [s.key, s.reason]));
  // The browser saw "not found": the job is closed (BL-236), listed once.
  assert.equal(ctx.closed.find((c) => c.key === "gone").reason, "url_dead");
  assert.equal(skipped.gone, undefined);
  // Browser blocked: fetch's 404 stands for tonight, but the row is NOT closed.
  assert.equal(skipped.blk, "url_dead");
  const byKey = Object.fromEntries(h.store.apps.map((a) => [a.key, a]));
  assert.equal(byKey.gone.status, "Closed");
  assert.equal(byKey.blk.status, "To Apply");
  assert.equal(h.log.filter((l) => l[0] === "viaPage").length, 3);
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
  assert.equal(pre.manual, undefined);
  assert.deepEqual(pre.skipped, [
    { key: "dead", reason: "url_dead" },
    {
      key: "wd",
      reason: "no_company_form",
      code: "unsupported_ats:epsilon.wd5.myworkdayjobs.com",
    },
  ]);
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

test("pre / submit: a browser that cannot start stops the run and touches no job", async () => {
  const h = harness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL })],
    files: [RESUME],
  });
  h.deps.launchBrowser = async () => {
    throw new Error("Executable doesn't exist");
  };
  assert.equal(await h.run({ phase: "pre" }), 1);
  assert.match(h.err.join("\n"), /cannot start the browser — Executable doesn't exist/);
  assert.equal(h.disk.has(CONTEXT_PATH), false);
  assert.equal(h.store.apps[0].apply_state || "", "");

  const s = submitHarness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL, apply_state: "queued" })],
    keys: [["gh1", GH_URL, "Acme"]],
    answers: [WHY("gh1")],
  });
  s.deps.launchBrowser = async () => {
    throw new Error("no chromium");
  };
  assert.equal(await s.run({ phase: "submit", answersFile: "/fake/answers.json" }), 1);
  assert.equal(s.store.apps[0].status, "To Apply");
  assert.equal(s.store.apps[0].apply_state, "queued");
});

test("submit: an answer outside a partial (searchable) option list is typed, not dropped", async () => {
  const school = (partial) => ({
    id: "school",
    label: "School",
    type: "select",
    required: true,
    options: ["Aalto University", "Atlanta College of Arts"],
    ...(partial ? { options_partial: true } : {}),
  });
  const answers = [WHY("gh1"), { key: "gh1", label: "School", answer: "Plekhanov University" }];
  const h = submitHarness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL })],
    keys: [["gh1", GH_URL, "Acme"]],
    answers,
    behavior: { [GH_URL]: { form: [...FORM, school(true)] } },
  });
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 0);
  const fill = h.log.find((l) => l[0] === "fill");
  assert.equal(fill[2].school, "Plekhanov University");

  // A complete list keeps the strict rule: no matching option → required field missing.
  const h2 = submitHarness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL })],
    keys: [["gh1", GH_URL, "Acme"]],
    answers,
    behavior: { [GH_URL]: { form: [...FORM, school(false)] } },
  });
  await h2.run({ phase: "submit", answersFile: "/fake/answers.json" });
  assert.equal(h2.log.filter((l) => l[0] === "fill").length, 0);
  assert.notEqual(h2.store.apps[0].status, "Applied");
});

// ---- answer ratings from the board (BL-225 U7) -----------------------------

const RATINGS_PATH = path.join(ROOT, ".answers", "ratings.json");
const BANK_A = "aaaaaaaa-0000-4000-8000-000000000001";
const BANK_B = "bbbbbbbb-0000-4000-8000-000000000002";
const BANK_C = "cccccccc-0000-4000-8000-000000000003";
const SQL_Q = "How many years of SQL experience do you have?";

function sqlAnswer(pageId, answer, over = {}) {
  return {
    pageId,
    company: "Other Co",
    role: "PM",
    question: SQL_Q,
    answer,
    category: "Experience",
    createdAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

function ratingsJson(map) {
  const ratings = {};
  for (const [id, rating] of Object.entries(map))
    ratings[id] = { rating, rated_at: "", question_key: "" };
  return JSON.stringify({ version: 1, ratings });
}

async function preWithRatings(bank, ratings) {
  const h = harness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL })],
    files: [RESUME],
    bank,
  });
  if (ratings !== undefined) h.disk.set(RATINGS_PATH, ratings);
  assert.equal(await h.run({ phase: "pre" }), 0);
  const job = JSON.parse(h.disk.get(CONTEXT_PATH)).jobs[0];
  const ans = Object.fromEntries(job.answers.map((a) => [a.field_id, a]));
  return { h, job, ans };
}

test("pre ratings: an answer rated 1–2 is never reused; the next match is taken", async () => {
  const bank = [sqlAnswer(BANK_A, "Seven years"), sqlAnswer(BANK_B, "Five years")];
  const { h, ans } = await preWithRatings(bank, ratingsJson({ [BANK_A]: 2 }));
  assert.equal(ans.q_years.bank_page_id, BANK_B);
  assert.equal(ans.q_years.value, "Five years");
  assert.match(h.out.join("\n"), /1 answer\(s\) rated 1–2 — not reused/);
});

test("pre ratings: the only matching answer rated 1 → the question goes to the LLM step", async () => {
  const { job, ans } = await preWithRatings(
    [sqlAnswer(BANK_A, "Seven years")],
    ratingsJson({ [BANK_A]: 1 })
  );
  assert.equal(ans.q_years, undefined);
  assert.ok(job.unanswered.some((u) => u.field_id === "q_years"));
});

test("pre ratings: several matches → higher rated first, then newer; unrated counts as 3", async () => {
  const bank = [
    sqlAnswer(BANK_A, "Old unrated", { createdAt: "2026-09-01T00:00:00Z" }),
    sqlAnswer(BANK_B, "New unrated", { createdAt: "2026-10-10T00:00:00Z" }),
    sqlAnswer(BANK_C, "Rated four", { createdAt: "2026-08-01T00:00:00Z" }),
  ];
  const rated = await preWithRatings(bank, ratingsJson({ [BANK_C]: 4 }));
  assert.equal(rated.ans.q_years.bank_page_id, BANK_C);

  const unrated = await preWithRatings(bank, undefined);
  assert.equal(unrated.ans.q_years.bank_page_id, BANK_B, "no ratings → newest wins");

  const three = await preWithRatings(bank, ratingsJson({ [BANK_A]: 3 }));
  assert.equal(three.ans.q_years.bank_page_id, BANK_B, "a 3 ties with unrated → newer");
});

test("pre ratings: an exact company+role+question match rated low falls back to a reusable one", async () => {
  const bank = [
    sqlAnswer(BANK_A, "Exact but bad", { company: "Acme", role: "Product Manager" }),
    sqlAnswer(BANK_B, "Portable"),
  ];
  const before = await preWithRatings(bank, undefined);
  assert.equal(before.ans.q_years.source, "bank");
  const after = await preWithRatings(bank, ratingsJson({ [BANK_A]: 2 }));
  assert.equal(after.ans.q_years.source, "bank_reuse");
  assert.equal(after.ans.q_years.bank_page_id, BANK_B);
});

test("pre ratings: an unreadable ratings file skips the bank (fail closed)", async () => {
  const { h, ans } = await preWithRatings([sqlAnswer(BANK_A, "Seven years")], "{not json");
  assert.equal(ans.q_years, undefined);
  assert.match(h.err.join("\n"), /answer ratings unreadable/);
});

test("pre: the stamped record lists which bank answers went into which form", async () => {
  const { h } = await preWithRatings([sqlAnswer(BANK_A, "Seven years")], undefined);
  const name = [...h.disk.keys()].find((k) => /apply_pre-.*\.json$/.test(k));
  const pre = JSON.parse(h.disk.get(name));
  assert.deepEqual(pre.bank_used, [{ key: "gh1", bank_page_id: BANK_A, source: "bank_reuse" }]);
});

test("pre: a To Apply row outside the profile geo is archived, never opened", async () => {
  const h = harness({
    apps: [
      row({ key: "gh1", companyName: "Acme", url: GH_URL, locations: ["San Francisco, CA"] }),
      row({ key: "waw", companyName: "Beta", url: GH2_URL, locations: ["Warsaw"] }),
    ],
    files: [RESUME],
  });
  h.deps.loadProfile = () => ({
    ...profile(),
    geo: { mode: "home_state_or_remote", home_state: "CA" },
  });
  assert.equal(await h.run({ phase: "pre" }), 0);
  assert.equal(h.log.filter((l) => l[0] === "open" && l[1] === GH2_URL).length, 0);
  const waw = h.store.apps.find((a) => a.key === "waw");
  assert.equal(waw.status, "Archived");
  assert.equal(waw.skip_reason, "geo_not_home_state_or_remote");
  assert.deepEqual(
    h.notionCalls.filter((c) => c[0] === "page-waw"),
    [["page-waw", "Archived"]]
  );
  assert.match(h.out.join("\n"), /1 outside your geo → archived/);
});

// --- open (human finishes one job) -----------------------------------------

function openHarness({ apps, successAfter = 1, blockers = [], closeAfter = null, rounds = {} }) {
  const h = harness({ apps, files: [RESUME] });
  const launched = [];
  let polls = 0;
  const base = h.deps.getAdapter;
  h.deps.getAdapter = (n) => {
    const a = base(n);
    return {
      ...a,
      async isSuccess() {
        polls += 1;
        return polls >= successAfter ? { url: "done", text: "Thank you for applying" } : null;
      },
      async enterSecurityCode(_page, code) {
        h.log.push(["code", code]);
        return { ok: true };
      },
    };
  };
  const baseLaunch = h.deps.launchBrowser;
  h.deps.launchBrowser = async (opts) => {
    launched.push(opts);
    const b = await baseLaunch(opts);
    return {
      ...b,
      newPage: async () => {
        const p = await b.newPage();
        p.page.isClosed = () => closeAfter !== null && polls >= closeAfter;
        return p;
      },
    };
  };
  const seen = [...blockers];
  h.deps.detectBlocker = async () => seen.shift() || null;
  h.deps.sleep = async () => {};
  h.deps.makeCodeWaiter = () => ({ wait: async () => "Ab3dE9fZ" });
  // Night answer rounds: rounds[name] = [answers…] under .apply-state/rounds/<name>/answers.
  const roundsDir = path.join(ROOT, ".apply-state", "rounds");
  h.deps.isDirectory = (p) =>
    p === roundsDir || Object.keys(rounds).some((r) => p === path.join(roundsDir, r, "answers"));
  h.deps.listDir = (p) =>
    p === roundsDir ? Object.keys(rounds) : p.endsWith("answers") ? ["job.json"] : [];
  for (const [r, answers] of Object.entries(rounds)) {
    h.disk.set(path.join(roundsDir, r, "answers", "job.json"), JSON.stringify({ answers }));
  }
  return { ...h, launched, polls: () => polls };
}

test("open: visible window, filled from the newest night answers, Applied by manual on confirmation", async () => {
  const h = openHarness({
    apps: [
      row({
        key: "gh1",
        companyName: "Acme",
        url: GH_URL,
        apply_state: "manual",
        apply_note: "captcha",
      }),
    ],
    successAfter: 3,
    rounds: {
      "2026-10-20T00": [{ ...WHY("gh1"), answer: "Old answer." }],
      "2026-10-21T00": [WHY("gh1")],
    },
  });
  assert.equal(await h.run({ phase: "open", key: "gh1" }), 0);
  assert.ok(
    h.launched.some((o) => o && o.headless === false),
    "a visible window for the human"
  );
  const fill = h.log.filter((l) => l[0] === "fill").pop();
  assert.equal(fill[2].q_why, "A sourced, truthful answer.", "the newest round wins");
  assert.equal(h.log.filter((l) => l[0] === "submit").length, 0, "the human presses Submit");
  const r = h.store.apps[0];
  assert.equal(r.status, "Applied");
  assert.equal(r.applied_by, "manual");
  assert.equal(r.apply_state, "submitted");
  assert.deepEqual(h.notionCalls, [["page-gh1", "Applied"]]);
});

test("open: a Greenhouse security code is typed in for the human and resubmitted", async () => {
  const h = openHarness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL, apply_state: "manual" })],
    successAfter: 99,
    blockers: ["email_verification"],
  });
  assert.equal(await h.run({ phase: "open", key: "gh1" }), 0);
  assert.deepEqual(
    h.log.filter((l) => l[0] === "code"),
    [["code", "Ab3dE9fZ"]]
  );
  assert.equal(h.log.filter((l) => l[0] === "submit").length, 1);
  assert.equal(h.store.apps[0].status, "Applied");
});

test("open: window closed without a confirmation → row untouched", async () => {
  const h = openHarness({
    apps: [
      row({
        key: "gh1",
        companyName: "Acme",
        url: GH_URL,
        apply_state: "manual",
        apply_note: "captcha",
      }),
    ],
    successAfter: 99,
    closeAfter: 2,
  });
  assert.equal(await h.run({ phase: "open", key: "gh1" }), 0);
  const r = h.store.apps[0];
  assert.deepEqual([r.status, r.apply_state, r.apply_note], ["To Apply", "manual", "captcha"]);
  assert.equal(h.notionCalls.length, 0);
});

test("open: input validation and never on an applied job", async () => {
  const h = openHarness({
    apps: [
      row({
        key: "gh1",
        companyName: "Acme",
        url: GH_URL,
        applied_date: "2026-10-20",
        status: "Applied",
      }),
    ],
  });
  assert.equal(await h.run({ phase: "open" }), 1);
  assert.match(h.err.join("\n"), /--key/);
  assert.equal(await h.run({ phase: "open", key: "nope" }), 1);
  assert.equal(await h.run({ phase: "open", key: "gh1" }), 1);
  assert.match(h.err.join("\n"), /already_applied/);
  assert.equal(h.launched.length, 0);
});

// ---- RFC 069 §4: the bot decides --------------------------------------------

const ASHBY_URL = `https://jobs.ashbyhq.com/acme/${UUID}/application`;

test("submit: Ashby forms open in a visible window, Greenhouse / Lever headless", async () => {
  const h = submitHarness({
    apps: [
      row({ key: "gh1", companyName: "Acme", url: GH_URL }),
      row({ key: "ash", companyName: "Beta", url: ASHBY_URL }),
    ],
    keys: [
      ["gh1", GH_URL, "Acme"],
      ["ash", ASHBY_URL, "Beta"],
    ],
    answers: [WHY("gh1"), WHY("ash")],
  });
  const launches = [];
  const pagesBy = [];
  h.deps.launchBrowser = async ({ headless }) => {
    launches.push(headless);
    return {
      newPage: async () => {
        pagesBy.push(headless);
        return { page: { url: "", screenshot: async () => {} }, close: async () => {} };
      },
      close: async () => {},
    };
  };
  const base = h.deps.getAdapter;
  h.deps.getAdapter = (n) => (n === "ashby" ? { ...base("greenhouse"), name: "ashby" } : base(n));
  const ctx = JSON.parse(h.disk.get(CONTEXT_PATH));
  ctx.jobs[1].ats = "ashby";
  h.disk.set(CONTEXT_PATH, JSON.stringify(ctx));
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 0);
  assert.deepEqual(launches.sort(), [false, true], "one headless + one visible browser");
  assert.deepEqual(pagesBy.sort(), [false, true]);
  assert.ok(h.store.apps.every((a) => a.status === "Applied"));
});

test("submit: injected headlessFor decides the window per ATS", async () => {
  const h = submitHarness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL })],
    keys: [["gh1", GH_URL, "Acme"]],
    answers: [WHY("gh1")],
  });
  const launches = [];
  const launch = h.deps.launchBrowser;
  h.deps.launchBrowser = async (opts) => {
    launches.push(opts.headless);
    return launch(opts);
  };
  h.deps.headlessFor = (ats) => ats !== "greenhouse";
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 0);
  // browserReady launches the default (headless) one; the Greenhouse form
  // itself opens in the visible one because the injected rule says so.
  assert.deepEqual(launches, [true, false]);
});

test("submit: an optional question without an answer is left blank and the row goes out", async () => {
  const form = [
    ...FORM.filter((f) => f.id !== "q_why"),
    { id: "q_extra", label: "Anything else?", type: "textarea", required: false, options: [] },
  ];
  const h = submitHarness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL })],
    keys: [["gh1", GH_URL, "Acme"]],
    answers: [],
    behavior: { [GH_URL]: { form } },
  });
  const ctx = JSON.parse(h.disk.get(CONTEXT_PATH));
  ctx.jobs[0].fields = form;
  ctx.jobs[0].unanswered = [
    {
      field_id: "q_extra",
      label: "Anything else?",
      type: "textarea",
      options: [],
      required: false,
    },
  ];
  h.disk.set(CONTEXT_PATH, JSON.stringify(ctx));
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 0);
  const fill = h.log.find((l) => l[0] === "fill");
  assert.equal(Object.prototype.hasOwnProperty.call(fill[2], "q_extra"), false);
  assert.equal(h.store.apps[0].status, "Applied");
});

test("submit: a crash after the Submit click is failed (never retried), before it skipped form_broken", async () => {
  const h = submitHarness({
    apps: [
      row({ key: "a", companyName: "Acme", url: GH_URL }),
      row({ key: "b", companyName: "Beta", url: GH2_URL }),
    ],
    keys: [
      ["a", GH_URL, "Acme"],
      ["b", GH2_URL, "Beta"],
    ],
    answers: [WHY("a"), WHY("b")],
  });
  const base = h.deps.getAdapter;
  h.deps.getAdapter = (n) => ({
    ...base(n),
    async readSchema(page) {
      if (page.url === GH2_URL) throw new Error("form vanished");
      return FORM;
    },
    async submit() {
      throw new Error("page crashed");
    },
  });
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 0);
  const by = Object.fromEntries(h.store.apps.map((x) => [x.key, x]));
  assert.deepEqual([by.a.apply_state, by.a.apply_note], ["failed", "no_confirmation"]);
  assert.deepEqual([by.b.apply_state, by.b.apply_note], ["skipped", "form_broken: unknown_page"]);
});

test("submit: guard skips (deadline) never touch the row state", async () => {
  const h = submitHarness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL, apply_state: "queued" })],
    keys: [["gh1", GH_URL, "Acme"]],
    answers: [WHY("gh1")],
  });
  assert.equal(
    await h.run({
      phase: "submit",
      answersFile: "/fake/answers.json",
      deadline: "2026-10-21T07:00:00Z",
    }),
    0
  );
  assert.equal(h.store.apps[0].apply_state, "queued");
  assert.equal(h.store.saves, 0);
});

test("resolveFields: the choice policy leaves an optional EEO question without a decline option blank", () => {
  const fields = [
    {
      id: "vet",
      label: "Are you a veteran?",
      type: "radio",
      required: false,
      options: ["Yes", "No"],
    },
    {
      id: "vet_req",
      label: "Are you a protected veteran?",
      type: "radio",
      required: true,
      options: ["Yes", "No"],
    },
    {
      id: "gender",
      label: "Gender",
      type: "radio",
      required: false,
      options: ["Man", "Woman", "Prefer not to say"],
    },
  ];
  const r = resolveFields(fields, {
    job: { company: "Acme", title: "PM" },
    identity: {},
    applyDefaults: profile().applyDefaults,
    salary: null,
    bank: [],
    files: { resume: { rel: "r.pdf" }, cover_letter: null },
  });
  assert.deepEqual(
    r.answers.map((a) => [a.field_id, a.value]),
    [["gender", "Prefer not to say"]]
  );
  assert.deepEqual(
    r.unanswered.map((u) => u.field_id),
    ["vet_req"],
    "a required one goes to the drafter"
  );
});

// ---- review fixes (BL-225): races, duplicates, trust ------------------------

// Wrap the fake adapters so a hook runs on open / fill.
function hookAdapter(h, hooks) {
  const base = h.deps.getAdapter;
  h.deps.getAdapter = (n) => {
    const a = base(n);
    if (!a) return a;
    return {
      ...a,
      async open(page, url) {
        if (hooks.open) await hooks.open(url);
        return a.open(page, url);
      },
      async fill(page, values) {
        if (hooks.fill) await hooks.fill(page.url);
        return a.fill(page, values);
      },
    };
  };
}

test("pre: a submit that lands between pre's load and save survives; the row is not re-queued", async () => {
  const h = harness({
    apps: [
      row({ key: "gh1", companyName: "Acme", url: GH_URL }),
      row({ key: "lv1", companyName: "Gamma", url: LEVER_URL }),
    ],
    files: [RESUME],
  });
  // The submitter (another process) sends gh1 while pre reads the forms.
  hookAdapter(h, {
    open: (url) => {
      if (url !== GH_URL) return;
      const r = h.store.apps.find((a) => a.key === "gh1");
      Object.assign(r, {
        status: "Applied",
        applied_date: "2026-10-21",
        applied_by: "bot",
        apply_state: "submitted",
        apply_note: ".apply-state/shots/gh1.png",
      });
    },
  });
  assert.equal(await h.run({ phase: "pre" }), 0);
  const by = Object.fromEntries(h.store.apps.map((a) => [a.key, a]));
  assert.deepEqual(
    [by.gh1.status, by.gh1.applied_date, by.gh1.apply_state, by.gh1.apply_note],
    ["Applied", "2026-10-21", "submitted", ".apply-state/shots/gh1.png"],
    "the submit is not overwritten"
  );
  assert.equal(by.lv1.apply_state, "queued", "pre's own change still lands");
  const ctx = JSON.parse(h.disk.get(CONTEXT_PATH));
  assert.deepEqual(
    ctx.jobs.map((j) => j.key),
    ["lv1"],
    "the submitted row is not handed to the submitter again"
  );
  assert.equal(ctx.skipped.find((s) => s.key === "gh1").reason, "already_applied");
});

test("pre: the same job through two rows → one job in the context, the other a guard skip", async () => {
  const h = harness({
    apps: [
      row({ key: "board", companyName: "Acme", url: GH_URL }),
      row({ key: "adz", companyName: "Acme", url: GH_URL }),
      // Already applied through a third row: a new row for the same form is
      // never queued.
      row({ key: "lv-done", companyName: "Gamma", url: LEVER_URL, status: "Applied" }),
      row({ key: "lv-new", companyName: "Gamma", url: LEVER_URL }),
    ],
    files: [RESUME],
  });
  assert.equal(await h.run({ phase: "pre" }), 0);
  const ctx = JSON.parse(h.disk.get(CONTEXT_PATH));
  assert.equal(ctx.jobs.length, 1);
  const kept = ctx.jobs[0].key;
  assert.ok(["board", "adz"].includes(kept));
  const dup = ctx.skipped.filter((s) => s.reason === "duplicate_job").map((s) => s.key);
  assert.deepEqual(dup.sort(), [kept === "board" ? "adz" : "board", "lv-new"].sort());
});

test("submit: a second row with the same form as a submitted one is never sent", async () => {
  const h = submitHarness({
    apps: [
      row({ key: "one", companyName: "Acme", url: GH_URL }),
      row({ key: "two", companyName: "Acme", url: "https://www.adzuna.com/land/ad/9" }),
    ],
    keys: [
      ["one", GH_URL, "Acme"],
      ["two", GH_URL, "Acme"],
    ],
    answers: [WHY("one"), WHY("two")],
  });
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 0);
  assert.equal(h.log.filter((l) => l[0] === "submit").length, 1, "one click only");
  const by = Object.fromEntries(h.store.apps.map((a) => [a.key, a]));
  assert.equal(by.one.status, "Applied");
  assert.equal(by.two.status, "To Apply");
  assert.equal(by.two.apply_state, "", "guard skip leaves the row as it is");
  const results = JSON.parse([...h.disk.entries()].find(([k]) => /apply_results-/.test(k))[1]);
  assert.equal(results.results.find((r) => r.key === "two").reason, "duplicate_job");
});

test("submit: the deadline is checked again right before the Submit click", async () => {
  const h = submitHarness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL })],
    keys: [["gh1", GH_URL, "Acme"]],
    answers: [WHY("gh1")],
  });
  let now = new Date("2026-10-21T08:00:00Z");
  h.deps.now = () => new Date(now);
  // Filling the form takes the clock past the deadline.
  hookAdapter(h, { fill: () => (now = new Date("2026-10-21T08:10:00Z")) });
  const flags = {
    phase: "submit",
    answersFile: "/fake/answers.json",
    deadline: "2026-10-21T08:05:00Z",
  };
  assert.equal(await h.run(flags), 0);
  assert.equal(h.log.filter((l) => l[0] === "submit").length, 0, "no click");
  const r = h.store.apps.find((a) => a.key === "gh1");
  assert.equal(r.status, "To Apply");
  assert.equal(r.apply_note, "", "no submitting: mark — the next run picks it up");
  const results = JSON.parse([...h.disk.entries()].find(([k]) => /apply_results-/.test(k))[1]);
  assert.deepEqual(
    [results.results[0].outcome, results.results[0].reason],
    ["skipped", "deadline"]
  );
});

test("submit: an unknown page after the Submit click is failed (unknown_after_click), not a skip", async () => {
  const h = submitHarness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL })],
    keys: [["gh1", GH_URL, "Acme"]],
    answers: [WHY("gh1")],
    behavior: { [GH_URL]: { submit: { ok: false, reason: "unknown_page", evidence: null } } },
  });
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 0);
  const r = h.store.apps.find((a) => a.key === "gh1");
  assert.deepEqual([r.apply_state, r.apply_note], ["failed", "unknown_after_click"]);
  assert.equal(r.status, "To Apply");
});

test("submit: a form URL off the ATS hosts, or not the ATS the context names, is never opened", async () => {
  const evil = "https://boards.greenhouse.io.evil.example/acme/jobs/111";
  const h = submitHarness({
    apps: [
      row({ key: "evil", companyName: "Acme", url: evil }),
      row({ key: "mismatch", companyName: "Beta", url: LEVER_URL }),
    ],
    keys: [
      ["evil", evil, "Acme"],
      ["mismatch", LEVER_URL, "Beta"],
    ],
    answers: [],
  });
  const ctx = JSON.parse(h.disk.get(CONTEXT_PATH));
  ctx.jobs[0].ats = "greenhouse";
  ctx.jobs[1].ats = "greenhouse"; // a Lever URL claimed as Greenhouse
  h.disk.set(CONTEXT_PATH, JSON.stringify(ctx));
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 0);
  assert.equal(h.log.filter((l) => l[0] === "open").length, 0);
  for (const r of h.store.apps) {
    assert.deepEqual([r.apply_state, r.apply_note], ["skipped", "form_broken: form_url_untrusted"]);
  }
});

test("buildFillPlan: a file answer outside the profile root, or not the engine's file, is never uploaded", () => {
  const root = "/fake/profiles/demo";
  const fields = [{ id: "resume", label: "Resume/CV", type: "file", required: true, options: [] }];
  const job = (value) => ({
    answers: [{ field_id: "resume", label: "Resume/CV", value, source: "file" }],
  });
  const ok = buildFillPlan(fields, job("resumes/cv.pdf"), [], root, ["resumes/cv.pdf"]);
  assert.equal(ok.values.resume, path.join(root, "resumes", "cv.pdf"));
  for (const bad of ["../../../etc/passwd", "/etc/passwd", "resumes/other.pdf"]) {
    const p = buildFillPlan(fields, job(bad), [], root, ["resumes/cv.pdf"]);
    assert.equal(p.values.resume, undefined, bad);
    assert.deepEqual(p.missingRequired, ["resume"], bad);
  }
  // An LLM answer never names a file to upload.
  const llm = buildFillPlan(
    fields,
    { answers: [] },
    [{ key: "k", label: "Resume/CV", answer: "/Users/someone/.ssh/id_rsa" }],
    root
  );
  assert.equal(llm.values.resume, undefined);
});

// ---- BL-236: fields that appear after the form is filled --------------------

const OWNER_DEFAULTS = {
  work_authorization: { authorized_us: true, requires_sponsorship: false },
  relocation: { willing: false },
  eeo: { policy: "decline" },
  salary: { floor: 120000, default: 180000 },
  how_did_you_hear_default: "Company careers page",
  legal_acknowledgements: "accept",
};
const consentField = (id, label) => ({ id, label, type: "checkbox", required: true, options: [] });
const CONSENT_DATA = consentField(
  "consent_data",
  "By checking this box, I agree to allow Acme to store and process my data for the purpose of considering my eligibility."
);
const CONSENT_SMS = consentField(
  "consent_sms",
  "By checking this box, I agree to receive SMS text messages about new roles."
);
const UNKNOWN_Q = {
  id: "q_color",
  label: "What is your favorite color?",
  type: "text",
  required: true,
  options: [],
};

// A form whose extra required fields exist only after the first fill (a
// checkbox Greenhouse renders once the answers are in). A checkbox is "checked"
// when a fill carried a value for it. `inSchema`: the extras are visible to
// the first readSchema too (the schema_changed case).
function lateAdapter(log, extras, { inSchema = false, stuck = false, onFill = () => {} } = {}) {
  const state = { filledOnce: false, checked: new Set() };
  return (name) => ({
    ...fakeAdapter(name, {}, log),
    async readSchema() {
      log.push(["readSchema"]);
      return state.filledOnce || inSchema ? [...FORM, ...extras] : FORM;
    },
    async fill(page, values) {
      log.push(["fill", page.url, values]);
      state.filledOnce = true;
      // Like the real adapters: a checkbox is only ticked by an affirmative value.
      for (const [id, v] of Object.entries(values)) {
        if (!stuck && !/^(no|false)$/i.test(String(v))) state.checked.add(id);
      }
      onFill();
      return { filled: Object.keys(values), errors: [] };
    },
    async checkFilled() {
      const missing = state.filledOnce
        ? extras.filter((f) => !state.checked.has(f.id)).map((f) => f.id)
        : [];
      return { missing, missingLabels: missing.map((id) => extras.find((f) => f.id === id).label) };
    },
  });
}

function lateHarness(extras, opts = {}, flags = {}) {
  const h = submitHarness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL })],
    keys: [["gh1", GH_URL, "Acme"]],
    answers: [WHY("gh1")],
    profileOver: { applyDefaults: OWNER_DEFAULTS },
  });
  h.deps.getAdapter = lateAdapter(h.log, extras, opts);
  const run = () => h.run({ phase: "submit", answersFile: "/fake/answers.json", ...flags });
  return { h, run, row: () => h.store.apps.find((a) => a.key === "gh1") };
}

test("submit: a consent box that appears after the fill is ticked in a second pass, no re-upload", async () => {
  const { h, run, row: get } = lateHarness([CONSENT_DATA]);
  assert.equal(await run(), 0);
  assert.equal(get().status, "Applied");
  const fills = h.log.filter((l) => l[0] === "fill");
  assert.equal(fills.length, 2);
  assert.ok("resume" in fills[0][2], "first pass attaches the files");
  assert.deepEqual(fills[1][2], { consent_data: "Yes" }, "second pass: only the new field");
  assert.equal(h.log.filter((l) => l[0] === "readSchema").length, 2, "the form is read again");
  assert.equal(h.log.filter((l) => l[0] === "submit").length, 1);
});

test("submit: a consent box present live but not in the context is answered, not schema_changed", async () => {
  const { h, run, row: get } = lateHarness([CONSENT_DATA], { inSchema: true });
  assert.equal(await run(), 0);
  assert.equal(get().status, "Applied");
  const fills = h.log.filter((l) => l[0] === "fill");
  assert.equal(fills.length, 1);
  assert.equal(fills[0][2].consent_data, "Yes");
});

test("submit: an unknown required field that appears late → required_empty with its label, no click", async () => {
  const { h, run, row: get } = lateHarness([UNKNOWN_Q]);
  assert.equal(await run(), 0);
  assert.equal(get().status, "To Apply");
  assert.equal(get().apply_state, "skipped");
  assert.equal(get().apply_note, "required_empty: What is your favorite color?");
  assert.equal(h.log.filter((l) => l[0] === "fill").length, 1, "nothing to fill → no second fill");
  assert.equal(h.log.filter((l) => l[0] === "submit").length, 0);
});

test("submit: a late unknown required field in the live schema stays schema_changed", async () => {
  const { h, run, row: get } = lateHarness([UNKNOWN_Q], { inSchema: true });
  assert.equal(await run(), 0);
  assert.equal(get().apply_note, "no_honest_answer: What is your favorite color?");
  assert.equal(h.log.filter((l) => l[0] === "fill").length, 0, "nothing was filled");
  const result = JSON.parse(
    h.disk.get([...h.disk.keys()].find((k) => /apply_results-.*\.json$/.test(k)))
  ).results[0];
  assert.equal(result.code, "schema_changed");
});

test("submit: a late SMS opt-in is never ticked → required_empty", async () => {
  const { h, run, row: get } = lateHarness([CONSENT_SMS]);
  assert.equal(await run(), 0);
  assert.equal(get().apply_state, "skipped");
  assert.match(get().apply_note, /^required_empty: By checking this box, I agree to receive SMS/);
  assert.equal(h.log.filter((l) => l[0] === "submit").length, 0);
});

test("submit: the second pass stops when the empty set does not shrink (at most one extra fill)", async () => {
  const { h, run, row: get } = lateHarness([CONSENT_DATA], { stuck: true });
  assert.equal(await run(), 0);
  assert.equal(get().apply_state, "skipped");
  assert.equal(h.log.filter((l) => l[0] === "fill").length, 2, "first fill + one late pass");
  assert.equal(h.log.filter((l) => l[0] === "submit").length, 0);
});

test("submit: a late field resolved from the owner's standing answers is filled", async () => {
  const h = submitHarness({
    apps: [row({ key: "gh1", companyName: "Acme", url: GH_URL })],
    keys: [["gh1", GH_URL, "Acme"]],
    answers: [WHY("gh1")],
    profileOver: {
      applyDefaults: {
        ...OWNER_DEFAULTS,
        standing_answers: [{ question: "What is your favorite color?", answer: "Green" }],
      },
    },
  });
  h.deps.getAdapter = lateAdapter(h.log, [UNKNOWN_Q]);
  assert.equal(await h.run({ phase: "submit", answersFile: "/fake/answers.json" }), 0);
  const fills = h.log.filter((l) => l[0] === "fill");
  assert.deepEqual(fills[1][2], { q_color: "Green" });
  assert.equal(h.store.apps[0].status, "Applied");
});

test("submit: a late pass never starts after the night's deadline", async () => {
  let clock = Date.parse("2026-10-21T08:00:00Z");
  const {
    h,
    run,
    row: get,
  } = lateHarness(
    [CONSENT_DATA],
    { onFill: () => (clock = Date.parse("2026-10-21T08:30:00Z")) },
    { deadline: "2026-10-21T08:10:00Z" }
  );
  h.deps.now = () => new Date(clock);
  assert.equal(await run(), 0);
  assert.equal(get().status, "To Apply");
  assert.equal(h.log.filter((l) => l[0] === "fill").length, 1);
  assert.equal(h.log.filter((l) => l[0] === "submit").length, 0);
});

// --- BL-243 (RFC 072): LatAm channel + AI order in `apply --phase pre` -----------

const { buildChannelIndex } = require("../core/company_channel.js");

const LATAM_URL = (slug) => `https://job-boards.greenhouse.io/${slug}/jobs/1`;
const LATAM_RULES = {
  company_cap: { max_active: 3, window_days: 30 },
  location_blocklist: ["Mexico", "Brazil", "Cyprus", "London"],
  channel_exceptions: { ru_latam: { allow_patterns: ["Mexico", "Brazil", "LATAM"] } },
  apply_priority: { ai_title_patterns: ["AI", "LLM"], ai_track_ids: [], ai_companies: [] },
};
const LATAM_SALARY = {
  floor: 95000,
  default: 180000,
  currency: "USD",
  by_channel: { ru_latam: { floor: 80000, default: 80000 } },
};

function latamHarness({ apps, jd = {}, rules = LATAM_RULES, salary = LATAM_SALARY }) {
  const h = harness({ apps, files: [RESUME] });
  h.deps.loadProfile = () => ({
    ...profile(),
    geo: { mode: "home_state_or_remote", home_state: "CA" },
    filterRules: rules,
    applyDefaults: { ...profile().applyDefaults, salary },
  });
  h.deps.loadChannelIndex = () =>
    buildChannelIndex([{ name: "Plata", extra: { channel: "ru_latam" } }]);
  h.deps.fetchJd = async (job) => ({ text: jd[job.slug] || "" });
  h.deps.getAdapter = (n) => {
    const a = fakeAdapter(n, {}, h.log);
    a.jobRef = (u) => ({ slug: new URL(u).pathname.split("/")[1], jobId: "1" });
    return a;
  };
  return h;
}
const ctxOf = (h) => JSON.parse(h.disk.get(CONTEXT_PATH));

test("pre (BL-243): Plata «Mexico City» is queued without archive; the same city at Acme is archived", async () => {
  const h = latamHarness({
    apps: [
      row({ key: "pl", companyName: "Plata", url: LATAM_URL("plata"), locations: ["Mexico City"] }),
      row({ key: "ac", companyName: "Acme", url: LATAM_URL("acme"), locations: ["Mexico City"] }),
      row({
        key: "cy",
        companyName: "Plata",
        url: LATAM_URL("plata2"),
        locations: ["Limassol, Cyprus"],
      }),
    ],
  });
  assert.equal(await h.run({ phase: "pre" }), 0);
  assert.deepEqual(
    ctxOf(h).jobs.map((j) => j.key),
    ["pl"]
  );
  const status = Object.fromEntries(h.store.apps.map((a) => [a.key, a.status]));
  assert.equal(status.pl, "To Apply");
  assert.equal(status.ac, "Archived");
  assert.equal(status.cy, "Archived");
});

test("pre (BL-243): without channel_exceptions (rollback / lilia) Plata «Mexico City» is archived", async () => {
  const rules = { ...LATAM_RULES };
  delete rules.channel_exceptions;
  const h = latamHarness({
    apps: [
      row({ key: "pl", companyName: "Plata", url: LATAM_URL("plata"), locations: ["Mexico City"] }),
    ],
    rules,
  });
  assert.equal(await h.run({ phase: "pre" }), 0);
  assert.equal(h.store.apps[0].status, "Archived");
});

test("pre (BL-243): the apply queue is ordered fit first, then AI first inside one fit", async () => {
  const h = latamHarness({
    apps: [
      row({ key: "plain", companyName: "A", url: LATAM_URL("a"), locations: ["Remote"] }),
      row({
        key: "ai",
        companyName: "B",
        title: "AI Product Manager",
        url: LATAM_URL("b"),
        locations: ["Remote"],
        createdAt: "2026-10-01T00:00:00Z",
      }),
      row({
        key: "med-ai",
        companyName: "C",
        title: "LLM Product Manager",
        fit_score: "Medium",
        url: LATAM_URL("c"),
        locations: ["Remote"],
      }),
    ],
  });
  assert.equal(await h.run({ phase: "pre", concurrency: 1 }), 0);
  assert.deepEqual(
    ctxOf(h).jobs.map((j) => j.key),
    ["ai", "plain", "med-ai"]
  );
});

test("pre (BL-243): ru_latam salary — default 80000, 85–90k kept, 60–75k archived, MXN text → default", async () => {
  const h = latamHarness({
    rules: { ...LATAM_RULES, company_cap: { max_active: 10, window_days: 30 } },
    apps: [
      row({
        key: "none",
        companyName: "Plata",
        url: LATAM_URL("s-none"),
        locations: ["Mexico City"],
      }),
      row({ key: "ok", companyName: "Plata", url: LATAM_URL("s-ok"), locations: ["Mexico City"] }),
      row({
        key: "low",
        companyName: "Plata",
        url: LATAM_URL("s-low"),
        locations: ["Mexico City"],
      }),
      row({
        key: "mxn",
        companyName: "Plata",
        url: LATAM_URL("s-mxn"),
        locations: ["Mexico City"],
      }),
      row({ key: "acme", companyName: "Acme", url: LATAM_URL("s-acme"), locations: ["Remote"] }),
    ],
    jd: {
      "s-ok": "Pay range $85,000 - $90,000",
      "s-low": "Pay range $60,000 - $75,000",
      "s-mxn": "Sueldo $45,000 – $60,000 MXN mensuales",
      "s-acme": "Pay range $85,000 - $90,000",
    },
  });
  assert.equal(await h.run({ phase: "pre", concurrency: 1 }), 0);
  const ctx = ctxOf(h);
  const byKey = Object.fromEntries(ctx.jobs.map((j) => [j.key, j]));
  assert.deepEqual(Object.keys(byKey).sort(), ["mxn", "none", "ok"]);
  const salaryOf = (j) => j.answers.find((a) => a.field_id === "q_salary").value;
  assert.equal(salaryOf(byKey.none), "80000");
  assert.equal(salaryOf(byKey.ok), "90000");
  assert.deepEqual(byKey.ok.salary.published_range, { min: 85000, max: 90000 });
  assert.equal(salaryOf(byKey.mxn), "80000");
  assert.equal(byKey.mxn.salary.published_range, null);
  assert.equal(ctx.skipped.find((s) => s.key === "low").reason, "salary_below_floor");
  assert.equal(ctx.skipped.find((s) => s.key === "acme").reason, "salary_below_floor");
});
