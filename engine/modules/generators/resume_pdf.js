// Pure generator: produces a PDF resume (export format) from the same normalized data
// as resume_docx.js. No profile awareness; caller supplies all data and output path.

const PDFDocument = require("pdfkit");
const fs = require("fs");

function sectionHeader(doc, text) {
  doc.moveDown(0.35);
  doc.font("Helvetica-Bold").fontSize(10).text(text);
  const y = doc.y + 1;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.75).stroke("#000000");
  doc.moveDown(0.2);
}

function roleHeader(doc, role) {
  doc.moveDown(0.15);
  doc
    .font("Helvetica-Bold")
    .fontSize(9.5)
    .text(`${role.role} \u2022 ${role.company}, ${role.location}  |  ${role.dates}`);
}

function roleDescription(doc, text) {
  doc.font("Helvetica-Oblique").fontSize(8).fillColor("#555555").text(text);
  doc.fillColor("#000000");
  doc.moveDown(0.1);
}

function bulletItem(doc, items) {
  const indent = 18;
  const left = doc.page.margins.left;
  const textX = left + indent;
  const maxW = doc.page.width - doc.page.margins.right - textX;
  const startY = doc.y;

  doc.font("Helvetica").fontSize(9).text("- ", left + 2, startY, { width: 16 });
  doc.y = startY;

  const lastIdx = items.length - 1;
  items.forEach((item, idx) => {
    const font = item.bold ? "Helvetica-Bold" : "Helvetica";
    doc.font(font).fontSize(9);
    const opts = { width: maxW, lineGap: 1, continued: idx < lastIdx };
    if (idx === 0) {
      doc.text(item.text, textX, startY, opts);
    } else {
      doc.text(item.text, opts);
    }
  });
  doc.moveDown(0.1);
  doc.x = doc.page.margins.left;
}

function renderHeader(doc, contact, versionTitle) {
  const displayName = versionTitle ? `${contact.name}, ${versionTitle}` : contact.name;
  doc.font("Helvetica-Bold").fontSize(12).text(displayName, { align: "center" });
  doc.moveDown(0.1);

  const parts = [contact.phone, contact.location, contact.email];
  if (contact.linkedin) parts.push(contact.linkedin);
  doc.font("Helvetica").fontSize(8.5).text(parts.join("  \u2022  "), { align: "center" });
  doc.moveDown(0.2);
}

function renderRole(doc, role) {
  roleHeader(doc, role);
  if (role.description) roleDescription(doc, role.description);
  for (const b of role.bullets || []) bulletItem(doc, b);
}

function renderEducation(doc, education) {
  if (!education || education.length === 0) return;
  sectionHeader(doc, "EDUCATION");
  education.forEach((e, i) => {
    if (i > 0) doc.moveDown(0.15);
    doc.font("Helvetica-Bold").fontSize(9).text(`${e.degree}  |  ${e.dates}`);
    doc.font("Helvetica").fontSize(8).fillColor("#555555").text(e.school);
    doc.fillColor("#000000");
  });
}

function renderCertifications(doc, certs) {
  if (!certs || certs.length === 0) return;
  sectionHeader(doc, "CERTIFICATIONS");
  certs.forEach((c, i) => {
    if (i > 0) doc.moveDown(0.15);
    doc.font("Helvetica-Bold").fontSize(9).text(`${c.name}  |  ${c.displayDate || c.date || ""}`);
    doc.font("Helvetica").fontSize(8).fillColor("#555555").text(c.issuer);
    doc.fillColor("#000000");
  });
}

function skillLine(doc, label, value) {
  doc.font("Helvetica-Bold").fontSize(8.5).text(`${label}: `, { continued: true });
  doc.font("Helvetica").fontSize(8.5).text(value);
  doc.moveDown(0.02);
}

function renderSkills(doc, skills) {
  if (!skills || skills.length === 0) return;
  sectionHeader(doc, "SKILLS & TOOLS");
  for (const s of skills) skillLine(doc, s.label, s.value);
}

function renderProjects(doc, projects) {
  if (!projects || projects.length === 0) return;
  sectionHeader(doc, "PERSONAL PROJECTS");
  projects.forEach((p, i) => {
    if (i > 0) doc.moveDown(0.15);
    const header = p.url ? `${p.name}  |  ${p.dates}  \u2022  ${p.url}` : `${p.name}  |  ${p.dates}`;
    doc.font("Helvetica-Bold").fontSize(9).text(header);
    if (p.description) {
      doc.font("Helvetica").fontSize(8.5).text(p.description, { lineGap: 1 });
    }
    for (const b of p.bullets || []) bulletItem(doc, b);
  });
}

function generateResumePdf(
  { contact, version, sharedExperience, sharedSections, certifications, projects },
  outputPath
) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 30, right: 40, bottom: 30, left: 40 },
    });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    renderHeader(doc, contact, version.title);

    sectionHeader(doc, "SUMMARY");
    doc.font("Helvetica").fontSize(9).text(version.summary, { lineGap: 1 });

    sectionHeader(doc, "PROFESSIONAL EXPERIENCE");
    const experience = [...(version.experienceOverride || []), ...(sharedExperience || [])];
    for (const r of experience) renderRole(doc, r);

    renderProjects(doc, projects);
    renderEducation(doc, sharedSections && sharedSections.education);
    renderCertifications(doc, certifications);

    const skills = [
      ...((sharedSections && sharedSections.skillsFixed) || []),
      ...(version.skillsVariable || []),
    ];
    renderSkills(doc, skills);

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

module.exports = { generateResumePdf };
