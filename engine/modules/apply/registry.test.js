// Pure tests: adapter detection / URL normalization, resume resolver,
// queue gates, worker pool.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { detectAts, getAdapter } = require("./index.js");
const { resolveResumePdf, resolveCoverLetterPdf } = require("./resume_path.js");
const { buildQueue } = require("./queue.js");
const { runPool, makeMutex } = require("./pool.js");
const { buildActiveCounts } = require("../../commands/prepare.js");

const UUID = "0f0f0f0f-1111-4222-8333-444444444444";

test("detectAts recognizes the three supported ATS URL shapes", () => {
  assert.equal(detectAts("https://job-boards.greenhouse.io/acme/jobs/123"), "greenhouse");
  assert.equal(detectAts("https://boards.greenhouse.io/acme/jobs/123?gh_jid=123"), "greenhouse");
  assert.equal(
    detectAts("https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123"),
    "greenhouse"
  );
  assert.equal(detectAts(`https://jobs.lever.co/acme/${UUID}`), "lever");
  assert.equal(detectAts(`https://jobs.lever.co/acme/${UUID}/apply`), "lever");
  assert.equal(detectAts(`https://jobs.ashbyhq.com/acme/${UUID}`), "ashby");
  assert.equal(detectAts(`https://jobs.ashbyhq.com/acme/${UUID}/application`), "ashby");
  // Board roots, other ATSes, junk → unsupported.
  assert.equal(detectAts("https://job-boards.greenhouse.io/acme"), null);
  assert.equal(detectAts("https://acme.wd5.myworkdayjobs.com/en-US/External/job/X"), null);
  assert.equal(detectAts("not a url"), null);
});

test("normalizeUrl points at the form, tenantKey groups by board", () => {
  const gh = getAdapter("greenhouse");
  assert.equal(
    gh.normalizeUrl("https://boards.greenhouse.io/acme/jobs/123?gh_src=x"),
    "https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123"
  );
  const embed = "https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123";
  assert.equal(gh.normalizeUrl(embed), embed);
  assert.equal(gh.tenantKey(embed), "greenhouse:acme");
  assert.equal(gh.tenantKey("https://boards.greenhouse.io/Acme/jobs/123"), "greenhouse:acme");
  const lv = getAdapter("lever");
  assert.equal(
    lv.normalizeUrl(`https://jobs.lever.co/acme/${UUID}`),
    `https://jobs.lever.co/acme/${UUID}/apply`
  );
  assert.equal(lv.tenantKey(`https://jobs.lever.co/acme/${UUID}/apply`), "lever:acme");
  const ab = getAdapter("ashby");
  assert.equal(
    ab.normalizeUrl(`https://jobs.ashbyhq.com/acme/${UUID}`),
    `https://jobs.ashbyhq.com/acme/${UUID}/application`
  );
  assert.deepEqual(ab.jobRef(`https://jobs.ashbyhq.com/acme/${UUID}`), {
    slug: "acme",
    jobId: UUID,
  });
  assert.equal(getAdapter("workday"), null);
});

// ---- resume resolver --------------------------------------------------------

const ROOT = "/profiles/demo";
const PROFILE = {
  identity: { name: "Test Candidate" },
  paths: { root: ROOT, resumesDir: path.join(ROOT, "resumes") },
  resumeVersions: { versions: { Growth: { filename: "CV_Test_Candidate_Growth.docx" } } },
};
const existsFrom = (set) => (p) => set.has(p);

