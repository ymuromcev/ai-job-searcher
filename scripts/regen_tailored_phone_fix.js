// One-shot: regen tailored CVs (PDF + DOCX) overriding contact from
// profile.json so the phone is canonical (+1 (916) 261-261-9). The
// resume-tailor-mirror subagent has been silently mangling the phone
// in some rows — we override contact entirely at render time.
//
// Run: node scripts/regen_tailored_phone_fix.js

const fs = require("fs");
const path = require("path");
const { generateResumePdf } = require("../engine/modules/generators/resume_pdf_chrome.js");
const { generateResumeDocx } = require("../engine/modules/generators/resume_docx.js");

const PROFILE_ROOT = path.join(__dirname, "..", "profiles", "jared");
const profile = JSON.parse(fs.readFileSync(path.join(PROFILE_ROOT, "profile.json"), "utf8"));
const CANONICAL_CONTACT = {
  name: profile.identity.name,
  phone: profile.identity.phone, // "+1 (916) 261-261-9"
  email: profile.identity.email,
  location: profile.identity.location,
  linkedin: profile.identity.linkedin,
};

// (resultsFile, rowKey, pdfRelPath)
const JOBS = [
  [
    "prepare_results_20260526_161200.json",
    "ashby:aa511ea8-96e3-42ba-b28f-5e222170bcee",
    "resumes/tailored/Perplexity_member-of-technical-staff-forward-deploy_20260526.pdf",
  ],
  [
    "prepare_results_20260526_161200.json",
    "greenhouse:7903661",
    "resumes/tailored/Consensys_senior-product-manager-universal-kyc-met_20260526.pdf",
  ],
  [
    "prepare_results_20260526_161200.json",
    "ashby:5bb93da5-78ab-47b1-b31a-8bb7fb84fc8d",
    "resumes/tailored/Zip_ai-forward-deployed-engineer_20260526.pdf",
  ],
  [
    "prepare_results_20260526_161200.json",
    "workday:/job/San-Jose-California-United-States-of-America/Product-Manager_R0136649-1",
    "resumes/tailored/PayPal_product-manager_20260526.pdf",
  ],
  [
    "prepare_results_20260526_013123.json",
    "ashby:f25e190e-0508-4707-b575-fcaed358dc13",
    "resumes/tailored/Perplexity-2026-05-26.pdf",
  ],
];

(async () => {
  console.log("Canonical contact:", CANONICAL_CONTACT.phone);
  let ok = 0,
    fail = 0;
  for (const [resultsFile, rowKey, pdfRel] of JOBS) {
    const resultsPath = path.join(PROFILE_ROOT, resultsFile);
    const j = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
    const row = (j.results || []).find((r) => r.key === rowKey);
    if (!row || !row.tailoredResume) {
      console.error(`  ! missing tailoredResume for ${rowKey} in ${resultsFile}`);
      fail++;
      continue;
    }
    const data = { ...row.tailoredResume, contact: { ...CANONICAL_CONTACT } };
    const pdfPath = path.join(PROFILE_ROOT, pdfRel);
    const docxPath = pdfPath.replace(/\.pdf$/, ".docx");
    try {
      await generateResumePdf(data, pdfPath, { layout: "one_page" });
      await generateResumeDocx(data, docxPath);
      console.log(`  ✓ ${path.basename(pdfPath)}`);
      ok++;
    } catch (err) {
      console.error(`  ✗ ${path.basename(pdfPath)}: ${err.message}`);
      fail++;
    }
  }
  console.log(`Done: ${ok} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
