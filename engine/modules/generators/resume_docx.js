// Pure generator: produces a DOCX resume from a normalized data object.
// No profile awareness. Caller supplies all data and the output path.
//
// Input schema (see rfc/001 for the full contract):
//   contact: { name, phone, email, location, linkedin? }
//   version: { title?, summary, experienceOverride?, skillsVariable? }
//   sharedExperience?: [ { role, company, location, dates, description?, bullets } ]
//   sharedSections?: { skillsFixed?: [{label, value}], education?: [{degree, school, dates}] }
//   certifications?: [ { name, issuer, displayDate? | date } ]
//
// Bullets are rich-text segments: [{ text, bold? }].

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  LevelFormat,
  ExternalHyperlink,
  BorderStyle,
} = require("docx");
const fs = require("fs");

function makeRuns(items) {
  return items.map(
    (i) => new TextRun({ text: i.text, bold: i.bold || false, font: "Arial", size: 20 })
  );
}

function sectionHeader(text) {
  return new Paragraph({
    spacing: { before: 280, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "000000", space: 4 } },
    children: [new TextRun({ text, bold: true, font: "Arial", size: 24 })],
  });
}

function roleHeader(role) {
  return new Paragraph({
    spacing: { before: 200, after: 0 },
    children: [
      new TextRun({
        text: `${role.role} \u2022 ${role.company}, ${role.location}`,
        bold: true,
        font: "Arial",
        size: 20,
      }),
      new TextRun({ text: `  |  ${role.dates}`, bold: true, font: "Arial", size: 20 }),
    ],
  });
}

function roleDescription(text) {
  return new Paragraph({
    spacing: { before: 20, after: 60 },
    children: [new TextRun({ text, italics: true, font: "Arial", size: 18, color: "555555" })],
  });
}

function bulletParagraph(items) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { before: 40, after: 40 },
    children: makeRuns(items),
  });
}

function roleBlock(role) {
  const out = [roleHeader(role)];
  if (role.description) out.push(roleDescription(role.description));
  for (const b of role.bullets || []) out.push(bulletParagraph(b));
  return out;
}

function headerBlock(contact, versionTitle) {
  const displayName = versionTitle ? `${contact.name}, ${versionTitle}` : contact.name;
  const contactChildren = [
    new TextRun({ text: `${contact.phone} \u2022 ${contact.location} \u2022 `, font: "Arial", size: 18 }),
    new ExternalHyperlink({
      children: [new TextRun({ text: contact.email, style: "Hyperlink", font: "Arial", size: 18 })],
      link: `mailto:${contact.email}`,
    }),
  ];
  if (contact.linkedin) {
    contactChildren.push(new TextRun({ text: " \u2022 ", font: "Arial", size: 18 }));
    contactChildren.push(
      new ExternalHyperlink({
        children: [
          new TextRun({ text: contact.linkedin, style: "Hyperlink", font: "Arial", size: 18 }),
        ],
        link: `https://${contact.linkedin}`,
      })
    );
  }

  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [new TextRun({ text: displayName, bold: true, font: "Arial", size: 26 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: contactChildren,
    }),
  ];
}

function educationBlock(education) {
  if (!education || education.length === 0) return [];
  const out = [sectionHeader("EDUCATION")];
  education.forEach((e, i) => {
    out.push(
      new Paragraph({
        spacing: { before: i === 0 ? 100 : 120 },
        children: [
          new TextRun({ text: e.degree, bold: true, font: "Arial", size: 20 }),
          new TextRun({ text: `  |  ${e.dates}`, bold: true, font: "Arial", size: 20 }),
        ],
      })
    );
    out.push(
      new Paragraph({
        spacing: { before: 20, after: 60 },
        children: [new TextRun({ text: e.school, font: "Arial", size: 18, color: "555555" })],
      })
    );
  });
  return out;
}

function certificationBlock(certs) {
  if (!certs || certs.length === 0) return [];
  const out = [sectionHeader("CERTIFICATIONS")];
  certs.forEach((c, i) => {
    out.push(
      new Paragraph({
        spacing: { before: i === 0 ? 100 : 120 },
        children: [
          new TextRun({ text: c.name, bold: true, font: "Arial", size: 20 }),
          new TextRun({
            text: `  |  ${c.displayDate || c.date || ""}`,
            bold: true,
            font: "Arial",
            size: 20,
          }),
        ],
      })
    );
    out.push(
      new Paragraph({
        spacing: { before: 20, after: 60 },
        children: [new TextRun({ text: c.issuer, font: "Arial", size: 18, color: "555555" })],
      })
    );
  });
  return out;
}

function skillsBlock(skills) {
  if (!skills || skills.length === 0) return [];
  const out = [sectionHeader("SKILLS & TOOLS")];
  skills.forEach((s, i) => {
    out.push(
      new Paragraph({
        spacing: { before: i === 0 ? 80 : 40, after: 40 },
        children: [
          new TextRun({ text: `${s.label}: `, bold: true, font: "Arial", size: 19 }),
          new TextRun({ text: s.value, font: "Arial", size: 19 }),
        ],
      })
    );
  });
  return out;
}

function buildDocument({ contact, version, sharedExperience, sharedSections, certifications }) {
  const experience = [...(version.experienceOverride || []), ...(sharedExperience || [])];
  const skills = [
    ...((sharedSections && sharedSections.skillsFixed) || []),
    ...(version.skillsVariable || []),
  ];
  const education = (sharedSections && sharedSections.education) || [];

  const children = [
    ...headerBlock(contact, version.title),
    sectionHeader("SUMMARY"),
    new Paragraph({
      spacing: { before: 60, after: 60 },
      children: [new TextRun({ text: version.summary, font: "Arial", size: 20 })],
    }),
    sectionHeader("PROFESSIONAL EXPERIENCE"),
    ...experience.flatMap(roleBlock),
    ...educationBlock(education),
    ...certificationBlock(certifications),
    ...skillsBlock(skills),
  ];

  return new Document({
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "\u25CB",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 540, hanging: 270 } } },
            },
          ],
        },
      ],
    },
    styles: { default: { document: { run: { font: "Arial", size: 20 } } } },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 720, right: 900, bottom: 720, left: 900 },
          },
        },
        children,
      },
    ],
  });
}

async function generateResumeDocx(data, outputPath) {
  const doc = buildDocument(data);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

module.exports = { generateResumeDocx };
