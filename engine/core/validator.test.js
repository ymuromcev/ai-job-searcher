const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { validateJob, validateProfile, validateProfileDeep } = require("./validator.js");
const { loadProfile } = require("./profile_loader.js");

// --- Back-compat (BL pre-99) ------------------------------------------------

test("validateJob passes on complete job", () => {
  const r = validateJob({
    source: "greenhouse",
    jobId: "1",
    company: "A",
    role: "PM",
    jobUrl: "https://x",
  });
  assert.equal(r.valid, true);
  assert.equal(r.errors.length, 0);
});

test("validateJob fails on missing required fields", () => {
  const r = validateJob({ source: "gh", company: "A" });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("jobId")));
  assert.ok(r.errors.some((e) => e.includes("role")));
  assert.ok(r.errors.some((e) => e.includes("jobUrl")));
});

test("validateJob rejects non-object input", () => {
  assert.equal(validateJob(null).valid, false);
  assert.equal(validateJob("string").valid, false);
});

test("validateProfile passes on minimal valid profile", () => {
  const r = validateProfile({
    id: "jared",
    identity: { name: "J", email: "j@x" },
    modules: ["generators:resume_pdf"],
  });
  assert.equal(r.valid, true);
});

test("validateProfile fails when identity.email missing", () => {
  const r = validateProfile({
    id: "jared",
    identity: { name: "J" },
    modules: [],
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("identity.email")));
});

test("validateProfile rejects non-array modules", () => {
  const r = validateProfile({
    id: "jared",
    identity: { name: "J", email: "j@x" },
    modules: "not-array",
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /modules must be an array/.test(e)));
});

test("validateProfile rejects id that fails ID_REGEX", () => {
  const r = validateProfile({
    id: "BadID",
    identity: { name: "J", email: "j@x" },
    modules: [],
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("profile.id does not match")));
});

// --- validateProfileDeep orchestrator ---------------------------------------

test("validateProfileDeep aggregates issues across categories", () => {
  const profile = {
    id: "jared",
    identity: { name: "J", email: "j@x" },
    modules: ["discovery:fictional"],
    filterRules: {
      // role_targets missing → semantic error
      title_blocklist: [{ pattern: "(unclosed" }], // schema error
      title_requirelist: [],
      location_blocklist: [],
      company_blocklist: [],
      role_targets: null,
    },
    paths: { root: "/tmp/nope" },
  };
  const result = validateProfileDeep(
    profile,
    {},
    { existsSync: () => false }
  );
  const categories = new Set(result.issues.map((i) => i.category));
  // Includes both schema (regex), semantic (role_targets), referential (module).
  assert.ok(categories.has("schema"));
  assert.ok(categories.has("semantic"));
  assert.ok(categories.has("referential"));
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
  // back-compat: errors are stringified single-line.
  assert.ok(result.errors.every((e) => typeof e === "string"));
});

test("validateProfileDeep: valid=true when only warns present", () => {
  const profile = {
    id: "jared",
    identity: { name: "J", email: "j@x" },
    modules: [],
    filterRules: {
      title_blocklist: [],
      title_requirelist: [],
      // anchor-looking entries → warn only
      location_blocklist: ["^Bengaluru$"],
      company_blocklist: [],
      role_targets: { tracks: [{ id: "pm", name: "PM", patterns: [{ pattern: "pm" }] }] },
    },
    paths: { root: "/tmp/x" },
  };
  const result = validateProfileDeep(profile, {}, { existsSync: () => true });
  assert.equal(result.valid, true);
  const warns = result.issues.filter((i) => i.severity === "warn");
  assert.ok(warns.length >= 1);
});

// --- Golden test: profiles/_example/ passes deep validation -----------------
//
// RFC 037 §7: copy profiles/_example/ to a tmpdir, rename .example suffixes,
// resolve the placeholder UUID, then load + validate. The tree must report
// zero errors (warnings are allowed). If this breaks, either the new check
// is a false positive or _example has drifted — _example is the truth.

function copyExampleToTmp() {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const src = path.join(repoRoot, "profiles", "_example");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "validator-example-"));
  const profilesDir = path.join(tmpRoot, "profiles");
  const dst = path.join(profilesDir, "example_test");
  fs.mkdirSync(dst, { recursive: true });

  function copyRec(srcDir, dstDir) {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const s = path.join(srcDir, entry.name);
      const renamed = entry.name.replace(/\.example\./, ".");
      const d = path.join(dstDir, renamed);
      if (entry.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        copyRec(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  }
  copyRec(src, dst);

  // Rewrite profile.json so it (a) references the renamed sibling files
  // (.example.json → .json), (b) replaces the placeholder DB id with a real-
  // looking UUID, and (c) matches the new directory id. Mirrors the Stage 18
  // wizard's onboarding mutations, just enough to make the example loadable.
  const profileJsonPath = path.join(dst, "profile.json");
  const profile = JSON.parse(fs.readFileSync(profileJsonPath, "utf8"));
  function dropExample(s) {
    return typeof s === "string" ? s.replace(/\.example\./g, ".") : s;
  }
  if (profile.filter_rules_file) profile.filter_rules_file = dropExample(profile.filter_rules_file);
  if (profile.resume && profile.resume.versions_file) {
    profile.resume.versions_file = dropExample(profile.resume.versions_file);
  }
  if (profile.cover_letter) {
    if (profile.cover_letter.template_file) {
      profile.cover_letter.template_file = dropExample(profile.cover_letter.template_file);
    }
    if (profile.cover_letter.config_file) {
      profile.cover_letter.config_file = dropExample(profile.cover_letter.config_file);
    }
  }
  if (
    profile.notion &&
    typeof profile.notion.jobs_pipeline_db_id === "string" &&
    profile.notion.jobs_pipeline_db_id.startsWith("REPLACE_WITH")
  ) {
    profile.notion.jobs_pipeline_db_id = "12345678-1234-1234-1234-1234567890ab";
  }
  // Loader requires profile.id to match the directory name.
  profile.id = "example_test";
  fs.writeFileSync(profileJsonPath, JSON.stringify(profile, null, 2));

  return { tmpRoot, profilesDir, profileRoot: dst };
}

test("golden: profiles/_example/ passes validateProfileDeep with zero errors", () => {
  const { tmpRoot, profilesDir, profileRoot } = copyExampleToTmp();
  try {
    const profile = loadProfile("example_test", { profilesDir });
    const result = validateProfileDeep(profile, { profileRoot, dataDir: path.join(tmpRoot, "data") });
    const errs = result.issues.filter((i) => i.severity === "error");
    if (errs.length > 0) {
      // Make the failure easy to act on.
      const lines = errs.map((i) => `  [${i.category}/${i.severity}] ${i.field}: ${i.message}`);
      assert.fail(
        `_example profile produced ${errs.length} validator error(s):\n${lines.join("\n")}`
      );
    }
    assert.equal(result.valid, true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
