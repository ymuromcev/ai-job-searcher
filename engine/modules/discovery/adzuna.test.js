// Unit tests for the Adzuna discovery adapter.
// All network I/O is mocked via a fake fetchFn.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { discover, source, feedMode, _internals } = require("./adzuna.js");
const { deriveKeywordsFromRoleTargets, patternToKeywords } = _internals;

function makeRes(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const LISTING = {
  id: 1234567890,
  title: "Senior Product Manager",
  company: { display_name: "Stripe" },
  location: { display_name: "San Francisco, CA" },
  redirect_url: "https://www.adzuna.com/land/ad/1234567890",
  created: "2026-04-20T10:00:00Z",
  description: "We are looking for a Senior PM...",
  contract_type: "permanent",
};

const LISTING_2 = {
  id: 9876543210,
  title: "Product Manager",
  company: { display_name: "Affirm" },
  location: { display_name: "Remote" },
  redirect_url: "https://www.adzuna.com/land/ad/9876543210",
  created: "2026-04-21T08:00:00Z",
  description: "PM role at Affirm...",
};

const SECRETS = { ADZUNA_APP_ID: "test_id", ADZUNA_API_KEY: "test_key" };

test("adzuna: exports correct source and feedMode", () => {
  assert.equal(source, "adzuna");
  assert.equal(feedMode, true);
});

test("adzuna: returns empty array when secrets missing", async () => {
  const warnings = [];
  const jobs = await discover([], {
    secrets: {},
    logger: { warn: (m) => warnings.push(m) },
  });
  assert.deepEqual(jobs, []);
  assert.ok(warnings.some((w) => w.includes("missing ADZUNA_APP_ID")));
});

test("adzuna: fetches and normalises jobs for each keyword", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return url.includes("what=Product+Manager")
      ? makeRes({ results: [LISTING] })
      : makeRes({ results: [LISTING_2] });
  };

  const jobs = await discover([], {
    fetchFn,
    secrets: SECRETS,
    discovery: {
      keyword_search: {
        keywords: ["Product Manager", "Senior Product Manager"],
        location: "United States",
        results_per_keyword: 50,
        max_age_days: 30,
      },
    },
    logger: { warn: () => {} },
  });

  assert.equal(calls.length, 2);
  assert.equal(jobs.length, 2);

  const stripe = jobs.find((j) => j.companyName === "Stripe");
  assert.ok(stripe);
  assert.equal(stripe.source, "adzuna");
  assert.equal(stripe.jobId, "1234567890");
  assert.equal(stripe.title, "Senior Product Manager");
  assert.equal(stripe.url, "https://www.adzuna.com/land/ad/1234567890");
  assert.equal(stripe.postedAt, "2026-04-20");
  assert.ok(stripe.locations.includes("San Francisco, CA"));
});

test("adzuna: dedupes same jobId across multiple keywords", async () => {
  const fetchFn = async () => makeRes({ results: [LISTING] });

  const jobs = await discover([], {
    fetchFn,
    secrets: SECRETS,
    discovery: { keyword_search: { keywords: ["Product Manager", "Senior PM"] } },
    logger: { warn: () => {} },
  });

  // Both keywords return LISTING (id=1234567890) → only one job
  assert.equal(jobs.length, 1);
});

test("adzuna: uses default keywords and params when no discovery config", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return makeRes({ results: [] });
  };

  await discover([], {
    fetchFn,
    secrets: SECRETS,
    logger: { warn: () => {} },
  });

  // Default is 2 keywords
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("what=Product+Manager"));
  assert.ok(calls[1].includes("what=Senior+Product+Manager"));
  assert.ok(calls[0].includes("where=United+States"));
  // Adzuna's age-filter param is `max_days_old` (not `max_days`) — sending the
  // wrong name makes the gateway 400 the request. Guard against regressing it.
  assert.ok(calls[0].includes("max_days_old=30"));
  assert.ok(!calls[0].includes("max_days=30"));
  assert.ok(calls[0].includes("results_per_page=50"));
});

test("adzuna: handles HTTP error gracefully and continues other keywords", async () => {
  const warnings = [];
  let call = 0;
  const fetchFn = async () => {
    call += 1;
    if (call === 1) return makeRes({}, 500);
    return makeRes({ results: [LISTING_2] });
  };

  const jobs = await discover([], {
    fetchFn,
    secrets: SECRETS,
    logger: { warn: (m) => warnings.push(m) },
  });

  assert.ok(warnings.some((w) => w.includes("HTTP 500")));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].companyName, "Affirm");
});

test("adzuna: skips listings missing id", async () => {
  const fetchFn = async () => makeRes({ results: [LISTING, { title: "Bad job no id" }] });

  const jobs = await discover([], {
    fetchFn,
    secrets: SECRETS,
    logger: { warn: () => {} },
  });

  assert.equal(jobs.length, 1);
});

// ---------------------------------------------------------------------------
// BL-87: derive keywords from role_targets when keyword_search.keywords absent
// ---------------------------------------------------------------------------

test("adzuna BL-87: patternToKeywords strips anchors and \\b", () => {
  assert.deepEqual(patternToKeywords("^product manager$"), ["product manager"]);
  assert.deepEqual(patternToKeywords("\\bPM\\b"), ["PM"]);
  assert.deepEqual(patternToKeywords("forward-deployed"), ["forward-deployed"]);
});

