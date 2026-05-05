const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  makePrepareCommand,
  applyPrepareFilter,
  buildActiveCounts,
} = require("./prepare.js");

// --- Helpers -----------------------------------------------------------------

function makeApp(overrides = {}) {
  return {
    key: overrides.key || "greenhouse:1001",
    source: overrides.source || "greenhouse",
    jobId: overrides.jobId || "1001",
    companyName: overrides.companyName || "Stripe",
    title: overrides.title || "Senior Product Manager",
    url: overrides.url || "https://boards.greenhouse.io/stripe/jobs/1001",
    status: overrides.status || "To Apply",
    notion_page_id: overrides.notion_page_id || "",
    resume_ver: overrides.resume_ver || "",
    cl_key: overrides.cl_key || "",
    createdAt: overrides.createdAt || "2026-04-20T00:00:00.000Z",
    updatedAt: overrides.updatedAt || "2026-04-20T00:00:00.000Z",
  };
}

function makeCtx(overrides = {}) {
  const lines = [];
  const errLines = [];
  return {
    profileId: overrides.profileId || "testuser",
    profilesDir: overrides.profilesDir || "/fake/profiles",
    flags: {
      dryRun: false,
      phase: "pre",
      batch: 30,
      resultsFile: "",
      ...overrides.flags,
    },
    env: {},
    stdout: (s) => lines.push(s),
    stderr: (s) => errLines.push(s),
    _lines: lines,
    _errLines: errLines,
  };
}

// Mirrors url_check.checkAll which spreads the original row.
function makeAliveUrl(row) {
  return { ...row, status: 200, alive: true, finalUrl: row.url };
}

function makeDeadUrl(row) {
  return { ...row, status: 404, alive: false, finalUrl: row.url };
}

// --- buildActiveCounts -------------------------------------------------------

test("buildActiveCounts: counts To Apply, Applied, Interview, Offer (skips Archived)", () => {
  const apps = [
    makeApp({ companyName: "Stripe", status: "To Apply" }),
    makeApp({ companyName: "Stripe", status: "Applied" }),
    makeApp({ companyName: "Ramp", status: "Interview" }),
    makeApp({ companyName: "Ramp", status: "Archived" }),
    makeApp({ companyName: "Brex", status: "Closed" }),
  ];
  const counts = buildActiveCounts(apps);
  assert.equal(counts["Stripe"], 2);
  assert.equal(counts["Ramp"], 1);
  assert.equal(counts["Brex"], undefined);
});

// --- applyPrepareFilter ------------------------------------------------------

test("applyPrepareFilter: passes clean jobs", () => {
  const apps = [
    makeApp({ companyName: "Stripe", title: "Product Manager" }),
    makeApp({ key: "lever:2", companyName: "Ramp", title: "Senior PM" }),
  ];
  const { passed, skipped } = applyPrepareFilter(apps, {}, {});
  assert.equal(passed.length, 2);
  assert.equal(skipped.length, 0);
});

test("applyPrepareFilter: blocks company_blocklist", () => {
  const apps = [
    makeApp({ companyName: "BadCo", title: "PM" }),
    makeApp({ key: "gh:2", companyName: "Stripe", title: "PM" }),
  ];
  const rules = { company_blocklist: ["BadCo"] };
  const { passed, skipped } = applyPrepareFilter(apps, rules, {});
  assert.equal(passed.length, 1);
  assert.equal(passed[0].companyName, "Stripe");
  assert.equal(skipped[0].reason, "company_blocklist");
});

test("applyPrepareFilter: blocks title_blocklist substring", () => {
  const apps = [
    makeApp({ title: "Director of Product" }),
    makeApp({ key: "gh:2", title: "Senior Product Manager" }),
  ];
  const rules = { title_blocklist: [{ pattern: "director", reason: "over-level" }] };
  const { passed, skipped } = applyPrepareFilter(apps, rules, {});
  assert.equal(passed.length, 1);
  assert.equal(skipped[0].reason, "title_blocklist");
});

test("applyPrepareFilter: enforces company_cap", () => {
  const apps = [
    makeApp({ key: "gh:1", companyName: "Stripe" }),
    makeApp({ key: "gh:2", companyName: "Stripe" }),
    makeApp({ key: "gh:3", companyName: "Stripe" }),
  ];
  const rules = { company_cap: { max_active: 2 } };
  // 0 existing active apps → first 2 pass, third skipped
  const { passed, skipped } = applyPrepareFilter(apps, rules, {});
  assert.equal(passed.length, 2);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, "company_cap");
});

test("applyPrepareFilter: counts existing active apps toward cap", () => {
  const apps = [
    makeApp({ key: "gh:1", companyName: "Stripe" }),
    makeApp({ key: "gh:2", companyName: "Stripe" }),
  ];
  const rules = { company_cap: { max_active: 2 } };
  // Stripe already has 1 active → only 1 more passes
  const { passed, skipped } = applyPrepareFilter(apps, rules, { Stripe: 1 });
  assert.equal(passed.length, 1);
  assert.equal(skipped.length, 1);
});

