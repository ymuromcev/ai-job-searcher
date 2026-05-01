const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const {
  makeAnswerCommand,
  buildBackupMarkdown,
  backupFilename,
  nextAvailableBackupPath,
  slugify,
  validateDraft,
} = require("./answer.js");

// ---------- pure helpers -----------------------------------------------------

test("slugify lowercases, strips, and dasherizes", () => {
  assert.equal(slugify("Product Manager, AI Platform"), "product-manager-ai-platform");
  assert.equal(slugify("  Senior PM  "), "senior-pm");
  assert.equal(slugify("---"), "");
  assert.equal(slugify(""), "");
});

test("backupFilename uses Company_role-slug_YYYYMMDD format", () => {
  const f = backupFilename({ company: "Linear", role: "Product Manager", dateStamp: "20260430" });
  assert.equal(f, "Linear_product-manager_20260430.md");
});

test("backupFilename handles Figma's role with comma", () => {
  const f = backupFilename({ company: "Figma", role: "Product Manager, AI Platform", dateStamp: "20260430" });
  assert.equal(f, "Figma_product-manager-ai-platform_20260430.md");
});

test("nextAvailableBackupPath appends _v2/_v3 when collisions exist", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qa-backup-"));
  const base = "X_role_20260430.md";
  // No collision yet → returns plain.
  assert.equal(nextAvailableBackupPath(tmp, base), path.join(tmp, base));
  fs.writeFileSync(path.join(tmp, base), "x");
  // First collision → _v2.
  assert.equal(nextAvailableBackupPath(tmp, base), path.join(tmp, "X_role_20260430_v2.md"));
  fs.writeFileSync(path.join(tmp, "X_role_20260430_v2.md"), "x");
  assert.equal(nextAvailableBackupPath(tmp, base), path.join(tmp, "X_role_20260430_v3.md"));
});

