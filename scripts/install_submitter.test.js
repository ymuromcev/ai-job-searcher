// install_submitter.sh — only the dry run is exercised: it prints the plist
// and the launchctl commands and must not write anything or call launchctl.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.join(__dirname, "install_submitter.sh");
const REPO = fs.realpathSync(path.join(__dirname, ".."));

function run(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aijs-installer-"));
  const res = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  return { ...res, home };
}

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
