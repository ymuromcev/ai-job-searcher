// Notion integration — hybrid model (per RFC 001):
//   - Direct API (@notionhq/client) for create/read (used by scan, prepare, sync).
//   - Queue file for updates (picked up later by Claude via MCP) — used by check-emails flow.
//
// This module is pure w.r.t. profiles: it accepts a Notion client, a database id,
// a property map, and job data. It does NOT read the profile directory or env.
// The CLI is responsible for loading profile data and constructing the client.

const { Client } = require("@notionhq/client");
const fs = require("fs");

// ---------- Client factory ----------

function makeClient(token) {
  if (!token || typeof token !== "string") {
    throw new Error("Notion token is required (non-empty string)");
  }
  return new Client({ auth: token });
}

// ---------- Property conversion (generic, type-driven) ----------

function toPropertyValue(value, type) {
  if (value === undefined || value === null) return null;
  switch (type) {
    case "title":
      return { title: [{ text: { content: String(value) } }] };
    case "rich_text":
      return { rich_text: [{ text: { content: String(value) } }] };
    case "select":
      return { select: { name: String(value) } };
    case "status":
      return { status: { name: String(value) } };
    case "multi_select": {
      const arr = Array.isArray(value) ? value : [value];
      return { multi_select: arr.map((v) => ({ name: String(v) })) };
    }
    case "url":
      return { url: String(value) };
    case "email":
      return { email: String(value) };
    case "phone_number":
      return { phone_number: String(value) };
    case "number":
      return { number: Number(value) };
    case "checkbox":
      return { checkbox: Boolean(value) };
    case "date":
      return { date: { start: String(value) } };
    case "relation": {
      const arr = Array.isArray(value) ? value : [value];
      return { relation: arr.map((id) => ({ id: String(id) })) };
    }
    default:
      throw new Error(`unsupported notion property type: ${type}`);
  }
}

function fromPropertyValue(prop) {
  if (!prop || !prop.type) return null;
  switch (prop.type) {
    case "title":
      return (prop.title || []).map((t) => t.plain_text || "").join("");
    case "rich_text":
      return (prop.rich_text || []).map((t) => t.plain_text || "").join("");
    case "select":
      return prop.select ? prop.select.name : null;
    case "status":
      return prop.status ? prop.status.name : null;
    case "multi_select":
      return (prop.multi_select || []).map((x) => x.name);
    case "url":
      return prop.url || null;
    case "email":
      return prop.email || null;
    case "phone_number":
      return prop.phone_number || null;
    case "number":
      return prop.number;
    case "checkbox":
      return Boolean(prop.checkbox);
    case "date":
      return prop.date ? prop.date.start : null;
    case "relation":
      return (prop.relation || []).map((r) => r.id);
    default:
      return null;
  }
}

function buildProperties(job, propertyMap) {
  if (!job || typeof job !== "object") throw new Error("job must be an object");
  if (!propertyMap || typeof propertyMap !== "object") {
    throw new Error("propertyMap must be an object");
  }
  const props = {};
  for (const [jobField, mapping] of Object.entries(propertyMap)) {
    const value = job[jobField];
    // Skip empty values. Notion API rejects {url: ""}, {email: ""}, etc.
    // for scalar types — it wants `null` (or the property omitted entirely,
    // which is what we do here). Empty string is never a meaningful value
    // for the field types we push, so treat it the same as missing.
    if (value === undefined || value === null || value === "") continue;
    const pv = toPropertyValue(value, mapping.type);
    if (pv !== null) props[mapping.field] = pv;
  }
  return props;
}

function parseNotionPage(page, propertyMap) {
  if (!page || typeof page !== "object") throw new Error("page must be an object");
  const result = { notionPageId: page.id };
  const properties = page.properties || {};
  for (const [jobField, mapping] of Object.entries(propertyMap)) {
    const prop = properties[mapping.field];
    const v = fromPropertyValue(prop);
    if (v !== null && v !== undefined) result[jobField] = v;
  }
  return result;
}

// ---------- High-level API ops ----------

async function createJobPage(client, databaseId, job, propertyMap) {
  return client.pages.create({
    parent: { database_id: databaseId },
    properties: buildProperties(job, propertyMap),
  });
}

