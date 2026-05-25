// Pure generator: produces a PDF resume in OpenArt-style 1-page dense layout
// (BL-126 Block B). Same normalized data as resume_docx.js. No profile awareness.
//
// Layout reference: docs/resume_openart_reference.html (mirrors the CSS values
// pixel-by-pixel below). Page: Letter, margins 0.4in × 0.55in. Body 9.3pt,
// line-height 1.22. Header all-caps bold 12.5pt centered. Section headers
// UPPERCASE bold 10pt with a 1pt horizontal underline. Dash-bullets with
// hanging indent. Skills as a prose paragraph, not bullets.

const PDFDocument = require("pdfkit");
const fs = require("fs");

// PDFKit's built-in Helvetica uses WinAnsi encoding (Latin-1 + a few extras),
// which lacks several Unicode chars used in our content (arrows in particular).
// Without sanitization they render as mojibake (e.g., `→` → `!'`).
// We swap them to ASCII fallbacks at render time; the source JSON stays
// Unicode-clean so DOCX (which embeds full Unicode fonts) renders correctly.
const PDF_CHAR_FALLBACKS = {
  "→": "->", // → rightwards arrow
  "↔": "<->", // ↔ left-right arrow
  "←": "<-", // ← leftwards arrow
  "⇒": "=>", // ⇒ rightwards double arrow
};

function sanitizeForPdf(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const [from, to] of Object.entries(PDF_CHAR_FALLBACKS)) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

function deepSanitize(value) {
  if (typeof value === "string") return sanitizeForPdf(value);
  if (Array.isArray(value)) return value.map(deepSanitize);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = deepSanitize(value[k]);
    return out;
  }
  return value;
}

// ---------- one_page preset (OpenArt-style dense layout) ----------

const PRESETS = {
  one_page: {
    margins: { top: 28.8, right: 39.6, bottom: 28.8, left: 39.6 }, // 0.4in × 0.55in
    body: { font: "Helvetica", size: 9.3 },
    bodyBold: { font: "Helvetica-Bold", size: 9.3 },
    lineGap: 2.05, // 9.3pt * (1.22 - 1) ≈ 2.05pt
    headerTitle: { font: "Helvetica-Bold", size: 12.5 },
    contact: { font: "Helvetica", size: 8.8 },
    sectionHeader: { font: "Helvetica-Bold", size: 10 },
    roleLine: { font: "Helvetica-Bold", size: 9.5 },
    roleTag: { font: "Helvetica-Oblique", size: 8.8, color: "#333333" },
    bullet: { indent: 12, hang: 8 }, // padding-left 12 (li), text-indent -8
    paraGap: 1, // very tight inter-paragraph gap
    sectionTopGap: 4,
    sectionBottomGap: 2,
    underlineOffset: 1,
    underlineWidth: 1,
  },
};

function resolvePreset(opts) {
  const name = (opts && opts.layout) || "one_page";
  // Block D may pass two_page or ru_long; for now they fall back to one_page
  // (correct visual style, just not yet pagination-tuned).
  return PRESETS[name] || PRESETS.one_page;
}

