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

test("SKILL.md Step 9 removed (RFC 022 / BL-23) — Notion-page creation owned by engine", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  // RFC 022: SKILL no longer creates Notion pages. Old "9a. Resolve Company"
  // and field tables for Step 9 are gone; engine assembles the payload.
  assert.doesNotMatch(
    text,
    /9a\.\s*Resolve Company relation/,
    "Step 9a body must be removed (engine owns Notion push)"
  );
  // Cover Letter filename invariant (BL-14) now belongs to the engine contract;
  // SKILL just needs to keep clKey + .pdf naming consistent in results.json
  // — there's still at least one .pdf reference in the file for that.
  assert.match(text, /\.pdf/);
  // Make the migration loud — Step 9 stub mentions RFC 022.
  assert.match(text, /RFC 022/);
});

test("SKILL.md Step 10 results schema example includes clParagraphs (BL-14)", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(text, /"clParagraphs"\s*:\s*\[/);
  // And drops `clPath` from the to_apply example — engine derives it now.
  // (The old line `"clPath": "<company>_<role-slug>_<YYYYMMDD>.md"` must be gone.)
  assert.doesNotMatch(text, /"clPath"\s*:\s*"<company>_<role-slug>_<YYYYMMDD>\.md"/);
});

// RFC 034 (BL-80) — SKILL output contract: no `decision`, no `skipReason`.
//
// These structural assertions catch accidental regressions in the prose +
// example JSON in SKILL.md. The engine ignores legacy `decision` with a
// back-compat warning, but the SKILL must NOT instruct the model to emit it.

test("SKILL.md (RFC 034): no `decision` field in any output JSON example", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  // Catches both `"decision": "to_apply"` and `decision: "to_apply"` (JSON
  // examples vs prose / pseudocode). The word "decision" still appears in
  // explanatory text (e.g. "geo decision", "RFC 034 removed `decision`"),
  // so we scope this assertion to the schema-style usage.
  assert.doesNotMatch(
    text,
    /"decision"\s*:\s*"[^"]*"/,
    "SKILL.md must not show `decision` as an output JSON field (RFC 034)"
  );
  assert.doesNotMatch(
    text,
    /\bdecision\s*=\s*"to_apply"/,
    "SKILL.md must not show `decision = \"to_apply\"` in pseudocode (RFC 034)"
  );
  assert.doesNotMatch(
    text,
    /\bdecision\s*=\s*"skip"/,
    "SKILL.md must not show `decision = \"skip\"` in pseudocode (RFC 034)"
  );
  assert.doesNotMatch(
    text,
    /\bdecision\s*=\s*"archive"/,
    "SKILL.md must not show `decision = \"archive\"` in pseudocode (RFC 034)"
  );
});

test("SKILL.md (RFC 034): no `skipReason` field in any output JSON example", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  assert.doesNotMatch(
    text,
    /"skipReason"\s*:\s*"[^"]*"/,
    "SKILL.md must not show `skipReason` as an output field (RFC 034)"
  );
});

test("SKILL.md (RFC 034): explicit anti-pattern note tells the model not to emit `decision`", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  // The anti-pattern list calls this out explicitly so a future drift is
  // caught at review time rather than at the first phantom-Weak bug.
  assert.match(
    text,
    /Do not.*emit.*decision/i,
    "anti-patterns must explicitly tell the model not to emit `decision`"
  );
});

test("SKILL.md (RFC 034): weak-fallback mode is gone from the prepare loop prose", () => {
  const text = fs.readFileSync(SKILL_PATH, "utf8");
  // The flag is referenced in the migration callout ("RFC 034 removed
  // `--mode weak-fallback`") but no longer appears as an operational step.
  // The check: the mode-table only lists `fresh` and `topup`, and Step 6/7
  // (the autonomous loop) doesn't invoke `--mode weak-fallback`.
  assert.doesNotMatch(
    text,
    /Run:\s*prepare\s+--phase\s+pre\s+--mode\s+weak-fallback/,
    "autonomous loop must not invoke --mode weak-fallback (RFC 034)"
  );
  assert.doesNotMatch(
    text,
    /node\s+engine\/cli\.js\s+prepare\s+--profile\s+<id>\s+--phase\s+pre\s+--mode\s+<fresh\|topup\|weak-fallback>/,
    "CLI command line must not list weak-fallback as a valid --mode (RFC 034)"
  );
});
