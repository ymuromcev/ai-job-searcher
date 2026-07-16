const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { makeAddCommand, backupPath } = require("./add.js");
const applicationsTsv = require("../core/applications_tsv.js");

const NOW = "2026-07-16T12:00:00.000Z";
const PAGE_ID = "39fd3a02-26ca-81d7-8f7a-c9ebab8f9565";

function makeTmpProfile(rows = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "add-test-"));
  const tsvPath = path.join(root, "applications.tsv");
  applicationsTsv.save(tsvPath, rows);
  fs.writeFileSync(
    path.join(root, "profile.json"),
    `${JSON.stringify({ id: "t", company_tiers: { Existing: "A" } }, null, 2)}\n`,
    "utf8"
  );
  return { root, tsvPath };
}

const PROFILE = (root) => ({
  id: "t",
  paths: { root },
  company_tiers: {},
  notion: {
    jobs_pipeline_db_id: "jobs-db",
    companies_db_id: "companies-db",
    property_map: { key: { field: "Key", type: "rich_text" } },
  },
});

// Collects stdout/stderr and records what the fakes were asked to do.
function harness(overrides = {}, rows = []) {
  const { root, tsvPath } = makeTmpProfile(rows);
  const out = [];
  const err = [];
  const calls = { pushJobPage: [], resolveDataSourceId: 0, makeClient: 0 };

  const deps = {
    loadProfile: () => PROFILE(root),
    loadSecrets: () => ({ NOTION_TOKEN: "secret_test" }),
    makeClient: () => {
      calls.makeClient++;
      return { fake: true };
    },
    resolveDataSourceId: async () => {
      calls.resolveDataSourceId++;
      return "companies-ds";
    },
    makeCompanyResolver: () => ({ resolve: async () => "company-page-id" }),
    pushJobPage: async (args) => {
      calls.pushJobPage.push(args);
      return { pageId: PAGE_ID, dedup: false };
    },
    now: () => NOW,
    ...overrides,
  };

  const cmd = makeAddCommand(deps);
  const ctx = (flags) => ({
    profileId: "t",
    flags,
    env: {},
    stdout: (m) => out.push(String(m)),
    stderr: (m) => err.push(String(m)),
  });

  return { cmd, ctx, out, err, calls, root, tsvPath };
}

const BASE_FLAGS = {
  company: "LawnStarter",
  title: "Senior Product Manager, Pricing & Monetization",
  status: "Interview",
  salary: "140000-185000",
  locations: "Remote,United States",
};

function readRows(tsvPath) {
  return applicationsTsv.load(tsvPath).apps;
}

// ---------- dry-run ----------

test("dry-run is the default: no client, no TSV write", async () => {
  const h = harness();
  const before = fs.readFileSync(h.tsvPath, "utf8");

  const code = await h.cmd(h.ctx({ ...BASE_FLAGS }));

  assert.equal(code, 0);
  assert.equal(h.calls.makeClient, 0, "no Notion client in dry-run");
  assert.equal(h.calls.pushJobPage.length, 0, "no page push in dry-run");
  assert.equal(fs.readFileSync(h.tsvPath, "utf8"), before, "TSV untouched");
  assert.match(h.out.join("\n"), /would add/);
  assert.match(h.out.join("\n"), /dry-run/);
});

test("dry-run renders the planned row", async () => {
  const h = harness();
  await h.cmd(h.ctx({ ...BASE_FLAGS }));
  const text = h.out.join("\n");
  assert.match(text, /manual:lawnstarter_senior-product-manager-pricing-monetization_2026-07-16/);
  assert.match(text, /status:\s+Interview/);
  assert.match(text, /\$140-185K \(\$165K mid\)/);
});

// ---------- happy path ----------

