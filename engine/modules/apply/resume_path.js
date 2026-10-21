// Resolve the resume / cover-letter PDF to attach for a TSV row (RFC 068 §1).
//
// `resume_ver` holds one of:
//   - a relative path under the profile root for a tailored resume
//     ("resumes/tailored/<company>_<role>_<date>.pdf", or a .docx whose PDF
//     sibling was rendered next to it; archived rows: "cv/archive/…pdf");
//   - an archetype key from resume_versions.json ("AI_Platform"), whose
//     rendered PDF is <resume.output_dir>/<versions[key].filename as .pdf>,
//     conventionally "resumes/CV_<First>_<Last>_<Key>.pdf".
//
// `cl_path` is a relative path under the profile root (PDF).
//
// Pure apart from the injected `exists(absPath)`.

const path = require("path");

function toPdf(p) {
  return String(p).replace(/\.(docx?|md|txt)$/i, ".pdf");
}

function isInside(root, abs) {
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function archetypeFilename(profile, key) {
  const versions = (profile.resumeVersions && profile.resumeVersions.versions) || {};
  const v = versions[key];
  if (v && v.filename) return toPdf(v.filename);
  const name = String((profile.identity && profile.identity.name) || "")
    .trim()
    .replace(/\s+/g, "_");
  return name ? `CV_${name}_${key}.pdf` : `CV_${key}.pdf`;
}

// Returns { abs, rel } or { error } where error ∈ resume_missing | resume_not_set
// | resume_outside_profile.
function resolveResumePdf(app, profile, { exists }) {
  const root = profile.paths.root;
  const ver = String((app && app.resume_ver) || "").trim();
  if (!ver) return { error: "resume_not_set" };

  let candidates;
  if (ver.includes("/") || /\.(pdf|docx?)$/i.test(ver)) {
    const rel = toPdf(ver);
    candidates = [rel];
  } else {
    const dir = path.relative(root, profile.paths.resumesDir || path.join(root, "resumes"));
    candidates = [path.join(dir, archetypeFilename(profile, ver))];
  }

  for (const rel of candidates) {
    const abs = path.resolve(root, rel);
    if (!isInside(root, abs)) return { error: "resume_outside_profile" };
    if (exists(abs)) return { abs, rel };
  }
  return { error: "resume_missing", rel: candidates[0] };
}

// Returns { abs, rel } | null (no cover letter on the row or file missing).
function resolveCoverLetterPdf(app, profile, { exists }) {
  const root = profile.paths.root;
  const raw = String((app && app.cl_path) || "").trim();
  if (!raw) return null;
  const rel = toPdf(raw);
  const abs = path.resolve(root, rel);
  if (!isInside(root, abs)) return null;
  return exists(abs) ? { abs, rel } : null;
}

module.exports = { resolveResumePdf, resolveCoverLetterPdf, archetypeFilename };
