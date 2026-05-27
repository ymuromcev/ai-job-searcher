// Tests for scripts/install.js — BL-137 / RFC 048.
// Pure functions get unit coverage; main() gets two end-to-end traces
// (fresh + update) against a fake ctx with in-memory fs / exec.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  checkPreflight,
  detectInstallState,
  isOurRemote,
  planSkillLink,
  detectCwdIsClone,
  formatTimestamp,
  ensureEnvFile,
  main,
  SKILLS_TO_LINK,
} = require("./install.js");

// --- checkPreflight ---------------------------------------------------------

test("checkPreflight: Node 20 darwin → ok", () => {
  assert.deepEqual(checkPreflight({ nodeVersion: "v20.10.0", platform: "darwin" }), {
    ok: true,
  });
});

test("checkPreflight: Node 22 linux → ok", () => {
  assert.deepEqual(checkPreflight({ nodeVersion: "v22.5.0", platform: "linux" }), {
    ok: true,
  });
});

test("checkPreflight: Node 18 → fails with upgrade message", () => {
  const r = checkPreflight({ nodeVersion: "v18.19.0", platform: "darwin" });
  assert.equal(r.ok, false);
  assert.match(r.message, /Node 20\+/);
  assert.match(r.message, /v18\.19\.0/);
});

test("checkPreflight: win32 → fails with platform message", () => {
  const r = checkPreflight({ nodeVersion: "v20.10.0", platform: "win32" });
  assert.equal(r.ok, false);
  assert.match(r.message, /macOS or Linux/);
});

test("checkPreflight: unparseable Node version → fails clearly", () => {
  const r = checkPreflight({ nodeVersion: "garbage", platform: "darwin" });
  assert.equal(r.ok, false);
  assert.match(r.message, /Could not parse/);
});

// --- isOurRemote ------------------------------------------------------------

test("isOurRemote: https URL with .git → true", () => {
  assert.equal(isOurRemote("https://github.com/ymuromcev/ai-job-searcher.git"), true);
});

test("isOurRemote: https URL without .git → true", () => {
  assert.equal(isOurRemote("https://github.com/ymuromcev/ai-job-searcher"), true);
});

test("isOurRemote: ssh URL → true", () => {
  assert.equal(isOurRemote("git@github.com:ymuromcev/ai-job-searcher.git"), true);
});

test("isOurRemote: someone else's fork → false", () => {
  assert.equal(isOurRemote("https://github.com/forker/ai-job-searcher.git"), false);
});

test("isOurRemote: unrelated repo → false", () => {
  assert.equal(isOurRemote("https://github.com/ymuromcev/something-else.git"), false);
});

test("isOurRemote: empty → false", () => {
  assert.equal(isOurRemote(""), false);
  assert.equal(isOurRemote(null), false);
});

test("isOurRemote: trailing slash → true", () => {
  assert.equal(isOurRemote("https://github.com/ymuromcev/ai-job-searcher/"), true);
  assert.equal(isOurRemote("https://github.com/ymuromcev/ai-job-searcher.git/"), true);
});

// --- detectInstallState -----------------------------------------------------

function makeFakeFs(paths) {
  const set = new Set(paths);
  return {
    existsSync: (p) => set.has(p),
    lstatExistsSync: (p) => set.has(p),
    lstatSync: () => {
      throw new Error("not implemented for this test");
    },
    readlinkSync: () => {
      throw new Error("not implemented for this test");
    },
  };
}

function makeFakeExec(responses) {
  return {
    run: (cmd, args) => {
      const key = `${cmd} ${args.join(" ")}`;
      if (key in responses) {
        const r = responses[key];
        if (r instanceof Error) throw r;
        return r;
      }
      throw new Error(`unmocked exec: ${key}`);
    },
  };
}

test("detectInstallState: no install dir → fresh", () => {
  const r = detectInstallState({
    installPath: "/home/u/.ai-job-searcher",
    fsCtx: makeFakeFs([]),
    execCtx: makeFakeExec({}),
  });
  assert.deepEqual(r, { state: "fresh" });
});

test("detectInstallState: install dir exists but no .git → conflict", () => {
  const r = detectInstallState({
    installPath: "/home/u/.ai-job-searcher",
    fsCtx: makeFakeFs(["/home/u/.ai-job-searcher"]),
    execCtx: makeFakeExec({}),
  });
  assert.equal(r.state, "conflict");
  assert.match(r.message, /not a git clone/);
});

