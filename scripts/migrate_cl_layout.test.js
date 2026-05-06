// Tests for scripts/migrate_cl_layout.js — BL-14 / RFC 019.
// Most coverage is on planRow (pure function); migrate() gets one synthetic
// end-to-end test against a real tmpdir to catch wiring bugs.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { planRow, migrate } = require("./migrate_cl_layout.js");

// --- planRow ----------------------------------------------------------------

function makeApp(overrides = {}) {
  return {
    key: "gh:1",
    companyName: "Affirm",
    cl_path: "Affirm_senior_pm_20260505.md",
    ...overrides,
  };
}

function existsSetFn(set) {
  return (p) => set.has(p);
}

const ROOT = "/profiles/jared";

test("planRow: empty cl_path → skipped", () => {
  const plan = planRow(makeApp({ cl_path: "" }), ROOT, { fileExists: () => false });
  assert.equal(plan.skip, true);
  assert.match(plan.reason, /empty/);
});

test("planRow: PDF already at canonical path + no MD → skipped (idempotent)", () => {
  const targetPdf = `${ROOT}/cover_letters/Affirm/Affirm_senior_pm_20260505.pdf`;
  const plan = planRow(
    makeApp({ cl_path: "cover_letters/Affirm/Affirm_senior_pm_20260505.pdf" }),
    ROOT,
    { fileExists: existsSetFn(new Set([targetPdf])) }
  );
  assert.equal(plan.skip, true);
  assert.match(plan.reason, /already canonical/);
  assert.equal(plan.newClPath, "cover_letters/Affirm/Affirm_senior_pm_20260505.pdf");
});

test("planRow: PDF flat in cover_letters/, MD flat too → plans both moves + canonical cl_path", () => {
  const flatPdf = `${ROOT}/cover_letters/Affirm_senior_pm_20260505.pdf`;
  const flatMd = `${ROOT}/cover_letters/Affirm_senior_pm_20260505.md`;
  const plan = planRow(
    makeApp({ cl_path: "Affirm_senior_pm_20260505.md" }),
    ROOT,
    { fileExists: existsSetFn(new Set([flatPdf, flatMd])) }
  );
  assert.equal(plan.skip, undefined);
  assert.equal(plan.pdfMove.from, flatPdf);
  assert.equal(
    plan.pdfMove.to,
    `${ROOT}/cover_letters/Affirm/Affirm_senior_pm_20260505.pdf`
  );
  assert.equal(plan.mdMove.from, flatMd);
  assert.equal(
    plan.mdMove.to,
    `${ROOT}/cover_letters_md/Affirm/Affirm_senior_pm_20260505.md`
  );
  assert.equal(plan.newClPath, "cover_letters/Affirm/Affirm_senior_pm_20260505.pdf");
  assert.equal(plan.warnings.length, 0);
});

test("planRow: only MD exists → plans PDF generation from MD", () => {
  const flatMd = `${ROOT}/cover_letters/Affirm_senior_pm_20260505.md`;
  const plan = planRow(
    makeApp({ cl_path: "Affirm_senior_pm_20260505.md" }),
    ROOT,
    { fileExists: existsSetFn(new Set([flatMd])) }
  );
  assert.ok(plan.pdfGenerate, "should plan PDF generation");
  assert.equal(plan.pdfGenerate.from, flatMd);
  assert.equal(
    plan.pdfGenerate.to,
    `${ROOT}/cover_letters/Affirm/Affirm_senior_pm_20260505.pdf`
  );
  assert.ok(plan.mdMove, "MD must move to canonical");
});

test("planRow: PDF nested under '<Company>/' (secondary profile layout, 'cover_letters/CL_<name>_<role>.pdf') → cl_path canonicalised", () => {
  // Secondary profile shape: cl_path is the relative path `cover_letters/...`
  // and the file lives flat at <root>/cover_letters/<basename>.
  const flatPdf = `${ROOT}/cover_letters/CL_profile_role_location.pdf`;
  const plan = planRow(
    makeApp({
      companyName: "Dignity Health",
      cl_path: "cover_letters/CL_profile_role_location.pdf",
    }),
    ROOT,
    { fileExists: existsSetFn(new Set([flatPdf])) }
  );
  assert.equal(plan.skip, undefined);
  assert.equal(plan.pdfMove.from, flatPdf);
  assert.equal(
    plan.pdfMove.to,
    `${ROOT}/cover_letters/Dignity_Health/CL_profile_role_location.pdf`
  );
  assert.equal(
    plan.newClPath,
    "cover_letters/Dignity_Health/CL_profile_role_location.pdf"
  );
});

