const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { generateResumePdf, sanitizeForPdf, deepSanitize } = require("./resume_pdf.js");

const FIXTURE = {
  contact: {
    name: "Test User",
    phone: "+1 555 0100",
    email: "test@example.com",
    linkedin: "linkedin.com/in/test",
    location: "San Francisco, CA",
  },
  sharedExperience: [
    {
      role: "Engineer",
      company: "ACME",
      location: "Remote",
      dates: "2020\u20132022",
      description: "Built stuff",
      bullets: [[{ text: "Shipped v1" }]],
    },
  ],
  sharedSections: {
    skillsFixed: [{ label: "Languages", value: "TypeScript | Python" }],
    education: [{ degree: "BS CS", school: "MIT", dates: "2018\u20132022" }],
  },
  certifications: [{ name: "PMP", issuer: "PMI", displayDate: "Jan 2023" }],
  version: {
    title: "Senior Engineer",
    summary: "Test summary.",
    experienceOverride: [],
    skillsVariable: [{ label: "Focus", value: "Backend" }],
  },
};

test("generateResumePdf writes a non-empty file with %PDF magic bytes", async () => {
  const tmp = path.join(os.tmpdir(), `resume-${process.pid}-${Date.now()}.pdf`);
  await generateResumePdf(FIXTURE, tmp);
  try {
    const stat = fs.statSync(tmp);
    assert.ok(stat.size > 0, "file should not be empty");

    const header = fs.readFileSync(tmp, "utf8").slice(0, 4);
    assert.equal(header, "%PDF", "expected PDF magic bytes at start of file");
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("generateResumePdf works with no certifications and no experienceOverride", async () => {
  const tmp = path.join(os.tmpdir(), `resume-min-${process.pid}-${Date.now()}.pdf`);
  const fixture = { ...FIXTURE, certifications: [] };
  await generateResumePdf(fixture, tmp);
  try {
    assert.ok(fs.statSync(tmp).size > 0);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("generateResumePdf works without linkedin", async () => {
  const tmp = path.join(os.tmpdir(), `resume-nolinkedin-${process.pid}-${Date.now()}.pdf`);
  const fixture = { ...FIXTURE, contact: { ...FIXTURE.contact } };
  delete fixture.contact.linkedin;
  await generateResumePdf(fixture, tmp);
  try {
    assert.ok(fs.statSync(tmp).size > 0);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("sanitizeForPdf swaps unicode arrows for ASCII fallbacks", () => {
  assert.equal(sanitizeForPdf("User interviews → new features"), "User interviews -> new features");
  assert.equal(sanitizeForPdf("patient ↔ provider ↔ payer"), "patient <-> provider <-> payer");
  assert.equal(sanitizeForPdf("a ← b"), "a <- b");
  assert.equal(sanitizeForPdf("a ⇒ b"), "a => b");
});

test("sanitizeForPdf preserves safe unicode (em-dash, bullet, multiplication)", () => {
  assert.equal(sanitizeForPdf("a — b"), "a — b");
  assert.equal(sanitizeForPdf("a • b"), "a • b");
  assert.equal(sanitizeForPdf("2 × faster"), "2 × faster");
});

test("sanitizeForPdf handles non-string inputs", () => {
  assert.equal(sanitizeForPdf(42), 42);
  assert.equal(sanitizeForPdf(null), null);
  assert.equal(sanitizeForPdf(undefined), undefined);
});

test("deepSanitize walks nested object/array structures", () => {
  const input = {
    a: "x → y",
    b: ["p ↔ q", { c: "r → s" }],
    d: { e: { f: "no-arrows" } },
    g: 42,
    h: null,
  };
  const out = deepSanitize(input);
  assert.equal(out.a, "x -> y");
  assert.equal(out.b[0], "p <-> q");
  assert.equal(out.b[1].c, "r -> s");
  assert.equal(out.d.e.f, "no-arrows");
  assert.equal(out.g, 42);
  assert.equal(out.h, null);
  // Input unchanged (no mutation)
  assert.equal(input.a, "x → y");
});

test("generateResumePdf sanitizes arrows in bullet text", async () => {
  const tmp = path.join(os.tmpdir(), `resume-arrows-${process.pid}-${Date.now()}.pdf`);
  const fixture = {
    ...FIXTURE,
    sharedExperience: [
      {
        ...FIXTURE.sharedExperience[0],
        bullets: [[{ text: "User interviews → new features" }]],
      },
    ],
  };
  await generateResumePdf(fixture, tmp);
  try {
    // PDF should render without throwing on the unsupported glyph.
    // We don't decode the PDF binary; the existence + non-empty size + %PDF magic
    // is the smoke check. Sanitization is verified by the unit tests above.
    const stat = fs.statSync(tmp);
    assert.ok(stat.size > 0);
    assert.equal(fs.readFileSync(tmp, "utf8").slice(0, 4), "%PDF");
  } finally {
    fs.unlinkSync(tmp);
  }
});
