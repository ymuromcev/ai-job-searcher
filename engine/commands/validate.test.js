const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  makeValidateCommand,
  checkCompanyCap,
  pingAll,
} = require("./validate.js");

function captureOut() {
  const stdout = [];
  const stderr = [];
  return {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    lines: stdout,
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
    status: "To Apply",
    notion_page_id: "",
    resume_ver: "",
    cl_key: "",
    createdAt: "now",
    updatedAt: "now",
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  return {
    loadProfile: () => ({
      id: "jared",
      paths: { root: "/tmp/profiles/jared" },
      filterRules: { company_cap: { max_active: 2 } },
    }),
    loadApplications: () => ({ apps: [fakeApp({ jobId: "1" }), fakeApp({ jobId: "2" })] }),
    loadJobs: () => ({ jobs: [] }),
    fetchFn: async (_url, opts) => ({ ok: true, status: opts.method === "HEAD" ? 200 : 200 }),
    ...overrides,
  };
}

function makeCtx() {
  const out = captureOut();
  return {
    out,
    ctx: {
      command: "validate",
      profileId: "jared",
      flags: { dryRun: false, apply: false, verbose: false },
      env: {},
      stdout: out.stdout,
      stderr: out.stderr,
      profilesDir: "/tmp/profiles",
      dataDir: "/tmp/data",
    },
  };
}

test("validate exits 0 when everything is clean", async () => {
  const { ctx, out } = makeCtx();
  const code = await makeValidateCommand(makeDeps())(ctx);
  assert.equal(code, 0);
  assert.match(out.all(), /validation: ok/);
});

test("validate flags TSV parse errors", async () => {
  const { ctx, out } = makeCtx();
  const deps = makeDeps({
    loadApplications: () => {
      throw new Error("bad header");
    },
  });
  const code = await makeValidateCommand(deps)(ctx);
  assert.equal(code, 1);
  assert.match(out.all(), /applications\.tsv: PARSE ERROR/);
});

test("validate reports company_cap violations and exits 1", async () => {
  const apps = [
    fakeApp({ jobId: "1", companyName: "Stripe", status: "Applied" }),
    fakeApp({ jobId: "2", companyName: "Stripe", status: "To Apply" }),
    fakeApp({ jobId: "3", companyName: "Stripe", status: "Interview" }),
  ];
  const deps = makeDeps({
    loadApplications: () => ({ apps }),
    loadProfile: () => ({
      paths: { root: "/tmp/profiles/jared" },
      filterRules: { company_cap: { max_active: 2 } },
    }),
  });
  const { ctx, out } = makeCtx();
  const code = await makeValidateCommand(deps)(ctx);
  assert.equal(code, 1);
  assert.match(out.all(), /Stripe: 3 active > limit 2/);
});

test("validate skips dead applications when computing cap", async () => {
  const apps = [
    fakeApp({ jobId: "1", companyName: "Stripe", status: "Archived" }),
    fakeApp({ jobId: "2", companyName: "Stripe", status: "Rejected" }),
  ];
  const deps = makeDeps({ loadApplications: () => ({ apps }) });
  const { ctx, out } = makeCtx();
  const code = await makeValidateCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.match(out.all(), /company_cap: ok/);
});

test("validate reports dead URLs and exits 1", async () => {
  const apps = [
    fakeApp({ jobId: "1", url: "https://alive/1" }),
    fakeApp({ jobId: "2", url: "https://dead/2" }),
  ];
  const deps = makeDeps({
    loadApplications: () => ({ apps }),
    fetchFn: async (url) => {
      if (url.includes("dead")) return { ok: false, status: 404 };
      return { ok: true, status: 200 };
    },
  });
  const { ctx, out } = makeCtx();
  const code = await makeValidateCommand(deps)(ctx);
  assert.equal(code, 1);
  assert.match(out.all(), /url_liveness: 1 dead/);
  assert.match(out.all(), /404 https:\/\/dead\/2/);
});

test("validate skips URL pings under --dry-run", async () => {
  const apps = [fakeApp({ url: "https://x/1" })];
  let pinged = 0;
  const deps = makeDeps({
    loadApplications: () => ({ apps }),
    fetchFn: async () => {
      pinged += 1;
      return { ok: true, status: 200 };
    },
  });
  const { ctx, out } = makeCtx();
  ctx.flags.dryRun = true;
  await makeValidateCommand(deps)(ctx);
  assert.equal(pinged, 0);
  assert.match(out.all(), /would HEAD-ping 1 URLs/);
});

test("checkCompanyCap honours per-company overrides", () => {
  const apps = [
    { companyName: "Stripe", status: "Applied" },
    { companyName: "Stripe", status: "Applied" },
    { companyName: "Stripe", status: "Applied" },
  ];
  const result = checkCompanyCap(apps, {
    company_cap: { max_active: 1, overrides: { Stripe: 5 } },
  });
  assert.equal(result.violations.length, 0);
});

test("validate caps URL liveness at ctx.urlCap with a heads-up message", async () => {
  const apps = Array.from({ length: 5 }, (_, i) =>
    fakeApp({ jobId: String(i + 1), url: `https://x/${i + 1}` })
  );
  let pinged = 0;
  const deps = makeDeps({
    loadApplications: () => ({ apps }),
    fetchFn: async () => {
      pinged += 1;
      return { ok: true, status: 200 };
    },
  });
  const { ctx, out } = makeCtx();
  ctx.urlCap = 2;
  await makeValidateCommand(deps)(ctx);
  assert.equal(pinged, 2);
  assert.match(out.all(), /first 2 of 5 URLs \(cap 2\)/);
});

test("pingUrl treats 405 as indeterminate (never falls back to GET)", async () => {
  const methods = [];
  const fetchFn = async (_url, opts) => {
    methods.push(opts.method);
    return { ok: false, status: 405 };
  };
  const results = await pingAll(fetchFn, ["https://example.com/1"]);
  // Only HEAD was issued — no GET fallback, avoiding mutating endpoints.
  assert.deepEqual(methods, ["HEAD"]);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].indeterminate, true);
  assert.equal(results[0].status, 405);
});