test("adzuna BL-87: patternToKeywords expands simple (a|b) alternation", () => {
  assert.deepEqual(patternToKeywords("product (manager|owner)"), [
    "product manager",
    "product owner",
  ]);
  assert.deepEqual(patternToKeywords("(senior|lead) pm"), ["senior pm", "lead pm"]);
});

test("adzuna BL-87: patternToKeywords drops regex-y patterns (silent skip)", () => {
  // Character class, quantifier, multiple groups, backslash class.
  assert.deepEqual(patternToKeywords("pm[s]?"), []);
  assert.deepEqual(patternToKeywords("manager.*"), []);
  assert.deepEqual(patternToKeywords("\\w+ manager"), []);
  assert.deepEqual(patternToKeywords("(a|b) (c|d)"), []);
  // Empty / whitespace-only after strip → []
  assert.deepEqual(patternToKeywords(""), []);
  assert.deepEqual(patternToKeywords("^$"), []);
});

test("adzuna BL-87: deriveKeywordsFromRoleTargets flattens + dedupes case-insensitively", () => {
  const filterRules = {
    role_targets: {
      tracks: [
        {
          id: "pm",
          patterns: [
            { pattern: "product manager", reason: "PM" },
            { pattern: "PM", reason: "abbr" },
          ],
        },
        {
          id: "fde",
          patterns: [
            { pattern: "forward-deployed", reason: "FDE" },
            // Duplicate of an earlier track (different casing) — should be deduped.
            { pattern: "Product Manager", reason: "dup" },
            { pattern: "(senior|lead) pm", reason: "expansion" },
          ],
        },
      ],
    },
  };
  const out = deriveKeywordsFromRoleTargets(filterRules);
  // First-occurrence casing wins. "PM" stays (different lowercased key from
  // "senior pm" / "lead pm").
  assert.deepEqual(out, ["product manager", "PM", "forward-deployed", "senior pm", "lead pm"]);
});

test("adzuna BL-87: deriveKeywordsFromRoleTargets returns [] when role_targets missing/empty", () => {
  assert.deepEqual(deriveKeywordsFromRoleTargets(null), []);
  assert.deepEqual(deriveKeywordsFromRoleTargets({}), []);
  assert.deepEqual(deriveKeywordsFromRoleTargets({ role_targets: null }), []);
  assert.deepEqual(deriveKeywordsFromRoleTargets({ role_targets: { tracks: [] } }), []);
});

test("adzuna BL-87: derives keywords from role_targets when keyword_search.keywords absent", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return makeRes({ results: [] });
  };

  await discover([], {
    fetchFn,
    secrets: SECRETS,
    // No discovery.keyword_search at all — fallback path.
    filterRules: {
      role_targets: {
        tracks: [
          {
            id: "pm",
            patterns: [
              { pattern: "^product manager$", reason: "PM" },
              { pattern: "\\bPM\\b", reason: "abbr" },
            ],
          },
          {
            id: "fde",
            patterns: [{ pattern: "forward-deployed", reason: "FDE" }],
          },
        ],
      },
    },
    logger: { warn: () => {} },
  });

  // Three unique derived keywords → three calls. Anchors stripped.
  assert.equal(calls.length, 3);
  assert.ok(calls[0].includes("what=product+manager"));
  assert.ok(calls[1].includes("what=PM"));
  assert.ok(calls[2].includes("what=forward-deployed"));
});

test("adzuna BL-87: derives when keyword_search.keywords is explicitly empty []", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return makeRes({ results: [] });
  };

  await discover([], {
    fetchFn,
    secrets: SECRETS,
    discovery: { keyword_search: { keywords: [] } },
    filterRules: {
      role_targets: {
        tracks: [{ id: "pm", patterns: [{ pattern: "product manager" }] }],
      },
    },
    logger: { warn: () => {} },
  });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("what=product+manager"));
});

test("adzuna BL-87: explicit keyword_search.keywords still wins (override path)", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return makeRes({ results: [] });
  };

  await discover([], {
    fetchFn,
    secrets: SECRETS,
    discovery: {
      keyword_search: { keywords: ["Custom Keyword One", "Custom Keyword Two"] },
    },
    // role_targets present but ignored when override is explicit.
    filterRules: {
      role_targets: {
        tracks: [{ id: "pm", patterns: [{ pattern: "product manager" }] }],
      },
    },
    logger: { warn: () => {} },
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("what=Custom+Keyword+One"));
  assert.ok(calls[1].includes("what=Custom+Keyword+Two"));
  // Ensure derived "product manager" did NOT leak in.
  assert.ok(!calls.some((u) => u.includes("what=product+manager")));
});

test("adzuna BL-87: falls back to DEFAULT_KEYWORDS when neither config nor role_targets present", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return makeRes({ results: [] });
  };

  await discover([], {
    fetchFn,
    secrets: SECRETS,
    // No discovery, no filterRules.
    logger: { warn: () => {} },
  });

  // Default is 2 PM keywords (back-compat path).
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("what=Product+Manager"));
  assert.ok(calls[1].includes("what=Senior+Product+Manager"));
});