test("planRow: PDF already in cover_letters/<otherSlug>/ (TSV company drift) → moves to canonical slug", () => {
  // Older Jared layout used "Anchorage_Digital" while company name in TSV
  // is now "Anchorage Digital" — slug stays Anchorage_Digital so it's a
  // no-op. Use a real drift case: TSV company "Bristol-Myers Squibb",
  // legacy folder "BristolMyers".
  const oldNested = `${ROOT}/cover_letters/BristolMyers/role_20260420.pdf`;
  const plan = planRow(
    makeApp({
      companyName: "Bristol-Myers Squibb",
      cl_path: "cover_letters/BristolMyers/role_20260420.pdf",
    }),
    ROOT,
    { fileExists: existsSetFn(new Set([oldNested])) }
  );
  // Note: "Bristol-Myers Squibb" slugifies to "Bristol_Myers_Squibb".
  assert.equal(
    plan.pdfMove.to,
    `${ROOT}/cover_letters/Bristol_Myers_Squibb/role_20260420.pdf`
  );
  assert.equal(
    plan.newClPath,
    "cover_letters/Bristol_Myers_Squibb/role_20260420.pdf"
  );
});

test("planRow: TSV cl_path with '<Company>/file.md' (Jared older format) resolves to canonical", () => {
  // Jared TSV often has values like "Lithic/role_20260502.md" which is
  // the basename of an MD inside cover_letters/Lithic/.
  const onDiskMd = `${ROOT}/cover_letters/Lithic/role_20260502.md`;
  const plan = planRow(
    makeApp({
      companyName: "Lithic",
      cl_path: "Lithic/role_20260502.md",
    }),
    ROOT,
    { fileExists: existsSetFn(new Set([onDiskMd])) }
  );
  // No PDF anywhere — plan PDF gen + MD move.
  assert.ok(plan.pdfGenerate);
  assert.equal(plan.pdfGenerate.from, onDiskMd);
  assert.ok(plan.mdMove);
  assert.equal(plan.mdMove.to, `${ROOT}/cover_letters_md/Lithic/role_20260502.md`);
  assert.equal(plan.newClPath, "cover_letters/Lithic/role_20260502.pdf");
});

test("planRow: company with '&' is slugified to 'and' in folder name", () => {
  const flatPdf = `${ROOT}/cover_letters/key.pdf`;
  const plan = planRow(
    makeApp({ companyName: "Procter & Gamble", cl_path: "key.md" }),
    ROOT,
    { fileExists: existsSetFn(new Set([flatPdf])) }
  );
  assert.match(plan.pdfMove.to, /\/Procter_and_Gamble\//);
  assert.equal(plan.newClPath, "cover_letters/Procter_and_Gamble/key.pdf");
});

test("planRow: no source file found anywhere → warning + still canonicalises TSV pointer", () => {
  const plan = planRow(
    makeApp({ cl_path: "ghost_file.md" }),
    ROOT,
    { fileExists: () => false }
  );
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /no source file found/);
  // We still update the TSV pointer so it's at least pointing at the
  // canonical location for any future regen.
  assert.equal(plan.newClPath, "cover_letters/Affirm/ghost_file.pdf");
});

test("planRow: sentinel cl_path (no extension, no file) → skipped, TSV pointer left alone", () => {
  // Secondary profile's `indeed_generic` rows: 30 Indeed apps share one generic CL the
  // operator manages by hand, never a per-job file on disk. Migration must
  // not corrupt these to "cover_letters/<slug>/indeed_generic.pdf".
  const plan = planRow(
    makeApp({ companyName: "Quad Optometry", cl_path: "indeed_generic" }),
    ROOT,
    { fileExists: () => false }
  );
  assert.equal(plan.skip, true);
  assert.match(plan.reason, /sentinel/);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /sentinel/);
});