test("detectInstallState: install dir is a clone of our repo → update", () => {
  const r = detectInstallState({
    installPath: "/home/u/.ai-job-searcher",
    fsCtx: makeFakeFs(["/home/u/.ai-job-searcher", "/home/u/.ai-job-searcher/.git"]),
    execCtx: makeFakeExec({
      "git -C /home/u/.ai-job-searcher remote get-url origin":
        "https://github.com/ymuromcev/ai-job-searcher.git\n",
    }),
  });
  assert.deepEqual(r, { state: "update" });
});

test("detectInstallState: install dir is a clone of someone else → conflict", () => {
  const r = detectInstallState({
    installPath: "/home/u/.ai-job-searcher",
    fsCtx: makeFakeFs(["/home/u/.ai-job-searcher", "/home/u/.ai-job-searcher/.git"]),
    execCtx: makeFakeExec({
      "git -C /home/u/.ai-job-searcher remote get-url origin":
        "https://github.com/forker/ai-job-searcher.git\n",
    }),
  });
  assert.equal(r.state, "conflict");
  assert.match(r.message, /not ai-job-searcher/);
});

test("detectInstallState: install dir has .git but no origin remote → conflict", () => {
  const r = detectInstallState({
    installPath: "/home/u/.ai-job-searcher",
    fsCtx: makeFakeFs(["/home/u/.ai-job-searcher", "/home/u/.ai-job-searcher/.git"]),
    execCtx: makeFakeExec({
      "git -C /home/u/.ai-job-searcher remote get-url origin": new Error("no origin"),
    }),
  });
  assert.equal(r.state, "conflict");
  assert.match(r.message, /no 'origin' remote/);
});

// --- planSkillLink ----------------------------------------------------------

const INSTALL = "/home/u/.ai-job-searcher";
const SKILLS = "/home/u/.claude/skills";

function fsWithSkill({ existing = [], lstats = {}, links = {} }) {
  const set = new Set([
    `${INSTALL}/skills/onboard-profile`,
    `${INSTALL}/skills/job-pipeline`,
    `${INSTALL}/skills/interview-coach`,
    ...existing,
  ]);
  return {
    existsSync: (p) => set.has(p),
    lstatExistsSync: (p) => set.has(p) || p in lstats,
    lstatSync: (p) => {
      if (!(p in lstats)) throw new Error(`no lstat for ${p}`);
      return lstats[p];
    },
    readlinkSync: (p) => {
      if (!(p in links)) throw new Error(`no readlink for ${p}`);
      return links[p];
    },
  };
}

test("planSkillLink: target absent → create", () => {
  const plan = planSkillLink({
    name: "onboard-profile",
    installPath: INSTALL,
    claudeSkillsPath: SKILLS,
    fsCtx: fsWithSkill({}),
    now: new Date("2026-05-27T12:00:00Z"),
  });
  assert.equal(plan.action, "create");
  assert.equal(plan.source, `${INSTALL}/skills/onboard-profile`);
  assert.equal(plan.target, `${SKILLS}/onboard-profile`);
});

test("planSkillLink: target already symlinked to our source → noop", () => {
  const target = `${SKILLS}/onboard-profile`;
  const plan = planSkillLink({
    name: "onboard-profile",
    installPath: INSTALL,
    claudeSkillsPath: SKILLS,
    fsCtx: fsWithSkill({
      existing: [target],
      lstats: { [target]: { isSymbolicLink: () => true } },
      links: { [target]: `${INSTALL}/skills/onboard-profile` },
    }),
    now: new Date("2026-05-27T12:00:00Z"),
  });
  assert.equal(plan.action, "noop");
});

test("planSkillLink: target is a regular directory → backup-then-create", () => {
  const target = `${SKILLS}/onboard-profile`;
  const plan = planSkillLink({
    name: "onboard-profile",
    installPath: INSTALL,
    claudeSkillsPath: SKILLS,
    fsCtx: fsWithSkill({
      existing: [target],
      lstats: { [target]: { isSymbolicLink: () => false } },
    }),
    now: new Date("2026-05-27T12:34:56Z"),
  });
  assert.equal(plan.action, "backup-then-create");
  assert.match(plan.backupPath, /onboard-profile\.backup-20260527-123456-000$/);
});

test("planSkillLink: target is a symlink to a different source → backup-then-create", () => {
  const target = `${SKILLS}/onboard-profile`;
  const plan = planSkillLink({
    name: "onboard-profile",
    installPath: INSTALL,
    claudeSkillsPath: SKILLS,
    fsCtx: fsWithSkill({
      existing: [target],
      lstats: { [target]: { isSymbolicLink: () => true } },
      links: { [target]: "/some/other/skill" },
    }),
    now: new Date("2026-05-27T00:00:00Z"),
  });
  assert.equal(plan.action, "backup-then-create");
});

