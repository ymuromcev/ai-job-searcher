const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  makeBackfillOutreachUrlCommand,
  selectBackfillCandidates,
  BACKFILL_STATUSES,
} = require("./backfill_outreach_url.js");

function captureOut() {
  const stdout = [];
  const stderr = [];
  return {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    lines: stdout,
    errLines: stderr,
    all: () => stdout.concat(stderr).join("\n"),
  };
}

function fakeApp(overrides = {}) {
  return {
    key: "greenhouse:1",
    source: "greenhouse",
    jobId: "1",
    companyName: "Affirm",
    title: "PM",
    url: "https://x/1",
    locations: ["Remote, US"],
    status: "To Apply",
    notion_page_id: "page-1",
    company_people_search_url: "",
    ...overrides,
  };
}

const URL_PROPERTY_MAP = {
  companyPeopleSearchUrl: { field: "LinkedIn Search", type: "url" },
};

function makeDeps(overrides = {}) {
  const calls = { saveApplications: [], updatePageUrl: [] };
  const deps = {
    loadProfile: () => ({
      id: "jared",
      paths: { root: "/tmp/profiles/jared" },
      notion: { jobs_pipeline_db_id: "db-123", property_map: URL_PROPERTY_MAP },
    }),
    loadSecrets: () => ({ NOTION_TOKEN: "tok" }),
    loadApplications: () => ({
      apps: [fakeApp({ jobId: "1", notion_page_id: "page-1" })],
    }),
    saveApplications: (file, apps) => {
      calls.saveApplications.push({ file, apps });
    },
    makeClient: () => ({}),
    updatePageUrl: async (client, pageId, updates, propertyMap) => {
      calls.updatePageUrl.push({ pageId, updates, propertyMap });
      return { id: pageId };
    },
    ...overrides,
  };
  return { deps, calls };
}

function makeCtx(overrides = {}) {
  const out = captureOut();
  return {
    out,
    ctx: {
      command: "backfill-outreach-url",
      profileId: "jared",
      flags: { dryRun: false, apply: false, verbose: false },
      env: { JARED_NOTION_TOKEN: "tok" },
      stdout: out.stdout,
      stderr: out.stderr,
      profilesDir: "/tmp/profiles",
      ...overrides,
    },
  };
}

// ---------- selectBackfillCandidates (pure) ----------

test("selectBackfillCandidates: picks To Apply / Applied with empty url + company", () => {
  const apps = [
    fakeApp({ key: "a", status: "To Apply", company_people_search_url: "" }),
    fakeApp({ key: "b", status: "Applied", company_people_search_url: "" }),
  ];
  const { candidates, skipped, alreadySet } = selectBackfillCandidates(apps);
  assert.deepEqual(
    candidates.map((c) => c.key),
    ["a", "b"]
  );
  assert.equal(skipped.length, 0);
  assert.equal(alreadySet.length, 0);
});

test("selectBackfillCandidates: empty company → skipped, not enriched", () => {
  const apps = [
    fakeApp({ key: "a", status: "To Apply", companyName: "", company_people_search_url: "" }),
    fakeApp({ key: "b", status: "Applied", companyName: "   ", company_people_search_url: "" }),
  ];
  const { candidates, skipped } = selectBackfillCandidates(apps);
  assert.equal(candidates.length, 0);
  assert.deepEqual(
    skipped.map((s) => s.key),
    ["a", "b"]
  );
});

test("selectBackfillCandidates: non-empty url → alreadySet (idempotency)", () => {
  const apps = [
    fakeApp({
      key: "a",
      status: "To Apply",
      company_people_search_url: "https://www.linkedin.com/search/results/people/?keywords=Affirm",
    }),
  ];
  const { candidates, alreadySet } = selectBackfillCandidates(apps);
  assert.equal(candidates.length, 0);
  assert.deepEqual(
    alreadySet.map((a) => a.key),
    ["a"]
  );
});

test("selectBackfillCandidates: ignores out-of-scope statuses entirely", () => {
  const apps = [
    fakeApp({ key: "inbox", status: "Inbox", company_people_search_url: "" }),
    fakeApp({ key: "rej", status: "Rejected", company_people_search_url: "" }),
    fakeApp({ key: "arch", status: "Archived", company_people_search_url: "" }),
    fakeApp({ key: "intv", status: "Interview", company_people_search_url: "" }),
    fakeApp({ key: "keep", status: "To Apply", company_people_search_url: "" }),
  ];
  const { candidates, skipped, alreadySet } = selectBackfillCandidates(apps);
  assert.deepEqual(
    candidates.map((c) => c.key),
    ["keep"]
  );
  assert.equal(skipped.length, 0);
  assert.equal(alreadySet.length, 0);
});

test("BACKFILL_STATUSES is exactly To Apply + Applied", () => {
  assert.deepEqual([...BACKFILL_STATUSES].sort(), ["Applied", "To Apply"]);
});

// ---------- command: dry-run ----------

