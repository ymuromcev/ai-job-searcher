// Tests for scripts/migrate_cl_to_tailored.js — BL-152.
// Most coverage is on planRow (pure); migrate() gets one synthetic
// end-to-end test against a real tmpdir to catch wiring bugs.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { planRow, migrate } = require("./migrate_cl_to_tailored.js");
const applicationsTsv = require("../engine/core/applications_tsv.js");

const ROOT = "/profiles/lilia";

function makeApp(overrides = {}) {
  return {
    key: "greenhouse:1",
    companyName: "Sutter Health",
    cl_path: "cover_letters/Sutter_Health/cl_receptionist_20260505.pdf",
    ...overrides,
  };
}

function existsSetFn(set) {
  return (p) => set.has(p);
}

// --- planRow ----------------------------------------------------------------

test("planRow: empty cl_path → skipped", () => {
  const plan = planRow(makeApp({ cl_path: "" }), ROOT, { fileExists: () => false });
  assert.equal(plan.skip, true);
  assert.match(plan.reason, /empty/);
});

test("planRow: legacy cover_letters/<slug>/x.pdf with file present → move + new pointer", () => {
  const from = `${ROOT}/cover_letters/Sutter_Health/cl_receptionist_20260505.pdf`;
  const plan = planRow(makeApp(), ROOT, { fileExists: existsSetFn(new Set([from])) });
  assert.equal(plan.skip, undefined);
  assert.equal(plan.move.from, from);
  assert.equal(
    plan.move.to,
    `${ROOT}/cover_letters/tailored/Sutter_Health/cl_receptionist_20260505.pdf`
  );
  assert.equal(plan.newClPath, "cover_letters/tailored/Sutter_Health/cl_receptionist_20260505.pdf");
  assert.equal(plan.warnings.length, 0);
});

test("planRow: flat cover_letters/x.pdf (no slug subdir) → still goes under tailored/", () => {
  const from = `${ROOT}/cover_letters/cl_flat_20260505.pdf`;
  const plan = planRow(makeApp({ cl_path: "cover_letters/cl_flat_20260505.pdf" }), ROOT, {
    fileExists: existsSetFn(new Set([from])),
  });
  assert.equal(plan.move.to, `${ROOT}/cover_letters/tailored/cl_flat_20260505.pdf`);
  assert.equal(plan.newClPath, "cover_letters/tailored/cl_flat_20260505.pdf");
});

test("planRow: already under cover_letters/tailored/ → skipped (idempotent)", () => {
  const plan = planRow(
    makeApp({ cl_path: "cover_letters/tailored/Sutter_Health/cl_receptionist_20260505.pdf" }),
    ROOT,
    { fileExists: () => true }
  );
  assert.equal(plan.skip, true);
  assert.match(plan.reason, /already tailored/);
});

test("planRow: already archived under cover_letters/archive/ → skipped", () => {
  const plan = planRow(
    makeApp({ cl_path: "cover_letters/archive/2026-05/cl_receptionist_20260505.pdf" }),
    ROOT,
    { fileExists: () => true }
  );
  assert.equal(plan.skip, true);
  assert.match(plan.reason, /already archived/);
});

test("planRow: sentinel cl_path (no .pdf extension) → skipped, untouched", () => {
  const plan = planRow(makeApp({ cl_path: "indeed_generic" }), ROOT, { fileExists: () => false });
  assert.equal(plan.skip, true);
  assert.match(plan.reason, /sentinel/);
  assert.equal(plan.newClPath, undefined);
});

test("planRow: unexpected layout (not under cover_letters/) → skipped + warn", () => {
  const plan = planRow(makeApp({ cl_path: "cover_letters_md/Sutter/x.pdf" }), ROOT, {
    fileExists: () => true,
  });
  assert.equal(plan.skip, true);
  assert.match(plan.reason, /unexpected/);
  assert.equal(plan.warnings.length, 1);
});

test("planRow: source missing → warn but still canonicalise pointer (no move)", () => {
  const plan = planRow(makeApp(), ROOT, { fileExists: () => false });
  assert.equal(plan.skip, undefined);
  assert.equal(plan.move, undefined);
  assert.equal(plan.newClPath, "cover_letters/tailored/Sutter_Health/cl_receptionist_20260505.pdf");
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /no PDF on disk/);
});

