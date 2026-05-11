// Smoke tests for the onboard-profile skill manifest.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SKILL_PATH = path.resolve(__dirname, "SKILL.md");

test("SKILL.md exists and starts with the required frontmatter", () => {
  assert.ok(fs.existsSync(SKILL_PATH), "SKILL.md missing");
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(text, /^---\nname: onboard-profile\n/);
  assert.match(text, /description:.*onboard/i);
});

test("SKILL.md documents trigger phrases", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  // Slash command + free-form phrasing both supported.
  assert.match(text, /\/onboard-profile/);
  assert.match(text, /\/onboard\b/);
  assert.match(text, /continue onboarding/i);
});

test("SKILL.md documents the profile id regex", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  // The canonical rule lives in engine/core/profile_loader.js; the
  // skill must restate it so the user sees the constraint.
  assert.match(text, /\^\[a-z\]\[a-z0-9_\]\{1,31\}\$/);
});

test("SKILL.md documents all blocks in order (0/pre-flight + 1..7 + finalize)", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  const blockHeaders = [
    /Pre-flight \(Block 0/,
    /## Block 1 — Identity/,
    /## Block 2 — Career context \+ filters/,
    /## Block 3 — Resume archetypes/,
    /## Block 4 — Cover letter voice/,
    /## Block 5 — Notion/,
    /## Block 6 — Job sources/,
    /## Block 7 — Flags \+ finalize/,
    /## Finalize: run the deploy/,
  ];
  let lastIdx = -1;
  for (const re of blockHeaders) {
    const m = text.match(re);
    assert.ok(m, `missing header matching ${re}`);
    const idx = text.indexOf(m[0]);
    assert.ok(
      idx > lastIdx,
      `block "${m[0]}" appears out of order (expected after position ${lastIdx}, found at ${idx})`
    );
    lastIdx = idx;
  }
});

test("SKILL.md writes intake.md inside the repo, NOT in the user's home", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  // RFC 023 / David #1: file lives at profiles/<id>/intake.md.
  assert.match(text, /profiles\/<id>\/intake\.md/);
  // Make the regression loud: the old "~/intake_filled.md" path is gone.
  assert.doesNotMatch(
    text,
    /~\/intake_filled\.md/,
    "skill must not point at the user's home directory anymore"
  );
});

test("SKILL.md states secrets are never read by the skill", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  // The skill checks presence via grep, not the value.
  assert.match(text, /Never read a token value/i);
  assert.match(text, /grep -q/);
  assert.match(text, /<ID_UPPER>_NOTION_TOKEN/);
  // And the negative — no instruction to paste a token in chat.
  assert.doesNotMatch(
    text,
    /paste (your|the) (notion )?token/i,
    "skill must not ask the user to paste a token in chat"
  );
});

test("SKILL.md is resumable — describes the partial-state recovery flow", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(text, /## Resumability/);
  assert.match(text, /continue onboarding/i);
  // Explicit guarantee that intake.md is written after each block.
  assert.match(text, /write after every block/i);
});

test("SKILL.md describes the finalize-step CLI invocations", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(text, /node scripts\/stage18\/parse_intake\.js/);
  assert.match(text, /node scripts\/stage18\/deploy_profile\.js/);
  assert.match(text, /node engine\/cli\.js scan/);
});

test("SKILL.md handles the existing-profile case (overwrite / resume / cancel)", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(text, /overwrite/i);
  assert.match(text, /resume/i);
  assert.match(text, /cancel/i);
});

test("SKILL.md bans the bulk-template anti-pattern", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  // The old flow was "paste template, fill, paste back" — that's what
  // we're replacing.
  assert.match(text, /## Anti-patterns/);
  assert.match(text, /one question at a time/i);
  assert.match(text, /Bulk-pasting the intake template/i);
});

test("SKILL.md is written in English (no Cyrillic in skill copy)", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  // The skill ships in a public repo and the user-facing text must be
  // English. Cyrillic anywhere is a regression.
  assert.doesNotMatch(text, /[Ѐ-ӿ]/, "Cyrillic found in SKILL.md");
});

// Regression guards for code-review P1s (RFC 023 acceptance pass).
//
// These pin parts of the SKILL.md that must agree with the
// engine/scripts under penalty of crashing onboarding mid-flow.

test("SKILL.md reserved-name list matches scripts/stage18/_common.js", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  // The loader's RESERVED_IDS set is `_example, example, default, test`.
  // If the skill's documented list drifts, users who pick a reserved id
  // sail past the skill's validation only to crash at deploy.
  assert.match(text, /`_example`/, "missing `_example`");
  assert.match(text, /`example`/, "missing `example`");
  assert.match(text, /`default`/, "missing `default`");
  assert.match(text, /`test`/, "missing `test`");
});

test("SKILL.md Block 1 instructs to write profile_id into section A", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  // parse_intake.js's validateIntake requires identity.profile_id;
  // the trigger phrase carries the id but the skill must persist it
  // into section A explicitly.
  assert.match(text, /profile_id:\s*<id>/);
});

test("SKILL.md Block 6 writes env_usajobs_set into section I when usajobs is selected", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  // parse_intake.js BOOL_FIELDS expects env_usajobs_set; the skill must
  // write it (yes/no) so section I is complete.
  assert.match(text, /env_usajobs_set/);
});
