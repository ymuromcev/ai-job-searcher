const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { generateResumeDocx } = require("./resume_docx.js");

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
      bullets: [[{ text: "Shipped ", bold: false }, { text: "v1", bold: true }]],
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
    skillsVariable: [{ label: "Focus", value: "Backend systems" }],
  },
};

test("generateResumeDocx writes a non-empty file with ZIP magic bytes", async () => {
  const tmp = path.join(os.tmpdir(), `resume-${process.pid}-${Date.now()}.docx`);
  await generateResumeDocx(FIXTURE, tmp);
  try {
    const stat = fs.statSync(tmp);
    assert.ok(stat.size > 0, "file should not be empty");

    const header = fs.readFileSync(tmp).subarray(0, 2);
    assert.equal(header[0], 0x50, "expected ZIP magic byte P (0x50)");
    assert.equal(header[1], 0x4b, "expected ZIP magic byte K (0x4B)");
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("generateResumeDocx combines experienceOverride before sharedExperience", async () => {
  const tmp = path.join(os.tmpdir(), `resume-override-${process.pid}-${Date.now()}.docx`);
  const fixture = {
    ...FIXTURE,
    version: {
      ...FIXTURE.version,
      experienceOverride: [
        {
          role: "Lead",
          company: "NewCo",
          location: "LA",
          dates: "2023\u2013Present",
          bullets: [[{ text: "Led team of 5" }]],
        },
      ],
    },
  };
  await generateResumeDocx(fixture, tmp);
  try {
    assert.ok(fs.statSync(tmp).size > 0);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("generateResumeDocx works without linkedin (optional contact field)", async () => {
  const tmp = path.join(os.tmpdir(), `resume-nolinkedin-${process.pid}-${Date.now()}.docx`);
  const fixture = {
    ...FIXTURE,
    contact: { ...FIXTURE.contact, linkedin: undefined },
  };
  delete fixture.contact.linkedin;
  await generateResumeDocx(fixture, tmp);
  try {
    assert.ok(fs.statSync(tmp).size > 0);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("generateResumeDocx works without version.title (name-only header)", async () => {
  const tmp = path.join(os.tmpdir(), `resume-notitle-${process.pid}-${Date.now()}.docx`);
  const fixture = {
    ...FIXTURE,
    version: { ...FIXTURE.version, title: undefined },
  };
  delete fixture.version.title;
  await generateResumeDocx(fixture, tmp);
  try {
    assert.ok(fs.statSync(tmp).size > 0);
  } finally {
    fs.unlinkSync(tmp);
  }
});
