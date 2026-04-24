// Pure generator: produces a cover letter PDF from an array of paragraphs.
// No profile awareness, no file path parsing; caller supplies paragraphs + output path.
//
// Input schema:
//   paragraphs: string[]  — rendered in order with spacing between them

const PDFDocument = require("pdfkit");
const fs = require("fs");

function generateCoverLetterPdf({ paragraphs }, outputPath) {
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) {
    return Promise.reject(new Error("paragraphs must be a non-empty array of strings"));
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 72, right: 72, bottom: 72, left: 72 },
    });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    doc.font("Helvetica").fontSize(11);

    paragraphs.forEach((text, i) => {
      if (i > 0) doc.moveDown(0.8);
      doc.text(text, { lineGap: 3 });
    });

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

module.exports = { generateCoverLetterPdf };
