#!/usr/bin/env node
/**
 * setup-hooks — wire `.git-hooks/` into the current clone.
 *
 * Sets `core.hooksPath` to `.git-hooks/` so our pre-commit script runs
 * on every commit. Idempotent; safe to re-run.
 *
 * Usage:
 *   npm run setup-hooks
 */
"use strict";

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function run(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const hooksDir = path.join(repoRoot, ".git-hooks");

  if (!fs.existsSync(hooksDir)) {
    console.error(`[setup-hooks] missing ${hooksDir}`);
    process.exit(1);
  }

  // Verify we're inside a git repo.
  try {
    run("git rev-parse --is-inside-work-tree");
  } catch {
    console.error("[setup-hooks] not inside a git work tree — skipping.");
    process.exit(0);
  }

  // Ensure every hook is executable (git refuses to run non-executable hooks).
  for (const entry of fs.readdirSync(hooksDir)) {
    const full = path.join(hooksDir, entry);
    try {
      fs.chmodSync(full, 0o755);
    } catch (err) {
      console.warn(`[setup-hooks] could not chmod ${full}: ${err.message}`);
    }
  }

  // Point git at our hooks directory.
  run("git config core.hooksPath .git-hooks");
  const current = run("git config --get core.hooksPath");

  console.log(`[setup-hooks] core.hooksPath = ${current}`);
  console.log("[setup-hooks] pre-commit PII + secret guard is active.");
}

main();