test("planRow: PDF at canonical, MD outside canonical → only MD move planned", () => {
  const targetPdf = `${ROOT}/cover_letters/Affirm/key.pdf`;
  const flatMd = `${ROOT}/cover_letters/key.md`;
  const plan = planRow(
    makeApp({ cl_path: "cover_letters/Affirm/key.pdf" }),
    ROOT,
    { fileExists: existsSetFn(new Set([targetPdf, flatMd])) }
  );
  assert.equal(plan.skip, undefined);
  assert.equal(plan.pdfMove, undefined);
  assert.ok(plan.mdMove);
  assert.equal(plan.mdMove.from, flatMd);
});

// --- migrate end-to-end (synthetic profile in tmpdir) -----------------------

test("migrate: end-to-end on synthetic profile — moves files, updates TSV, backs up", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-cl-"));
  const profilesDir = path.join(tmp, "profiles");
  const profileRoot = path.join(profilesDir, "synthtest");
  fs.mkdirSync(path.join(profileRoot, "cover_letters"), { recursive: true });
  fs.mkdirSync(path.join(profileRoot, "jd_cache"), { recursive: true });

  // Minimal profile.json the loader accepts.
  fs.writeFileSync(
    path.join(profileRoot, "profile.json"),
    JSON.stringify({ id: "synthtest", display_name: "Synth Test" }, null, 2)
  );

  // 3 fixtures:
  //   row1: PDF + MD flat → both move into Affirm/
  //   row2: only MD flat → PDF generated, MD moved
  //   row3: already canonical → skipped
  const flatPdf = path.join(profileRoot, "cover_letters", "Affirm_role_20260505.pdf");
  const flatMd = path.join(profileRoot, "cover_letters", "Affirm_role_20260505.md");
  fs.writeFileSync(flatPdf, "fake-pdf-bytes");
  fs.writeFileSync(flatMd, "P1 line\n\nP2 line");

  const onlyMd = path.join(profileRoot, "cover_letters", "Stripe_role_20260505.md");
  fs.writeFileSync(onlyMd, "Only paragraph for Stripe.");

  const canonicalDir = path.join(profileRoot, "cover_letters", "Adyen");
  fs.mkdirSync(canonicalDir, { recursive: true });
  const canonicalPdf = path.join(canonicalDir, "Adyen_role_20260505.pdf");
  fs.writeFileSync(canonicalPdf, "fake-pdf-bytes-2");

  // Build TSV with these 3 rows.
  const tsv = path.join(profileRoot, "applications.tsv");
  const headers = [
    "key", "source", "jobId", "companyName", "title", "url", "location",
    "status", "notion_page_id", "resume_ver", "cl_key", "salary_min",
    "salary_max", "cl_path", "createdAt", "updatedAt",
  ];
  const row = (vals) => vals.join("\t");
  const lines = [
    row(headers),
    row(["gh:1", "greenhouse", "1", "Affirm", "PM", "http://x", "Remote", "To Apply", "", "v1", "", "", "", "Affirm_role_20260505.md", "2026-05-05", "2026-05-05"]),
    row(["gh:2", "greenhouse", "2", "Stripe", "PM", "http://y", "Remote", "To Apply", "", "v1", "", "", "", "Stripe_role_20260505.md", "2026-05-05", "2026-05-05"]),
    row(["gh:3", "greenhouse", "3", "Adyen", "PM", "http://z", "Remote", "To Apply", "", "v1", "", "", "", "cover_letters/Adyen/Adyen_role_20260505.pdf", "2026-05-05", "2026-05-05"]),
  ];
  fs.writeFileSync(tsv, lines.join("\n") + "\n");

  const lines_out = [];
  const code = await migrate({
    profileId: "synthtest",
    apply: true,
    profilesDir,
    stdout: (s) => lines_out.push(s),
    stderr: () => {},
  });
  assert.equal(code, 0);

  // Files are at canonical locations.
  assert.ok(
    fs.existsSync(path.join(profileRoot, "cover_letters", "Affirm", "Affirm_role_20260505.pdf")),
    "row1 PDF moved into Affirm/"
  );
  assert.ok(
    fs.existsSync(path.join(profileRoot, "cover_letters_md", "Affirm", "Affirm_role_20260505.md")),
    "row1 MD moved into cover_letters_md/Affirm/"
  );
  assert.ok(
    fs.existsSync(path.join(profileRoot, "cover_letters", "Stripe", "Stripe_role_20260505.pdf")),
    "row2 PDF generated from MD"
  );
  assert.ok(
    fs.existsSync(path.join(profileRoot, "cover_letters_md", "Stripe", "Stripe_role_20260505.md")),
    "row2 MD moved into cover_letters_md/Stripe/"
  );
  // Originals removed.
  assert.equal(fs.existsSync(flatPdf), false, "original flat PDF was renamed");
  assert.equal(fs.existsSync(flatMd), false, "original flat MD was renamed");
  assert.equal(fs.existsSync(onlyMd), false, "original Stripe MD was renamed");
  // row3 untouched on disk.
  assert.equal(fs.existsSync(canonicalPdf), true);

  // TSV updated with canonical cl_paths.
  const after = fs.readFileSync(tsv, "utf8").split("\n").filter(Boolean);
  const updated = after.slice(1).map((l) => l.split("\t"));
  const clPathIdx = headers.indexOf("cl_path");
  assert.equal(updated[0][clPathIdx], "cover_letters/Affirm/Affirm_role_20260505.pdf");
  assert.equal(updated[1][clPathIdx], "cover_letters/Stripe/Stripe_role_20260505.pdf");
  assert.equal(updated[2][clPathIdx], "cover_letters/Adyen/Adyen_role_20260505.pdf");

  // Backup file created.
  const dir = fs.readdirSync(profileRoot);
  assert.ok(
    dir.some((f) => /^applications\.tsv\.pre-cl-migrate-/.test(f)),
    "backup TSV must be present"
  );

  // Idempotency: a second run should be a no-op.
  const lines2 = [];
  const code2 = await migrate({
    profileId: "synthtest",
    apply: true,
    profilesDir,
    stdout: (s) => lines2.push(s),
    stderr: () => {},
  });
  assert.equal(code2, 0);
  assert.ok(
    lines2.some((l) => /nothing to do/.test(l)),
    `second run should report nothing to do, got: ${lines2.join(" | ")}`
  );

  // Cleanup.
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("migrate: dry-run does not mutate filesystem or TSV", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-cl-dry-"));
  const profilesDir = path.join(tmp, "profiles");
  const profileRoot = path.join(profilesDir, "synthtest");
  fs.mkdirSync(path.join(profileRoot, "cover_letters"), { recursive: true });
  fs.writeFileSync(
    path.join(profileRoot, "profile.json"),
    JSON.stringify({ id: "synthtest" })
  );

  const flatMd = path.join(profileRoot, "cover_letters", "Affirm_x.md");
  fs.writeFileSync(flatMd, "para");
  const tsv = path.join(profileRoot, "applications.tsv");
  const headers = [
    "key", "source", "jobId", "companyName", "title", "url", "location",
    "status", "notion_page_id", "resume_ver", "cl_key", "salary_min",
    "salary_max", "cl_path", "createdAt", "updatedAt",
  ];
  fs.writeFileSync(
    tsv,
    headers.join("\t") + "\n" +
      ["gh:1", "greenhouse", "1", "Affirm", "PM", "http://x", "Remote", "To Apply", "", "v1", "", "", "", "Affirm_x.md", "2026-05-05", "2026-05-05"].join("\t") + "\n"
  );

  const before = fs.readFileSync(tsv, "utf8");
  const code = await migrate({
    profileId: "synthtest",
    apply: false,
    profilesDir,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(code, 0);

  assert.equal(fs.existsSync(flatMd), true, "flat MD must still exist");
  assert.equal(
    fs.existsSync(
      path.join(profileRoot, "cover_letters", "Affirm", "Affirm_x.pdf")
    ),
    false,
    "no PDF generated in dry-run"
  );
  assert.equal(fs.readFileSync(tsv, "utf8"), before, "TSV untouched in dry-run");
  // No backup created on dry-run.
  const dir = fs.readdirSync(profileRoot);
  assert.equal(
    dir.some((f) => /pre-cl-migrate/.test(f)),
    false,
    "no backup in dry-run"
  );

  fs.rmSync(tmp, { recursive: true, force: true });
});
