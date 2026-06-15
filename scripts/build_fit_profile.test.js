// Smoke + unit tests for scripts/build_fit_profile.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { main } = require("./build_fit_profile.js");

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

## Score History
ignore me
`;

function makeProfile(root, id, md) {
  const dir = path.join(root, "profiles", id, "interview-coach-state");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "coaching_state.md"), md, "utf8");
}

test("build_fit_profile: writes fit_profile.md from the storybank", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bfp-"));
  makeProfile(tmpRoot, "acme", STORYBANK_MD);

  const exit = main(["--profile", "acme", "--root", tmpRoot]);
  assert.equal(exit, 0);

  const out = fs.readFileSync(path.join(tmpRoot, "profiles", "acme", "fit_profile.md"), "utf8");
  assert.match(out, /## S001 — Acme — checkout funnel \(\+18% CR\)/);
  assert.match(out, /- Outcome: \+18% end-to-end funnel CR\./);
  assert.match(out, /<!-- stories: 2 -->/);
});

test("build_fit_profile: idempotent — two runs are byte-identical", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bfp-"));
  makeProfile(tmpRoot, "acme", STORYBANK_MD);
  const outPath = path.join(tmpRoot, "profiles", "acme", "fit_profile.md");

  main(["--profile", "acme", "--root", tmpRoot]);
  const first = fs.readFileSync(outPath, "utf8");
  main(["--profile", "acme", "--root", tmpRoot]);
  const second = fs.readFileSync(outPath, "utf8");
  assert.equal(first, second);
});

test("build_fit_profile: missing --profile returns 1", () => {
  assert.equal(main([]), 1);
});

test("build_fit_profile: missing coaching_state returns 1", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bfp-"));
  assert.equal(main(["--profile", "ghost", "--root", tmpRoot]), 1);
});

test("build_fit_profile: empty storybank returns 1 (no fit basis)", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bfp-"));
  makeProfile(tmpRoot, "empty", "# Coaching State\n\n## Profile\nno bank here\n");
  assert.equal(main(["--profile", "empty", "--root", tmpRoot]), 1);
});
