// Cross-process file lock (BL-225 review): one writer at a time for a file
// that several processes read-modify-write (applications.tsv, companies.tsv).
//
//   withFileLock(lockPath, fn, opts) → result of fn()
//
// The lock is a file created atomically (a fully written temp file
// hard-linked into place, so a reader never sees it half-written) holding
// { pid, host, acquired_at }. A held lock is only ever broken when its holder
// is gone: same host and the pid is not alive (or the content is unreadable
// and old). A live holder is never robbed, however long it holds the lock —
// the caller waits and, after `timeoutMs`, gets an error instead.
//
// Breaking a stale lock goes through a short-lived "<lock>.break" guard, so
// two waiters that both saw the dead holder cannot remove each other's fresh
// lock. In one process, calls on the same path are serialized first (an
// async chain per path), so concurrent async writers in one process queue up
// instead of all spinning on the file. Nested calls on the same path from
// inside fn would deadlock — do not nest.

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_POLL_MS = 50;
// A lock file without a readable pid is treated as stale only after this.
const UNREADABLE_STALE_MS = 60 * 1000;
// The break guard is held for milliseconds; older means its holder died.
const BREAK_STALE_MS = 30 * 1000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else — alive.
    return err.code === "EPERM";
  }
}

function readHolder(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return { raw, holder: parsed };
    // Older lock files hold the bare pid.
    if (Number.isInteger(parsed)) return { raw, holder: { pid: parsed } };
    return { raw, holder: null };
  } catch (err) {
    if (err.code === "ENOENT") return null;
    return { raw: "", holder: null };
  }
}

function ageMs(p) {
  try {
    return Date.now() - fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// Atomic create: write a temp file, hard-link it to `target` (fails with
// EEXIST when the target exists), remove the temp file.
function createAtomic(target, body) {
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  try {
    fs.linkSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Is the lock described by `info` held by nobody? `heldHere` — this process
// holds that path right now (then a matching pid is really us).
function isStale(info, lockPath, { heldHere, isAlive }) {
  if (!info) return false;
  const h = info.holder;
  if (!h || !Number.isInteger(h.pid)) return ageMs(lockPath) > UNREADABLE_STALE_MS;
  if (h.host && h.host !== os.hostname()) return false; // cannot see that pid
  if (h.pid === process.pid) return !heldHere; // a leftover of an earlier us
  return !isAlive(h.pid);
}

function tryBreak(lockPath, staleRaw) {
  const guard = `${lockPath}.break`;
  try {
    createAtomic(guard, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    if (ageMs(guard) > BREAK_STALE_MS) fs.rmSync(guard, { force: true });
    return false;
  }
  try {
    const now = readHolder(lockPath);
    // Only the exact stale lock we saw is removed — never a fresh one.
    if (now && now.raw === staleRaw) fs.rmSync(lockPath, { force: true });
    return true;
  } finally {
    fs.rmSync(guard, { force: true });
  }
}

const chains = new Map(); // lockPath → tail promise of this process's queue
const heldPaths = new Set();

async function acquire(lockPath, opts) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs || DEFAULT_POLL_MS;
  const isAlive = opts.pidAlive || pidAlive;
  const started = Date.now();
  const body = JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    acquired_at: new Date().toISOString(),
  });
  for (;;) {
    try {
      createAtomic(lockPath, body);
      return body;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    const info = readHolder(lockPath);
    if (!info) continue; // released between our attempt and the read
    if (isStale(info, lockPath, { heldHere: heldPaths.has(lockPath), isAlive })) {
      tryBreak(lockPath, info.raw);
      continue;
    }
    if (Date.now() - started > timeoutMs) {
      const who = info.holder && info.holder.pid ? ` by pid ${info.holder.pid}` : "";
      throw new Error(`${path.basename(lockPath)} is locked${who} (${lockPath})`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function release(lockPath, body) {
  const info = readHolder(lockPath);
  if (info && info.raw === body) fs.rmSync(lockPath, { force: true });
}

async function withFileLock(lockPath, fn, opts = {}) {
  const prev = chains.get(lockPath) || Promise.resolve();
  let done;
  const mine = new Promise((r) => (done = r));
  const tail = prev.then(() => mine);
  chains.set(lockPath, tail);
  await prev;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const body = await acquire(lockPath, opts);
    heldPaths.add(lockPath);
    try {
      return await fn();
    } finally {
      heldPaths.delete(lockPath);
      release(lockPath, body);
    }
  } finally {
    done();
    if (chains.get(lockPath) === tail) chains.delete(lockPath);
  }
}

module.exports = { withFileLock, pidAlive, createAtomic, isStale };
