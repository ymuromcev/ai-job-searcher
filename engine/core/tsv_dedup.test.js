const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  planDedup,
  canonicalKey,
  pickWinner,
  mergeLosersInto,
  rowsAreSuspicious,
} = require("./tsv_dedup.js");

function row(overrides = {}) {
  return {
    key: "lever:abc",
    source: "lever",
    jobId: "abc",
    companyName: "Affirm",
    title: "PM",
    url: "https://example.com/jobs/abc",
    locations: [],
    status: "Inbox",
    notion_page_id: "",
    resume_ver: "",
    cl_key: "",
    salary_min: "",
    salary_max: "",
    cl_path: "",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    fit_score: "",
    fit_rationale: "",
    fit_evaluated_at: "",
    skip_reason: "",
    ...overrides,
  };
}

test("canonicalKey strips double ATS prefix", () => {
  assert.equal(canonicalKey({ source: "lever", jobId: "abc" }), "lever:abc");
  assert.equal(canonicalKey({ source: "lever", jobId: "lever:abc" }), "lever:abc");
  assert.equal(canonicalKey({ source: "gh", jobId: "gh:7769924" }), "gh:7769924");
  assert.equal(canonicalKey({ source: "lever", jobId: "" }), null);
});

test("planDedup: no duplicates → kept untouched, dropped empty", () => {
  const apps = [
    row({ key: "lever:a", jobId: "a" }),
    row({ key: "lever:b", jobId: "b" }),
    row({ key: "gh:c", source: "greenhouse", jobId: "c" }),
  ];
  const plan = planDedup(apps);
  assert.equal(plan.pairs, 0);
  assert.equal(plan.kept.length, 3);
  assert.equal(plan.dropped.length, 0);
});

test("planDedup: legacy-prefix collision lever:abc ↔ lever:lever:abc collapses", () => {
  const legacy = row({
    key: "lever:abc",
    jobId: "abc",
    status: "Applied",
    notion_page_id: "page-1",
    updatedAt: "2026-04-15T00:00:00.000Z",
  });
  const doubled = row({
    key: "lever:lever:abc",
    jobId: "lever:abc",
    status: "Inbox",
    updatedAt: "2026-04-22T00:00:00.000Z",
  });
  const plan = planDedup([legacy, doubled]);
  assert.equal(plan.pairs, 1);
  assert.equal(plan.kept.length, 1);
  assert.equal(plan.dropped.length, 1);
  assert.equal(plan.kept[0].key, "lever:abc");
  assert.equal(plan.kept[0].notion_page_id, "page-1");
  assert.match(Object.keys(plan.byReason)[0], /legacy-prefix collision/);
});

test("planDedup: winner = row with notion_page_id even if other is newer", () => {
  const withPid = row({
    key: "lever:abc",
    jobId: "abc",
    status: "Applied",
    notion_page_id: "page-1",
    updatedAt: "2026-04-01T00:00:00.000Z",
  });
  const noPid = row({
    key: "lever:lever:abc",
    jobId: "lever:abc",
    status: "Inbox",
    notion_page_id: "",
    updatedAt: "2026-04-30T00:00:00.000Z",
  });
  const plan = planDedup([withPid, noPid]);
  assert.equal(plan.kept[0].notion_page_id, "page-1");
});

test("planDedup: status priority Offer > Interview > Applied > To Apply > Inbox", () => {
  const inbox = row({ key: "lever:lever:abc", jobId: "lever:abc", status: "Inbox" });
  const interview = row({ key: "lever:abc", jobId: "abc", status: "Interview" });
  const plan = planDedup([inbox, interview]);
  assert.equal(plan.kept[0].status, "Interview");
});

test("planDedup: tie on status → newer updatedAt wins", () => {
  const older = row({
    key: "lever:lever:abc",
    jobId: "lever:abc",
    updatedAt: "2026-04-01T00:00:00.000Z",
  });
  const newer = row({
    key: "lever:abc",
    jobId: "abc",
    updatedAt: "2026-04-30T00:00:00.000Z",
  });
  const plan = planDedup([older, newer]);
  assert.equal(plan.kept[0].updatedAt, "2026-04-30T00:00:00.000Z");
});

test("planDedup: tie on status+time → shorter key wins (canonical form)", () => {
  const long = row({ key: "lever:lever:abc", jobId: "lever:abc" });
  const short = row({ key: "lever:abc", jobId: "abc" });
  const plan = planDedup([long, short]);
  assert.equal(plan.kept[0].key, "lever:abc");
});

test("planDedup: merges loser fit_score into winner when winner is empty", () => {
  const winner = row({
    key: "lever:abc",
    jobId: "abc",
    notion_page_id: "page-1",
    status: "Applied",
    fit_score: "",
    fit_rationale: "",
  });
  const loser = row({
    key: "lever:lever:abc",
    jobId: "lever:abc",
    status: "Inbox",
    fit_score: "Strong",
    fit_rationale: "great match",
    fit_evaluated_at: "2026-04-25T00:00:00.000Z",
  });
  const plan = planDedup([winner, loser]);
  const out = plan.kept[0];
  assert.equal(out.fit_score, "Strong");
  assert.equal(out.fit_rationale, "great match");
  assert.equal(out.fit_evaluated_at, "2026-04-25T00:00:00.000Z");
  assert.equal(out.notion_page_id, "page-1");
});

