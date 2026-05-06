const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  makeClient,
  toPropertyValue,
  fromPropertyValue,
  buildProperties,
  parseNotionPage,
  createJobPage,
  updateJobPage,
  updatePageStatus,
  addPageComment,
  updateCalloutBlock,
  fetchJobsFromDatabase,
  resolveDataSourceId,
  readQueue,
  writeQueue,
  queueUpdate,
  clearQueue,
} = require("./notion_sync.js");

// ---------- Fake client (records calls, returns scripted responses) ----------

function makeFakeClient({
  createResponse = { id: "new-page-id" },
  updateResponse = { id: "updated-page-id" },
  queryPages = [],
  pageSize = 2,
  dataSourceId = "ds-default",
} = {}) {
  const calls = [];
  const pages = {
    create: async (params) => {
      calls.push({ method: "pages.create", params });
      return createResponse;
    },
    update: async (params) => {
      calls.push({ method: "pages.update", params });
      return updateResponse;
    },
  };
  // SDK v5: databases.retrieve returns the container + data_sources array.
  // Queries go through dataSources.query with a data_source_id.
  const databases = {
    retrieve: async (params) => {
      calls.push({ method: "databases.retrieve", params });
      return { id: params.database_id, data_sources: [{ id: dataSourceId }] };
    },
  };
  const dataSources = {
    query: async (params) => {
      calls.push({ method: "dataSources.query", params });
      const cursor = params.start_cursor ? Number(params.start_cursor) : 0;
      const slice = queryPages.slice(cursor, cursor + pageSize);
      const nextCursor = cursor + slice.length;
      return {
        results: slice,
        has_more: nextCursor < queryPages.length,
        next_cursor: String(nextCursor),
      };
    },
  };
  const comments = {
    create: async (params) => {
      calls.push({ method: "comments.create", params });
      return { id: "new-comment-id" };
    },
  };
  return { pages, databases, dataSources, comments, calls };
}

const PROPERTY_MAP = {
  role: { type: "title", field: "Role" },
  status: { type: "select", field: "Status" },
  jobUrl: { type: "url", field: "Job URL" },
  fitScore: { type: "select", field: "Fit Score" },
  salaryMin: { type: "number", field: "Salary Min" },
  dateAdded: { type: "date", field: "Date Added" },
  soqRequired: { type: "checkbox", field: "SOQ Required" },
  companyId: { type: "relation", field: "Company" },
  location: { type: "rich_text", field: "Location" },
  industry: { type: "multi_select", field: "Industry" },
};

// ---------- makeClient ----------

test("makeClient throws when token missing or non-string", () => {
  assert.throws(() => makeClient(), /token is required/);
  assert.throws(() => makeClient(""), /token is required/);
  assert.throws(() => makeClient(null), /token is required/);
  assert.throws(() => makeClient(42), /token is required/);
});

test("makeClient returns a Notion client instance when given a token", () => {
  const client = makeClient("test-token");
  assert.ok(client);
  assert.ok(client.pages);
  assert.ok(client.databases);
  assert.ok(client.dataSources);
});

// ---------- toPropertyValue ----------

test("toPropertyValue handles all supported types", () => {
  assert.deepEqual(toPropertyValue("Hello", "title"), {
    title: [{ text: { content: "Hello" } }],
  });
  assert.deepEqual(toPropertyValue("World", "rich_text"), {
    rich_text: [{ text: { content: "World" } }],
  });
  assert.deepEqual(toPropertyValue("Applied", "select"), { select: { name: "Applied" } });
  assert.deepEqual(toPropertyValue(["A", "B"], "multi_select"), {
    multi_select: [{ name: "A" }, { name: "B" }],
  });
  assert.deepEqual(toPropertyValue("https://x", "url"), { url: "https://x" });
  assert.deepEqual(toPropertyValue(150, "number"), { number: 150 });
  assert.deepEqual(toPropertyValue(true, "checkbox"), { checkbox: true });
  assert.deepEqual(toPropertyValue("2026-04-19", "date"), { date: { start: "2026-04-19" } });
  assert.deepEqual(toPropertyValue("abc-123", "relation"), {
    relation: [{ id: "abc-123" }],
  });
});

test("toPropertyValue returns null for null/undefined value", () => {
  assert.equal(toPropertyValue(null, "title"), null);
  assert.equal(toPropertyValue(undefined, "title"), null);
});