test("planSkillLink: source missing in repo → missing-source", () => {
  const plan = planSkillLink({
    name: "nonexistent-skill",
    installPath: INSTALL,
    claudeSkillsPath: SKILLS,
    fsCtx: fsWithSkill({}),
    now: new Date(),
  });
  assert.equal(plan.action, "missing-source");
});

test("planSkillLink: existing backup at same timestamp → appends suffix", () => {
  const target = `${SKILLS}/onboard-profile`;
  const baseBackup = `${target}.backup-20260527-123456-789`;
  const plan = planSkillLink({
    name: "onboard-profile",
    installPath: INSTALL,
    claudeSkillsPath: SKILLS,
    fsCtx: fsWithSkill({
      existing: [target, baseBackup],
      lstats: { [target]: { isSymbolicLink: () => false } },
    }),
    now: new Date(Date.UTC(2026, 4, 27, 12, 34, 56, 789)),
  });
  assert.equal(plan.action, "backup-then-create");
  assert.equal(plan.backupPath, `${baseBackup}-1`);
});

// --- detectCwdIsClone -------------------------------------------------------

test("detectCwdIsClone: cwd is installPath → not a clone (skip the warning)", () => {
  const r = detectCwdIsClone({
    cwd: INSTALL,
    installPath: INSTALL,
    fsCtx: makeFakeFs([`${INSTALL}/.git`]),
    execCtx: makeFakeExec({}),
  });
  assert.equal(r.isClone, false);
});

test("detectCwdIsClone: cwd is a separate clone of our repo → true", () => {
  const r = detectCwdIsClone({
    cwd: "/Users/dev/work/ai-job-searcher",
    installPath: INSTALL,
    fsCtx: makeFakeFs(["/Users/dev/work/ai-job-searcher/.git"]),
    execCtx: makeFakeExec({
      "git -C /Users/dev/work/ai-job-searcher remote get-url origin":
        "https://github.com/ymuromcev/ai-job-searcher.git\n",
    }),
  });
  assert.equal(r.isClone, true);
  assert.equal(r.cwd, "/Users/dev/work/ai-job-searcher");
});

test("detectCwdIsClone: cwd is a clone of a different repo → false", () => {
  const r = detectCwdIsClone({
    cwd: "/Users/dev/other-project",
    installPath: INSTALL,
    fsCtx: makeFakeFs(["/Users/dev/other-project/.git"]),
    execCtx: makeFakeExec({
      "git -C /Users/dev/other-project remote get-url origin":
        "https://github.com/dev/other-project.git\n",
    }),
  });
  assert.equal(r.isClone, false);
});

test("detectCwdIsClone: cwd has no .git → false", () => {
  const r = detectCwdIsClone({
    cwd: "/tmp/empty",
    installPath: INSTALL,
    fsCtx: makeFakeFs([]),
    execCtx: makeFakeExec({}),
  });
  assert.equal(r.isClone, false);
});

// --- formatTimestamp --------------------------------------------------------

test("formatTimestamp: utc components zero-padded + milliseconds", () => {
  assert.equal(formatTimestamp(new Date(Date.UTC(2026, 0, 5, 3, 4, 5, 7))), "20260105-030405-007");
});

// --- main: fresh install trace ---------------------------------------------

function makeTraceCtx({ fsState = new Set(), execResponses = {} }) {
  const calls = [];
  const messages = [];
  const symlinks = new Map();
  const fsState_ = new Set(fsState);
  const lstats = new Map();

  return {
    calls,
    messages,
    fs: {
      existsSync: (p) => fsState_.has(p),
      lstatExistsSync: (p) => fsState_.has(p) || lstats.has(p),
      lstatSync: (p) => {
        if (lstats.has(p)) return lstats.get(p);
        throw new Error(`no lstat for ${p}`);
      },
      readlinkSync: (p) => {
        if (symlinks.has(p)) return symlinks.get(p);
        throw new Error(`no readlink for ${p}`);
      },
      mkdirSync: (p) => {
        calls.push(["mkdir", p]);
        fsState_.add(p);
      },
      renameSync: (a, b) => {
        calls.push(["rename", a, b]);
        fsState_.delete(a);
        fsState_.add(b);
      },
      symlinkSync: (target, link) => {
        calls.push(["symlink", target, link]);
        symlinks.set(link, target);
        lstats.set(link, { isSymbolicLink: () => true });
        fsState_.add(link);
      },
      copyFileSync: (a, b) => {
        calls.push(["copyFile", a, b]);
        fsState_.add(b);
      },
    },
    exec: {
      run: (cmd, args) => {
        const key = `${cmd} ${args.join(" ")}`;
        calls.push(["run", key]);
        if (key in execResponses) {
          const r = execResponses[key];
          if (r instanceof Error) throw r;
          return r;
        }
        return "";
      },
      runStreaming: (cmd, args) => {
        calls.push(["runStreaming", `${cmd} ${args.join(" ")}`]);
      },
    },
    log: (...m) => messages.push(m.join(" ")),
    err: (...m) => messages.push("ERR: " + m.join(" ")),
  };
}