// Downstream of profile_loader's normalizeFilterRules, title_blocklist entries
// are {pattern, reason} objects. applyPrepareFilter must unwrap `.pattern`.
test("applyPrepareFilter: unwraps {pattern,reason} objects in title_blocklist", () => {
  const apps = [
    makeApp({ key: "gh:1", title: "Associate Product Manager" }),
    makeApp({ key: "gh:2", title: "Senior Product Manager" }),
  ];
  const rules = {
    title_blocklist: [{ pattern: "Associate Product Manager", reason: "Too junior" }],
  };
  const { passed, skipped } = applyPrepareFilter(apps, rules, {});
  assert.equal(passed.length, 1);
  assert.equal(passed[0].title, "Senior Product Manager");
  assert.equal(skipped[0].reason, "title_blocklist");
});

// company_blocklist is flat strings post-normalization, but `{name, reason}`
// objects must still be tolerated (defensive unwrap — e.g. if upstream callers
// forget to normalize).
test("applyPrepareFilter: tolerates {name,reason} objects in company_blocklist", () => {
  const apps = [
    makeApp({ key: "gh:1", companyName: "Toast" }),
    makeApp({ key: "gh:2", companyName: "Stripe" }),
  ];
  const rules = {
    company_blocklist: [{ name: "Toast", reason: "Not fintech" }],
  };
  const { passed, skipped } = applyPrepareFilter(apps, rules, {});
  assert.equal(passed.length, 1);
  assert.equal(passed[0].companyName, "Stripe");
  assert.equal(skipped[0].reason, "company_blocklist");
});

test("applyPrepareFilter: cap override per-company", () => {
  const apps = [
    makeApp({ key: "gh:1", companyName: "VIP" }),
    makeApp({ key: "gh:2", companyName: "VIP" }),
    makeApp({ key: "gh:3", companyName: "VIP" }),
  ];
  const rules = {
    company_cap: { max_active: 1, overrides: { VIP: 3 } },
  };
  const { passed } = applyPrepareFilter(apps, rules, {});
  assert.equal(passed.length, 3);
});

test("applyPrepareFilter: title_requirelist blocks non-PM title", () => {
  const apps = [
    makeApp({ key: "gh:1", title: "Software Engineer" }),
    makeApp({ key: "gh:2", title: "Senior Product Manager" }),
  ];
  const rules = {
    title_requirelist: [{ pattern: "product manager", reason: "PM role" }],
  };
  const { passed, skipped } = applyPrepareFilter(apps, rules, {});
  assert.equal(passed.length, 1);
  assert.equal(passed[0].title, "Senior Product Manager");
  assert.equal(skipped[0].reason, "title_requirelist");
});

test("applyPrepareFilter: title_requirelist passes PM abbreviation (word boundary)", () => {
  const apps = [
    makeApp({ key: "gh:1", title: "Sr. PM, Payments" }),
  ];
  const rules = {
    title_requirelist: [{ pattern: "PM", reason: "PM abbreviation" }],
  };
  const { passed } = applyPrepareFilter(apps, rules, {});
  assert.equal(passed.length, 1);
});

test("applyPrepareFilter: title_requirelist empty → no gate applied", () => {
  const apps = [makeApp({ title: "DevOps Engineer" })];
  const { passed } = applyPrepareFilter(apps, { title_requirelist: [] }, {});
  assert.equal(passed.length, 1);
});

test("applyPrepareFilter: title_requirelist slash-compound — PM part passes whole title", () => {
  const apps = [makeApp({ title: "Analyst/Product Manager" })];
  const rules = { title_requirelist: [{ pattern: "product manager", reason: "PM" }] };
  const { passed, skipped } = applyPrepareFilter(apps, rules, {});
  assert.equal(passed.length, 1);
  assert.equal(skipped.length, 0);
});

// --- prepare --phase pre (unit) ----------------------------------------------

function makePrepDeps(apps, overrides = {}) {
  const written = {};
  return {
    loadProfile: () => ({
      id: "testuser",
      filterRules: {},
      company_tiers: { Stripe: "S" },
      paths: {
        root: "/fake/profiles/testuser",
        applicationsTsv: "/fake/profiles/testuser/applications.tsv",
        jdCacheDir: "/fake/profiles/testuser/jd_cache",
      },
    }),
    loadApplications: () => ({ apps }),
    saveApplications: () => {},
    checkUrls: async (rows) => rows.map((r) => makeAliveUrl(r)),
    fetchJds: async () => [],
    calcSalary: () => null,
    fetchFn: async () => ({ ok: true, status: 200 }),
    readFile: () => "",
    writeFile: (p, data) => { written[p] = data; },
    now: () => "2026-04-20T12:00:00.000Z",
    _written: written,
    ...overrides,
  };
}

