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
  normalizeGeo,
  normalizeResumeLayout,
  checkPositiveGate,
  DEFAULT_RESUME_LAYOUT,
  ID_REGEX,
} = require("./profile_loader.js");

// Silence the RFC 033 positive-gate warning by default in this test file —
// most fixtures are minimal and would otherwise spam stderr. Tests that
// assert on the warning pass an explicit capturing function.
const SILENT_OPTS = { warn: () => {} };

function makeTempProfiles() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aijs-profiles-"));
}

function writeProfile(profilesDir, id, profile, extras = {}) {
  const root = path.join(profilesDir, id);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "profile.json"), JSON.stringify(profile, null, 2));
  for (const [file, content] of Object.entries(extras)) {
    fs.writeFileSync(
      path.join(root, file),
      typeof content === "string" ? content : JSON.stringify(content)
    );
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

  const profile = loadProfile("test", { profilesDir: dir, ...SILENT_OPTS });
  try {
    assert.equal(profile.id, "test");
    assert.equal(profile.identity.email, "t@example.com");
    assert.deepEqual(profile.filterRules, {
      company_cap: { max_active: 3 },
      company_blocklist: [],
      title_blocklist: [],
      role_targets: null,
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
    JARED_GMAIL_APP_PASSWORD: "j-app-pass",
    PAT_NOTION_TOKEN: "l-token",
    OTHER_VAR: "ignored",
  };
  const jared = loadSecrets("jared", env);
  assert.deepEqual(jared, { NOTION_TOKEN: "j-token", GMAIL_APP_PASSWORD: "j-app-pass" });
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
  assert.deepEqual(out.title_requirelist, []);
  assert.equal(out.role_targets, null);
});

// --- RFC 030: role_targets (single source of truth for acceptable tracks) ---

test("normalizeFilterRules: role_targets present → synthesizes title_requirelist from tracks", () => {
  const out = normalizeFilterRules({
    role_targets: {
      _description: "...",
      fit_treatments: { primary: "p-prose", bridge: "b-prose" },
      tracks: [
        {
          id: "pm",
          name: "Product Manager",
          fit_treatment: "primary",
          patterns: [
            { pattern: "product manager", reason: "PM role" },
            { pattern: "PM", reason: "abbr" },
          ],
        },
        {
          id: "fde",
          name: "Forward-Deployed Engineer",
          fit_treatment: "bridge",
          bridge_note: "treat as primary in AI-native",
          patterns: [{ pattern: "forward deployed", reason: "FDE" }],
        },
      ],
    },
  });
  // Patterns from all tracks flow into title_requirelist for filter.js compat.
  assert.deepEqual(out.title_requirelist, [
    { pattern: "product manager", reason: "PM role" },
    { pattern: "PM", reason: "abbr" },
    { pattern: "forward deployed", reason: "FDE" },
  ]);
  // role_targets is preserved (with normalized track entries) for prepare.js.
  assert.equal(out.role_targets.tracks.length, 2);
  assert.equal(out.role_targets.tracks[0].id, "pm");
  assert.equal(out.role_targets.tracks[0].fit_treatment, "primary");
  assert.equal(out.role_targets.tracks[1].fit_treatment, "bridge");
  assert.equal(out.role_targets.tracks[1].bridge_note, "treat as primary in AI-native");
  assert.equal(out.role_targets.fit_treatments.primary, "p-prose");
});

test("normalizeFilterRules: explicit title_requirelist wins over role_targets synthesis", () => {
  const out = normalizeFilterRules({
    title_requirelist: { patterns: [{ pattern: "explicit-pattern", reason: "kept" }] },
    role_targets: {
      tracks: [{ id: "pm", name: "PM", patterns: [{ pattern: "synthesized", reason: "ignored" }] }],
    },
  });
  // Explicit title_requirelist is preserved; synthesis is skipped.
  assert.deepEqual(out.title_requirelist, [{ pattern: "explicit-pattern", reason: "kept" }]);
  // role_targets still exposed so prepare.js can read tracks/treatments.
  assert.equal(out.role_targets.tracks.length, 1);
});

test("normalizeFilterRules: role_targets defaults fit_treatment to primary when omitted", () => {
  const out = normalizeFilterRules({
    role_targets: {
      tracks: [{ id: "x", name: "X", patterns: [{ pattern: "x", reason: "x" }] }],
    },
  });
  assert.equal(out.role_targets.tracks[0].fit_treatment, "primary");
  assert.deepEqual(out.role_targets.fit_treatments, {});
});

test("normalizeFilterRules: role_targets with empty tracks → empty title_requirelist", () => {
  const out = normalizeFilterRules({ role_targets: { tracks: [] } });
  assert.deepEqual(out.title_requirelist, []);
  assert.deepEqual(out.role_targets.tracks, []);
});

test("normalizeFilterRules: malformed role_targets (no tracks array) → role_targets: null", () => {
  const out = normalizeFilterRules({ role_targets: { tracks: "not-array" } });
  assert.equal(out.role_targets, null);
  // Falls through to title_requirelist: [] since no synthesis possible.
  assert.deepEqual(out.title_requirelist, []);
});

// Regression for RFC 030 §10 R1 footgun: explicit `title_requirelist: []`
// alongside a non-empty role_targets must NOT silently disable the gate.
test("normalizeFilterRules: empty title_requirelist + non-empty role_targets → falls through to synthesis", () => {
  const out = normalizeFilterRules({
    title_requirelist: [],
    role_targets: {
      tracks: [{ id: "pm", name: "PM", patterns: [{ pattern: "product manager", reason: "PM" }] }],
    },
  });
  // Synthesized — gate is preserved despite explicit empty list.
  assert.deepEqual(out.title_requirelist, [{ pattern: "product manager", reason: "PM" }]);
});

test("normalizeFilterRules: empty {patterns: []} title_requirelist + role_targets → synthesis", () => {
  const out = normalizeFilterRules({
    title_requirelist: { patterns: [] },
    role_targets: {
      tracks: [{ id: "x", name: "X", patterns: [{ pattern: "x-role", reason: "x" }] }],
    },
  });
  assert.deepEqual(out.title_requirelist, [{ pattern: "x-role", reason: "x" }]);
});

test("normalizeFilterRules: track.patterns null/missing → empty patterns, no crash", () => {
  const out = normalizeFilterRules({
    role_targets: {
      tracks: [
        { id: "a", name: "A" }, // patterns absent
        { id: "b", name: "B", patterns: null }, // patterns explicitly null
        { id: "c", name: "C", patterns: [{ pattern: "c-pat", reason: "c" }] },
      ],
    },
  });
  assert.deepEqual(out.role_targets.tracks[0].patterns, []);
  assert.deepEqual(out.role_targets.tracks[1].patterns, []);
  // Only valid pattern from track C flows into the synthesized list.
  assert.deepEqual(out.title_requirelist, [{ pattern: "c-pat", reason: "c" }]);
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
  assert.throws(
    () => saveProfile("../etc", { x: 1 }, { profilesDir: "/tmp" }),
    /invalid profile id/
  );
});

test("saveProfile: throws when profile.json missing", () => {
  const dir = makeTempProfiles();
  fs.mkdirSync(path.join(dir, "bare"));
  assert.throws(() => saveProfile("bare", { x: 1 }, { profilesDir: dir }), /profile\.json missing/);
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
  const next = saveProfile("p", { company_tiers: { Acme: "B" } }, { profilesDir: dir });
  assert.deepEqual(next.company_tiers, { Acme: "B" });
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- L-2: memory loading ----------------------------------------------------

test("loadProfile: surfaces empty memory block when profile.memory absent", () => {
  const dir = makeTempProfiles();
  writeProfile(dir, "p", { id: "p", identity: { name: "x", email: "x@x" }, modules: [] });
  const profile = loadProfile("p", { profilesDir: dir, ...SILENT_OPTS });
  assert.deepEqual(profile.memory, { writingStyle: null, resumeKeyPoints: null, feedback: [] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadProfile: loads memory files declared in profile.memory", () => {
  const dir = makeTempProfiles();
  const root = writeProfile(dir, "p", {
    id: "p",
    identity: { name: "x", email: "x@x" },
    modules: [],
    memory: {
      writing_style_file: "memory/style.md",
      resume_key_points_file: "memory/key_points.md",
      feedback_dir: "memory",
    },
  });
  fs.mkdirSync(path.join(root, "memory"));
  fs.writeFileSync(path.join(root, "memory/style.md"), "warm 5/10");
  fs.writeFileSync(path.join(root, "memory/key_points.md"), "front-desk strong fit");
  fs.writeFileSync(path.join(root, "memory/feedback_recruiter.md"), "no location");
  fs.writeFileSync(path.join(root, "memory/feedback_humanizer.md"), "no AI tells");
  fs.writeFileSync(path.join(root, "memory/notes.md"), "ignored — not feedback_*");

  const profile = loadProfile("p", { profilesDir: dir, ...SILENT_OPTS });
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
  const profile = loadProfile("p", { profilesDir: dir, ...SILENT_OPTS });
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
  const profile = loadProfile("jared", { profilesDir: dir, ...SILENT_OPTS });
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
  const profile = loadProfile("lilia", { profilesDir: dir, ...SILENT_OPTS });
  assert.equal(profile.salaryConfig.levelParser, "healthcare");
  assert.equal(profile.salaryConfig.salaryMatrix.S.MedAdmin.min, 48000);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- normalizeGeo (L-4 / RFC 013) ------------------------------------------

test("normalizeGeo: missing block defaults to unrestricted", () => {
  assert.deepEqual(normalizeGeo(undefined), {
    mode: "unrestricted",
    remote_ok: false,
    blocklist: [],
  });
  assert.deepEqual(normalizeGeo(null), {
    mode: "unrestricted",
    remote_ok: false,
    blocklist: [],
  });
});

test("normalizeGeo: rejects non-object input", () => {
  assert.throws(() => normalizeGeo("string"), /must be an object/);
  assert.throws(() => normalizeGeo(["array"]), /must be an object/);
});

test("normalizeGeo: rejects unknown mode", () => {
  assert.throws(() => normalizeGeo({ mode: "global" }), /must be one of/);
});

test("normalizeGeo: metro mode requires non-empty cities", () => {
  assert.throws(() => normalizeGeo({ mode: "metro", states: ["CA"] }), /cities is required/);
  assert.throws(
    () => normalizeGeo({ mode: "metro", cities: [], states: ["CA"] }),
    /cities is required/
  );
});

test("normalizeGeo: metro mode requires non-empty states (§8.1)", () => {
  assert.throws(
    () => normalizeGeo({ mode: "metro", cities: ["Sacramento"] }),
    /states is required/
  );
  assert.throws(
    () => normalizeGeo({ mode: "metro", cities: ["Sacramento"], states: [] }),
    /states is required/
  );
});

test("normalizeGeo: metro mode canonical shape", () => {
  const out = normalizeGeo({
    mode: "metro",
    cities: ["Sacramento", "Roseville"],
    states: ["CA"],
    remote_ok: false,
    blocklist: ["Napa"],
  });
  assert.deepEqual(out, {
    mode: "metro",
    cities: ["Sacramento", "Roseville"],
    states: ["CA"],
    countries: [],
    remote_ok: false,
    blocklist: ["Napa"],
    max_radius_miles: null,
  });
});

test("normalizeGeo: us-wide defaults countries to ['US']", () => {
  const out = normalizeGeo({ mode: "us-wide" });
  assert.deepEqual(out.countries, ["US"]);
});

test("normalizeGeo: unrestricted with explicit remote_ok", () => {
  const out = normalizeGeo({ mode: "unrestricted", remote_ok: true });
  assert.equal(out.mode, "unrestricted");
  assert.equal(out.remote_ok, true);
});

test("normalizeGeo: max_radius_miles preserved when number, else null", () => {
  assert.equal(normalizeGeo({ mode: "us-wide", max_radius_miles: 25 }).max_radius_miles, 25);
  assert.equal(normalizeGeo({ mode: "us-wide", max_radius_miles: "25" }).max_radius_miles, null);
  assert.equal(normalizeGeo({ mode: "us-wide" }).max_radius_miles, null);
});

test("loadProfile: surfaces normalized geo block (Lilia metro)", () => {
  const dir = makeTempProfiles();
  writeProfile(dir, "lilia", {
    id: "lilia",
    geo: {
      mode: "metro",
      cities: ["Sacramento", "Roseville"],
      states: ["CA"],
      remote_ok: false,
      blocklist: ["Napa"],
    },
  });
  const profile = loadProfile("lilia", { profilesDir: dir, ...SILENT_OPTS });
  assert.equal(profile.geo.mode, "metro");
  assert.deepEqual(profile.geo.cities, ["Sacramento", "Roseville"]);
  assert.deepEqual(profile.geo.states, ["CA"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadProfile: profile without geo block defaults to unrestricted", () => {
  const dir = makeTempProfiles();
  writeProfile(dir, "jared", { id: "jared" });
  const profile = loadProfile("jared", { profilesDir: dir, ...SILENT_OPTS });
  assert.equal(profile.geo.mode, "unrestricted");
  assert.equal(profile.geo.remote_ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadProfile: invalid geo block raises clean error", () => {
  const dir = makeTempProfiles();
  writeProfile(dir, "broken", { id: "broken", geo: { mode: "metro", cities: ["X"] } });
  assert.throws(() => loadProfile("broken", { profilesDir: dir }), /states is required/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- RFC 033: positive-gate enforcement ------------------------------------

test("checkPositiveGate: returns null when role_targets has at least one track with patterns", () => {
  const out = checkPositiveGate(
    {
      role_targets: {
        tracks: [{ id: "pm", patterns: [{ pattern: "product manager", reason: "PM" }] }],
      },
      title_requirelist: [],
    },
    "jared"
  );
  assert.equal(out, null);
});

test("checkPositiveGate: returns null when title_requirelist is non-empty (no role_targets)", () => {
  const out = checkPositiveGate(
    {
      role_targets: null,
      title_requirelist: [{ pattern: "manager", reason: "..." }],
    },
    "jared"
  );
  assert.equal(out, null);
});

test("checkPositiveGate: warns when both role_targets and title_requirelist are empty", () => {
  const out = checkPositiveGate({ role_targets: null, title_requirelist: [] }, "lilia");
  assert.ok(typeof out === "string");
  assert.match(out, /profile "lilia"/);
  assert.match(out, /role_targets/);
  assert.match(out, /RFC 033/);
});

test("checkPositiveGate: warns when role_targets has only empty-pattern tracks", () => {
  const out = checkPositiveGate(
    {
      role_targets: { tracks: [{ id: "x", patterns: [] }] },
      title_requirelist: [],
    },
    "lilia"
  );
  assert.ok(typeof out === "string");
  assert.match(out, /role_targets/);
});

test("checkPositiveGate: warns when filterRules is missing entirely", () => {
  const out = checkPositiveGate(null, "lilia");
  assert.ok(typeof out === "string");
  assert.match(out, /no filter_rules/);
  assert.match(out, /RFC 033/);
});

test("loadProfile: emits RFC 033 warning via injected warn callback when no positive gate", () => {
  const dir = makeTempProfiles();
  writeProfile(
    dir,
    "p",
    { id: "p", filter_rules_file: "filter_rules.json" },
    { "filter_rules.json": { company_cap: { max_active: 3 } } }
  );
  const warnings = [];
  loadProfile("p", { profilesDir: dir, warn: (msg) => warnings.push(msg) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /profile "p"/);
  assert.match(warnings[0], /role_targets/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadProfile: does NOT warn when role_targets has at least one populated track", () => {
  const dir = makeTempProfiles();
  writeProfile(
    dir,
    "p",
    { id: "p", filter_rules_file: "filter_rules.json" },
    {
      "filter_rules.json": {
        role_targets: {
          tracks: [
            {
              id: "pm",
              name: "PM",
              patterns: [{ pattern: "product manager", reason: "PM" }],
            },
          ],
        },
      },
    }
  );
  const warnings = [];
  loadProfile("p", { profilesDir: dir, warn: (msg) => warnings.push(msg) });
  assert.equal(warnings.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- BL-126 Block D: resume.layout normalisation ----------------------------

test("normalizeResumeLayout: defaults to one_page when absent/null/empty", () => {
  assert.deepEqual(normalizeResumeLayout(undefined), { layout: "one_page", warnings: [] });
  assert.deepEqual(normalizeResumeLayout(null), { layout: "one_page", warnings: [] });
  assert.deepEqual(normalizeResumeLayout(""), { layout: "one_page", warnings: [] });
  assert.equal(DEFAULT_RESUME_LAYOUT, "one_page");
});

test("normalizeResumeLayout: accepts known presets verbatim", () => {
  for (const v of ["one_page", "two_page", "ru_long"]) {
    const { layout, warnings } = normalizeResumeLayout(v);
    assert.equal(layout, v);
    assert.deepEqual(warnings, []);
  }
});

test("normalizeResumeLayout: unknown value falls back to one_page with warning", () => {
  const { layout, warnings } = normalizeResumeLayout("triple_page");
  assert.equal(layout, "one_page");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /triple_page/);
  assert.match(warnings[0], /one_page/);
});

test("loadProfile: surfaces resume.layout=two_page when set", () => {
  const dir = makeTempProfiles();
  writeProfile(dir, "p", {
    id: "p",
    resume: { versions_file: "rv.json", layout: "two_page" },
  });
  const profile = loadProfile("p", { ...SILENT_OPTS, profilesDir: dir });
  assert.equal(profile.resume.layout, "two_page");
  // Other resume fields preserved.
  assert.equal(profile.resume.versions_file, "rv.json");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadProfile: resume.layout defaults to one_page when resume block absent", () => {
  const dir = makeTempProfiles();
  writeProfile(dir, "p", { id: "p" });
  const profile = loadProfile("p", { ...SILENT_OPTS, profilesDir: dir });
  assert.equal(profile.resume.layout, "one_page");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadProfile: resume.layout defaults to one_page when field absent on existing resume block", () => {
  const dir = makeTempProfiles();
  writeProfile(dir, "p", { id: "p", resume: { versions_file: "rv.json" } });
  const profile = loadProfile("p", { ...SILENT_OPTS, profilesDir: dir });
  assert.equal(profile.resume.layout, "one_page");
  assert.equal(profile.resume.versions_file, "rv.json");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadProfile: unknown resume.layout warns via injected callback and falls back", () => {
  const dir = makeTempProfiles();
  writeProfile(dir, "p", {
    id: "p",
    resume: { layout: "triple_page" },
  });
  const warnings = [];
  const profile = loadProfile("p", {
    profilesDir: dir,
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(profile.resume.layout, "one_page");
  // First warning may be the RFC 033 positive-gate warning; find the layout one.
  const layoutWarn = warnings.find((w) => /resume\.layout/.test(w));
  assert.ok(layoutWarn, `expected resume.layout warning, got: ${JSON.stringify(warnings)}`);
  assert.match(layoutWarn, /triple_page/);
  assert.match(layoutWarn, /one_page/);
  fs.rmSync(dir, { recursive: true, force: true });
});