test("resolveResumePdf: tailored path, .docx sibling, archetype key", () => {
  const files = new Set([
    `${ROOT}/resumes/tailored/acme_pm_20261001.pdf`,
    `${ROOT}/resumes/CV_Test_Candidate_Growth.pdf`,
    `${ROOT}/resumes/CV_Test_Candidate_Platform.pdf`,
  ]);
  const exists = existsFrom(files);
  assert.deepEqual(
    resolveResumePdf({ resume_ver: "resumes/tailored/acme_pm_20261001.pdf" }, PROFILE, { exists }),
    {
      abs: `${ROOT}/resumes/tailored/acme_pm_20261001.pdf`,
      rel: "resumes/tailored/acme_pm_20261001.pdf",
    }
  );
  assert.equal(
    resolveResumePdf({ resume_ver: "resumes/tailored/acme_pm_20261001.docx" }, PROFILE, { exists })
      .rel,
    "resumes/tailored/acme_pm_20261001.pdf"
  );
  assert.equal(
    resolveResumePdf({ resume_ver: "Growth" }, PROFILE, { exists }).rel,
    "resumes/CV_Test_Candidate_Growth.pdf"
  );
  // Key missing from resume_versions.json → conventional CV_<Name>_<Key>.pdf.
  assert.equal(
    resolveResumePdf({ resume_ver: "Platform" }, PROFILE, { exists }).rel,
    "resumes/CV_Test_Candidate_Platform.pdf"
  );
});

test("resolveResumePdf: errors", () => {
  const exists = () => false;
  assert.deepEqual(resolveResumePdf({ resume_ver: "" }, PROFILE, { exists }), {
    error: "resume_not_set",
  });
  assert.equal(
    resolveResumePdf({ resume_ver: "Growth" }, PROFILE, { exists }).error,
    "resume_missing"
  );
  assert.equal(
    resolveResumePdf({ resume_ver: "../../etc/passwd.pdf" }, PROFILE, { exists: () => true }).error,
    "resume_outside_profile"
  );
});

test("resolveCoverLetterPdf", () => {
  const exists = existsFrom(new Set([`${ROOT}/cover_letters/tailored/acme.pdf`]));
  assert.equal(
    resolveCoverLetterPdf({ cl_path: "cover_letters/tailored/acme.pdf" }, PROFILE, { exists }).rel,
    "cover_letters/tailored/acme.pdf"
  );
  assert.equal(resolveCoverLetterPdf({ cl_path: "" }, PROFILE, { exists }), null);
  assert.equal(
    resolveCoverLetterPdf({ cl_path: "cover_letters/x.pdf" }, PROFILE, { exists }),
    null
  );
});

// ---- queue ------------------------------------------------------------------

const NOW = new Date("2026-10-21T12:00:00Z");
function row(over) {
  return {
    key: over.key,
    companyName: over.companyName || "Acme",
    title: "PM",
    status: "To Apply",
    fit_score: "Strong",
    applied_date: "",
    apply_state: "",
    apply_note: "",
    createdAt: "2026-10-20T00:00:00Z",
    updatedAt: "2026-10-20T00:00:00Z",
    ...over,
  };
}
const RULES = { company_cap: { max_active: 3, window_days: 30 } };
const q = (apps, extra = {}) =>
  buildQueue(apps, { filterRules: RULES, buildActiveCounts, windowDays: 30, now: NOW, ...extra });

test("queue: gates on status, fit, applied_date and apply_state", () => {
  const apps = [
    row({ key: "a" }),
    row({ key: "b", fit_score: "Weak" }),
    row({ key: "c", applied_date: "2026-10-01" }),
    row({ key: "d", apply_state: "submitted" }),
    row({ key: "e", apply_state: "failed" }),
    row({ key: "f", apply_state: "manual" }),
    row({ key: "g", apply_state: "queued", apply_note: "submitting:2026-10-21T03:00:00Z" }),
    row({ key: "h", apply_state: "queued", fit_score: "Medium" }),
    row({ key: "i", status: "Applied" }),
    row({ key: "j", status: "Inbox" }),
  ];
  const { queue, skipped } = q(apps);
  assert.deepEqual(queue.map((a) => a.key).sort(), ["a", "h"]);
  const reasons = Object.fromEntries(skipped.map((s) => [s.key, s.reason]));
  assert.equal(reasons.b, "fit_not_strong_medium");
  assert.equal(reasons.c, "already_applied");
  assert.equal(reasons.d, "apply_state_submitted");
  assert.equal(reasons.e, "apply_state_failed");
  assert.equal(reasons.f, "apply_state_manual");
  assert.equal(reasons.g, "interrupted_submit");
  assert.equal(reasons.i, undefined, "non To Apply rows are simply not candidates");
});

