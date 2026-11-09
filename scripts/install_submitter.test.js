// install_submitter.sh — only the dry run is exercised: it prints the plist
// and the launchctl commands and must not write anything or call launchctl.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SOURCE = path.join(__dirname, "install_submitter.sh");

function git(cwd, args) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

// A throwaway main checkout holding a copy of the script and (optionally)
// profiles/demo/profile.json — the installer refuses anything else.
function makeRepo({ profile = true } = {}) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aijs-repo-")));
  git(repo, ["init", "-q"]);
  fs.mkdirSync(path.join(repo, "scripts"));
  fs.copyFileSync(SOURCE, path.join(repo, "scripts", "install_submitter.sh"));
  if (profile) {
    fs.mkdirSync(path.join(repo, "profiles", "demo"), { recursive: true });
    fs.writeFileSync(path.join(repo, "profiles", "demo", "profile.json"), "{}");
  }
  return repo;
}

const REPO = makeRepo();
const SCRIPT = path.join(REPO, "scripts", "install_submitter.sh");

function run(args, script = SCRIPT) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aijs-installer-"));
  const res = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  return { ...res, home };
}

test("install refuses outside the main checkout (a git worktree)", () => {
  const repo = makeRepo();
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const wt = path.join(fs.realpathSync(os.tmpdir()), `aijs-wt-${process.pid}-${Date.now()}`);
  git(repo, ["worktree", "add", "-q", wt]);
  fs.mkdirSync(path.join(wt, "profiles", "demo"), { recursive: true });
  fs.writeFileSync(path.join(wt, "profiles", "demo", "profile.json"), "{}");
  const r = run(
    ["--profile", "demo", "--dry-run"],
    path.join(wt, "scripts", "install_submitter.sh")
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /main checkout/);
  assert.deepEqual(fs.readdirSync(r.home), []);
});

test("install refuses when profiles/<id>/profile.json is missing", () => {
  const repo = makeRepo({ profile: false });
  const r = run(
    ["--profile", "demo", "--dry-run"],
    path.join(repo, "scripts", "install_submitter.sh")
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /profile\.json missing/);
});

test("--dry-run prints the LaunchAgent plist and writes nothing", () => {
  const r = run(["--profile", "demo", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  const user = os.userInfo().username;
  const label = `com.${user}.ai-job-searcher.submit-demo`;
  assert.match(r.stdout, new RegExp(`<string>${label.replace(/\./g, "\\.")}</string>`));
  assert.match(r.stdout, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/);
  assert.match(
    r.stdout,
    /<string>submit-ready<\/string>\s*<string>--profile<\/string>\s*<string>demo<\/string>/
  );
  assert.ok(r.stdout.includes(`<string>${path.join(REPO, "engine", "cli.js")}</string>`));
  assert.ok(r.stdout.includes(`<key>WorkingDirectory</key>\n  <string>${REPO}</string>`));
  const node = spawnSync("bash", ["-c", "command -v node"], { encoding: "utf8" }).stdout.trim();
  assert.ok(r.stdout.includes(`<string>${node}</string>`), "absolute node path");
  assert.ok(
    r.stdout.includes(path.join(r.home, "Library", "Logs", "ai-job-searcher", "submit-demo.log"))
  );
  assert.ok(
    r.stdout.includes(`plist: ${path.join(r.home, "Library", "LaunchAgents", `${label}.plist`)}`)
  );
  assert.match(r.stdout, /would run: launchctl bootstrap gui\/\d+ /);
  assert.deepEqual(fs.readdirSync(r.home), [], "nothing written under HOME");
});

test("--uninstall --dry-run prints bootout + rm only", () => {
  const r = run(["--profile", "demo", "--uninstall", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /would run: launchctl bootout gui\/\d+\/com\..+\.ai-job-searcher\.submit-demo/
  );
  assert.match(r.stdout, /would run: rm -f .*submit-demo\.plist/);
  assert.deepEqual(fs.readdirSync(r.home), []);
});

test("profile id is required and validated", () => {
  assert.equal(run(["--dry-run"]).status, 2);
  const bad = run(["--profile", "../etc", "--dry-run"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /invalid profile id/);
  assert.equal(run(["--profile", "demo", "--bogus"]).status, 2);
});