test("main: fresh install — clones, installs, tests, links all 3 skills", () => {
  const home = "/home/u";
  const installPath = `${home}/.ai-job-searcher`;
  const ctx = makeTraceCtx({
    fsState: new Set([
      // After "clone" the source skill dirs would exist; emulate that by
      // pre-populating them. Real run sequences clone-then-link.
      `${installPath}/skills/onboard-profile`,
      `${installPath}/skills/job-pipeline`,
      `${installPath}/skills/interview-coach`,
      `${installPath}/.env.example`,
    ]),
  });

  const rc = main({
    homedir: home,
    nodeVersion: "v20.10.0",
    platform: "darwin",
    cwd: "/tmp/empty",
    ctx,
    now: new Date("2026-05-27T12:00:00Z"),
  });

  assert.equal(rc, 0);

  const streamingCalls = ctx.calls.filter((c) => c[0] === "runStreaming").map((c) => c[1]);
  assert.deepEqual(streamingCalls, [
    `git clone https://github.com/ymuromcev/ai-job-searcher.git ${installPath}`,
    `npm --prefix ${installPath} install`,
  ]);

  const symlinkCalls = ctx.calls.filter((c) => c[0] === "symlink");
  assert.equal(symlinkCalls.length, SKILLS_TO_LINK.length);
  for (const name of SKILLS_TO_LINK) {
    const link = `${home}/.claude/skills/${name}`;
    const target = `${installPath}/skills/${name}`;
    assert.ok(
      symlinkCalls.some((c) => c[1] === target && c[2] === link),
      `expected symlink for ${name}`
    );
  }

  const copyCalls = ctx.calls.filter((c) => c[0] === "copyFile");
  assert.equal(copyCalls.length, 1, ".env should be copied from .env.example");
  assert.equal(copyCalls[0][1], `${installPath}/.env.example`);
  assert.equal(copyCalls[0][2], `${installPath}/.env`);

  const out = ctx.messages.join("\n");
  assert.match(out, /Close Claude Code and open it again/);
  assert.match(out, /\/onboard-profile me/);
});

test("main: update path — pulls instead of clones, no .env overwrite", () => {
  const home = "/home/u";
  const installPath = `${home}/.ai-job-searcher`;
  const ctx = makeTraceCtx({
    fsState: new Set([
      installPath,
      `${installPath}/.git`,
      `${installPath}/skills/onboard-profile`,
      `${installPath}/skills/job-pipeline`,
      `${installPath}/skills/interview-coach`,
      `${installPath}/.env`,
      `${installPath}/.env.example`,
    ]),
    execResponses: {
      [`git -C ${installPath} remote get-url origin`]:
        "https://github.com/ymuromcev/ai-job-searcher.git\n",
      [`git -C ${installPath} status --porcelain`]: "",
    },
  });

  const rc = main({
    homedir: home,
    nodeVersion: "v20.10.0",
    platform: "darwin",
    cwd: "/tmp/empty",
    ctx,
    now: new Date("2026-05-27T12:00:00Z"),
  });

  assert.equal(rc, 0);

  const streamingCalls = ctx.calls.filter((c) => c[0] === "runStreaming").map((c) => c[1]);
  assert.deepEqual(streamingCalls, [
    `git -C ${installPath} pull --ff-only`,
    `npm --prefix ${installPath} install`,
  ]);

  // .env exists already → no copy
  const copyCalls = ctx.calls.filter((c) => c[0] === "copyFile");
  assert.equal(copyCalls.length, 0);

  const out = ctx.messages.join("\n");
  assert.match(out, /Updated to latest version/);
});

