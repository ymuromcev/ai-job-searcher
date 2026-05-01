const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  chunkRichText,
  buildAnswerProperties,
  buildUpdateProperties,
  parseAnswerPage,
  searchAnswers,
  createAnswerPage,
  updateAnswerPage,
} = require("./qa_notion.js");

// ---------- chunkRichText ----------

test("chunkRichText returns empty array for empty input", () => {
  assert.deepEqual(chunkRichText(""), []);
  assert.deepEqual(chunkRichText(null), []);
  assert.deepEqual(chunkRichText(undefined), []);
});

test("chunkRichText returns single segment for short text", () => {
  const out = chunkRichText("hello");
  assert.equal(out.length, 1);
  assert.equal(out[0].text.content, "hello");
  assert.equal(out[0].type, "text");
});

test("chunkRichText splits long text into <=2000-char segments", () => {
  const long = "a".repeat(5500);
  const out = chunkRichText(long);
  assert.equal(out.length, 3);
  assert.equal(out[0].text.content.length, 2000);
  assert.equal(out[1].text.content.length, 2000);
  assert.equal(out[2].text.content.length, 1500);
});

// ---------- buildAnswerProperties ----------

test("buildAnswerProperties produces the full schema", () => {
  const props = buildAnswerProperties({
    question: "Why?",
    answer: "Because.",
    category: "Motivation",
    role: "PM",
    company: "Linear",
    notes: "210 chars",
  });
  assert.deepEqual(Object.keys(props).sort(), ["Answer", "Category", "Company", "Notes", "Question", "Role"]);
  assert.equal(props.Question.title[0].text.content, "Why?");
  assert.equal(props.Answer.rich_text[0].text.content, "Because.");
  assert.equal(props.Category.select.name, "Motivation");
  assert.equal(props.Role.rich_text[0].text.content, "PM");
  assert.equal(props.Company.rich_text[0].text.content, "Linear");
  assert.equal(props.Notes.rich_text[0].text.content, "210 chars");
});

test("buildAnswerProperties omits Category when not provided", () => {
  const props = buildAnswerProperties({ question: "Q", answer: "A", role: "PM", company: "X", notes: "" });
  assert.equal(props.Category, undefined);
});

test("buildAnswerProperties handles empty notes/role/company without throwing", () => {
  const props = buildAnswerProperties({ question: "Q", answer: "A", category: "Other" });
  assert.deepEqual(props.Role.rich_text, []);
  assert.deepEqual(props.Company.rich_text, []);
  assert.deepEqual(props.Notes.rich_text, []);
});

// ---------- buildUpdateProperties ----------

test("buildUpdateProperties only includes provided fields", () => {
  const props = buildUpdateProperties({ answer: "new text" });
  assert.deepEqual(Object.keys(props), ["Answer"]);
  assert.equal(props.Answer.rich_text[0].text.content, "new text");
});

test("buildUpdateProperties skips undefined fields but includes empty string", () => {
  const props = buildUpdateProperties({ answer: "x", notes: "" });
  assert.equal(props.Answer.rich_text[0].text.content, "x");
  assert.deepEqual(props.Notes.rich_text, []); // empty string yields []
});

test("buildUpdateProperties includes Category only when provided non-null", () => {
  assert.equal(buildUpdateProperties({}).Category, undefined);
  assert.equal(buildUpdateProperties({ category: null }).Category, undefined);
  assert.equal(buildUpdateProperties({ category: "Salary" }).Category.select.name, "Salary");
});

// ---------- parseAnswerPage ----------

test("parseAnswerPage extracts all fields", () => {
  const page = {
    id: "page-uuid-123",
    url: "https://www.notion.so/abc",
    properties: {
      Question: { title: [{ plain_text: "Why join?" }] },
      Answer: { rich_text: [{ plain_text: "Because of leverage." }] },
      Category: { select: { name: "Motivation" } },
      Role: { rich_text: [{ plain_text: "PM" }] },
      Company: { rich_text: [{ plain_text: "Linear" }] },
      Notes: { rich_text: [{ plain_text: "long version" }] },
    },
  };
  const out = parseAnswerPage(page);
  assert.equal(out.pageId, "page-uuid-123");
  assert.equal(out.url, "https://www.notion.so/abc");
  assert.equal(out.question, "Why join?");
  assert.equal(out.answer, "Because of leverage.");
  assert.equal(out.category, "Motivation");
  assert.equal(out.role, "PM");
  assert.equal(out.company, "Linear");
  assert.equal(out.notes, "long version");
});

test("parseAnswerPage handles missing properties gracefully", () => {
  const out = parseAnswerPage({ id: "x", properties: {} });
  assert.equal(out.pageId, "x");
  assert.equal(out.question, "");
  assert.equal(out.category, null);
});

