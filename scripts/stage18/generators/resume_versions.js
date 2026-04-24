// generators/resume_versions.js — intake.resume_archetypes → resume_versions.json
//
// Output shape (consumed by engine/core/fit_prompt.js and prepare):
//   { versions: { <key>: { title, summary, bullets?, tags? }, ... } }

function buildResumeVersions(intake = {}) {
  const archetypes = Array.isArray(intake.resume_archetypes) ? intake.resume_archetypes : [];
  const versions = {};
  for (const a of archetypes) {
    if (!a || !a.key) continue;
    const key = String(a.key).trim();
    if (!key) continue;
    const entry = {};
    if (a.title) entry.title = String(a.title).trim();
    if (a.summary) entry.summary = String(a.summary).trim();
    if (Array.isArray(a.bullets) && a.bullets.length) {
      entry.bullets = a.bullets.map((b) => String(b).trim()).filter(Boolean);
    }
    if (Array.isArray(a.tags) && a.tags.length) {
      entry.tags = a.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    }
    // Require at least one meaningful field beyond the key.
    if (Object.keys(entry).length === 0) continue;
    versions[key] = entry;
  }
  return { versions };
}

module.exports = { buildResumeVersions };