test("pingUrl passes redirect: 'manual' and timeoutMs to fetchFn", async () => {
  let seen;
  const fetchFn = async (_url, opts) => {
    seen = opts;
    return { ok: true, status: 200 };
  };
  await pingAll(fetchFn, ["https://example.com/1"], { timeoutMs: 1234 });
  assert.equal(seen.redirect, "manual");
  assert.equal(seen.timeoutMs, 1234);
});

test("pingUrl blocks SSRF to loopback / private IPs / non-http schemes", async () => {
  const { pingUrl, isSafeLivenessUrl } = require("./validate.js");
  let called = 0;
  const fetchFn = async () => {
    called += 1;
    return { ok: true, status: 200 };
  };
  const blocked = [
    "http://127.0.0.1/admin",
    "http://localhost:3000",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://172.20.0.5/",
    "http://169.254.169.254/latest/meta-data/", // AWS IMDS
    "http://[::1]/",
    "http://[fe80::1]/",
    "file:///etc/passwd",
    "ftp://example.com/",
  ];
  for (const url of blocked) {
    const result = await pingUrl(fetchFn, url);
    assert.equal(result.ok, false, `should block ${url}`);
    assert.equal(result.blocked, true);
    const safety = isSafeLivenessUrl(url);
    assert.equal(safety.ok, false, `isSafeLivenessUrl should reject ${url}`);
  }
  assert.equal(called, 0, "no fetch should be made for blocked URLs");
});

