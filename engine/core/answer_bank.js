// Answer bank ratings and views (RFC 068, BL-225 U7).
//
// Pure helpers over the answer bank (`qa_notion.fetchAllAnswers` entries, or
// entries parsed from the local `.md` backups) and the owner's ratings
// (`profiles/<id>/.answers/ratings.json`, read / written by
// answer_bank_store.js).
//
//   rankBank(bank, ratings)        → bank order for `apply --phase pre`:
//                                    rated 1–2 dropped, higher rated first,
//                                    then newer
//   buildBankView(entries, …)      → rows for the board tab «Банк ответов»
//   botBankStats(entries, …)       → the weekly report line
//   parseBackupMarkdown(text, f)   → entries from one local backup file
//   validateRatingInput(body)      → strict check of the board's POST body
//
// A rating is an integer 1..5 set by the owner. Unrated answers rank as a 3
// (neutral): a 4–5 beats them, a 1–2 is never reused.

const { dedupKey } = require("./qa_dedup.js");

const RATING_MIN = 1;
const RATING_MAX = 5;
const LOW_RATING_MAX = 2; // ≤ this → never reused by the bot
const NEUTRAL_RATING = 3; // where unrated answers sit in the ranking

const BOT_NOTES_RE = /\bapply bot\b/i;
const TRUTH_CHECKED_RE = /truth[- ]checked/i;

// Notion page ids (dashed or bare UUID) and local backup ids
// (`local:<backup file name>#<question number>`).
const NOTION_ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const LOCAL_ID_RE = /^local:[A-Za-z0-9._-]{1,200}\.md#\d{1,3}$/;

function str(v) {
  return v === undefined || v === null ? "" : String(v);
}

function isValidBankId(id) {
  return typeof id === "string" && (NOTION_ID_RE.test(id) || LOCAL_ID_RE.test(id));
}

function isLocalId(id) {
  return typeof id === "string" && id.startsWith("local:");
}

function isValidRating(r) {
  return Number.isInteger(r) && r >= RATING_MIN && r <= RATING_MAX;
}

function questionKey(entry) {
  return dedupKey({ company: entry.company, role: entry.role, question: entry.question });
}

function entryId(entry) {
  return str(entry && entry.pageId);
}

// --- ratings map -----------------------------------------------------------
//
// Shape (the `ratings` object inside ratings.json):
//   { "<bank id>": { rating: 1..5, rated_at: ISO, question_key: "co||role||q" } }

// Keep only well-formed entries; anything else in the file is ignored.
function normalizeRatings(raw) {
  const out = {};
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  for (const [id, v] of Object.entries(src)) {
    if (!isValidBankId(id) || !v || typeof v !== "object") continue;
    if (!isValidRating(v.rating)) continue;
    out[id] = {
      rating: v.rating,
      rated_at: str(v.rated_at),
      question_key: str(v.question_key),
    };
  }
  return out;
}

// New map with `id` rated (or cleared when rating is null).
function setRating(ratings, { id, rating, questionKey: qk = "", now = new Date() }) {
  if (!isValidBankId(id)) throw new Error(`invalid bank id: ${id}`);
  if (rating !== null && !isValidRating(rating)) throw new Error(`invalid rating: ${rating}`);
  const out = { ...normalizeRatings(ratings) };
  if (rating === null) {
    delete out[id];
  } else {
    out[id] = { rating, rated_at: new Date(now).toISOString(), question_key: str(qk) };
  }
  return out;
}

// Lookup index: by id, plus by question key for ratings set on a local-backup
// row (shown when Notion was unreachable) so they still reach the Notion row
// with the same company + role + question.
function indexRatings(ratings) {
  const byId = normalizeRatings(ratings);
  const byKey = new Map();
  for (const [id, v] of Object.entries(byId)) {
    if (isLocalId(id) && v.question_key && !byKey.has(v.question_key)) {
      byKey.set(v.question_key, v.rating);
    }
  }
  return { byId, byKey };
}

function ratingFor(entry, index) {
  const id = entryId(entry);
  if (id && index.byId[id]) return index.byId[id].rating;
  const viaKey = index.byKey.get(questionKey(entry));
  return viaKey === undefined ? null : viaKey;
}

// --- ranking for the bot ---------------------------------------------------

function timeOf(value) {
  const t = Date.parse(str(value));
  return Number.isNaN(t) ? -Infinity : t;
}

