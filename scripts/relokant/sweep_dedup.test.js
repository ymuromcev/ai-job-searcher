const test = require("node:test");
const assert = require("node:assert");

const { normalizeName, partitionCandidates } = require("./sweep_dedup.js");

test("normalizeName lowercases and trims", () => {
  assert.strictEqual(normalizeName("  Krisp  "), "krisp");
  assert.strictEqual(normalizeName("SuperAnnotate"), "superannotate");
});

test("normalizeName strips diacritics", () => {
  assert.strictEqual(normalizeName("José"), "jose");
  assert.strictEqual(normalizeName("Café Möller"), "cafe moller");
});

test("normalizeName drops punctuation and collapses whitespace", () => {
  assert.strictEqual(normalizeName("Virto   Commerce"), "virto commerce");
  assert.strictEqual(normalizeName("ID-Finance!!"), "id finance");
});

test("normalizeName peels trailing legal suffixes", () => {
  assert.strictEqual(normalizeName("Virto Commerce, Inc."), "virto commerce");
  assert.strictEqual(normalizeName("Acme Co Ltd"), "acme");
  // suffix-only name is kept (don't strip down to empty)
  assert.strictEqual(normalizeName("Inc"), "inc");
});

test("normalizeName matches across legal-suffix / casing variants", () => {
  assert.strictEqual(normalizeName("Virto Commerce"), normalizeName("virto commerce  inc"));
});

test("normalizeName keeps Cyrillic (CIS-domain names) instead of emptying them", () => {
  // CIS company names are often Cyrillic — must survive normalization so a
  // genuinely new company is not mislabeled DUP and silently dropped.
  assert.strictEqual(normalizeName("Яндекс"), "яндекс");
  assert.strictEqual(normalizeName("  ВкусВилл!! "), "вкусвилл");
  assert.notStrictEqual(normalizeName("Яндекс"), normalizeName("Озон"));
});

test("partitionCandidates treats a fresh Cyrillic name as fresh, not dup", () => {
  const known = new Set([normalizeName("Яндекс")]);
  const { fresh, dupes } = partitionCandidates(["Озон", "яндекс"], known);
  assert.deepStrictEqual(fresh, ["Озон"]);
  assert.deepStrictEqual(dupes, ["яндекс"]);
});

test("normalizeName returns empty for junk", () => {
  assert.strictEqual(normalizeName(""), "");
  assert.strictEqual(normalizeName("!!!"), "");
  assert.strictEqual(normalizeName(null), "");
});

test("partitionCandidates splits fresh vs known dupes", () => {
  const known = new Set([normalizeName("Miro"), normalizeName("Wrike")]);
  const { fresh, dupes } = partitionCandidates(["New Co", "miro", "WRIKE", "Another"], known);
  assert.deepStrictEqual(fresh, ["New Co", "Another"]);
  assert.deepStrictEqual(dupes, ["miro", "WRIKE"]);
});

test("partitionCandidates dedups within the candidate batch", () => {
  const { fresh, dupes } = partitionCandidates(["New Co", "new co, inc", "New Co"], new Set());
  assert.deepStrictEqual(fresh, ["New Co"]);
  assert.deepStrictEqual(dupes, ["new co, inc", "New Co"]);
});

test("partitionCandidates skips junk names entirely", () => {
  const { fresh, dupes } = partitionCandidates(["", "!!!", "Real Co"], new Set());
  assert.deepStrictEqual(fresh, ["Real Co"]);
  assert.deepStrictEqual(dupes, []);
});

test("partitionCandidates matches a known company through its legal suffix", () => {
  const known = new Set([normalizeName("Virto Commerce")]);
  const { fresh, dupes } = partitionCandidates(["Virto Commerce, LLC"], known);
  assert.deepStrictEqual(fresh, []);
  assert.deepStrictEqual(dupes, ["Virto Commerce, LLC"]);
});
