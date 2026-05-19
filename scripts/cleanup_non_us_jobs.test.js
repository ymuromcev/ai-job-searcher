const test = require("node:test");
const assert = require("node:assert");

const {
  plan,
  applyPlanToTsv,
  pushNotionUpdates,
  SKIP_REASON,
  NEW_STATUS,
} = require("./cleanup_non_us_jobs.js");

const RULES = {
  location_blocklist: ["poland", "germany", "united kingdom", "spain"],
};

function row(overrides) {
  // Helper accepts either `location: "..."` (legacy) or `locations: [...]`
  // (v5, RFC 038). We normalize to `locations: string[]` so the script,
  // which only reads `app.locations`, sees the right shape.
  const { location, locations, ...rest } = overrides || {};
  let normLocations;
  if (Array.isArray(locations)) normLocations = locations;
  else if (typeof location === "string" && location.length > 0) normLocations = [location];
  else if (location === "") normLocations = [];
  else normLocations = [];
  return {
    key: "gh:1",
    source: "gh",
    jobId: "1",
    companyName: "Acme",
    title: "PM",
    url: "https://example.com",
    locations: normLocations,
    status: "To Apply",
    notion_page_id: "",
    resume_ver: "",
    cl_key: "",
    salary_min: "",
    salary_max: "",
    cl_path: "",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    fit_score: "",
    fit_rationale: "",
    fit_evaluated_at: "",
    skip_reason: "",
    ...rest,
  };
}

test("plan: flags non-US row with blocklist hit", () => {
  const apps = [row({ key: "gh:1", location: "Warsaw, Poland", notion_page_id: "page-1" })];
  const { candidates, counts } = plan(apps, RULES);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].key, "gh:1");
  assert.equal(candidates[0].match, "poland");
  assert.equal(candidates[0].notion_page_id, "page-1");
  assert.equal(counts.candidates, 1);
});

test("plan: US-marker (state code) wins — keeps row even if blocklist substring present", () => {
  // "Sacramento, CA" should pass via BL-24 US state-code rule
  const apps = [row({ location: "Sacramento, CA" })];
  const { candidates, counts } = plan(apps, RULES);
  assert.equal(candidates.length, 0);
  assert.equal(counts.not_a_match, 1);
});

test("plan: US-marker phrase wins (united states)", () => {
  const apps = [row({ location: "Remote, United States" })];
  const { candidates } = plan(apps, RULES);
  assert.equal(candidates.length, 0);
});

test("plan: skips protected statuses (Applied / Interview / Offer / Rejected / Archived)", () => {
  const apps = [
    row({ key: "gh:a", location: "Berlin, Germany", status: "Applied" }),
    row({ key: "gh:b", location: "Berlin, Germany", status: "Interview" }),
    row({ key: "gh:c", location: "Berlin, Germany", status: "Offer" }),
    row({ key: "gh:d", location: "Berlin, Germany", status: "Rejected" }),
    row({ key: "gh:e", location: "Berlin, Germany", status: "Archived" }),
  ];
  const { candidates, counts } = plan(apps, RULES);
  assert.equal(candidates.length, 0);
  assert.equal(counts.skipped_protected_status, 5);
});

test("plan: idempotent — skips rows already marked with our skip_reason", () => {
  const apps = [
    row({
      location: "Berlin, Germany",
      status: "Archived",
      skip_reason: SKIP_REASON,
    }),
  ];
  const { candidates, counts } = plan(apps, RULES);
  assert.equal(candidates.length, 0);
  assert.equal(counts.skipped_already_marked, 1);
});

test("plan: skips rows with empty location", () => {
  const apps = [row({ location: "" })];
  const { candidates, counts } = plan(apps, RULES);
  assert.equal(candidates.length, 0);
  assert.equal(counts.skipped_no_location, 1);
});

test("plan: counts breakdown sums to total", () => {
  const apps = [
    row({ key: "1", location: "Warsaw, Poland" }), // candidate
    row({ key: "2", location: "Berlin, Germany", status: "Applied" }), // protected
    row({ key: "3", location: "" }), // no location
    row({ key: "4", location: "Sacramento, CA" }), // not a match
    row({ key: "5", location: "Berlin, Germany", skip_reason: SKIP_REASON }), // already marked
  ];
  const { counts } = plan(apps, RULES);
  assert.equal(
    counts.candidates +
      counts.skipped_protected_status +
      counts.skipped_no_location +
      counts.not_a_match +
      counts.skipped_already_marked,
    counts.total
  );
});

test("applyPlanToTsv: updates only candidate keys, leaves others alone", () => {
  const apps = [
    row({ key: "1", status: "To Apply", location: "Warsaw, Poland" }),
    row({ key: "2", status: "To Apply", location: "Sacramento, CA" }),
  ];
  const next = applyPlanToTsv(apps, ["1"], "2026-05-18T01:00:00Z");
  assert.equal(next[0].status, NEW_STATUS);
  assert.equal(next[0].skip_reason, SKIP_REASON);
  assert.equal(next[0].updatedAt, "2026-05-18T01:00:00Z");
  // Unchanged
  assert.equal(next[1].status, "To Apply");
  assert.equal(next[1].skip_reason, "");
});

test("pushNotionUpdates: skips rows without notion_page_id (TSV-only), calls API for the rest", async () => {
  const calls = [];
  const fakeClient = {
    pages: {
      update: async (args) => {
        calls.push(args);
        return { id: args.page_id };
      },
    },
  };
  const candidates = [
    { key: "1", notion_page_id: "page-a" },
    { key: "2", notion_page_id: "" }, // TSV-only
    { key: "3", notion_page_id: "page-c" },
  ];
  const { ok, failed } = await pushNotionUpdates(fakeClient, candidates);
  assert.equal(ok.length, 3);
  assert.equal(failed.length, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].page_id, "page-a");
  assert.equal(calls[1].page_id, "page-c");
});

test("pushNotionUpdates: collects failures without aborting the batch", async () => {
  const fakeClient = {
    pages: {
      update: async (args) => {
        if (args.page_id === "page-bad") throw new Error("validation_error: status option missing");
        return { id: args.page_id };
      },
    },
  };
  const candidates = [
    { key: "1", notion_page_id: "page-a" },
    { key: "2", notion_page_id: "page-bad" },
    { key: "3", notion_page_id: "page-c" },
  ];
  const { ok, failed } = await pushNotionUpdates(fakeClient, candidates);
  assert.deepEqual(ok, ["1", "3"]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].key, "2");
  assert.match(failed[0].error, /validation_error/);
});

test("pushNotionUpdates: sends Archived as the new status with default property map", async () => {
  let captured = null;
  const fakeClient = {
    pages: {
      update: async (args) => {
        captured = args;
        return { id: args.page_id };
      },
    },
  };
  await pushNotionUpdates(fakeClient, [{ key: "1", notion_page_id: "page-x" }]);
  assert.equal(captured.page_id, "page-x");
  // Default property map writes to field "Status" with type "status"
  assert.ok(captured.properties.Status);
  assert.equal(captured.properties.Status.status.name, "Archived");
});