test("dry-run defaults: prints counts, writes nothing, no Notion calls", async () => {
  const { deps, calls } = makeDeps({
    loadApplications: () => ({
      apps: [
        fakeApp({ key: "a", status: "To Apply", company_people_search_url: "" }),
        fakeApp({ key: "b", status: "Applied", companyName: "", company_people_search_url: "" }),
        fakeApp({
          key: "c",
          status: "Applied",
          company_people_search_url: "https://www.linkedin.com/x",
        }),
      ],
    }),
  });
  const { ctx, out } = makeCtx();
  const code = await makeBackfillOutreachUrlCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.equal(calls.saveApplications.length, 0);
  assert.equal(calls.updatePageUrl.length, 0);
  assert.match(out.all(), /would enrich 1, skip 1 \(no company\), already set 1/);
  assert.match(out.all(), /\(dry-run/);
});

// ---------- command: --apply writes TSV + Notion (mocked) ----------

test("--apply writes URL to TSV and pushes to Notion via targeted update", async () => {
  const { deps, calls } = makeDeps();
  const { ctx } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeBackfillOutreachUrlCommand(deps)(ctx);
  assert.equal(code, 0);

  // TSV saved once with the URL filled in.
  assert.equal(calls.saveApplications.length, 1);
  const saved = calls.saveApplications[0].apps;
  assert.equal(saved.length, 1);
  assert.match(saved[0].company_people_search_url, /linkedin\.com\/search\/results\/people/);
  assert.match(saved[0].company_people_search_url, /Affirm/);

  // Notion targeted update called once with the URL field only.
  assert.equal(calls.updatePageUrl.length, 1);
  assert.equal(calls.updatePageUrl[0].pageId, "page-1");
  assert.match(
    calls.updatePageUrl[0].updates.companyPeopleSearchUrl,
    /linkedin\.com\/search\/results\/people/
  );
});

test("--apply does not bump updatedAt (derived-field backfill, not a state change)", async () => {
  const { deps, calls } = makeDeps({
    loadApplications: () => ({
      apps: [fakeApp({ key: "a", updatedAt: "2026-01-01T00:00:00Z" })],
    }),
  });
  const { ctx } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  await makeBackfillOutreachUrlCommand(deps)(ctx);
  assert.equal(calls.saveApplications[0].apps[0].updatedAt, "2026-01-01T00:00:00Z");
});

// ---------- idempotency: second run is a no-op ----------

test("idempotent: second --apply run enriches nothing and skips Notion", async () => {
  // Simulate a TSV where the row already has a URL (i.e. the state after a
  // first run). The command should treat it as alreadySet and do no writes.
  const { deps, calls } = makeDeps({
    loadApplications: () => ({
      apps: [
        fakeApp({
          key: "a",
          status: "To Apply",
          company_people_search_url:
            "https://www.linkedin.com/search/results/people/?keywords=Affirm",
        }),
      ],
    }),
  });
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeBackfillOutreachUrlCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.equal(calls.saveApplications.length, 0);
  assert.equal(calls.updatePageUrl.length, 0);
  assert.match(out.all(), /already set 1/);
  assert.match(out.all(), /nothing to backfill/);
});

// ---------- skip on empty company under --apply ----------

test("--apply skips empty-company rows (no URL computed, no write)", async () => {
  const { deps, calls } = makeDeps({
    loadApplications: () => ({
      apps: [fakeApp({ key: "a", companyName: "", company_people_search_url: "" })],
    }),
  });
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeBackfillOutreachUrlCommand(deps)(ctx);
  assert.equal(code, 0);
  // No candidates → no save, no Notion call.
  assert.equal(calls.saveApplications.length, 0);
  assert.equal(calls.updatePageUrl.length, 0);
  assert.match(out.all(), /skip 1 \(no company\)/);
});

// ---------- Notion-skip paths ----------

test("--apply writes TSV but skips Notion when token missing", async () => {
  const { deps, calls } = makeDeps({ loadSecrets: () => ({}) });
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeBackfillOutreachUrlCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.equal(calls.saveApplications.length, 1);
  assert.equal(calls.updatePageUrl.length, 0);
  assert.match(out.all(), /NOTION_TOKEN/);
  assert.match(out.all(), /Notion push skipped/);
});

test("--apply writes TSV but skips Notion when property_map lacks the URL key", async () => {
  const { deps, calls } = makeDeps({
    loadProfile: () => ({
      id: "jared",
      paths: { root: "/tmp/profiles/jared" },
      notion: { jobs_pipeline_db_id: "db-123", property_map: {} },
    }),
  });
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeBackfillOutreachUrlCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.equal(calls.saveApplications.length, 1);
  assert.equal(calls.updatePageUrl.length, 0);
  assert.match(out.all(), /companyPeopleSearchUrl/);
});

test("--apply: Notion error on one row is counted and yields exit code 1, TSV still saved", async () => {
  const { deps, calls } = makeDeps({
    loadApplications: () => ({
      apps: [
        fakeApp({ key: "a", notion_page_id: "page-a" }),
        fakeApp({ key: "b", notion_page_id: "page-b" }),
      ],
    }),
    updatePageUrl: async (client, pageId) => {
      if (pageId === "page-b") throw new Error("rate limited");
      return { id: pageId };
    },
  });
  const { ctx, out } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeBackfillOutreachUrlCommand(deps)(ctx);
  assert.equal(code, 1);
  // TSV still saved with both URLs (TSV is canonical; Notion is a view).
  assert.equal(calls.saveApplications.length, 1);
  assert.equal(calls.saveApplications[0].apps.length, 2);
  assert.ok(calls.saveApplications[0].apps.every((a) => a.company_people_search_url));
  assert.match(out.all(), /1 Notion error/);
});

test("--apply skips Notion push for candidate rows without a notion_page_id", async () => {
  const { deps, calls } = makeDeps({
    loadApplications: () => ({
      apps: [fakeApp({ key: "a", notion_page_id: "" })],
    }),
  });
  const { ctx } = makeCtx({ flags: { dryRun: false, apply: true, verbose: false } });
  const code = await makeBackfillOutreachUrlCommand(deps)(ctx);
  assert.equal(code, 0);
  // URL still written to TSV.
  assert.equal(calls.saveApplications.length, 1);
  assert.ok(calls.saveApplications[0].apps[0].company_people_search_url);
  // No Notion call — no page to target.
  assert.equal(calls.updatePageUrl.length, 0);
});
