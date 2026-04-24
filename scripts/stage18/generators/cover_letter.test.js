const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCoverLetterTemplate,
  buildCoverLetterVersions,
  lengthHint,
  toneHint,
} = require("./cover_letter.js");

test("toneHint + lengthHint: known values covered, unknown → conversational/medium", () => {
  assert.ok(toneHint("formal").includes("Formal"));
  assert.ok(toneHint("punchy").includes("Direct"));
  assert.ok(toneHint("conversational").includes("First person"));
  assert.ok(toneHint("nonsense").includes("First person")); // fallback
  assert.ok(lengthHint("short").includes("200"));
  assert.ok(lengthHint("long").includes("400"));
  assert.ok(lengthHint("").includes("200–400"));
});

test("buildCoverLetterTemplate: includes name, signature, placeholders", () => {
  const md = buildCoverLetterTemplate({
    identity: { full_name: "Pat Example" },
    cover_letter: {
      signature: "Best, Pat",
      tone: "conversational",
      length: "medium",
      intro_hint: "Open with why the company matters.",
    },
  });
  assert.ok(md.includes("Pat Example"));
  assert.ok(md.includes("Best, Pat"));
  assert.ok(md.includes("{{INTRO_PARAGRAPH}}"));
  assert.ok(md.includes("{{WHY_INTERESTED_PARAGRAPH}}"));
  assert.ok(md.includes("{{WHY_FIT_PARAGRAPH}}"));
  assert.ok(md.includes("{{CLOSE_PARAGRAPH}}"));
  assert.ok(md.includes("Dear Hiring Manager"));
});

test("buildCoverLetterTemplate: falls back when cover_letter section empty", () => {
  const md = buildCoverLetterTemplate({
    identity: { full_name: "Jane Doe" },
  });
  assert.ok(md.includes("Jane Doe"));
  assert.ok(md.includes("Best,")); // default signature structure
  assert.ok(md.includes("{{INTRO_PARAGRAPH}}"));
});

test("buildCoverLetterTemplate: missing name → {{FULL_NAME}} placeholder", () => {
  const md = buildCoverLetterTemplate({});
  assert.ok(md.includes("{{FULL_NAME}}"));
});

test("buildCoverLetterVersions: keys mirror archetype slugs", () => {
  const v = buildCoverLetterVersions({
    resume_archetypes: [{ key: "ai-pm" }, { key: "fintech" }],
  });
  assert.deepEqual(Object.keys(v.versions).sort(), ["ai-pm", "fintech"]);
  for (const k of Object.keys(v.versions)) {
    const e = v.versions[k];
    assert.equal(e.intro_override, "");
    assert.equal(e.why_interested_override, "");
  }
});

test("buildCoverLetterVersions: empty archetypes → {versions: {}}", () => {
  assert.deepEqual(buildCoverLetterVersions({}).versions, {});
  assert.deepEqual(buildCoverLetterVersions({ resume_archetypes: [] }).versions, {});
});