test("prepare --phase pre: writes prepare_context.json with correct shape", async () => {
  const apps = [makeApp()];
  const deps = makePrepDeps(apps);
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  const code = await cmd(ctx);
  assert.equal(code, 0);

  const written = deps._written["/fake/profiles/testuser/prepare_context.json"];
  assert.ok(written, "context file should be written");
  const ctx2 = JSON.parse(written);
  assert.equal(ctx2.profileId, "testuser");
  assert.equal(ctx2.batch.length, 1);
  assert.equal(ctx2.batch[0].key, "greenhouse:1001");
  assert.equal(ctx2.batch[0].urlAlive, true);
  assert.ok(ctx2.stats);
  assert.equal(ctx2.stats.inboxTotal, 1);
});

test("prepare --phase pre: dry-run does not write file", async () => {
  const apps = [makeApp()];
  const deps = makePrepDeps(apps);
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { dryRun: true, phase: "pre", batch: 30 } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  assert.equal(Object.keys(deps._written).length, 0);
  assert.ok(ctx._lines.some((l) => /dry-run/.test(l)));
});

test("prepare --phase pre: only picks fresh apps (status='To Apply' AND no notion_page_id)", async () => {
  // 8-status set has no "Inbox". Fresh = "To Apply" + never pushed to Notion.
  // After commit, the row keeps "To Apply" but gains notion_page_id, so it falls
  // out of the fresh list. Applied/Interview/etc are skipped — they're past the
  // pre-apply triage stage.
  const apps = [
    makeApp({ key: "gh:1", status: "To Apply", notion_page_id: "abc" }), // already pushed
    makeApp({ key: "gh:2", status: "To Apply", notion_page_id: "" }),    // fresh — picked
    makeApp({ key: "gh:3", status: "Applied", notion_page_id: "" }),     // past triage
  ];
  const deps = makePrepDeps(apps);
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  const written = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(written.stats.inboxTotal, 1);
  assert.equal(written.batch.length, 1);
  assert.equal(written.batch[0].key, "gh:2");
});

test("prepare --phase pre: dead URLs go to skipped, NOT batch (G-12: alive-only batch)", async () => {
  const alive = makeApp({ key: "gh:1" });
  const dead = makeApp({ key: "gh:2", url: "https://dead.example.com/jobs/2" });
  const deps = makePrepDeps([alive, dead], {
    checkUrls: async (rows) =>
      rows.map((r) =>
        r.key === "gh:1" ? makeAliveUrl(r) : makeDeadUrl(r)
      ),
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.stats.urlAlive, 1);
  assert.equal(result.stats.urlDead, 1);
  // After G-12: batch is alive-only. Dead entries appear ONLY in skipped.
  assert.equal(result.batch.length, 1);
  assert.equal(result.batch[0].key, "gh:1");
  assert.equal(result.batch[0].urlAlive, true);
  assert.ok(!result.batch.some((e) => e.key === "gh:2"));
  // dead URL in skipped list with the right reason
  assert.ok(result.skipped.some((s) => s.key === "gh:2" && s.reason === "url_dead"));
  assert.equal(result.stats.skipReasons.url_dead, 1);
});

test("prepare --phase pre: respects batchSize", async () => {
  const apps = Array.from({ length: 10 }, (_, i) =>
    makeApp({ key: `gh:${i}`, jobId: String(i) })
  );
  const deps = makePrepDeps(apps);
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", batch: 3, dryRun: false } });
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch.length, 3);
  assert.equal(result.stats.inBatch, 3);
});

