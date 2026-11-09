// Notion helpers for the Application Q&A database.
// Schema (matches scripts/stage16/migrate_application_qa.js + the live DB):
//   Question (title) | Answer (rich_text) | Category (select) |
//   Role (rich_text) | Company (rich_text) | Notes (rich_text)
// Added by `questions --phase push` (RFC 070) when missing:
//   Status (select: Waiting for answer / Answered / Skip such jobs) |
//   Question key (rich_text) | Jobs (rich_text)
// Rows without a Status are ordinary bank answers. "Waiting for answer" and
// "Skip such jobs" rows are not answers (`isBankAnswer`).
//
// Module is pure w.r.t. profiles: accepts a Notion client + DB id, never
// reads env or the profile dir. The CLI is responsible for constructing
// the client via notion_sync.makeClient.

const { dedupKey } = require("./qa_dedup.js");
const { resolveDataSourceId } = require("./notion_sync.js");

const RICH_TEXT_CHUNK = 2000; // Notion rich_text item content limit.
// Notion allows 100 rich_text items per property; long job lists are cut.
const RICH_TEXT_MAX_ITEMS = 100;

// RFC 070: the owner's questions queue inside the Q&A database.
const QA_STATUS_PROP = "Status";
const QA_KEY_PROP = "Question key";
const QA_JOBS_PROP = "Jobs";
const QA_STATUS = Object.freeze({
  waiting: "Waiting for answer",
  answered: "Answered",
  skip: "Skip such jobs",
});
const QA_STATUS_COLORS = Object.freeze({
  [QA_STATUS.waiting]: "yellow",
  [QA_STATUS.answered]: "green",
  [QA_STATUS.skip]: "gray",
});

// ---------- pure helpers (tested directly) ----------------------------------

function chunkRichText(value) {
  const s = String(value || "");
  if (!s) return [];
  const out = [];
  for (let i = 0; i < s.length; i += RICH_TEXT_CHUNK) {
    out.push({ type: "text", text: { content: s.slice(i, i + RICH_TEXT_CHUNK) } });
    if (out.length >= RICH_TEXT_MAX_ITEMS) break;
  }
  return out;
}

function readTitle(prop) {
  return ((prop && prop.title) || []).map((t) => t.plain_text || "").join("");
}

function readRichText(prop) {
  return ((prop && prop.rich_text) || []).map((t) => t.plain_text || "").join("");
}

function readSelect(prop) {
  return prop && prop.select ? prop.select.name : null;
}

function buildAnswerProperties({ question, answer, category, role, company, notes }) {
  const props = {
    Question: { title: chunkRichText(question) },
    Answer: { rich_text: chunkRichText(answer) },
    Role: { rich_text: chunkRichText(role) },
    Company: { rich_text: chunkRichText(company) },
    Notes: { rich_text: chunkRichText(notes) },
  };
  if (category) {
    props.Category = { select: { name: String(category) } };
  }
  return props;
}

function buildUpdateProperties({ answer, category, notes }) {
  // Only updates fields that are explicitly present (undefined = leave as-is).
  const props = {};
  if (answer !== undefined) props.Answer = { rich_text: chunkRichText(answer) };
  if (notes !== undefined) props.Notes = { rich_text: chunkRichText(notes) };
  if (category !== undefined && category !== null) {
    props.Category = { select: { name: String(category) } };
  }
  return props;
}

function parseAnswerPage(page) {
  if (!page || typeof page !== "object") return null;
  const p = page.properties || {};
  return {
    pageId: page.id,
    url: page.url || null,
    question: readTitle(p.Question),
    answer: readRichText(p.Answer),
    category: readSelect(p.Category),
    role: readRichText(p.Role),
    company: readRichText(p.Company),
    notes: readRichText(p.Notes),
    // RFC 070 — null / "" on databases without these properties.
    status: readSelect(p[QA_STATUS_PROP]),
    questionKey: readRichText(p[QA_KEY_PROP]),
    jobs: readRichText(p[QA_JOBS_PROP]),
    // Page creation time — "newer first" ordering for the bot and the board.
    createdAt: page.created_time || null,
  };
}

