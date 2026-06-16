"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildContent, ensureFresh, checkFreshness } = require("./fit_profile");

const STORYBANK_MD = `# Coaching State

## Storybank
| ID   | Title                            | Primary Skill        | Secondary Skill | Commercial Profile | Earned Secret | Strength  | Use Count | Last Used |
|------|----------------------------------|----------------------|-----------------|--------------------|----------------|-----------|-----------|-----------|
| S001 | Acme — checkout funnel (+18% CR) | Funnel / experiments | Team leadership | B2C marketplace    | Secret one.    | seed      | 0         | —         |
| S002 | Acme — pricing rework (3x rev)   | Pricing              | Competitive     | B2C startup        | Secret two.    | confirmed | 0         | —         |

### Story Details

#### S001 — Acme: checkout funnel

| 🇷🇺 | 🇬🇧 |
|----|----|
| **Result.** +18%. | **Result.** **+18% end-to-end funnel CR.** |

- **Deploy for.** Funnel / growth, team leadership.
`;

function makeProfileDir(md) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fitprof-"));
  const dir = path.join(root, "profiles", "acme");
  fs.mkdirSync(path.join(dir, "interview-coach-state"), { recursive: true });
  if (md != null) {
    fs.writeFileSync(path.join(dir, "interview-coach-state", "coaching_state.md"), md, "utf8");
  }
  return dir;
}

test("buildContent: returns content + hash + stories for a real storybank", () => {
  const dir = makeProfileDir(STORYBANK_MD);
  const built = buildContent(dir, "acme");
  assert.ok(built);
  assert.equal(built.stories.length, 2);
  assert.match(built.content, /## S001 — Acme — checkout funnel/);
  assert.match(built.hash, /^[0-9a-f]{12}$/);
});

test("buildContent: null when coaching_state is absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fitprof-"));
  assert.equal(buildContent(path.join(root, "profiles", "ghost"), "ghost"), null);
});

test("buildContent: null when storybank is empty", () => {
  const dir = makeProfileDir("# Coaching State\n\n## Profile\nno bank\n");
  assert.equal(buildContent(dir, "acme"), null);
});

test("ensureFresh: creates the artifact when missing", () => {
  const dir = makeProfileDir(STORYBANK_MD);
  const res = ensureFresh(dir, "acme");
  assert.equal(res.regenerated, true);
  assert.equal(res.reason, "created");
  assert.ok(fs.existsSync(path.join(dir, "fit_profile.md")));
});

test("ensureFresh: no-op when artifact already matches the bank", () => {
  const dir = makeProfileDir(STORYBANK_MD);
  ensureFresh(dir, "acme");
  const res = ensureFresh(dir, "acme");
  assert.equal(res.regenerated, false);
  assert.equal(res.reason, "fresh");
});

test("ensureFresh: rewrites a stale artifact", () => {
  const dir = makeProfileDir(STORYBANK_MD);
  fs.writeFileSync(path.join(dir, "fit_profile.md"), "old garbage\n", "utf8");
  const res = ensureFresh(dir, "acme");
  assert.equal(res.regenerated, true);
  assert.equal(res.reason, "stale");
  assert.match(fs.readFileSync(path.join(dir, "fit_profile.md"), "utf8"), /## S001/);
});

test("ensureFresh: dryRun computes content but does not write", () => {
  const dir = makeProfileDir(STORYBANK_MD);
  const res = ensureFresh(dir, "acme", { dryRun: true });
  assert.match(res.content, /## S001/);
  assert.equal(res.regenerated, false);
  assert.equal(fs.existsSync(path.join(dir, "fit_profile.md")), false);
});

test("ensureFresh: no storybank → returns existing artifact untouched", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fitprof-"));
  const dir = path.join(root, "profiles", "acme");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "fit_profile.md"), "kept\n", "utf8");
  const res = ensureFresh(dir, "acme");
  assert.equal(res.reason, "no-storybank");
  assert.equal(res.content, "kept\n");
  assert.equal(fs.readFileSync(path.join(dir, "fit_profile.md"), "utf8"), "kept\n");
});

test("checkFreshness: ok when artifact is in sync", () => {
  const dir = makeProfileDir(STORYBANK_MD);
  ensureFresh(dir, "acme");
  const res = checkFreshness(dir, "acme");
  assert.equal(res.applicable, true);
  assert.equal(res.ok, true);
  assert.deepEqual(res.issues, []);
});

test("checkFreshness: flags a missing artifact", () => {
  const dir = makeProfileDir(STORYBANK_MD);
  const res = checkFreshness(dir, "acme");
  assert.equal(res.ok, false);
  assert.match(res.issues[0], /missing/);
});

test("checkFreshness: flags a stale artifact (edited metric)", () => {
  const dir = makeProfileDir(STORYBANK_MD);
  ensureFresh(dir, "acme");
  // Bank changes but nobody regenerated the digest.
  const changed = STORYBANK_MD.replace("+18% end-to-end funnel CR.", "+25% end-to-end funnel CR.");
  fs.writeFileSync(path.join(dir, "interview-coach-state", "coaching_state.md"), changed, "utf8");
  const res = checkFreshness(dir, "acme");
  assert.equal(res.ok, false);
  assert.match(res.issues[0], /stale/);
});

test("checkFreshness: names a missing storybank row specifically", () => {
  const dir = makeProfileDir(STORYBANK_MD);
  ensureFresh(dir, "acme");
  // Add a third story to the bank without regenerating.
  const withNew = STORYBANK_MD.replace(
    "| S002 | Acme — pricing rework (3x rev)   | Pricing              | Competitive     | B2C startup        | Secret two.    | confirmed | 0         | —         |",
    "| S002 | Acme — pricing rework (3x rev)   | Pricing              | Competitive     | B2C startup        | Secret two.    | confirmed | 0         | —         |\n| S003 | Acme — new bet                   | Growth               | Analytics       | B2C startup        | Secret three.  | seed      | 0         | —         |"
  );
  fs.writeFileSync(path.join(dir, "interview-coach-state", "coaching_state.md"), withNew, "utf8");
  const res = checkFreshness(dir, "acme");
  assert.equal(res.ok, false);
  assert.match(res.issues[0], /S003/);
});

test("checkFreshness: not applicable when profile has no storybank", () => {
  const dir = makeProfileDir("# Coaching State\n\n## Profile\nno bank\n");
  const res = checkFreshness(dir, "acme");
  assert.equal(res.applicable, false);
  assert.equal(res.ok, true);
});