test("toPropertyValue throws on unknown type", () => {
  assert.throws(() => toPropertyValue("x", "bogus_type"), /unsupported notion property type/);
});

// ---------- fromPropertyValue ----------

test("fromPropertyValue roundtrips basic types", () => {
  assert.equal(fromPropertyValue({ type: "title", title: [{ plain_text: "Hello" }] }), "Hello");
  assert.equal(fromPropertyValue({ type: "select", select: { name: "Applied" } }), "Applied");
  assert.equal(fromPropertyValue({ type: "status", status: { name: "Open" } }), "Open");
  assert.deepEqual(
    fromPropertyValue({ type: "multi_select", multi_select: [{ name: "A" }, { name: "B" }] }),
    ["A", "B"]
  );
  assert.equal(fromPropertyValue({ type: "url", url: "https://x" }), "https://x");
  assert.equal(fromPropertyValue({ type: "number", number: 42 }), 42);
  assert.equal(fromPropertyValue({ type: "checkbox", checkbox: true }), true);
  assert.equal(fromPropertyValue({ type: "date", date: { start: "2026-01-01" } }), "2026-01-01");
  assert.deepEqual(
    fromPropertyValue({ type: "relation", relation: [{ id: "abc" }] }),
    ["abc"]
  );
});

test("fromPropertyValue returns null for missing/empty props", () => {
  assert.equal(fromPropertyValue(null), null);
  assert.equal(fromPropertyValue({ type: "select", select: null }), null);
  assert.equal(fromPropertyValue({ type: "url", url: null }), null);
});

// ---------- buildProperties / parseNotionPage roundtrip ----------

test("buildProperties skips undefined fields and maps known ones", () => {
  const job = {
    role: "Senior PM",
    status: "To Apply",
    jobUrl: "https://x",
    salaryMin: 180000,
    extraField: "ignored", // not in map
  };
  const props = buildProperties(job, PROPERTY_MAP);
  assert.ok(props["Role"]);
  assert.ok(props["Status"]);
  assert.ok(props["Job URL"]);
  assert.ok(props["Salary Min"]);
  assert.equal(props["Fit Score"], undefined); // not provided
  assert.equal(props["extraField"], undefined); // not mapped
});

test("buildProperties skips empty-string values (Notion rejects {url: ''})", () => {
  // Regression: during Stage 16 live migration, pushing a row with
  // jobUrl="" caused Notion to return 400 `body.properties.URL.url should
  // be populated or null, instead was ""`. Empty strings should be
  // treated the same as undefined/null — property omitted entirely.
  const job = {
    role: "Senior PM",
    status: "To Apply",
    jobUrl: "",
    salaryMin: 180000,
  };
  const props = buildProperties(job, PROPERTY_MAP);
  assert.ok(props["Role"]);
  assert.equal(props["Job URL"], undefined);
  assert.ok(props["Salary Min"]);
});

test("parseNotionPage extracts mapped properties back to job fields", () => {
  const page = {
    id: "page-123",
    properties: {
      Role: { type: "title", title: [{ plain_text: "Senior PM" }] },
      Status: { type: "select", select: { name: "Applied" } },
      "Job URL": { type: "url", url: "https://example.com" },
      "Salary Min": { type: "number", number: 200000 },
      "SOQ Required": { type: "checkbox", checkbox: true },
    },
  };
  const job = parseNotionPage(page, PROPERTY_MAP);
  assert.equal(job.notionPageId, "page-123");
  assert.equal(job.role, "Senior PM");
  assert.equal(job.status, "Applied");
  assert.equal(job.jobUrl, "https://example.com");
  assert.equal(job.salaryMin, 200000);
  assert.equal(job.soqRequired, true);
});

// ---------- createJobPage / updateJobPage ----------

test("createJobPage passes database_id and built properties to client", async () => {
  const client = makeFakeClient({ createResponse: { id: "abc-123" } });
  const result = await createJobPage(
    client,
    "db-xyz",
    { role: "PM", status: "To Apply", jobUrl: "https://x" },
    PROPERTY_MAP
  );
  assert.equal(result.id, "abc-123");
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].method, "pages.create");
  assert.deepEqual(client.calls[0].params.parent, { database_id: "db-xyz" });
  assert.ok(client.calls[0].params.properties["Role"]);
  assert.ok(client.calls[0].params.properties["Status"]);
  assert.ok(client.calls[0].params.properties["Job URL"]);
});

