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
    { role: "PM", status: "Inbox", jobUrl: "https://x" },
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
      Status: { type: "select", select: { name: "Inbox" } },
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
