const { test } = require("node:test");
const assert = require("node:assert/strict");

const { extract } = require("./seed_companies.js");

test("extract pulls greenhouse / lever / smartrecruiters / workday targets", () => {
  const text = `
    const targets = [
      { name: "Affirm", platform: "greenhouse", slug: "affirm" },
      { name: "Stripe", platform: "lever", slug: "stripe" },
      { name: "Capital One", platform: "workday", slug: "capitalone", dc: "wd1", site: "jobs" },
      { name: "EPAM", platform: "smartrecruiters", slug: "EPAM" },
    ];
  `;
  const out = extract(text);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { name: "Affirm", source: "greenhouse", slug: "affirm", extra: null });
  const cap = out.find((r) => r.slug === "capitalone");
  assert.deepEqual(cap.extra, { dc: "wd1", site: "jobs" });
});

test("extract pulls ASHBY_COMPANIES separately", () => {
  const text = `
    const ASHBY_COMPANIES = [
      { name: "Ramp", slug: "ramp" },
      { name: "Sardine", slug: "sardine" },
    ];
  `;
  const out = extract(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].source, "ashby");
});

test("extract dedupes by (source, slug)", () => {
  const text = `
    const targets = [
      { name: "Affirm", platform: "greenhouse", slug: "affirm" },
      { name: "Affirm", platform: "greenhouse", slug: "affirm" },
    ];
  `;
  const out = extract(text);
  assert.equal(out.length, 1);
});

test("extract on real legacy file finds ≥200 targets across 5 sources", () => {
  const fs = require("fs");
  const path = require("path");
  const legacyPath = path.resolve(__dirname, "..", "..", "..", "Job Search", "find_jobs.js");
  if (!fs.existsSync(legacyPath)) {
    // Skip when the legacy MVP is not checked out alongside this repo.
    return;
  }
  const text = fs.readFileSync(legacyPath, "utf8");
  const out = extract(text);
  assert.ok(out.length > 200, `expected >200 targets, got ${out.length}`);
  const sources = new Set(out.map((r) => r.source));
  for (const expected of ["greenhouse", "lever", "ashby", "smartrecruiters", "workday"]) {
    assert.ok(sources.has(expected), `missing source ${expected}`);
  }
});
