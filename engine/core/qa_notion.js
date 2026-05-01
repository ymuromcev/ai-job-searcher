// Notion helpers for the Application Q&A database.
// Schema (matches scripts/stage16/migrate_application_qa.js + the live DB):
//   Question (title) | Answer (rich_text) | Category (select) |
//   Role (rich_text) | Company (rich_text) | Notes (rich_text)
//
// Module is pure w.r.t. profiles: accepts a Notion client + DB id, never
// reads env or the profile dir. The CLI is responsible for constructing
// the client via notion_sync.makeClient.

const { dedupKey } = require("./qa_dedup.js");
const { resolveDataSourceId } = require("./notion_sync.js");

const RICH_TEXT_CHUNK = 2000; // Notion rich_text item content limit.

// ---------- pure helpers (tested directly) ----------------------------------

function chunkRichText(value) {
  const s = String(value || "");
  if (!s) return [];
  const out = [];
  for (let i = 0; i < s.length; i += RICH_TEXT_CHUNK) {
    out.push({ type: "text", text: { content: s.slice(i, i + RICH_TEXT_CHUNK) } });
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
  };
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

// Returns { exact, partials } where:
//   exact = single answer matching dedup key, or null
//   partials = answers for same (company, role) but different question, or
//              same question but different (company, role) — deduplicated.
async function searchAnswers(client, databaseId, { company, role, question }) {
  const all = await fetchAllAnswers(client, databaseId);
  const targetKey = dedupKey({ company, role, question });
  const targetCo = String(company || "").trim().toLowerCase();
  const targetRo = String(role || "").trim().toLowerCase();
  const targetQu = String(question || "").trim().toLowerCase();

  let exact = null;
  const partials = [];
  for (const a of all) {
    const aKey = dedupKey({ company: a.company, role: a.role, question: a.question });
    if (aKey === targetKey) {
      // Exact match — first wins (DB shouldn't have duplicates anyway).
      if (!exact) exact = a;
      continue;
    }
    const aCo = String(a.company || "").trim().toLowerCase();
    const aRo = String(a.role || "").trim().toLowerCase();
    const aQu = String(a.question || "").trim().toLowerCase();
    const sameCoRole = aCo === targetCo && aRo === targetRo;
    const sameQuestion = aQu === targetQu;
    if (sameCoRole || sameQuestion) {
      partials.push(a);
    }
  }
  return { exact, partials };
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

module.exports = {
  // pure helpers
  chunkRichText,
  buildAnswerProperties,
  buildUpdateProperties,
  parseAnswerPage,
  // API ops
  fetchAllAnswers,
  searchAnswers,
  createAnswerPage,
  updateAnswerPage,
};
