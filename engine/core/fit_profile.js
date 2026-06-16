// Fit-profile artifact lifecycle (RFC 060, BL-192).
//
// `profiles/<id>/fit_profile.md` is the GENERATED achievement digest the fit
// evaluator scores vacancies against. It is built from the `## Storybank`
// section of `profiles/<id>/interview-coach-state/coaching_state.md`.
//
// This module is the single place that knows how to:
//   - buildContent   — turn a profile's storybank into the digest string;
//   - ensureFresh     — (re)write the artifact when it drifts from the bank;
//   - checkFreshness  — read-only staleness/coverage check for `validate`.
//
// scripts/build_fit_profile.js (manual CLI), engine/commands/prepare.js
// (auto-regenerate before scoring) and engine/commands/validate.js (gate)
// all go through here so there is exactly one definition of "fresh".
//
// Pure-ish: side effects are confined to ensureFresh's single write, which is
// injectable (opts.fs / opts.writeFile) for tests.

"use strict";

const fs = require("fs");
const path = require("path");

const { parseStorybank } = require("./storybank");
const { buildFitDigest, digestHash } = require("./fit_digest");

const DIGEST_SOURCE = "interview-coach-state/coaching_state.md (## Storybank)";

function coachingStatePath(profileDir) {
  return path.join(profileDir, "interview-coach-state", "coaching_state.md");
}

function fitProfilePath(profileDir) {
  return path.join(profileDir, "fit_profile.md");
}

// Build the digest content for a profile from its storybank.
// Returns { content, hash, stories } or null when there is no coaching_state
// file or the storybank is empty — the caller decides the fallback.
function buildContent(profileDir, profileId, opts = {}) {
  const fsImpl = opts.fs || fs;
  const csPath = coachingStatePath(profileDir);
  if (!fsImpl.existsSync(csPath)) return null;
  const md = fsImpl.readFileSync(csPath, "utf8");
  const stories = parseStorybank(md);
  if (stories.length === 0) return null;
  const content = buildFitDigest(stories, { profileId, source: DIGEST_SOURCE });
  return { content, hash: digestHash(stories), stories };
}

// (Re)generate fit_profile.md when it is missing or has drifted from the bank.
// Returns { content, regenerated, reason }. `content` is null only when there
// is neither a storybank nor an existing artifact. Honours opts.dryRun (compute
// fresh content but do not write) so `prepare --dry-run` still surfaces the
// up-to-date digest without touching disk.
function ensureFresh(profileDir, profileId, opts = {}) {
  const fsImpl = opts.fs || fs;
  const writeFile = opts.writeFile || ((p, d) => fsImpl.writeFileSync(p, d, "utf8"));
  const outPath = fitProfilePath(profileDir);
  const existing = fsImpl.existsSync(outPath) ? fsImpl.readFileSync(outPath, "utf8") : null;

  const built = buildContent(profileDir, profileId, { fs: fsImpl });
  if (!built) {
    return { content: existing, regenerated: false, reason: "no-storybank" };
  }
  if (existing === built.content) {
    return { content: built.content, regenerated: false, reason: "fresh" };
  }
  if (!opts.dryRun) writeFile(outPath, built.content);
  return {
    content: built.content,
    regenerated: !opts.dryRun,
    reason: existing == null ? "created" : "stale",
  };
}

// Read-only freshness + coverage check for `validate`. Never writes.
// Returns { applicable, exists, ok, issues:[...] }.
//   applicable=false → profile has no storybank, fit_profile.md is optional.
function checkFreshness(profileDir, profileId, opts = {}) {
  const fsImpl = opts.fs || fs;
  const built = buildContent(profileDir, profileId, { fs: fsImpl });
  const outPath = fitProfilePath(profileDir);
  const exists = fsImpl.existsSync(outPath);

  if (!built) {
    return { applicable: false, exists, ok: true, issues: [] };
  }
  if (!exists) {
    return {
      applicable: true,
      exists,
      ok: false,
      issues: [`missing — generate it: node scripts/build_fit_profile.js --profile ${profileId}`],
    };
  }

  const actual = fsImpl.readFileSync(outPath, "utf8");
  const issues = [];

  // Coverage: every storybank row must render as a `## S0NN` block. A missing
  // story is the specific, actionable case ("you added S022, regenerate").
  const missing = built.stories
    .map((s) => s.id)
    .filter((id) => !new RegExp(`^##\\s+${id}\\b`, "m").test(actual));
  if (missing.length) {
    issues.push(`missing storybank rows: ${missing.join(", ")} — regenerate the digest`);
  }

  // Staleness: catches every other drift (edited title / metric / domain) via
  // the content hash embedded in the header. Skip when a story is outright
  // missing — that message is already clearer.
  const m = actual.match(/<!-- fit-digest-hash: ([0-9a-f]+) -->/);
  const actualHash = m ? m[1] : null;
  if (missing.length === 0 && actualHash !== built.hash) {
    issues.push(
      `stale (achievements changed since last build) — regenerate: ` +
        `node scripts/build_fit_profile.js --profile ${profileId}`
    );
  }

  return { applicable: true, exists, ok: issues.length === 0, issues };
}

module.exports = {
  DIGEST_SOURCE,
  coachingStatePath,
  fitProfilePath,
  buildContent,
  ensureFresh,
  checkFreshness,
};
