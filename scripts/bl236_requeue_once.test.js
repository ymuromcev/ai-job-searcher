// Tests for the BL-236 one-off requeue script: nothing touches the disk, the
// network or Notion (every dep is faked).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const script = require("./bl236_requeue_once.js");
const { classifyRow } = require("../engine/modules/tailor/dispatcher.js");

const ROOT = "/fake/profiles/demo";
const TSV = path.join(ROOT, "applications.tsv");

const VERSIONS = {
  AI_Platform: { title: "SENIOR AI PRODUCT MANAGER — PLATFORM", filename: "CV_AI_Platform.docx" },
  Risk_Fraud: { title: "SENIOR PRODUCT MANAGER — RISK & FRAUD", filename: "CV_Risk_Fraud.docx" },
  Marketplace: { title: "SENIOR PRODUCT MANAGER — MARKETPLACES", filename: "CV_Marketplace.docx" },
};

function profile() {
  return {
    id: "demo",
    identity: { name: "Test Candidate" },
    resumeVersions: { versions: VERSIONS },
    paths: { root: ROOT, applicationsTsv: TSV, resumesDir: path.join(ROOT, "resumes") },
  };
}

function app(over) {
  return {
    key: over.key,
    source: "greenhouse",
    jobId: over.key,
    companyName: `Co ${over.key}`,
    title: "Product Manager",
    status: "Inbox",
    notion_page_id: "",
    resume_ver: "",
    cl_key: "",
    cl_path: "",
    fit_score: "Strong",
    fit_evaluated_at: "2026-11-14T00:00:00.000Z",
    applied_date: "",
    apply_state: "",
    apply_note: "",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

const rec = (key, over = {}) => ({
  key,
  fitScore: "Strong",
  fitRationale: "core",
  clKey: `Co_pm_${key}`,
  clParagraphs: ["a", "b", "c", "d"],
  resumeVer: "AI_Platform",
  tailoredResume: { version: { summary: key } },
  tailorCoverage: 60,
  tailorEscalated: true,
  tailorEscalationReason: "no_growth_below_threshold",
  ...over,
});

function resultsFile(results) {
  return JSON.stringify({ profileId: "demo", results });
}

function harness({ apps, files = {}, nightLock = false }) {
  const store = { apps: apps.map((a) => ({ ...a })), saves: 0 };
  const disk = new Map(Object.entries(files));
  for (const k of Object.keys(VERSIONS)) {
    disk.set(path.join(ROOT, "resumes", `CV_${k}.pdf`), "%PDF");
  }
  const out = [];
  const err = [];
  const commits = [];
  const deps = {
    loadProfile: () => profile(),
    loadApplications: () => ({ apps: store.apps.map((a) => ({ ...a })) }),
    saveApplications: (_p, list) => {
      store.apps = list.map((a) => ({ ...a }));
      store.saves += 1;
    },
    withLock: async (_p, fn) => fn(),
    listDir: (p) =>
      [...disk.keys()].filter((k) => path.dirname(k) === p).map((k) => path.basename(k)),
    readFile: (p) => disk.get(p),
    writeFile: (p, d) => disk.set(p, d),
    fileExists: (p) => disk.has(p),
    classifyRow,
    nightLockExists: () => nightLock,
    now: () => new Date("2026-11-15T12:00:00Z"),
    today: () => "2026-11-15",
    // The real commit moves Inbox rows to To Apply, gives them a page, a
    // cover letter and a resume, and stamps fit_evaluated_at with "now".
    commit: async (ctx) => {
      const data = JSON.parse(disk.get(ctx.flags.resultsFile));
      commits.push(data);
      store.apps = store.apps.map((a) => {
        const r = data.results.find((x) => x.key === a.key);
        if (!r) return a;
        return {
          ...a,
          status: "To Apply",
          notion_page_id: `page-${a.key}`,
          cl_path: `cl/${r.clKey}.pdf`,
          cl_key: r.clKey,
          resume_ver: r.tailoredResume ? `resumes/tailored/${a.key}.pdf` : r.resumeVer,
          fit_evaluated_at: "2026-11-15T12:00:00.000Z",
        };
      });
      return 0;
    },
  };
  const io = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env: {},
  };
  const go = (flags = {}) =>
    script.run({ profile: "demo", apply: false, ignoreNightLock: false, ...flags }, deps, io);
  return { deps, store, disk, out, err, commits, go };
}

const FILES = (list) => ({
  [path.join(ROOT, "prepare_results_20261110_010000.json")]: resultsFile(list[0] || []),
  [path.join(ROOT, "prepare_results_20261112_010000.json")]: resultsFile(list[1] || []),
});

test("parseArgs: --profile is required, --apply is opt-in", () => {
  assert.equal(script.parseArgs(["node", "x"]).error, "--profile <id> is required");
  const o = script.parseArgs(["node", "x", "--profile", "jared", "--apply"]);
  assert.deepEqual([o.profile, o.apply, o.error], ["jared", true, null]);
  assert.equal(
    script.parseArgs(["node", "x", "--profile", "j", "--wat"]).error,
    "unknown argument: --wat"
  );
});

test("the LAST record by key wins, whatever the earlier coverage was", () => {
  const records = new Map([
    [
      "a",
      [
        { file: "f1", row: rec("a", { tailorCoverage: 70 }) },
        { file: "f2", row: rec("a", { tailorCoverage: 55 }) },
      ],
    ],
  ]);
  const best = script.bestRecord(records.get("a"));
  assert.equal(best.file, "f2");
  assert.equal(best.cov, 55);
});

test("an old no_growth 70% record + a newer uncertain_about_fact 50% one: the row is held", () => {
  const apps = [app({ key: "u1" })];
  const records = new Map([
    [
      "u1",
      [
        {
          file: "f1",
          row: rec("u1", {
            tailorCoverage: 70,
            tailorEscalated: true,
            tailorEscalationReason: "no_growth_below_threshold",
          }),
        },
        {
          file: "f2",
          row: rec("u1", {
            tailorCoverage: 50,
            tailorEscalated: true,
            tailorEscalationReason: "uncertain_about_fact",
          }),
        },
      ],
    ],
  ]);
  const plan = script.planStrong(apps, records, {
    classify: classifyRow,
    versionKeys: new Set(),
  });
  assert.equal(plan.eligible.length, 0);
  assert.equal(plan.held.length, 1);
  assert.equal(plan.held[0].why, "uncertain_about_fact");
});

test("a 'blocked' uncertain_about_fact (no job text) goes back as the base resume, a real fact stays held", () => {
  const blocked = rec("b1", {
    flags: ["jd-unavailable"],
    resumeVer: "AI_Platform",
    tailoredResume: null,
    tailorCoverage: 0,
    tailorEscalationReason: "uncertain_about_fact",
    tailorEscalationDetail: { iterations: 1, uncertain_facts: [{ fact: "blocked" }] },
  });
  const real = rec("r1", {
    tailorEscalationReason: "uncertain_about_fact",
    tailorEscalationDetail: { uncertain_facts: [{ fact: "led a team of 8" }] },
  });
  const records = new Map([
    ["b1", [{ file: "f1", row: blocked }]],
    ["r1", [{ file: "f1", row: real }]],
  ]);
  const plan = script.planStrong([app({ key: "b1" }), app({ key: "r1" })], records, {
    classify: classifyRow,
    versionKeys: new Set(["AI_Platform"]),
  });
  assert.deepEqual(
    plan.eligible.map((e) => [e.app.key, e.kind]),
    [["b1", "archetype"]]
  );
  assert.deepEqual(
    plan.held.map((h) => h.app.key),
    ["r1"]
  );
});

test("dry-run (default): lists 2 Strong + 1 held + 1 Weak, writes nothing", async () => {
  const h = harness({
    apps: [
      app({ key: "s1" }),
      app({ key: "s2" }),
      app({ key: "s3" }), // unconfirmed fact → held
      app({
        key: "w1",
        status: "To Apply",
        fit_score: "Weak",
        notion_page_id: "p",
        apply_state: "skipped",
        apply_note: "form_broken: resume_not_set",
        title: "Risk Fraud Manager",
      }),
      app({
        key: "w2",
        status: "To Apply",
        fit_score: "Weak",
        notion_page_id: "p",
        apply_state: "skipped",
        apply_note: "no_company_form: unresolved_url:x",
      }),
    ],
    files: FILES([
      [
        rec("s1"),
        rec("s3", { tailorEscalationReason: "uncertain_about_fact", tailoredResume: null }),
      ],
      [rec("s2", { tailorCoverage: 0 })],
    ]),
  });
  assert.equal(await h.go(), 0);
  const text = h.out.join("\n");
  assert.match(
    text,
    /Strong stuck in Inbox: 2 to requeue \(1 with the best draft, 1 with the base resume\), 1 held/
  );
  assert.match(text, /Weak without a resume version in To Apply: 1 to fix in place, 1 left alone/);
  assert.match(text, /dry-run: nothing written/);
  assert.equal(h.store.saves, 0);
  assert.equal(h.commits.length, 0);
  assert.deepEqual(
    [...h.disk.keys()].filter((k) => /_bl236\.json$/.test(k)),
    [],
    "no results file in a dry run"
  );
});

test("--apply: Strong go through the ordinary commit, fit_evaluated_at is not moved, Weak get a resume in place", async () => {
  const h = harness({
    apps: [
      app({ key: "s1" }),
      app({ key: "s2" }),
      app({
        key: "w1",
        status: "To Apply",
        fit_score: "Weak",
        notion_page_id: "p",
        apply_state: "skipped",
        apply_note: "form_broken: resume_not_set",
        title: "Risk and Fraud Product Manager",
      }),
      app({
        key: "w2",
        status: "To Apply",
        fit_score: "Weak",
        notion_page_id: "p",
        apply_state: "",
        title: "Staff Engineer",
      }),
      app({
        key: "w3",
        status: "To Apply",
        fit_score: "Weak",
        notion_page_id: "p",
        apply_state: "skipped",
        apply_note: "no_company_form: unresolved_url:x",
      }),
      app({
        key: "w4",
        status: "To Apply",
        fit_score: "Weak",
        notion_page_id: "p",
        apply_state: "skipped",
        apply_note: "captcha",
        title: "Risk and Fraud Product Manager",
      }),
      app({
        key: "w5",
        status: "To Apply",
        fit_score: "Weak",
        notion_page_id: "p",
        apply_state: "skipped",
        apply_note: "no_honest_answer: salary",
        title: "Risk and Fraud Product Manager",
      }),
    ],
    files: FILES([[rec("s1")], [rec("s2", { tailorCoverage: 0 })]]),
  });
  assert.equal(await h.go({ apply: true }), 0);
  assert.equal(h.commits.length, 1);
  assert.deepEqual(h.commits[0].results.map((r) => r.key).sort(), ["s1", "s2"]);

  const by = Object.fromEntries(h.store.apps.map((a) => [a.key, a]));
  for (const k of ["s1", "s2"]) {
    assert.equal(by[k].status, "To Apply");
    assert.ok(by[k].notion_page_id && by[k].cl_path && by[k].resume_ver);
    assert.equal(by[k].fit_evaluated_at, "2026-11-14T00:00:00.000Z", "fit_evaluated_at not moved");
  }
  // Weak: resume in place; the skipped one is queued again, the untried one keeps its state.
  assert.equal(by.w1.resume_ver, "Risk_Fraud");
  assert.equal(by.w1.apply_state, "queued");
  assert.equal(by.w1.apply_note, "requeued:2026-11-15");
  assert.equal(
    by.w2.resume_ver,
    "AI_Platform",
    "no title match → the most used archetype… or the first"
  );
  assert.equal(by.w2.apply_state, "");
  // no_company_form is not touched.
  assert.equal(by.w3.resume_ver, "");
  assert.equal(by.w3.apply_state, "skipped");
  // Skipped for another reason (captcha, no_honest_answer): left exactly as is.
  for (const k of ["w4", "w5"]) {
    assert.equal(by[k].resume_ver, "");
    assert.equal(by[k].apply_state, "skipped");
  }
  assert.equal(by.w4.apply_note, "captcha");
  assert.match(h.out.join("\n"), /Strong: 2 of 2 row\(s\) are in To Apply/);
});

test("idempotent: a second --apply finds nothing", async () => {
  const h = harness({
    apps: [
      app({ key: "s1" }),
      app({
        key: "w1",
        status: "To Apply",
        fit_score: "Weak",
        notion_page_id: "p",
        apply_state: "skipped",
        apply_note: "form_broken: resume_not_set",
      }),
    ],
    files: FILES([[rec("s1")]]),
  });
  await h.go({ apply: true });
  const saves = h.store.saves;
  h.out.length = 0;
  assert.equal(await h.go({ apply: true }), 0);
  assert.match(h.out.join("\n"), /0 to requeue/);
  assert.match(h.out.join("\n"), /0 to fix in place/);
  assert.match(h.out.join("\n"), /nothing to write/);
  assert.equal(h.commits.length, 1, "no second commit");
  assert.equal(h.store.saves, saves, "no second write");
});

test("race with a live night: a row that left Inbox / To Apply meanwhile is skipped", async () => {
  const h = harness({
    apps: [
      app({ key: "s1" }),
      app({ key: "s2" }),
      app({
        key: "w1",
        status: "To Apply",
        fit_score: "Weak",
        notion_page_id: "p",
        apply_state: "skipped",
        apply_note: "form_broken: resume_not_set",
      }),
    ],
    files: FILES([[rec("s1"), rec("s2")]]),
  });
  // The night takes s2 (status moves) and applies to w1 between plan and write.
  const realLoad = h.deps.loadApplications;
  let loads = 0;
  h.deps.loadApplications = (p) => {
    loads += 1;
    const r = realLoad(p);
    if (loads === 2) {
      for (const a of h.store.apps) {
        if (a.key === "s2") a.status = "Archived";
        if (a.key === "w1") {
          a.status = "Applied";
          a.applied_date = "2026-11-15";
        }
      }
      return realLoad(p);
    }
    return r;
  };
  assert.equal(await h.go({ apply: true }), 0);
  const by = Object.fromEntries(h.store.apps.map((a) => [a.key, a]));
  assert.equal(by.s2.status, "Archived", "left as the night wrote it");
  assert.deepEqual(
    h.commits[0].results.map((r) => r.key),
    ["s1"]
  );
  assert.equal(by.w1.resume_ver, "", "an applied row is not touched");
  assert.match(h.err.join("\n"), /1 row\(s\) left Inbox meanwhile/);
});

test("a running night blocks --apply (dry-run is still fine)", async () => {
  const h = harness({ apps: [app({ key: "s1" })], files: FILES([[rec("s1")]]), nightLock: true });
  assert.equal(await h.go(), 0);
  assert.equal(await h.go({ apply: true }), 1);
  assert.match(h.err.join("\n"), /night run holds its lock/);
  assert.equal(h.commits.length, 0);
  assert.equal(await h.go({ apply: true, ignoreNightLock: true }), 0);
  assert.equal(h.commits.length, 1);
});

test("cover-letter keys are made unique across the rows that go back", () => {
  const entries = [
    { app: { key: "a" }, row: { clKey: "Acme_pm_20261110" } },
    { app: { key: "b" }, row: { clKey: "Acme_pm_20261110" } },
    { app: { key: "c" }, row: { clKey: "Other_pm_20261110" } },
  ];
  script.uniqueClKeys(entries, [{ key: "z", cl_key: "Other_pm_20261110" }]);
  const keys = entries.map((e) => e.row.clKey);
  assert.equal(new Set(keys).size, 3);
  assert.equal(keys[0], "Acme_pm_20261110", "the first holder keeps its key");
  assert.match(keys[1], /^Acme_pm_20261110_/);
  assert.match(keys[2], /^Other_pm_20261110_/);
});

test("Weak archetype: title words first, else the profile's most used one", () => {
  const usable = new Set(Object.keys(VERSIONS));
  const apps = [
    { resume_ver: "Marketplace" },
    { resume_ver: "Marketplace" },
    { resume_ver: "Risk_Fraud" },
  ];
  assert.equal(
    script.pickArchetype({ title: "Fraud Analyst" }, VERSIONS, usable, apps).key,
    "Risk_Fraud"
  );
  assert.equal(
    script.pickArchetype({ title: "AI Product Manager" }, VERSIONS, usable, apps).key,
    "AI_Platform"
  );
  const dom = script.pickArchetype({ title: "Warehouse Lead" }, VERSIONS, usable, apps);
  assert.deepEqual([dom.key, dom.why], ["Marketplace", "most used"]);
  // An archetype without a PDF is never picked.
  assert.equal(
    script.pickArchetype({ title: "Fraud Analyst" }, VERSIONS, new Set(["Marketplace"]), apps).key,
    "Marketplace"
  );
});