test("queue: newest createdAt first, then --limit", () => {
  const apps = [
    row({ key: "old", companyName: "A", createdAt: "2026-10-01T00:00:00Z" }),
    row({ key: "new", companyName: "B", createdAt: "2026-10-20T00:00:00Z" }),
    row({ key: "mid", companyName: "C", createdAt: "2026-10-10T00:00:00Z" }),
  ];
  assert.deepEqual(
    q(apps).queue.map((a) => a.key),
    ["new", "mid", "old"]
  );
  const limited = q(apps, { limit: 2 });
  assert.deepEqual(
    limited.queue.map((a) => a.key),
    ["new", "mid"]
  );
  assert.equal(limited.skipped.find((s) => s.key === "old").reason, "over_limit");
});

test("queue: company cap counts recent applications + tonight's queue", () => {
  const apps = [
    row({
      key: "p1",
      status: "Applied",
      applied_date: "2026-10-10",
      updatedAt: "2026-10-10T00:00:00Z",
    }),
    row({ key: "p2", status: "Rejected", updatedAt: "2026-10-15T00:00:00Z" }),
    // Outside the 30-day window: does not count.
    row({
      key: "p3",
      status: "Applied",
      applied_date: "2026-08-01",
      updatedAt: "2026-08-01T00:00:00Z",
    }),
    row({ key: "t1", createdAt: "2026-10-20T00:00:00Z" }),
    row({ key: "t2", createdAt: "2026-10-19T00:00:00Z" }),
    row({ key: "other", companyName: "Other Co" }),
  ];
  const { queue, skipped } = q(apps);
  assert.deepEqual(queue.map((a) => a.key).sort(), ["other", "t1"]);
  const cap = skipped.find((s) => s.key === "t2");
  assert.equal(cap.reason, "company_cap");
  assert.equal(cap.detail.cap, 3);
});

test("queue: per-company cap override from filter_rules", () => {
  const apps = [row({ key: "t1" }), row({ key: "t2" })];
  const { queue } = q(apps, {
    filterRules: { company_cap: { max_active: 3, overrides: { Acme: 1 } } },
  });
  assert.equal(queue.length, 1);
});

// ---- pool -------------------------------------------------------------------

test("runPool: bounded concurrency, one in flight per key, results in order", async () => {
  let active = 0;
  let maxActive = 0;
  const activeKeys = new Set();
  let keyClash = false;
  const items = ["a:1", "a:2", "b:1", "c:1", "a:3", "b:2"];
  const results = await runPool(items, {
    concurrency: 3,
    keyOf: (s) => s.split(":")[0],
    worker: async (s) => {
      const k = s.split(":")[0];
      if (activeKeys.has(k)) keyClash = true;
      activeKeys.add(k);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      activeKeys.delete(k);
      if (s === "c:1") throw new Error("boom");
      return s.toUpperCase();
    },
  });
  assert.equal(keyClash, false);
  assert.ok(maxActive <= 3);
  assert.deepEqual(results, ["A:1", "A:2", "B:1", { error: "boom" }, "A:3", "B:2"]);
  assert.deepEqual(await runPool([], { worker: async () => 1 }), []);
});

test("makeMutex serializes critical sections", async () => {
  const lock = makeMutex();
  const log = [];
  await Promise.all(
    [1, 2, 3].map((n) =>
      lock(async () => {
        log.push(`in${n}`);
        await new Promise((r) => setTimeout(r, 5));
        log.push(`out${n}`);
      })
    )
  );
  assert.deepEqual(log, ["in1", "out1", "in2", "out2", "in3", "out3"]);
});
