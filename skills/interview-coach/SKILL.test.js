// Smoke test for the interview-coach skill manifest.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SKILL_PATH = path.resolve(__dirname, "SKILL.md");
const PREP_PATH = path.resolve(__dirname, "references/commands/prep.md");
const CONVENTIONS_PATH = path.resolve(__dirname, "references/conventions.md");

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

// RFC 064 — prep opens with a mandatory 8-step company + role research screen
// whose output IS the konspekt 📖 A–H front-matter (no separate file). These
// assertions lock the doc contract so a future edit can't silently drop a step,
// re-introduce depth-scaling, or split the dossier into a parallel artifact.

test("prep.md documents all 8 research-screen step titles (RFC 064)", () => {
  const text = fs.readFileSync(PREP_PATH, "utf8");
  for (const step of [
    "Pull JD from the primary source",
    "Requirements + anti-requirements",
    "Business model",
    "Reputation recheck",
    "People",
    "Fit map",
    "Culture layer",
    "Comp / benefits",
  ]) {
    assert.match(text, new RegExp(step.replace(/[+/]/g, "\\$&")), `missing step: ${step}`);
  }
});

test("prep.md keeps Company Knowledge Sourcing as the per-claim verified/unverified gate (RFC 064)", () => {
  const text = fs.readFileSync(PREP_PATH, "utf8");
  assert.match(text, /Tier 1 — Verified/i, "Tier 1 verified must survive");
  assert.match(text, /Tier 3 — Unknown/i, "Tier 3 unknown must survive");
  // anti-requirement extraction is the load-bearing addition.
  assert.match(text, /anti-requirements/i, "must require anti-requirement extraction");
  // the tiering must be wired to the 8 steps, not left as an isolated aside.
  assert.match(text, /per-claim gate for every one of the 8 research steps/i);
});

test("prep.md Output Schema carries the 📖 A–H front-matter AND the unchanged 🗣️ speech sections (RFC 064)", () => {
  const text = fs.readFileSync(PREP_PATH, "utf8");
  assert.match(text, /## 📖 A\. Компания за 60 секунд/, "front-matter A missing");
  assert.match(text, /## ⚠️ E\. Риски и landmines/, "risks/landmines section missing");
  assert.match(text, /## 📖 H\. Комп и бенефиты/, "comp section missing");
  // Sections stay numbered 5–10 so the §9-plan and §10-cheat-sheet anchor
  // links (which point at §5–§8 and at §9/§10 themselves) don't break.
  assert.match(text, /## 🗣️ 5\. Твоё позиционирование/, "speech §5 must be unchanged");
  assert.match(text, /## 🗣️ 6\. Вероятные вопросы и истории/, "speech §6 must be unchanged");
  assert.match(text, /## 📖 9\. План на оставшиеся часы/, "plan §9 must be unchanged");
  assert.match(text, /## 🗣️ 10\. Day-of cheat sheet/, "cheat-sheet §10 must be unchanged");
});

test("prep.md forbids depth-scaling — all 8 steps always run at full depth (RFC 064)", () => {
  const text = fs.readFileSync(PREP_PATH, "utf8");
  assert.match(
    text,
    /All 8 steps always\s*\n?\s*run at full depth/i,
    "must state all 8 steps always run at full depth"
  );
});

test("no separate company-screen.md artifact is introduced — dossier lives in the konspekt (RFC 064)", () => {
  const prep = fs.readFileSync(PREP_PATH, "utf8");
  const skill = fs.readFileSync(SKILL_PATH, "utf8");
  assert.doesNotMatch(
    prep,
    /company-screen\.md/,
    "prep.md must not reference a separate dossier file"
  );
  assert.doesNotMatch(
    skill,
    /company-screen\.md/,
    "SKILL.md must not reference a separate dossier file"
  );
});

test("conventions.md rule 1c two-column konspekt table is untouched (RFC 064 non-goal)", () => {
  const text = fs.readFileSync(CONVENTIONS_PATH, "utf8");
  assert.match(
    text,
    /\| 🇷🇺 Говоришь так \| 🇬🇧 English \|/,
    "rule 1c two-column table must survive"
  );
});
