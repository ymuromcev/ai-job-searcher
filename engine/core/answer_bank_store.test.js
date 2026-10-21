const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require("./answer_bank_store.js");

const A = "aaaaaaaa-0000-4000-8000-000000000001";

function tmpProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aijs-bank-"));
  return { id: "demo", notion: { application_qa_db_id: "qa-db" }, paths: { root } };
}

function writeBackup(root, name, question, answer) {
  const dir = path.join(root, "application_answers");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, name),
    `# Acme — PM\n\n- **Role**: PM\n- **Notes**: apply bot, truth-checked\n\n---\n\n## Q. ${question}\n\n${answer}\n`
  );
}

test("ratings file: missing → {}, round-trip, atomic (no tmp left), corrupt → throws", () => {
  const p = tmpProfile();
  const file = store.ratingsPath(p.paths.root);
  assert.equal(file, path.join(p.paths.root, ".answers", "ratings.json"));
  assert.deepEqual(store.readRatings(file), {});

  store.writeRatings(
    file,
    { [A]: { rating: 4, rated_at: "x", question_key: "k" }, bogus: { rating: 3 } },
    { now: new Date("2026-10-21T00:00:00Z") }
  );
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.updated_at, "2026-10-21T00:00:00.000Z");
  assert.deepEqual(store.readRatings(file), {
    [A]: { rating: 4, rated_at: "x", question_key: "k" },
  });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["ratings.json"]);

  fs.writeFileSync(file, "{oops");
  assert.throws(() => store.readRatings(file));
});

test("readLocalBackup: every .md in application_answers/, sorted by file name", () => {
  const p = tmpProfile();
  assert.deepEqual(store.readLocalBackup(store.backupDir(p.paths.root)), []);
  writeBackup(p.paths.root, "B_pm_20261002.md", "Q2?", "A2");
  writeBackup(p.paths.root, "A_pm_20261001.md", "Q1?", "A1");
  fs.writeFileSync(path.join(store.backupDir(p.paths.root), "notes.txt"), "ignored");
  const list = store.readLocalBackup(store.backupDir(p.paths.root));
  assert.deepEqual(
    list.map((e) => [e.pageId, e.question, e.answer, e.createdAt]),
    [
      ["local:A_pm_20261001.md#1", "Q1?", "A1", "2026-10-01"],
      ["local:B_pm_20261002.md#1", "Q2?", "A2", "2026-10-02"],
    ]
  );
});

test("readPreRecords: only apply_pre-*.json, broken files skipped", () => {
  const p = tmpProfile();
  const dir = path.join(p.paths.root, ".apply-state");
  assert.deepEqual(store.readPreRecords(dir), []);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "apply_pre-1.json"), JSON.stringify({ dry_run: false }));
  fs.writeFileSync(path.join(dir, "apply_pre-2.json"), "{half");
  fs.writeFileSync(path.join(dir, "apply_results-1.json"), JSON.stringify({ results: [] }));
  assert.deepEqual(store.readPreRecords(dir), [{ dry_run: false }]);
});

test("loadAnswerBank: Notion when configured, local backup without a token or on failure", async () => {
  const p = tmpProfile();
  writeBackup(p.paths.root, "A_pm_20261001.md", "Q1?", "A1");
  const calls = [];
  const notionDeps = {
    makeClient: (token) => ({ token }),
    fetchAllAnswers: async (client, dbId) => {
      calls.push([client.token, dbId]);
      return [{ pageId: A, question: "From Notion" }];
    },
  };

  const viaNotion = await store.loadAnswerBank({
    profile: p,
    secrets: { NOTION_TOKEN: "t" },
    deps: notionDeps,
  });
  assert.equal(viaNotion.source, "notion");
  assert.equal(viaNotion.notice, "");
  assert.deepEqual(calls, [["t", "qa-db"]]);
  assert.equal(viaNotion.entries[0].question, "From Notion");

  const noToken = await store.loadAnswerBank({ profile: p, secrets: {}, deps: notionDeps });
  assert.equal(noToken.source, "local");
  assert.equal(noToken.entries.length, 1);
  assert.match(noToken.notice, /Notion не настроен — показан локальный бэкап \(1\)/);
  assert.equal(calls.length, 1, "no Notion call without a token");

  const down = await store.loadAnswerBank({
    profile: p,
    secrets: { NOTION_TOKEN: "t" },
    deps: {
      makeClient: () => ({}),
      fetchAllAnswers: async () => {
        throw new Error("ECONNRESET");
      },
    },
  });
  assert.equal(down.source, "local");
  assert.equal(down.entries[0].question, "Q1?");
  assert.match(down.notice, /Notion недоступен \(ECONNRESET\) — показан локальный бэкап \(1\)/);
});
