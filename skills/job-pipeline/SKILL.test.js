// Smoke test for the job-pipeline skill manifest.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SKILL_PATH = path.resolve(__dirname, "SKILL.md");

test("SKILL.md exists and starts with the required frontmatter", () => {
  assert.ok(fs.existsSync(SKILL_PATH), "SKILL.md missing");
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(text, /^---\nname: job-pipeline\n/);
  assert.match(text, /description:.*scan.*validate.*sync/i);
});

test("SKILL.md documents all five CLI commands", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  for (const cmd of ["scan", "validate", "sync", "prepare", "check"]) {
    assert.match(text, new RegExp(`/job-pipeline ${cmd}`), `missing /${cmd} doc`);
    assert.match(
      text,
      new RegExp(`node engine/cli\\.js ${cmd}`),
      `missing CLI invocation for ${cmd}`
    );
  }
});

test("SKILL.md warns that sync defaults to dry-run", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(text, /Default = dry-run/i);
  assert.match(text, /--apply/);
});

test("SKILL.md includes the seed-companies bootstrap step", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(text, /seed_companies\.js/);
});

test("SKILL.md lists the supported profile (jared) explicitly", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(text, /\bjared\b/);
});

test("SKILL.md documents the profile resolution policy (default + NLP + sticky)", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(text, /Default profile is `jared`/i, "must state default profile");
  assert.match(text, /NLP extraction/i, "must describe NLP extraction");
  assert.match(text, /Session-sticky/i, "must describe session-sticky behavior");
  assert.match(text, /--profile/, "must reference the --profile CLI flag");
});

// BL-14 / RFC 019 — engine writes CL files; SKILL emits paragraphs only.
test("SKILL.md Step 8e tells the SKILL not to write the .md file itself", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  // Locked: SKILL must NOT include any "Save the CL as ...md" instruction.
  assert.doesNotMatch(
    text,
    /Save the CL as .*\.md/i,
    "Step 8e must no longer instruct the SKILL to write the .md file directly"
  );
  // Must explicitly call out that engine writes the files.
  assert.match(text, /clParagraphs/);
  assert.match(text, /engine writes the files/i);
});

test("SKILL.md Step 9 Cover Letter field uses .pdf filename (BL-14)", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  // Notion `Cover Letter` rich_text now stores the PDF filename, not stem.
  assert.match(
    text,
    /\*\*Cover Letter\*\*[\s\S]*?\.pdf/,
    "Step 9 Cover Letter field must reference .pdf extension"
  );
});

test("SKILL.md Step 10 results schema example includes clParagraphs (BL-14)", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(text, /"clParagraphs"\s*:\s*\[/);
  // And drops `clPath` from the to_apply example — engine derives it now.
  // (The old line `"clPath": "<company>_<role-slug>_<YYYYMMDD>.md"` must be gone.)
  assert.doesNotMatch(text, /"clPath"\s*:\s*"<company>_<role-slug>_<YYYYMMDD>\.md"/);
});
