const { test } = require("node:test");
const assert = require("node:assert/strict");

const { pickFresh, formatLine, parseArgs } = require("./fresh_by_source.js");

const NOW = new Date("2026-11-27T16:00:00Z");

function app(over) {
  return {
    source: "walmart",
    status: "Inbox",
    title: "Senior Product Manager",
    locations: ["Sunnyvale, CA"],
    url: "https://careers.walmart.com/us/en/jobs/R-2603947",
    createdAt: "2026-11-27T10:00:00Z",
    ...over,
  };
}

test("pickFresh keeps only fresh Inbox rows of the source, newest first", () => {
  const rows = [
    app({ title: "old", createdAt: "2026-11-20T10:00:00Z" }),
    app({ title: "other source", source: "greenhouse" }),
    app({ title: "prepared", status: "To Apply" }),
    app({ title: "a", createdAt: "2026-11-27T09:00:00Z" }),
    app({ title: "b", createdAt: "2026-11-27T11:00:00Z" }),
    app({ title: "no date", createdAt: "" }),
  ];
  const out = pickFresh(rows, { source: "Walmart", hours: 24, now: NOW });
  assert.deepEqual(
    out.map((r) => r.title),
    ["b", "a"]
  );
});

test("pickFresh without a source returns nothing", () => {
  assert.deepEqual(pickFresh([app({})], { now: NOW }), []);
});

test("formatLine: title — locations — url", () => {
  assert.equal(
    formatLine(app({ locations: ["Sunnyvale, CA", "San Bruno"] })),
    "Senior Product Manager — Sunnyvale, CA; San Bruno — https://careers.walmart.com/us/en/jobs/R-2603947"
  );
});

test("parseArgs validates required flags", () => {
  assert.deepEqual(parseArgs(["--profile", "jared", "--source", "walmart"]), {
    hours: 24,
    profile: "jared",
    source: "walmart",
  });
  assert.throws(() => parseArgs(["--source", "walmart"]), /--profile/);
  assert.throws(() => parseArgs(["--profile", "x", "--source", "w", "--hours", "0"]), /hours/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown arg/);
});
