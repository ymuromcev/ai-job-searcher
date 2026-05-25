const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  extractJDPhrases,
  buildPhrasePrompt,
  parsePhrasesFromLLM,
} = require("./jd_phrase_extract.js");

test("buildPhrasePrompt — contains JD text and key contract tokens", () => {
  const prompt = buildPhrasePrompt("We are hiring a Plaid PM to own open finance.", {
    requirements: ["5+ years PM experience", "Fintech background"],
    responsibilities: ["Own a product area end-to-end"],
  });
  // Header tokens we rely on the LLM seeing.
  assert.ok(prompt.includes("lexical-mirror"));
  assert.ok(prompt.includes("category"));
  assert.ok(prompt.includes("priority"));
  // Pre-extracted bullets surface.
  assert.ok(prompt.includes("5+ years PM experience"));
  assert.ok(prompt.includes("Own a product area end-to-end"));
  // Raw JD is included.
  assert.ok(prompt.includes("Plaid PM"));
  assert.ok(prompt.includes("open finance"));
});

test("buildPhrasePrompt — gracefully handles empty/missing structure", () => {
  const prompt = buildPhrasePrompt("raw jd text", null);
  assert.ok(prompt.includes("(none)"));
  assert.ok(prompt.includes("raw jd text"));
  const prompt2 = buildPhrasePrompt("", {});
  assert.ok(prompt2.includes("(empty)"));
});

test("parsePhrasesFromLLM — accepts array directly and validates fields", () => {
  const input = [
    { phrase: "open finance", category: "domain", priority: "high" },
    { phrase: "scrum of scrums", category: "skill", priority: "medium" },
    // Invalid category — dropped.
    { phrase: "bogus", category: "weird", priority: "high" },
    // Invalid priority — dropped.
    { phrase: "graphql", category: "tech", priority: "critical" },
    // Empty phrase — dropped.
    { phrase: "", category: "tech", priority: "high" },
  ];
  const out = parsePhrasesFromLLM(input);
  assert.equal(out.length, 2);
  assert.equal(out[0].phrase, "open finance");
  assert.equal(out[0].category, "domain");
  assert.equal(out[1].phrase, "scrum of scrums");
});

test("parsePhrasesFromLLM — extracts array from raw LLM string with fences", () => {
  const raw = `Here are the phrases:
\`\`\`json
[
  {"phrase": "kubernetes", "category": "tech", "priority": "high"},
  {"phrase": "open finance", "category": "domain", "priority": "high"}
]
\`\`\`
Hope this helps!`;
  const out = parsePhrasesFromLLM(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].phrase, "kubernetes");
  assert.equal(out[1].phrase, "open finance");
});

test("parsePhrasesFromLLM — bad/empty input returns []", () => {
  assert.deepEqual(parsePhrasesFromLLM(null), []);
  assert.deepEqual(parsePhrasesFromLLM(undefined), []);
  assert.deepEqual(parsePhrasesFromLLM("no json here"), []);
  assert.deepEqual(parsePhrasesFromLLM("[ malformed"), []);
});

test("extractJDPhrases — calls llmCallFn with built prompt and returns parsed phrases", async () => {
  let capturedPrompt = null;
  const fakePhrases = [
    { phrase: "own product area", category: "responsibility", priority: "high" },
    { phrase: "open finance", category: "domain", priority: "high" },
  ];
  const llmCallFn = async (prompt) => {
    capturedPrompt = prompt;
    return fakePhrases;
  };
  const out = await extractJDPhrases({
    jdText: "Plaid hiring PM for open finance.",
    jdStructure: { requirements: ["5+ years PM"], responsibilities: [] },
    llmCallFn,
  });
  assert.ok(capturedPrompt.includes("Plaid hiring PM"));
  assert.equal(out.length, 2);
  assert.equal(out[0].phrase, "own product area");
});

test("extractJDPhrases — throws when llmCallFn missing", async () => {
  await assert.rejects(
    () => extractJDPhrases({ jdText: "x", jdStructure: {}, llmCallFn: null }),
    /llmCallFn is required/
  );
});