test("updateJobPage sends partial property update for a single page", async () => {
  const client = makeFakeClient();
  await updateJobPage(client, "page-xyz", { status: "Applied" }, PROPERTY_MAP);
  assert.equal(client.calls[0].method, "pages.update");
  assert.equal(client.calls[0].params.page_id, "page-xyz");
  assert.deepEqual(client.calls[0].params.properties["Status"], {
    select: { name: "Applied" },
  });
  assert.equal(Object.keys(client.calls[0].params.properties).length, 1);
});

// ---------- updatePageStatus / addPageComment ----------

test("updatePageStatus uses status property map + toPropertyValue", async () => {
  const client = makeFakeClient();
  const propertyMap = { status: { field: "Status", type: "status" } };
  await updatePageStatus(client, "page-1", "Rejected", propertyMap);
  assert.equal(client.calls[0].method, "pages.update");
  assert.equal(client.calls[0].params.page_id, "page-1");
  assert.deepEqual(client.calls[0].params.properties["Status"], {
    status: { name: "Rejected" },
  });
});

test("updatePageStatus falls back to default property map when omitted", async () => {
  const client = makeFakeClient();
  await updatePageStatus(client, "page-1", "Interview");
  assert.equal(client.calls[0].params.properties["Status"].status.name, "Interview");
});

test("updatePageStatus throws on missing args", async () => {
  const client = makeFakeClient();
  await assert.rejects(() => updatePageStatus(client, "", "Rejected"), /pageId is required/);
  await assert.rejects(() => updatePageStatus(client, "p1", ""), /newStatus is required/);
});

test("addPageComment sends rich_text to comments.create", async () => {
  const client = makeFakeClient();
  await addPageComment(client, "page-1", "❌ Отказ");
  assert.equal(client.calls[0].method, "comments.create");
  assert.deepEqual(client.calls[0].params.parent, { page_id: "page-1" });
  assert.equal(client.calls[0].params.rich_text[0].text.content, "❌ Отказ");
});

test("addPageComment throws on empty text", async () => {
  const client = makeFakeClient();
  await assert.rejects(() => addPageComment(client, "p1", ""), /comment text is required/);
  await assert.rejects(() => addPageComment(client, "p1", "   "), /comment text is required/);
});

test("addPageComment without mentionUserId emits text-only rich_text", async () => {
  const client = makeFakeClient();
  await addPageComment(client, "page-1", "❌ Отказ");
  const rt = client.calls[0].params.rich_text;
  assert.equal(rt.length, 1);
  assert.equal(rt[0].type, "text");
  assert.equal(rt[0].text.content, "❌ Отказ");
});

test("addPageComment with mentionUserId prepends @mention + space", async () => {
  const client = makeFakeClient();
  const userId = "2110f54d-8d9d-43c6-9d89-07594eb1a6ac";
  await addPageComment(client, "page-1", "❌ Отказ", userId);
  const rt = client.calls[0].params.rich_text;
  assert.equal(rt.length, 3);
  assert.equal(rt[0].type, "mention");
  assert.equal(rt[0].mention.type, "user");
  assert.equal(rt[0].mention.user.id, userId);
  assert.equal(rt[1].type, "text");
  assert.equal(rt[1].text.content, " ");
  assert.equal(rt[2].type, "text");
  assert.equal(rt[2].text.content, "❌ Отказ");
});

test("addPageComment with empty/whitespace mentionUserId falls back to text-only", async () => {
  const client = makeFakeClient();
  await addPageComment(client, "p1", "x", "");
  assert.equal(client.calls[0].params.rich_text.length, 1);
  await addPageComment(client, "p1", "x", "   ");
  assert.equal(client.calls[1].params.rich_text.length, 1);
  await addPageComment(client, "p1", "x", null);
  assert.equal(client.calls[2].params.rich_text.length, 1);
});

// ---------- updateCalloutBlock ----------

test("updateCalloutBlock sends correct callout rich_text to blocks.update", async () => {
  const calls = [];
  const client = {
    blocks: {
      update: async (params) => {
        calls.push(params);
        return { id: params.block_id };
      },
    },
  };
  await updateCalloutBlock(client, "block-abc", "Inbox: 42 | Updated: 2026-05-02");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].block_id, "block-abc");
  assert.deepEqual(calls[0].callout.rich_text, [
    { type: "text", text: { content: "Inbox: 42 | Updated: 2026-05-02" } },
  ]);
});

