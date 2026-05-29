const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  planArchiveMoves,
  applyArchiveMoves,
  isTailoredPath,
  bucketMonth,
  archiveTargetFor,
  TRIGGER_STATUSES,
} = require("./archive_used_artifacts.js");

const PROFILE_ROOT = "/tmp/profiles/lilia";

// Tiny in-memory fs facade backing both planner (existsSync) and
// applier (mkdirSync / renameSync).
function makeFs(initialFiles = []) {
  const files = new Set(initialFiles.map((p) => path.normalize(p)));
  const dirs = new Set();
  return {
    files,
    dirs,
    existsSync: (p) => files.has(path.normalize(p)),
    mkdirSync: (p, _opts) => {
      dirs.add(path.normalize(p));
    },
    renameSync: (from, to) => {
      const f = path.normalize(from);
      const t = path.normalize(to);
      if (!files.has(f)) {
        const err = new Error(`ENOENT: no such file or directory, rename '${from}' -> '${to}'`);
        err.code = "ENOENT";
        throw err;
      }
      if (files.has(t)) {
        const err = new Error(`EEXIST: target exists '${to}'`);
        err.code = "EEXIST";
        throw err;
      }
      files.delete(f);
      files.add(t);
    },
  };
}

// Row factory with sane defaults; override only what each test cares about.
function row(overrides = {}) {
  return {
    key: "greenhouse:1",
    source: "greenhouse",
    jobId: "1",
    companyName: "Affirm",
    title: "PM",
    url: "https://x/1",
    locations: [],
    status: "Applied",
    notion_page_id: "page-1",
    resume_ver: "resumes/tailored/affirm_pm_20260520.docx",
    cl_key: "Affirm_pm_20260520",
    salary_min: "",
    salary_max: "",
    cl_path: "cover_letters/tailored/affirm_pm_20260520.pdf",
    createdAt: "2026-05-20T00:00:00Z",
    updatedAt: "2026-05-21T00:00:00Z",
    fit_score: "Strong",
    fit_rationale: "",
    fit_evaluated_at: "",
    skip_reason: "",
    ...overrides,
  };
}

// Compose absolute path under the profile root.
function abs(rel) {
  return path.join(PROFILE_ROOT, rel);
}

// --- Tests -------------------------------------------------------------------

test("isTailoredPath recognizes all three tailored prefixes", () => {
  assert.equal(isTailoredPath("resumes/tailored/a.docx"), true);
  assert.equal(isTailoredPath("cv/tailored/a.docx"), true);
  assert.equal(isTailoredPath("cover_letters/tailored/a.pdf"), true);
  assert.equal(isTailoredPath("resumes/Risk_Fraud.docx"), false);
  assert.equal(isTailoredPath("cover_letters/Affirm/X.pdf"), false);
  assert.equal(isTailoredPath(""), false);
  assert.equal(isTailoredPath(null), false);
  assert.equal(isTailoredPath(undefined), false);
});

test("bucketMonth: prefers updatedAt then createdAt then 'unknown'", () => {
  assert.equal(
    bucketMonth({ updatedAt: "2026-05-21T00:00:00Z", createdAt: "2026-04-01" }),
    "2026-05"
  );
  assert.equal(bucketMonth({ updatedAt: "", createdAt: "2026-04-01T00:00:00Z" }), "2026-04");
  assert.equal(bucketMonth({}), "unknown");
  assert.equal(bucketMonth({ updatedAt: "not-a-date", createdAt: "" }), "unknown");
});

test("archiveTargetFor: cv vs cl layout under YYYY-MM", () => {
  assert.equal(
    archiveTargetFor("resumes/tailored/a_b_20260520.docx", "cv", "2026-05"),
    "cv/archive/2026-05/a_b_20260520.docx"
  );
  assert.equal(
    archiveTargetFor("cover_letters/tailored/a_b.pdf", "cl", "2026-05"),
    "cover_letters/archive/2026-05/a_b.pdf"
  );
  assert.equal(
    archiveTargetFor("resumes/tailored/x.docx", "cv", "unknown"),
    "cv/archive/unknown/x.docx"
  );
});

test("(a) Applied / Interview / Offer / Rejected / Closed / No Response → move-candidates", () => {
  const statuses = ["Applied", "Interview", "Offer", "Rejected", "Closed", "No Response"];
  for (const status of statuses) {
    const r = row({ key: `greenhouse:${status}`, status });
    const fs = makeFs([abs(r.resume_ver), abs(r.cl_path)]);
    const plan = planArchiveMoves({ rows: [r], profileRoot: PROFILE_ROOT, fs });
    assert.equal(plan.moves.length, 2, `${status}: expected 2 moves (cv + cl)`);
    assert.equal(plan.skipped.length, 0, `${status}: expected no skips`);
  }
});