// Bank order for `apply --phase pre`. `matchAnswers` takes the first exact
// match and walks partials in order, so the order decides which answer wins
// when several match. Returns { bank, hidden } — hidden = dropped as 1–2.
function rankBank(bank, ratings) {
  const index = indexRatings(ratings);
  const kept = [];
  let hidden = 0;
  (Array.isArray(bank) ? bank : []).forEach((entry, i) => {
    const rating = ratingFor(entry, index);
    if (rating !== null && rating <= LOW_RATING_MAX) {
      hidden += 1;
      return;
    }
    kept.push({ entry, score: rating === null ? NEUTRAL_RATING : rating, i });
  });
  kept.sort(
    (a, b) =>
      b.score - a.score || timeOf(b.entry.createdAt) - timeOf(a.entry.createdAt) || a.i - b.i
  );
  return { bank: kept.map((k) => k.entry), hidden };
}

// --- origin ----------------------------------------------------------------

function isBotAnswer(entry) {
  return BOT_NOTES_RE.test(str(entry && entry.notes));
}

function originLabel(entry) {
  if (!isBotAnswer(entry)) return "свой";
  return TRUTH_CHECKED_RE.test(str(entry.notes)) ? "бот, проверен на правду" : "бот";
}

// --- uses ------------------------------------------------------------------

// How many distinct jobs took each bank answer, from the stamped
// `apply_pre-*.json` records (`bank_used: [{key, bank_page_id}]`). Dry runs
// do not count. → Map(bank id → count)
function countBankUses(preRecords) {
  const seen = new Map();
  for (const rec of Array.isArray(preRecords) ? preRecords : []) {
    if (!rec || rec.dry_run || !Array.isArray(rec.bank_used)) continue;
    for (const u of rec.bank_used) {
      const id = str(u && u.bank_page_id);
      const key = str(u && u.key);
      if (!id || !key) continue;
      if (!seen.has(id)) seen.set(id, new Set());
      seen.get(id).add(key);
    }
  }
  const out = new Map();
  for (const [id, keys] of seen) out.set(id, keys.size);
  return out;
}

// Bank answers a pre run filled for the jobs it queued.
function bankUsesFromJobs(jobs) {
  const out = [];
  for (const j of Array.isArray(jobs) ? jobs : []) {
    for (const a of j.answers || []) {
      if ((a.source === "bank" || a.source === "bank_reuse") && a.bank_page_id) {
        out.push({ key: j.key, bank_page_id: a.bank_page_id, source: a.source });
      }
    }
  }
  return out;
}

// --- board view ------------------------------------------------------------

function dayOf(value) {
  const m = str(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

// entries → rows for the page, newest first (undated rows last).
function buildBankView(entries, ratings, { uses } = {}) {
  const index = indexRatings(ratings);
  const useMap = uses instanceof Map ? uses : new Map();
  const rows = (Array.isArray(entries) ? entries : []).map((e, i) => {
    const id = entryId(e);
    return {
      id,
      question: str(e.question),
      answer: str(e.answer),
      company: str(e.company),
      role: str(e.role),
      category: str(e.category),
      notes: str(e.notes),
      origin: isBotAnswer(e) ? "bot" : "own",
      origin_label: originLabel(e),
      created_at: str(e.createdAt),
      date: dayOf(e.createdAt),
      uses: useMap.get(id) || 0,
      rating: ratingFor(e, index),
      ratable: isValidBankId(id),
      _i: i,
    };
  });
  rows.sort((a, b) => timeOf(b.created_at) - timeOf(a.created_at) || a._i - b._i);
  for (const r of rows) delete r._i;
  const rated = rows.filter((r) => r.rating !== null);
  return {
    rows,
    summary: {
      total: rows.length,
      bot: rows.filter((r) => r.origin === "bot").length,
      rated: rated.length,
      unrated: rows.length - rated.length,
      average: average(rated.map((r) => r.rating)),
    },
  };
}

function average(list) {
  if (!list.length) return null;
  return Math.round((list.reduce((s, n) => s + n, 0) / list.length) * 10) / 10;
}

// Bot answers among `entries` that `inPeriod(entry)` keeps →
// { added, rated, unrated, average }.
function botBankStats(entries, ratings, inPeriod = () => true) {
  const index = indexRatings(ratings);
  const list = (Array.isArray(entries) ? entries : []).filter((e) => isBotAnswer(e) && inPeriod(e));
  const scores = list.map((e) => ratingFor(e, index)).filter((r) => r !== null);
  return {
    added: list.length,
    rated: scores.length,
    unrated: list.length - scores.length,
    average: average(scores),
  };
}

// --- POST body -------------------------------------------------------------

// Body of POST /api/rating: exactly { id, rating } — rating 1..5, or null to
// clear. Returns { ok: true, id, rating } or { ok: false, error }.
function validateRatingInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "ожидался объект { id, rating }" };
  }
  const keys = Object.keys(body);
  if (keys.some((k) => k !== "id" && k !== "rating") || !keys.includes("id")) {
    return { ok: false, error: "ожидались только поля id и rating" };
  }
  if (!isValidBankId(body.id)) return { ok: false, error: "неверный id ответа" };
  const r = body.rating === undefined ? null : body.rating;
  if (r !== null && !isValidRating(r)) {
    return { ok: false, error: "оценка — целое число от 1 до 5 или null" };
  }
  return { ok: true, id: body.id, rating: r };
}

