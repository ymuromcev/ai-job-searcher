// Smoke test for the interview-coach skill manifest.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SKILL_PATH = path.resolve(__dirname, "SKILL.md");

test("SKILL.md exists and starts with the required frontmatter", () => {
  assert.ok(fs.existsSync(SKILL_PATH), "SKILL.md missing");
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(text, /^---\nname: interview-coach\n/);
});

test("SKILL.md documents the profile resolution policy (default + NLP + sticky)", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(text, /Default profile is `jared`/i, "must state default profile");
  assert.match(text, /NLP extraction/i, "must describe NLP extraction");
  assert.match(text, /Session-sticky/i, "must describe session-sticky behavior");
});

test("SKILL.md pins coaching_state.md to profiles/<id>/interview-coach-state/", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(
    text,
    /profiles\/<id>\/interview-coach-state\/coaching_state\.md/,
    "must document the profile-scoped path for coaching_state.md"
  );
});