test("prepare --phase pre: includes salary when company_tiers known", async () => {
  const apps = [makeApp({ companyName: "Stripe", title: "Senior PM" })];
  const deps = makePrepDeps(apps, {
    calcSalary: (co, title) => (co === "Stripe" ? { tier: "S", level: "Senior", min: 220000, max: 300000, mid: 260000, expectation: "$220-300K TC (midpoint $260K)" } : null),
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.ok(result.batch[0].salary);
  assert.equal(result.batch[0].salary.tier, "S");
  // Known-tier company should NOT be flagged unknownTier
  assert.equal(result.batch[0].unknownTier, undefined);
  assert.deepEqual(result.unknownTierCompanies, []);
});

test("prepare --phase pre: flags unknown-tier companies, dedupes across batch", async () => {
  // Stripe is in company_tiers → known. NewCo and OtherCo are not → flagged.
  // Two NewCo jobs should produce one entry in unknownTierCompanies (deduped).
  const apps = [
    makeApp({ key: "gh:1", companyName: "Stripe", title: "PM", jobId: "1" }),
    makeApp({ key: "gh:2", companyName: "NewCo", title: "PM", jobId: "2" }),
    makeApp({ key: "gh:3", companyName: "NewCo", title: "Senior PM", jobId: "3" }),
    makeApp({ key: "gh:4", companyName: "OtherCo", title: "PM", jobId: "4" }),
  ];
  const deps = makePrepDeps(apps);
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  // Stripe entry is not flagged
  const stripeEntry = result.batch.find((e) => e.companyName === "Stripe");
  assert.equal(stripeEntry.unknownTier, undefined);
  // Both NewCo entries are flagged
  const newcoEntries = result.batch.filter((e) => e.companyName === "NewCo");
  assert.equal(newcoEntries.length, 2);
  assert.ok(newcoEntries.every((e) => e.unknownTier === true));
  // unknownTierCompanies has unique sorted names (no Stripe)
  assert.deepEqual(result.unknownTierCompanies, ["NewCo", "OtherCo"]);
  assert.equal(result.stats.unknownTierCompanies, 2);
});

// --- L-5: schedule + requirements extraction from JD ------------------------

test("prepare --phase pre (L-5): extracts schedule + requirements from jdText into batch entries", async () => {
  const apps = [makeApp({ key: "gh:1", companyName: "Kaiser", title: "Medical Receptionist" })];
  const jdText = "Schedule: Full-time, day shift. Requirements: HS diploma required. BLS preferred.";
  const deps = makePrepDeps(apps, {
    fetchJds: async () => [{ key: "gh:1", status: "fetched", text: jdText }],
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch.length, 1);
  assert.equal(result.batch[0].schedule, "Full-time");
  assert.ok(result.batch[0].requirements);
  assert.match(result.batch[0].requirements, /diploma/i);
  assert.match(result.batch[0].requirements, /BLS \(preferred\)/);
});

test("prepare --phase pre (L-5): no jdText → no schedule/requirements fields", async () => {
  // When the JD couldn't be fetched, we don't invent fields. The SKILL falls
  // back to writing nothing for these (profiles whose property_map doesn't
  // declare them stay unaffected anyway).
  const apps = [makeApp({ key: "gh:1" })];
  const deps = makePrepDeps(apps, {
    fetchJds: async () => [], // no JD fetched
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch.length, 1);
  assert.equal(result.batch[0].schedule, undefined);
  assert.equal(result.batch[0].requirements, undefined);
});

test("prepare --phase pre (L-5): jdText with no recognizable signal → no fields added", async () => {
  const apps = [makeApp({ key: "gh:1" })];
  const jdText = "We are seeking a dedicated team member to join our growing organization.";
  const deps = makePrepDeps(apps, {
    fetchJds: async () => [{ key: "gh:1", status: "fetched", text: jdText }],
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch[0].schedule, undefined);
  assert.equal(result.batch[0].requirements, undefined);
  // jdText itself is still preserved
  assert.equal(result.batch[0].jdText, jdText);
});

test("prepare --phase pre (L-5): extractFromJd is injected via deps and called with jdText", async () => {
  // Verify the dep injection contract: extractFromJd is called with the JD
  // body and its return shape lands on the entry. This protects against a
  // future refactor accidentally bypassing the extractor.
  const apps = [makeApp({ key: "gh:1" })];
  const calls = [];
  const deps = makePrepDeps(apps, {
    fetchJds: async () => [{ key: "gh:1", status: "fetched", text: "JD-BODY" }],
    extractFromJd: (text) => {
      calls.push(text);
      return { schedule: "Custom-FT", requirements: "- Custom requirement" };
    },
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  assert.deepEqual(calls, ["JD-BODY"]);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch[0].schedule, "Custom-FT");
  assert.equal(result.batch[0].requirements, "- Custom requirement");
});

test("prepare --phase pre (L-5): Jared parity — batch shape unchanged when JD has no healthcare signal", async () => {
  // Jared's JDs (PM/fintech) don't contain healthcare cert vocabulary. Without
  // schedule/requirements, the batch entry shape is back-compat for his
  // profile (his property_map declares no Schedule/Requirements; the SKILL
  // simply skips writing those fields). We assert no spurious fields appear
  // for a typical PM JD.
  const apps = [makeApp({ key: "gh:1", companyName: "Stripe", title: "Senior PM" })];
  const jdText = `
    Senior Product Manager, Capital
    You will own the full product lifecycle for Stripe Capital.
    Requirements:
    - 7+ years of product management experience
    - Strong analytical skills (SQL, A/B testing)
  `;
  const deps = makePrepDeps(apps, {
    fetchJds: async () => [{ key: "gh:1", status: "fetched", text: jdText }],
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  // schedule: no employment-type vocabulary in this PM JD → null → field omitted.
  assert.equal(result.batch[0].schedule, undefined);
  // requirements: years signal still fires (universal), so requirements is
  // populated with "7+ years of product management experience" — not null.
  // This is the expected behavior: for Jared, his property_map doesn't
  // declare a Requirements field, so SKILL Step 9 will simply not push it.
  assert.ok(result.batch[0].requirements);
  assert.match(result.batch[0].requirements, /7\+ years/i);
  // No invented healthcare certs for a PM JD.
  assert.doesNotMatch(result.batch[0].requirements, /\bBLS\b/);
  assert.doesNotMatch(result.batch[0].requirements, /\bRN\b/);
});

// --- G-12: fill-up loop + skip-reason breakdown ------------------------------

test("prepare --phase pre (G-12): fills batch to target by pulling more from passed when first chunk has dead URLs", async () => {
  // 10 candidates, first 3 are dead → fill-up loop should keep pulling until
  // batchSize=5 alive entries are accumulated, never giving up.
  const apps = Array.from({ length: 10 }, (_, i) =>
    makeApp({ key: `gh:${i}`, jobId: String(i), companyName: "Stripe" })
  );
  const deadKeys = new Set(["gh:0", "gh:1", "gh:2"]);
  const deps = makePrepDeps(apps, {
    checkUrls: async (rows) =>
      rows.map((r) => (deadKeys.has(r.key) ? makeDeadUrl(r) : makeAliveUrl(r))),
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", batch: 5, dryRun: false } });
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch.length, 5, "batch should be filled to 5 alive");
  assert.ok(
    result.batch.every((e) => e.urlAlive === true),
    "all batch entries must be alive"
  );
  assert.equal(result.stats.urlAlive, 5);
  assert.equal(result.stats.urlDead, 3);
  assert.equal(result.stats.skipReasons.url_dead, 3);
});

test("prepare --phase pre (G-12): does NOT URL-check beyond what's needed (deferred count)", async () => {
  // 30 candidates, batchSize=5, all alive. Loop should consume only 5
  // (first chunk size = max(remaining=5, floor=5) = 5), leaving 25 deferred.
  const apps = Array.from({ length: 30 }, (_, i) =>
    makeApp({ key: `gh:${i}`, jobId: String(i) })
  );
  const deps = makePrepDeps(apps);
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", batch: 5, dryRun: false } });
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch.length, 5);
  assert.equal(result.stats.urlChecked, 5, "only first chunk is URL-checked");
  assert.equal(result.stats.deferred, 25);
});

test("prepare --phase pre (G-12): pool exhausted — batch smaller than target", async () => {
  // Only 3 candidates, all alive; batchSize=10. Result: 3 in batch, 0 deferred.
  const apps = Array.from({ length: 3 }, (_, i) =>
    makeApp({ key: `gh:${i}`, jobId: String(i) })
  );
  const deps = makePrepDeps(apps);
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", batch: 10, dryRun: false } });
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch.length, 3);
  assert.equal(result.stats.deferred, 0);
});

test("prepare --phase pre (G-12): skipReasons aggregates across cap + blocklist + url_dead", async () => {
  const apps = [
    makeApp({ key: "gh:1", title: "VP of Engineering" }),  // title_blocklist
    makeApp({ key: "gh:2", title: "Director of PM" }),     // title_blocklist
    makeApp({ key: "gh:3", companyName: "BadCo" }),        // company_blocklist
    makeApp({ key: "gh:4", url: "https://dead.example.com/jobs/4" }), // url_dead
    makeApp({ key: "gh:5" }),                              // alive
  ];
  const deps = makePrepDeps(apps, {
    loadProfile: () => ({
      id: "testuser",
      filterRules: {
        title_blocklist: [
          { pattern: "vp of", reason: "vp" },
          { pattern: "director of", reason: "director" },
        ],
        company_blocklist: ["BadCo"],
      },
      company_tiers: { Stripe: "S" },
      paths: {
        root: "/fake/profiles/testuser",
        applicationsTsv: "/fake/profiles/testuser/applications.tsv",
        jdCacheDir: "/fake/profiles/testuser/jd_cache",
      },
    }),
    checkUrls: async (rows) =>
      rows.map((r) => (r.key === "gh:4" ? makeDeadUrl(r) : makeAliveUrl(r))),
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", batch: 30, dryRun: false } });
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.stats.skipReasons.title_blocklist, 2);
  assert.equal(result.stats.skipReasons.company_blocklist, 1);
  assert.equal(result.stats.skipReasons.url_dead, 1);
  // batch contains only the one alive entry that passed all filters
  assert.equal(result.batch.length, 1);
  assert.equal(result.batch[0].key, "gh:5");
});

test("prepare --phase pre (G-12): empty skipReasons when nothing skipped", async () => {
  const apps = [makeApp({ key: "gh:1" })];
  const deps = makePrepDeps(apps);
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.deepEqual(result.stats.skipReasons, {});
});

test("prepare --phase pre: empty unknownTierCompanies when all companies tiered", async () => {
  const apps = [makeApp({ companyName: "Stripe", title: "PM" })];
  const deps = makePrepDeps(apps);
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.deepEqual(result.unknownTierCompanies, []);
  assert.equal(result.stats.unknownTierCompanies, 0);
});

// --- prepare --phase commit --------------------------------------------------

function makeCommitDeps(apps, overrides = {}) {
  let savedApps = null;
  let savedProfile = null;
  const profileBase = overrides.profile || {
    id: "testuser",
    filterRules: {},
    company_tiers: {},
    paths: {
      root: "/fake/profiles/testuser",
      applicationsTsv: "/fake/profiles/testuser/applications.tsv",
      jdCacheDir: "/fake/profiles/testuser/jd_cache",
    },
  };
  return {
    loadProfile: () => profileBase,
    saveProfile: (id, patch) => {
      savedProfile = { id, patch };
      return { ...profileBase, ...patch };
    },
    loadApplications: () => ({ apps }),
    saveApplications: (_, updated) => { savedApps = updated; },
    checkUrls: async () => [],
    fetchJds: async () => [],
    calcSalary: () => null,
    fetchFn: async () => ({ ok: true, status: 200 }),
    readFile: overrides.readFile || (() => ""),
    writeFile: () => {},
    now: () => "2026-04-20T13:00:00.000Z",
    _getSaved: () => savedApps,
    _getSavedProfile: () => savedProfile,
    ...overrides,
  };
}

test("prepare --phase commit: to_apply sets status and fields", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    results: [
      { key: "gh:1", decision: "to_apply", clKey: "stripe_spm_cl", resumeVer: "v3", notionPageId: "notion-abc" },
    ],
  };
  const deps = makeCommitDeps(apps, {
    readFile: () => JSON.stringify(results),
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/fake/results.json", dryRun: false } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  const saved = deps._getSaved();
  assert.ok(saved, "should have saved");
  const app = saved[0];
  assert.equal(app.status, "To Apply");
  assert.equal(app.cl_key, "stripe_spm_cl");
  assert.equal(app.resume_ver, "v3");
  assert.equal(app.notion_page_id, "notion-abc");
  assert.equal(app.updatedAt, "2026-04-20T13:00:00.000Z");
});

test("prepare --phase commit: to_apply writes salary_min/salary_max/cl_path from results", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    results: [
      {
        key: "gh:1",
        decision: "to_apply",
        clKey: "Affirm_analyst_20260420",
        clPath: "Affirm_analyst_20260420.md",
        resumeVer: "Risk_Fraud",
        notionPageId: "notion-affirm",
        salaryMin: 140000,
        salaryMax: 190000,
      },
    ],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  const saved = deps._getSaved();
  const app = saved[0];
  assert.equal(app.salary_min, "140000");
  assert.equal(app.salary_max, "190000");
  assert.equal(app.cl_path, "Affirm_analyst_20260420.md");
  assert.equal(app.cl_key, "Affirm_analyst_20260420");
});

test("prepare --phase commit: defaults cl_path to clKey when clPath missing", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    results: [
      { key: "gh:1", decision: "to_apply", clKey: "just_a_key", resumeVer: "v" },
    ],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  await cmd(ctx);
  const saved = deps._getSaved();
  assert.equal(saved[0].cl_path, "just_a_key");
});

test("prepare --phase commit: archive sets status", async () => {
  const apps = [makeApp({ key: "gh:2", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    results: [{ key: "gh:2", decision: "archive" }],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  await cmd(ctx);
  const saved = deps._getSaved();
  assert.equal(saved[0].status, "Archived");
});

test("prepare --phase commit: skip leaves app unchanged", async () => {
  const apps = [makeApp({ key: "gh:3", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    results: [{ key: "gh:3", decision: "skip" }],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  await cmd(ctx);
  const saved = deps._getSaved();
  // "skip" decision leaves status untouched.
  assert.equal(saved[0].status, "To Apply");
});

test("prepare --phase commit: dry-run does not save", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    results: [{ key: "gh:1", decision: "to_apply" }],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json", dryRun: true } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  assert.equal(deps._getSaved(), null);
  assert.ok(ctx._lines.some((l) => /dry-run/.test(l)));
});

test("prepare --phase commit: warns on unknown key", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    results: [
      { key: "gh:999", decision: "to_apply" }, // does not exist
    ],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  assert.ok(ctx._errLines.some((l) => /not found/.test(l)));
});

test("prepare --phase commit: missing results-file returns 1", async () => {
  const cmd = makePrepareCommand(makeCommitDeps([]));
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "" } });
  const code = await cmd(ctx);
  assert.equal(code, 1);
  assert.ok(ctx._errLines.some((l) => /results-file/.test(l)));
});

test("prepare --phase commit: unknown decision warns and falls back to skip", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    results: [{ key: "gh:1", decision: "approve" }], // typo, not in enum
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json", dryRun: false } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  assert.ok(
    ctx._errLines.some((l) => /unknown decision "approve"/.test(l)),
    "should warn about unknown decision"
  );
  // App should remain unchanged (no resume_ver, no notion_page_id, status as-was)
  const saved = deps._getSaved();
  assert.equal(saved[0].notion_page_id || "", "");
  assert.equal(saved[0].resume_ver || "", "");
});

test("prepare --phase commit: unknown resumeVer warns and skips when validArchetypes set is non-empty", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    results: [
      { key: "gh:1", decision: "to_apply", resumeVer: "made-up-key", notionPageId: "p1" },
    ],
  };
  const deps = makeCommitDeps(apps, {
    readFile: () => JSON.stringify(results),
    loadProfile: () => ({
      id: "testuser",
      filterRules: {},
      paths: {
        root: "/fake/profiles/testuser",
        applicationsTsv: "/fake/profiles/testuser/applications.tsv",
        jdCacheDir: "/fake/profiles/testuser/jd_cache",
      },
      resumeVersions: { versions: { "fintech-pm-v3": {}, "ai-pm-v2": {} } },
    }),
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json", dryRun: false } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  assert.ok(
    ctx._errLines.some((l) => /unknown resumeVer "made-up-key"/.test(l)),
    "should warn about invalid archetype"
  );
  // The row should not have been mutated to to_apply
  const saved = deps._getSaved();
  assert.equal(saved[0].resume_ver || "", "");
  assert.equal(saved[0].notion_page_id || "", "");
});

test("prepare --phase commit: validArchetypes empty set disables the gate (legacy profiles)", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    results: [
      { key: "gh:1", decision: "to_apply", resumeVer: "anything-goes", notionPageId: "p1" },
    ],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  // default makeCommitDeps loadProfile has no resumeVersions → empty set → no gate
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json", dryRun: false } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  const saved = deps._getSaved();
  assert.equal(saved[0].resume_ver, "anything-goes");
  assert.equal(saved[0].notion_page_id, "p1");
});

// --- prepare --phase commit: companyTiers merge (G-11/G-15) ------------------

test("prepare --phase commit: persists companyTiers from results to profile.json", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply", companyName: "NewCo" })];
  const results = {
    profileId: "testuser",
    companyTiers: { NewCo: "B", OtherCo: "C" },
    results: [
      { key: "gh:1", decision: "to_apply", clKey: "newco_pm", resumeVer: "v1", notionPageId: "p1" },
    ],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json", dryRun: false } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  const saved = deps._getSavedProfile();
  assert.ok(saved, "profile should be saved");
  assert.equal(saved.id, "testuser");
  assert.deepEqual(saved.patch.company_tiers, { NewCo: "B", OtherCo: "C" });
  assert.ok(ctx._lines.some((l) => /persisted 2 new tier/.test(l)));
});

test("prepare --phase commit: does NOT call saveProfile when companyTiers absent", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    results: [{ key: "gh:1", decision: "to_apply", clKey: "x", resumeVer: "v1", notionPageId: "p1" }],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json", dryRun: false } });
  await cmd(ctx);
  assert.equal(deps._getSavedProfile(), null);
});

test("prepare --phase commit: skips already-known tiers (no spurious write)", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    companyTiers: { Stripe: "S", NewCo: "B" }, // Stripe already known
    results: [{ key: "gh:1", decision: "to_apply", clKey: "x", resumeVer: "v1", notionPageId: "p1" }],
  };
  const profile = {
    id: "testuser",
    filterRules: {},
    company_tiers: { Stripe: "S" },
    paths: {
      root: "/fake/profiles/testuser",
      applicationsTsv: "/fake/profiles/testuser/applications.tsv",
      jdCacheDir: "/fake/profiles/testuser/jd_cache",
    },
  };
  const deps = makeCommitDeps(apps, { profile, readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json", dryRun: false } });
  await cmd(ctx);
  const saved = deps._getSavedProfile();
  assert.ok(saved);
  // Only NewCo should be in patch (Stripe was already at the same value)
  assert.deepEqual(saved.patch.company_tiers, { Stripe: "S", NewCo: "B" });
  assert.ok(ctx._lines.some((l) => /persisted 1 new tier/.test(l)));
});

test("prepare --phase commit: rejects invalid tier values, warns, continues", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    companyTiers: { GoodCo: "B", BadCo: "Z", AnotherBad: "" },
    results: [{ key: "gh:1", decision: "to_apply", clKey: "x", resumeVer: "v1", notionPageId: "p1" }],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json", dryRun: false } });
  await cmd(ctx);
  const saved = deps._getSavedProfile();
  assert.ok(saved);
  assert.deepEqual(saved.patch.company_tiers, { GoodCo: "B" });
  assert.equal(
    ctx._errLines.filter((l) => /invalid tier/.test(l)).length,
    2
  );
});

test("prepare --phase commit: dry-run does not call saveProfile", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    companyTiers: { NewCo: "B" },
    results: [{ key: "gh:1", decision: "to_apply", clKey: "x", resumeVer: "v1", notionPageId: "p1" }],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json", dryRun: true } });
  await cmd(ctx);
  assert.equal(deps._getSavedProfile(), null);
  assert.ok(ctx._lines.some((l) => /\(dry-run\) would persist 1 new tier/.test(l)));
});

