// Path resolution helpers.
//
// `resolveProfilesDir(ctx, env)` returns the directory that contains all
// profile subdirs. Resolution order:
//   1. `ctx.profilesDir` (test injection)
//   2. `env.AI_JOB_SEARCHER_DATA_DIR + /profiles` (cron / fly volume override)
//   3. `process.cwd() + /profiles` (default — local Mac runs)
//
// `resolveDataDir(env)` returns the data dir root (where `profiles/` lives).
// Used by anything that wants a parallel state location, e.g. shared TSV pool.
//
// The DATA_DIR override is what lets the fly.io container persist state on a
// mounted volume at `/data` while keeping local Mac runs unchanged.

const path = require("path");

function resolveDataDir(env = process.env) {
  const fromEnv = env && env.AI_JOB_SEARCHER_DATA_DIR;
  if (fromEnv && typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv);
  }
  return path.resolve(process.cwd());
}

function resolveProfilesDir(ctx = {}, env = process.env) {
  if (ctx.profilesDir) return ctx.profilesDir;
  return path.join(resolveDataDir(env), "profiles");
}

module.exports = { resolveDataDir, resolveProfilesDir };