test("pingUrl allows public http(s) URLs", async () => {
  let called = 0;
  const fetchFn = async () => {
    called += 1;
    return { ok: true, status: 200 };
  };
  const result = await pingAll(fetchFn, [
    "https://boards.greenhouse.io/affirm/jobs/1",
    "http://jobs.lever.co/stripe/abc",
  ]);
  assert.equal(result.length, 2);
  assert.ok(result.every((r) => r.ok));
  assert.equal(called, 2);
});

test("validate reports SSRF-blocked URLs in applications.tsv", async () => {
  const apps = [
    fakeApp({ jobId: "1", url: "https://good/1" }),
    fakeApp({ jobId: "2", url: "http://127.0.0.1:11434/api/delete" }),
  ];
  let hitGood = 0;
  const deps = makeDeps({
    loadApplications: () => ({ apps }),
    fetchFn: async (url) => {
      if (url.includes("127.0.0.1")) throw new Error("fetchFn should not be called for blocked URL");
      hitGood += 1;
      return { ok: true, status: 200 };
    },
  });
  const { ctx, out } = makeCtx();
  const code = await makeValidateCommand(deps)(ctx);
  assert.equal(code, 1);
  assert.equal(hitGood, 1);
  assert.match(out.all(), /blocked by SSRF guard/);
  assert.match(out.all(), /BLOCKED http:\/\/127\.0\.0\.1/);
});

