const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { makeScanCommand, modulesToSources, applyTargetFilters, redactor } = require("./scan.js");

function captureOut() {
  const stdout = [];
  const stderr = [];
  return {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    write: (s) => stdout.push(s), // legacy alias
    lines: stdout,
    all: () => stdout.concat(stderr).join("\n"),
  };
}

function fakeJob(overrides = {}) {
  return {
    source: "greenhouse",
    slug: "affirm",
    jobId: "1",
    companyName: "Affirm",
    title: "Senior PM",
    url: "https://x/1",
    locations: ["SF"],
    team: "Product",
    postedAt: "2026-04-15",
    rawExtra: {},
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const calls = { saveJobs: [], saveApplications: [], scan: [], loadProfile: [] };
  const deps = {
    loadProfile: (id) => {
      calls.loadProfile.push(id);
      return {
        id,
        modules: ["discovery:greenhouse", "discovery:lever"],
        discovery: { companies_blacklist: [] },
        paths: { root: "/tmp/profiles/jared" },
      };
    },
    loadSecrets: () => ({ NOTION_TOKEN: "tok" }),
    loadCompanies: () => ({
      rows: [
        { name: "Affirm", source: "greenhouse", slug: "affirm", extra: null },
        { name: "Stripe", source: "lever", slug: "stripe", extra: null },
        { name: "Old", source: "ashby", slug: "old", extra: null },
      ],
    }),
    groupBySource: (rows) => {
      const out = {};
      for (const r of rows) {
        if (!out[r.source]) out[r.source] = [];
        out[r.source].push({ name: r.name, slug: r.slug });
      }
      return out;
    },
    loadJobs: () => ({ jobs: [] }),
    saveJobs: (file, jobs) => {
      calls.saveJobs.push({ file, count: jobs.length });
      return { path: file, count: jobs.length };
    },
    loadApplications: () => ({ apps: [] }),
    saveApplications: (file, apps) => {
      calls.saveApplications.push({ file, count: apps.length });
      return { path: file, count: apps.length };
    },
    appendNewApplications: (existing, jobs, opts = {}) => {
      // RFC 014 (2026-05-04): default flipped from "To Apply" to "Inbox" — the
      // fake mirrors the production default so tests exercise the same shape.
      const status = opts.defaultStatus || "Inbox";
      const seen = new Set(existing.map((a) => a.key));
      const fresh = [];
      for (const j of jobs) {
        const key = `${j.source}:${j.jobId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push({
          key,
          source: j.source,
          jobId: j.jobId,
          companyName: j.companyName,
          title: j.title,
          url: j.url,
          status,
          notion_page_id: "",
          resume_ver: "",
          cl_key: "",
          createdAt: "now",
          updatedAt: "now",
        });
      }
      return { apps: existing.concat(fresh), fresh };
    },
    appendRejectionsLog: (file, lines) => {
      calls.appendRejectionsLog = calls.appendRejectionsLog || [];
      calls.appendRejectionsLog.push({ file, lines });
    },
    scan: async ({ targetsBySource, adapters, existing, ctx }) => {
      calls.scan.push({ targetsBySource, adapters: Object.keys(adapters), existingCount: existing.length, ctx });
      return {
        fresh: [fakeJob({ jobId: "1" }), fakeJob({ source: "lever", slug: "stripe", jobId: "2", companyName: "Stripe" })],
        pool: [fakeJob({ jobId: "1" }), fakeJob({ source: "lever", slug: "stripe", jobId: "2", companyName: "Stripe" })],
        summary: { greenhouse: { total: 1, error: null }, lever: { total: 1, error: null } },
        errors: [],
      };
    },
    listAdapters: () => ["greenhouse", "lever", "ashby"],
    getAdapter: (src) => ({ source: src, discover: async () => [] }),
    now: () => "2026-04-20T00:00:00Z",
    ...overrides,
  };
  return { deps, calls };
}

function makeCtx(overrides = {}) {
  const out = captureOut();
  return {
    ctx: {
      command: "scan",
      profileId: "jared",
      flags: { dryRun: false, apply: false, verbose: false },
      env: { JARED_NOTION_TOKEN: "x" },
      stdout: out.stdout,
      stderr: out.stderr,
      profilesDir: "/tmp/profiles",
      dataDir: "/tmp/data",
      ...overrides,
    },
    out,
  };
}

test("scan dispatches enabled discovery modules and writes both files", async () => {
  const { deps, calls } = makeDeps();
  const { ctx, out } = makeCtx();
  const code = await makeScanCommand(deps)(ctx);
  assert.equal(code, 0);

  // Only greenhouse + lever are in profile.modules — ashby targets must be filtered out.
  const passedSources = Object.keys(calls.scan[0].targetsBySource).sort();
  assert.deepEqual(passedSources, ["greenhouse", "lever"]);
  // Adapter map mirrors that.
  assert.deepEqual(calls.scan[0].adapters.sort(), ["greenhouse", "lever"]);

  // ctx.secrets must be threaded through to the orchestrator.
  assert.equal(calls.scan[0].ctx.secrets.NOTION_TOKEN, "tok");

  assert.equal(calls.saveJobs.length, 1);
  assert.equal(calls.saveApplications.length, 1);
  assert.equal(calls.saveJobs[0].count, 2);
  assert.equal(calls.saveApplications[0].count, 2);
  assert.match(out.lines.join("\n"), /fresh jobs: 2/);
});

test("scan honours --dry-run by skipping writes", async () => {
  const { deps, calls } = makeDeps();
  const { ctx, out } = makeCtx({ flags: { dryRun: true, apply: false, verbose: false } });
  const code = await makeScanCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.equal(calls.saveJobs.length, 0);
  assert.equal(calls.saveApplications.length, 0);
  assert.match(out.lines.join("\n"), /\(dry-run\) would write 2 rows/);
  assert.match(out.lines.join("\n"), /\(dry-run\) would append 2 Inbox \+ 0 Archived rows/);
});

test("scan exits 1 when companies pool is empty", async () => {
  const { deps } = makeDeps({ loadCompanies: () => ({ rows: [] }) });
  const { ctx, out } = makeCtx();
  const code = await makeScanCommand(deps)(ctx);
  assert.equal(code, 1);
  assert.match(out.all(), /companies pool is empty/);
});

test("scan returns early when profile has no discovery modules", async () => {
  const { deps } = makeDeps({
    loadProfile: () => ({
      id: "jared",
      modules: ["tracking:gmail"],
      discovery: {},
      paths: { root: "/tmp/profiles/jared" },
    }),
  });
  const { ctx, out } = makeCtx();
  const code = await makeScanCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.match(out.lines.join("\n"), /no discovery modules enabled/);
});

test("scan warns about sources without registered adapter", async () => {
  const { deps } = makeDeps({
    loadProfile: () => ({
      id: "jared",
      modules: ["discovery:greenhouse", "discovery:lever", "discovery:ashby"],
      discovery: {},
      paths: { root: "/tmp/profiles/jared" },
    }),
    listAdapters: () => ["greenhouse", "lever"], // ashby missing
  });
  const { ctx, out } = makeCtx();
  await makeScanCommand(deps)(ctx);
  assert.match(out.all(), /no adapter for source "ashby"/);
});

test("modulesToSources extracts only discovery: entries", () => {
  assert.deepEqual(
    [...modulesToSources(["discovery:greenhouse", "tracking:gmail", "discovery:lever"])].sort(),
    ["greenhouse", "lever"]
  );
  assert.deepEqual([...modulesToSources([])], []);
  assert.deepEqual([...modulesToSources("nope")], []);
});

test("redactor masks secret values in error messages and ignores short ones", () => {
  const r = redactor(["sk-abcd1234longtoken", "ab"]); // short value "ab" should be ignored
  assert.equal(r("error: Authorization-Key sk-abcd1234longtoken invalid"),
    "error: Authorization-Key *** invalid");
  assert.equal(r("no abracadabra here"), "no abracadabra here"); // short value not redacted
  assert.equal(r(null), "");
  assert.equal(r(undefined), "");
});

test("scan --verbose prints the redactor mask count", async () => {
  const { deps } = makeDeps({
    loadSecrets: () => ({ NOTION_TOKEN: "ntn_longenough", SHORT: "ab", OTHER: "secret12345" }),
  });
  const { ctx, out } = makeCtx({ flags: { dryRun: true, apply: false, verbose: true } });
  await makeScanCommand(deps)(ctx);
  // "ab" is below the length-6 threshold, so 2 active masks.
  assert.match(out.all(), /redactor: 2 secret value\(s\) will be masked/);
});

test("scan is idempotent — second run without new jobs does not rewrite jobs.tsv", async () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aijs-scan-idem-"));
  const profilesDir = path.join(tmpRoot, "profiles");
  const dataDir = path.join(tmpRoot, "data");
  const profileDir = path.join(profilesDir, "jared");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "profile.json"),
    JSON.stringify({ id: "jared", modules: ["discovery:greenhouse"], discovery: {} })
  );
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "companies.tsv"),
    "name\tats_source\tats_slug\textra_json\nAffirm\tgreenhouse\taffirm\t\n"
  );

  const stubAdapter = {
    source: "greenhouse",
    discover: async () => [
      {
        source: "greenhouse",
        slug: "affirm",
        jobId: "777",
        companyName: "Affirm",
        title: "Stable PM",
        url: "https://x/777",
        locations: ["SF"],
        team: null,
        postedAt: "2026-04-15",
        rawExtra: {},
      },
    ],
  };
  const cmd = makeScanCommand({
    listAdapters: () => ["greenhouse"],
    getAdapter: () => stubAdapter,
    now: () => "2026-04-20T00:00:00Z",
  });
  const makeRunCtx = () => {
    const out = captureOut();
    return {
      out,
      ctx: {
        command: "scan",
        profileId: "jared",
        flags: { dryRun: false, apply: false, verbose: false },
        env: {},
        stdout: out.stdout,
        stderr: out.stderr,
        profilesDir,
        dataDir,
      },
    };
  };

  // First run — file is written.
  const first = makeRunCtx();
  const code1 = await cmd(first.ctx);
  assert.equal(code1, 0);
  const jobsPath = path.join(dataDir, "jobs.tsv");
  const firstSnapshot = fs.readFileSync(jobsPath, "utf8");
  const firstMtime = fs.statSync(jobsPath).mtimeMs;

  await new Promise((r) => setTimeout(r, 20)); // ensure the filesystem clock advances

  // Second run — no new jobs (stub returns the same id). File must not change.
  const second = makeRunCtx();
  const code2 = await cmd(second.ctx);
  assert.equal(code2, 0);
  const secondSnapshot = fs.readFileSync(jobsPath, "utf8");
  const secondMtime = fs.statSync(jobsPath).mtimeMs;
  assert.equal(secondSnapshot, firstSnapshot, "jobs.tsv content must not change on idempotent scan");
  assert.equal(secondMtime, firstMtime, "jobs.tsv mtime must not change on idempotent scan");
  assert.match(second.out.all(), /no new jobs — nothing to write/);
});

test("scan redacts secret values from adapter error messages", async () => {
  const secretVal = "ntn_super_secret_token_xyz";
  const { deps } = makeDeps({
    loadSecrets: () => ({ NOTION_TOKEN: secretVal }),
    scan: async () => ({
      fresh: [],
      pool: [],
      summary: { greenhouse: { total: 0, error: `HTTP 401 (token=${secretVal})` } },
      errors: [],
    }),
  });
  const { ctx, out } = makeCtx();
  await makeScanCommand(deps)(ctx);
  const joined = out.all();
  assert.doesNotMatch(joined, new RegExp(secretVal));
  assert.match(joined, /\*\*\*/);
});

test("applyTargetFilters honours whitelist + blacklist", () => {
  const grouped = {
    greenhouse: [{ name: "Affirm", slug: "affirm" }, { name: "Stripe", slug: "stripe" }],
    lever: [{ name: "Plaid", slug: "plaid" }],
  };
  const wl = applyTargetFilters(grouped, {
    discovery: { companies_whitelist: ["Affirm", "Plaid"] },
  });
  assert.equal(wl.greenhouse.length, 1);
  assert.equal(wl.greenhouse[0].name, "Affirm");
  assert.equal(wl.lever.length, 1);

  const bl = applyTargetFilters(grouped, {
    discovery: { companies_blacklist: ["stripe"] },
  });
  assert.equal(bl.greenhouse.length, 1);
  assert.equal(bl.greenhouse[0].name, "Affirm");
});

test("scan gates companies by profile column (RFC 010 cross-profile isolation)", async () => {
  // Regression for RFC 010 part B: shared data/companies.tsv now carries a
  // `profile` column. The scan command must filter rows by that column
  // BEFORE running adapters, replacing the brittle blacklist-on-Jared hack.
  const sharedRows = [
    { name: "PayPal", source: "workday", slug: "paypal", extra: null, profile: "jared" },
    { name: "Capital One (WD)", source: "workday", slug: "capitalone", extra: null, profile: "jared" },
    { name: "Sutter Health", source: "workday", slug: "sutterhealth", extra: null, profile: "lilia" },
    { name: "SCAN Health Plan", source: "workday", slug: "scanhealthplan", extra: null, profile: "lilia" },
    { name: "Public Co", source: "workday", slug: "publicco", extra: null, profile: "" },
  ];
  const seenByProfile = {};
  function makeProfileScan(profileId) {
    const { deps, calls } = makeDeps({
      loadProfile: (id) => ({
        id,
        modules: ["discovery:workday"],
        discovery: {},
        paths: { root: `/tmp/profiles/${id}` },
      }),
      loadCompanies: () => ({ rows: sharedRows }),
      listAdapters: () => ["workday"],
      getAdapter: () => ({ source: "workday", discover: async () => [] }),
      scan: async ({ targetsBySource }) => {
        seenByProfile[profileId] = (targetsBySource.workday || []).map((t) => t.name).sort();
        return { fresh: [], pool: [], summary: {}, errors: [] };
      },
    });
    return { deps, calls };
  }

  for (const profileId of ["jared", "lilia"]) {
    const { deps } = makeProfileScan(profileId);
    const { ctx } = makeCtx({ profileId });
    await makeScanCommand(deps)(ctx);
  }

  assert.deepEqual(seenByProfile.jared, ["Capital One (WD)", "PayPal", "Public Co"]);
  assert.deepEqual(seenByProfile.lilia, ["Public Co", "SCAN Health Plan", "Sutter Health"]);
});

test("scan injects synthetic feed target for feedMode adapters with no companies", async () => {
  // Profile enables "discovery:remoteok"; companies.tsv has no remoteok entries.
  // Scan command should inject { name: 'feed', slug: '__feed__' } and invoke the adapter.
  const feedJobs = [];
  const { deps } = makeDeps({
    loadProfile: () => ({
      id: "jared",
      modules: ["discovery:remoteok"],
      discovery: {},
      paths: { root: "/tmp/profiles/jared" },
    }),
    loadCompanies: () => ({ rows: [] }), // no companies at all
    listAdapters: () => ["remoteok"],
    getAdapter: (src) => ({
      source: src,
      discover: async (targets) => {
        feedJobs.push(...targets);
        return [];
      },
      feedMode: true,
    }),
    scan: async ({ targetsBySource }) => {
      // Verify synthetic target was injected before scan was called.
      assert.ok(targetsBySource.remoteok, "remoteok should be in targetsBySource");
      assert.equal(targetsBySource.remoteok[0].slug, "__feed__");
      return { fresh: [], pool: [], summary: { remoteok: { total: 0, error: null } }, errors: [] };
    },
  });
  const { ctx } = makeCtx();
  const code = await makeScanCommand(deps)(ctx);
  assert.equal(code, 0);
});

test("scan does NOT inject feed target for non-feed adapters with no companies", async () => {
  // Non-feedMode adapter + empty companies pool → no targets → companies pool error.
  const { deps } = makeDeps({
    loadProfile: () => ({
      id: "jared",
      modules: ["discovery:greenhouse"],
      discovery: {},
      paths: { root: "/tmp/profiles/jared" },
    }),
    loadCompanies: () => ({ rows: [] }), // no greenhouse companies
    listAdapters: () => ["greenhouse"],
    getAdapter: (src) => ({ source: src, discover: async () => [], feedMode: false }),
  });
  const { ctx, out } = makeCtx();
  const code = await makeScanCommand(deps)(ctx);
  assert.equal(code, 1);
  assert.match(out.all(), /companies pool is empty/);
});

test("scan integrates end-to-end against tmp filesystem with stub adapter", async () => {
  // Setup tmp profile + data dirs
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aijs-scan-"));
  const profilesDir = path.join(tmpRoot, "profiles");
  const dataDir = path.join(tmpRoot, "data");
  const profileDir = path.join(profilesDir, "jared");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "profile.json"),
    JSON.stringify({
      id: "jared",
      modules: ["discovery:greenhouse"],
      discovery: {},
    })
  );
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "companies.tsv"),
    "name\tats_source\tats_slug\textra_json\nAffirm\tgreenhouse\taffirm\t\n"
  );

  // Stub adapter returning one job
  const stubAdapter = {
    source: "greenhouse",
    discover: async () => [
      {
        source: "greenhouse",
        slug: "affirm",
        jobId: "999",
        companyName: "Affirm",
        title: "Live PM",
        url: "https://x/999",
        locations: ["SF"],
        team: "Product",
        postedAt: "2026-04-15",
        rawExtra: {},
      },
    ],
  };

  const cmd = makeScanCommand({
    listAdapters: () => ["greenhouse"],
    getAdapter: () => stubAdapter,
  });

  const out = captureOut();
  const code = await cmd({
    command: "scan",
    profileId: "jared",
    flags: { dryRun: false, apply: false, verbose: false },
    env: {},
    stdout: out.stdout,
    stderr: out.stderr,
    profilesDir,
    dataDir,
  });
  assert.equal(code, 0);

  const jobsTsvText = fs.readFileSync(path.join(dataDir, "jobs.tsv"), "utf8");
  assert.match(jobsTsvText, /Live PM/);
  const appsText = fs.readFileSync(path.join(profileDir, "applications.tsv"), "utf8");
  assert.match(appsText, /greenhouse:999/);
});

test("scan applies filter rules: passed → Inbox, rejected → Archived (incident 2026-05-04, RFC 014)", async () => {
  const { deps, calls } = makeDeps({
    loadProfile: () => ({
      id: "jared",
      modules: ["discovery:greenhouse", "discovery:lever"],
      discovery: {},
      filter_rules: {
        title_requirelist: [{ pattern: "product manager", reason: "PM role" }],
      },
      paths: { root: "/tmp/profiles/jared" },
    }),
    scan: async () => ({
      // 1 PM (passes), 1 SWE (rejected by requirelist)
      fresh: [
        fakeJob({ jobId: "1", title: "Senior Product Manager" }),
        fakeJob({ source: "lever", jobId: "2", companyName: "Stripe", title: "Software Engineer" }),
      ],
      pool: [fakeJob({ jobId: "1" }), fakeJob({ source: "lever", jobId: "2" })],
      summary: { greenhouse: { total: 1, error: null }, lever: { total: 1, error: null } },
      errors: [],
    }),
  });
  const { ctx, out } = makeCtx();
  const code = await makeScanCommand(deps)(ctx);
  assert.equal(code, 0);

  // Total saved = 2 (one passed + one rejected, both go to TSV)
  assert.equal(calls.saveApplications[0].count, 2);

  // Output reports filter summary with reason breakdown
  const log = out.lines.join("\n");
  assert.match(log, /filter: 1 passed, 1 rejected/);
  assert.match(log, /title_requirelist=1/);
  assert.match(log, /1 Inbox \+ 1 Archived/);

  // Rejection log received the SWE entry with proper kind
  assert.equal(calls.appendRejectionsLog.length, 1);
  assert.equal(calls.appendRejectionsLog[0].lines.length, 1);
  assert.equal(calls.appendRejectionsLog[0].lines[0].kind, "title_requirelist");
  assert.equal(calls.appendRejectionsLog[0].lines[0].title, "Software Engineer");
  assert.equal(calls.appendRejectionsLog[0].lines[0].source, "lever");
});

test("scan filter: adapter shape (companyName/title/locations[]) maps to filter shape (company/role/location)", async () => {
  // Inject a fake filterJobs that asserts the shape it receives.
  let observed = null;
  const { deps } = makeDeps({
    loadProfile: () => ({
      id: "jared",
      modules: ["discovery:greenhouse"],
      discovery: {},
      filter_rules: { _description: "anything truthy" },
      paths: { root: "/tmp/profiles/jared" },
    }),
    scan: async () => ({
      fresh: [
        fakeJob({
          jobId: "1",
          companyName: "AcmeCo",
          title: "Senior PM",
          locations: ["Remote, USA", "NYC"],
        }),
      ],
      pool: [fakeJob({ jobId: "1" })],
      summary: { greenhouse: { total: 1, error: null } },
      errors: [],
    }),
    filterJobs: (inputs) => {
      observed = inputs;
      // Pass everything through
      return { passed: inputs, rejected: [], finalCounts: {} };
    },
  });
  const { ctx } = makeCtx();
  await makeScanCommand(deps)(ctx);

  assert.ok(observed, "filterJobs not called");
  assert.equal(observed.length, 1);
  assert.equal(observed[0].company, "AcmeCo");
  assert.equal(observed[0].role, "Senior PM");
  assert.equal(observed[0].location, "Remote, USA"); // first of locations[]
  assert.ok(observed[0]._job, "back-ref to original adapter job missing");
  assert.equal(observed[0]._job.companyName, "AcmeCo");
});

test("scan filter: company_cap counts active rows from existing apps (active_statuses)", async () => {
  // Two existing apps for AcmeCo — one Applied (active), one Rejected (not active).
  // Cap=1 → next AcmeCo job rejected with kind=company_cap.
  const existingApps = [
    {
      key: "greenhouse:0",
      source: "greenhouse",
      jobId: "0",
      companyName: "AcmeCo",
      title: "PM",
      url: "",
      location: "",
      status: "Applied",
      notion_page_id: "",
      resume_ver: "",
      cl_key: "",
      salary_min: "",
      salary_max: "",
      cl_path: "",
      createdAt: "",
      updatedAt: "",
    },
    {
      key: "greenhouse:99",
      source: "greenhouse",
      jobId: "99",
      companyName: "AcmeCo",
      title: "Old PM",
      url: "",
      location: "",
      status: "Rejected", // not in active_statuses → does not count
      notion_page_id: "",
      resume_ver: "",
      cl_key: "",
      salary_min: "",
      salary_max: "",
      cl_path: "",
      createdAt: "",
      updatedAt: "",
    },
  ];
  const { deps, calls } = makeDeps({
    loadProfile: () => ({
      id: "jared",
      modules: ["discovery:greenhouse"],
      discovery: {},
      filter_rules: {
        company_cap: { max_active: 1 }, // active_statuses defaulted
      },
      paths: { root: "/tmp/profiles/jared" },
    }),
    loadApplications: () => ({ apps: existingApps }),
    scan: async () => ({
      fresh: [fakeJob({ jobId: "1", companyName: "AcmeCo", title: "New PM" })],
      pool: [fakeJob({ jobId: "1", companyName: "AcmeCo" })],
      summary: { greenhouse: { total: 1, error: null } },
      errors: [],
    }),
  });
  const { ctx, out } = makeCtx();
  await makeScanCommand(deps)(ctx);

  const log = out.lines.join("\n");
  assert.match(log, /company_cap=1/);
  // Only the Applied row counts as active; if the Rejected row had counted,
  // the cap=1 would already be reached even without the new job.
  assert.equal(calls.appendRejectionsLog[0].lines[0].kind, "company_cap");
});