test("planRow: backslash path is normalised before classification", () => {
  const plan = planRow(makeApp({ cl_path: "cover_letters\\Sutter_Health\\x.pdf" }), ROOT, {
    fileExists: () => false,
  });
  assert.equal(plan.newClPath, "cover_letters/tailored/Sutter_Health/x.pdf");
});

// --- migrate end-to-end (synthetic profile in tmpdir) -----------------------

test("migrate: end-to-end — moves PDF, updates TSV, backs up, idempotent on re-run", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-cl-tailored-"));
  const profilesDir = path.join(tmp, "profiles");
  const profileRoot = path.join(profilesDir, "synthtest");
  fs.mkdirSync(path.join(profileRoot, "cover_letters", "Affirm"), { recursive: true });
  fs.writeFileSync(
    path.join(profileRoot, "profile.json"),
    JSON.stringify({ id: "synthtest", display_name: "Synth Test" }, null, 2)
  );

  // Fixtures:
  //   row1: legacy PDF present → moves under tailored/
  //   row2: already tailored → skipped
  //   row3: sentinel → untouched
  const legacyPdf = path.join(profileRoot, "cover_letters", "Affirm", "cl_pm_20260505.pdf");
  fs.writeFileSync(legacyPdf, "fake-pdf-bytes");

  const tailoredDir = path.join(profileRoot, "cover_letters", "tailored", "Stripe");
  fs.mkdirSync(tailoredDir, { recursive: true });
  fs.writeFileSync(path.join(tailoredDir, "cl_pm_20260505.pdf"), "already-tailored");

  const tsvPath = path.join(profileRoot, "applications.tsv");
  const baseRow = (overrides) => ({
    key: "",
    source: "greenhouse",
    jobId: "1",
    companyName: "",
    title: "PM",
    url: "http://x",
    locations: [],
    status: "Applied",
    notion_page_id: "",
    resume_ver: "",
    cl_key: "",
    salary_min: "",
    salary_max: "",
    cl_path: "",
    createdAt: "2026-05-05",
    updatedAt: "2026-05-05",
    fit_score: "",
    fit_rationale: "",
    fit_evaluated_at: "",
    skip_reason: "",
    ...overrides,
  });
  applicationsTsv.save(tsvPath, [
    baseRow({
      key: "greenhouse:1",
      companyName: "Affirm",
      cl_path: "cover_letters/Affirm/cl_pm_20260505.pdf",
    }),
    baseRow({
      key: "greenhouse:2",
      companyName: "Stripe",
      cl_path: "cover_letters/tailored/Stripe/cl_pm_20260505.pdf",
    }),
    baseRow({
      key: "greenhouse:3",
      companyName: "Indeed Co",
      cl_path: "indeed_generic",
    }),
  ]);

  const out = [];
  const code = await migrate({
    profileId: "synthtest",
    apply: true,
    profilesDir,
    stdout: (m) => out.push(m),
    stderr: () => {},
  });
  assert.equal(code, 0);

  // File physically moved.
  assert.equal(fs.existsSync(legacyPdf), false, "legacy PDF should be gone");
  assert.equal(
    fs.existsSync(
      path.join(profileRoot, "cover_letters", "tailored", "Affirm", "cl_pm_20260505.pdf")
    ),
    true,
    "PDF should be under tailored/"
  );

  // TSV pointer updated for row1, others untouched.
  const { apps } = applicationsTsv.load(tsvPath);
  const byKey = Object.fromEntries(apps.map((a) => [a.key, a]));
  assert.equal(byKey["greenhouse:1"].cl_path, "cover_letters/tailored/Affirm/cl_pm_20260505.pdf");
  assert.equal(byKey["greenhouse:2"].cl_path, "cover_letters/tailored/Stripe/cl_pm_20260505.pdf");
  assert.equal(byKey["greenhouse:3"].cl_path, "indeed_generic");

  // Backup created.
  const backups = fs
    .readdirSync(profileRoot)
    .filter((f) => f.startsWith("applications.tsv.pre-cl-tailored-"));
  assert.equal(backups.length, 1, "exactly one TSV backup");

  // Re-run is a no-op (nothing left to migrate).
  const out2 = [];
  const code2 = await migrate({
    profileId: "synthtest",
    apply: true,
    profilesDir,
    stdout: (m) => out2.push(m),
    stderr: () => {},
  });
  assert.equal(code2, 0);
  assert.ok(
    out2.some((m) => /nothing to do/.test(m)),
    "second run should be a no-op"
  );

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("migrate: target already exists → per-row error, exit 1, pointer NOT rewritten, others land", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-cl-tailored-collide-"));
  const profilesDir = path.join(tmp, "profiles");
  const profileRoot = path.join(profilesDir, "synthtest");
  fs.mkdirSync(path.join(profileRoot, "cover_letters", "Affirm"), { recursive: true });
  fs.mkdirSync(path.join(profileRoot, "cover_letters", "tailored", "Affirm"), { recursive: true });
  fs.mkdirSync(path.join(profileRoot, "cover_letters", "Stripe"), { recursive: true });
  fs.writeFileSync(
    path.join(profileRoot, "profile.json"),
    JSON.stringify({ id: "synthtest", display_name: "Synth Test" }, null, 2)
  );

  // row1: legacy PDF exists AND a file already sits at the tailored target →
  //       moveFile refuses to overwrite → error, cl_path stays legacy.
  // row2: clean legacy PDF → migrates fine (proves one bad row doesn't abort).
  const collideLegacy = path.join(profileRoot, "cover_letters", "Affirm", "cl_pm.pdf");
  fs.writeFileSync(collideLegacy, "legacy");
  fs.writeFileSync(
    path.join(profileRoot, "cover_letters", "tailored", "Affirm", "cl_pm.pdf"),
    "pre-existing-target"
  );
  const cleanLegacy = path.join(profileRoot, "cover_letters", "Stripe", "cl_pm.pdf");
  fs.writeFileSync(cleanLegacy, "legacy");

  const tsvPath = path.join(profileRoot, "applications.tsv");
  const baseRow = (overrides) => ({
    key: "",
    source: "greenhouse",
    jobId: "1",
    companyName: "",
    title: "PM",
    url: "http://x",
    locations: [],
    status: "Applied",
    notion_page_id: "",
    resume_ver: "",
    cl_key: "",
    salary_min: "",
    salary_max: "",
    cl_path: "",
    createdAt: "2026-05-05",
    updatedAt: "2026-05-05",
    fit_score: "",
    fit_rationale: "",
    fit_evaluated_at: "",
    skip_reason: "",
    ...overrides,
  });
  applicationsTsv.save(tsvPath, [
    baseRow({
      key: "greenhouse:1",
      companyName: "Affirm",
      cl_path: "cover_letters/Affirm/cl_pm.pdf",
    }),
    baseRow({
      key: "greenhouse:2",
      companyName: "Stripe",
      cl_path: "cover_letters/Stripe/cl_pm.pdf",
    }),
  ]);

  const errs = [];
  const code = await migrate({
    profileId: "synthtest",
    apply: true,
    profilesDir,
    stdout: () => {},
    stderr: (m) => errs.push(m),
  });
  assert.equal(code, 1, "non-zero exit when a row errors");
  assert.ok(errs.some((m) => /target already exists/.test(m)));

  const { apps } = applicationsTsv.load(tsvPath);
  const byKey = Object.fromEntries(apps.map((a) => [a.key, a]));
  // Colliding row: pointer and disk both untouched (consistent).
  assert.equal(byKey["greenhouse:1"].cl_path, "cover_letters/Affirm/cl_pm.pdf");
  assert.equal(fs.existsSync(collideLegacy), true, "legacy PDF must remain on collision");
  // Clean row still migrated despite the other row's failure.
  assert.equal(byKey["greenhouse:2"].cl_path, "cover_letters/tailored/Stripe/cl_pm.pdf");

  fs.rmSync(tmp, { recursive: true, force: true });
});
