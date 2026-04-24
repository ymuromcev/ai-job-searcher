const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildRegistry } = require("./index.js");

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aijs-registry-"));
}

function writeAdapter(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), body);
}

test("buildRegistry loads well-formed adapters and skips helpers/tests", () => {
  const dir = mkTmpDir();
  writeAdapter(dir, "alpha.js", 'module.exports = { source: "alpha", discover: async () => [] };');
  writeAdapter(dir, "beta.js", 'module.exports = { source: "beta", discover: async () => [] };');
  writeAdapter(dir, "_helper.js", 'module.exports = { should: "be skipped" };');
  writeAdapter(dir, "alpha.test.js", 'throw new Error("should not load tests");');

  const reg = buildRegistry(dir);
  const keys = Array.from(reg.keys()).sort();
  assert.deepEqual(keys, ["alpha", "beta"]);
});

test("buildRegistry rejects adapter missing discover()", () => {
  const dir = mkTmpDir();
  writeAdapter(dir, "bad.js", 'module.exports = { source: "bad" };');
  assert.throws(() => buildRegistry(dir), /must export "discover"/);
});

test("buildRegistry rejects adapter missing source", () => {
  const dir = mkTmpDir();
  writeAdapter(dir, "bad.js", "module.exports = { discover: async () => [] };");
  assert.throws(() => buildRegistry(dir), /must export non-empty "source"/);
});

test("buildRegistry rejects duplicate source values", () => {
  const dir = mkTmpDir();
  writeAdapter(dir, "a.js", 'module.exports = { source: "dup", discover: async () => [] };');
  writeAdapter(dir, "b.js", 'module.exports = { source: "dup", discover: async () => [] };');
  assert.throws(() => buildRegistry(dir), /duplicate adapter source "dup"/);
});
