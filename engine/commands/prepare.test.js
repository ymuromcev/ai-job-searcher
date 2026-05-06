const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  makePrepareCommand,
  applyPrepareFilter,
  filterAlreadyEvaluated,
  buildActiveCounts,
  computeInboxExhausted,
  isFreshInboxApp,
  runAutoDedup,
} = require("./prepare.js");

// --- Helpers -----------------------------------------------------------------

function makeApp(overrides = {}) {
  // Derive source/jobId from `key` when only `key` is overridden — keeps
  // existing tests stable after BL-13 (auto-dedup at runPre start) since
  // multiple rows with the same canonical (source, jobId) would otherwise
  // collapse into a single "duplicate group" before any test assertion runs.
  let source = overrides.source;
  let jobId = overrides.jobId;
  if (overrides.key && (!source || !jobId)) {
    const m = String(overrides.key).match(/^([^:]+):(.+)$/);
    if (m) {
      if (!source) source = m[1];
      if (!jobId) jobId = m[2];
    }
  }
  return {
    key: overrides.key || "greenhouse:1001",
    source: source || "greenhouse",
    jobId: jobId || "1001",
    companyName: overrides.companyName || "Stripe",
    title: overrides.title || "Senior Product Manager",
    url: overrides.url || "https://boards.greenhouse.io/stripe/jobs/1001",
    status: overrides.status || "To Apply",
    notion_page_id: overrides.notion_page_id || "",
    resume_ver: overrides.resume_ver || "",
    cl_key: overrides.cl_key || "",
    createdAt: overrides.createdAt || "2026-04-20T00:00:00.000Z",
    updatedAt: overrides.updatedAt || "2026-04-20T00:00:00.000Z",
    // Pass arbitrary extras (fit_score, skip_reason, location, etc.) through
    // — the helper enumerated only a v1 subset before BL-9.
    ...overrides,
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

// --- filterAlreadyEvaluated (BL-9, TSV v4) -----------------------------------

test("filterAlreadyEvaluated: drops fit_score=Weak rows with reason already_evaluated_weak", () => {
  const apps = [
    makeApp({ key: "gh:1", fit_score: "Strong" }),
    makeApp({ key: "gh:2", fit_score: "Medium" }),
    makeApp({ key: "gh:3", fit_score: "Weak" }),
    makeApp({ key: "gh:4" }), // never evaluated → empty
  ];
  const { passed, skipped } = filterAlreadyEvaluated(apps);
  assert.equal(passed.length, 3);
  assert.deepEqual(passed.map((a) => a.key), ["gh:1", "gh:2", "gh:4"]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].key, "gh:3");
  assert.equal(skipped[0].reason, "already_evaluated_weak");
});

test("filterAlreadyEvaluated: drops skip_reason=weak_fit (legacy alias for fit_score=Weak)", () => {
  // SKILL writes both fit_score=Weak AND skip_reason=weak_fit; either signal
  // alone must produce the same skip outcome (defensive against partial writes).
  const apps = [
    makeApp({ key: "gh:1", fit_score: "", skip_reason: "weak_fit" }),
  ];
  const { passed, skipped } = filterAlreadyEvaluated(apps);
  assert.equal(passed.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, "already_evaluated_weak");
});

test("filterAlreadyEvaluated: drops skip_reason=duplicate with reason already_evaluated_duplicate", () => {
  const apps = [
    makeApp({ key: "gh:1", skip_reason: "duplicate" }),
    makeApp({ key: "gh:2" }),
  ];
  const { passed, skipped } = filterAlreadyEvaluated(apps);
  assert.equal(passed.length, 1);
  assert.equal(passed[0].key, "gh:2");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, "already_evaluated_duplicate");
});