async function updateJobPage(client, pageId, updates, propertyMap) {
  return client.pages.update({
    page_id: pageId,
    properties: buildProperties(updates, propertyMap),
  });
}

async function resolveDataSourceId(client, databaseId) {
  // Notion SDK v5 split databases into a container + data_sources. Queries now
  // target a data_source_id, not a database_id. We keep `database_id` as the
  // user-facing config and resolve the data_source_id at call time. Databases
  // created through the UI or the API expose at least one data_source.
  const db = await client.databases.retrieve({ database_id: databaseId });
  const sources = Array.isArray(db && db.data_sources) ? db.data_sources : [];
  if (!sources.length) {
    throw new Error(`database ${databaseId} has no data_sources`);
  }
  return sources[0].id;
}

async function fetchJobsFromDatabase(client, databaseId, propertyMap, queryOptions = {}) {
  const dataSourceId = await resolveDataSourceId(client, databaseId);
  const jobs = [];
  let cursor;
  do {
    const params = { data_source_id: dataSourceId, page_size: 100 };
    if (cursor) params.start_cursor = cursor;
    if (queryOptions.filter) params.filter = queryOptions.filter;
    if (queryOptions.sorts) params.sorts = queryOptions.sorts;

    const resp = await client.dataSources.query(params);
    for (const page of resp.results || []) {
      jobs.push(parseNotionPage(page, propertyMap));
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return jobs;
}

// ---------- Targeted updates used by `check` command ----------

// Writes a single Status change to an existing page. The check command uses
// this instead of updateJobPage because we only ever change Status (and want
// the call to be small and rate-limit-friendly).
async function updatePageStatus(client, pageId, newStatus, propertyMap) {
  if (!pageId) throw new Error("pageId is required");
  if (!newStatus) throw new Error("newStatus is required");
  const mapping = (propertyMap && propertyMap.status) || { field: "Status", type: "status" };
  const pv = toPropertyValue(newStatus, mapping.type);
  return client.pages.update({
    page_id: pageId,
    properties: { [mapping.field]: pv },
  });
}

// Adds a page-level comment. Notion SDK v5: client.comments.create.
// If `mentionUserId` (UUID) is supplied, the comment starts with an @mention
// of that user — Notion sends them a push/email notification. Without it,
// integration-authored comments are silent.
async function addPageComment(client, pageId, text, mentionUserId = null) {
  if (!pageId) throw new Error("pageId is required");
  if (!text || !String(text).trim()) throw new Error("comment text is required");
  const richText = [];
  if (mentionUserId && typeof mentionUserId === "string" && mentionUserId.trim()) {
    richText.push({
      type: "mention",
      mention: { type: "user", user: { id: mentionUserId.trim() } },
    });
    richText.push({ type: "text", text: { content: " " } });
  }
  richText.push({ type: "text", text: { content: String(text) } });
  return client.comments.create({
    parent: { page_id: pageId },
    rich_text: richText,
  });
}

// ---------- Queue file (updates applied by Claude via MCP) ----------
// Format: JSON array of { action, pageId?, databaseId?, job?, updates?, queuedAt }.

function readQueue(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  const raw = fs.readFileSync(queuePath, "utf8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`queue file is not a JSON array: ${queuePath}`);
  }
  return parsed;
}

function writeQueue(queuePath, entries) {
  if (!Array.isArray(entries)) throw new Error("entries must be an array");
  fs.writeFileSync(queuePath, JSON.stringify(entries, null, 2));
}

function queueUpdate(queuePath, entry) {
  if (!entry || typeof entry !== "object") throw new Error("entry must be an object");
  if (!entry.action) throw new Error("entry.action is required");
  const queue = readQueue(queuePath);
  queue.push({ ...entry, queuedAt: new Date().toISOString() });
  writeQueue(queuePath, queue);
  return queue.length;
}

function clearQueue(queuePath) {
  if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath);
}

module.exports = {
  makeClient,
  toPropertyValue,
  fromPropertyValue,
  buildProperties,
  parseNotionPage,
  createJobPage,
  updateJobPage,
  updatePageStatus,
  addPageComment,
  fetchJobsFromDatabase,
  resolveDataSourceId,
  readQueue,
  writeQueue,
  queueUpdate,
  clearQueue,
};
