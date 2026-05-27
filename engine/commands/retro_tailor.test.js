const { test } = require("node:test");
const assert = require("node:assert/strict");

const retroTailor = require("./retro_tailor.js");
const { makeRetroTailorCommand, isRetroTailorCandidate } = retroTailor;

// --- Helpers ----------------------------------------------------------------

function makeApp(overrides = {}) {
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
    notion_page_id: overrides.notion_page_id || "notion-page-default",
    resume_ver: overrides.resume_ver || "",
    cl_key: overrides.cl_key || "",
    cl_path: overrides.cl_path || "",
    createdAt: overrides.createdAt || "2026-04-20T00:00:00.000Z",
    updatedAt: overrides.updatedAt || "2026-04-20T00:00:00.000Z",
    fit_score: overrides.fit_score || "Strong",
    fit_rationale: overrides.fit_rationale || "great",
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
      apply: false,
      batch: 30,
      since: "",
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

function makeDeps(apps, overrides = {}) {
  const profileBase = overrides.profile || {
    id: "testuser",
    notion: {
      jobs_pipeline_db_id: "test-jobs-db",
    },
    paths: {
      root: "/fake/profiles/testuser",
      applicationsTsv: "/fake/profiles/testuser/applications.tsv",
      jdCacheDir: "/fake/profiles/testuser/jd_cache",
    },
  };
  let savedApps = null;
  const writes = {};
  return {
    loadProfile: () => profileBase,
    loadSecrets: () => ({ NOTION_TOKEN: "secret_test" }),
    loadApplications: () => ({ apps }),
    saveApplications: (_, updated) => {
      savedApps = updated;
    },
    fetchJds: async (inputs) =>
      inputs.map((i) => ({ key: i.key, text: `JD body for ${i.key}`, status: "ok" })),
    fetchFn: async () => ({ ok: true, status: 200 }),
    readFile: overrides.readFile || (() => ""),
    writeFile: (p, data) => {
      writes[p] = data;
    },
    mkdirp: () => {},
    slugifyCompany: (s) => String(s || "").replace(/\s+/g, "-"),
    slugifyRole: (s) => String(s || "").toLowerCase().replace(/\s+/g, "-"),
    generateResumeDocx: async () => {},
    generateResumePdf: async () => ({ pageCount: 1 }),
    makeNotionClient: () => ({}),
    updateJobPage: async () => ({}),
    now: () => "2026-05-26T13:00:00.000Z",
    _getSaved: () => savedApps,
    _getWrites: () => writes,
    ...overrides,
  };
}

// --- isRetroTailorCandidate -------------------------------------------------

test("isRetroTailorCandidate: To Apply + Strong + non-tailored resume_ver = yes", () => {
  const a = makeApp({ status: "To Apply", fit_score: "Strong", resume_ver: "pm-builder" });
  assert.equal(isRetroTailorCandidate(a, ""), true);
});

test("isRetroTailorCandidate: empty resume_ver also qualifies", () => {
  const a = makeApp({ status: "To Apply", fit_score: "Strong", resume_ver: "" });
  assert.equal(isRetroTailorCandidate(a, ""), true);
});

test("isRetroTailorCandidate: already-tailored resume_ver is filtered out", () => {
  const a = makeApp({
    status: "To Apply",
    fit_score: "Strong",
    resume_ver: "resumes/tailored/Stripe_pm_20260524.pdf",
  });
  assert.equal(isRetroTailorCandidate(a, ""), false);
});

test("isRetroTailorCandidate: Medium fit_score filtered out", () => {
  const a = makeApp({ status: "To Apply", fit_score: "Medium" });
  assert.equal(isRetroTailorCandidate(a, ""), false);
});

test("isRetroTailorCandidate: Weak fit_score filtered out", () => {
  const a = makeApp({ status: "To Apply", fit_score: "Weak" });
  assert.equal(isRetroTailorCandidate(a, ""), false);
});

test("isRetroTailorCandidate: Inbox status filtered out", () => {
  const a = makeApp({ status: "Inbox", fit_score: "Strong" });
  assert.equal(isRetroTailorCandidate(a, ""), false);
});

test("isRetroTailorCandidate: Applied status filtered out", () => {
  const a = makeApp({ status: "Applied", fit_score: "Strong" });
  assert.equal(isRetroTailorCandidate(a, ""), false);
});

test("isRetroTailorCandidate: --since filters rows older than the date", () => {
  const a = makeApp({
    status: "To Apply",
    fit_score: "Strong",
    updatedAt: "2026-04-01T00:00:00.000Z",
  });
  assert.equal(isRetroTailorCandidate(a, "2026-05-01"), false);
});

test("isRetroTailorCandidate: --since allows rows newer than the date", () => {
  const a = makeApp({
    status: "To Apply",
    fit_score: "Strong",
    updatedAt: "2026-05-20T00:00:00.000Z",
  });
  assert.equal(isRetroTailorCandidate(a, "2026-05-01"), true);
});

// --- recon ------------------------------------------------------------------

test("recon: writes context with only retro candidates", async () => {
  const apps = [
    makeApp({
      key: "gh:1",
      companyName: "Stripe",
      status: "To Apply",
      fit_score: "Strong",
      resume_ver: "pm-builder",
    }),
    makeApp({
      key: "gh:2",
      companyName: "Brex",
      status: "To Apply",
      fit_score: "Strong",
      resume_ver: "resumes/tailored/Brex_pm_20260524.pdf",
    }),
    makeApp({
      key: "gh:3",
      companyName: "Ramp",
      status: "To Apply",
      fit_score: "Medium",
      resume_ver: "pm-v2",
    }),
  ];
  const deps = makeDeps(apps);
  const cmd = makeRetroTailorCommand(deps);
  const ctx = makeCtx();
  const code = await cmd(ctx);
  assert.equal(code, 0);

  const contextPath = "/fake/profiles/testuser/retro_tailor_context.json";
  const written = deps._getWrites()[contextPath];
  assert.ok(written, "retro_tailor_context.json must be written");
  const ctxJson = JSON.parse(written);
  assert.equal(ctxJson.mode, "retro");
  assert.equal(ctxJson.batch.length, 1);
  assert.equal(ctxJson.batch[0].key, "gh:1");
  assert.equal(ctxJson.batch[0].companyName, "Stripe");
  assert.ok(ctxJson.batch[0].jdText, "JD text must be included");
  assert.equal(ctxJson.stats.candidatesTotal, 1);
  assert.equal(ctxJson.stats.alreadyTailored, 1);
});

test("recon: --dry-run does not write the context file", async () => {
  const apps = [
    makeApp({
      key: "gh:1",
      status: "To Apply",
      fit_score: "Strong",
      resume_ver: "pm-builder",
    }),
  ];
  const deps = makeDeps(apps);
  const cmd = makeRetroTailorCommand(deps);
  const ctx = makeCtx({ flags: { dryRun: true } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  const contextPath = "/fake/profiles/testuser/retro_tailor_context.json";
  assert.equal(deps._getWrites()[contextPath], undefined);
  assert.ok(ctx._lines.some((l) => /\(dry-run\) would write/.test(l)));
});

test("recon: empty candidate set exits cleanly", async () => {
  const apps = [
    makeApp({
      key: "gh:1",
      status: "To Apply",
      fit_score: "Strong",
      resume_ver: "resumes/tailored/Stripe_pm_20260524.pdf",
    }),
  ];
  const deps = makeDeps(apps);
  const cmd = makeRetroTailorCommand(deps);
  const ctx = makeCtx();
  const code = await cmd(ctx);
  assert.equal(code, 0);
  assert.ok(ctx._lines.some((l) => /nothing to do/.test(l)));
  // Context file is not written when there are zero candidates — we exit
  // early before the write.
  const contextPath = "/fake/profiles/testuser/retro_tailor_context.json";
  assert.equal(deps._getWrites()[contextPath], undefined);
});

test("recon: --batch caps the candidate list", async () => {
  const apps = [];
  for (let i = 0; i < 10; i++) {
    apps.push(
      makeApp({
        key: `gh:${i}`,
        status: "To Apply",
        fit_score: "Strong",
        resume_ver: "pm-builder",
      })
    );
  }
  const deps = makeDeps(apps);
  const cmd = makeRetroTailorCommand(deps);
  const ctx = makeCtx({ flags: { batch: 3 } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  const contextPath = "/fake/profiles/testuser/retro_tailor_context.json";
  const ctxJson = JSON.parse(deps._getWrites()[contextPath]);
  assert.equal(ctxJson.batch.length, 3);
  assert.equal(ctxJson.stats.deferred, 7);
  assert.ok(ctx._lines.some((l) => /deferred: 7/.test(l)));
});

test("recon: JD-fetch failure excludes the row from the context", async () => {
  const apps = [
    makeApp({
      key: "gh:1",
      status: "To Apply",
      fit_score: "Strong",
      resume_ver: "pm-builder",
    }),
    makeApp({
      key: "gh:2",
      status: "To Apply",
      fit_score: "Strong",
      resume_ver: "pm-builder",
    }),
  ];
  const deps = makeDeps(apps, {
    fetchJds: async (inputs) =>
      inputs.map((i, idx) =>
        idx === 0 ? { key: i.key, text: "", status: "error" } : { key: i.key, text: "JD", status: "ok" }
      ),
  });
  const cmd = makeRetroTailorCommand(deps);
  const ctx = makeCtx();
  const code = await cmd(ctx);
  assert.equal(code, 0);
  const contextPath = "/fake/profiles/testuser/retro_tailor_context.json";
  const ctxJson = JSON.parse(deps._getWrites()[contextPath]);
  assert.equal(ctxJson.batch.length, 1);
  assert.equal(ctxJson.batch[0].key, "gh:2");
  assert.equal(ctxJson.stats.jdFetchFailed, 1);
});

// --- commit -----------------------------------------------------------------

test("commit: tailored row generates DOCX+PDF, updates TSV + Notion", async () => {
  const apps = [
    makeApp({
      key: "gh:1",
      status: "To Apply",
      fit_score: "Strong",
      resume_ver: "pm-builder",
      cl_path: "cover_letters/Stripe/cl1.pdf",
      cl_key: "cl1",
      notion_page_id: "notion-abc",
    }),
  ];
  const tailored = {
    contact: { name: "T", phone: "1", email: "a@b.c", location: "SF" },
    version: { summary: "tailored summary" },
  };
  const results = {
    profileId: "testuser",
    results: [
      {
        key: "gh:1",
        tailoredResume: tailored,
        tailorCoverage: 92,
        tailorEscalated: false,
      },
    ],
  };
  let docxCalled = null;
  let pdfCalled = null;
  const notionCalls = [];
  const deps = makeDeps(apps, {
    readFile: () => JSON.stringify(results),
    generateResumeDocx: async (data, outPath) => {
      docxCalled = { data, outPath };
    },
    generateResumePdf: async (data, outPath) => {
      pdfCalled = { data, outPath };
      return { pageCount: 1 };
    },
    updateJobPage: async (client, pageId, updates, propertyMap) => {
      notionCalls.push({ pageId, updates, propertyMap });
      return {};
    },
  });
  const cmd = makeRetroTailorCommand(deps);
  const ctx = makeCtx({
    flags: { apply: true, resultsFile: "/r.json" },
  });
  const code = await cmd(ctx);
  assert.equal(code, 0);

  // DOCX + PDF were generated.
  assert.ok(docxCalled, "DOCX must be generated");
  assert.ok(pdfCalled, "PDF must be generated");
  assert.match(docxCalled.outPath, /resumes\/tailored\/Stripe_senior-product-manager_20260526\.docx$/);
  assert.match(pdfCalled.outPath, /resumes\/tailored\/Stripe_senior-product-manager_20260526\.pdf$/);

  // TSV was updated.
  const saved = deps._getSaved();
  assert.ok(saved, "saveApplications must be called");
  assert.equal(saved[0].resume_ver, "resumes/tailored/Stripe_senior-product-manager_20260526.pdf");
  assert.equal(saved[0].updatedAt, "2026-05-26T13:00:00.000Z");

  // CL fields are NOT touched.
  assert.equal(saved[0].cl_path, "cover_letters/Stripe/cl1.pdf");
  assert.equal(saved[0].cl_key, "cl1");

  // Notion was updated with the PDF path.
  assert.equal(notionCalls.length, 1);
  assert.equal(notionCalls[0].pageId, "notion-abc");
  assert.equal(
    notionCalls[0].updates.resumeVersion,
    "resumes/tailored/Stripe_senior-product-manager_20260526.pdf"
  );
});

test("commit: escalated row does not touch TSV or Notion, escalation MD written", async () => {
  const apps = [
    makeApp({
      key: "gh:1",
      status: "To Apply",
      fit_score: "Strong",
      resume_ver: "pm-builder",
      notion_page_id: "notion-abc",
    }),
  ];
  const results = {
    results: [
      {
        key: "gh:1",
        tailorEscalated: true,
        tailorEscalationReason: "no_growth_below_threshold",
        tailorCoverage: 72,
        tailorEscalationDetail: {
          iterations: [{ n: 1, coverage_pct: 72, missing: ["foo"] }],
          uncertain_facts: [],
          coverage_table: [],
        },
      },
    ],
  };
  const notionCalls = [];
  const deps = makeDeps(apps, {
    readFile: () => JSON.stringify(results),
    updateJobPage: async (...args) => {
      notionCalls.push(args);
    },
  });
  const cmd = makeRetroTailorCommand(deps);
  const ctx = makeCtx({ flags: { apply: true, resultsFile: "/r.json" } });
  const code = await cmd(ctx);
  assert.equal(code, 0);

  // TSV not saved (no mutations).
  assert.equal(deps._getSaved(), null);
  // Notion not called.
  assert.equal(notionCalls.length, 0);

  // Escalation MD written with retro- prefix.
  const writes = deps._getWrites();
  const escalationPaths = Object.keys(writes).filter((p) =>
    /retro-escalations-\d+\.md$/.test(p)
  );
  assert.equal(escalationPaths.length, 1);
});

test("commit: Notion failure leaves TSV resume_ver unchanged", async () => {
  const apps = [
    makeApp({
      key: "gh:1",
      status: "To Apply",
      fit_score: "Strong",
      resume_ver: "pm-builder",
      notion_page_id: "notion-abc",
    }),
  ];
  const results = {
    results: [
      {
        key: "gh:1",
        tailoredResume: { contact: {}, version: { summary: "x" } },
        tailorEscalated: false,
      },
    ],
  };
  const deps = makeDeps(apps, {
    readFile: () => JSON.stringify(results),
    updateJobPage: async () => {
      throw new Error("Notion 503");
    },
  });
  const cmd = makeRetroTailorCommand(deps);
  const ctx = makeCtx({ flags: { apply: true, resultsFile: "/r.json" } });
  const code = await cmd(ctx);
  assert.equal(code, 0);

  // TSV save happens because tailoredRows.length > 0, but the row's
  // resume_ver was NOT mutated (rollback semantics — mutation happens
  // only AFTER Notion succeeds).
  const saved = deps._getSaved();
  assert.ok(saved);
  assert.equal(saved[0].resume_ver, "pm-builder");
  assert.ok(ctx._errLines.some((l) => /Notion update failed.*Notion 503/.test(l)));
  assert.ok(ctx._lines.some((l) => /1 Notion failed/.test(l)));
});

test("commit: row status moved to Applied between recon and commit is skipped", async () => {
  const apps = [
    makeApp({
      key: "gh:1",
      status: "Applied", // operator marked applied in Notion + ran sync
      fit_score: "Strong",
      resume_ver: "pm-builder",
      notion_page_id: "notion-abc",
    }),
  ];
  const results = {
    results: [
      {
        key: "gh:1",
        tailoredResume: { contact: {}, version: { summary: "x" } },
        tailorEscalated: false,
      },
    ],
  };
  const notionCalls = [];
  const deps = makeDeps(apps, {
    readFile: () => JSON.stringify(results),
    updateJobPage: async (...args) => {
      notionCalls.push(args);
    },
  });
  const cmd = makeRetroTailorCommand(deps);
  const ctx = makeCtx({ flags: { apply: true, resultsFile: "/r.json" } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  assert.equal(notionCalls.length, 0);
  assert.ok(ctx._errLines.some((l) => /status is "Applied".*Did you sync since recon/.test(l)));
});

test("commit: row without notion_page_id is skipped", async () => {
  const apps = [
    makeApp({
      key: "gh:1",
      status: "To Apply",
      fit_score: "Strong",
      resume_ver: "pm-builder",
      notion_page_id: "", // missing!
    }),
  ];
  const results = {
    results: [
      {
        key: "gh:1",
        tailoredResume: { contact: {}, version: { summary: "x" } },
        tailorEscalated: false,
      },
    ],
  };
  const notionCalls = [];
  const deps = makeDeps(apps, {
    readFile: () => JSON.stringify(results),
    updateJobPage: async (...args) => {
      notionCalls.push(args);
    },
  });
  const cmd = makeRetroTailorCommand(deps);
  const ctx = makeCtx({ flags: { apply: true, resultsFile: "/r.json" } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  assert.equal(notionCalls.length, 0);
  assert.ok(ctx._errLines.some((l) => /no notion_page_id/.test(l)));
});

test("commit: --apply --dry-run does not call DOCX, PDF, Notion, or save TSV", async () => {
  const apps = [
    makeApp({
      key: "gh:1",
      status: "To Apply",
      fit_score: "Strong",
      resume_ver: "pm-builder",
      notion_page_id: "notion-abc",
    }),
  ];
  const results = {
    results: [
      {
        key: "gh:1",
        tailoredResume: { contact: {}, version: { summary: "x" } },
        tailorEscalated: false,
      },
    ],
  };
  let docxCalled = false;
  const notionCalls = [];
  const deps = makeDeps(apps, {
    readFile: () => JSON.stringify(results),
    generateResumeDocx: async () => {
      docxCalled = true;
    },
    updateJobPage: async (...args) => {
      notionCalls.push(args);
    },
  });
  const cmd = makeRetroTailorCommand(deps);
  const ctx = makeCtx({ flags: { apply: true, resultsFile: "/r.json", dryRun: true } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  assert.equal(docxCalled, false);
  assert.equal(notionCalls.length, 0);
  assert.equal(deps._getSaved(), null);
  assert.ok(ctx._lines.some((l) => /\(dry-run\) would write tailored resume/.test(l)));
  assert.ok(ctx._lines.some((l) => /\(dry-run\) would update Notion page/.test(l)));
});

test("commit: results.json without --results-file errors out", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply", fit_score: "Strong" })];
  const deps = makeDeps(apps);
  const cmd = makeRetroTailorCommand(deps);
  const ctx = makeCtx({ flags: { apply: true, resultsFile: "" } });
  const code = await cmd(ctx);
  assert.equal(code, 1);
  assert.ok(ctx._errLines.some((l) => /--results-file <path> is required/.test(l)));
});

test("commit: missing NOTION_TOKEN warns and skips Notion (TSV not mutated)", async () => {
  const apps = [
    makeApp({
      key: "gh:1",
      status: "To Apply",
      fit_score: "Strong",
      resume_ver: "pm-builder",
      notion_page_id: "notion-abc",
    }),
  ];
  const results = {
    results: [
      {
        key: "gh:1",
        tailoredResume: { contact: {}, version: { summary: "x" } },
        tailorEscalated: false,
      },
    ],
  };
  const deps = makeDeps(apps, {
    readFile: () => JSON.stringify(results),
    loadSecrets: () => ({}), // no NOTION_TOKEN
  });
  const cmd = makeRetroTailorCommand(deps);
  const ctx = makeCtx({ flags: { apply: true, resultsFile: "/r.json" } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  // Files were generated on disk (we attempted), but TSV resume_ver stays
  // pm-builder — operator fixes .env and re-runs.
  const saved = deps._getSaved();
  assert.equal(saved[0].resume_ver, "pm-builder");
  assert.ok(ctx._errLines.some((l) => /TESTUSER_NOTION_TOKEN missing/.test(l)));
});

test("commit: row not in TSV is skipped with warn", async () => {
  const apps = [makeApp({ key: "gh:1", status: "To Apply", fit_score: "Strong" })];
  const results = {
    results: [
      {
        key: "gh:999",
        tailoredResume: { contact: {}, version: { summary: "x" } },
        tailorEscalated: false,
      },
    ],
  };
  const deps = makeDeps(apps, {
    readFile: () => JSON.stringify(results),
  });
  const cmd = makeRetroTailorCommand(deps);
  const ctx = makeCtx({ flags: { apply: true, resultsFile: "/r.json" } });
  const code = await cmd(ctx);
  assert.equal(code, 0);
  assert.ok(ctx._errLines.some((l) => /key not found in applications\.tsv: gh:999/.test(l)));
});