test("main: update path with dirty tree → refuses with friendly message, no pull", () => {
  const home = "/home/u";
  const installPath = `${home}/.ai-job-searcher`;
  const ctx = makeTraceCtx({
    fsState: new Set([
      installPath,
      `${installPath}/.git`,
      `${installPath}/skills/onboard-profile`,
      `${installPath}/skills/job-pipeline`,
      `${installPath}/skills/interview-coach`,
    ]),
    execResponses: {
      [`git -C ${installPath} remote get-url origin`]:
        "https://github.com/ymuromcev/ai-job-searcher.git\n",
      [`git -C ${installPath} status --porcelain`]: " M package.json\n",
    },
  });

  const rc = main({
    homedir: home,
    nodeVersion: "v20.10.0",
    platform: "darwin",
    cwd: "/tmp/empty",
    ctx,
    now: new Date("2026-05-27T12:00:00Z"),
  });

  assert.equal(rc, 1);
  const streamingCalls = ctx.calls.filter((c) => c[0] === "runStreaming");
  assert.equal(streamingCalls.length, 0, "no pull or npm when dirty");
  const out = ctx.messages.join("\n");
  assert.match(out, /local changes/);
});

test("main: conflict state (someone else's clone) → exit 1, no work done", () => {
  const home = "/home/u";
  const installPath = `${home}/.ai-job-searcher`;
  const ctx = makeTraceCtx({
    fsState: new Set([installPath, `${installPath}/.git`]),
    execResponses: {
      [`git -C ${installPath} remote get-url origin`]:
        "https://github.com/forker/ai-job-searcher.git\n",
    },
  });

  const rc = main({
    homedir: home,
    nodeVersion: "v20.10.0",
    platform: "darwin",
    cwd: "/tmp/empty",
    ctx,
    now: new Date("2026-05-27T12:00:00Z"),
  });
  assert.equal(rc, 1);
  const streamingCalls = ctx.calls.filter((c) => c[0] === "runStreaming");
  assert.equal(streamingCalls.length, 0);
  const out = ctx.messages.join("\n");
  assert.match(out, /Move or rename it/);
});

test("main: Node 18 → fails preflight, no work done", () => {
  const ctx = makeTraceCtx({});
  const rc = main({
    homedir: "/home/u",
    nodeVersion: "v18.0.0",
    platform: "linux",
    cwd: "/tmp/empty",
    ctx,
  });
  assert.equal(rc, 1);
  assert.equal(
    ctx.calls.filter((c) => c[0] === "runStreaming").length,
    0,
    "no shell calls when preflight fails"
  );
});

test("main: cwd is a separate clone → final note about redundant copy", () => {
  const home = "/home/u";
  const installPath = `${home}/.ai-job-searcher`;
  const cwd = "/Users/dev/work/ai-job-searcher";
  const ctx = makeTraceCtx({
    fsState: new Set([
      `${installPath}/skills/onboard-profile`,
      `${installPath}/skills/job-pipeline`,
      `${installPath}/skills/interview-coach`,
      `${installPath}/.env.example`,
      `${cwd}/.git`,
    ]),
    execResponses: {
      [`git -C ${cwd} remote get-url origin`]: "https://github.com/ymuromcev/ai-job-searcher.git\n",
    },
  });

  const rc = main({
    homedir: home,
    nodeVersion: "v20.10.0",
    platform: "darwin",
    cwd,
    ctx,
    now: new Date("2026-05-27T12:00:00Z"),
  });
  assert.equal(rc, 0);

  const out = ctx.messages.join("\n");
  assert.match(out, /you ran this from inside another clone/);
  assert.match(out, /You can delete/);
});

// --- ensureEnvFile ----------------------------------------------------------

test("ensureEnvFile: fresh + .env exists → skipped", () => {
  const calls = [];
  const ctx = {
    fs: {
      existsSync: (p) => p.endsWith(".env") || p.endsWith(".env.example"),
      copyFileSync: (...args) => calls.push(args),
    },
    log: () => {},
  };
  ensureEnvFile({ installPath: "/r", ctx, isFresh: true });
  assert.equal(calls.length, 0);
});

test("ensureEnvFile: fresh + no .env.example → skipped silently", () => {
  const calls = [];
  const ctx = {
    fs: {
      existsSync: () => false,
      copyFileSync: (...args) => calls.push(args),
    },
    log: () => {},
  };
  ensureEnvFile({ installPath: "/r", ctx, isFresh: true });
  assert.equal(calls.length, 0);
});

test("ensureEnvFile: update (not fresh) → never creates .env, even if missing", () => {
  const calls = [];
  const ctx = {
    fs: {
      existsSync: (p) => p.endsWith(".env.example"),
      copyFileSync: (...args) => calls.push(args),
    },
    log: () => {},
  };
  ensureEnvFile({ installPath: "/r", ctx, isFresh: false });
  assert.equal(calls.length, 0, "update path must not silently recreate .env");
});