test("prepare --phase commit: lowercase tier value is normalized to uppercase", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    companyTiers: { NewCo: "b", OtherCo: "a" },
    results: [{ key: "gh:1", decision: "to_apply", clKey: "x", resumeVer: "v1", notionPageId: "p1" }],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json", dryRun: false } });
  await cmd(ctx);
  const saved = deps._getSavedProfile();
  assert.deepEqual(saved.patch.company_tiers, { NewCo: "B", OtherCo: "A" });
});

// --- unknown phase -----------------------------------------------------------

test("prepare: missing phase returns 1", async () => {
  const cmd = makePrepareCommand(makePrepDeps([]));
  const ctx = makeCtx({ flags: { phase: "" } });
  const code = await cmd(ctx);
  assert.equal(code, 1);
  assert.ok(ctx._errLines.some((l) => /--phase/.test(l)));
});

// --- L-4 / RFC 013: profile geo enforcement -------------------------------

const LILIA_GEO = {
  mode: "metro",
  cities: ["Sacramento", "Roseville", "Folsom"],
  states: ["CA"],
  remote_ok: false,
  blocklist: ["Napa"],
};

function makePrepDepsWithGeo(apps, geo, overrides = {}) {
  const base = makePrepDeps(apps, overrides);
  const origLoadProfile = base.loadProfile;
  base.loadProfile = () => {
    const p = origLoadProfile();
    p.geo = geo;
    return p;
  };
  return base;
}