test("--apply creates the page and persists notion_page_id", async () => {
  const h = harness();

  const code = await h.cmd(h.ctx({ ...BASE_FLAGS, apply: true }));

  assert.equal(code, 0);
  assert.equal(h.calls.pushJobPage.length, 1);

  const rows = readRows(h.tsvPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].companyName, "LawnStarter");
  assert.equal(rows[0].status, "Interview");
  assert.equal(rows[0].notion_page_id, PAGE_ID);
  assert.equal(rows[0].source, "Manual");
  assert.equal(rows[0].salary_min, 140000);
  assert.match(h.out.join("\n"), new RegExp(PAGE_ID));
});

test("--apply passes the shared helper a payload carrying companyName and key", async () => {
  const h = harness();
  await h.cmd(h.ctx({ ...BASE_FLAGS, apply: true }));

  const args = h.calls.pushJobPage[0];
  assert.equal(args.jobsDbId, "jobs-db");
  assert.equal(args.jobFields.companyName, "LawnStarter");
  assert.equal(
    args.jobFields.key,
    "manual:lawnstarter_senior-product-manager-pricing-monetization_2026-07-16"
  );
  assert.equal(args.jobFields.status, "Interview");
  assert.equal(typeof args.companyResolver.resolve, "function");
});

test("--apply backs the TSV up before writing", async () => {
  const h = harness();
  await h.cmd(h.ctx({ ...BASE_FLAGS, apply: true }));

  const bak = backupPath(h.tsvPath, "lawnstarter", "2026-07-16");
  assert.ok(fs.existsSync(bak), "backup file exists");
  assert.equal(applicationsTsv.load(bak).apps.length, 0, "backup holds the pre-write state");
});

// ---------- failure ordering (RFC 063 §4) ----------

test("Notion failure leaves the TSV byte-identical and exits non-zero", async () => {
  const h = harness({
    pushJobPage: async () => {
      throw new Error("notion is down");
    },
  });
  const before = fs.readFileSync(h.tsvPath, "utf8");

  const code = await h.cmd(h.ctx({ ...BASE_FLAGS, apply: true }));

  assert.equal(code, 1);
  assert.equal(fs.readFileSync(h.tsvPath, "utf8"), before, "TSV byte-identical");
  assert.match(h.err.join("\n"), /Notion push failed/);
  assert.match(h.err.join("\n"), /TSV not modified/);
});

test("missing token fails before any Notion call and writes nothing", async () => {
  const h = harness({ loadSecrets: () => ({}) });
  const before = fs.readFileSync(h.tsvPath, "utf8");

  const code = await h.cmd(h.ctx({ ...BASE_FLAGS, apply: true }));

  assert.equal(code, 1);
  assert.equal(h.calls.makeClient, 0);
  assert.equal(fs.readFileSync(h.tsvPath, "utf8"), before);
  assert.match(h.err.join("\n"), /NOTION_TOKEN/);
});

test("dedup hit reuses the existing page rather than creating a second", async () => {
  const h = harness({
    pushJobPage: async () => ({ pageId: "existing-page", dedup: true }),
  });

  const code = await h.cmd(h.ctx({ ...BASE_FLAGS, apply: true }));

  assert.equal(code, 0);
  const rows = readRows(h.tsvPath);
  assert.equal(rows[0].notion_page_id, "existing-page");
  assert.match(h.out.join("\n"), /already existed/);
});

// ---------- validation ----------

test("missing --status is rejected with exit 2, before any I/O", async () => {
  const h = harness();
  const code = await h.cmd(h.ctx({ company: "X", title: "Y", apply: true }));
  assert.equal(code, 2);
  assert.equal(h.calls.makeClient, 0);
  assert.match(h.err.join("\n"), /--status is required/);
});

test("--status Inbox is rejected by name", async () => {
  const h = harness();
  const code = await h.cmd(h.ctx({ ...BASE_FLAGS, status: "Inbox", apply: true }));
  assert.equal(code, 2);
  assert.match(h.err.join("\n"), /TSV-only/);
});

test("bad --salary is rejected", async () => {
  const h = harness();
  const code = await h.cmd(h.ctx({ ...BASE_FLAGS, salary: "$140k", apply: true }));
  assert.equal(code, 2);
  assert.match(h.err.join("\n"), /whole dollars/);
});