test("updateCalloutBlock throws on missing blockId", async () => {
  const client = { blocks: { update: async () => {} } };
  await assert.rejects(() => updateCalloutBlock(client, "", "text"), /blockId is required/);
  await assert.rejects(() => updateCalloutBlock(client, null, "text"), /blockId is required/);
});

test("updateCalloutBlock throws on missing text", async () => {
  const client = { blocks: { update: async () => {} } };
  await assert.rejects(
    () => updateCalloutBlock(client, "block-abc", ""),
    /text is required/
  );
});

// ---------- resolveDataSourceId ----------

test("resolveDataSourceId returns the first data_source id from the database", async () => {
  const client = makeFakeClient({ dataSourceId: "ds-abc" });
  const dsId = await resolveDataSourceId(client, "db-xyz");
  assert.equal(dsId, "ds-abc");
  assert.equal(client.calls[0].method, "databases.retrieve");
  assert.deepEqual(client.calls[0].params, { database_id: "db-xyz" });
});

test("resolveDataSourceId throws when database has no data_sources", async () => {
  const client = { databases: { retrieve: async () => ({ id: "db", data_sources: [] }) } };
  await assert.rejects(() => resolveDataSourceId(client, "db-xyz"), /no data_sources/);
});

// ---------- fetchJobsFromDatabase (pagination) ----------

test("fetchJobsFromDatabase resolves data_source and paginates via dataSources.query", async () => {
  const pages = Array.from({ length: 5 }, (_, i) => ({
    id: `page-${i}`,
    properties: {
      Role: { type: "title", title: [{ plain_text: `Role ${i}` }] },
      Status: { type: "select", select: { name: "To Apply" } },
    },
  }));
  const client = makeFakeClient({ queryPages: pages, pageSize: 2, dataSourceId: "ds-xyz" });

  const jobs = await fetchJobsFromDatabase(client, "db-xyz", PROPERTY_MAP);
  assert.equal(jobs.length, 5);
  assert.equal(jobs[0].role, "Role 0");
  assert.equal(jobs[4].role, "Role 4");
  // 1 retrieve + 3 dataSources.query (2+2+1)
  assert.equal(client.calls.length, 4);
  assert.equal(client.calls[0].method, "databases.retrieve");
  assert.equal(client.calls[1].method, "dataSources.query");
  assert.equal(client.calls[1].params.data_source_id, "ds-xyz");
});

test("fetchJobsFromDatabase forwards filter and sorts options to dataSources.query", async () => {
  const client = makeFakeClient({ queryPages: [], dataSourceId: "ds-xyz" });
  const filter = { property: "Status", select: { does_not_equal: "Archive" } };
  const sorts = [{ property: "Date Added", direction: "descending" }];
  await fetchJobsFromDatabase(client, "db-xyz", PROPERTY_MAP, { filter, sorts });
  const queryCall = client.calls.find((c) => c.method === "dataSources.query");
  assert.ok(queryCall, "expected a dataSources.query call");
  assert.deepEqual(queryCall.params.filter, filter);
  assert.deepEqual(queryCall.params.sorts, sorts);
  assert.equal(queryCall.params.data_source_id, "ds-xyz");
});

// ---------- Queue operations ----------

test("queueUpdate appends entries with queuedAt and readQueue returns them", () => {
  const tmp = path.join(os.tmpdir(), `queue-${process.pid}-${Date.now()}.json`);
  try {
    assert.deepEqual(readQueue(tmp), []);

    queueUpdate(tmp, { action: "update_status", pageId: "abc", status: "Applied" });
    queueUpdate(tmp, { action: "add_comment", pageId: "abc", text: "Hi" });

    const q = readQueue(tmp);
    assert.equal(q.length, 2);
    assert.equal(q[0].action, "update_status");
    assert.equal(q[0].pageId, "abc");
    assert.ok(q[0].queuedAt);
    assert.equal(q[1].action, "add_comment");
  } finally {
    clearQueue(tmp);
  }
});

test("queueUpdate requires entry.action", () => {
  const tmp = path.join(os.tmpdir(), `queue-bad-${process.pid}-${Date.now()}.json`);
  assert.throws(() => queueUpdate(tmp, { pageId: "abc" }), /action is required/);
});

