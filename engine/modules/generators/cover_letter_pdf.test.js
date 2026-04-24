const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { generateCoverLetterPdf } = require("./cover_letter_pdf.js");

test("generateCoverLetterPdf writes a non-empty file with %PDF magic bytes", async () => {
  const tmp = path.join(os.tmpdir(), `cl-${process.pid}-${Date.now()}.pdf`);
  await generateCoverLetterPdf(
    {
      paragraphs: [
        "Dear Hiring Manager,",
        "I am writing to apply for the Senior PM role.",
        "Sincerely, Test User",
      ],
    },
    tmp
  );
  try {
    const stat = fs.statSync(tmp);
    assert.ok(stat.size > 0, "file should not be empty");

    const header = fs.readFileSync(tmp, "utf8").slice(0, 4);
    assert.equal(header, "%PDF");
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("generateCoverLetterPdf rejects on empty paragraphs", async () => {
  const tmp = path.join(os.tmpdir(), `cl-empty-${process.pid}-${Date.now()}.pdf`);
  await assert.rejects(
    () => generateCoverLetterPdf({ paragraphs: [] }, tmp),
    /non-empty array/
  );
});

test("generateCoverLetterPdf rejects on missing paragraphs", async () => {
  const tmp = path.join(os.tmpdir(), `cl-missing-${process.pid}-${Date.now()}.pdf`);
  await assert.rejects(
    () => generateCoverLetterPdf({}, tmp),
    /non-empty array/
  );
});