test("(a2) BL-152: cover_letters/tailored/ CL (no resume) → move-candidate", () => {
  // Regression for BL-152: engine now writes CLs under cover_letters/tailored/.
  // A row with only a tailored CL (archetype resume referenced by name) must
  // still produce exactly one CL move into cover_letters/archive/.
  const r = row({
    resume_ver: "Risk_Fraud", // archetype, never archived
    cl_path: "cover_letters/tailored/sutter-health/cl_receptionist_20260520.pdf",
  });
  const fs = makeFs([abs(r.cl_path)]);
  const plan = planArchiveMoves({ rows: [r], profileRoot: PROFILE_ROOT, fs });
  assert.equal(plan.moves.length, 1, "expected exactly one CL move");
  assert.equal(plan.moves[0].kind, "cl");
  assert.equal(plan.moves[0].toRel, "cover_letters/archive/2026-05/cl_receptionist_20260520.pdf");
});

test("(b) Inbox / To Apply / In Review → stay in place", () => {
  for (const status of ["Inbox", "To Apply", "In Review", "Archived"]) {
    const r = row({ key: `greenhouse:${status}`, status });
    const fs = makeFs([abs(r.resume_ver), abs(r.cl_path)]);
    const plan = planArchiveMoves({ rows: [r], profileRoot: PROFILE_ROOT, fs });
    assert.equal(plan.moves.length, 0, `${status}: should not plan moves`);
  }
});

test("(c) Archetype paths (not under tailored/) → never moved, no warning", () => {
  const r = row({
    resume_ver: "Risk_Fraud", // archetype name
    cl_path: "cover_letters/Affirm/Affirm_pm_20260520.pdf", // legacy CL output (not under tailored/)
  });
  const fs = makeFs([abs("cover_letters/Affirm/Affirm_pm_20260520.pdf")]);
  const plan = planArchiveMoves({ rows: [r], profileRoot: PROFILE_ROOT, fs });
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.warnings.length, 0);
});

test("(d) Missing source file → warn, no TSV mutation, no move", () => {
  const r = row();
  const fs = makeFs([]); // neither file exists
  const plan = planArchiveMoves({ rows: [r], profileRoot: PROFILE_ROOT, fs });
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.skipped.length, 2);
  assert.ok(plan.skipped.every((s) => s.reason === "source-missing"));
  assert.ok(plan.warnings.some((w) => /source missing/.test(w)));

  // Now apply with no moves: tsvUpdater is never called.
  const updates = [];
  const result = applyArchiveMoves(plan, {
    fs,
    tsvUpdater: (key, patch) => updates.push({ key, patch }),
  });
  assert.equal(result.moved, 0);
  assert.equal(updates.length, 0);
});

test("(e) Target file already exists → skip + warn (no overwrite)", () => {
  const r = row();
  // Both source AND archive target exist (prior partial run).
  const fs = makeFs([
    abs(r.resume_ver),
    abs(r.cl_path),
    abs("cv/archive/2026-05/affirm_pm_20260520.docx"),
    abs("cover_letters/archive/2026-05/affirm_pm_20260520.pdf"),
  ]);
  const plan = planArchiveMoves({ rows: [r], profileRoot: PROFILE_ROOT, fs });
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.skipped.length, 2);
  assert.ok(plan.skipped.every((s) => s.reason === "target-exists"));
  assert.ok(plan.warnings.some((w) => /target exists/.test(w)));
});

test("(f) Idempotent — running the same plan twice is a no-op the second time", () => {
  const r = row();
  const fs = makeFs([abs(r.resume_ver), abs(r.cl_path)]);

  const plan1 = planArchiveMoves({ rows: [r], profileRoot: PROFILE_ROOT, fs });
  assert.equal(plan1.moves.length, 2);

  // Apply with a tsvUpdater that mutates `r` in-place so the next plan
  // sees the rewritten paths.
  const result1 = applyArchiveMoves(plan1, {
    fs,
    tsvUpdater: (_key, patch) => Object.assign(r, patch),
  });
  assert.equal(result1.moved, 2);
  assert.equal(r.resume_ver, "cv/archive/2026-05/affirm_pm_20260520.docx");
  assert.equal(r.cl_path, "cover_letters/archive/2026-05/affirm_pm_20260520.pdf");

  // Second run sees archive paths (no longer tailored prefix) → 0 moves.
  const plan2 = planArchiveMoves({ rows: [r], profileRoot: PROFILE_ROOT, fs });
  assert.equal(plan2.moves.length, 0);
  assert.equal(plan2.skipped.length, 0);
  assert.equal(plan2.warnings.length, 0);
});