test("bad --tier is rejected", async () => {
  const h = harness();
  const code = await h.cmd(h.ctx({ ...BASE_FLAGS, tier: "Z", apply: true }));
  assert.equal(code, 2);
  assert.match(h.err.join("\n"), /--tier/);
});

// ---------- duplicates ----------

test("a duplicate row is refused before touching Notion", async () => {
  const existing = {
    key: "manual:lawnstarter_pm-pricing_2026-07-01",
    source: "Manual",
    jobId: "x",
    companyName: "LawnStarter",
    title: "Senior Product Manager, Pricing & Monetization",
    url: "",
    locations: [],
    status: "Applied",
    notion_page_id: "p",
    resume_ver: "",
    cl_key: "",
    salary_min: null,
    salary_max: null,
    cl_path: "",
    createdAt: NOW,
    updatedAt: NOW,
    fit_score: "",
    fit_rationale: "",
    fit_evaluated_at: "",
    skip_reason: "",
    company_people_search_url: "",
    outreach_type: "",
    contact_name: "",
    contact_linkedin: "",
    hm_outreach_status: "To do",
    hm_outreach_date: "",
    applied_date: "",
  };
  const h = harness({}, [existing]);

  const code = await h.cmd(h.ctx({ ...BASE_FLAGS, apply: true }));

  assert.equal(code, 1);
  assert.equal(h.calls.makeClient, 0, "duplicate guard runs before Notion");
  assert.equal(readRows(h.tsvPath).length, 1, "no row added");
  assert.match(h.err.join("\n"), /refusing/);
  assert.match(h.err.join("\n"), /same company \+ title/);
});

test("--force overrides the duplicate guard", async () => {
  const existing = {
    key: "manual:lawnstarter_pm-pricing_2026-07-01",
    source: "Manual",
    jobId: "x",
    companyName: "LawnStarter",
    title: "Senior Product Manager, Pricing & Monetization",
    url: "",
    locations: [],
    status: "Applied",
    notion_page_id: "p",
    resume_ver: "",
    cl_key: "",
    salary_min: null,
    salary_max: null,
    cl_path: "",
    createdAt: NOW,
    updatedAt: NOW,
    fit_score: "",
    fit_rationale: "",
    fit_evaluated_at: "",
    skip_reason: "",
    company_people_search_url: "",
    outreach_type: "",
    contact_name: "",
    contact_linkedin: "",
    hm_outreach_status: "To do",
    hm_outreach_date: "",
    applied_date: "",
  };
  const h = harness({}, [existing]);

  const code = await h.cmd(h.ctx({ ...BASE_FLAGS, apply: true, force: true }));

  assert.equal(code, 0);
  assert.equal(readRows(h.tsvPath).length, 2);
  assert.match(h.out.join("\n"), /--force set/);
});

// ---------- tier ----------

test("--tier writes company_tiers into profile.json without dropping existing entries", async () => {
  const h = harness();
  const code = await h.cmd(h.ctx({ ...BASE_FLAGS, apply: true, tier: "B" }));

  assert.equal(code, 0);
  const json = JSON.parse(fs.readFileSync(path.join(h.root, "profile.json"), "utf8"));
  assert.equal(json.company_tiers.LawnStarter, "B");
  assert.equal(json.company_tiers.Existing, "A", "pre-existing tiers preserved");
});

test("a profile.json failure warns but does not fail the add", async () => {
  const h = harness({
    writeFileSync: () => {
      throw new Error("read-only fs");
    },
  });

  const code = await h.cmd(h.ctx({ ...BASE_FLAGS, apply: true, tier: "B" }));

  assert.equal(code, 0, "row and page are fine — tier is best-effort");
  assert.equal(readRows(h.tsvPath)[0].notion_page_id, PAGE_ID);
  assert.match(h.err.join("\n"), /could not write tier/);
});