test("prepare --phase pre (L-4): metro geo skips out-of-metro app at applyPrepareFilter", async () => {
  // Lilia geo + an in-metro and an out-of-metro app. The latter never reaches
  // the batch — it's skipped with reason "geo_metro_miss".
  const apps = [
    makeApp({ key: "gh:1", companyName: "Kaiser", title: "Medical Receptionist" }),
    makeApp({ key: "gh:2", companyName: "Kaiser", title: "Medical Receptionist" }),
  ];
  // Simulate TSV location field (G-5 schema v3) on the apps.
  apps[0].location = "Sacramento, CA";
  apps[1].location = "Houston, TX";
  const deps = makePrepDepsWithGeo(apps, LILIA_GEO);
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  // Only the Sacramento app made it through.
  assert.equal(result.batch.length, 1);
  assert.equal(result.batch[0].key, "gh:1");
  // Houston app appears in skipped with geo reason.
  const houston = result.skipped.find((s) => s.key === "gh:2");
  assert.ok(houston, "Houston app should be in skipped");
  assert.equal(houston.reason, "geo_metro_miss");
  // Stats breakdown surfaces the geo skip.
  assert.equal(result.stats.skipReasons.geo_metro_miss, 1);
});

test("prepare --phase pre (L-4): unrestricted mode passes everything", async () => {
  // Jared parity: mode unrestricted = no geo enforcement.
  const apps = [
    makeApp({ key: "gh:1", companyName: "Stripe", title: "Senior PM" }),
    makeApp({ key: "gh:2", companyName: "Stripe", title: "Senior PM" }),
  ];
  apps[0].location = "London, UK";
  apps[1].location = "Bangalore, India";
  const deps = makePrepDepsWithGeo(apps, { mode: "unrestricted", remote_ok: true });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  // Both pass under unrestricted.
  assert.equal(result.batch.length, 2);
});

