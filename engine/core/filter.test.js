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

test("filterJobs title_blocklist uses word-boundary (rn does not match PRN)", () => {
  // 2026-04-28 fix: short patterns like "rn", "do", "md" must not match
  // mid-word substrings. "PRN" (per-shift) is NOT a registered nurse role.
  const prn = { ...BASE_JOB, role: "Medical Records Assistant - PRN" };
  const { passed, rejected } = filterJobs(
    [prn],
    { title_blocklist: [{ pattern: "rn", reason: "registered nurse" }] }
  );
  assert.equal(rejected.length, 0);
  assert.equal(passed.length, 1);

  // But standalone "RN" still matches.
  const rn = { ...BASE_JOB, role: "RN — Acute Care" };
  const { rejected: r2 } = filterJobs(
    [rn],
    { title_blocklist: [{ pattern: "rn", reason: "registered nurse" }] }
  );
  assert.equal(r2.length, 1);
});

test("filterJobs title_blocklist word-boundary (do does not match orthodontic)", () => {
  // "DO" (Doctor of Osteopathy) must not match "orthodontic" or "doctor".
  const ortho = { ...BASE_JOB, role: "Bilingual Orthodontic Receptionist" };
  const { passed, rejected } = filterJobs(
    [ortho],
    { title_blocklist: [{ pattern: "do", reason: "doctor of osteopathy" }] }
  );
  assert.equal(rejected.length, 0);
  assert.equal(passed.length, 1);

  // Standalone "DO" still matches.
  const dox = { ...BASE_JOB, role: "Family Practice DO" };
  const { rejected: r2 } = filterJobs(
    [dox],
    { title_blocklist: [{ pattern: "do", reason: "doctor of osteopathy" }] }
  );
  assert.equal(r2.length, 1);
});

test("filterJobs title_blocklist compound title (slash) — any clean part passes", () => {
  // 2026-04-28: "Dental Receptionist/Office Manager" must pass even if
  // "manager" is on the blocklist — receptionist part is clean.
  const compound = { ...BASE_JOB, role: "Dental Receptionist/Office Manager" };
  const { passed, rejected } = filterJobs(
    [compound],
    { title_blocklist: [{ pattern: "manager", reason: "managerial" }] }
  );
  assert.equal(rejected.length, 0);
  assert.equal(passed.length, 1);
});

test("filterJobs title_blocklist compound title (slash) — all parts blocked → rejected", () => {
  // "Senior Manager/Director" — both halves hit "manager" / "director" → blocked.
  const allBad = { ...BASE_JOB, role: "Senior Manager/Director of Ops" };
  const { rejected } = filterJobs(
    [allBad],
    {
      title_blocklist: [
        { pattern: "manager", reason: "managerial" },
        { pattern: "director", reason: "too senior" },
      ],
    }
  );
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.kind, "title_blocklist");
});

test("filterJobs title_blocklist does NOT split on comma (department modifier stays)", () => {
  // "Supervisor, Medical" is ONE role with a department modifier — must block.
  const role = { ...BASE_JOB, role: "Supervisor, Medical" };
  const { rejected } = filterJobs(
    [role],
    { title_blocklist: [{ pattern: "supervisor", reason: "managerial" }] }
  );
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.pattern, "supervisor");
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

// ── title_requirelist ────────────────────────────────────────────────────────

test("filterJobs title_requirelist passes a matching PM title", () => {
  const rules = {
    title_requirelist: [
      { pattern: "product manager", reason: "PM role" },
      { pattern: "PM", reason: "PM abbreviation" },
    ],
  };
  const { passed, rejected } = filterJobs([BASE_JOB], rules); // BASE_JOB role = "Senior Product Manager"
  assert.equal(passed.length, 1);
  assert.equal(rejected.length, 0);
});

test("filterJobs title_requirelist rejects a non-PM title (SWE)", () => {
  const swe = { ...BASE_JOB, role: "Senior Software Engineer" };
  const rules = {
    title_requirelist: [
      { pattern: "product manager", reason: "PM role" },
      { pattern: "PM", reason: "PM abbreviation" },
    ],
  };
  const { passed, rejected } = filterJobs([swe], rules);
  assert.equal(passed.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.kind, "title_requirelist");
});

test("filterJobs title_requirelist passes PM abbreviation title", () => {
  const srPm = { ...BASE_JOB, role: "Sr. PM, Payments" };
  const rules = {
    title_requirelist: [{ pattern: "PM", reason: "PM abbreviation" }],
  };
  const { passed } = filterJobs([srPm], rules);
  assert.equal(passed.length, 1);
});

test("filterJobs title_requirelist — slash compound: one PM part → passes", () => {
  // "Analyst/Product Manager" — second part is a PM, so it passes even though
  // "Analyst" alone would fail the requirelist.
  const hybrid = { ...BASE_JOB, role: "Analyst/Product Manager" };
  const rules = {
    title_requirelist: [{ pattern: "product manager", reason: "PM role" }],
  };
  const { passed, rejected } = filterJobs([hybrid], rules);
  assert.equal(passed.length, 1);
  assert.equal(rejected.length, 0);
});

test("filterJobs title_requirelist — slash compound: all non-PM parts → rejected", () => {
  // "Software Engineer/DevOps" — neither part matches; role rejected.
  const noMatch = { ...BASE_JOB, role: "Software Engineer/DevOps" };
  const rules = {
    title_requirelist: [
      { pattern: "product manager", reason: "PM role" },
      { pattern: "PM", reason: "PM abbreviation" },
    ],
  };
  const { passed, rejected } = filterJobs([noMatch], rules);
  assert.equal(passed.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.kind, "title_requirelist");
});

test("filterJobs title_requirelist empty array skips the gate (pass-through)", () => {
  // When title_requirelist is empty, no positive gate is applied.
  const swe = { ...BASE_JOB, role: "Software Engineer" };
  const { passed } = filterJobs([swe], { title_requirelist: [] });
  assert.equal(passed.length, 1);
});

test("filterJobs title_requirelist is applied before title_blocklist", () => {
  // A role that fails the requirelist should be rejected with kind=title_requirelist,
  // not title_blocklist, even if it also matches the blocklist.
  const swe = { ...BASE_JOB, role: "Senior Software Engineer" };
  const rules = {
    title_requirelist: [{ pattern: "product manager", reason: "PM role" }],
    title_blocklist: [{ pattern: "senior", reason: "over-level" }],
  };
  const { rejected } = filterJobs([swe], rules);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.kind, "title_requirelist");
});
