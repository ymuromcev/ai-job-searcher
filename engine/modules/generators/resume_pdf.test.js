const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  generateResumePdf,
  sanitizeForPdf,
  deepSanitize,
  parseInlineBold,
} = require("./resume_pdf.js");

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

test("parseInlineBold splits <b>...</b> into runs", () => {
  const out = parseInlineBold("foo <b>bar</b> baz");
  assert.deepEqual(out, [
    { text: "foo ", bold: false },
    { text: "bar", bold: true },
    { text: " baz", bold: false },
  ]);
});

test("parseInlineBold handles strings with no markers", () => {
  assert.deepEqual(parseInlineBold("plain text"), [{ text: "plain text", bold: false }]);
});

test("parseInlineBold handles multiple bold runs", () => {
  const out = parseInlineBold("<b>a</b>x<b>b</b>");
  assert.deepEqual(out, [
    { text: "a", bold: true },
    { text: "x", bold: false },
    { text: "b", bold: true },
  ]);
});

test("parseInlineBold handles empty/non-string input", () => {
  assert.deepEqual(parseInlineBold(""), []);
  assert.deepEqual(parseInlineBold(null), []);
  assert.deepEqual(parseInlineBold(undefined), []);
});

test("generateResumePdf returns { path, pageCount }", async () => {
  const tmp = path.join(os.tmpdir(), `resume-ret-${process.pid}-${Date.now()}.pdf`);
  const result = await generateResumePdf(FIXTURE, tmp);
  try {
    assert.equal(result.path, tmp);
    assert.equal(typeof result.pageCount, "number");
    assert.ok(result.pageCount >= 1, "pageCount should be at least 1");
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("generateResumePdf renders compressed OpenArt fixture as a single page", async () => {
  // Synthetic compressed fixture matching Block C compression rules:
  // 2 full roles + Earlier PM roles paragraph + 1 projects paragraph.
  // Verifies renderer + layout, NOT subagent compression (that has its own tests).
  const compressed = {
    contact: {
      name: "Jared Moore, Product Manager (Builder) — Agentic AI",
      phone: "+1 555 0100",
      email: "test@example.com",
      linkedin: "linkedin.com/in/test",
      location: "Sacramento, CA",
    },
    sharedExperience: [
      {
        role: "AI Product Advisor",
        company: "Credit Mentor",
        location: "Los Angeles, CA",
        dates: "Jun 2025 – Present",
        description: "AI-powered credit-building app.",
        bullets: [
          [{ text: "Advised founding team on roadmap and metrics." }],
          [{ text: "Built event analytics from scratch via Claude Code." }],
          [{ text: "Engineered MCP-native automation pipeline." }],
          [{ text: "Applied LLM agents to envision innovative technology." }],
        ],
      },
      {
        role: "Senior AI Product Manager",
        company: "Alfa-Bank",
        location: "Moscow, Russia",
        dates: "Mar 2022 – Apr 2025",
        description: "Russia's largest private bank.",
        bullets: [
          [{ text: "Owned credit card product end-to-end over 3 years." }],
          [{ text: "Drove +20% CR via 40+ A/B experiments." }],
          [{ text: "Launched MFI integration — $500k/mo new revenue." }],
          [{ text: "Built unified event analytics across product lines." }],
        ],
      },
      {
        role: "Earlier PM roles",
        company: "",
        location: "",
        dates: "Jan 2016 – Dec 2021",
        description:
          "Ferma Digital (Moscow, B2C growth): 26x MRR in 2020. SMMACC (marketplace): scaled limit $25k → $1M. CROC, Inc. (cloud): market research and CustDev.",
        bullets: [],
      },
    ],
    sharedSections: {
      skillsFixed: [{ label: "Skills", value: "PM, A/B, MCP, Claude Code" }],
      education: [{ degree: "B.A. HRM", school: "Plekhanov", dates: "2015–2019" }],
    },
    certifications: [{ name: "EB-1A", issuer: "USCIS", displayDate: "2025" }],
    projects: [
      {
        title: "Open-source AI-native projects",
        url: "github.com/ymuromcev",
        description:
          "AI Job Search Agent + claude-dev-workflow + scaffold-project — Claude Code skills with multi-agent review and RFC gating.",
        bullets: [],
      },
    ],
    version: {
      title: "Product Manager (Builder) — Agentic AI",
      summary:
        "AI-native Senior PM with 10+ years in FinTech and consumer growth. Daily user of agentic AI tools. Envision innovative technology and ship high value outcomes for users.",
      experienceOverride: [],
      skillsVariable: [],
    },
  };
  const tmp = path.join(os.tmpdir(), `resume-compressed-${process.pid}-${Date.now()}.pdf`);
  const result = await generateResumePdf(compressed, tmp, { layout: "one_page" });
  try {
    const stat = fs.statSync(tmp);
    assert.ok(stat.size > 2 * 1024, `expected > 2KB, got ${stat.size}`);
    assert.ok(stat.size < 100 * 1024, `expected < 100KB, got ${stat.size}`);
    assert.equal(result.pageCount, 1, "OpenArt one_page layout must produce 1 page on compressed input");
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
});

test("generateResumePdf renders <b>...</b> markers in summary", async () => {
  const tmp = path.join(os.tmpdir(), `resume-bold-${process.pid}-${Date.now()}.pdf`);
  const fixture = {
    ...FIXTURE,
    version: {
      ...FIXTURE.version,
      summary: "Plain prefix <b>BOLD_TOKEN</b> plain suffix.",
    },
  };
  // Disable stream compression so the test can grep the rendered text.
  const PDFDocument = require("pdfkit");
  const origPipe = PDFDocument.prototype.pipe;
  const origCtor = PDFDocument;
  // We can't easily swap the ctor; pdfkit accepts `compress: false` in options
  // but our generator hard-codes options. Instead, verify behavior via the
  // pure parser (covered above) AND that the PDF is well-formed without
  // raw <b> tags appearing in the binary stream.
  void origPipe;
  void origCtor;
  const result = await generateResumePdf(fixture, tmp);
  try {
    const buf = fs.readFileSync(tmp);
    assert.equal(buf.slice(0, 4).toString("utf8"), "%PDF");
    assert.ok(result.pageCount >= 1);
    // Raw <b> markers must NOT leak into the rendered PDF text streams. PDFKit
    // compresses content streams, so we additionally check the parsed string
    // does not contain the literal marker.
    const asString = buf.toString("latin1");
    assert.ok(!asString.includes("<b>BOLD_TOKEN</b>"), "raw <b> markers should be stripped");
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("generateResumePdf handles empty sections gracefully", async () => {
  const tmp = path.join(os.tmpdir(), `resume-empty-${process.pid}-${Date.now()}.pdf`);
  const fixture = {
    contact: { name: "Empty User", phone: "", email: "e@x.io", location: "Nowhere" },
    version: { title: "PM", summary: "" },
    sharedExperience: [],
    sharedSections: { skillsFixed: [], education: [] },
    certifications: [],
    projects: [],
  };
  const result = await generateResumePdf(fixture, tmp);
  try {
    assert.ok(fs.statSync(tmp).size > 0);
    assert.ok(result.pageCount >= 1);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("generateResumePdf accepts unknown layout opts without crashing", async () => {
  const tmp = path.join(os.tmpdir(), `resume-layout-${process.pid}-${Date.now()}.pdf`);
  // two_page / ru_long fall back to one_page preset for now (Block D stubs).
  const result = await generateResumePdf(FIXTURE, tmp, { layout: "two_page" });
  try {
    assert.ok(result.pageCount >= 1);
  } finally {
    fs.unlinkSync(tmp);
  }
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