test("pingAll honours concurrency option", async () => {
  let active = 0;
  let peak = 0;
  const fetchFn = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return { ok: true, status: 200 };
  };
  const urls = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`);
  await pingAll(fetchFn, urls, { concurrency: 3 });
  assert.ok(peak <= 3, `peak concurrency ${peak} should be ≤ 3`);
});

test("retro_sweep: no-op when filter_rules has no blocklists", async () => {
  // No company_blocklist or title_blocklist → sweep is skipped entirely.
  const apps = [fakeApp({ status: "To Apply", companyName: "Stripe", title: "PM" })];
  const deps = makeDeps({
    loadApplications: () => ({ apps }),
    loadProfile: () => ({
      paths: { root: "/tmp/profiles/jared" },
      filterRules: {},
    }),
  });
  const { ctx, out } = makeCtx();
  const code = await makeValidateCommand(deps)(ctx);
  assert.equal(code, 0);
  assert.doesNotMatch(out.all(), /retro_sweep:/);
});

test("retro_sweep: reports matches without --apply and exits 1", async () => {
  const apps = [
    fakeApp({ key: "greenhouse:1", jobId: "1", status: "To Apply", companyName: "Toast", title: "Senior PM" }),
    fakeApp({ key: "greenhouse:2", jobId: "2", status: "To Apply", companyName: "Stripe", title: "Associate PM" }),
    fakeApp({ key: "greenhouse:3", jobId: "3", status: "Applied", companyName: "Toast", title: "Senior PM" }), // not swept
    fakeApp({ key: "greenhouse:4", jobId: "4", status: "To Apply", companyName: "Stripe", title: "Senior PM" }), // passes
  ];
  let saved = null;
  const deps = makeDeps({
    loadApplications: () => ({ apps }),
    saveApplications: (_path, rows) => { saved = rows; },
    loadProfile: () => ({
      paths: { root: "/tmp/profiles/jared" },
      filterRules: {
        company_blocklist: ["toast"],
        title_blocklist: [{ pattern: "Associate", reason: "too junior" }],
      },
    }),
    fetchFn: async () => ({ ok: true, status: 200 }),
  });
  const { ctx, out } = makeCtx();
  const code = await makeValidateCommand(deps)(ctx);
  assert.equal(code, 1);
  assert.equal(saved, null, "must not write TSV without --apply");
  assert.match(out.all(), /retro_sweep: 2 row\(s\) now match blocklists/);
  assert.match(out.all(), /MATCH Toast — Senior PM \(company_blocklist:/);
  assert.match(out.all(), /MATCH Stripe — Associate PM \(title_blocklist:/);
});

test("retro_sweep: archives matches and writes TSV when --apply is set", async () => {
  const apps = [
    fakeApp({ key: "greenhouse:1", jobId: "1", status: "To Apply", companyName: "Toast", title: "PM", updatedAt: "old" }),
    fakeApp({ key: "greenhouse:2", jobId: "2", status: "To Apply", companyName: "Stripe", title: "PM", updatedAt: "old" }),
  ];
  let savedPath, savedRows;
  const deps = makeDeps({
    loadApplications: () => ({ apps }),
    saveApplications: (p, rows) => { savedPath = p; savedRows = rows; },
    loadProfile: () => ({
      paths: { root: "/tmp/profiles/jared" },
      filterRules: { company_blocklist: ["Toast"] },
    }),
    fetchFn: async () => ({ ok: true, status: 200 }),
    now: () => "2026-04-21T00:00:00Z",
  });
  const { ctx, out } = makeCtx();
  ctx.flags.apply = true;
  const code = await makeValidateCommand(deps)(ctx);
  assert.equal(code, 0, "archiving is not itself an issue — exit 0 when --apply succeeds");
  assert.ok(savedPath.endsWith("applications.tsv"));
  assert.equal(savedRows.length, 2);
  const toast = savedRows.find((r) => r.companyName === "Toast");
  const stripe = savedRows.find((r) => r.companyName === "Stripe");
  assert.equal(toast.status, "Archived");
  assert.equal(toast.updatedAt, "2026-04-21T00:00:00Z");
  assert.equal(stripe.status, "To Apply", "non-matching rows are untouched");
  assert.equal(stripe.updatedAt, "old");
  assert.match(out.all(), /retro_sweep: archived 1 row/);
});

test("retro_sweep: only sweeps 'To Apply', not Applied/Interview/Offer", async () => {
  const apps = [
    fakeApp({ key: "greenhouse:1", jobId: "1", status: "Applied", companyName: "Toast", title: "PM" }),
    fakeApp({ key: "greenhouse:2", jobId: "2", status: "Interview", companyName: "Toast", title: "PM" }),
    fakeApp({ key: "greenhouse:3", jobId: "3", status: "Offer", companyName: "Toast", title: "PM" }),
    fakeApp({ key: "greenhouse:4", jobId: "4", status: "To Apply", companyName: "Toast", title: "PM" }),
  ];
  const deps = makeDeps({
    loadApplications: () => ({ apps }),
    loadProfile: () => ({
      paths: { root: "/tmp/profiles/jared" },
      filterRules: { company_blocklist: ["Toast"] },
    }),
    fetchFn: async () => ({ ok: true, status: 200 }),
  });
  const { ctx, out } = makeCtx();
  const code = await makeValidateCommand(deps)(ctx);
  // Applied-row company_cap violation (3 Toast Applied+Interview+Offer under
  // the default cap of 2) will also fire but what we care about here:
  // retro_sweep only flags 1 row (the "To Apply" one), not the 3 already advanced.
  assert.match(out.all(), /retro_sweep: 1 row\(s\) now match blocklists/);
  assert.equal(code, 1);
});

test("validate cap warning goes to stderr", async () => {
  const apps = Array.from({ length: 5 }, (_, i) =>
    fakeApp({ jobId: String(i + 1), url: `https://example.com/${i + 1}` })
  );
  const deps = makeDeps({
    loadApplications: () => ({ apps }),
    fetchFn: async () => ({ ok: true, status: 200 }),
  });
  const { ctx } = makeCtx();
  ctx.urlCap = 2;
  const stderrLines = [];
  ctx.stderr = (s) => stderrLines.push(s);
  await makeValidateCommand(deps)(ctx);
  assert.ok(
    stderrLines.some((l) => /first 2 of 5 URLs \(cap 2\)/.test(l)),
    "cap warning must be on stderr"
  );
});
