// core/file_lock.js — real temp files; a child process holds the lock for
// the cross-process case. No network.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { withFileLock, pidAlive } = require("./file_lock.js");

function tmpLock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-"));
  return path.join(dir, "applications.tsv.lock");
}

test("in one process: writers on the same path run one at a time", async () => {
  const lock = tmpLock();
  const order = [];
  await Promise.all([
    withFileLock(lock, async () => {
      order.push("a-in");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-out");
    }),
    withFileLock(lock, async () => {
      order.push("b-in");
      order.push("b-out");
    }),
  ]);
  assert.deepEqual(order, ["a-in", "a-out", "b-in", "b-out"]);
  assert.equal(fs.existsSync(lock), false, "released");
});

test("a lock held by a live pid is never taken, however old", async () => {
  const lock = tmpLock();
  const holder = { pid: process.ppid, host: os.hostname(), acquired_at: "2020-01-01T00:00:00Z" };
  fs.writeFileSync(lock, JSON.stringify(holder));
  const old = new Date(Date.now() - 24 * 3600 * 1000);
  fs.utimesSync(lock, old, old);
  assert.equal(pidAlive(process.ppid), true);
  await assert.rejects(
    withFileLock(lock, async () => "ran", { timeoutMs: 150, pollMs: 20 }),
    /locked by pid/
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, "utf8")), holder, "left untouched");
});

test("a lock whose pid is gone is broken and taken", async () => {
  const lock = tmpLock();
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, host: os.hostname() }));
  const ran = await withFileLock(lock, async () => "ran", {
    pidAlive: (pid) => pid !== 999999,
    timeoutMs: 1000,
  });
  assert.equal(ran, "ran");
  assert.equal(fs.existsSync(lock), false);
});

test("another process holding the lock makes this one wait until it is released", async () => {
  const lock = tmpLock();
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const { withFileLock } = require(${JSON.stringify(path.join(__dirname, "file_lock.js"))});
       withFileLock(${JSON.stringify(lock)}, async () => {
         process.stdout.write("held\\n");
         await new Promise((r) => setTimeout(r, 300));
       });`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => child.stdout.once("data", resolve));
  const started = Date.now();
  await withFileLock(lock, async () => {}, { timeoutMs: 5000 });
  assert.ok(Date.now() - started >= 150, "waited for the other process");
  await exited;
});
