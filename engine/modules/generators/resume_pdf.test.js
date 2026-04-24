const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { generateResumePdf } = require("./resume_pdf.js");

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