// A real answer the bot may reuse: not a question waiting for the owner,
// not a "skip such jobs" rule, and not empty.
function isBankAnswer(entry) {
  if (!entry || !String(entry.answer || "").trim()) return false;
  return !isQueueEntry(entry);
}

// An entry of the owner's questions queue that is not an answer yet:
// "Waiting for answer" or a "Skip such jobs" rule.
function isQueueEntry(entry) {
  return Boolean(entry) && (entry.status === QA_STATUS.waiting || entry.status === QA_STATUS.skip);
}

// Properties of a "Waiting for answer" entry (RFC 070). Empty values are
// left out — Notion rejects some empty property values.
function buildPendingProperties({ question, key, jobs, companies, roles, category }) {
  const props = {
    Question: { title: chunkRichText(question) },
    [QA_STATUS_PROP]: { select: { name: QA_STATUS.waiting } },
    [QA_KEY_PROP]: { rich_text: chunkRichText(key) },
    [QA_JOBS_PROP]: { rich_text: chunkRichText(jobs) },
  };
  if (companies) props.Company = { rich_text: chunkRichText(companies) };
  if (roles) props.Role = { rich_text: chunkRichText(roles) };
  if (category) props.Category = { select: { name: String(category) } };
  return props;
}

function buildPendingUpdate({ jobs, companies, roles }) {
  const props = { [QA_JOBS_PROP]: { rich_text: chunkRichText(jobs) } };
  if (companies) props.Company = { rich_text: chunkRichText(companies) };
  if (roles) props.Role = { rich_text: chunkRichText(roles) };
  return props;
}

// Pure: what the data source schema lacks for RFC 070.
//   → { ok, properties: <dataSources.update payload> | null, error: string | null }
function pendingSchemaPatch(dataSource) {
  const props = (dataSource && dataSource.properties) || {};
  const patch = {};
  const status = props[QA_STATUS_PROP];
  const wanted = Object.values(QA_STATUS);
  if (!status) {
    patch[QA_STATUS_PROP] = {
      select: { options: wanted.map((name) => ({ name, color: QA_STATUS_COLORS[name] })) },
    };
  } else if (status.type === "select" || (status.select && !status.type)) {
    const options = (status.select && status.select.options) || [];
    const have = new Set(options.map((o) => o && o.name));
    const missing = wanted.filter((n) => !have.has(n));
    if (missing.length) {
      patch[QA_STATUS_PROP] = {
        select: {
          options: [
            ...options.map((o) => ({ name: o.name, ...(o.color ? { color: o.color } : {}) })),
            ...missing.map((name) => ({ name, color: QA_STATUS_COLORS[name] })),
          ],
        },
      };
    }
  } else {
    return {
      ok: false,
      properties: null,
      error: `property "${QA_STATUS_PROP}" exists with type "${status.type}" — needs a select`,
    };
  }
  for (const name of [QA_KEY_PROP, QA_JOBS_PROP]) {
    const p = props[name];
    if (!p) patch[name] = { rich_text: {} };
    else if (p.type && p.type !== "rich_text") {
      return {
        ok: false,
        properties: null,
        error: `property "${name}" exists with type "${p.type}" — needs rich text`,
      };
    }
  }
  return { ok: true, properties: Object.keys(patch).length ? patch : null, error: null };
}

// ---------- API ops --------------------------------------------------------