test("filterAlreadyEvaluated: empty fit fields → all pass through unchanged", () => {
  // Pre-v4 rows (or fresh post-scan rows that never reached the SKILL)
  // must traverse the filter as a no-op.
  const apps = [makeApp({ key: "gh:1" }), makeApp({ key: "gh:2" })];
  const { passed, skipped } = filterAlreadyEvaluated(apps);
  assert.equal(passed.length, 2);
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

test("prepare --phase pre (BL-9): already-evaluated rows skip URL-check and do not enter batch", async () => {
  // Three Inbox rows — one Weak (already evaluated), one duplicate, one fresh.
  // Only the fresh row should reach checkUrls and the resulting batch.
  const apps = [
    makeApp({ key: "gh:1", fit_score: "Weak", skip_reason: "weak_fit" }),
    makeApp({ key: "gh:2", skip_reason: "duplicate" }),
    makeApp({ key: "gh:3" }), // fresh
  ];
  const checkedKeys = [];
  const deps = makePrepDeps(apps, {
    checkUrls: async (rows) => {
      for (const r of rows) checkedKeys.push(r.key);
      return rows.map((r) => makeAliveUrl(r));
    },
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);

  // Engine never URL-checks already-evaluated rows.
  assert.deepEqual(checkedKeys, ["gh:3"]);
  // Batch carries only the fresh row.
  assert.equal(result.batch.length, 1);
  assert.equal(result.batch[0].key, "gh:3");
  // Both already-evaluated rows show up in skipped[] with distinct reasons.
  const reasons = result.skipped.map((s) => s.reason).sort();
  assert.deepEqual(
    reasons,
    ["already_evaluated_duplicate", "already_evaluated_weak"]
  );
  assert.equal(result.stats.alreadyEvaluated, 2);
  assert.equal(result.stats.skipReasons.already_evaluated_weak, 1);
  assert.equal(result.stats.skipReasons.already_evaluated_duplicate, 1);
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

// --- BL-9: fit verdict persistence on commit --------------------------------

test("prepare --phase commit (BL-9): to_apply persists fit_score=Strong + rationale + timestamp", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    results: [
      {
        key: "gh:1",
        decision: "to_apply",
        clKey: "stripe_spm_cl",
        notionPageId: "p1",
        fitScore: "Strong",
        fitRationale: "Direct PM/fintech match — Capital portfolio overlap",
      },
    ],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  await cmd(ctx);
  const app = deps._getSaved()[0];
  assert.equal(app.status, "To Apply");
  assert.equal(app.fit_score, "Strong");
  assert.equal(app.fit_rationale, "Direct PM/fintech match — Capital portfolio overlap");
  assert.equal(app.fit_evaluated_at, "2026-04-20T13:00:00.000Z");
  assert.equal(app.skip_reason || "", "");
});

test("prepare --phase commit (BL-9): skip persists fit_score=Weak + skip_reason=weak_fit", async () => {
  // The whole point of Step 2 + Step 3: a Weak verdict on this run must be
  // re-readable next run so filterAlreadyEvaluated drops it without paying
  // SKILL cost again.
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    results: [
      {
        key: "gh:1",
        decision: "skip",
        fitScore: "Weak",
        fitRationale: "Energy domain — outside PM core",
        skipReason: "weak_fit",
      },
    ],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  await cmd(ctx);
  const app = deps._getSaved()[0];
  // skip leaves status untouched but fit fields ARE written.
  assert.equal(app.status, "To Apply");
  assert.equal(app.fit_score, "Weak");
  assert.equal(app.skip_reason, "weak_fit");
  assert.equal(app.fit_rationale, "Energy domain — outside PM core");
  assert.equal(app.fit_evaluated_at, "2026-04-20T13:00:00.000Z");
});

test("prepare --phase commit (BL-9): skip with skip_reason=duplicate persists for next-run filter", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    results: [
      {
        key: "gh:1",
        decision: "skip",
        fitRationale: "Duplicate of greenhouse:1234 — same posting different ATS",
        skipReason: "duplicate",
      },
    ],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  await cmd(ctx);
  const app = deps._getSaved()[0];
  assert.equal(app.skip_reason, "duplicate");
  assert.equal(app.fit_rationale, "Duplicate of greenhouse:1234 — same posting different ATS");
});

test("prepare --phase commit (BL-9): archive persists fit verdict alongside status change", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    results: [
      {
        key: "gh:1",
        decision: "archive",
        fitScore: "Weak",
        fitRationale: "Hard blocker — non-PM role mis-classified at scan",
        skipReason: "weak_fit",
      },
    ],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  await cmd(ctx);
  const app = deps._getSaved()[0];
  assert.equal(app.status, "Archived");
  assert.equal(app.fit_score, "Weak");
  assert.equal(app.skip_reason, "weak_fit");
});

test("prepare --phase commit (BL-9): invalid fitScore warns and is not persisted", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply", fit_score: "" })];
  const results = {
    profileId: "testuser",
    results: [
      { key: "gh:1", decision: "skip", fitScore: "MaybeStrong", skipReason: "weak_fit" },
    ],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  await cmd(ctx);
  const app = deps._getSaved()[0];
  // Bad fit_score not persisted, but skip_reason still written (independent).
  assert.equal(app.fit_score || "", "");
  assert.equal(app.fit_evaluated_at || "", "");
  assert.equal(app.skip_reason, "weak_fit");
  assert.ok(ctx._errLines.some((l) => /invalid fitScore "MaybeStrong"/.test(l)));
});

test("prepare --phase commit (BL-9): invalid skipReason warns and is not persisted", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const results = {
    profileId: "testuser",
    results: [
      { key: "gh:1", decision: "skip", fitScore: "Weak", skipReason: "not_a_pm_role" },
    ],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  await cmd(ctx);
  const app = deps._getSaved()[0];
  // fit_score still written, skip_reason rejected.
  assert.equal(app.fit_score, "Weak");
  assert.equal(app.skip_reason || "", "");
  assert.ok(ctx._errLines.some((l) => /invalid skipReason "not_a_pm_role"/.test(l)));
});

test("prepare --phase commit (BL-9): result without fit fields leaves existing TSV values untouched", async () => {
  // Back-compat: SKILL versions that don't yet emit fit fields must not wipe
  // the column. This protects against partial migrations / older tooling.
  const apps = [
    makeApp({
      key: "gh:1",
      status: "To Apply",
      fit_score: "Strong",
      fit_rationale: "earlier rationale",
      fit_evaluated_at: "2026-05-01T00:00:00Z",
    }),
  ];
  const results = {
    profileId: "testuser",
    results: [{ key: "gh:1", decision: "to_apply", clKey: "k", notionPageId: "p1" }],
  };
  const deps = makeCommitDeps(apps, { readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  await cmd(ctx);
  const app = deps._getSaved()[0];
  assert.equal(app.fit_score, "Strong");
  assert.equal(app.fit_rationale, "earlier rationale");
  assert.equal(app.fit_evaluated_at, "2026-05-01T00:00:00Z");
});

test("prepare --phase commit (BL-9): downgraded-to-skip path (invalid resumeVer) still captures verdict", async () => {
  // When commit downgrades a to_apply to skip due to invalid resumeVer, the
  // fit verdict should still be written so the user doesn't see this row
  // re-evaluated next run.
  const apps = [makeApp({ key: "gh:1", status: "To Apply" })];
  const profile = {
    id: "testuser",
    filterRules: {},
    company_tiers: {},
    resumeVersions: { versions: { real_key: { name: "Real" } } },
    paths: {
      root: "/fake/profiles/testuser",
      applicationsTsv: "/fake/profiles/testuser/applications.tsv",
      jdCacheDir: "/fake/profiles/testuser/jd_cache",
    },
  };
  const results = {
    profileId: "testuser",
    results: [
      {
        key: "gh:1",
        decision: "to_apply",
        resumeVer: "typo_key",
        fitScore: "Strong",
        fitRationale: "Good fit, but typo will downgrade",
      },
    ],
  };
  const deps = makeCommitDeps(apps, { profile, readFile: () => JSON.stringify(results) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  await cmd(ctx);
  const app = deps._getSaved()[0];
  assert.ok(ctx._errLines.some((l) => /unknown resumeVer/.test(l)));
  // Status not promoted (skip), but fit STILL captured.
  assert.equal(app.fit_score, "Strong");
  assert.equal(app.fit_evaluated_at, "2026-04-20T13:00:00.000Z");
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

// --- BL-14 / RFC 019: engine-owned CL file writes ---------------------------

// Helper that captures all CL-related side effects (MD writes, PDF generates,
// fileExists probes, mkdir calls). Each test instantiates one and asserts
// against the recorded log instead of touching the real filesystem.
function makeClRecorder({ existing = new Set() } = {}) {
  const writes = [];
  const pdfs = [];
  const mkdirs = [];
  return {
    writes,
    pdfs,
    mkdirs,
    deps: {
      writeFile: (p, data) => writes.push({ path: p, data }),
      generateCoverLetterPdf: async ({ paragraphs }, p) => {
        pdfs.push({ path: p, paragraphs });
      },
      fileExists: (p) => existing.has(p),
      mkdirp: (d) => mkdirs.push(d),
      slugifyCompany: (n) =>
        // Intentionally use the real implementation so tests verify the
        // contract the engine relies on (not a fake that drifts).
        require("../core/company_slug.js").slugifyCompany(n),
    },
  };
}

test("prepare --phase commit (BL-14): to_apply with clParagraphs writes MD + PDF, sets canonical cl_path", async () => {
  const apps = [makeApp({ key: "gh:1", status: "Inbox", companyName: "Affirm" })];
  const results = {
    profileId: "testuser",
    results: [
      {
        key: "gh:1",
        decision: "to_apply",
        clKey: "Affirm_Senior_PM_20260505",
        resumeVer: "Risk_Fraud",
        clParagraphs: [
          "Dear Affirm hiring team,",
          "I'm excited about the Senior PM role.",
          "My background in fintech maps well to risk and underwriting work.",
          "Best, Jared",
        ],
      },
    ],
  };
  const rec = makeClRecorder();
  const deps = makeCommitDeps(apps, {
    readFile: () => JSON.stringify(results),
    ...rec.deps,
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  const code = await cmd(ctx);
  assert.equal(code, 0);

  // MD written into cover_letters_md/<slug>/
  assert.equal(rec.writes.length, 1);
  assert.equal(
    rec.writes[0].path,
    "/fake/profiles/testuser/cover_letters_md/Affirm/Affirm_Senior_PM_20260505.md"
  );
  // Paragraphs joined by blank lines + trailing newline.
  assert.equal(
    rec.writes[0].data,
    [
      "Dear Affirm hiring team,",
      "I'm excited about the Senior PM role.",
      "My background in fintech maps well to risk and underwriting work.",
      "Best, Jared",
    ].join("\n\n") + "\n"
  );

  // PDF written into cover_letters/<slug>/
  assert.equal(rec.pdfs.length, 1);
  assert.equal(
    rec.pdfs[0].path,
    "/fake/profiles/testuser/cover_letters/Affirm/Affirm_Senior_PM_20260505.pdf"
  );
  assert.deepEqual(rec.pdfs[0].paragraphs, results.results[0].clParagraphs);

  // PDF dir was mkdir'd before generation.
  assert.ok(
    rec.mkdirs.includes("/fake/profiles/testuser/cover_letters/Affirm")
  );

  // TSV cl_path = canonical relative PDF path.
  const saved = deps._getSaved();
  assert.equal(saved[0].cl_path, "cover_letters/Affirm/Affirm_Senior_PM_20260505.pdf");
});

test("prepare --phase commit (BL-14): existing PDF is preserved (idempotent)", async () => {
  const apps = [makeApp({ key: "gh:1", status: "Inbox", companyName: "Stripe" })];
  const pdfPath = "/fake/profiles/testuser/cover_letters/Stripe/Stripe_PM_20260505.pdf";
  const results = {
    profileId: "testuser",
    results: [
      {
        key: "gh:1",
        decision: "to_apply",
        clKey: "Stripe_PM_20260505",
        resumeVer: "v1",
        clParagraphs: ["P1", "P2"],
      },
    ],
  };
  const rec = makeClRecorder({ existing: new Set([pdfPath]) });
  const deps = makeCommitDeps(apps, {
    readFile: () => JSON.stringify(results),
    ...rec.deps,
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  await cmd(ctx);

  // MD still overwritten.
  assert.equal(rec.writes.length, 1);
  // PDF NOT regenerated.
  assert.equal(rec.pdfs.length, 0);
  // No PDF mkdir either (we don't touch the dir if we won't write to it).
  assert.equal(rec.mkdirs.length, 0);
  // cl_path still points at the canonical PDF (the existing one).
  const saved = deps._getSaved();
  assert.equal(saved[0].cl_path, "cover_letters/Stripe/Stripe_PM_20260505.pdf");
});

test("prepare --phase commit (BL-14): slugifies company with ampersand into folder name", async () => {
  const apps = [makeApp({ key: "gh:1", status: "Inbox", companyName: "Procter & Gamble" })];
  const results = {
    profileId: "testuser",
    results: [
      {
        key: "gh:1",
        decision: "to_apply",
        clKey: "PG_PM_20260505",
        resumeVer: "v1",
        clParagraphs: ["only para"],
      },
    ],
  };
  const rec = makeClRecorder();
  const deps = makeCommitDeps(apps, {
    readFile: () => JSON.stringify(results),
    ...rec.deps,
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  await cmd(ctx);

  assert.match(rec.writes[0].path, /cover_letters_md\/Procter_and_Gamble\//);
  assert.match(rec.pdfs[0].path, /cover_letters\/Procter_and_Gamble\//);
  const saved = deps._getSaved();
  assert.equal(
    saved[0].cl_path,
    "cover_letters/Procter_and_Gamble/PG_PM_20260505.pdf"
  );
});

test("prepare --phase commit (BL-14): dry-run does not write files but plans cl_path", async () => {
  const apps = [makeApp({ key: "gh:1", status: "Inbox", companyName: "Affirm" })];
  const results = {
    profileId: "testuser",
    results: [
      {
        key: "gh:1",
        decision: "to_apply",
        clKey: "Affirm_PM_20260505",
        resumeVer: "v1",
        clParagraphs: ["P1", "P2"],
      },
    ],
  };
  const rec = makeClRecorder();
  const deps = makeCommitDeps(apps, {
    readFile: () => JSON.stringify(results),
    ...rec.deps,
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json", dryRun: true } });
  await cmd(ctx);

  assert.equal(rec.writes.length, 0);
  assert.equal(rec.pdfs.length, 0);
  // dry-run prints the plan + announces the canonical path; saveApplications
  // is not called, but the in-memory app object reflects the planned cl_path.
  // (Useful for callers that observe ctx output.)
  assert.ok(ctx._lines.some((l) => /\(dry-run\) would write/.test(l)));
});

test("prepare --phase commit (BL-14): PDF generation failure warns but does not abort", async () => {
  const apps = [
    makeApp({ key: "gh:1", status: "Inbox", companyName: "Affirm" }),
    makeApp({ key: "gh:2", status: "Inbox", companyName: "Stripe" }),
  ];
  const results = {
    profileId: "testuser",
    results: [
      {
        key: "gh:1",
        decision: "to_apply",
        clKey: "Affirm_PM_20260505",
        resumeVer: "v1",
        clParagraphs: ["P1"],
      },
      {
        key: "gh:2",
        decision: "to_apply",
        clKey: "Stripe_PM_20260505",
        resumeVer: "v1",
        clParagraphs: ["P1"],
      },
    ],
  };
  const rec = makeClRecorder();
  // First PDF call fails, second succeeds.
  let calls = 0;
  rec.deps.generateCoverLetterPdf = async ({ paragraphs }, p) => {
    calls++;
    if (calls === 1) throw new Error("disk full");
    rec.pdfs.push({ path: p, paragraphs });
  };
  const deps = makeCommitDeps(apps, {
    readFile: () => JSON.stringify(results),
    ...rec.deps,
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  const code = await cmd(ctx);
  assert.equal(code, 0); // overall commit still succeeds
  assert.ok(ctx._errLines.some((l) => /failed to write PDF for gh:1/.test(l)));
  // Second row was still processed.
  assert.equal(rec.pdfs.length, 1);
  assert.match(rec.pdfs[0].path, /Stripe_PM_20260505\.pdf$/);
});

test("prepare --phase commit (BL-14): clParagraphs without clKey warns + skips file write", async () => {
  const apps = [makeApp({ key: "gh:1", status: "Inbox", companyName: "Affirm" })];
  const results = {
    profileId: "testuser",
    results: [
      {
        key: "gh:1",
        decision: "to_apply",
        // clKey intentionally missing
        resumeVer: "v1",
        clParagraphs: ["P1"],
      },
    ],
  };
  const rec = makeClRecorder();
  const deps = makeCommitDeps(apps, {
    readFile: () => JSON.stringify(results),
    ...rec.deps,
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  await cmd(ctx);
  assert.equal(rec.writes.length, 0);
  assert.equal(rec.pdfs.length, 0);
  assert.ok(ctx._errLines.some((l) => /clParagraphs present but clKey missing/.test(l)));
});

test("prepare --phase commit (BL-14): to_apply WITHOUT clParagraphs warns (regression guard)", async () => {
  const apps = [makeApp({ key: "gh:1", status: "Inbox", companyName: "Affirm" })];
  const results = {
    profileId: "testuser",
    // No clParagraphs — old SKILL behavior. Engine should flag this.
    results: [
      {
        key: "gh:1",
        decision: "to_apply",
        clKey: "Affirm_PM_20260505",
        resumeVer: "v1",
      },
    ],
  };
  const rec = makeClRecorder();
  const deps = makeCommitDeps(apps, {
    readFile: () => JSON.stringify(results),
    ...rec.deps,
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "commit", resultsFile: "/r.json" } });
  await cmd(ctx);
  // Engine wrote nothing (legacy path) but warned.
  assert.equal(rec.writes.length, 0);
  assert.equal(rec.pdfs.length, 0);
  assert.ok(
    ctx._errLines.some((l) =>
      /to_apply row\(s\) missing clParagraphs/.test(l)
    ),
    `expected legacy-row warning, got: ${ctx._errLines.join(" | ")}`
  );
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

// --- BL-9 Step 4: deferredQueue + topup mode ---------------------------------

test("prepare --phase pre fresh (BL-9 Step 4): writes deferredQueue + mode=fresh", async () => {
  // 10 apps, batchSize=5, all alive. Iter 1: chunk=max(5,5)=5, consumed=5,
  // 5 alive → aliveResults=5 (target met). deferredQueue = passed.slice(5) =
  // 5 remaining keys, in order.
  const apps = Array.from({ length: 10 }, (_, i) =>
    makeApp({ key: `gh:${i}`, jobId: String(i) })
  );
  const deps = makePrepDeps(apps);
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", batch: 5, dryRun: false } });
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch.length, 5);
  assert.equal(result.mode, "fresh");
  assert.deepEqual(result.deferredQueue, ["gh:5", "gh:6", "gh:7", "gh:8", "gh:9"]);
  assert.equal(result.stats.deferred, 5);
});

test("prepare --phase pre topup (BL-9 Step 4): appends new entries to existing batch", async () => {
  // TSV: 4 fresh apps. Pre-context: 2 in batch (gh:0/1), 2 in queue (gh:2/3).
  // --need 2. Topup pulls both queue entries → batch grows to 4, queue empties.
  const apps = [
    makeApp({ key: "gh:0", jobId: "0" }),
    makeApp({ key: "gh:1", jobId: "1" }),
    makeApp({ key: "gh:2", jobId: "2" }),
    makeApp({ key: "gh:3", jobId: "3" }),
  ];
  const prevContext = {
    version: 1,
    profileId: "testuser",
    mode: "fresh",
    batchSize: 4,
    batch: [
      { key: "gh:0", source: "greenhouse", jobId: "0", companyName: "Stripe", title: "PM", url: "https://example.com/0", urlAlive: true, urlStatus: 200 },
      { key: "gh:1", source: "greenhouse", jobId: "1", companyName: "Stripe", title: "PM", url: "https://example.com/1", urlAlive: true, urlStatus: 200 },
    ],
    skipped: [],
    deferredQueue: ["gh:2", "gh:3"],
    unknownTierCompanies: [],
    stats: { urlChecked: 2, urlAlive: 2, urlDead: 0, deferred: 2, skipReasons: {} },
  };
  const deps = makePrepDeps(apps, {
    readFile: () => JSON.stringify(prevContext),
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", mode: "topup", need: 2, batch: 4, dryRun: false } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.mode, "topup");
  assert.equal(result.batch.length, 4);
  assert.equal(result.batch[0].key, "gh:0");
  assert.equal(result.batch[1].key, "gh:1");
  assert.equal(result.batch[2].key, "gh:2");
  assert.equal(result.batch[3].key, "gh:3");
  assert.equal(result.deferredQueue.length, 0);
  assert.equal(result.stats.topupRuns, 1);
  // urlChecked is cumulative (2 from fresh + 2 from topup).
  assert.equal(result.stats.urlChecked, 4);
  assert.equal(result.stats.inBatch, 4);
});

test("prepare --phase pre topup (BL-9 Step 4): drops keys that have moved out of Inbox", async () => {
  // gh:2 has been committed (status=Applied) since the fresh run wrote queue.
  // Topup must drop it with reason no_longer_fresh.
  const apps = [
    makeApp({ key: "gh:0", status: "To Apply", notion_page_id: "p0" }),
    makeApp({ key: "gh:1", status: "To Apply", notion_page_id: "p1" }),
    makeApp({ key: "gh:2", status: "Applied", notion_page_id: "p2", jobId: "2" }),
    makeApp({ key: "gh:3", status: "To Apply", notion_page_id: "", jobId: "3" }),
  ];
  const prevContext = {
    version: 1,
    profileId: "testuser",
    mode: "fresh",
    batchSize: 4,
    batch: [
      { key: "gh:0", source: "greenhouse", jobId: "0", companyName: "Stripe", title: "PM", url: "https://example.com/0", urlAlive: true, urlStatus: 200 },
      { key: "gh:1", source: "greenhouse", jobId: "1", companyName: "Stripe", title: "PM", url: "https://example.com/1", urlAlive: true, urlStatus: 200 },
    ],
    skipped: [],
    deferredQueue: ["gh:2", "gh:3"],
    unknownTierCompanies: [],
    stats: {},
  };
  const deps = makePrepDeps(apps, {
    readFile: () => JSON.stringify(prevContext),
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", mode: "topup", need: 2, batch: 4, dryRun: false } });
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  // Only gh:3 added. gh:2 is in skipped[] with no_longer_fresh.
  assert.equal(result.batch.length, 3);
  assert.equal(result.batch[2].key, "gh:3");
  const drop = result.skipped.find((s) => s.key === "gh:2");
  assert.ok(drop);
  assert.equal(drop.reason, "no_longer_fresh");
});

test("prepare --phase pre topup (BL-9 Step 4): drops keys whose commit added fit_score=Weak", async () => {
  // Between fresh and topup, the SKILL committed a Weak verdict on gh:2.
  // filterAlreadyEvaluated must drop it with already_evaluated_weak.
  const apps = [
    makeApp({ key: "gh:0", status: "To Apply", notion_page_id: "p0" }),
    makeApp({ key: "gh:1", status: "To Apply", notion_page_id: "p1" }),
    makeApp({ key: "gh:2", fit_score: "Weak", skip_reason: "weak_fit", jobId: "2" }),
    makeApp({ key: "gh:3", jobId: "3" }),
  ];
  const prevContext = {
    version: 1,
    profileId: "testuser",
    mode: "fresh",
    batchSize: 4,
    batch: [
      { key: "gh:0", source: "greenhouse", jobId: "0", companyName: "Stripe", title: "PM", url: "https://example.com/0", urlAlive: true, urlStatus: 200 },
      { key: "gh:1", source: "greenhouse", jobId: "1", companyName: "Stripe", title: "PM", url: "https://example.com/1", urlAlive: true, urlStatus: 200 },
    ],
    skipped: [],
    deferredQueue: ["gh:2", "gh:3"],
    unknownTierCompanies: [],
    stats: {},
  };
  const deps = makePrepDeps(apps, { readFile: () => JSON.stringify(prevContext) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", mode: "topup", need: 2, batch: 4, dryRun: false } });
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch.length, 3);
  assert.equal(result.batch[2].key, "gh:3");
  const drop = result.skipped.find((s) => s.key === "gh:2");
  assert.ok(drop);
  assert.equal(drop.reason, "already_evaluated_weak");
  assert.equal(result.stats.alreadyEvaluated, 1);
});

test("prepare --phase pre topup (BL-9 Step 4): empty deferredQueue is a no-op (no write)", async () => {
  const apps = [makeApp()];
  const prevContext = {
    version: 1,
    profileId: "testuser",
    mode: "fresh",
    batchSize: 30,
    batch: [{ key: "greenhouse:1001", companyName: "Stripe", title: "PM" }],
    skipped: [],
    deferredQueue: [],
    unknownTierCompanies: [],
    stats: {},
  };
  let writeCalls = 0;
  const deps = makePrepDeps(apps, {
    readFile: () => JSON.stringify(prevContext),
    writeFile: () => { writeCalls++; },
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", mode: "topup", need: 5, batch: 30, dryRun: false } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  assert.equal(writeCalls, 0);
});

test("prepare --phase pre topup (BL-9 Step 4): default --need is batchSize - currentBatch (deficit)", async () => {
  // batchSize=30, currentBatch=20 → default need=10. Queue has 15 alive.
  // Topup adds 10, queue becomes 5.
  const apps = Array.from({ length: 35 }, (_, i) =>
    makeApp({ key: `gh:${i}`, jobId: String(i) })
  );
  const batchEntries = Array.from({ length: 20 }, (_, i) => ({
    key: `gh:${i}`,
    source: "greenhouse",
    jobId: String(i),
    companyName: "Stripe",
    title: "PM",
    url: `https://example.com/${i}`,
    urlAlive: true,
    urlStatus: 200,
  }));
  const queueKeys = Array.from({ length: 15 }, (_, i) => `gh:${i + 20}`);
  const prevContext = {
    version: 1,
    profileId: "testuser",
    mode: "fresh",
    batchSize: 30,
    batch: batchEntries,
    skipped: [],
    deferredQueue: queueKeys,
    unknownTierCompanies: [],
    stats: {},
  };
  const deps = makePrepDeps(apps, { readFile: () => JSON.stringify(prevContext) });
  const cmd = makePrepareCommand(deps);
  // No --need flag passed → defaults to batchSize - currentBatch = 10.
  const ctx = makeCtx({ flags: { phase: "pre", mode: "topup", batch: 30, dryRun: false } });
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch.length, 30);
  assert.equal(result.deferredQueue.length, 5);
});

test("prepare --phase pre topup (BL-9 Step 4): missing prepare_context.json returns 1", async () => {
  const apps = [makeApp()];
  const deps = makePrepDeps(apps, {
    readFile: () => { throw new Error("ENOENT"); },
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", mode: "topup", need: 5, batch: 30, dryRun: false } });
  const code = await cmd(ctx);
  assert.equal(code, 1);
  assert.ok(ctx._errLines.some((l) => /cannot read prepare_context/.test(l)));
});

test("prepare --phase pre topup (BL-9 Step 4): dry-run does not write file", async () => {
  const apps = [
    makeApp({ key: "gh:0" }),
    makeApp({ key: "gh:1", jobId: "1" }),
    makeApp({ key: "gh:2", jobId: "2" }),
  ];
  const prevContext = {
    version: 1,
    profileId: "testuser",
    mode: "fresh",
    batchSize: 30,
    batch: [{ key: "gh:0", source: "greenhouse", jobId: "0", companyName: "Stripe", title: "PM", url: "https://example.com/0", urlAlive: true, urlStatus: 200 }],
    skipped: [],
    deferredQueue: ["gh:1", "gh:2"],
    unknownTierCompanies: [],
    stats: {},
  };
  const deps = makePrepDeps(apps, { readFile: () => JSON.stringify(prevContext) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", mode: "topup", need: 2, batch: 30, dryRun: true } });
  await cmd(ctx);
  assert.equal(Object.keys(deps._written).length, 0);
  assert.ok(ctx._lines.some((l) => /dry-run/.test(l)));
});

test("prepare --phase pre (BL-9 Step 4): unknown --mode returns 1", async () => {
  const apps = [makeApp()];
  const deps = makePrepDeps(apps);
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", mode: "weird", batch: 30, dryRun: false } });
  const code = await cmd(ctx);
  assert.equal(code, 1);
  assert.ok(ctx._errLines.some((l) => /unknown --mode/.test(l)));
});

// --- BL-9 Step 5: weak-fallback + inboxExhausted -----------------------------

test("filterAlreadyEvaluated weak-fallback mode: keeps Weak rows, still drops duplicates", () => {
  const apps = [
    makeApp({ key: "a", fit_score: "Weak" }),
    makeApp({ key: "b", skip_reason: "weak_fit" }),
    makeApp({ key: "c", skip_reason: "duplicate" }),
    makeApp({ key: "d" }),
  ];
  const { passed, skipped } = filterAlreadyEvaluated(apps, { mode: "weak-fallback" });
  // a + b + d pass; c drops as duplicate.
  assert.deepEqual(passed.map((a) => a.key).sort(), ["a", "b", "d"]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].key, "c");
  assert.equal(skipped[0].reason, "already_evaluated_duplicate");
});

test("isFreshInboxApp: true for status=Inbox", () => {
  assert.equal(isFreshInboxApp(makeApp({ status: "Inbox" })), true);
});

test("isFreshInboxApp: true for legacy 'To Apply' without notion_page_id", () => {
  assert.equal(isFreshInboxApp(makeApp({ status: "To Apply", notion_page_id: "" })), true);
});

test("isFreshInboxApp: false for committed To Apply (has notion_page_id)", () => {
  assert.equal(
    isFreshInboxApp(makeApp({ status: "To Apply", notion_page_id: "p1" })),
    false
  );
});

test("isFreshInboxApp: false for Applied / Rejected / Archived", () => {
  for (const status of ["Applied", "Rejected", "Archived", "Closed"]) {
    assert.equal(isFreshInboxApp(makeApp({ status })), false, `status=${status}`);
  }
});

test("computeInboxExhausted: false when fresh-Inbox row exists outside batch", () => {
  const apps = [
    makeApp({ key: "a", status: "Inbox" }),
    makeApp({ key: "b", status: "Inbox" }),
  ];
  assert.equal(computeInboxExhausted(apps, new Set(["a"])), false);
});

test("computeInboxExhausted: true when all fresh rows are in batch", () => {
  const apps = [
    makeApp({ key: "a", status: "Inbox" }),
    makeApp({ key: "b", status: "Inbox" }),
  ];
  assert.equal(computeInboxExhausted(apps, new Set(["a", "b"])), true);
});

test("computeInboxExhausted: ignores duplicate-flagged rows", () => {
  // Only fresh-Inbox row left is duplicate-flagged → still exhausted.
  const apps = [
    makeApp({ key: "a", status: "Inbox" }),
    makeApp({ key: "b", status: "Inbox", skip_reason: "duplicate" }),
  ];
  assert.equal(computeInboxExhausted(apps, new Set(["a"])), true);
});

test("computeInboxExhausted: counts already-Weak rows as not-exhausted", () => {
  // Weak rows are still pull-able by weak-fallback → don't count as exhausted.
  const apps = [
    makeApp({ key: "a", status: "Inbox" }),
    makeApp({ key: "b", status: "Inbox", fit_score: "Weak" }),
  ];
  assert.equal(computeInboxExhausted(apps, new Set(["a"])), false);
});

test("prepare --phase pre fresh (BL-9 Step 5): writes inboxExhausted=true when batch consumes all fresh", async () => {
  // 2 fresh apps, both fit in batch=2. After fresh run, no more queued, no more
  // weak rows → exhausted.
  const apps = [
    makeApp({ key: "gh:0", jobId: "0", status: "Inbox" }),
    makeApp({ key: "gh:1", jobId: "1", status: "Inbox" }),
  ];
  const deps = makePrepDeps(apps);
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", batch: 5, dryRun: false } });
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.stats.inboxExhausted, true);
});

test("prepare --phase pre fresh (BL-9 Step 5): inboxExhausted=false when already-Weak rows remain", async () => {
  // Fresh run consumes the 1 fresh row. The Weak row was filtered by
  // filterAlreadyEvaluated and never reached the batch — but it's still
  // available for weak-fallback. Inbox NOT exhausted yet.
  const apps = [
    makeApp({ key: "gh:0", jobId: "0", status: "Inbox" }),
    makeApp({ key: "gh:1", jobId: "1", status: "Inbox", fit_score: "Weak" }),
  ];
  const deps = makePrepDeps(apps);
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", batch: 5, dryRun: false } });
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch.length, 1);
  assert.equal(result.batch[0].key, "gh:0");
  assert.equal(result.stats.inboxExhausted, false);
});

test("prepare --phase pre weak-fallback (BL-9 Step 5): pulls already-Weak rows into batch with wasAlreadyWeak=true", async () => {
  // gh:0 is in batch (already from a prior pass). gh:1 has been judged Weak.
  // weak-fallback should pull gh:1 in with wasAlreadyWeak=true.
  const apps = [
    makeApp({ key: "gh:0", status: "To Apply", notion_page_id: "p0" }),
    makeApp({
      key: "gh:1",
      jobId: "1",
      status: "Inbox",
      fit_score: "Weak",
      fit_rationale: "no fintech overlap",
    }),
  ];
  const prevContext = {
    version: 1,
    profileId: "testuser",
    mode: "topup",
    batchSize: 4,
    batch: [
      { key: "gh:0", source: "greenhouse", jobId: "0", companyName: "Stripe", title: "PM", url: "https://example.com/0", urlAlive: true, urlStatus: 200 },
    ],
    skipped: [],
    deferredQueue: [],
    unknownTierCompanies: [],
    stats: {},
  };
  const deps = makePrepDeps(apps, { readFile: () => JSON.stringify(prevContext) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", mode: "weak-fallback", need: 3, batch: 4, dryRun: false } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.mode, "weak-fallback");
  assert.equal(result.batch.length, 2);
  const newEntry = result.batch[1];
  assert.equal(newEntry.key, "gh:1");
  assert.equal(newEntry.wasAlreadyWeak, true);
  assert.equal(newEntry.priorFitScore, "Weak");
  assert.equal(newEntry.priorFitRationale, "no fintech overlap");
  assert.equal(result.stats.weakFallbackRuns, 1);
});

test("prepare --phase pre weak-fallback (BL-9 Step 5): combines deferredQueue + already-Weak (dedupes)", async () => {
  // gh:1 is in queue (passed filter, not URL-checked yet, no verdict).
  // gh:2 is already-Weak.
  // gh:3 is in BOTH queue AND already-Weak in TSV — must appear once.
  const apps = [
    makeApp({ key: "gh:0", status: "To Apply", notion_page_id: "p0" }),
    makeApp({ key: "gh:1", jobId: "1", status: "Inbox" }),
    makeApp({ key: "gh:2", jobId: "2", status: "Inbox", fit_score: "Weak" }),
    makeApp({ key: "gh:3", jobId: "3", status: "Inbox", fit_score: "Weak" }),
  ];
  const prevContext = {
    version: 1,
    profileId: "testuser",
    mode: "topup",
    batchSize: 5,
    batch: [
      { key: "gh:0", source: "greenhouse", jobId: "0", companyName: "Stripe", title: "PM", url: "https://example.com/0", urlAlive: true, urlStatus: 200 },
    ],
    skipped: [],
    deferredQueue: ["gh:1", "gh:3"],
    unknownTierCompanies: [],
    stats: {},
  };
  const deps = makePrepDeps(apps, { readFile: () => JSON.stringify(prevContext) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", mode: "weak-fallback", need: 5, batch: 5, dryRun: false } });
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  // Should pull all 3 distinct keys (gh:1, gh:2, gh:3).
  const newKeys = result.batch.slice(1).map((e) => e.key).sort();
  assert.deepEqual(newKeys, ["gh:1", "gh:2", "gh:3"]);
  // gh:1 came from queue, NOT marked weak. gh:2 and gh:3 are weak.
  const e1 = result.batch.find((e) => e.key === "gh:1");
  const e2 = result.batch.find((e) => e.key === "gh:2");
  const e3 = result.batch.find((e) => e.key === "gh:3");
  assert.ok(!e1.wasAlreadyWeak);
  assert.equal(e2.wasAlreadyWeak, true);
  assert.equal(e3.wasAlreadyWeak, true);
});

test("prepare --phase pre weak-fallback (BL-9 Step 5): drops duplicate-flagged rows even in this mode", async () => {
  const apps = [
    makeApp({ key: "gh:0", status: "To Apply", notion_page_id: "p0" }),
    makeApp({ key: "gh:1", jobId: "1", status: "Inbox", fit_score: "Weak" }),
    makeApp({ key: "gh:2", jobId: "2", status: "Inbox", skip_reason: "duplicate" }),
  ];
  const prevContext = {
    version: 1,
    profileId: "testuser",
    mode: "topup",
    batchSize: 4,
    batch: [
      { key: "gh:0", source: "greenhouse", jobId: "0", companyName: "Stripe", title: "PM", url: "https://example.com/0", urlAlive: true, urlStatus: 200 },
    ],
    skipped: [],
    deferredQueue: ["gh:2"],
    unknownTierCompanies: [],
    stats: {},
  };
  const deps = makePrepDeps(apps, { readFile: () => JSON.stringify(prevContext) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", mode: "weak-fallback", need: 3, batch: 4, dryRun: false } });
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  // Only gh:1 added; gh:2 dropped as duplicate.
  assert.equal(result.batch.length, 2);
  assert.equal(result.batch[1].key, "gh:1");
  assert.ok(result.skipped.some((s) => s.key === "gh:2" && s.reason === "already_evaluated_duplicate"));
});

test("prepare --phase pre weak-fallback (BL-9 Step 5): empty pool — writes mode + stats, no batch growth", async () => {
  const apps = [
    makeApp({ key: "gh:0", status: "To Apply", notion_page_id: "p0" }),
  ];
  const prevContext = {
    version: 1,
    profileId: "testuser",
    mode: "topup",
    batchSize: 4,
    batch: [
      { key: "gh:0", source: "greenhouse", jobId: "0", companyName: "Stripe", title: "PM", url: "https://example.com/0", urlAlive: true, urlStatus: 200 },
    ],
    skipped: [],
    deferredQueue: [],
    unknownTierCompanies: [],
    stats: {},
  };
  const deps = makePrepDeps(apps, { readFile: () => JSON.stringify(prevContext) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", mode: "weak-fallback", need: 3, batch: 4, dryRun: false } });
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.mode, "weak-fallback");
  assert.equal(result.batch.length, 1);
  assert.equal(result.stats.weakFallbackRuns, 1);
  assert.equal(result.stats.inboxExhausted, true);
});

test("prepare --phase pre weak-fallback (BL-9 Step 5): inboxExhausted=true after consuming all weak rows", async () => {
  // 1 already-Weak row in TSV. weak-fallback pulls it into batch. After that,
  // no fresh rows remain.
  const apps = [
    makeApp({ key: "gh:0", status: "To Apply", notion_page_id: "p0" }),
    makeApp({ key: "gh:1", jobId: "1", status: "Inbox", fit_score: "Weak" }),
  ];
  const prevContext = {
    version: 1,
    profileId: "testuser",
    mode: "topup",
    batchSize: 4,
    batch: [
      { key: "gh:0", source: "greenhouse", jobId: "0", companyName: "Stripe", title: "PM", url: "https://example.com/0", urlAlive: true, urlStatus: 200 },
    ],
    skipped: [],
    deferredQueue: [],
    unknownTierCompanies: [],
    stats: {},
  };
  const deps = makePrepDeps(apps, { readFile: () => JSON.stringify(prevContext) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", mode: "weak-fallback", need: 3, batch: 4, dryRun: false } });
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.stats.inboxExhausted, true);
});

test("prepare --phase pre weak-fallback (BL-9 Step 5): respects company cap (pre-accounts prevBatch)", async () => {
  // Company cap = 2 active for Stripe. prevBatch already has 2 Stripe entries.
  // Cap pre-account → topup must NOT add more Stripe rows.
  const apps = [
    makeApp({ key: "gh:0", status: "To Apply", notion_page_id: "p0" }),
    makeApp({ key: "gh:1", status: "To Apply", notion_page_id: "p1" }),
    makeApp({ key: "gh:2", jobId: "2", status: "Inbox", fit_score: "Weak", companyName: "Stripe" }),
  ];
  const prevContext = {
    version: 1,
    profileId: "testuser",
    mode: "topup",
    batchSize: 5,
    batch: [
      { key: "gh:0", source: "greenhouse", jobId: "0", companyName: "Stripe", title: "PM", url: "https://example.com/0", urlAlive: true, urlStatus: 200 },
      { key: "gh:1", source: "greenhouse", jobId: "1", companyName: "Stripe", title: "PM", url: "https://example.com/1", urlAlive: true, urlStatus: 200 },
    ],
    skipped: [],
    deferredQueue: [],
    unknownTierCompanies: [],
    stats: {},
  };
  const deps = makePrepDeps(apps, {
    readFile: () => JSON.stringify(prevContext),
    loadProfile: () => ({
      id: "testuser",
      filterRules: { company_cap: { max_active: 2 } },
      company_tiers: { Stripe: "S" },
      paths: {
        root: "/fake/profiles/testuser",
        applicationsTsv: "/fake/profiles/testuser/applications.tsv",
        jdCacheDir: "/fake/profiles/testuser/jd_cache",
      },
    }),
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", mode: "weak-fallback", need: 3, batch: 5, dryRun: false } });
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  // gh:2 must be skipped with company_cap.
  assert.equal(result.batch.length, 2);
  assert.ok(result.skipped.some((s) => s.key === "gh:2" && s.reason === "company_cap"));
});

test("prepare --phase pre weak-fallback (BL-9 Step 5): missing prepare_context.json returns 1", async () => {
  const apps = [makeApp()];
  const deps = makePrepDeps(apps, {
    readFile: () => { throw new Error("ENOENT"); },
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", mode: "weak-fallback", need: 3, batch: 5, dryRun: false } });
  const code = await cmd(ctx);
  assert.equal(code, 1);
  assert.ok(ctx._errLines.some((l) => /cannot read prepare_context/.test(l)));
});

test("prepare --phase pre weak-fallback (BL-9 Step 5): dry-run does not write file", async () => {
  const apps = [
    makeApp({ key: "gh:0", status: "To Apply", notion_page_id: "p0" }),
    makeApp({ key: "gh:1", jobId: "1", status: "Inbox", fit_score: "Weak" }),
  ];
  const prevContext = {
    version: 1,
    profileId: "testuser",
    mode: "topup",
    batchSize: 4,
    batch: [
      { key: "gh:0", source: "greenhouse", jobId: "0", companyName: "Stripe", title: "PM", url: "https://example.com/0", urlAlive: true, urlStatus: 200 },
    ],
    skipped: [],
    deferredQueue: [],
    unknownTierCompanies: [],
    stats: {},
  };
  const deps = makePrepDeps(apps, { readFile: () => JSON.stringify(prevContext) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", mode: "weak-fallback", need: 3, batch: 4, dryRun: true } });
  await cmd(ctx);
  assert.equal(Object.keys(deps._written).length, 0);
  assert.ok(ctx._lines.some((l) => /dry-run/.test(l)));
});

test("prepare --phase pre topup (BL-9 Step 5): writes inboxExhausted to stats", async () => {
  // After topup, batch consumes both queue keys. No fresh rows remain.
  const apps = [
    makeApp({ key: "gh:0", status: "To Apply", notion_page_id: "p0" }),
    makeApp({ key: "gh:1", jobId: "1", status: "Inbox" }),
    makeApp({ key: "gh:2", jobId: "2", status: "Inbox" }),
  ];
  const prevContext = {
    version: 1,
    profileId: "testuser",
    mode: "fresh",
    batchSize: 5,
    batch: [
      { key: "gh:0", source: "greenhouse", jobId: "0", companyName: "Stripe", title: "PM", url: "https://example.com/0", urlAlive: true, urlStatus: 200 },
    ],
    skipped: [],
    deferredQueue: ["gh:1", "gh:2"],
    unknownTierCompanies: [],
    stats: {},
  };
  const deps = makePrepDeps(apps, { readFile: () => JSON.stringify(prevContext) });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { phase: "pre", mode: "topup", need: 2, batch: 5, dryRun: false } });
  await cmd(ctx);
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch.length, 3);
  assert.equal(result.stats.inboxExhausted, true);
});

// --- BL-13: auto-dedup at prepare --phase pre --------------------------------

function makeDedupDeps(savedRowsRef, opts = {}) {
  const writes = { backups: [], saved: [], copied: false };
  return {
    now: () => "2026-05-06T10:00:00.000Z",
    fileExists: () => opts.tsvExists !== false,
    copyFileSync: (src, dst) => {
      writes.copied = true;
      writes.backups.push({ src, dst });
    },
    saveApplications: (p, rows) => {
      writes.saved.push({ path: p, rows });
      savedRowsRef.value = rows;
    },
    _writes: writes,
  };
}

function makeDedupCtx(overrides = {}) {
  const lines = [];
  const errLines = [];
  return {
    stdout: (s) => lines.push(s),
    stderr: (s) => errLines.push(s),
    flags: { dryRun: false, ...overrides.flags },
    _lines: lines,
    _errLines: errLines,
  };
}

test("runAutoDedup: silent when no duplicates exist", () => {
  const apps = [makeApp({ key: "gh:1" }), makeApp({ key: "gh:2" })];
  const saved = { value: null };
  const deps = makeDedupDeps(saved);
  const ctx = makeDedupCtx();
  const out = runAutoDedup(apps, "/tmp/applications.tsv", ctx, deps);
  assert.equal(out, apps); // returns input unchanged
  assert.equal(ctx._lines.length, 0);
  assert.equal(ctx._errLines.length, 0);
  assert.equal(deps._writes.saved.length, 0);
  assert.equal(deps._writes.copied, false);
});

test("runAutoDedup: collapses non-suspicious duplicates with backup + explicit found+fixed message", () => {
  // Two rows with the same canonical key (lever:abc ↔ lever:lever:abc) but
  // identical company + url → safe to auto-collapse.
  const winner = makeApp({
    key: "lever:abc",
    source: "lever",
    jobId: "abc",
    companyName: "Stripe",
    url: "https://jobs.lever.co/stripe/abc",
    status: "Applied",
    notion_page_id: "n1",
  });
  const loser = makeApp({
    key: "lever:lever:abc",
    source: "lever",
    jobId: "lever:abc",
    companyName: "Stripe",
    url: "https://jobs.lever.co/stripe/abc",
    status: "Inbox",
    notion_page_id: "",
  });
  const apps = [winner, loser];
  const saved = { value: null };
  const deps = makeDedupDeps(saved);
  const ctx = makeDedupCtx();
  const out = runAutoDedup(apps, "/tmp/p/applications.tsv", ctx, deps);

  // 1. Returns the deduped list, not the original.
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "lever:abc");

  // 2. Backup was taken from the original TSV path, suffixed with timestamp.
  assert.equal(deps._writes.copied, true);
  assert.equal(deps._writes.backups[0].src, "/tmp/p/applications.tsv");
  assert.match(
    deps._writes.backups[0].dst,
    /\/tmp\/p\/applications\.tsv\.pre-dedup-2026-05-06T10-00-00-000Z$/
  );

  // 3. Saved the deduped rows to the same path.
  assert.equal(deps._writes.saved.length, 1);
  assert.equal(deps._writes.saved[0].path, "/tmp/p/applications.tsv");
  assert.equal(deps._writes.saved[0].rows.length, 1);

  // 4. Stdout explicitly mentions BOTH detection AND fix.
  const line = ctx._lines.join("\n");
  assert.match(line, /found 1 duplicate group\(s\)/);
  assert.match(line, /auto-collapsed/);
  assert.match(line, /kept 1 row\(s\)/);
  assert.match(line, /removed 1 row\(s\)/);
  assert.match(line, /backup: applications\.tsv\.pre-dedup-/);
});

test("runAutoDedup: suspicious groups stay untouched + stderr warning", () => {
  // Same canonical key but different company → suspicious. Engine must NOT
  // collapse — could be data corruption or an ATS recycling an id.
  const a = makeApp({
    key: "lever:xyz",
    source: "lever",
    jobId: "xyz",
    companyName: "Stripe",
    url: "https://jobs.lever.co/stripe/xyz",
  });
  const b = makeApp({
    key: "lever:lever:xyz",
    source: "lever",
    jobId: "lever:xyz",
    companyName: "Different Company",
    url: "https://jobs.lever.co/other/xyz",
  });
  const apps = [a, b];
  const saved = { value: null };
  const deps = makeDedupDeps(saved);
  const ctx = makeDedupCtx();
  const out = runAutoDedup(apps, "/tmp/p/applications.tsv", ctx, deps);

  // No write — suspicious is never auto-collapsed.
  assert.equal(deps._writes.saved.length, 0);
  assert.equal(deps._writes.copied, false);
  // Both rows passed through.
  assert.equal(out.length, 2);
  // stderr warning surfaces the count + manual review.
  const err = ctx._errLines.join("\n");
  assert.match(err, /1 suspicious group/);
  assert.match(err, /manual review required/);
});

test("runAutoDedup: dry-run plans without writing", () => {
  const winner = makeApp({
    key: "lever:abc",
    source: "lever",
    jobId: "abc",
    companyName: "Stripe",
    url: "https://jobs.lever.co/stripe/abc",
    status: "Applied",
    notion_page_id: "n1",
  });
  const loser = makeApp({
    key: "lever:lever:abc",
    source: "lever",
    jobId: "lever:abc",
    companyName: "Stripe",
    url: "https://jobs.lever.co/stripe/abc",
    status: "Inbox",
  });
  const apps = [winner, loser];
  const saved = { value: null };
  const deps = makeDedupDeps(saved);
  const ctx = makeDedupCtx({ flags: { dryRun: true } });
  const out = runAutoDedup(apps, "/tmp/p/applications.tsv", ctx, deps);

  // Dry-run returns the *original* apps unchanged so downstream reflects
  // exactly what the user would see if --apply were re-run.
  assert.equal(out.length, 2);
  assert.equal(deps._writes.saved.length, 0);
  assert.equal(deps._writes.copied, false);
  // Stdout still announces what WOULD happen.
  const line = ctx._lines.join("\n");
  assert.match(line, /would auto-collapse 1 duplicate group/);
  assert.match(line, /dry-run, no write/);
});

test("runAutoDedup: backup is skipped when applications.tsv does not yet exist", () => {
  const winner = makeApp({
    key: "lever:abc",
    source: "lever",
    jobId: "abc",
    companyName: "Stripe",
    url: "https://jobs.lever.co/stripe/abc",
  });
  const loser = makeApp({
    key: "lever:lever:abc",
    source: "lever",
    jobId: "lever:abc",
    companyName: "Stripe",
    url: "https://jobs.lever.co/stripe/abc",
  });
  const apps = [winner, loser];
  const saved = { value: null };
  const deps = makeDedupDeps(saved, { tsvExists: false });
  const ctx = makeDedupCtx();
  runAutoDedup(apps, "/tmp/p/applications.tsv", ctx, deps);

  assert.equal(deps._writes.copied, false);
  // …but still writes the deduped rows.
  assert.equal(deps._writes.saved.length, 1);
});

test("prepare --phase pre: auto-dedups before filtering (BL-13 end-to-end)", async () => {
  // TSV contains a legacy-prefix collision plus one fresh Inbox row. After
  // BL-13 the duplicate group collapses to one row, then the fresh row goes
  // through URL-check + ends up in the batch as expected. Without BL-13 the
  // batch would carry two rows (one of them stale).
  const apps = [
    makeApp({
      key: "lever:abc",
      source: "lever",
      jobId: "abc",
      companyName: "Stripe",
      url: "https://jobs.lever.co/stripe/abc",
      status: "Inbox",
      notion_page_id: "",
    }),
    makeApp({
      key: "lever:lever:abc",
      source: "lever",
      jobId: "lever:abc",
      companyName: "Stripe",
      url: "https://jobs.lever.co/stripe/abc",
      status: "Inbox",
      notion_page_id: "",
    }),
    makeApp({
      key: "gh:42",
      source: "greenhouse",
      jobId: "42",
      companyName: "Stripe",
      url: "https://boards.greenhouse.io/stripe/jobs/42",
      status: "Inbox",
      notion_page_id: "",
    }),
  ];
  const savedRows = [];
  const deps = makePrepDeps(apps, {
    saveApplications: (_p, rows) => savedRows.push(rows),
    fileExists: () => true,
    copyFileSync: () => {},
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx();
  await cmd(ctx);

  // 1. saveApplications was called once (the dedup write) — runPre itself
  //    doesn't write TSV in pre phase.
  assert.equal(savedRows.length, 1);
  // After collapse: 2 rows remain (one canonical lever + one greenhouse).
  assert.equal(savedRows[0].length, 2);

  // 2. Stdout carries the explicit found+fixed message.
  const line = ctx._lines.join("\n");
  assert.match(line, /found 1 duplicate group\(s\) in TSV/);
  assert.match(line, /auto-collapsed/);

  // 3. Batch carries 2 unique entries (canonical lever + greenhouse).
  const result = JSON.parse(deps._written["/fake/profiles/testuser/prepare_context.json"]);
  assert.equal(result.batch.length, 2);
  const keys = result.batch.map((b) => b.key).sort();
  assert.deepEqual(keys, ["gh:42", "lever:abc"]);
});

test("prepare --phase pre --dry-run: detects duplicates but does NOT write TSV (BL-13)", async () => {
  const apps = [
    makeApp({
      key: "lever:abc",
      source: "lever",
      jobId: "abc",
      companyName: "Stripe",
      url: "https://jobs.lever.co/stripe/abc",
      status: "Inbox",
    }),
    makeApp({
      key: "lever:lever:abc",
      source: "lever",
      jobId: "lever:abc",
      companyName: "Stripe",
      url: "https://jobs.lever.co/stripe/abc",
      status: "Inbox",
    }),
  ];
  const savedRows = [];
  const deps = makePrepDeps(apps, {
    saveApplications: (_p, rows) => savedRows.push(rows),
    fileExists: () => true,
    copyFileSync: () => {},
  });
  const cmd = makePrepareCommand(deps);
  const ctx = makeCtx({ flags: { dryRun: true, phase: "pre", batch: 30 } });
  await cmd(ctx);

  // Read-only: no TSV write, no prepare_context write.
  assert.equal(savedRows.length, 0);
  const line = ctx._lines.join("\n");
  assert.match(line, /would auto-collapse 1 duplicate group/);
  assert.match(line, /dry-run/);
});
