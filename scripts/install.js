#!/usr/bin/env node
/**
 * install — bootstrap the ai-job-searcher tool for a fresh Claude Code user.
 *
 * Invocation (the canonical path documented in README):
 *   npx -y github:ymuromcev/ai-job-searcher install
 *
 * What it does (RFC 048):
 *   1. Preflight: Node ≥ 20, platform is darwin or linux.
 *   2. Detect existing install at ~/.ai-job-searcher/. Update if it's
 *      our clone; refuse if it's something else.
 *   3. Fresh install: git clone, npm install, npm test.
 *   4. Symlink each skill in skills/<name>/ to ~/.claude/skills/<name>/,
 *      backing up any existing entry at <name>.backup-<timestamp>/.
 *   5. Copy .env.example to .env if .env doesn't exist.
 *   6. Print restart-required message.
 *
 * Pure planning logic lives in plan*() functions; execute*() do the
 * side effects. Tests mock fs / child_process via the ctx parameter.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_URL = "https://github.com/ymuromcev/ai-job-searcher.git";
const INSTALL_DIR_NAME = ".ai-job-searcher";
const CLAUDE_SKILLS_DIR_NAME = path.join(".claude", "skills");
const SKILLS_TO_LINK = ["onboard-profile", "job-pipeline", "interview-coach"];
const MIN_NODE_MAJOR = 20;

// --- preflight (pure) -------------------------------------------------------

function checkPreflight({ nodeVersion, platform }) {
  const m = /^v?(\d+)\./.exec(nodeVersion || "");
  if (!m) {
    return { ok: false, message: `Could not parse Node version: ${nodeVersion}` };
  }
  const major = Number(m[1]);
  if (major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      message:
        `Need Node ${MIN_NODE_MAJOR}+. You have ${nodeVersion}. ` +
        `Get a newer version at https://nodejs.org. Then rerun this command.`,
    };
  }
  if (platform !== "darwin" && platform !== "linux") {
    return {
      ok: false,
      message: `Platform ${platform} is not supported. Use macOS or Linux.`,
    };
  }
  return { ok: true };
}

// --- detect existing install (pure given an fs-like ctx) -------------------

function detectInstallState({ installPath, fsCtx, execCtx }) {
  if (!fsCtx.existsSync(installPath)) {
    return { state: "fresh" };
  }
  const gitDir = path.join(installPath, ".git");
  if (!fsCtx.existsSync(gitDir)) {
    return {
      state: "conflict",
      message:
        `${installPath} already exists and is not a git clone. ` + `Move or rename it, then rerun.`,
    };
  }
  let remote;
  try {
    remote = execCtx.run("git", ["-C", installPath, "remote", "get-url", "origin"]).trim();
  } catch {
    return {
      state: "conflict",
      message:
        `${installPath} exists but has no 'origin' remote. ` + `Move or rename it, then rerun.`,
    };
  }
  if (!isOurRemote(remote)) {
    return {
      state: "conflict",
      message:
        `${installPath} is a clone of ${remote}, not ai-job-searcher. ` +
        `Move or rename it, then rerun.`,
    };
  }
  return { state: "update" };
}

function isOurRemote(remoteUrl) {
  if (!remoteUrl) return false;
  const normalized = remoteUrl
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  return (
    normalized.endsWith("ymuromcev/ai-job-searcher") ||
    normalized.endsWith(":ymuromcev/ai-job-searcher")
  );
}

// --- plan skill symlinks (pure given fsCtx) --------------------------------

function planSkillLink({ name, installPath, claudeSkillsPath, fsCtx, now }) {
  const source = path.join(installPath, "skills", name);
  const target = path.join(claudeSkillsPath, name);

  if (!fsCtx.existsSync(source)) {
    return { name, source, target, action: "missing-source" };
  }

  if (!fsCtx.lstatExistsSync(target)) {
    return { name, source, target, action: "create" };
  }

  const stat = fsCtx.lstatSync(target);
  if (stat.isSymbolicLink()) {
    const current = fsCtx.readlinkSync(target);
    if (path.resolve(claudeSkillsPath, current) === path.resolve(source)) {
      return { name, source, target, action: "noop" };
    }
  }

  // Pick a backup path that doesn't already exist (defensive against a
  // re-run within the same second or a leftover from a previous install).
  const base = `${target}.backup-${formatTimestamp(now)}`;
  let backupPath = base;
  let suffix = 1;
  while (fsCtx.lstatExistsSync(backupPath)) {
    backupPath = `${base}-${suffix}`;
    suffix += 1;
  }
  return { name, source, target, action: "backup-then-create", backupPath };
}

function formatTimestamp(date) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}` +
    `-${pad(date.getUTCMilliseconds(), 3)}`
  );
}

// --- cwd detection (pure) --------------------------------------------------

function detectCwdIsClone({ cwd, fsCtx, execCtx, installPath }) {
  if (path.resolve(cwd) === path.resolve(installPath)) {
    return { isClone: false };
  }
  const gitDir = path.join(cwd, ".git");
  if (!fsCtx.existsSync(gitDir)) {
    return { isClone: false };
  }
  let remote;
  try {
    remote = execCtx.run("git", ["-C", cwd, "remote", "get-url", "origin"]).trim();
  } catch {
    return { isClone: false };
  }
  if (isOurRemote(remote)) {
    return { isClone: true, cwd };
  }
  return { isClone: false };
}

// --- execute (side effects) -------------------------------------------------

function makeRealCtx() {
  return {
    fs: {
      existsSync: (p) => fs.existsSync(p),
      lstatExistsSync: (p) => {
        try {
          fs.lstatSync(p);
          return true;
        } catch {
          return false;
        }
      },
      lstatSync: (p) => fs.lstatSync(p),
      readlinkSync: (p) => fs.readlinkSync(p),
      mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
      renameSync: (a, b) => fs.renameSync(a, b),
      symlinkSync: (target, link, type) => fs.symlinkSync(target, link, type),
      copyFileSync: (a, b, flags) => fs.copyFileSync(a, b, flags),
    },
    exec: {
      run: (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts }),
      runStreaming: (cmd, args, opts = {}) =>
        execFileSync(cmd, args, { stdio: "inherit", ...opts }),
    },
    log: (...m) => console.log(...m),
    err: (...m) => console.error(...m),
  };
}

function executeFreshClone({ installPath, ctx }) {
  ctx.log(`Cloning ai-job-searcher into ${installPath}...`);
  ctx.exec.runStreaming("git", ["clone", REPO_URL, installPath]);
}

function checkCleanTree({ installPath, ctx }) {
  const status = ctx.exec.run("git", ["-C", installPath, "status", "--porcelain"]).trim();
  if (status) {
    ctx.err(
      `${installPath} has local changes:\n${status}\n` +
        `Move them aside (or delete ${installPath} and run install again), then rerun.`
    );
    return false;
  }
  return true;
}

function executeUpdate({ installPath, ctx }) {
  ctx.log(`Updating existing install at ${installPath}...`);
  ctx.exec.runStreaming("git", ["-C", installPath, "pull", "--ff-only"]);
}

function executeNpmInstall({ installPath, ctx }) {
  ctx.log("Installing dependencies...");
  ctx.exec.runStreaming("npm", ["--prefix", installPath, "install"]);
}

function executeSkillLink(plan, ctx) {
  switch (plan.action) {
    case "noop":
      ctx.log(`  ${plan.name}: already linked.`);
      return;
    case "missing-source":
      ctx.err(`  ${plan.name}: source ${plan.source} missing in the cloned repo — skipping.`);
      return;
    case "create":
      ctx.fs.mkdirSync(path.dirname(plan.target), { recursive: true });
      ctx.fs.symlinkSync(plan.source, plan.target, "dir");
      ctx.log(`  ${plan.name}: linked.`);
      return;
    case "backup-then-create":
      ctx.fs.renameSync(plan.target, plan.backupPath);
      ctx.fs.mkdirSync(path.dirname(plan.target), { recursive: true });
      ctx.fs.symlinkSync(plan.source, plan.target, "dir");
      ctx.log(`  ${plan.name}: existing entry moved to ${plan.backupPath}, then linked.`);
      return;
    default:
      throw new Error(`unknown skill-link action: ${plan.action}`);
  }
}

function ensureEnvFile({ installPath, ctx, isFresh }) {
  // Only seed .env on fresh installs. On updates, treat a missing .env as
  // an intentional choice — don't silently recreate it.
  if (!isFresh) return;
  const envPath = path.join(installPath, ".env");
  const examplePath = path.join(installPath, ".env.example");
  if (ctx.fs.existsSync(envPath)) return;
  if (!ctx.fs.existsSync(examplePath)) return;
  ctx.fs.copyFileSync(examplePath, envPath, fs.constants.COPYFILE_EXCL);
  ctx.log(`Created ${envPath} from .env.example. Fill in tokens before first scan.`);
}

// --- main -------------------------------------------------------------------

function main({
  homedir = os.homedir(),
  nodeVersion = process.version,
  platform = process.platform,
  cwd = process.cwd(),
  ctx = makeRealCtx(),
  now = new Date(),
} = {}) {
  const installPath = path.join(homedir, INSTALL_DIR_NAME);
  const claudeSkillsPath = path.join(homedir, CLAUDE_SKILLS_DIR_NAME);

  const pre = checkPreflight({ nodeVersion, platform });
  if (!pre.ok) {
    ctx.err(pre.message);
    return 1;
  }

  const detect = detectInstallState({
    installPath,
    fsCtx: ctx.fs,
    execCtx: ctx.exec,
  });

  if (detect.state === "conflict") {
    ctx.err(detect.message);
    return 1;
  }

  if (detect.state === "fresh") {
    executeFreshClone({ installPath, ctx });
  } else {
    if (!checkCleanTree({ installPath, ctx })) return 1;
    executeUpdate({ installPath, ctx });
  }

  executeNpmInstall({ installPath, ctx });

  ctx.log("Wiring skills into ~/.claude/skills/...");
  for (const name of SKILLS_TO_LINK) {
    const plan = planSkillLink({
      name,
      installPath,
      claudeSkillsPath,
      fsCtx: ctx.fs,
      now,
    });
    executeSkillLink(plan, ctx);
  }

  ensureEnvFile({ installPath, ctx, isFresh: detect.state === "fresh" });

  const cwdCheck = detectCwdIsClone({
    cwd,
    fsCtx: ctx.fs,
    execCtx: ctx.exec,
    installPath,
  });
  if (cwdCheck.isClone) {
    ctx.log("");
    ctx.log(`Note: you ran this from inside another clone at ${cwdCheck.cwd}.`);
    ctx.log(
      `The canonical copy now lives at ${installPath}. You can delete ` +
        `${cwdCheck.cwd} if you don't need it.`
    );
  }

  ctx.log("");
  if (detect.state === "fresh") {
    ctx.log("Done.");
    ctx.log("");
    ctx.log("Close Claude Code and open it again.");
    ctx.log("Then in a Claude Code chat type:");
    ctx.log("");
    ctx.log("  /onboard-profile me");
  } else {
    ctx.log("Updated to latest version.");
    ctx.log("Restart Claude Code if it's currently open; otherwise you're set.");
  }
  return 0;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0] || "install";
  if (cmd !== "install") {
    console.error(
      `Unknown subcommand: ${cmd}.\n` + `Usage: npx -y github:ymuromcev/ai-job-searcher install`
    );
    process.exit(1);
  }
  try {
    process.exit(main());
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  }
}

module.exports = {
  checkPreflight,
  detectInstallState,
  isOurRemote,
  planSkillLink,
  detectCwdIsClone,
  formatTimestamp,
  ensureEnvFile,
  main,
  SKILLS_TO_LINK,
  REPO_URL,
};