test("prepare --phase pre (L-4): metro geo populates entry.geo_decision='allowed' on passing entries", async () => {
  const apps = [makeApp({ key: "gh:1", companyName: "Kaiser" })];
  apps[0].location = "Sacramento, CA";
  const deps = makePrepDepsWithGeo(apps, LILIA_GEO);
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch.length, 1);
  assert.equal(result.batch[0].geo_decision, "allowed");
  assert.equal(result.batch[0].geo_matched_by, "city:Sacramento");
});

test("prepare --phase pre (L-4): metro geo skips empty-location apps with geo_no_location", async () => {
  // Old TSV row from before G-5 backfill — no location field. In metro mode
  // → geo_no_location reject.
  const apps = [makeApp({ key: "gh:1", companyName: "Kaiser" })];
  apps[0].location = ""; // empty location
  const deps = makePrepDepsWithGeo(apps, LILIA_GEO);
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch.length, 0);
  assert.equal(result.skipped[0].reason, "geo_no_location");
});

test("prepare --phase pre (L-4): metro geo blocklist short-circuits with geo_blocklist", async () => {
  const apps = [makeApp({ key: "gh:1", companyName: "Kaiser" })];
  apps[0].location = "Napa, CA";
  const deps = makePrepDepsWithGeo(apps, LILIA_GEO);
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch.length, 0);
  assert.equal(result.skipped[0].reason, "geo_blocklist");
});

test("prepare --phase pre (L-4): no geo block in profile → no geo_decision field (back-compat)", async () => {
  // Profile without `geo` (e.g. test fixtures or legacy profiles loaded
  // through a non-normalized path). Entries should not carry geo_decision —
  // SKILL Step 3 falls back to its legacy WebFetch path.
  const apps = [makeApp({ key: "gh:1", companyName: "Stripe" })];
  apps[0].location = "Sacramento, CA";
  const deps = makePrepDeps(apps); // no geo injection
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch.length, 1);
  assert.equal(result.batch[0].geo_decision, undefined);
});
