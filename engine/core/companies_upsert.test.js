const test = require("node:test");
const assert = require("node:assert");

const { planUpsert, buildKnownIndex, createProps, FIELD_SPECS } = require("./companies_upsert.js");

function row(over = {}) {
  return {
    name: "New Co",
    website: "newco.com",
    ru_signal: "RU founder (Yerevan)",
    market: "US SaaS",
    us_viability: "HIGH",
    channel: "outreach",
    ats: "greenhouse:newco",
    contact: "Jane Doe (CEO)",
    open_roles_url: "https://newco.com/careers",
    notes: "early stage",
    ...over,
  };
}

test("create: unknown company -> full props, Name + fill fields present", () => {
  const known = buildKnownIndex({});
  const plan = planUpsert({ rows: [row()], known });
  assert.strictEqual(plan.creates.length, 1);
  assert.strictEqual(plan.fills.length, 0);
  assert.strictEqual(plan.skips.length, 0);
  const fields = plan.creates[0].props.map((p) => p.field);
  assert.ok(fields.includes("Name"));
  assert.ok(fields.includes("Website"));
  assert.ok(fields.includes("Why Interested"));
  assert.ok(fields.includes("Notes"));
  assert.ok(fields.includes("Outbound Status"));
});

test("Tier is never written on create", () => {
  assert.ok(!FIELD_SPECS.some((s) => s.field === "Tier"));
  const plan = planUpsert({ rows: [row()], known: buildKnownIndex({}) });
  assert.ok(!plan.creates[0].props.some((p) => p.field === "Tier"));
});

test("Website value gets https:// prefix; bare domain normalized for dedup", () => {
  const plan = planUpsert({ rows: [row({ website: "newco.com" })], known: buildKnownIndex({}) });
  const website = plan.creates[0].props.find((p) => p.field === "Website");
  assert.strictEqual(website.value, "https://newco.com");
});

test("dedup by domain: existing Notion page with same domain -> not created", () => {
  const known = buildKnownIndex({
    notionPages: [
      {
        pageId: "p1",
        name: "Totally Different Name",
        website: "https://www.newco.com/jobs",
        values: {
          Website: "https://newco.com",
          Notes: "x",
          "Why Interested": "y",
          "Careers URL": "z",
          "Outbound Status": "Not started",
        },
      },
    ],
  });
  const plan = planUpsert({ rows: [row()], known });
  assert.strictEqual(plan.creates.length, 0);
  // all fields already present -> skip, not fill
  assert.strictEqual(plan.skips.length, 1);
  assert.strictEqual(plan.skips[0].reason, "already-complete");
});

test("dedup by name when no website on candidate", () => {
  const known = buildKnownIndex({
    notionPages: [{ pageId: "p2", name: "New Co", website: "", values: {} }],
  });
  const plan = planUpsert({ rows: [row({ website: "" })], known });
  assert.strictEqual(plan.creates.length, 0);
  assert.strictEqual(plan.fills.length, 1);
  assert.strictEqual(plan.fills[0].pageId, "p2");
});

test("fill-gaps: only empty page fields are written, non-empty kept", () => {
  const known = buildKnownIndex({
    notionPages: [
      {
        pageId: "p3",
        name: "New Co",
        website: "newco.com",
        values: {
          Website: "https://newco.com", // non-empty -> keep
          Notes: "", // empty -> fill
          "Why Interested": "existing reason", // non-empty -> keep
          "Careers URL": "", // empty -> fill
          "Outbound Status": "Contacted", // non-empty -> keep
        },
      },
    ],
  });
  const plan = planUpsert({ rows: [row()], known });
  assert.strictEqual(plan.fills.length, 1);
  const filled = plan.fills[0].props.map((p) => p.field).sort();
  assert.deepStrictEqual(filled, ["Careers URL", "Notes"]);
});

test("known via data/companies.tsv but not in Notion -> skip, no create", () => {
  const known = buildKnownIndex({ tsvNames: ["New Co"] });
  const plan = planUpsert({ rows: [row()], known });
  assert.strictEqual(plan.creates.length, 0);
  assert.strictEqual(plan.skips.length, 1);
  assert.strictEqual(plan.skips[0].reason, "known-non-notion");
});

test("known via relokant ledger but not in Notion -> skip", () => {
  const known = buildKnownIndex({ ledgerNames: ["New Co"] });
  const plan = planUpsert({ rows: [row()], known });
  assert.strictEqual(plan.skips[0].reason, "known-non-notion");
});

test("in-batch dedup: same company twice -> one create, one skip", () => {
  const plan = planUpsert({ rows: [row(), row()], known: buildKnownIndex({}) });
  assert.strictEqual(plan.creates.length, 1);
  assert.strictEqual(plan.skips.length, 1);
  assert.strictEqual(plan.skips[0].reason, "in-batch-dup");
});

test("in-batch dedup catches same domain under different name", () => {
  const rows = [row({ name: "New Co" }), row({ name: "Newco Inc", website: "www.newco.com" })];
  const plan = planUpsert({ rows, known: buildKnownIndex({}) });
  assert.strictEqual(plan.creates.length, 1);
  assert.strictEqual(plan.skips[0].reason, "in-batch-dup");
});

test("row with no name -> skip no-name", () => {
  const plan = planUpsert({ rows: [row({ name: "" })], known: buildKnownIndex({}) });
  assert.strictEqual(plan.skips[0].reason, "no-name");
  assert.strictEqual(plan.creates.length, 0);
});

test("buildKnownIndex: a Notion page upgrades a bare tsv/ledger marker (gets fill, not skip)", () => {
  // Same company present in both data/companies.tsv (presence only) AND Notion
  // with an empty field. The Notion entry must win so we back-fill, not treat
  // it as a non-Notion known and skip it.
  const known = buildKnownIndex({
    tsvNames: ["New Co"],
    notionPages: [{ pageId: "pX", name: "New Co", website: "", values: { Notes: "" } }],
  });
  const plan = planUpsert({ rows: [row({ website: "" })], known });
  assert.strictEqual(plan.skips.length, 0);
  assert.strictEqual(plan.fills.length, 1);
  assert.strictEqual(plan.fills[0].pageId, "pX");
});

test("planUpsert: domain match wins over an unrelated name-key entry", () => {
  // byDomain points at page D (complete); byName would point at page N. The
  // domain hit must be chosen -> already-complete skip, not a fill on N.
  const known = {
    byDomain: new Map([
      [
        "newco.com",
        {
          inNotion: true,
          pageId: "D",
          values: {
            Website: "https://newco.com",
            Notes: "x",
            "Why Interested": "y",
            "Careers URL": "z",
            "Outbound Status": "Not started",
          },
        },
      ],
    ]),
    byName: new Map([["new co", { inNotion: true, pageId: "N", values: {} }]]),
  };
  const plan = planUpsert({ rows: [row()], known });
  assert.strictEqual(plan.skips.length, 1);
  assert.strictEqual(plan.skips[0].reason, "already-complete");
  assert.strictEqual(plan.fills.length, 0);
});

test("createProps omits empty optional fields", () => {
  const props = createProps(row({ open_roles_url: "", ru_signal: "", market: "" }));
  const fields = props.map((p) => p.field);
  assert.ok(!fields.includes("Careers URL"));
  assert.ok(!fields.includes("Why Interested"));
  assert.ok(fields.includes("Name"));
});
