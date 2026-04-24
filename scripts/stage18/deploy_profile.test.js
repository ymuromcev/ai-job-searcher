const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { generateFiles, writeIfChanged } = require("./deploy_profile.js");

function baseIntake(overrides = {}) {
  return {
    identity: {
      profile_id: "profile_b",
      full_name: "Pat Example",
      email: "pat@example.com",
      phone: "+1 555 000 0000",
      location_city: "San Francisco",
      location_state: "CA",
      location_country: "US",
    },
    career: {
      target_roles: "Product Manager",
      level: "Senior",
      years_experience: 7,
    },
    preferences: {
      salary_min_total_comp: 180000,
      salary_currency: "USD",
      work_format: "Hybrid",
    },
    companies: {
      tier_s: ["Acme"],
      tier_a: ["Beta Co"],
      company_blocklist: ["EvilCorp"],
    },
    resume_archetypes: [
      { key: "pm_default", title: "Senior PM", summary: "PM generalist.", tags: ["pm"] },
    ],
    cover_letter: { tone: "conversational", length: "medium" },
    notion: {
      parent_page_url: "https://www.notion.so/workspace/Hub-00000000000000000000000000000000",
    },
    modules: ["discovery:greenhouse", "discovery:lever"],
    env_checks: { env_notion_token_set: true },
    flags: {},
    ...overrides,
  };
}

function mkTmpProfileDir(id = "profile_b") {
  // Make a throwaway repo root with profiles/<id>/ so profileDir() resolves.
  // We override via monkey-patching REPO_ROOT is NOT straightforward; instead
  // we test generateFiles by pointing profileDir through the real repo but
  // writing into a temp subdir under profiles/_example-like name. Simplest:
  // just rely on writeIfChanged directly for unit tests, and test
  // generateFiles in dry-run where no disk writes happen.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stage18-deploy-"));
  return tmp;
}

test("writeIfChanged: writes new file", () => {
  const tmp = mkTmpProfileDir();
  try {
    const p = path.join(tmp, "a.txt");
    const r = writeIfChanged(p, "hello");
    assert.equal(r, "wrote");
    assert.equal(fs.readFileSync(p, "utf8"), "hello");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("writeIfChanged: skips when content identical", () => {
  const tmp = mkTmpProfileDir();
  try {
    const p = path.join(tmp, "a.txt");
    fs.writeFileSync(p, "hello");
    const r = writeIfChanged(p, "hello");
    assert.equal(r, "unchanged");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("writeIfChanged: overwrites when content differs", () => {
  const tmp = mkTmpProfileDir();
  try {
    const p = path.join(tmp, "a.txt");
    fs.writeFileSync(p, "old");
    const r = writeIfChanged(p, "new");
    assert.equal(r, "wrote");
    assert.equal(fs.readFileSync(p, "utf8"), "new");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("writeIfChanged: creates parent directory if missing", () => {
  const tmp = mkTmpProfileDir();
  try {
    const p = path.join(tmp, "nested", "deep", "file.txt");
    const r = writeIfChanged(p, "x");
    assert.equal(r, "wrote");
    assert.ok(fs.existsSync(p));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("generateFiles (dry-run): plans all 5 artifacts without writing", () => {
  // dry-run = no disk writes, so we can safely use a real intake and just
  // verify the returned summary shape.
  const intake = baseIntake();
  const summary = generateFiles(intake, "profile_b", /* apply */ false);
  const paths = summary.map((s) => s.path).sort();
  assert.deepEqual(paths, [
    "cover_letter_template.md",
    "cover_letter_versions.json",
    "filter_rules.json",
    "profile.json",
    "resume_versions.json",
  ]);
  for (const s of summary) {
    assert.equal(s.status, "planned");
  }
});

test("generateFiles (dry-run): surfaces intake missing parent_page_url early", () => {
  const intake = baseIntake({ notion: {} });
  // buildProfileJson calls extractNotionPageId("") → throws.
  assert.throws(() => generateFiles(intake, "profile_b", false), /notion page URL/i);
});