test("buildBackupMarkdown formats expected sections", () => {
  const md = buildBackupMarkdown({
    company: "Linear",
    role: "PM",
    question: "Why?",
    answer: "Because.",
    category: "Motivation",
    notes: "210 chars",
  });
  assert.match(md, /^# Linear — PM/);
  assert.match(md, /## Q\. Why\?/);
  assert.match(md, /Because\./);
  assert.match(md, /\*\*Category\*\*: Motivation/);
  assert.match(md, /_\(8 chars\)_/);
});

test("buildBackupMarkdown marks update vs submit", () => {
  const fresh = buildBackupMarkdown({ company: "X", role: "Y", question: "Q", answer: "A" });
  const updated = buildBackupMarkdown({ company: "X", role: "Y", question: "Q", answer: "A", existingPageId: "p1" });
  assert.match(fresh, /\*\*Status\*\*: submitted/);
  assert.match(updated, /\*\*Status\*\*: updated/);
});

test("validateDraft requires company/role/question/answer", () => {
  assert.deepEqual(validateDraft({}), [
    "missing required field: company",
    "missing required field: role",
    "missing required field: question",
    "missing required field: answer",
  ]);
});

test("validateDraft rejects invalid category", () => {
  const errs = validateDraft({
    company: "X",
    role: "Y",
    question: "Z",
    answer: "A",
    category: "Made up",
  });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /invalid category/);
});

test("validateDraft accepts a fully-formed draft", () => {
  const errs = validateDraft({
    company: "X",
    role: "Y",
    question: "Z",
    answer: "A",
    category: "Motivation",
  });
  assert.deepEqual(errs, []);
});

// ---------- search phase (mocked deps) ---------------------------------------

function captureWriter() {
  const lines = [];
  return {
    writer: (s) => lines.push(s),
    text: () => lines.join("\n"),
  };
}

function makeCtx({ phase, flags = {}, env, replaceEnv = false } = {}) {
  const out = captureWriter();
  const err = captureWriter();
  // Default env supplies a fake token. Tests that want to assert "missing token"
  // pass `replaceEnv: true` with `env: {}`.
  const finalEnv = replaceEnv
    ? env || {}
    : { JARED_NOTION_TOKEN: "ntn_test", ...(env || {}) };
  return {
    profileId: "jared",
    flags: { phase, ...flags },
    env: finalEnv,
    stdout: out.writer,
    stderr: err.writer,
    _out: out,
    _err: err,
  };
}

function makeProfileLoader(notionExtras = {}) {
  return () => ({
    notion: { application_qa_db_id: "qa-db-1", ...notionExtras },
  });
}

function defaultLoadSecrets(_id, env) {
  // Mirrors profile_loader.loadSecrets behavior — strips JARED_ prefix.
  const out = {};
  const prefix = "JARED_";
  for (const [k, v] of Object.entries(env || {})) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}

test("runSearch errors when --company/--role/--question missing", async () => {
  const cmd = makeAnswerCommand({
    loadProfile: makeProfileLoader(),
    makeClient: () => ({}),
    searchAnswers: async () => ({ exact: null, partials: [] }),
  });
  const ctx = makeCtx({ phase: "search", flags: {} });
  const code = await cmd(ctx);
  assert.equal(code, 1);
  assert.match(ctx._err.text(), /requires --company, --role, and --question/);
});

test("runSearch errors when profile has no application_qa_db_id", async () => {
  const cmd = makeAnswerCommand({
    loadProfile: () => ({ notion: {} }),
  });
  const ctx = makeCtx({
    phase: "search",
    flags: { company: "X", role: "Y", question: "Z" },
  });
  const code = await cmd(ctx);
  assert.equal(code, 1);
  assert.match(ctx._err.text(), /no notion\.application_qa_db_id/);
});

test("runSearch errors when JARED_NOTION_TOKEN env var missing", async () => {
  const cmd = makeAnswerCommand({ loadProfile: makeProfileLoader() });
  const ctx = makeCtx({
    phase: "search",
    flags: { company: "X", role: "Y", question: "Z" },
    env: {},
    replaceEnv: true,
  });
  const code = await cmd(ctx);
  assert.equal(code, 1);
  assert.match(ctx._err.text(), /missing JARED_NOTION_TOKEN/);
});

test("runSearch returns JSON with key + suggestion + matches", async () => {
  const cmd = makeAnswerCommand({
    loadProfile: makeProfileLoader(),
    makeClient: () => ({ marker: "client" }),
    searchAnswers: async (client, dbId, q) => {
      assert.equal(dbId, "qa-db-1");
      assert.equal(q.company, "Linear");
      return {
        exact: { pageId: "p1", question: "Why join?" },
        partials: [{ pageId: "p2", question: "Other" }],
      };
    },
  });
  const ctx = makeCtx({
    phase: "search",
    flags: { company: "Linear", role: "PM", question: "Why join Linear?" },
  });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  const out = JSON.parse(ctx._out.text());
  assert.equal(out.key, "linear||pm||why join linear?");
  assert.equal(out.exact.pageId, "p1");
  assert.equal(out.partials.length, 1);
  assert.equal(out.category_suggestion, "Motivation");
  assert.ok(Array.isArray(out.schema.categories));
});

// ---------- push phase (mocked deps) -----------------------------------------

function makeFakeFs(files = {}) {
  const written = {};
  const made = new Set();
  return {
    existsSync: (p) =>
      Object.prototype.hasOwnProperty.call(files, p) ||
      Object.prototype.hasOwnProperty.call(written, p) ||
      made.has(p),
    readFileSync: (p) => {
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
      if (Object.prototype.hasOwnProperty.call(written, p)) return written[p];
      throw new Error("ENOENT: " + p);
    },
    writeFileSync: (p, content) => {
      written[p] = content;
    },
    mkdirSync: (p) => {
      made.add(p);
    },
    _written: written,
    _made: made,
  };
}

test("runPush errors when --results-file missing", async () => {
  const cmd = makeAnswerCommand({ loadProfile: makeProfileLoader() });
  const ctx = makeCtx({ phase: "push", flags: {} });
  const code = await cmd(ctx);
  assert.equal(code, 1);
  assert.match(ctx._err.text(), /requires --results-file/);
});

test("runPush errors when results file does not exist", async () => {
  const fakeFs = makeFakeFs();
  const cmd = makeAnswerCommand({
    loadProfile: makeProfileLoader(),
    fs: fakeFs,
    resolveProfilesDir: () => "/tmp/profiles",
  });
  const ctx = makeCtx({ phase: "push", flags: { resultsFile: "/nope/missing.json" } });
  const code = await cmd(ctx);
  assert.equal(code, 1);
  assert.match(ctx._err.text(), /results file not found/);
});

test("runPush errors on invalid draft JSON", async () => {
  const file = "/tmp/draft.json";
  const fakeFs = makeFakeFs({ [file]: '{"company": "X"}' });
  const cmd = makeAnswerCommand({
    loadProfile: makeProfileLoader(),
    fs: fakeFs,
    resolveProfilesDir: () => "/tmp/profiles",
  });
  const ctx = makeCtx({ phase: "push", flags: { resultsFile: file } });
  const code = await cmd(ctx);
  assert.equal(code, 1);
  assert.match(ctx._err.text(), /invalid draft/);
});

test("runPush creates Notion page + writes local backup", async () => {
  const file = "/tmp/draft.json";
  const draft = {
    company: "Linear",
    role: "Product Manager",
    question: "Why join?",
    answer: "Because.",
    category: "Motivation",
    notes: "test",
  };
  const fakeFs = makeFakeFs({ [file]: JSON.stringify(draft) });
  let createCall = null;
  const cmd = makeAnswerCommand({
    loadProfile: makeProfileLoader(),
    makeClient: () => ({ marker: "client" }),
    createAnswerPage: async (client, dbId, fields) => {
      createCall = { dbId, fields };
      return { id: "new-page-uuid", url: "https://notion.so/new" };
    },
    updateAnswerPage: async () => {
      throw new Error("should not call update on fresh draft");
    },
    fs: fakeFs,
    resolveProfilesDir: () => "/tmp/profiles",
  });
  const ctx = makeCtx({ phase: "push", flags: { resultsFile: file } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  assert.equal(createCall.dbId, "qa-db-1");
  assert.equal(createCall.fields.company, "Linear");
  const out = JSON.parse(ctx._out.text());
  assert.equal(out.action, "created");
  assert.equal(out.pageId, "new-page-uuid");
  // Backup written to expected dir.
  const writtenPaths = Object.keys(fakeFs._written);
  assert.equal(writtenPaths.length, 1);
  assert.match(writtenPaths[0], /\/tmp\/profiles\/jared\/application_answers\/Linear_product-manager_/);
  assert.match(fakeFs._written[writtenPaths[0]], /## Q\. Why join\?/);
});

test("runPush updates existing page when existingPageId is set", async () => {
  const file = "/tmp/draft.json";
  const draft = {
    company: "Linear",
    role: "PM",
    question: "Why?",
    answer: "New.",
    category: "Motivation",
    existingPageId: "existing-uuid",
  };
  const fakeFs = makeFakeFs({ [file]: JSON.stringify(draft) });
  let updateCall = null;
  const cmd = makeAnswerCommand({
    loadProfile: makeProfileLoader(),
    makeClient: () => ({}),
    createAnswerPage: async () => {
      throw new Error("should not call create on update draft");
    },
    updateAnswerPage: async (client, pageId, fields) => {
      updateCall = { pageId, fields };
      return { id: pageId, url: "https://notion.so/existing" };
    },
    fs: fakeFs,
    resolveProfilesDir: () => "/tmp/profiles",
  });
  const ctx = makeCtx({ phase: "push", flags: { resultsFile: file } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  assert.equal(updateCall.pageId, "existing-uuid");
  assert.equal(updateCall.fields.answer, "New.");
  const out = JSON.parse(ctx._out.text());
  assert.equal(out.action, "updated");
  assert.equal(out.pageId, "existing-uuid");
});

test("answer command errors on missing/unknown phase", async () => {
  const cmd = makeAnswerCommand({ loadProfile: makeProfileLoader() });
  const ctx = makeCtx({ phase: "" });
  const code = await cmd(ctx);
  assert.equal(code, 1);
  assert.match(ctx._err.text(), /--phase <search\|push>/);
});

// ---------- regression: code review fixes -----------------------------------

test("validateDraft rejects non-string existingPageId", () => {
  const errs1 = validateDraft({
    company: "X", role: "Y", question: "Z", answer: "A", existingPageId: 42,
  });
  assert.match(errs1.join(";"), /existingPageId must be a non-empty string/);
  const errs2 = validateDraft({
    company: "X", role: "Y", question: "Z", answer: "A", existingPageId: "",
  });
  assert.match(errs2.join(";"), /existingPageId must be a non-empty string/);
  const errs3 = validateDraft({
    company: "X", role: "Y", question: "Z", answer: "A", existingPageId: "abc",
  });
  assert.deepEqual(errs3, []);
});

test("validateDraft rejects non-string notes", () => {
  const errs = validateDraft({
    company: "X", role: "Y", question: "Z", answer: "A", notes: 123,
  });
  assert.match(errs.join(";"), /notes must be a string/);
});

test("runPush ensures backup dir exists (calls mkdirSync)", async () => {
  const file = "/tmp/draft-mkdir.json";
  const draft = { company: "Linear", role: "PM", question: "Why?", answer: "A" };
  const fakeFs = makeFakeFs({ [file]: JSON.stringify(draft) });
  const cmd = makeAnswerCommand({
    loadProfile: makeProfileLoader(),
    makeClient: () => ({}),
    createAnswerPage: async () => ({ id: "p", url: null }),
    fs: fakeFs,
    resolveProfilesDir: () => "/tmp/profiles",
  });
  const ctx = makeCtx({ phase: "push", flags: { resultsFile: file } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  assert.ok(
    fakeFs._made.has("/tmp/profiles/jared/application_answers"),
    "expected mkdirSync to be called for backup dir"
  );
});

test("runPush writes local backup BEFORE Notion call (preserved on Notion failure)", async () => {
  const file = "/tmp/draft-fail.json";
  const draft = { company: "Linear", role: "PM", question: "Why?", answer: "A" };
  const fakeFs = makeFakeFs({ [file]: JSON.stringify(draft) });
  let createCalled = false;
  const cmd = makeAnswerCommand({
    loadProfile: makeProfileLoader(),
    makeClient: () => ({}),
    createAnswerPage: async () => {
      createCalled = true;
      throw new Error("Notion 502 Bad Gateway");
    },
    fs: fakeFs,
    resolveProfilesDir: () => "/tmp/profiles",
  });
  const ctx = makeCtx({ phase: "push", flags: { resultsFile: file } });
  const code = await cmd(ctx);
  assert.equal(code, 1);
  assert.equal(createCalled, true, "expected createAnswerPage to be invoked");
  // Local backup should still exist.
  const writtenPaths = Object.keys(fakeFs._written);
  assert.equal(writtenPaths.length, 1);
  assert.match(writtenPaths[0], /\/tmp\/profiles\/jared\/application_answers\/Linear_pm_/);
  // Stderr should mention preserved backup.
  assert.match(ctx._err.text(), /notion push failed/i);
  assert.match(ctx._err.text(), /Local backup preserved/);
});

test("runPush works with the real loadSecrets dep contract", async () => {
  // Sanity check that the default loadSecrets pathway (used in production)
  // strips the profile prefix correctly.
  const file = "/tmp/draft-sanity.json";
  const draft = { company: "Linear", role: "PM", question: "Why?", answer: "A" };
  const fakeFs = makeFakeFs({ [file]: JSON.stringify(draft) });
  const cmd = makeAnswerCommand({
    loadProfile: makeProfileLoader(),
    loadSecrets: defaultLoadSecrets,
    makeClient: (token) => {
      assert.equal(token, "ntn_test", "token should be unprefixed");
      return {};
    },
    createAnswerPage: async () => ({ id: "p", url: null }),
    fs: fakeFs,
    resolveProfilesDir: () => "/tmp/profiles",
  });
  const ctx = makeCtx({ phase: "push", flags: { resultsFile: file } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
});
