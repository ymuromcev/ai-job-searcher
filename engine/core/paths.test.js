"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { resolveDataDir, resolveProfilesDir } = require("./paths.js");

test("resolveDataDir: defaults to process.cwd() when env unset", () => {
  const got = resolveDataDir({});
  assert.equal(got, path.resolve(process.cwd()));
});

test("resolveDataDir: honors AI_JOB_SEARCHER_DATA_DIR", () => {
  const got = resolveDataDir({ AI_JOB_SEARCHER_DATA_DIR: "/data" });
  assert.equal(got, path.resolve("/data"));
});

test("resolveDataDir: empty string treated as unset", () => {
  const got = resolveDataDir({ AI_JOB_SEARCHER_DATA_DIR: "   " });
  assert.equal(got, path.resolve(process.cwd()));
});

test("resolveDataDir: relative path is resolved against cwd", () => {
  const got = resolveDataDir({ AI_JOB_SEARCHER_DATA_DIR: "./tmp" });
  assert.equal(got, path.resolve("./tmp"));
});

test("resolveProfilesDir: ctx.profilesDir wins over env", () => {
  const got = resolveProfilesDir(
    { profilesDir: "/explicit/path" },
    { AI_JOB_SEARCHER_DATA_DIR: "/data" }
  );
  assert.equal(got, "/explicit/path");
});

test("resolveProfilesDir: env override produces /<DATA_DIR>/profiles", () => {
  const got = resolveProfilesDir({}, { AI_JOB_SEARCHER_DATA_DIR: "/data" });
  assert.equal(got, path.join(path.resolve("/data"), "profiles"));
});

test("resolveProfilesDir: defaults to <cwd>/profiles when env unset", () => {
  const got = resolveProfilesDir({}, {});
  assert.equal(got, path.join(path.resolve(process.cwd()), "profiles"));
});

test("resolveProfilesDir: handles undefined ctx + undefined env", () => {
  // Should not throw — both args optional.
  const got = resolveProfilesDir();
  assert.equal(typeof got, "string");
  assert.ok(got.endsWith(path.sep + "profiles"));
});
