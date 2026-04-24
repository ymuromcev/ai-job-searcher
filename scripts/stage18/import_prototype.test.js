const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { IMPORT_PLAN, copyFile, copyDir, exists } = require("./import_prototype.js");

function mkTmpDir(prefix = "stage18-import-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("IMPORT_PLAN: every entry has key + kind + src + dst", () => {
  assert.ok(IMPORT_PLAN.length >= 5);
  for (const item of IMPORT_PLAN) {
    assert.ok(item.key, "missing key");
    assert.ok(item.kind === "file" || item.kind === "dir", `bad kind: ${item.kind}`);
    assert.ok(item.src && item.dst, "src/dst missing");
  }
});

test("IMPORT_PLAN: cover_letter_config → cover_letter_versions rename", () => {
  const item = IMPORT_PLAN.find((i) => i.key === "import_cover_letter_versions");
  assert.equal(item.src, "cover_letter_config.json");
  assert.equal(item.dst, "cover_letter_versions.json");
});

test("copyFile: respects overwrite=false when target exists", () => {
  const tmp = mkTmpDir();
  try {
    const src = path.join(tmp, "src.txt");
    const dst = path.join(tmp, "dst.txt");
    fs.writeFileSync(src, "NEW");
    fs.writeFileSync(dst, "OLD");
    const r = copyFile(src, dst, { overwrite: false });
    assert.equal(r.action, "skip");
    assert.equal(fs.readFileSync(dst, "utf8"), "OLD");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("copyFile: overwrite=true replaces existing target", () => {
  const tmp = mkTmpDir();
  try {
    const src = path.join(tmp, "src.txt");
    const dst = path.join(tmp, "dst.txt");
    fs.writeFileSync(src, "NEW");
    fs.writeFileSync(dst, "OLD");
    const r = copyFile(src, dst, { overwrite: true });
    assert.equal(r.action, "copy");
    assert.equal(fs.readFileSync(dst, "utf8"), "NEW");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("copyDir: skips dotfiles + recursive + handles missing src", () => {
  const tmp = mkTmpDir();
  try {
    const src = path.join(tmp, "src");
    const dst = path.join(tmp, "dst");
    fs.mkdirSync(path.join(src, "sub1"), { recursive: true });
    fs.writeFileSync(path.join(src, "a.pdf"), "a");
    fs.writeFileSync(path.join(src, "sub1", "b.pdf"), "b");
    fs.writeFileSync(path.join(src, ".DS_Store"), "X");
    fs.mkdirSync(path.join(src, ".git"));
    fs.writeFileSync(path.join(src, ".git", "ignored"), "X");

    const r = copyDir(src, dst, { overwrite: false });
    assert.equal(r.copied, 2);
    assert.equal(r.missing, false);
    assert.ok(exists(path.join(dst, "a.pdf")));
    assert.ok(exists(path.join(dst, "sub1", "b.pdf")));
    assert.ok(!exists(path.join(dst, ".DS_Store")));
    assert.ok(!exists(path.join(dst, ".git")));

    // Re-run: second pass should skip all (overwrite=false).
    const r2 = copyDir(src, dst, { overwrite: false });
    assert.equal(r2.copied, 0);
    assert.equal(r2.skipped, 2);

    // Missing src is handled gracefully.
    const rMissing = copyDir(path.join(tmp, "does-not-exist"), path.join(tmp, "x"), { overwrite: false });
    assert.equal(rMissing.missing, true);
    assert.equal(rMissing.copied, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