async function fetchAllAnswers(client, databaseId) {
  const dataSourceId = await resolveDataSourceId(client, databaseId);
  const out = [];
  let cursor;
  do {
    const params = { data_source_id: dataSourceId, page_size: 100 };
    if (cursor) params.start_cursor = cursor;
    const resp = await client.dataSources.query(params);
    for (const page of resp.results || []) {
      const parsed = parseAnswerPage(page);
      if (parsed) out.push(parsed);
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return out;
}

// Pure matcher over an already-fetched answer list. Returns { exact, partials }:
//   exact = single answer matching dedup key, or null
//   partials = answers for same (company, role) but different question, or
//              same question but different (company, role) — deduplicated.
// Exported so batch callers (`apply --phase pre`) can fetch the bank once
// and match many questions without re-querying Notion per question.
function matchAnswers(all, { company, role, question }) {
  const targetKey = dedupKey({ company, role, question });
  const targetCo = String(company || "")
    .trim()
    .toLowerCase();
  const targetRo = String(role || "")
    .trim()
    .toLowerCase();
  const targetQu = String(question || "")
    .trim()
    .toLowerCase();

  let exact = null;
  const partials = [];
  for (const a of all || []) {
    const aKey = dedupKey({ company: a.company, role: a.role, question: a.question });
    if (aKey === targetKey) {
      // Exact match — first wins (DB shouldn't have duplicates anyway).
      if (!exact) exact = a;
      continue;
    }
    const aCo = String(a.company || "")
      .trim()
      .toLowerCase();
    const aRo = String(a.role || "")
      .trim()
      .toLowerCase();
    const aQu = String(a.question || "")
      .trim()
      .toLowerCase();
    const sameCoRole = aCo === targetCo && aRo === targetRo;
    const sameQuestion = aQu === targetQu;
    if (sameCoRole || sameQuestion) {
      partials.push(a);
    }
  }
  return { exact, partials };
}

async function searchAnswers(client, databaseId, { company, role, question }) {
  // The owner's questions queue (RFC 070) is not something to reuse.
  const all = (await fetchAllAnswers(client, databaseId)).filter((e) => !isQueueEntry(e));
  return matchAnswers(all, { company, role, question });
}

async function createAnswerPage(client, databaseId, fields) {
  const resp = await client.pages.create({
    parent: { database_id: databaseId },
    properties: buildAnswerProperties(fields),
  });
  return resp;
}

async function updateAnswerPage(client, pageId, fields) {
  const resp = await client.pages.update({
    page_id: pageId,
    properties: buildUpdateProperties(fields),
  });
  return resp;
}

// Add the RFC 070 properties / status options the database lacks.
// → { changed: string[] } (names of added / extended properties). Throws
// when a property exists with the wrong type.
async function ensurePendingSchema(client, databaseId) {
  const dataSourceId = await resolveDataSourceId(client, databaseId);
  const ds = await client.dataSources.retrieve({ data_source_id: dataSourceId });
  const plan = pendingSchemaPatch(ds);
  if (!plan.ok) throw new Error(plan.error);
  if (!plan.properties) return { changed: [] };
  await client.dataSources.update({ data_source_id: dataSourceId, properties: plan.properties });
  return { changed: Object.keys(plan.properties) };
}

async function createPendingPage(client, databaseId, fields) {
  return client.pages.create({
    parent: { database_id: databaseId },
    properties: buildPendingProperties(fields),
  });
}

async function updatePendingPage(client, pageId, fields) {
  return client.pages.update({ page_id: pageId, properties: buildPendingUpdate(fields) });
}

module.exports = {
  QA_STATUS,
  QA_STATUS_PROP,
  QA_KEY_PROP,
  QA_JOBS_PROP,
  // pure helpers
  chunkRichText,
  buildAnswerProperties,
  buildUpdateProperties,
  parseAnswerPage,
  isBankAnswer,
  isQueueEntry,
  buildPendingProperties,
  buildPendingUpdate,
  pendingSchemaPatch,
  // API ops
  fetchAllAnswers,
  matchAnswers,
  searchAnswers,
  createAnswerPage,
  updateAnswerPage,
  ensurePendingSchema,
  createPendingPage,
  updatePendingPage,
};
