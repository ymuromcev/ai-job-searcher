const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  loadProfile,
  saveProfile,
  loadSecrets,
  normalizeFilterRules,
  loadMemory,
  normalizeSalaryConfig,
  ID_REGEX,
} = require("./profile_loader.js");

function makeTempProfiles() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aijs-profiles-"));
}

function writeProfile(profilesDir, id, profile, extras = {}) {
  const root = path.join(profilesDir, id);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "profile.json"), JSON.stringify(profile, null, 2));
  for (const [file, content] of Object.entries(extras)) {
    fs.writeFileSync(path.join(root, file), typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

test("ID_REGEX accepts lowercase ids with digits/hyphens/underscores", () => {
  assert.ok(ID_REGEX.test("jared"));
  assert.ok(ID_REGEX.test("pat"));
  assert.ok(ID_REGEX.test("user_2"));
  assert.ok(ID_REGEX.test("dev-3"));
});

test("ID_REGEX rejects unsafe ids", () => {
  assert.equal(ID_REGEX.test(""), false);
  assert.equal(ID_REGEX.test("../etc"), false);
  assert.equal(ID_REGEX.test("Jared"), false); // uppercase
  assert.equal(ID_REGEX.test("1jared"), false); // starts with digit
  assert.equal(ID_REGEX.test("jar ed"), false); // space
  assert.equal(ID_REGEX.test("jared/pat"), false);
});

test("loadProfile throws on invalid id", () => {
  assert.throws(() => loadProfile("../etc", { profilesDir: "/tmp" }), /invalid profile id/);
  assert.throws(() => loadProfile("", { profilesDir: "/tmp" }), /invalid profile id/);
  assert.throws(() => loadProfile("UPPER", { profilesDir: "/tmp" }), /invalid profile id/);
});

test("loadProfile throws when directory missing", () => {
  const dir = makeTempProfiles();
  assert.throws(() => loadProfile("ghost", { profilesDir: dir }), /profile not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadProfile throws when profile.json missing", () => {
  const dir = makeTempProfiles();
  fs.mkdirSync(path.join(dir, "bare"));
  assert.throws(
    () => loadProfile("bare", { profilesDir: dir }),
    /profile\.json missing[\s\S]*onboarding wizard/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadProfile error hints at _example copy when profile.example.json present", () => {
  const dir = makeTempProfiles();
  const root = path.join(dir, "copied");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "profile.example.json"), "{}");
  assert.throws(
    () => loadProfile("copied", { profilesDir: dir }),
    /Found profile\.example\.json[\s\S]*copied profiles\/_example\/[\s\S]*scripts\/stage18/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadProfile returns normalized object with paths and loaded sub-configs", () => {
  const dir = makeTempProfiles();
  writeProfile(
    dir,
    "test",
    {
      id: "test",
      identity: { name: "Test", email: "t@example.com" },
      modules: ["generators:resume_pdf"],
      filter_rules_file: "filter_rules.json",
      resume: { versions_file: "resume_versions.json", output_dir: "resumes" },
      cover_letter: {
        config_file: "cl_config.json",
        template_file: "cl_template.md",
        output_dir: "cover_letters",
      },
      fit_prompt_template: "hello",
    },
    {
      "filter_rules.json": { company_cap: { max_active: 3 } },
      "resume_versions.json": { contact: { name: "Test" }, versions: {} },
      "cl_config.json": { defaults: {} },
      "cl_template.md": "Dear {{company}}...",
    }
  );

  const profile = loadProfile("test", { profilesDir: dir });
  try {
    assert.equal(profile.id, "test");
    assert.equal(profile.identity.email, "t@example.com");
    assert.deepEqual(profile.filterRules, {
      company_cap: { max_active: 3 },
      company_blocklist: [],
      title_blocklist: [],
      title_requirelist: [],
      location_blocklist: [],
    });
    assert.ok(profile.resumeVersions);
    assert.ok(profile.coverLetterConfig);
    assert.equal(profile.coverLetterTemplate, "Dear {{company}}...");
    assert.ok(profile.paths.root.endsWith("/test"));
    assert.ok(profile.paths.applicationsTsv.endsWith("/applications.tsv"));
    assert.ok(profile.paths.resumesDir.endsWith("/resumes"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProfile throws when profile.id does not match requested id", () => {
  const dir = makeTempProfiles();
  writeProfile(dir, "jared", {
    id: "pat",
    identity: { name: "x", email: "x@x" },
    modules: [],
  });
  assert.throws(() => loadProfile("jared", { profilesDir: dir }), /does not match/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadSecrets returns only keys for the requested profile, stripping prefix", () => {
  const env = {
    JARED_NOTION_TOKEN: "j-token",
    JARED_GMAIL_CLIENT_ID: "j-gmail",
    PAT_NOTION_TOKEN: "l-token",
    OTHER_VAR: "ignored",
  };
  const jared = loadSecrets("jared", env);
  assert.deepEqual(jared, { NOTION_TOKEN: "j-token", GMAIL_CLIENT_ID: "j-gmail" });
  assert.equal(jared.PAT_NOTION_TOKEN, undefined);

  const pat = loadSecrets("pat", env);
  assert.deepEqual(pat, { NOTION_TOKEN: "l-token" });
});

test("loadSecrets validates id", () => {
  assert.throws(() => loadSecrets("../etc", {}), /invalid profile id/);
});

// Filter-rules normalization accepts the prototype's nested shape so migrated
// filter_rules.json works identically in the new engine. See audit §6.
test("normalizeFilterRules: nested prototype shape → flat engine shape", () => {
  const out = normalizeFilterRules({
    company_cap: { max_active: 3 },
    company_blocklist: {
      _description: "junk companies",
      companies: [
        { name: "Toast", reason: "not fintech" },
        { name: "Gusto", reason: "HR tech" },
      ],
    },
    title_blocklist: {
      _description: "levels",
      patterns: [
        { pattern: "Associate", reason: "too junior" },
        { pattern: "Director", reason: "too senior" },
      ],
    },
    location_blocklist: {
      _description: "non-US",
      patterns: ["UK", "Canada"],
    },
  });
  assert.deepEqual(out.company_blocklist, ["Toast", "Gusto"]);
  assert.deepEqual(out.title_blocklist, [
    { pattern: "Associate", reason: "too junior" },
    { pattern: "Director", reason: "too senior" },
  ]);
  assert.deepEqual(out.location_blocklist, ["UK", "Canada"]);
  assert.deepEqual(out.company_cap, { max_active: 3 });
});

test("normalizeFilterRules: flat engine shape passes through", () => {
  const out = normalizeFilterRules({
    company_blocklist: ["Toast"],
    title_blocklist: [{ pattern: "Intern", reason: "internship" }],
    location_blocklist: ["Canada"],
  });
  assert.deepEqual(out.company_blocklist, ["Toast"]);
  assert.deepEqual(out.title_blocklist, [{ pattern: "Intern", reason: "internship" }]);
  assert.deepEqual(out.location_blocklist, ["Canada"]);
});

test("normalizeFilterRules: missing keys default to empty arrays", () => {
  const out = normalizeFilterRules({ company_cap: { max_active: 2 } });
  assert.deepEqual(out.company_blocklist, []);
  assert.deepEqual(out.title_blocklist, []);
  assert.deepEqual(out.location_blocklist, []);
});

test("normalizeFilterRules: preserves auxiliary sections verbatim", () => {
  const input = {
    company_cap: { max_active: 3 },
    domain_weak_fit: { patterns: [{ pattern: "Tax", reason: "x" }] },
    early_startup_modifier: { companies: [{ name: "Capchase" }] },
    priority_order: { criteria: ["fintech"] },
  };
  const out = normalizeFilterRules(input);
  assert.deepEqual(out.domain_weak_fit, input.domain_weak_fit);
  assert.deepEqual(out.early_startup_modifier, input.early_startup_modifier);
  assert.deepEqual(out.priority_order, input.priority_order);
});

test("saveProfile: validates id", () => {
  assert.throws(() => saveProfile("../etc", { x: 1 }, { profilesDir: "/tmp" }), /invalid profile id/);
});

test("saveProfile: throws when profile.json missing", () => {
  const dir = makeTempProfiles();
  fs.mkdirSync(path.join(dir, "bare"));
  assert.throws(
    () => saveProfile("bare", { x: 1 }, { profilesDir: dir }),
    /profile\.json missing/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("saveProfile: deep-merges company_tiers, replaces other top-level keys", () => {
  const dir = makeTempProfiles();
  writeProfile(dir, "p", {
    id: "p",
    company_tiers: { Stripe: "S", Brex: "A" },
    notion: { jobs_db_id: "abc" },
  });
  const next = saveProfile(
    "p",
    {
      company_tiers: { Brex: "B", NewCo: "C" }, // override Brex, add NewCo, keep Stripe
      notion: { jobs_db_id: "xyz" }, // top-level replace (not deep-merged)
    },
    { profilesDir: dir }
  );
  assert.deepEqual(next.company_tiers, { Stripe: "S", Brex: "B", NewCo: "C" });
  assert.deepEqual(next.notion, { jobs_db_id: "xyz" });

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "p", "profile.json"), "utf8"));
  assert.deepEqual(onDisk.company_tiers, { Stripe: "S", Brex: "B", NewCo: "C" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("saveProfile: writes atomically via tmp+rename (no partial file on error)", () => {
  const dir = makeTempProfiles();
  writeProfile(dir, "p", { id: "p", company_tiers: { A: "S" } });
  saveProfile("p", { company_tiers: { B: "A" } }, { profilesDir: dir });
  // No leftover .tmp.* files
  const leftovers = fs.readdirSync(path.join(dir, "p")).filter((f) => f.includes(".tmp."));
  assert.equal(leftovers.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("saveProfile: handles empty current company_tiers", () => {
  const dir = makeTempProfiles();
  writeProfile(dir, "p", { id: "p" });
  const next = saveProfile(
    "p",
    { company_tiers: { Acme: "B" } },
    { profilesDir: dir }
  );
  assert.deepEqual(next.company_tiers, { Acme: "B" });
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- L-2: memory loading ----------------------------------------------------

test("loadProfile: surfaces empty memory block when profile.memory absent", () => {
  const dir = makeTempProfiles();
  writeProfile(dir, "p", { id: "p", identity: { name: "x", email: "x@x" }, modules: [] });
  const profile = loadProfile("p", { profilesDir: dir });
  assert.deepEqual(profile.memory, { writingStyle: null, resumeKeyPoints: null, feedback: [] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadProfile: loads memory files declared in profile.memory", () => {
  const dir = makeTempProfiles();
  const root = writeProfile(
    dir,
    "p",
    {
      id: "p",
      identity: { name: "x", email: "x@x" },
      modules: [],
      memory: {
        writing_style_file: "memory/style.md",
        resume_key_points_file: "memory/key_points.md",
        feedback_dir: "memory",
      },
    }
  );
  fs.mkdirSync(path.join(root, "memory"));
  fs.writeFileSync(path.join(root, "memory/style.md"), "warm 5/10");
  fs.writeFileSync(path.join(root, "memory/key_points.md"), "front-desk strong fit");
  fs.writeFileSync(path.join(root, "memory/feedback_recruiter.md"), "no location");
  fs.writeFileSync(path.join(root, "memory/feedback_humanizer.md"), "no AI tells");
  fs.writeFileSync(path.join(root, "memory/notes.md"), "ignored — not feedback_*");

  const profile = loadProfile("p", { profilesDir: dir });
  assert.equal(profile.memory.writingStyle, "warm 5/10");
  assert.equal(profile.memory.resumeKeyPoints, "front-desk strong fit");
  assert.equal(profile.memory.feedback.length, 2);
  const names = profile.memory.feedback.map((f) => path.basename(f.file)).sort();
  assert.deepEqual(names, ["feedback_humanizer.md", "feedback_recruiter.md"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadProfile: missing memory files come back as null without throwing", () => {
  const dir = makeTempProfiles();
  writeProfile(dir, "p", {
    id: "p",
    identity: { name: "x", email: "x@x" },
    modules: [],
    memory: {
      writing_style_file: "memory/style.md",
      resume_key_points_file: "memory/key_points.md",
    },
  });
  const profile = loadProfile("p", { profilesDir: dir });
  assert.equal(profile.memory.writingStyle, null);
  assert.equal(profile.memory.resumeKeyPoints, null);
  assert.deepEqual(profile.memory.feedback, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadMemory: handles missing dir gracefully", () => {
  const out = loadMemory("/no/such/path", { feedback_dir: "memory" });
  assert.deepEqual(out.feedback, []);
});

// --- L-1: salary block normalization ---------------------------------------

test("normalizeSalaryConfig: returns null when block absent", () => {
  assert.equal(normalizeSalaryConfig(undefined), null);
  assert.equal(normalizeSalaryConfig(null), null);
  assert.equal(normalizeSalaryConfig("string"), null);
});

test("normalizeSalaryConfig: maps snake_case to calcSalary opts", () => {
  const out = normalizeSalaryConfig({
    currency: "USD",
    level_parser: "healthcare",
    matrix: { S: { MedAdmin: { min: 48000, max: 58000, mid: 53000 } } },
    col_adjustment: { multiplier: 1.0, high_col_cities: [], exclude_format: ["Remote"] },
  });
  assert.equal(out.currency, "USD");
  assert.equal(out.levelParser, "healthcare");
  assert.deepEqual(out.salaryMatrix.S.MedAdmin, { min: 48000, max: 58000, mid: 53000 });
  assert.deepEqual(out.colAdjustment, {
    multiplier: 1.0,
    high_col_cities: [],
    exclude_format: ["Remote"],
  });
});

test("loadProfile: surfaces salaryConfig=null when profile.salary absent (Jared parity)", () => {
  const dir = makeTempProfiles();
  writeProfile(dir, "jared", { id: "jared", identity: { name: "x", email: "x@x" }, modules: [] });
  const profile = loadProfile("jared", { profilesDir: dir });
  assert.equal(profile.salaryConfig, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadProfile: normalises profile.salary into salaryConfig", () => {
  const dir = makeTempProfiles();
  writeProfile(dir, "lilia", {
    id: "lilia",
    identity: { name: "x", email: "x@x" },
    modules: [],
    salary: {
      currency: "USD",
      level_parser: "healthcare",
      matrix: { S: { MedAdmin: { min: 48000, max: 58000, mid: 53000 } } },
    },
  });
  const profile = loadProfile("lilia", { profilesDir: dir });
  assert.equal(profile.salaryConfig.levelParser, "healthcare");
  assert.equal(profile.salaryConfig.salaryMatrix.S.MedAdmin.min, 48000);
  fs.rmSync(dir, { recursive: true, force: true });
});
