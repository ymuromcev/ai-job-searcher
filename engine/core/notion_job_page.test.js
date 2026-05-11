// engine/core/notion_job_page.test.js

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatSalaryDisplay,
  findExistingJobPage,
  pushJobPage,
} = require("./notion_job_page.js");
const { DEFAULT_PROPERTY_MAP } = require("./notion_sync.js");

// ---------- formatSalaryDisplay ----------

test("formatSalaryDisplay: range with mid", () => {
  assert.equal(formatSalaryDisplay(140000, 190000), "$140-190K ($165K mid)");
});

test("formatSalaryDisplay: min only", () => {
  assert.equal(formatSalaryDisplay(150000, null), "$150K+");
});

test("formatSalaryDisplay: max only", () => {
  assert.equal(formatSalaryDisplay(null, 200000), "up to $200K");
});

test("formatSalaryDisplay: both absent", () => {
  assert.equal(formatSalaryDisplay(null, null), "");
  assert.equal(formatSalaryDisplay("", ""), "");
  assert.equal(formatSalaryDisplay(undefined, undefined), "");
});

test("formatSalaryDisplay: string inputs (results.json comes through JSON.parse)", () => {
  assert.equal(formatSalaryDisplay("140000", "190000"), "$140-190K ($165K mid)");
});

test("formatSalaryDisplay: invalid inputs treated as absent", () => {
  assert.equal(formatSalaryDisplay("not-a-number", 100000), "up to $100K");
  assert.equal(formatSalaryDisplay(0, 0), "");
  assert.equal(formatSalaryDisplay(-1000, -2000), "");
});

test("formatSalaryDisplay: mid rounded to nearest $5K", () => {
  // (130 + 175) / 2 = 152.5 → rounds to 155 (nearest $5K)
  assert.equal(formatSalaryDisplay(130000, 175000), "$130-175K ($155K mid)");
});

// ---------- findExistingJobPage ----------

function makeClient(queryResults) {
  const calls = [];
  return {
    calls,
    dataSources: {
      async query(params) {
        calls.push(params);
        return { results: queryResults };
      },
    },
  };
}

test("findExistingJobPage: returns id when match found", async () => {
  const client = makeClient([{ id: "existing-page-id" }]);
  const id = await findExistingJobPage({
    client,
    jobsDataSourceId: "ds-1",
    propertyMap: DEFAULT_PROPERTY_MAP,
    key: "linkedin:abc123",
  });
  assert.equal(id, "existing-page-id");
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].data_source_id, "ds-1");
  assert.deepEqual(client.calls[0].filter, {
    property: "Key",
    rich_text: { equals: "linkedin:abc123" },
  });
});

test("findExistingJobPage: returns null when no match", async () => {
  const client = makeClient([]);
  const id = await findExistingJobPage({
    client,
    jobsDataSourceId: "ds-1",
    propertyMap: DEFAULT_PROPERTY_MAP,
    key: "linkedin:abc123",
  });
  assert.equal(id, null);
});

test("findExistingJobPage: empty key returns null without API call", async () => {
  const client = makeClient([{ id: "should-not-be-returned" }]);
  const id = await findExistingJobPage({
    client,
    jobsDataSourceId: "ds-1",
    propertyMap: DEFAULT_PROPERTY_MAP,
    key: "",
  });
  assert.equal(id, null);
  assert.equal(client.calls.length, 0);
});

test("findExistingJobPage: propertyMap without key field returns null", async () => {
  const client = makeClient([{ id: "should-not-be-returned" }]);
  const id = await findExistingJobPage({
    client,
    jobsDataSourceId: "ds-1",
    propertyMap: { title: { field: "Title", type: "title" } },
    key: "linkedin:abc123",
  });
  assert.equal(id, null);
  assert.equal(client.calls.length, 0);
});

// ---------- pushJobPage ----------

function makePushTestRig({
  existingPages = [],
  resolveReturns = "company-page-id",
  resolveThrows = null,
  createThrows = null,
}) {
  const calls = { query: [], resolve: [], create: [] };
  const client = {
    dataSources: {
      async query(params) {
        calls.query.push(params);
        return { results: existingPages };
      },
    },
  };
  const companyResolver = {
    async resolve(name) {
      calls.resolve.push(name);
      if (resolveThrows) throw resolveThrows;
      return resolveReturns;
    },
  };
  // DI shims for createJobPage / resolveDataSourceId.
  const createJobPage = async (c, dbId, job, map) => {
    calls.create.push({ dbId, job, map });
    if (createThrows) throw createThrows;
    return { id: "new-page-id" };
  };
  const resolveDataSourceId = async () => "ds-jobs";
  return { client, companyResolver, calls, createJobPage, resolveDataSourceId };
}

test("pushJobPage: happy path creates page with resolved company relation", async () => {
  const rig = makePushTestRig({});
  const result = await pushJobPage({
    client: rig.client,
    jobsDbId: "jobs-db",
    jobsDataSourceId: "ds-jobs",
    propertyMap: DEFAULT_PROPERTY_MAP,
    companyResolver: rig.companyResolver,
    jobFields: {
      key: "linkedin:abc",
      companyName: "Affirm",
      title: "Senior PM",
      url: "https://affirm.com/job/abc",
      status: "To Apply",
    },
    createJobPage: rig.createJobPage,
    resolveDataSourceId: rig.resolveDataSourceId,
  });
  assert.equal(result.pageId, "new-page-id");
  assert.equal(result.dedup, false);
  assert.equal(rig.calls.resolve.length, 1);
  assert.equal(rig.calls.resolve[0], "Affirm");
  assert.equal(rig.calls.create.length, 1);
  const createdJob = rig.calls.create[0].job;
  assert.deepEqual(createdJob.companyRelation, ["company-page-id"]);
  assert.equal(createdJob.companyName, undefined, "raw companyName must be stripped");
  assert.equal(createdJob.title, "Senior PM");
});