test("(g) YYYY-MM derived from updatedAt then createdAt fallback", () => {
  // updatedAt picked when present.
  const r1 = row({ updatedAt: "2026-06-10T12:00:00Z", createdAt: "2026-04-01T00:00:00Z" });
  const fs1 = makeFs([abs(r1.resume_ver)]);
  const plan1 = planArchiveMoves({ rows: [r1], profileRoot: PROFILE_ROOT, fs: fs1 });
  assert.equal(plan1.moves[0].toRel, "cv/archive/2026-06/affirm_pm_20260520.docx");

  // updatedAt empty → fall back to createdAt.
  const r2 = row({
    updatedAt: "",
    createdAt: "2026-03-05T00:00:00Z",
    cl_path: "",
  });
  const fs2 = makeFs([abs(r2.resume_ver)]);
  const plan2 = planArchiveMoves({ rows: [r2], profileRoot: PROFILE_ROOT, fs: fs2 });
  assert.equal(plan2.moves[0].toRel, "cv/archive/2026-03/affirm_pm_20260520.docx");

  // Both missing → "unknown".
  const r3 = row({ updatedAt: "", createdAt: "", cl_path: "" });
  const fs3 = makeFs([abs(r3.resume_ver)]);
  const plan3 = planArchiveMoves({ rows: [r3], profileRoot: PROFILE_ROOT, fs: fs3 });
  assert.equal(plan3.moves[0].toRel, "cv/archive/unknown/affirm_pm_20260520.docx");
});

test("(h) Both resume_ver AND cl_path archive for the same row", () => {
  const r = row();
  const fs = makeFs([abs(r.resume_ver), abs(r.cl_path)]);
  const plan = planArchiveMoves({ rows: [r], profileRoot: PROFILE_ROOT, fs });
  assert.equal(plan.moves.length, 2);
  assert.ok(plan.moves.some((m) => m.kind === "cv" && m.field === "resume_ver"));
  assert.ok(plan.moves.some((m) => m.kind === "cl" && m.field === "cl_path"));

  const patches = [];
  applyArchiveMoves(plan, {
    fs,
    tsvUpdater: (key, patch) => patches.push({ key, patch }),
  });
  assert.equal(patches.length, 2);
  assert.deepEqual(patches.map((p) => Object.keys(p.patch)[0]).sort(), ["cl_path", "resume_ver"]);
});

test("(i) Row with no cl_path → only resume_ver considered", () => {
  const r = row({ cl_path: "" });
  const fs = makeFs([abs(r.resume_ver)]);
  const plan = planArchiveMoves({ rows: [r], profileRoot: PROFILE_ROOT, fs });
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].kind, "cv");
});

test("applyArchiveMoves: rename failure surfaces as a warning, does not throw", () => {
  const r = row({ cl_path: "" });
  const fs = makeFs([abs(r.resume_ver)]);
  const plan = planArchiveMoves({ rows: [r], profileRoot: PROFILE_ROOT, fs });
  // Sabotage rename to simulate a disk error.
  fs.renameSync = () => {
    throw new Error("EBUSY: resource busy");
  };
  const logged = [];
  const result = applyArchiveMoves(plan, {
    fs,
    tsvUpdater: () => {},
    logger: { warn: (m) => logged.push(m) },
  });
  assert.equal(result.moved, 0);
  assert.ok(result.warnings.some((w) => /EBUSY/.test(w)));
  assert.ok(logged.some((m) => /EBUSY/.test(m)));
});

test("TRIGGER_STATUSES contains exactly the 6 confirmed statuses", () => {
  assert.deepEqual(Array.from(TRIGGER_STATUSES).sort(), [
    "Applied",
    "Closed",
    "Interview",
    "No Response",
    "Offer",
    "Rejected",
  ]);
});

test("planArchiveMoves: row whose path is already under archive prefix is silently skipped", () => {
  const r = row({
    resume_ver: "cv/archive/2026-05/affirm_pm_20260520.docx",
    cl_path: "cover_letters/archive/2026-05/affirm_pm_20260520.pdf",
  });
  const fs = makeFs([abs(r.resume_ver), abs(r.cl_path)]);
  const plan = planArchiveMoves({ rows: [r], profileRoot: PROFILE_ROOT, fs });
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.warnings.length, 0);
});

test("planArchiveMoves: missing profileRoot returns empty plan with warning", () => {
  const fs = makeFs([]);
  const plan = planArchiveMoves({ rows: [row()], profileRoot: "", fs });
  assert.equal(plan.moves.length, 0);
  assert.ok(plan.warnings.some((w) => /missing profileRoot/.test(w)));
});
