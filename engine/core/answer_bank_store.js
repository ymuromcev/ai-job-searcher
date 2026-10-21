// Answer bank on disk / over the network (RFC 068, BL-225 U7).
//
//   ratingsPath(profileRoot)        → profiles/<id>/.answers/ratings.json
//   readRatings(file)               → { "<bank id>": { rating, rated_at, question_key } }
//   writeRatings(file, ratings)     → atomic write (tmp + rename)
//   readLocalBackup(dir)            → entries parsed from application_answers/*.md
//   readPreRecords(stateDir)        → stamped apply_pre-*.json records
//   loadAnswerBank({ … })           → { entries, source, notice } — Notion when
//                                     the profile has a token and a DB id,
//                                     else (or when Notion fails) the local backup
//
// The ratings file is the source of truth for ratings; Notion is not written.

const fs = require("fs");
const path = require("path");

const { normalizeRatings, parseBackupMarkdown } = require("./answer_bank.js");

const ANSWERS_DIR = ".answers";
const RATINGS_FILE = "ratings.json";
const BACKUP_DIR = "application_answers";
const PRE_RECORD_RE = /^apply_pre-.+\.json$/;

function ratingsPath(profileRoot) {
  return path.join(profileRoot, ANSWERS_DIR, RATINGS_FILE);
}

function backupDir(profileRoot) {
  return path.join(profileRoot, BACKUP_DIR);
}

// Missing file → {}. A file that does not parse is an error: overwriting it
// with a fresh map would silently drop the owner's ratings.
function parseRatingsFile(text) {
  const data = JSON.parse(text);
  return normalizeRatings(data && data.ratings);
}

function readRatings(file, fsImpl = fs) {
  let text;
  try {
    text = fsImpl.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return {};
    throw err;
  }
  return parseRatingsFile(text);
}

function writeRatings(file, ratings, { fsImpl = fs, now = new Date() } = {}) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const body = {
    version: 1,
    updated_at: new Date(now).toISOString(),
    ratings: normalizeRatings(ratings),
  };
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fsImpl.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n");
  fsImpl.renameSync(tmp, file);
}

function readLocalBackup(dir, fsImpl = fs) {
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
    try {
      out.push(...parseBackupMarkdown(fsImpl.readFileSync(path.join(dir, name), "utf8"), name));
    } catch {
      // One unreadable file does not hide the rest of the bank.
    }
  }
  return out;
}

function readPreRecords(stateDir, fsImpl = fs) {
  let names;
  try {
    names = fsImpl.readdirSync(stateDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.filter((n) => PRE_RECORD_RE.test(n))) {
    try {
      out.push(JSON.parse(fsImpl.readFileSync(path.join(stateDir, name), "utf8")));
    } catch {
      // A half-written or foreign file is skipped.
    }
  }
  return out;
}

// Notion first (same source `apply --phase pre` uses), local backup otherwise.
//   deps: { makeClient(token), fetchAllAnswers(client, dbId), fsImpl? }
async function loadAnswerBank({ profile, secrets, deps }) {
  const dbId = profile && profile.notion && profile.notion.application_qa_db_id;
  const token = secrets && secrets.NOTION_TOKEN;
  const local = () => readLocalBackup(backupDir(profile.paths.root), deps.fsImpl || fs);
  if (!dbId || !token) {
    const entries = local();
    return {
      entries,
      source: "local",
      notice: `Notion не настроен — показан локальный бэкап (${entries.length})`,
    };
  }
  try {
    const entries = await deps.fetchAllAnswers(deps.makeClient(token), dbId);
    return { entries, source: "notion", notice: "" };
  } catch (err) {
    const entries = local();
    return {
      entries,
      source: "local",
      notice: `Notion недоступен (${err.message}) — показан локальный бэкап (${entries.length})`,
    };
  }
}

module.exports = {
  ANSWERS_DIR,
  RATINGS_FILE,
  ratingsPath,
  backupDir,
  parseRatingsFile,
  readRatings,
  writeRatings,
  readLocalBackup,
  readPreRecords,
  loadAnswerBank,
};