test("pushJobPage: dedup hit returns existing id, no resolve, no create", async () => {
  const rig = makePushTestRig({
    existingPages: [{ id: "existing-id" }],
  });
  const result = await pushJobPage({
    client: rig.client,
    jobsDbId: "jobs-db",
    jobsDataSourceId: "ds-jobs",
    propertyMap: DEFAULT_PROPERTY_MAP,
    companyResolver: rig.companyResolver,
    jobFields: { key: "linkedin:abc", companyName: "Affirm", title: "Senior PM" },
    createJobPage: rig.createJobPage,
    resolveDataSourceId: rig.resolveDataSourceId,
  });
  assert.equal(result.pageId, "existing-id");
  assert.equal(result.dedup, true);
  assert.equal(rig.calls.resolve.length, 0);
  assert.equal(rig.calls.create.length, 0);
});

test("pushJobPage: companyResolver returns null → page created without relation", async () => {
  const rig = makePushTestRig({ resolveReturns: null });
  const result = await pushJobPage({
    client: rig.client,
    jobsDbId: "jobs-db",
    jobsDataSourceId: "ds-jobs",
    propertyMap: DEFAULT_PROPERTY_MAP,
    companyResolver: rig.companyResolver,
    jobFields: { key: "linkedin:abc", companyName: "", title: "Senior PM" },
    createJobPage: rig.createJobPage,
    resolveDataSourceId: rig.resolveDataSourceId,
  });
  assert.equal(result.pageId, "new-page-id");
  const createdJob = rig.calls.create[0].job;
  assert.equal(createdJob.companyRelation, undefined);
});

test("pushJobPage: createJobPage failure propagates", async () => {
  const rig = makePushTestRig({ createThrows: new Error("Notion 503") });
  await assert.rejects(
    pushJobPage({
      client: rig.client,
      jobsDbId: "jobs-db",
      jobsDataSourceId: "ds-jobs",
      propertyMap: DEFAULT_PROPERTY_MAP,
      companyResolver: rig.companyResolver,
      jobFields: { key: "linkedin:abc", companyName: "Affirm", title: "Senior PM" },
      createJobPage: rig.createJobPage,
      resolveDataSourceId: rig.resolveDataSourceId,
    }),
    /Notion 503/
  );
});

test("pushJobPage: resolver failure propagates", async () => {
  const rig = makePushTestRig({ resolveThrows: new Error("companies db missing") });
  await assert.rejects(
    pushJobPage({
      client: rig.client,
      jobsDbId: "jobs-db",
      jobsDataSourceId: "ds-jobs",
      propertyMap: DEFAULT_PROPERTY_MAP,
      companyResolver: rig.companyResolver,
      jobFields: { key: "linkedin:abc", companyName: "Affirm", title: "Senior PM" },
      createJobPage: rig.createJobPage,
      resolveDataSourceId: rig.resolveDataSourceId,
    }),
    /companies db missing/
  );
});

test("pushJobPage: missing key throws (idempotency invariant)", async () => {
  const rig = makePushTestRig({});
  await assert.rejects(
    pushJobPage({
      client: rig.client,
      jobsDbId: "jobs-db",
      jobsDataSourceId: "ds-jobs",
      propertyMap: DEFAULT_PROPERTY_MAP,
      companyResolver: rig.companyResolver,
      jobFields: { companyName: "Affirm", title: "Senior PM" },
      createJobPage: rig.createJobPage,
      resolveDataSourceId: rig.resolveDataSourceId,
    }),
    /jobFields\.key is required/
  );
});

test("pushJobPage: lazy data_source resolution when jobsDataSourceId omitted", async () => {
  const rig = makePushTestRig({});
  let resolveCalled = 0;
  const resolveDataSourceId = async (_c, _dbId) => {
    resolveCalled++;
    return "ds-jobs-lazy";
  };
  await pushJobPage({
    client: rig.client,
    jobsDbId: "jobs-db",
    // jobsDataSourceId intentionally omitted
    propertyMap: DEFAULT_PROPERTY_MAP,
    companyResolver: rig.companyResolver,
    jobFields: { key: "linkedin:abc", companyName: "Affirm", title: "Senior PM" },
    createJobPage: rig.createJobPage,
    resolveDataSourceId,
  });
  assert.equal(resolveCalled, 1);
  assert.equal(rig.calls.query[0].data_source_id, "ds-jobs-lazy");
});

test("pushJobPage: profile-gated fields pass through to buildProperties (caller filters)", async () => {
  const rig = makePushTestRig({});
  // Profile WITHOUT schedule/requirements in property_map. The fields land
  // on the job payload, but buildProperties drops unmapped fields silently.
  // pushJobPage's job is just to assemble the payload; field filtering is
  // owned by buildProperties via the propertyMap shape.
  await pushJobPage({
    client: rig.client,
    jobsDbId: "jobs-db",
    jobsDataSourceId: "ds-jobs",
    propertyMap: DEFAULT_PROPERTY_MAP, // no schedule / requirements
    companyResolver: rig.companyResolver,
    jobFields: {
      key: "linkedin:abc",
      companyName: "Affirm",
      title: "Senior PM",
      schedule: "Full-time",
      requirements: "5+ years",
    },
    createJobPage: rig.createJobPage,
    resolveDataSourceId: rig.resolveDataSourceId,
  });
  const createdJob = rig.calls.create[0].job;
  assert.equal(createdJob.schedule, "Full-time", "payload retains extra fields");
  assert.equal(createdJob.requirements, "5+ years", "buildProperties decides what to push");
});