// ---------- Inline <b>...</b> parser ----------
// Splits "foo <b>bar</b> baz" into [{text:"foo ",bold:false},
// {text:"bar",bold:true},{text:" baz",bold:false}].
function parseInlineBold(str) {
  if (typeof str !== "string") return [];
  const out = [];
  let i = 0;
  const re = /<b>([\s\S]*?)<\/b>/gi;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m.index > i) out.push({ text: str.slice(i, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    i = m.index + m[0].length;
  }
  if (i < str.length) out.push({ text: str.slice(i), bold: false });
  return out;
}

// Normalize a string-or-runs into a runs array.
function asRuns(value) {
  if (Array.isArray(value)) return value;
  return parseInlineBold(value || "");
}

// ---------- Low-level rendering helpers ----------

function drawRuns(doc, runs, preset, opts = {}) {
  // Render an array of {text, bold} runs as one continuous text block.
  // `opts` is passed to pdfkit text() on the first run (e.g. x/y/width).
  const lastIdx = runs.length - 1;
  if (lastIdx < 0) {
    // Nothing to draw — emit a no-op newline-equivalent so y advances minimally.
    return;
  }
  runs.forEach((run, idx) => {
    const f = run.bold ? preset.bodyBold.font : preset.body.font;
    doc.font(f).fontSize(preset.body.size);
    const textOpts = { lineGap: preset.lineGap, ...opts, continued: idx < lastIdx };
    if (idx === 0) {
      doc.text(run.text || "", textOpts);
    } else {
      // After the first run, omit x/y so pdfkit continues inline.
      const { width } = textOpts;
      const continuationOpts = { lineGap: preset.lineGap, continued: idx < lastIdx };
      if (width != null) continuationOpts.width = width;
      doc.text(run.text || "", continuationOpts);
    }
  });
}

function sectionHeader(doc, text, preset) {
  doc.moveDown(0);
  // Modest top gap, computed manually so we hit the dense rhythm.
  doc.y += preset.sectionTopGap;
  doc.font(preset.sectionHeader.font).fontSize(preset.sectionHeader.size).fillColor("#111111");
  doc.text(text.toUpperCase(), { lineGap: 0 });
  const y = doc.y + preset.underlineOffset;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  doc
    .moveTo(left, y)
    .lineTo(right, y)
    .lineWidth(preset.underlineWidth)
    .stroke("#111111");
  doc.y = y + preset.sectionBottomGap;
  doc.fillColor("#111111");
}

function renderHeader(doc, contact, versionTitle, preset) {
  const name = (contact.name || "").toString();
  const title = (versionTitle || "").toString();
  const displayName = (title ? `${name}, ${title}` : name).toUpperCase();
  doc.font(preset.headerTitle.font).fontSize(preset.headerTitle.size).fillColor("#111111");
  doc.text(displayName, { align: "center", lineGap: 0, characterSpacing: 0.3 });
  doc.y += 1;

  const parts = [contact.phone, contact.location, contact.email].filter(Boolean);
  if (contact.linkedin) parts.push(contact.linkedin);
  doc.font(preset.contact.font).fontSize(preset.contact.size).fillColor("#222222");
  doc.text(parts.join(" • "), { align: "center", lineGap: 0 });
  doc.fillColor("#111111");
  doc.y += 2;
}

function renderSummary(doc, summary, preset) {
  if (!summary) return;
  sectionHeader(doc, "Summary", preset);
  drawRuns(doc, asRuns(summary), preset);
}

function roleHeader(doc, role, preset) {
  doc.y += 2; // .role { margin-top: 2px }
  doc.font(preset.roleLine.font).fontSize(preset.roleLine.size).fillColor("#111111");
  const head = `${role.role} • ${role.company}${role.location ? ", " + role.location : ""}  |  ${role.dates || ""}`;
  doc.text(head, { lineGap: preset.lineGap });
  if (role.description) {
    doc
      .font(preset.roleTag.font)
      .fontSize(preset.roleTag.size)
      .fillColor(preset.roleTag.color);
    doc.text(role.description, { lineGap: preset.lineGap });
    doc.fillColor("#111111");
  }
}

function renderBullet(doc, runs, preset) {
  const indent = preset.bullet.indent;
  const hang = preset.bullet.hang;
  const left = doc.page.margins.left;
  const textX = left + indent;
  const width = doc.page.width - doc.page.margins.right - textX;
  const startY = doc.y;

  // Draw dash at hanging position (textX - hang).
  doc.font(preset.body.font).fontSize(preset.body.size).fillColor("#111111");
  doc.text("- ", textX - hang, startY, { width: hang, lineGap: preset.lineGap, continued: false });
  doc.y = startY;

  drawRuns(doc, runs, preset, { x: textX, y: startY, width });
  // Reset x to left margin so subsequent block-level text isn't indented.
  doc.x = left;
}

function renderRole(doc, role, preset) {
  roleHeader(doc, role, preset);
  for (const b of role.bullets || []) {
    renderBullet(doc, asRuns(b), preset);
  }
}

function renderExperience(doc, experience, preset) {
  if (!experience || experience.length === 0) return;
  sectionHeader(doc, "Professional Experience", preset);
  for (const r of experience) renderRole(doc, r, preset);
}

function renderProjects(doc, projects, preset) {
  if (!projects || projects.length === 0) return;
  sectionHeader(doc, "Personal Projects", preset);
  projects.forEach((p, i) => {
    if (i > 0) doc.y += 2;
    const headParts = [p.name];
    if (p.dates) headParts.push(p.dates);
    if (p.url) headParts.push(p.url);
    doc
      .font(preset.roleLine.font)
      .fontSize(preset.roleLine.size)
      .fillColor("#111111")
      .text(headParts.join("  |  "), { lineGap: preset.lineGap });
    if (p.description) {
      drawRuns(doc, asRuns(p.description), preset);
    }
    for (const b of p.bullets || []) {
      renderBullet(doc, asRuns(b), preset);
    }
  });
}

function renderEducation(doc, education, preset) {
  if (!education || education.length === 0) return;
  sectionHeader(doc, "Education", preset);
  education.forEach((e, i) => {
    if (i > 0) doc.y += 1;
    const runs = [
      { text: `${e.degree}  |  ${e.dates || ""}  |  `, bold: true },
      { text: e.school || "", bold: false },
    ];
    drawRuns(doc, runs, preset);
  });
}

function renderCertifications(doc, certs, preset) {
  if (!certs || certs.length === 0) return;
  sectionHeader(doc, "Certifications", preset);
  certs.forEach((c, i) => {
    if (i > 0) doc.y += 1;
    const date = c.displayDate || c.date || "";
    const runs = [
      { text: `${c.name}  |  ${date}  |  `, bold: true },
      { text: c.issuer || "", bold: false },
    ];
    drawRuns(doc, runs, preset);
  });
}

function renderSkills(doc, skills, preset) {
  if (!skills || skills.length === 0) return;
  sectionHeader(doc, "Skills & Tools", preset);
  // Prose-style: concatenate all skill groups into one paragraph,
  // joined by ". " for visual rhythm matching the HTML reference.
  const pieces = skills
    .map((s) => (s && s.value ? s.value.trim().replace(/\.+$/, "") : ""))
    .filter(Boolean);
  const paragraph = pieces.join(". ") + (pieces.length ? "." : "");
  drawRuns(doc, asRuns(paragraph), preset);
}

// ---------- Main entry ----------

function generateResumePdf(rawData, outputPath, opts = {}) {
  const data = deepSanitize(rawData) || {};
  const contact = data.contact || {};
  const version = data.version || {};
  const sharedExperience = data.sharedExperience || [];
  const sharedSections = data.sharedSections || {};
  const certifications = data.certifications || [];
  const projects = data.projects || [];
  const preset = resolvePreset(opts);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: preset.margins,
      // bufferPages keeps all pages in memory so bufferedPageRange().count
      // accurately reflects the total page count after the document is built.
      bufferPages: true,
    });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    renderHeader(doc, contact, version.title, preset);
    renderSummary(doc, version.summary, preset);

    const experience = [...(version.experienceOverride || []), ...sharedExperience];
    renderExperience(doc, experience, preset);

    renderProjects(doc, projects, preset);
    renderEducation(doc, sharedSections.education, preset);
    renderCertifications(doc, certifications, preset);

    const skills = [
      ...(sharedSections.skillsFixed || []),
      ...(version.skillsVariable || []),
    ];
    renderSkills(doc, skills, preset);

    // Capture page count BEFORE end() since bufferedPageRange resets after flush.
    const pageCount = doc.bufferedPageRange().count;
    doc.end();
    stream.on("finish", () => resolve({ path: outputPath, pageCount }));
    stream.on("error", reject);
  });
}

module.exports = {
  generateResumePdf,
  sanitizeForPdf,
  deepSanitize,
  parseInlineBold,
};