test("clearQueue removes the queue file", () => {
  const tmp = path.join(os.tmpdir(), `queue-clear-${process.pid}-${Date.now()}.json`);
  writeQueue(tmp, [{ action: "x", queuedAt: "2026-01-01" }]);
  assert.ok(fs.existsSync(tmp));
  clearQueue(tmp);
  assert.equal(fs.existsSync(tmp), false);
});

test("readQueue throws on malformed JSON (non-array top level)", () => {
  const tmp = path.join(os.tmpdir(), `queue-bad-${process.pid}-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmp, '{"not":"an array"}');
    assert.throws(() => readQueue(tmp), /not a JSON array/);
  } finally {
    fs.unlinkSync(tmp);
  }
});

// ============================================================================
// Notion SDK v5 wire-shape pinning tests
//
// These tests pin the EXACT params object passed to each `@notionhq/client`
// method we depend on. Goal: a future `npm update @notionhq/client` (or any
// refactor that accidentally drops a required key / adds an unexpected one)
// fails in CI rather than in live smoke against a real workspace.
//
// The Stage 16 incident is the worst-case we want to prevent: SDK v5
// silently dropped `properties` from `databases.create({ properties })` —
// the fix was to move `properties` under `initial_data_source.properties`.
// We don't call `databases.create` from engine, but the same class of
// shape-drift can hit `pages.create` / `dataSources.query` / etc.
//
// Each test below calls a high-level engine function with a recording fake
// client and asserts (a) WHICH SDK method was invoked, (b) the EXACT shape
// of the params object — no extras, no missing keys.
// ============================================================================

const SUPPORTED_V5_METHODS = new Set([
  "pages.create",
  "pages.update",
  "databases.retrieve",
  "dataSources.query",
  "comments.create",
  "blocks.update",
]);

// Strict variant of makeFakeClient: throws on any SDK method we DON'T already
// depend on. If we accidentally introduce a call to e.g. `databases.query`
// (deprecated v4 path) or `users.list`, this test client trips immediately.
function makeStrictV5Client(scripted = {}) {
  const calls = [];
  const wrap = (group, method, defaultResp) => async (params) => {
    const fullName = `${group}.${method}`;
    if (!SUPPORTED_V5_METHODS.has(fullName)) {
      throw new Error(`unsupported SDK method called: ${fullName}`);
    }
    calls.push({ method: fullName, params });
    return scripted[fullName] ? scripted[fullName](params) : defaultResp;
  };
  return {
    pages: {
      create: wrap("pages", "create", { id: "new-page-id" }),
      update: wrap("pages", "update", { id: "updated-page-id" }),
    },
    databases: {
      retrieve: wrap("databases", "retrieve", {
        id: "db-id",
        data_sources: [{ id: "ds-default" }],
      }),
    },
    dataSources: {
      query: wrap("dataSources", "query", {
        results: [],
        has_more: false,
        next_cursor: null,
      }),
    },
    comments: {
      create: wrap("comments", "create", { id: "new-comment-id" }),
    },
    blocks: {
      update: wrap("blocks", "update", { id: "updated-block-id" }),
    },
    calls,
  };
}

test("v5 shape: createJobPage → pages.create({ parent: { database_id }, properties })", async () => {
  const client = makeStrictV5Client();
  await createJobPage(
    client,
    "db-xyz",
    { role: "PM", status: "To Apply" },
    PROPERTY_MAP
  );
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].method, "pages.create");
  const { params } = client.calls[0];
  // EXACT top-level keys: parent + properties only. No `database_id` at the
  // root, no `children`, no v4-style `created_time`.
  assert.deepEqual(Object.keys(params).sort(), ["parent", "properties"]);
  assert.deepEqual(Object.keys(params.parent), ["database_id"]);
  assert.equal(params.parent.database_id, "db-xyz");
  assert.equal(typeof params.properties, "object");
});

test("v5 shape: updateJobPage → pages.update({ page_id, properties })", async () => {
  const client = makeStrictV5Client();
  await updateJobPage(client, "page-xyz", { status: "Applied" }, PROPERTY_MAP);
  assert.equal(client.calls[0].method, "pages.update");
  const { params } = client.calls[0];
  // EXACT top-level keys: page_id + properties only. No `archived`, no
  // `parent`, no v4-style `properties.Status: 'Applied'` flat shape.
  assert.deepEqual(Object.keys(params).sort(), ["page_id", "properties"]);
  assert.equal(params.page_id, "page-xyz");
  // Property value MUST be the v5 nested shape, not v4 flat.
  assert.deepEqual(params.properties.Status, { select: { name: "Applied" } });
});

test("v5 shape: updatePageStatus → pages.update with single property update", async () => {
  const client = makeStrictV5Client();
  await updatePageStatus(client, "page-1", "Rejected", {
    status: { field: "Status", type: "status" },
  });
  assert.equal(client.calls[0].method, "pages.update");
  const { params } = client.calls[0];
  assert.deepEqual(Object.keys(params).sort(), ["page_id", "properties"]);
  // `status` (not `select`) is the correct v5 type for status-typed columns.
  assert.deepEqual(params.properties.Status, { status: { name: "Rejected" } });
  assert.equal(Object.keys(params.properties).length, 1);
});

test("v5 shape: resolveDataSourceId → databases.retrieve({ database_id }) returning { data_sources }", async () => {
  // Stage 7 follow-up: in v5, queries must target a `data_source_id` rather
  // than a `database_id`. The split happens at `databases.retrieve` time.
  // If a future SDK collapses this back, our test catches it because the
  // returned shape no longer has `data_sources`.
  const client = makeStrictV5Client();
  const dsId = await resolveDataSourceId(client, "db-xyz");
  assert.equal(client.calls[0].method, "databases.retrieve");
  assert.deepEqual(Object.keys(client.calls[0].params), ["database_id"]);
  assert.equal(client.calls[0].params.database_id, "db-xyz");
  assert.equal(dsId, "ds-default");
});

test("v5 shape: resolveDataSourceId throws if Notion returns 0 data_sources (defensive)", async () => {
  const client = makeStrictV5Client({
    "databases.retrieve": async (params) => ({
      id: params.database_id,
      data_sources: [],
    }),
  });
  await assert.rejects(
    () => resolveDataSourceId(client, "db-empty"),
    /has no data_sources/
  );
});

test("v5 shape: fetchJobsFromDatabase → databases.retrieve THEN dataSources.query (not databases.query)", async () => {
  // V4 used `databases.query({ database_id })`. V5 split this into a two-step
  // dance: retrieve to find data_source_id, then query the data source.
  // If someone refactors to call `databases.query`, makeStrictV5Client throws
  // because `databases.query` is not in SUPPORTED_V5_METHODS.
  const scriptedPages = [
    { id: "p1", properties: { Role: { type: "title", title: [{ plain_text: "PM 1" }] } } },
    { id: "p2", properties: { Role: { type: "title", title: [{ plain_text: "PM 2" }] } } },
  ];
  const client = makeStrictV5Client({
    "dataSources.query": async () => ({
      results: scriptedPages,
      has_more: false,
      next_cursor: null,
    }),
  });
  const jobs = await fetchJobsFromDatabase(client, "db-xyz", PROPERTY_MAP);
  assert.equal(jobs.length, 2);
  // Order: retrieve first, then query.
  assert.equal(client.calls[0].method, "databases.retrieve");
  assert.equal(client.calls[1].method, "dataSources.query");
  // dataSources.query params: only `data_source_id` + `page_size` are sent
  // when no filter/sorts/cursor — additive keys are opt-in.
  const queryParams = client.calls[1].params;
  assert.equal(queryParams.data_source_id, "ds-default");
  assert.equal(queryParams.page_size, 100);
  assert.equal(queryParams.filter, undefined);
  assert.equal(queryParams.sorts, undefined);
  assert.equal(queryParams.start_cursor, undefined);
});

test("v5 shape: fetchJobsFromDatabase forwards filter + sorts when supplied", async () => {
  const client = makeStrictV5Client();
  await fetchJobsFromDatabase(client, "db-xyz", PROPERTY_MAP, {
    filter: { property: "Status", select: { equals: "Applied" } },
    sorts: [{ property: "Date Added", direction: "descending" }],
  });
  const queryCall = client.calls.find((c) => c.method === "dataSources.query");
  assert.ok(queryCall);
  assert.deepEqual(queryCall.params.filter, {
    property: "Status",
    select: { equals: "Applied" },
  });
  assert.deepEqual(queryCall.params.sorts, [
    { property: "Date Added", direction: "descending" },
  ]);
});

test("v5 shape: addPageComment → comments.create({ parent: { page_id }, rich_text })", async () => {
  const client = makeStrictV5Client();
  await addPageComment(client, "page-1", "❌ Отказ");
  assert.equal(client.calls[0].method, "comments.create");
  const { params } = client.calls[0];
  // EXACT top-level keys: parent + rich_text only. No `discussion_id`,
  // no `block_id`, no v4 `comment_text` flat field.
  assert.deepEqual(Object.keys(params).sort(), ["parent", "rich_text"]);
  assert.deepEqual(Object.keys(params.parent), ["page_id"]);
  assert.equal(params.parent.page_id, "page-1");
  // rich_text is an array of objects with type "text"; content lives at
  // rich_text[N].text.content (v5 — not flat `text`).
  assert.ok(Array.isArray(params.rich_text));
  assert.equal(params.rich_text[0].type, "text");
  assert.equal(params.rich_text[0].text.content, "❌ Отказ");
});

test("v5 shape: addPageComment with mention prepends user mention block", async () => {
  const client = makeStrictV5Client();
  await addPageComment(client, "page-1", "review", "user-uuid-123");
  const richText = client.calls[0].params.rich_text;
  // Mention block first, then space, then the comment text.
  assert.equal(richText[0].type, "mention");
  assert.deepEqual(richText[0].mention, {
    type: "user",
    user: { id: "user-uuid-123" },
  });
  assert.equal(richText[1].type, "text");
  assert.equal(richText[1].text.content, " ");
  assert.equal(richText[2].type, "text");
  assert.equal(richText[2].text.content, "review");
});

test("v5 shape: updateCalloutBlock → blocks.update({ block_id, callout: { rich_text } })", async () => {
  const client = makeStrictV5Client();
  await updateCalloutBlock(client, "block-42", "Inbox: 5 | Updated: 2026-05-06");
  assert.equal(client.calls[0].method, "blocks.update");
  const { params } = client.calls[0];
  // EXACT top-level keys: block_id + callout only. The block-type discriminator
  // (`callout`) carries the partial payload — Notion merges it into the existing
  // block. No top-level `archived`, no `type`.
  assert.deepEqual(Object.keys(params).sort(), ["block_id", "callout"]);
  assert.equal(params.block_id, "block-42");
  // Callout body holds rich_text only — icon / color must NOT be sent (would
  // overwrite existing values to undefined).
  assert.deepEqual(Object.keys(params.callout), ["rich_text"]);
  assert.equal(params.callout.rich_text[0].text.content, "Inbox: 5 | Updated: 2026-05-06");
});

test("v5 shape: high-level ops do NOT call any unsupported SDK method", async () => {
  // Belt-and-braces: run all five high-level ops in sequence with strict
  // client. If any of them ever reach for `databases.query`, `users.list`,
  // `search`, etc., the strict client throws and the test fails.
  const client = makeStrictV5Client();
  await createJobPage(client, "db", { role: "PM" }, PROPERTY_MAP);
  await updateJobPage(client, "p1", { status: "Applied" }, PROPERTY_MAP);
  await updatePageStatus(client, "p1", "Interview", {
    status: { field: "Status", type: "status" },
  });
  await addPageComment(client, "p1", "hi");
  await updateCalloutBlock(client, "b1", "ok");
  await fetchJobsFromDatabase(client, "db", PROPERTY_MAP);
  // All calls are inside the supported set.
  for (const c of client.calls) {
    assert.ok(
      SUPPORTED_V5_METHODS.has(c.method),
      `unexpected SDK method: ${c.method}`
    );
  }
});

test("v5 shape: package.json pins @notionhq/client to v5.x (no accidental downgrade or v6 jump)", () => {
  // Read the engine's pinned range. We use caret-on-major-5 (^5.x) so patch +
  // minor updates are picked up automatically, but a major bump (v6) requires
  // explicit human review (and a refresh of these wire-shape tests).
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")
  );
  const range = (pkg.dependencies && pkg.dependencies["@notionhq/client"]) || "";
  assert.match(
    range,
    /^\^5\./,
    `@notionhq/client must stay on a v5.x range; got "${range}". ` +
      `If you intentionally bumped to v6, refresh the wire-shape tests in this file first.`
  );
});