test("planDedup: does NOT overwrite winner's populated field", () => {
  const winner = row({
    key: "lever:abc",
    jobId: "abc",
    notion_page_id: "page-1",
    fit_score: "Medium",
  });
  const loser = row({
    key: "lever:lever:abc",
    jobId: "lever:abc",
    fit_score: "Strong",
  });
  const plan = planDedup([winner, loser]);
  assert.equal(plan.kept[0].fit_score, "Medium");
});

test("planDedup: triple collision (X ↔ source:X ↔ source:source:X) → single winner", () => {
  const a = row({ key: "lever:abc", jobId: "abc", status: "Inbox" });
  const b = row({ key: "lever:lever:abc", jobId: "lever:abc", status: "To Apply" });
  const c = row({ key: "lever:lever:lever:abc", jobId: "lever:lever:abc", status: "Applied" });
  const plan = planDedup([a, b, c]);
  assert.equal(plan.pairs, 1);
  assert.equal(plan.kept.length, 1);
  assert.equal(plan.dropped.length, 2);
  assert.equal(plan.kept[0].status, "Applied");
});

test("planDedup: suspicious group (different company) is NOT collapsed", () => {
  const a = row({
    key: "lever:abc",
    jobId: "abc",
    companyName: "Affirm",
  });
  const b = row({
    key: "lever:lever:abc",
    jobId: "lever:abc",
    companyName: "Stripe",
  });
  const plan = planDedup([a, b]);
  assert.equal(plan.pairs, 0);
  assert.equal(plan.suspicious.length, 1);
  assert.equal(plan.kept.length, 2); // both stay
  assert.equal(plan.dropped.length, 0);
});

test("planDedup: suspicious group (different url path) is NOT collapsed", () => {
  const a = row({
    key: "lever:abc",
    jobId: "abc",
    url: "https://example.com/jobs/abc",
  });
  const b = row({
    key: "lever:lever:abc",
    jobId: "lever:abc",
    url: "https://example.com/jobs/something-else",
  });
  const plan = planDedup([a, b]);
  assert.equal(plan.suspicious.length, 1);
  assert.equal(plan.kept.length, 2);
});

test("planDedup: same url with different query strings is NOT suspicious", () => {
  const a = row({
    key: "lever:abc",
    jobId: "abc",
    url: "https://example.com/jobs/abc?utm=x",
  });
  const b = row({
    key: "lever:lever:abc",
    jobId: "lever:abc",
    url: "https://example.com/jobs/abc?utm=y",
  });
  const plan = planDedup([a, b]);
  assert.equal(plan.pairs, 1);
  assert.equal(plan.suspicious.length, 0);
});

test("planDedup: empty url + populated url is NOT suspicious", () => {
  const a = row({
    key: "lever:abc",
    jobId: "abc",
    url: "",
  });
  const b = row({
    key: "lever:lever:abc",
    jobId: "lever:abc",
    url: "https://example.com/jobs/abc",
  });
  const plan = planDedup([a, b]);
  assert.equal(plan.pairs, 1);
});

test("planDedup: preserves input row ordering for kept rows", () => {
  const a = row({ key: "lever:a", jobId: "a" });
  const b = row({ key: "lever:b", jobId: "b" });
  const c = row({ key: "lever:c", jobId: "c" });
  const dDup = row({ key: "lever:lever:b", jobId: "lever:b" });
  const plan = planDedup([a, b, c, dDup]);
  assert.deepEqual(
    plan.kept.map((r) => r.jobId),
    ["a", "b", "c"]
  );
});

test("planDedup: rows with no source/jobId pass through untouched", () => {
  const garbage = { key: "", source: "", jobId: "", status: "Inbox" };
  const valid = row({ key: "lever:a", jobId: "a" });
  const plan = planDedup([garbage, valid]);
  assert.equal(plan.kept.length, 2);
  assert.equal(plan.dropped.length, 0);
});

test("planDedup: byReason categorizes by source", () => {
  const apps = [
    row({ key: "lever:a", jobId: "a" }),
    row({ key: "lever:lever:a", jobId: "lever:a" }),
    row({ key: "gh:b", source: "greenhouse", jobId: "b" }),
    row({ key: "greenhouse:gh:b", source: "greenhouse", jobId: "gh:b" }),
  ];
  const plan = planDedup(apps);
  assert.equal(plan.pairs, 2);
  assert.ok(Object.keys(plan.byReason).some((k) => k.includes("lever:X")));
  assert.ok(Object.keys(plan.byReason).some((k) => k.includes("greenhouse:X")));
});

test("planDedup throws on non-array input", () => {
  assert.throws(() => planDedup(null), /must be an array/);
  assert.throws(() => planDedup({}), /must be an array/);
});

test("rowsAreSuspicious: single row never suspicious", () => {
  assert.equal(rowsAreSuspicious([row()]), false);
});

test("pickWinner: stable for identical rows (returns first)", () => {
  const a = row({ key: "lever:a", jobId: "a" });
  const b = row({ key: "lever:a", jobId: "a" });
  assert.strictEqual(pickWinner([a, b]), a);
});

test("mergeLosersInto: lifts locations/cl_path from losers", () => {
  const winner = row({
    key: "lever:abc",
    notion_page_id: "page-1",
    locations: [],
    cl_path: "",
  });
  const loser = row({
    key: "lever:lever:abc",
    locations: ["Remote", "United States"],
    cl_path: "/cl/foo.pdf",
  });
  const merged = mergeLosersInto(winner, [loser]);
  assert.deepEqual(merged.locations, ["Remote", "United States"]);
  assert.equal(merged.cl_path, "/cl/foo.pdf");
  assert.equal(merged.notion_page_id, "page-1");
});