// --- local backup ----------------------------------------------------------
//
// Files written by `answer --phase push` (buildBackupMarkdown):
//   # <Company> — <Role>
//   - **Date saved**: <ISO>          (older files: **Date submitted**)
//   - **Role**: <role>
//   - **Category**: <category>
//   - **Notes**: <notes>
//   ---
//   ## Q. <question>                 (older files: ## Q1. / ## Q2. …)
//   <answer>
//   _(N chars)_

function backupMeta(lines, name) {
  const meta = {};
  for (const line of lines) {
    const m = line.match(/^- \*\*([^*]+)\*\*:\s*(.*)$/);
    if (m) meta[name(m[1])] = m[2].trim();
  }
  return meta;
}

function stampFromFilename(filename) {
  const m = str(filename).match(/_(\d{4})(\d{2})(\d{2})(?:_v\d+)?\.md$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

function cleanAnswer(lines) {
  const out = [...lines];
  const trim = () => {
    while (out.length && !out[out.length - 1].trim()) out.pop();
    while (out.length && !out[0].trim()) out.shift();
  };
  trim();
  if (out.length && /^---\s*$/.test(out[out.length - 1])) out.pop();
  trim();
  if (out.length && /^_\(\d+ chars\)_\s*$/.test(out[out.length - 1].trim())) out.pop();
  trim();
  return out.join("\n");
}

function parseBackupMarkdown(text, filename) {
  const lines = str(text).split(/\r?\n/);
  const firstQ = lines.findIndex((l) => /^## Q\d*\.\s/.test(l));
  if (firstQ === -1) return [];
  const head = lines.slice(0, firstQ);
  const meta = backupMeta(head, (k) => k.trim().toLowerCase());
  const title = (head.find((l) => /^# /.test(l)) || "").replace(/^# /, "").trim();
  const role = meta.role || "";
  let company = title;
  const suffix = role ? ` — ${role}` : "";
  if (suffix && title.endsWith(suffix)) company = title.slice(0, -suffix.length);
  else if (title.includes(" — ")) company = title.split(" — ")[0];
  const createdAt =
    meta["date saved"] || meta["date submitted"] || stampFromFilename(filename) || "";

  const entries = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const answer = cleanAnswer(current.body);
    if (current.question && answer) {
      entries.push({
        pageId: `local:${filename}#${entries.length + 1}`,
        url: null,
        question: current.question,
        answer,
        category: meta.category || null,
        role,
        company: company.trim(),
        notes: meta.notes || "",
        createdAt,
      });
    }
  };
  for (let i = firstQ; i < lines.length; i += 1) {
    const q = lines[i].match(/^## Q\d*\.\s+(.*)$/);
    if (q) {
      flush();
      current = { question: q[1].trim(), body: [] };
    } else if (current) {
      current.body.push(lines[i]);
    }
  }
  flush();
  return entries;
}

module.exports = {
  RATING_MIN,
  RATING_MAX,
  LOW_RATING_MAX,
  NEUTRAL_RATING,
  isValidBankId,
  isValidRating,
  isBotAnswer,
  originLabel,
  questionKey,
  normalizeRatings,
  setRating,
  indexRatings,
  ratingFor,
  rankBank,
  countBankUses,
  bankUsesFromJobs,
  buildBankView,
  botBankStats,
  validateRatingInput,
  parseBackupMarkdown,
};
