const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildFitPrompt, substitute } = require("./fit_prompt.js");

test("substitute replaces simple placeholders", () => {
  const out = substitute("Hello {{name}}, you work at {{company}}.", {
    name: "Sam",
    company: "Acme Corp",
  });
  assert.equal(out, "Hello Sam, you work at Acme Corp.");
});

test("substitute supports nested paths", () => {
  const out = substitute("{{job.role}} at {{job.company}}", {
    job: { role: "Senior PM", company: "Stripe" },
  });
  assert.equal(out, "Senior PM at Stripe");
});

test("substitute treats missing keys as empty string", () => {
  const out = substitute("Hi {{unknown}}.", {});
  assert.equal(out, "Hi .");
});

test("substitute tolerates whitespace inside braces", () => {
  assert.equal(substitute("x={{  a.b  }}", { a: { b: 42 } }), "x=42");
});

test("substitute does not execute arbitrary expressions", () => {
  // Only property access — no function calls, no operators.
  const out = substitute("{{a+b}} {{a.b()}}", { a: { b: 1 } });
  // "a+b" does not match path regex, left as-is; "a.b()" also invalid path
  assert.equal(out, "{{a+b}} {{a.b()}}");
});

test("buildFitPrompt assembles prompt from profile.fit_prompt_template", () => {
  const profile = {
    id: "me",
    fit_prompt_template: "Rate fit for {{job.role}} at {{job.company}}. Focus: fintech.",
  };
  const job = { role: "Senior PM", company: "Stripe" };
  assert.equal(
    buildFitPrompt({ job, profile }),
    "Rate fit for Senior PM at Stripe. Focus: fintech."
  );
});

test("buildFitPrompt throws when template missing", () => {
  assert.throws(() => buildFitPrompt({ job: {}, profile: {} }), /fit_prompt_template/);
});

test("buildFitPrompt throws when profile missing", () => {
  assert.throws(() => buildFitPrompt({ job: {} }), /profile is required/);
});

test("buildFitPrompt tolerates undefined job fields", () => {
  const out = buildFitPrompt({
    job: {},
    profile: { fit_prompt_template: "Role: {{job.role}}." },
  });
  assert.equal(out, "Role: .");
});
