const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildResumeVersions } = require("./resume_versions.js");

test("buildResumeVersions: maps archetype list to {versions: {...}}", () => {
  const rv = buildResumeVersions({
    resume_archetypes: [
      {
        key: "ai-pm",
        title: "AI Product Manager",
        summary: "Short bio",
        bullets: ["Built X", "Led Y"],
        tags: ["ai", "ml"],
      },
      {
        key: "fintech",
        title: "FinTech PM",
        summary: "Different bio",
      },
    ],
  });
  assert.deepEqual(Object.keys(rv.versions).sort(), ["ai-pm", "fintech"]);
  assert.equal(rv.versions["ai-pm"].title, "AI Product Manager");
  assert.deepEqual(rv.versions["ai-pm"].tags, ["ai", "ml"]);
  assert.equal(rv.versions["fintech"].bullets, undefined);
});

test("buildResumeVersions: tags lowercased; blanks filtered", () => {
  const rv = buildResumeVersions({
    resume_archetypes: [{ key: "x", title: "T", tags: ["AI", " ML ", ""] }],
  });
  assert.deepEqual(rv.versions.x.tags, ["ai", "ml"]);
});

test("buildResumeVersions: empty/missing archetypes → {versions: {}}", () => {
  assert.deepEqual(buildResumeVersions({}).versions, {});
  assert.deepEqual(buildResumeVersions({ resume_archetypes: [] }).versions, {});
  assert.deepEqual(buildResumeVersions({ resume_archetypes: null }).versions, {});
});

test("buildResumeVersions: drops archetypes with only a key, no fields", () => {
  const rv = buildResumeVersions({
    resume_archetypes: [{ key: "empty" }, { key: "real", title: "Real PM" }],
  });
  assert.deepEqual(Object.keys(rv.versions), ["real"]);
});
