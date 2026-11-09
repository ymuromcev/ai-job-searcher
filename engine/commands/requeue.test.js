const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const applicationsTsv = require("../core/applications_tsv.js");
const companiesTsv = require("../core/companies.js");
const {
  makeRequeueCommand,
  selectCandidates,
  confirmationQuery,
  jobState,
} = require("./requeue.js");

const LEVER_ID = "0f0f0f0f-1111-4222-8333-444444444444";
const ASHBY_ID = "1a1a1a1a-2222-4333-8444-555555555555";

function app(over) {
  return {
    key: over.key,
    source: "greenhouse",
    jobId: "1",
    companyName: "Acme",
    title: "Product Manager",
    url: "",
    locations: [],
    status: "Applied",
    notion_page_id: "",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-21T00:00:00Z",
    applied_date: "2026-10-21",
    applied_by: "bot",
    apply_state: "submitted",
    apply_note: "shot.png",
    ...over,
  };
}

// Rows of the October scenario.
function rows() {
  return [
    // Unconfirmed, job open on Greenhouse → requeue.
    app({
      key: "greenhouse:111",
      jobId: "111",
      companyName: "Globex",
      notion_page_id: "page-globex",
    }),
    // Unconfirmed Ashby (no liveness API) → requeue, state unknown.
    app({
      key: "ashby:" + ASHBY_ID,
      source: "ashby",
      jobId: ASHBY_ID,
      companyName: "Initech",
      status: "No Response",
      url: `https://jobs.ashbyhq.com/initech/${ASHBY_ID}`,
    }),
    // Confirmation mail in the apply mailbox → kept.
    app({ key: "greenhouse:222", jobId: "222", companyName: "Umbrella Corp" }),
    // Job closed (Lever 404) → kept.
    app({
      key: "lever:" + LEVER_ID,
      source: "lever",
      jobId: LEVER_ID,
      companyName: "Hooli",
      url: `https://jobs.lever.co/hooli/${LEVER_ID}`,
    }),
    // Before --since → not looked at.
    app({ key: "greenhouse:333", jobId: "333", applied_date: "2026-10-10" }),
    // Moved on to Interview → kept.
    app({ key: "greenhouse:444", jobId: "444", companyName: "Vandelay", status: "Interview" }),
    // Applied by hand, not by the bot → not looked at.
    app({ key: "greenhouse:555", jobId: "555", applied_by: "manual", apply_state: "" }),
  ];
}

const MAILS = [
  {
    from: "Umbrella Recruiting <no-reply@umbrella.example>",
    subject: "Thank you for applying to Umbrella",
    body: "We have received your application.",
    date: "2026-10-21T15:00:00Z",
  },
  // Globex mail from BEFORE the application day: not a confirmation of it.
  {
    from: "Globex <jobs@globex.example>",
    subject: "Thank you for applying",
    body: "Globex",
    date: "2026-10-01T10:00:00Z",
  },
];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "requeue-cmd-"));
  const tsv = path.join(root, "applications.tsv");
  applicationsTsv.save(tsv, rows());
  const dataDir = path.join(root, "data");
  companiesTsv.save(path.join(dataDir, "companies.tsv"), [
    { name: "Globex", source: "greenhouse", slug: "globex", extra: null, profile: "" },
    { name: "Umbrella Corp", source: "greenhouse", slug: "umbrella", extra: null, profile: "" },
  ]);
  // The October submit run's results: "submitted" with no confirmation page.
  writeResults(
    root,
    "2026-10-21T08-00-00-000Z",
    rows().map((a) => ({ key: a.key, outcome: "submitted", evidence: null }))
  );
  return { root, tsv, dataDir };
}

function writeResults(root, stamp, results) {
  const dir = path.join(root, ".apply-state");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `apply_results-${stamp}.json`),
    JSON.stringify({ generated_at: "2026-10-21T08:00:00.000Z", results })
  );
}