test("parseAnswerPage joins multi-segment rich_text", () => {
  const page = {
    id: "p",
    properties: {
      Question: { title: [{ plain_text: "Why " }, { plain_text: "join?" }] },
      Answer: { rich_text: [{ plain_text: "Hello " }, { plain_text: "world." }] },
    },
  };
  const out = parseAnswerPage(page);
  assert.equal(out.question, "Why join?");
  assert.equal(out.answer, "Hello world.");
});

// ---------- searchAnswers (with fake client) ----------

function makeFakeClient(pages) {
  return {
    databases: {
      retrieve: async () => ({ data_sources: [{ id: "ds-1" }] }),
    },
    dataSources: {
      query: async () => ({ results: pages, has_more: false }),
    },
    pages: {
      create: async (req) => ({ id: "new-page-id", ...req }),
      update: async (req) => ({ id: req.page_id, ...req }),
    },
  };
}

function makePage({ id, q, a, cat, role, co, notes }) {
  return {
    id,
    properties: {
      Question: { title: [{ plain_text: q || "" }] },
      Answer: { rich_text: [{ plain_text: a || "" }] },
      Category: cat ? { select: { name: cat } } : { select: null },
      Role: { rich_text: [{ plain_text: role || "" }] },
      Company: { rich_text: [{ plain_text: co || "" }] },
      Notes: { rich_text: [{ plain_text: notes || "" }] },
    },
  };
}

test("searchAnswers returns exact match when dedup key matches", async () => {
  const client = makeFakeClient([
    makePage({ id: "p1", q: "Why join Linear?", a: "Because.", cat: "Motivation", role: "PM", co: "Linear" }),
    makePage({ id: "p2", q: "What motivates you?", a: "Leverage.", cat: "Motivation", role: "PM", co: "Linear" }),
  ]);
  const { exact, partials } = await searchAnswers(client, "db-1", {
    company: "Linear",
    role: "PM",
    question: "Why join Linear?",
  });
  assert.equal(exact.pageId, "p1");
  assert.equal(partials.length, 1);
  assert.equal(partials[0].pageId, "p2");
});

test("searchAnswers is case-insensitive for dedup matching", async () => {
  const client = makeFakeClient([
    makePage({ id: "p1", q: "Why join Linear?", a: "X", cat: "Motivation", role: "Product Manager", co: "Linear" }),
  ]);
  const { exact } = await searchAnswers(client, "db-1", {
    company: "LINEAR",
    role: "product manager",
    question: "  why join linear?  ",
  });
  assert.equal(exact.pageId, "p1");
});

test("searchAnswers returns null exact + empty partials when nothing matches", async () => {
  const client = makeFakeClient([
    makePage({ id: "p1", q: "Random", a: "X", cat: "Other", role: "Engineer", co: "Stripe" }),
  ]);
  const { exact, partials } = await searchAnswers(client, "db-1", {
    company: "Linear",
    role: "PM",
    question: "Why?",
  });
  assert.equal(exact, null);
  assert.equal(partials.length, 0);
});

test("searchAnswers returns same-question matches across companies as partials", async () => {
  const client = makeFakeClient([
    makePage({ id: "p1", q: "What motivates you?", a: "X", cat: "Motivation", role: "PM", co: "Stripe" }),
    makePage({ id: "p2", q: "What motivates you?", a: "Y", cat: "Motivation", role: "PM", co: "Affirm" }),
  ]);
  const { exact, partials } = await searchAnswers(client, "db-1", {
    company: "Linear",
    role: "PM",
    question: "What motivates you?",
  });
  assert.equal(exact, null);
  assert.equal(partials.length, 2);
});

// ---------- createAnswerPage / updateAnswerPage ----------

test("createAnswerPage sends parent + full properties", async () => {
  let captured = null;
  const client = {
    pages: { create: async (req) => { captured = req; return { id: "new" }; } },
  };
  await createAnswerPage(client, "db-1", {
    question: "Q",
    answer: "A",
    category: "Motivation",
    role: "PM",
    company: "Linear",
    notes: "n",
  });
  assert.equal(captured.parent.database_id, "db-1");
  assert.equal(captured.properties.Question.title[0].text.content, "Q");
  assert.equal(captured.properties.Category.select.name, "Motivation");
});

test("updateAnswerPage sends only the provided fields", async () => {
  let captured = null;
  const client = {
    pages: { update: async (req) => { captured = req; return { id: req.page_id }; } },
  };
  await updateAnswerPage(client, "page-123", { answer: "new", category: "Salary" });
  assert.equal(captured.page_id, "page-123");
  assert.deepEqual(Object.keys(captured.properties).sort(), ["Answer", "Category"]);
  assert.equal(captured.properties.Answer.rich_text[0].text.content, "new");
  assert.equal(captured.properties.Category.select.name, "Salary");
});
