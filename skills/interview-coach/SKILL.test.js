// Smoke test for the interview-coach skill manifest.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SKILL_PATH = path.resolve(__dirname, "SKILL.md");
const PREP_PATH = path.resolve(__dirname, "references/commands/prep.md");
const CONVENTIONS_PATH = path.resolve(__dirname, "references/conventions.md");
const SKELETON_PATH = path.resolve(__dirname, "references/konspekt-skeleton.md");
const DECISIONS_PATH = path.resolve(__dirname, "references/decisions-log.md");

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

// RFC 064 — prep opens with a mandatory 8-step company + role research screen.
// These assertions lock the doc contract so a future edit can't silently drop a
// step, re-introduce depth-scaling, or split the dossier into a parallel artifact.

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

test("prep.md forbids depth-scaling — all 8 steps always run at full depth (RFC 064)", () => {
  const text = fs.readFileSync(PREP_PATH, "utf8");
  assert.match(
    text,
    /All 8 steps always\s*\n?\s*run at full depth/i,
    "must state all 8 steps always run at full depth"
  );
});

test("no separate company-screen.md artifact is introduced — research feeds the konspekt", () => {
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

// The konspekt format lives in exactly one file. It used to be described in
// prep.md § Output Schema, in conventions rule 28 and again in rule 28a — the
// three drifted apart and a dead schema was followed for two rounds.

test("konspekt-skeleton.md is the single description of the konspekt format", () => {
  assert.ok(fs.existsSync(SKELETON_PATH), "konspekt-skeleton.md missing");
  const text = fs.readFileSync(SKELETON_PATH, "utf8");
  for (const section of [
    "📖 Что это за звонок",
    "📖 Кто интервьюер",
    "📖 Справка по компании",
    "📖 Чего мы не знаем",
    "🗣️ Вводные вопросы",
    "🗣️ Истории",
    "🗣️ Бюрократия",
    "📖 Ловушки",
  ]) {
    assert.ok(text.includes(section), `skeleton must carry section: ${section}`);
  }
  // the story block is transcluded through the block anchor, never rewritten
  assert.match(text, /!\[\[coaching_state#\^say-s0nn\]\]/, "story transclusion anchor missing");
  assert.match(text, /Закрывает требования/, "requirement list missing from the story block");
  assert.match(text, /Годится на вопросы/, "question list missing from the story block");
});

test("prep.md no longer describes the konspekt document — it points at the skeleton", () => {
  const text = fs.readFileSync(PREP_PATH, "utf8");
  assert.match(
    text,
    /references\/konspekt-skeleton\.md/,
    "prep.md must point at the skeleton for the deliverable"
  );
  // the dead A–H / 5–10 schema must not come back
  for (const dead of [
    "📖 A. Компания за 60 секунд",
    "⚠️ E. Риски и landmines",
    "📖 H. Комп и бенефиты",
    "🗣️ 5. Твоё позиционирование",
    "🗣️ 10. Day-of cheat sheet",
  ]) {
    assert.ok(!text.includes(dead), `dead schema section resurfaced in prep.md: ${dead}`);
  }
});

test("prep.md keeps the time-to-interview modes SKILL.md depends on", () => {
  const prep = fs.readFileSync(PREP_PATH, "utf8");
  const skill = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(prep, /triage/i, "triage mode must survive the Output Schema removal");
  assert.match(prep, /focused/i, "focused mode must survive");
  assert.match(prep, /< 24h/, "the <24h threshold must survive");
  assert.match(skill, /triage \/ focused \/ full/i, "SKILL.md still names the three modes");
});

// conventions.md is the spec; decisions-log.md is the history. Neither should
// grow back into the other.

test("conventions.md keeps the original rule numbers findable as aliases", () => {
  const text = fs.readFileSync(CONVENTIONS_PATH, "utf8");
  for (const alias of ["· 1", "· 1b", "· 1c", "· 1d", "· 1e", "· 1f", "· 1g"]) {
    assert.ok(text.includes(alias), `alias missing from a rule heading: ${alias}`);
  }
  for (const alias of ["| 17 |", "| 22 |", "| 28 (структура) |", "| 28 (storybank) |"]) {
    assert.ok(text.includes(alias), `alias missing from the index table: ${alias}`);
  }
});

test("conventions.md does not restate the konspekt skeleton", () => {
  const text = fs.readFileSync(CONVENTIONS_PATH, "utf8");
  assert.ok(
    !text.includes("Скелет документа целиком"),
    "the document skeleton must live only in konspekt-skeleton.md"
  );
  assert.match(text, /konspekt-skeleton\.md/, "conventions must link to the skeleton");
});

test("conventions.md rule 1c two-column konspekt table is untouched (RFC 064 non-goal)", () => {
  const text = fs.readFileSync(CONVENTIONS_PATH, "utf8");
  assert.match(
    text,
    /\| 🇷🇺 Говоришь так \| 🇬🇧 English \|/,
    "rule 1c two-column table must survive"
  );
});

test("decisions-log.md holds the history the rules no longer carry", () => {
  assert.ok(fs.existsSync(DECISIONS_PATH), "decisions-log.md missing");
  const text = fs.readFileSync(DECISIONS_PATH, "utf8");
  for (const date of [
    "2026-05-14",
    "2026-06-16",
    "2026-07-24",
    "2026-07-28",
    "2026-08-02",
    "2026-08-04",
  ]) {
    assert.ok(text.includes(date), `decision date lost: ${date}`);
  }
  assert.match(text, /conventions\.md/, "log must link back to the spec");
});

test("every rule in conventions.md links to its entry in the decisions log", () => {
  const text = fs.readFileSync(CONVENTIONS_PATH, "utf8");
  const rules = text.match(/^### .+ · .+$/gm) || [];
  const backlinks = text.match(/^↩ История: `decisions-log\.md` § .+$/gm) || [];
  assert.ok(rules.length >= 30, `expected the full rule set, found ${rules.length}`);
  assert.equal(backlinks.length, rules.length, "every rule needs exactly one history backlink");
});