function fakeDeps(env, over = {}) {
  const log = { queries: [], posting: [], notion: [] };
  const deps = {
    loadProfile: () => ({
      id: "jared",
      paths: { root: env.root, applicationsTsv: env.tsv },
      notion: {},
    }),
    loadSecrets: () => ({ NOTION_TOKEN: "secret_test" }),
    makeMailFetcher: () => async (q) => {
      log.queries.push(q);
      return MAILS;
    },
    fetchFn: async () => {
      throw new Error("no network in tests");
    },
    checkPostingOpen: async (ref) => {
      log.posting.push(`${ref.ats}:${ref.slug}:${ref.jobId}`);
      // Same answers as canonical_url.checkPostingOpen: Ashby has no API.
      if (ref.ats === "ashby") return "unknown";
      return ref.ats === "lever" ? "closed" : "open";
    },
    makeNotionClient: (token) => ({ token }),
    updatePageStatus: async (_client, pageId, status) => {
      log.notion.push([pageId, status]);
    },
    today: () => "2026-11-09",
    ...over,
  };
  return { deps, log };
}

async function run(env, deps, flags) {
  const out = [];
  const err = [];
  const code = await makeRequeueCommand(deps)({
    profileId: "jared",
    flags: { since: "2026-10-20", apply: false, dryRun: false, ...flags },
    dataDir: env.dataDir,
    env: {},
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("selectCandidates: bot submits since the date, Applied / No Response only", () => {
  const { candidates, skipped } = selectCandidates(rows(), "2026-10-20");
  assert.deepEqual(
    candidates.map((a) => a.key),
    ["greenhouse:111", "ashby:" + ASHBY_ID, "greenhouse:222", "lever:" + LEVER_ID]
  );
  assert.deepEqual(
    skipped.map((s) => [s.app.key, s.reason]),
    [["greenhouse:444", "status_Interview"]]
  );
});

test("confirmationQuery: Gmail search from the day before --since", () => {
  const q = confirmationQuery("2026-10-20");
  assert.match(q, /^after:2026\/10\/19 /);
  assert.match(q, /-subject:"security code"/);
});

test("jobState: canonical Greenhouse, Lever from the URL, Ashby unknown", async () => {
  const seen = [];
  const checkOpen = async (ref) => {
    seen.push(ref.ats);
    return "open";
  };
  const index = new Map([["globex", [{ source: "greenhouse", slug: "globex" }]]]);
  const [gh, , , lever] = rows();
  assert.equal(await jobState(gh, { slugIndex: index, checkOpen }), "open");
  assert.equal(await jobState(lever, { slugIndex: new Map(), checkOpen }), "open");
  const noUrl = { ...rows()[1], source: "adzuna", url: "https://www.adzuna.com/x" };
  assert.equal(await jobState(noUrl, { slugIndex: new Map(), checkOpen }), "unknown");
  assert.deepEqual(seen, ["greenhouse", "lever"]);
});

test("requeue dry run: prints the list, writes nothing", async () => {
  const env = setup();
  const before = fs.readFileSync(env.tsv, "utf8");
  const { deps, log } = fakeDeps(env);
  const r = await run(env, deps, {});
  assert.equal(r.code, 0);
  assert.match(
    r.out,
    /4 bot submission\(s\): 2 to requeue, 1 confirmed by email, 0 confirmed by page, 0 without a results record, 1 closed/
  );
  assert.match(r.out, /requeue\s+greenhouse:111\s+Globex/);
  assert.match(r.out, /requeue\s+ashby:\S+\s+Initech .*job unknown/);
  assert.match(r.out, /confirmed greenhouse:222\s+Umbrella Corp/);
  assert.match(r.out, /closed\s+lever:\S+\s+Hooli/);
  assert.match(r.out, /kept\s+greenhouse:444 .*status_Interview/);
  assert.match(r.out, /dry-run: nothing written/);
  assert.equal(fs.readFileSync(env.tsv, "utf8"), before);
  assert.equal(log.queries.length, 1);
  assert.deepEqual(log.posting, [
    "greenhouse:globex:111",
    "ashby:initech:" + ASHBY_ID,
    "lever:hooli:" + LEVER_ID,
  ]);
  assert.equal(log.notion.length, 0);
});

test("requeue --apply: Notion first, then the TSV rows go back to queued", async () => {
  const env = setup();
  const { deps, log } = fakeDeps(env);
  const r = await run(env, deps, { apply: true });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /2 row\(s\) back in the queue/);
  assert.deepEqual(log.notion, [["page-globex", "To Apply"]]);
  const byKey = Object.fromEntries(applicationsTsv.load(env.tsv).apps.map((a) => [a.key, a]));
  for (const key of ["greenhouse:111", "ashby:" + ASHBY_ID]) {
    const a = byKey[key];
    assert.equal(a.status, "To Apply");
    assert.equal(a.applied_date, "");
    assert.equal(a.applied_by, "");
    assert.equal(a.apply_state, "queued");
    assert.equal(a.apply_note, "requeued:2026-11-09");
  }
  for (const key of ["greenhouse:222", "lever:" + LEVER_ID, "greenhouse:333", "greenhouse:444"]) {
    assert.equal(byKey[key].apply_state, "submitted", key);
    assert.notEqual(byKey[key].status, "To Apply", key);
  }
});

test("requeue --apply: a failed Notion update leaves that row as is", async () => {
  const env = setup();
  const { deps } = fakeDeps(env, {
    updatePageStatus: async () => {
      throw new Error("rate limited");
    },
  });
  const r = await run(env, deps, { apply: true });
  assert.equal(r.code, 1);
  assert.match(r.err, /greenhouse:111 failed \(rate limited\)/);
  const byKey = Object.fromEntries(applicationsTsv.load(env.tsv).apps.map((a) => [a.key, a]));
  assert.equal(byKey["greenhouse:111"].status, "Applied");
  assert.equal(byKey["ashby:" + ASHBY_ID].apply_state, "queued");
});

test("requeue --apply without a Notion token refuses (sync would undo it)", async () => {
  const env = setup();
  const before = fs.readFileSync(env.tsv, "utf8");
  const { deps } = fakeDeps(env, { loadSecrets: () => ({}) });
  const r = await run(env, deps, { apply: true });
  assert.equal(r.code, 1);
  assert.match(r.err, /JARED_NOTION_TOKEN/);
  assert.equal(fs.readFileSync(env.tsv, "utf8"), before);
});

test("requeue: no apply mailbox → refuses, nothing changed", async () => {
  const env = setup();
  const { deps } = fakeDeps(env, { makeMailFetcher: () => null });
  const r = await run(env, deps, { apply: true });
  assert.equal(r.code, 1);
  assert.match(r.err, /JARED_APPLY_GMAIL_USER/);
});

test("requeue: mailbox read error → refuses", async () => {
  const env = setup();
  const { deps } = fakeDeps(env, {
    makeMailFetcher: () => async () => {
      throw new Error("IMAP auth failed");
    },
  });
  const r = await run(env, deps, {});
  assert.equal(r.code, 1);
  assert.match(r.err, /IMAP auth failed/);
});

test("requeue: bad or missing --since", async () => {
  const env = setup();
  const { deps } = fakeDeps(env);
  for (const since of ["", "2026-13-45x", "20261020"]) {
    const r = await run(env, deps, { since });
    assert.equal(r.code, 1);
    assert.match(r.err, /--since/);
  }
});

test("requeue: a confirmation page in the results, or no results record at all → kept", async () => {
  const env = setup();
  // Globex: the ATS showed its thank-you page. Initech: no results record.
  fs.rmSync(path.join(env.root, ".apply-state"), { recursive: true, force: true });
  writeResults(env.root, "2026-10-21T08-00-00-000Z", [
    {
      key: "greenhouse:111",
      outcome: "submitted",
      evidence: { url: "https://job-boards.greenhouse.io/globex/jobs/111/done", text: "Thanks" },
    },
    { key: "lever:" + LEVER_ID, outcome: "submitted", evidence: null },
  ]);
  const { deps, log } = fakeDeps(env);
  const r = await run(env, deps, { apply: true });
  assert.equal(r.code, 0, r.err);
  assert.match(
    r.out,
    /0 to requeue, 1 confirmed by email, 1 confirmed by page, 1 without a results record/
  );
  assert.match(r.out, /confirmed greenhouse:111 .*confirmation page/);
  assert.match(r.out, /kept\s+ashby:\S+ .*no results record/);
  assert.deepEqual(log.notion, []);
  const byKey = Object.fromEntries(applicationsTsv.load(env.tsv).apps.map((a) => [a.key, a]));
  assert.equal(byKey["greenhouse:111"].status, "Applied");
  assert.equal(byKey["ashby:" + ASHBY_ID].apply_state, "submitted");
});

test("requeue --apply: a row that changed meanwhile is re-checked inside the TSV lock and kept", async () => {
  const env = setup();
  let locked = 0;
  const { deps, log } = fakeDeps(env, {
    // Between the Notion update and the TSV write, the Globex row moves on
    // to Interview (a recruiter answered): it must not be requeued.
    withApplicationsLock: async (p, fn) => {
      locked += 1;
      const { apps } = applicationsTsv.load(env.tsv);
      apps.find((a) => a.key === "greenhouse:111").status = "Interview";
      applicationsTsv.save(env.tsv, apps);
      return applicationsTsv.withLock(p, fn);
    },
  });
  const r = await run(env, deps, { apply: true });
  assert.equal(locked, 1);
  assert.match(r.out, /1 row\(s\) back in the queue/);
  const byKey = Object.fromEntries(applicationsTsv.load(env.tsv).apps.map((a) => [a.key, a]));
  assert.equal(byKey["greenhouse:111"].status, "Interview");
  assert.equal(byKey["greenhouse:111"].apply_state, "submitted");
  assert.equal(byKey["ashby:" + ASHBY_ID].status, "To Apply");
  // Its Notion page had already been moved to To Apply: back to Interview.
  assert.deepEqual(log.notion, [
    ["page-globex", "To Apply"],
    ["page-globex", "Interview"],
  ]);
  assert.match(r.err, /greenhouse:111 changed since the check \(now Interview\)/);
});

test("requeue: rows the old bot left to a human go back to the queue, unless they went out", async () => {
  const env = setup();
  const left = (over) =>
    app({
      status: "To Apply",
      applied_date: "",
      applied_by: "",
      updatedAt: "2026-10-25T00:00:00Z",
      ...over,
    });
  applicationsTsv.save(
    env.tsv,
    rows().concat([
      left({
        key: "ashby:m1",
        companyName: "Soylent",
        apply_state: "manual",
        apply_note: "captcha",
      }),
      left({
        key: "ashby:f1",
        companyName: "Massive Dynamic",
        apply_state: "failed",
        apply_note: "no_confirmation",
      }),
      // Its results record shows the ATS's thank-you page → kept.
      left({ key: "ashby:f2", companyName: "Wayne", apply_state: "failed" }),
      // Before --since → not looked at.
      left({ key: "ashby:m2", apply_state: "manual", updatedAt: "2026-10-01T00:00:00Z" }),
      // Already handled by the new bot → not looked at.
      left({ key: "ashby:s1", apply_state: "skipped", apply_note: "captcha" }),
    ])
  );
  writeResults(env.root, "2026-10-25T08-00-00-000Z", [
    {
      key: "ashby:f2",
      outcome: "submitted",
      evidence: { url: "https://jobs.ashbyhq.com/wayne/thanks" },
    },
  ]);
  const { deps, log } = fakeDeps(env);
  const dry = await run(env, deps, {});
  assert.equal(dry.code, 0, dry.err);
  assert.match(
    dry.out,
    /3 row\(s\) the old bot left to a human \(manual \/ failed\): 2 to requeue, 1 kept/
  );
  assert.match(dry.out, /requeue\s+ashby:m1\s+Soylent .*was manual: captcha/);
  assert.match(dry.out, /requeue\s+ashby:f1\s+Massive Dynamic/);
  assert.match(dry.out, /dry-run: nothing written. Re-run with --apply to requeue 4 row\(s\)/);

  const r = await run(env, deps, { apply: true });
  assert.equal(r.code, 0, r.err);
  const byKey = Object.fromEntries(applicationsTsv.load(env.tsv).apps.map((a) => [a.key, a]));
  for (const key of ["ashby:m1", "ashby:f1"]) {
    assert.equal(byKey[key].apply_state, "queued", key);
    assert.equal(byKey[key].apply_note, "requeued:2026-11-09");
    assert.equal(byKey[key].status, "To Apply");
  }
  assert.equal(byKey["ashby:m2"].apply_state, "manual");
  assert.equal(byKey["ashby:s1"].apply_state, "skipped");
  // No Notion call for the left rows: their pages already say To Apply.
  assert.deepEqual(log.notion, [["page-globex", "To Apply"]]);
});
