const { test } = require("node:test");
const assert = require("node:assert/strict");

const { filterJobs, US_MARKERS } = require("./filter.js");

const BASE_JOB = {
  source: "greenhouse",
  jobId: "123",
  company: "Stripe",
  role: "Senior Product Manager",
  location: "San Francisco, CA",
  jobUrl: "https://example.com/job/123",
};

test("filterJobs passes a normal job", () => {
  const { passed, rejected } = filterJobs([BASE_JOB], {});
  assert.equal(passed.length, 1);
  assert.equal(rejected.length, 0);
});

test("filterJobs rejects by company_blocklist", () => {
  const { passed, rejected } = filterJobs(
    [BASE_JOB],
    { company_blocklist: ["Stripe"] }
  );
  assert.equal(passed.length, 0);
  assert.equal(rejected[0].reason.kind, "company_blocklist");
});

test("filterJobs company_blocklist is case-insensitive", () => {
  // Prototype parity (audit §6 gap 3): "Toast" in blocklist must catch "TOAST"
  // and "toast" in incoming job data.
  const upper = { ...BASE_JOB, company: "TOAST" };
  const lower = { ...BASE_JOB, company: "toast" };
  const { rejected: upperR } = filterJobs([upper], { company_blocklist: ["Toast"] });
  const { rejected: lowerR } = filterJobs([lower], { company_blocklist: ["Toast"] });
  assert.equal(upperR.length, 1);
  assert.equal(lowerR.length, 1);
  assert.equal(upperR[0].reason.kind, "company_blocklist");
  // Also the reverse: blocklist lowercased, job uppercased.
  const { rejected: rev } = filterJobs([upper], { company_blocklist: ["toast"] });
  assert.equal(rev.length, 1);
});

test("filterJobs rejects by title_blocklist substring", () => {
  const job = { ...BASE_JOB, role: "Associate Product Manager" };
  const { rejected } = filterJobs(
    [job],
    { title_blocklist: [{ pattern: "Associate", reason: "too junior" }] }
  );
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.kind, "title_blocklist");
  assert.equal(rejected[0].reason.why, "too junior");
});

test("filterJobs title_blocklist is case-insensitive", () => {
  const job = { ...BASE_JOB, role: "associate PM" };
  const { rejected } = filterJobs(
    [job],
    { title_blocklist: [{ pattern: "ASSOCIATE", reason: "junior" }] }
  );
  assert.equal(rejected.length, 1);
});

test("filterJobs title_blocklist treats metacharacters literally (no regex)", () => {
  // Prototype parity (audit §6 gap 2): patterns are substrings, not regex.
  // "Sr. Director" pattern must match literally — the `.` does NOT match any
  // character as it would in regex mode.
  const matches = { ...BASE_JOB, role: "Sr. Director of Product" };
  const { rejected: r1 } = filterJobs(
    [matches],
    { title_blocklist: [{ pattern: "Sr. Director", reason: "too senior" }] }
  );
  assert.equal(r1.length, 1);

  // A string that would match in regex mode (`.` as any char) must NOT match
  // in substring mode when the literal dot is absent.
  const noDot = { ...BASE_JOB, role: "SrXDirector of Product" };
  const { rejected: r2, passed: p2 } = filterJobs(
    [noDot],
    { title_blocklist: [{ pattern: "Sr. Director", reason: "too senior" }] }
  );
  assert.equal(r2.length, 0);
  assert.equal(p2.length, 1);

  // Parentheses in patterns must not throw (were regex syntax errors before).
  assert.doesNotThrow(() =>
    filterJobs(
      [BASE_JOB],
      { title_blocklist: [{ pattern: "Principal (Staff)", reason: "x" }] }
    )
  );
});

test("filterJobs rejects by location_blocklist substring", () => {
  const job = { ...BASE_JOB, location: "London, UK" };
  const { rejected } = filterJobs([job], { location_blocklist: ["UK"] });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.kind, "location_blocklist");
});

test("filterJobs skips location_blocklist when US marker present", () => {
  // Prototype parity (audit §6 gap 4): multi-location jobs with a US marker
  // must NOT be archived even if a blocklisted substring (e.g. "canada")
  // appears elsewhere in the location string.
  const multi = {
    ...BASE_JOB,
    location: "Atlanta, GA, United States; Toronto, Canada",
  };
  const { passed, rejected } = filterJobs(
    [multi],
    { location_blocklist: ["canada"] }
  );
  assert.equal(passed.length, 1);
  assert.equal(rejected.length, 0);

  // Every US marker should trigger the safeguard.
  for (const marker of US_MARKERS) {
    const j = { ...BASE_JOB, location: `Remote (${marker}); Toronto, Canada` };
    const { passed: p } = filterJobs([j], { location_blocklist: ["canada"] });
    assert.equal(p.length, 1, `marker "${marker}" should skip location blocklist`);
  }

  // No US marker → blocklist still applies.
  const canadaOnly = { ...BASE_JOB, location: "Toronto, Canada" };
  const { rejected: rej } = filterJobs(
    [canadaOnly],
    { location_blocklist: ["canada"] }
  );
  assert.equal(rej.length, 1);
});

test("filterJobs enforces company_cap (max_active)", () => {
  const jobs = [
    { ...BASE_JOB, jobId: "a" },
    { ...BASE_JOB, jobId: "b" },
    { ...BASE_JOB, jobId: "c" },
    { ...BASE_JOB, jobId: "d" },
  ];
  const { passed, rejected } = filterJobs(jobs, { company_cap: { max_active: 2 } });
  assert.equal(passed.length, 2);
  assert.equal(rejected.length, 2);
  assert.equal(rejected[0].reason.kind, "company_cap");
});

test("filterJobs respects company_cap.overrides per company", () => {
  const jobs = [
    { ...BASE_JOB, jobId: "a", company: "Capital One" },
    { ...BASE_JOB, jobId: "b", company: "Capital One" },
    { ...BASE_JOB, jobId: "c", company: "Capital One" },
    { ...BASE_JOB, jobId: "d", company: "Capital One" },
    { ...BASE_JOB, jobId: "e", company: "Stripe" },
    { ...BASE_JOB, jobId: "f", company: "Stripe" },
  ];
  const rules = {
    company_cap: { max_active: 2, overrides: { "Capital One": 3 } },
  };
  const { passed, rejected } = filterJobs(jobs, rules);
  const byCompany = passed.reduce((acc, j) => {
    acc[j.company] = (acc[j.company] || 0) + 1;
    return acc;
  }, {});
  assert.equal(byCompany["Capital One"], 3);
  assert.equal(byCompany["Stripe"], 2);
  assert.equal(rejected.length, 1);
});

test("filterJobs accumulates counts from currentCounts baseline", () => {
  const jobs = [
    { ...BASE_JOB, jobId: "x" },
    { ...BASE_JOB, jobId: "y" },
  ];
  const { passed, rejected } = filterJobs(
    jobs,
    { company_cap: { max_active: 2 } },
    { Stripe: 2 }
  );
  assert.equal(passed.length, 0);
  assert.equal(rejected.length, 2);
});

test("filterJobs throws on bad input", () => {
  assert.throws(() => filterJobs("nope", {}), /jobs must be an array/);
  assert.throws(() => filterJobs([], null), /rules must be an object/);
});
