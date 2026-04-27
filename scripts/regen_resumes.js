// Regenerates all archetype DOCX and PDF files from resume_versions.json.
// Run: node scripts/regen_resumes.js [--profile jared]
//
// Reads shared_roles, shared_sections, shared_projects, shared_experience,
// certifications and versions from profiles/<id>/resume_versions.json.
// Writes to profiles/<id>/resumes/.

const fs = require("fs");
const path = require("path");
const { generateResumeDocx } = require("../engine/modules/generators/resume_docx");
const { generateResumePdf } = require("../engine/modules/generators/resume_pdf");

const args = process.argv.slice(2);
const profileIdx = args.indexOf("--profile");
const PROFILE = profileIdx !== -1 ? args[profileIdx + 1] : "jared";

const ROOT = path.join(__dirname, "..", "profiles", PROFILE);
const rvPath = path.join(ROOT, "resume_versions.json");

if (!fs.existsSync(rvPath)) {
  console.error(`resume_versions.json not found at ${rvPath}`);
  process.exit(1);
}

const rv = JSON.parse(fs.readFileSync(rvPath, "utf8"));
const outDir = path.join(ROOT, "resumes");

function buildSharedExperience(ver) {
  const roles = rv.shared_roles;
  const se = rv.shared_experience;
  return [
    {
      ...roles.credit_mentor,
      bullets: [ver.creditMentor, ...(ver.creditMentorBullets || [])],
    },
    {
      ...roles.alfa,
      bullets: ver.alfaBullets || [],
    },
    {
      ...roles.ferma,
      bullets: [se.ferma],
    },
    {
      ...roles.smmacc,
      bullets: [se.smmacc],
    },
  ];
}

async function main() {
  const { contact, shared_sections, shared_projects, certifications, versions } = rv;

  let generated = 0;
  let errors = 0;

  for (const [key, ver] of Object.entries(versions)) {
    const isPdfOnly = ver.filename && ver.filename.endsWith(".pdf");
    const stem = (ver.filename || `cv_${key}`).replace(/\.(docx|pdf)$/, "");

    const sharedExperience = buildSharedExperience(ver);

    const version = {
      title: ver.title,
      summary: ver.summary,
      skillsVariable:
        ver.skillsProduct
          ? [
              { label: "Product", value: ver.skillsProduct },
              { label: "Domain", value: ver.skillsDomain },
            ]
          : [],
    };

    const data = {
      contact,
      version,
      sharedExperience,
      sharedSections: shared_sections,
      certifications,
      projects: shared_projects,
    };

    try {
      if (!isPdfOnly) {
        await generateResumeDocx(data, path.join(outDir, `${stem}.docx`));
      }
      await generateResumePdf(data, path.join(outDir, `${stem}.pdf`));
      console.log(`✓ ${key} (${isPdfOnly ? "pdf" : "docx+pdf"})`);
      generated++;
    } catch (e) {
      console.error(`✗ ${key}: ${e.message}`);
      errors++;
    }
  }

  console.log(`\nDone: ${generated} generated, ${errors} errors`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
